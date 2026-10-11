//! Tauri commands: the entire surface the renderer can call.
//!
//! Rules the tests in this file enforce:
//!
//! * the renderer never receives a session token, a PKCE verifier, or a state
//!   value, and it never chooses a destination URL — it names an `/api/...`
//!   path that the shell pins to the configured server;
//! * every failure crosses the IPC boundary as [`crate::errors::PublicError`],
//!   so paths, tokens, user names, and provider bodies cannot leak;
//! * native side effects (browser, notifications, tray) are injectable, so the
//!   policy is testable without a window.

use crate::auth::{self, PendingAuthorization, StoredSession};
use crate::errors::{AuthError, DesktopError, PublicError, Result};
use crate::exchange::{self, Transport};
use crate::notifier::{Notifier, UnattachedNotifier};
use crate::notify::{self, Decision, NotifiedRuns};
use crate::opener::{Opener, SystemOpener};
use crate::server::{ProviderConfig, ResourcesSummary, ServerResponse};
use crate::settings::{self, DesktopSettings};
use crate::vault::{self, CredentialVault, OsVault};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};
use url::Url;

/// Wall-clock helper, so tests can inject time instead of waiting for it.
pub mod clock {
    pub fn epoch_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0)
    }
}

/// Recover from a poisoned lock: a panic inside one command must not take the
/// whole desktop state with it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Managed desktop state.
pub struct DesktopState {
    vault: Box<dyn CredentialVault>,
    transport: Box<dyn Transport>,
    opener: Box<dyn Opener>,
    notifier: Mutex<Box<dyn Notifier>>,
    connection: Mutex<ConnectionState>,
    pending: Mutex<Option<PendingAuthorization>>,
    settings: Mutex<DesktopSettings>,
    settings_path: Mutex<Option<PathBuf>>,
    notified: Mutex<NotifiedRuns>,
    notification_targets: Mutex<HashMap<i32, String>>,
    notification_sequence: AtomicI32,
    events: Mutex<std::collections::VecDeque<DesktopEvent>>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            // Production wiring: the real platform vault and a real transport.
            vault: Box::new(OsVault::new()),
            transport: Box::new(exchange::HttpTransport),
            opener: Box::new(SystemOpener),
            notifier: Mutex::new(Box::new(UnattachedNotifier)),
            connection: Mutex::new(ConnectionState::default()),
            pending: Mutex::new(None),
            settings: Mutex::new(DesktopSettings::default()),
            settings_path: Mutex::new(None),
            notified: Mutex::new(NotifiedRuns::default()),
            notification_targets: Mutex::new(HashMap::new()),
            notification_sequence: AtomicI32::new(1),
            events: Mutex::new(std::collections::VecDeque::new()),
        }
    }
}

impl DesktopState {
    /// Record something the renderer has to know about. The renderer polls
    /// [`take_events`] instead of subscribing to native events, so the shell
    /// exposes exactly one outbound mechanism.
    pub fn record_event(&self, kind: &str, payload: serde_json::Value) {
        let mut events = lock(&self.events);
        if events.len() >= MAX_PENDING_EVENTS {
            events.pop_front();
        }
        events.push_back(DesktopEvent {
            kind: kind.to_string(),
            payload,
        });
    }

    pub fn vault(&self) -> &dyn CredentialVault {
        self.vault.as_ref()
    }

    pub fn transport(&self) -> &dyn Transport {
        self.transport.as_ref()
    }

    /// Bind the platform notifier once the app handle exists.
    pub fn bind_notifier(&self, notifier: Box<dyn Notifier>) {
        *lock(&self.notifier) = notifier;
    }

    /// Load persisted settings and remember where to write them next.
    pub fn attach_settings(&self, settings_path: PathBuf, loaded: DesktopSettings) {
        *lock(&self.settings) = loaded;
        *lock(&self.settings_path) = Some(settings_path);
    }

    pub fn settings_snapshot(&self) -> DesktopSettings {
        lock(&self.settings).clone()
    }

    pub fn connection_snapshot(&self) -> ConnectionState {
        lock(&self.connection).clone()
    }

    pub fn notifications_allowed_snapshot(&self) -> bool {
        lock(&self.settings).notifications_allowed
    }

    pub fn set_notifications_allowed(&self, allowed: bool) {
        lock(&self.settings).notifications_allowed = allowed;
        self.persist_settings();
    }

    fn persist_settings(&self) {
        let settings = lock(&self.settings).clone();
        let path = lock(&self.settings_path).clone();
        if let Some(path) = path {
            // A failed preference write is not worth failing a command over;
            // the in-memory value stays authoritative for this session.
            let _ = settings::save(&path, &settings);
        }
    }

    /// The server the user configured, validated and reduced to its origin.
    ///
    /// A configured address is an origin: any path it carries is dropped, so
    /// `/api/...` paths always resolve against the server root.
    pub fn configured_server(&self) -> Option<Url> {
        let configured = lock(&self.settings).server_url.clone();
        let candidate = if configured.is_empty() {
            match &*lock(&self.connection) {
                ConnectionState::Connected { server_url } => server_url.clone(),
                _ => String::new(),
            }
        } else {
            configured
        };
        if candidate.is_empty() {
            return None;
        }
        let parsed = Url::parse(candidate.trim_end_matches('/')).ok()?;
        if !exchange::is_allowed_remote(&parsed) {
            return None;
        }
        Url::parse(&origin_of(&parsed)).ok()
    }

    /// The vaulted token, but only while it is still valid.
    fn session_token(&self, now: i64) -> Option<String> {
        match vault::load_active_session(self.vault()) {
            Ok(session) if auth::session_is_valid(&session, now) => Some(session.session_token),
            _ => None,
        }
    }

    /// The stored session as the renderer may see it: no token.
    pub fn session_view(&self, now: i64) -> Result<SessionView> {
        match vault::load_active_session(self.vault()) {
            Ok(session) => Ok(SessionView::from_session(
                &session,
                auth::session_is_valid(&session, now),
            )),
            Err(AuthError::NoSession) => Ok(SessionView::empty()),
            Err(error) => Err(DesktopError::Auth(error)),
        }
    }
}

// ---------------------------------------------------------------------------
// Shapes crossing the IPC boundary
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionState {
    Connected {
        server_url: String,
    },
    #[default]
    Offline,
    Unauthorized,
    Expired,
    Forbidden,
    ServerUnavailable,
}

/// A session as the renderer sees it: never the token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionView {
    pub server_url: String,
    pub tenant_id: String,
    pub workspace_id: String,
    pub role: String,
    pub expires_at: i64,
    pub valid: bool,
}

impl SessionView {
    fn empty() -> Self {
        Self {
            server_url: String::new(),
            tenant_id: String::new(),
            workspace_id: String::new(),
            role: String::new(),
            expires_at: 0,
            valid: false,
        }
    }

    fn from_session(session: &StoredSession, valid: bool) -> Self {
        Self {
            server_url: session.server_url.clone(),
            tenant_id: session.tenant_id.clone(),
            workspace_id: session.workspace_id.clone(),
            role: session.role.clone(),
            expires_at: session.expires_at,
            valid,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsView {
    pub connection_state: ConnectionState,
    pub notifications_allowed: bool,
    pub server_url: String,
    pub workspace_id: String,
    pub tenant_id: String,
    pub update_channel: String,
    pub appearance: String,
    pub signed_in: bool,
}

/// Result of asking to sign in, or of being told why that cannot happen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationStart {
    /// `started`, `unconfigured`, or `not-configured`.
    pub status: &'static str,
    pub message: &'static str,
    pub expires_in_seconds: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallbackOutcome {
    /// `signed-in` whenever a session was established.
    pub kind: &'static str,
    pub session: SessionView,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogoutOutcome {
    pub removed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationOutcome {
    pub notified: bool,
    /// `sent`, `disabled`, `not-terminal`, `duplicate`, `invalid-run-id`, or
    /// `delivery-failed`.
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationPermission {
    /// `granted`, `denied`, `prompt`, or `unavailable`.
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepLinkTarget {
    pub kind: String,
    pub id: String,
}

/// One queued notification for the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopEvent {
    pub kind: String,
    pub payload: serde_json::Value,
}

/// Bound on queued events, so a renderer that never polls cannot grow memory
/// without limit (the oldest entry is dropped instead).
const MAX_PENDING_EVENTS: usize = 256;

pub fn connection_label(state: &ConnectionState) -> &'static str {
    match state {
        ConnectionState::Connected { .. } => "Connection: connected",
        ConnectionState::Offline => "Connection: offline",
        ConnectionState::Unauthorized => "Connection: sign in",
        ConnectionState::Expired => "Connection: session expired",
        ConnectionState::Forbidden => "Connection: forbidden",
        ConnectionState::ServerUnavailable => "Connection: server unavailable",
    }
}

/// `scheme://host[:port]` for a parsed URL.
fn origin_of(url: &Url) -> String {
    match url.port() {
        Some(port) => format!(
            "{}://{}:{}",
            url.scheme(),
            url.host_str().unwrap_or_default(),
            port
        ),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
    }
}

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

pub fn session_state_on(state: &DesktopState, now: i64) -> Result<SessionView> {
    state.session_view(now)
}

#[tauri::command]
pub fn get_session_state(state: State<'_, DesktopState>) -> Result<SessionView> {
    session_state_on(&state, clock::epoch_secs())
}

pub fn logout_on(state: &DesktopState) -> Result<LogoutOutcome> {
    let removed = match vault::clear_active_session(state.vault()) {
        Ok(removed) => removed,
        // Signing out of nothing is not an error the UI has to handle.
        Err(AuthError::NoSession) => false,
        Err(error) => return Err(DesktopError::Auth(error)),
    };
    *lock(&state.connection) = ConnectionState::Offline;
    Ok(LogoutOutcome { removed })
}

#[tauri::command]
pub fn logout(state: State<'_, DesktopState>) -> Result<LogoutOutcome> {
    logout_on(&state)
}

pub fn configure_server_on(state: &DesktopState, server_url: &str) -> Result<SettingsView> {
    let trimmed = server_url.trim().trim_end_matches('/').to_string();
    let normalized = if trimmed.is_empty() {
        String::new()
    } else {
        let parsed = Url::parse(&trimmed)
            .map_err(|_| DesktopError::Rejected(PublicError::SERVER_URL_NOT_ALLOWED))?;
        if !exchange::is_allowed_remote(&parsed) {
            return Err(DesktopError::Rejected(PublicError::SERVER_URL_NOT_ALLOWED));
        }
        // Stored as an origin so every API path resolves against the root.
        origin_of(&parsed)
    };
    lock(&state.settings).server_url = normalized;
    state.persist_settings();
    // A freshly configured address has not been proven reachable yet.
    *lock(&state.connection) = ConnectionState::Offline;
    settings_on(state, clock::epoch_secs())
}

#[tauri::command]
pub fn configure_server(
    state: State<'_, DesktopState>,
    server_url: String,
) -> Result<SettingsView> {
    configure_server_on(&state, &server_url)
}

pub fn settings_on(state: &DesktopState, now: i64) -> Result<SettingsView> {
    let session = state.session_view(now)?;
    let settings = state.settings_snapshot();
    let server_url = if settings.server_url.is_empty() {
        session.server_url.clone()
    } else {
        settings.server_url.clone()
    };
    Ok(SettingsView {
        connection_state: state.connection_snapshot(),
        notifications_allowed: settings.notifications_allowed,
        server_url,
        workspace_id: session.workspace_id.clone(),
        tenant_id: session.tenant_id.clone(),
        update_channel: settings.update_channel.clone(),
        appearance: settings.appearance.clone(),
        signed_in: session.valid,
    })
}

#[tauri::command]
pub fn get_settings(state: State<'_, DesktopState>) -> Result<SettingsView> {
    settings_on(&state, clock::epoch_secs())
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/// Ask the server what it supports, then — only when a provider is genuinely
/// configured — mint a pending attempt and open the system browser.
pub fn begin_authorization_on(state: &DesktopState, now: i64) -> Result<AuthorizationStart> {
    let Some(server) = state.configured_server() else {
        return Ok(AuthorizationStart {
            status: "not-configured",
            message: "Configure the TraceHealer server address first.",
            expires_in_seconds: 0,
        });
    };
    let url = crate::server::api_url(&server, "/api/desktop/auth/config")?;
    let (status, _content_type, body) = state
        .transport()
        .request("GET", &url, &[], None)
        .map_err(DesktopError::from)?;
    let config: ProviderConfig = crate::server::provider_config(status, &body);
    if !config.configured {
        return Ok(AuthorizationStart {
            status: "unconfigured",
            message: "External OIDC is not configured on this server, so sign-in cannot complete.",
            expires_in_seconds: 0,
        });
    }
    let endpoints = crate::server::provider_endpoints(&server, &config)?;
    // The operator may pin a scope locally; otherwise the server's advertisement
    // is used verbatim.
    let configured_scope = state.settings_snapshot().scope;
    let scope = if configured_scope.is_empty() {
        config.scope.clone()
    } else {
        configured_scope
    };
    let pending = PendingAuthorization::new(
        auth::new_pkce(),
        endpoints,
        config.client_id.clone(),
        scope,
        now,
    );
    let authorize = pending.authorize_url();
    let expires_in_seconds = pending.seconds_remaining(now);
    *lock(&state.pending) = Some(pending);
    if state.opener.open(&authorize).is_err() {
        // No browser means no callback: drop the attempt rather than leaving a
        // verifier waiting for a link that cannot arrive.
        *lock(&state.pending) = None;
        return Err(DesktopError::Rejected(PublicError::TRANSPORT_FAILED));
    }
    Ok(AuthorizationStart {
        status: "started",
        message: "Finish signing in from the browser window that just opened.",
        expires_in_seconds,
    })
}

#[tauri::command]
pub fn begin_authorization(state: State<'_, DesktopState>) -> Result<AuthorizationStart> {
    begin_authorization_on(&state, clock::epoch_secs())
}

/// Identity the server reports for a freshly exchanged credential.
fn resolve_identity(
    state: &DesktopState,
    server: &Url,
    token: &str,
) -> Result<(String, String, String)> {
    let response = crate::server::send_api(
        state.transport(),
        server,
        "/api/desktop/session",
        "GET",
        None,
        Some(token),
    )?;
    if response.status != 200 {
        // The server did not accept the exchanged credential, so no session is
        // stored: a login the server does not honour is not a login.
        return Err(DesktopError::Auth(AuthError::ExchangeFailed(format!(
            "the server rejected the exchanged credential (status {})",
            response.status
        ))));
    }
    let value: serde_json::Value = serde_json::from_str(&response.body).map_err(|_| {
        DesktopError::Auth(AuthError::ExchangeFailed(
            "the identity response was not JSON".into(),
        ))
    })?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Ok((field("tenantId"), field("workspaceId"), field("role")))
}

/// Validate a callback and, on success, exchange the code and store the
/// resulting session. The pending attempt is dropped on every path — success,
/// mismatch, expiry, replay, provider refusal — so a verifier is never reused.
pub fn handle_callback_on(state: &DesktopState, url: &str, now: i64) -> Result<CallbackOutcome> {
    let parsed = Url::parse(url).map_err(|_| DesktopError::Auth(AuthError::StateMismatch))?;
    let pending = lock(&state.pending)
        .take()
        .ok_or(DesktopError::Auth(AuthError::NoAttempt))?;

    let code = pending.accept_callback(&parsed, now)?;
    let grant = exchange::exchange_code(
        state.transport(),
        &pending.endpoints,
        &pending.client_id,
        &pending.redirect_uri,
        &code,
        &pending.pkce.verifier,
        &pending.pkce.nonce,
        now,
    )?;

    // The origin is pinned by the attempt itself, not by anything the renderer
    // supplied after the fact.
    let server_url = origin_of(&pending.endpoints.token);
    let server = Url::parse(&server_url)
        .map_err(|_| DesktopError::Rejected(PublicError::SERVER_URL_NOT_ALLOWED))?;

    let (tenant_id, workspace_id, role) = resolve_identity(state, &server, &grant.access_token)?;
    let session = StoredSession {
        server_url,
        tenant_id,
        workspace_id,
        role,
        session_token: grant.access_token,
        expires_at: grant.expires_at,
    };
    vault::store_session(state.vault(), &session)?;
    *lock(&state.connection) = ConnectionState::Connected {
        server_url: session.server_url.clone(),
    };
    Ok(CallbackOutcome {
        kind: "signed-in",
        session: SessionView::from_session(&session, auth::session_is_valid(&session, now)),
    })
}

#[tauri::command]
pub fn handle_callback(app: AppHandle, url: String) -> Result<CallbackOutcome> {
    let state = app.state::<DesktopState>();
    let outcome = handle_callback_on(&state, &url, clock::epoch_secs())?;
    state.record_event(
        "auth-callback",
        serde_json::to_value(&outcome).unwrap_or_default(),
    );
    state.record_event(
        "connection-state",
        serde_json::to_value(state.connection_snapshot()).unwrap_or_default(),
    );
    crate::tray::refresh(&app);
    Ok(outcome)
}

/// Drain everything the renderer has not seen yet.
#[tauri::command]
pub fn take_events(state: State<'_, DesktopState>) -> Vec<DesktopEvent> {
    lock(&state.events).drain(..).collect()
}

// ---------------------------------------------------------------------------
// Connection reporting
// ---------------------------------------------------------------------------

pub fn report_connection_on(state: &DesktopState, status: ConnectionState) -> ConnectionState {
    *lock(&state.connection) = status.clone();
    if let ConnectionState::Connected { server_url } = &status {
        // Learning the address from a successful connection is what lets the
        // tray act without the renderer naming a URL.
        let mut settings = lock(&state.settings);
        if settings.server_url.is_empty() {
            settings.server_url = server_url.clone();
        }
    }
    status
}

#[tauri::command]
pub fn report_connection(state: State<'_, DesktopState>, status: ConnectionState, app: AppHandle) {
    let status = report_connection_on(&state, status);
    state.record_event(
        "connection-state",
        serde_json::to_value(&status).unwrap_or_default(),
    );
    crate::tray::refresh(&app);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/// The deep link a run notification points at.
#[tauri::command]
pub fn notification_target(run_id: String) -> Result<String> {
    notify::notification_target(&run_id).ok_or(DesktopError::Rejected(PublicError::INVALID_INPUT))
}

/// Apply the notification policy and deliver when it says to.
pub fn push_run_update_on(state: &DesktopState, run_id: &str, status: &str) -> NotificationOutcome {
    let allowed = state.notifications_allowed_snapshot();
    let decision = {
        let mut notified = lock(&state.notified);
        notify::decide(&mut notified, allowed, run_id, status)
    };
    let notification = match decision {
        Decision::Skip(reason) => {
            return NotificationOutcome {
                notified: false,
                reason: reason.as_str().to_string(),
            }
        }
        Decision::Notify(notification) => notification,
    };

    let identifier = state.notification_sequence.fetch_add(1, Ordering::SeqCst);
    let delivered = {
        let notifier = lock(&state.notifier);
        notifier.deliver(
            identifier,
            notification.title,
            &notification.body,
            &notification.run_id,
        )
    };
    if delivered.is_err() {
        // A dead notification service must not hide the run: forget the pair so
        // a later update can try again, and say so.
        lock(&state.notified).forget(&notification.run_id, &notification.state);
        return NotificationOutcome {
            notified: false,
            reason: "delivery-failed".to_string(),
        };
    }
    lock(&state.notification_targets).insert(identifier, notification.run_id.clone());
    NotificationOutcome {
        notified: true,
        reason: "sent".to_string(),
    }
}

#[tauri::command]
pub fn push_run_update(
    state: State<'_, DesktopState>,
    run_id: String,
    status: String,
) -> NotificationOutcome {
    let outcome = push_run_update_on(&state, &run_id, &status);
    state.record_event(
        "run-update",
        serde_json::json!({ "runId": run_id, "state": status, "notified": outcome.notified }),
    );
    outcome
}

#[tauri::command]
pub fn request_notification_permission(app: AppHandle) -> NotificationPermission {
    use tauri_plugin_notification::NotificationExt;
    match app.notification().request_permission() {
        Ok(state) => NotificationPermission {
            status: format!("{state:?}").to_ascii_lowercase(),
        },
        Err(_) => NotificationPermission {
            status: "unavailable".to_string(),
        },
    }
}

pub fn set_notifications_allowed_on(state: &DesktopState, allowed: bool) -> Result<SettingsView> {
    state.set_notifications_allowed(allowed);
    settings_on(state, clock::epoch_secs())
}

#[tauri::command]
pub fn set_notifications_allowed(
    state: State<'_, DesktopState>,
    allowed: bool,
    app: AppHandle,
) -> Result<SettingsView> {
    let view = set_notifications_allowed_on(&state, allowed)?;
    crate::tray::refresh(&app);
    Ok(view)
}

#[tauri::command]
pub fn notifications_allowed(state: State<'_, DesktopState>) -> bool {
    state.notifications_allowed_snapshot()
}

/// Resolve which run a clicked notification belongs to.
pub fn notification_run_id(
    state: &DesktopState,
    identifier: i32,
    fallback: Option<&str>,
) -> Option<String> {
    let mapped = lock(&state.notification_targets).get(&identifier).cloned();
    mapped
        .filter(|run_id| notify::is_valid_run_id(run_id))
        .or_else(|| {
            fallback
                .filter(|run_id| notify::is_valid_run_id(run_id))
                .map(str::to_string)
        })
}

// ---------------------------------------------------------------------------
// Server access for the renderer
// ---------------------------------------------------------------------------

pub fn server_request_on(
    state: &DesktopState,
    method: &str,
    path: &str,
    body: Option<&str>,
    now: i64,
) -> Result<ServerResponse> {
    let Some(server) = state.configured_server() else {
        return Err(DesktopError::Rejected(PublicError::NOT_CONFIGURED));
    };
    let token = state.session_token(now);
    crate::server::send_api(
        state.transport(),
        &server,
        path,
        method,
        body,
        token.as_deref(),
    )
}

#[tauri::command]
pub fn server_request(
    state: State<'_, DesktopState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<ServerResponse> {
    server_request_on(&state, &method, &path, body.as_deref(), clock::epoch_secs())
}

pub fn resources_summary_on(state: &DesktopState) -> Result<ResourcesSummary> {
    let Some(server) = state.configured_server() else {
        return Err(DesktopError::Rejected(PublicError::NOT_CONFIGURED));
    };
    let response = server_request_on(state, "GET", "/api/ready", None, clock::epoch_secs())?;
    Ok(crate::server::readiness_summary(
        &origin_of(&server),
        response.status,
        &response.body,
    ))
}

#[tauri::command]
pub fn resources_summary(state: State<'_, DesktopState>) -> Result<ResourcesSummary> {
    resources_summary_on(&state)
}

/// Open the configured server in the system browser. Takes no argument, so the
/// renderer cannot ask the shell to open an arbitrary address.
pub fn open_dashboard_on(state: &DesktopState) -> Result<()> {
    let Some(server) = state.configured_server() else {
        return Err(DesktopError::Rejected(PublicError::NOT_CONFIGURED));
    };
    state
        .opener
        .open(&origin_of(&server))
        .map_err(|_| DesktopError::Rejected(PublicError::TRANSPORT_FAILED))
}

#[tauri::command]
pub fn open_dashboard(state: State<'_, DesktopState>) -> Result<()> {
    open_dashboard_on(&state)
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/// Parse `tracehealer://incident/:id` or `tracehealer://run/:id`.
pub fn parse_deep_link(url: &str) -> Result<DeepLinkTarget> {
    let parsed =
        Url::parse(url).map_err(|_| DesktopError::Rejected(PublicError::UNKNOWN_DEEP_LINK))?;
    if parsed.scheme() != "tracehealer" {
        return Err(DesktopError::Rejected(PublicError::UNKNOWN_DEEP_LINK));
    }
    // Dot segments are never part of an identifier, and following them lets a
    // crafted link masquerade as a shorter one.
    if url.contains("..") {
        return Err(DesktopError::Rejected(PublicError::UNKNOWN_DEEP_LINK));
    }
    let kind = parsed.host_str().unwrap_or("").to_string();
    let id = parsed
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    match kind.as_str() {
        "incident" | "run" if notify::is_valid_run_id(&id) => Ok(DeepLinkTarget { kind, id }),
        _ => Err(DesktopError::Rejected(PublicError::UNKNOWN_DEEP_LINK)),
    }
}

/// Whether a deep link is the OAuth callback rather than a run link.
pub fn is_auth_callback(url: &str) -> bool {
    Url::parse(url)
        .map(|parsed| parsed.scheme() == "tracehealer" && parsed.host_str() == Some("auth"))
        .unwrap_or(false)
}

/// Bring the window to the foreground; used by deep links and notifications.
pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn handle_deep_link(app: AppHandle, url: String) -> Result<DeepLinkTarget> {
    let state = app.state::<DesktopState>();
    let target = parse_deep_link(&url)?;
    focus_main_window(&app);
    state.record_event(
        "open-target",
        serde_json::to_value(&target).unwrap_or_default(),
    );
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exchange::testing::ScriptedTransport;
    use crate::notifier::testing::RecordingNotifier;
    use crate::opener::testing::RecordingOpener;
    use crate::vault::testing::MemoryVault;
    use serde_json::json;
    use std::sync::Arc;

    /// Wrappers that let a test keep inspecting a backend the state now owns.
    struct SharedTransport(Arc<ScriptedTransport>);
    struct SharedOpener(Arc<RecordingOpener>);
    struct SharedVault(Arc<MemoryVault>);
    struct SharedNotifier(Arc<RecordingNotifier>);

    impl Transport for SharedTransport {
        fn request(
            &self,
            method: &str,
            url: &Url,
            headers: &[(String, String)],
            body: Option<&str>,
        ) -> std::result::Result<(u16, String, String), crate::http::HttpError> {
            self.0.request(method, url, headers, body)
        }
    }

    impl Opener for SharedOpener {
        fn open(&self, url: &str) -> std::result::Result<(), String> {
            self.0.open(url)
        }
    }

    impl CredentialVault for SharedVault {
        fn get(
            &self,
            user: &str,
        ) -> std::result::Result<Option<String>, crate::errors::VaultError> {
            self.0.get(user)
        }
        fn set(
            &self,
            user: &str,
            secret: &str,
        ) -> std::result::Result<(), crate::errors::VaultError> {
            self.0.set(user, secret)
        }
        fn delete(&self, user: &str) -> std::result::Result<(), crate::errors::VaultError> {
            self.0.delete(user)
        }
    }

    impl Notifier for SharedNotifier {
        fn deliver(
            &self,
            identifier: i32,
            title: &str,
            body: &str,
            run_id: &str,
        ) -> std::result::Result<(), String> {
            self.0.deliver(identifier, title, body, run_id)
        }
    }

    struct Harness {
        state: DesktopState,
        transport: Arc<ScriptedTransport>,
        opener: Arc<RecordingOpener>,
        vault: Arc<MemoryVault>,
        notifier: Arc<RecordingNotifier>,
        settings_path: PathBuf,
    }

    fn harness() -> Harness {
        harness_with(
            ScriptedTransport::default(),
            RecordingOpener::new(),
            RecordingNotifier::new(),
        )
    }

    fn harness_with(
        transport: ScriptedTransport,
        opener: RecordingOpener,
        notifier: RecordingNotifier,
    ) -> Harness {
        let transport = Arc::new(transport);
        let opener = Arc::new(opener);
        let vault = Arc::new(MemoryVault::new());
        let notifier = Arc::new(notifier);
        let settings_path = std::env::temp_dir().join(format!(
            "tracehealer-desktop-{}-{}.json",
            std::process::id(),
            next_identifier()
        ));
        let state = DesktopState {
            vault: Box::new(SharedVault(vault.clone())),
            transport: Box::new(SharedTransport(transport.clone())),
            opener: Box::new(SharedOpener(opener.clone())),
            notifier: Mutex::new(Box::new(SharedNotifier(notifier.clone()))),
            connection: Mutex::new(ConnectionState::default()),
            pending: Mutex::new(None),
            settings: Mutex::new(DesktopSettings::default()),
            settings_path: Mutex::new(Some(settings_path.clone())),
            notified: Mutex::new(NotifiedRuns::default()),
            notification_targets: Mutex::new(HashMap::new()),
            notification_sequence: AtomicI32::new(1),
            events: Mutex::new(std::collections::VecDeque::new()),
        };
        Harness {
            state,
            transport,
            opener,
            vault,
            notifier,
            settings_path,
        }
    }

    fn next_identifier() -> i32 {
        static COUNTER: AtomicI32 = AtomicI32::new(0);
        COUNTER.fetch_add(1, Ordering::SeqCst)
    }

    impl Harness {
        fn configure(&self, server_url: &str) {
            let mut settings = self.state.settings_snapshot();
            settings.server_url = server_url.to_string();
            self.state
                .attach_settings(self.settings_path.clone(), settings);
        }

        fn provider_configured(&self) {
            self.transport.push((
                200,
                json!({
                    "configured": true,
                    "provider": "corp-oidc",
                    "clientId": "tracehealer-desktop",
                    "authorizeEndpoint": "https://healer.example/auth/authorize",
                    "tokenEndpoint": "https://healer.example/auth/token",
                    "scope": "openid profile"
                })
                .to_string(),
            ));
        }

        fn pending_state(&self) -> Option<String> {
            lock(&self.state.pending)
                .as_ref()
                .map(|p| p.pkce.state.clone())
        }
    }

    fn started_for(server_url: &str) -> Harness {
        let harness = harness();
        harness.configure(server_url);
        harness.provider_configured();
        let start = begin_authorization_on(&harness.state, 1_000).unwrap();
        assert_eq!(start.status, "started");
        harness
    }

    #[test]
    fn signing_in_requires_a_configured_server() {
        let harness = harness();
        let start = begin_authorization_on(&harness.state, 1_000).unwrap();
        assert_eq!(start.status, "not-configured");
        assert!(harness.opener.opened().is_empty());
        assert!(harness.pending_state().is_none());
    }

    #[test]
    fn a_server_without_a_provider_never_starts_a_sign_in() {
        let harness = harness();
        harness.configure("https://healer.example");
        harness.transport.push((
            200,
            json!({ "configured": false, "reason": "no issuer configured" }).to_string(),
        ));
        let start = begin_authorization_on(&harness.state, 1_000).unwrap();
        assert_eq!(start.status, "unconfigured");
        assert_eq!(start.expires_in_seconds, 0);
        assert!(harness.opener.opened().is_empty());
        assert!(harness.pending_state().is_none());
    }

    #[test]
    fn a_started_sign_in_opens_the_browser_with_pkce_and_keeps_the_verifier_native() {
        let harness = started_for("https://healer.example");
        let opened = harness.opener.opened();
        assert_eq!(opened.len(), 1);
        let url = &opened[0];
        assert!(
            url.starts_with("https://healer.example/auth/authorize?"),
            "{url}"
        );
        assert!(url.contains("code_challenge_method=S256"), "{url}");
        assert!(url.contains("code_challenge="), "{url}");
        assert!(url.contains("nonce="), "{url}");
        assert!(url.contains("state="), "{url}");

        // The verifier exists only in native state, and never appears anywhere
        // the renderer or the browser could read it.
        let pending = lock(&harness.state.pending).clone().unwrap();
        assert!(!url.contains(&pending.pkce.verifier), "{url}");
    }

    #[test]
    fn an_unreachable_server_or_a_dead_browser_leaves_no_pending_attempt() {
        let harness = harness();
        harness.configure("https://healer.example");
        let error = begin_authorization_on(&harness.state, 1_000).unwrap_err();
        assert_eq!(error.public().code, "transport-failed");
        assert!(harness.pending_state().is_none());

        let broken = harness_with(
            ScriptedTransport::default(),
            RecordingOpener::failing(),
            RecordingNotifier::new(),
        );
        broken.configure("https://healer.example");
        broken.provider_configured();
        let error = begin_authorization_on(&broken.state, 1_000).unwrap_err();
        assert_eq!(error.public().code, "transport-failed");
        assert!(broken.pending_state().is_none());
    }

    #[test]
    fn a_server_url_outside_https_and_loopback_is_refused() {
        let harness = harness();
        for hostile in [
            "http://healer.example",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://host",
        ] {
            let error = configure_server_on(&harness.state, hostile).unwrap_err();
            assert_eq!(error.public().code, "server-url-not-allowed", "{hostile}");
        }
        assert!(configure_server_on(&harness.state, "http://localhost:3000").is_ok());
        assert!(configure_server_on(&harness.state, "https://healer.example").is_ok());
        // A path on the configured address is dropped rather than silently
        // changing where `/api/...` resolves.
        let view = configure_server_on(&harness.state, "https://healer.example/sub/path").unwrap();
        assert_eq!(view.server_url, "https://healer.example");
    }

    #[test]
    fn a_successful_callback_stores_the_session_in_the_vault_and_not_in_settings() {
        let harness = started_for("https://healer.example");
        let state = harness.pending_state().unwrap();
        harness.transport.push((
            200,
            json!({
                "access_token": "tok_abcdefghijklmnop",
                "expires_in": 900,
                "token_type": "Bearer"
            })
            .to_string(),
        ));
        harness.transport.push((
            200,
            json!({ "tenantId": "tenant-a", "workspaceId": "workspace-a", "role": "operator" })
                .to_string(),
        ));

        let outcome = handle_callback_on(
            &harness.state,
            &format!("tracehealer://auth/callback?state={state}&code=auth-code"),
            1_010,
        )
        .unwrap();
        assert_eq!(outcome.kind, "signed-in");
        assert_eq!(outcome.session.tenant_id, "tenant-a");
        assert_eq!(outcome.session.workspace_id, "workspace-a");
        assert!(outcome.session.valid);

        // The token reached the vault...
        let stored = vault::load_active_session(harness.vault.as_ref()).unwrap();
        assert_eq!(stored.session_token, "tok_abcdefghijklmnop");
        // ...and nothing the renderer can see carries it.
        let rendered = serde_json::to_string(&outcome).unwrap();
        assert!(!rendered.contains("tok_abcdefghijklmnop"), "{rendered}");
        let settings_view =
            serde_json::to_string(&settings_on(&harness.state, 1_010).unwrap()).unwrap();
        assert!(
            !settings_view.contains("tok_abcdefghijklmnop"),
            "{settings_view}"
        );
        // The attempt is spent.
        assert!(harness.pending_state().is_none());
    }

    #[test]
    fn the_exchanged_token_is_verified_with_the_server_before_it_is_stored() {
        let harness = started_for("https://healer.example");
        let state = harness.pending_state().unwrap();
        harness.transport.push((
            200,
            json!({ "access_token": "tok_abcdefghijklmnop", "expires_in": 900 }).to_string(),
        ));
        harness
            .transport
            .push((401, json!({ "ok": false }).to_string()));

        let error = handle_callback_on(
            &harness.state,
            &format!("tracehealer://auth/callback?state={state}&code=auth-code"),
            1_010,
        )
        .unwrap_err();
        assert_eq!(error.public().code, "exchange-failed");
        // Nothing was stored for a credential the server does not accept.
        assert!(matches!(
            vault::load_active_session(harness.vault.as_ref()),
            Err(AuthError::NoSession)
        ));
    }

    #[test]
    fn a_wrong_state_is_refused_and_clears_the_attempt() {
        let harness = started_for("https://healer.example");
        let error = handle_callback_on(
            &harness.state,
            "tracehealer://auth/callback?state=attacker&code=steal",
            1_010,
        )
        .unwrap_err();
        assert_eq!(error.public().code, "auth-rejected");
        assert!(harness.pending_state().is_none());
        assert!(vault::load_active_session(harness.vault.as_ref()).is_err());
        // A second delivery finds nothing to consume.
        let again = handle_callback_on(
            &harness.state,
            "tracehealer://auth/callback?state=attacker&code=steal",
            1_010,
        )
        .unwrap_err();
        assert_eq!(again.public().code, "auth-no-attempt");
    }

    #[test]
    fn an_expired_attempt_is_refused() {
        let harness = harness();
        harness.configure("https://healer.example");
        harness.provider_configured();
        let start = begin_authorization_on(&harness.state, 1_000).unwrap();
        assert_eq!(start.status, "started");
        let state = harness.pending_state().unwrap();
        let error = handle_callback_on(
            &harness.state,
            &format!("tracehealer://auth/callback?state={state}&code=late"),
            1_000 + auth::PENDING_TTL_SECS + 1,
        )
        .unwrap_err();
        assert_eq!(error.public().code, "auth-expired");
        assert!(harness.pending_state().is_none());
    }

    #[test]
    fn a_callback_is_accepted_exactly_once() {
        let harness = started_for("https://healer.example");
        let state = harness.pending_state().unwrap();
        let url = format!("tracehealer://auth/callback?state={state}&code=auth-code");
        harness.transport.push((
            200,
            json!({ "access_token": "tok_abcdefghijklmnop", "expires_in": 900 }).to_string(),
        ));
        harness.transport.push((
            200,
            json!({ "tenantId": "t", "workspaceId": "w", "role": "operator" }).to_string(),
        ));
        assert!(handle_callback_on(&harness.state, &url, 1_010).is_ok());

        // Replaying the very same callback can neither re-issue a session nor
        // replay the exchange.
        let requests_before = harness.transport.requests().len();
        let replay = handle_callback_on(&harness.state, &url, 1_011).unwrap_err();
        assert_eq!(replay.public().code, "auth-no-attempt");
        assert_eq!(harness.transport.requests().len(), requests_before);
    }

    #[test]
    fn a_provider_refusal_clears_the_attempt_without_a_token() {
        let harness = started_for("https://healer.example");
        let state = harness.pending_state().unwrap();
        let error = handle_callback_on(
            &harness.state,
            &format!("tracehealer://auth/callback?state={state}&error=access_denied"),
            1_010,
        )
        .unwrap_err();
        assert_eq!(error.public().code, "provider-error");
        assert!(harness.pending_state().is_none());
        assert!(vault::load_active_session(harness.vault.as_ref()).is_err());
    }

    #[test]
    fn queued_events_are_reader_drained_and_bounded() {
        let harness = harness();
        harness
            .state
            .record_event("open-target", json!({ "kind": "run", "id": "heal_1" }));
        harness
            .state
            .record_event("connection-state", json!("Offline"));
        let drained: Vec<DesktopEvent> = {
            let mut events = lock(&harness.state.events);
            events.drain(..).collect()
        };
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].kind, "open-target");
        // A drained queue stays drained: nothing is delivered twice.
        assert!(lock(&harness.state.events).is_empty());

        // The queue is bounded, dropping the oldest entries first.
        for index in 0..(MAX_PENDING_EVENTS + 10) {
            harness
                .state
                .record_event("run-update", json!({ "runId": format!("heal_{index}") }));
        }
        let events = lock(&harness.state.events);
        assert_eq!(events.len(), MAX_PENDING_EVENTS);
        assert!(events.front().is_some());
    }

    #[test]
    fn logging_out_removes_the_credential_and_forgets_the_connection() {
        let harness = started_for("https://healer.example");
        let state = harness.pending_state().unwrap();
        harness.transport.push((
            200,
            json!({ "access_token": "tok_abcdefghijklmnop", "expires_in": 900 }).to_string(),
        ));
        harness.transport.push((
            200,
            json!({ "tenantId": "t", "workspaceId": "w", "role": "operator" }).to_string(),
        ));
        handle_callback_on(
            &harness.state,
            &format!("tracehealer://auth/callback?state={state}&code=auth-code"),
            1_010,
        )
        .unwrap();

        let outcome = logout_on(&harness.state).unwrap();
        assert!(outcome.removed);
        assert!(matches!(
            vault::load_active_session(harness.vault.as_ref()),
            Err(AuthError::NoSession)
        ));
        assert_eq!(
            harness.state.connection_snapshot(),
            ConnectionState::Offline
        );
        // The configured address is a preference, not a credential: it stays.
        assert_eq!(
            harness.state.settings_snapshot().server_url,
            "https://healer.example"
        );
    }

    #[test]
    fn session_views_never_expose_the_token() {
        let harness = harness();
        let session = StoredSession {
            server_url: "https://healer.example".into(),
            tenant_id: "t".into(),
            workspace_id: "w".into(),
            role: "operator".into(),
            session_token: "tok_abcdefghijklmnop".into(),
            expires_at: 4_000_000_000,
        };
        vault::store_session(harness.vault.as_ref(), &session).unwrap();
        let view = session_state_on(&harness.state, 1_000).unwrap();
        assert!(view.valid);
        let rendered = serde_json::to_string(&view).unwrap();
        assert!(!rendered.contains("tok_abcdefghijklmnop"), "{rendered}");
        assert!(!rendered.contains("session_token"), "{rendered}");

        // An expired session is reported as unusable rather than silently sent.
        assert!(
            !session_state_on(&harness.state, 4_000_000_000)
                .unwrap()
                .valid
        );
        assert!(harness.state.session_token(4_000_000_000).is_none());
    }

    #[test]
    fn api_calls_carry_the_session_cookie_only_while_it_is_valid() {
        let harness = harness();
        harness.configure("https://healer.example");
        let session = StoredSession {
            server_url: "https://healer.example".into(),
            tenant_id: "t".into(),
            workspace_id: "w".into(),
            role: "operator".into(),
            session_token: "tok_abcdefghijklmnop".into(),
            expires_at: 2_000,
        };
        vault::store_session(harness.vault.as_ref(), &session).unwrap();

        harness
            .transport
            .push((200, json!({ "ok": true }).to_string()));
        server_request_on(&harness.state, "GET", "/api/runs", None, 1_000).unwrap();
        let request = harness.transport.requests().pop().unwrap();
        assert_eq!(request.url, "https://healer.example/api/runs");
        assert!(
            request
                .headers
                .iter()
                .any(|(name, value)| name == "Cookie" && value.contains("tok_abcdefghijklmnop")),
            "{:?}",
            request.headers
        );

        // Past expiry the cookie is withheld: the server decides, not the app.
        harness
            .transport
            .push((401, json!({ "ok": false }).to_string()));
        let response = server_request_on(&harness.state, "GET", "/api/runs", None, 2_000).unwrap();
        assert_eq!(response.status, 401);
        let request = harness.transport.requests().pop().unwrap();
        assert!(
            request.headers.iter().all(|(name, _)| name != "Cookie"),
            "{:?}",
            request.headers
        );
    }

    #[test]
    fn api_calls_are_pinned_to_the_configured_server() {
        let harness = harness();
        harness.configure("https://healer.example");
        for hostile in [
            "/api/../etc/passwd",
            "//evil.example/api/x",
            "https://evil.example/api/x",
            "/other/path",
        ] {
            let error = server_request_on(&harness.state, "GET", hostile, None, 1_000).unwrap_err();
            assert_eq!(error.public().code, "invalid-input", "{hostile}");
        }
        for method in ["DELETE", "webdav"] {
            assert!(server_request_on(&harness.state, method, "/api/runs", None, 1_000).is_err());
        }
        assert!(harness.transport.requests().is_empty());
    }

    #[test]
    fn readiness_is_reported_from_the_server_or_not_at_all() {
        let harness = harness();
        harness.configure("https://healer.example");
        harness.transport.push((
            200,
            json!({
                "status": "ready",
                "dataRootWritable": true,
                "persistence": "sqlite",
                "database": { "ok": true },
                "policy": { "modelPatchesEnabled": false },
                "integrations": { "github": false, "sandbox": "local" }
            })
            .to_string(),
        ));
        let summary = resources_summary_on(&harness.state).unwrap();
        assert_eq!(summary.status, "ready");
        assert_eq!(summary.persistence, "sqlite");
        assert_eq!(summary.server_url, "https://healer.example");

        // An unreachable server produces an error, never a fabricated "ready".
        let error = resources_summary_on(&harness.state).unwrap_err();
        assert_eq!(error.public().code, "transport-failed");

        let unconfigured = harness_with(
            ScriptedTransport::default(),
            RecordingOpener::new(),
            RecordingNotifier::new(),
        );
        assert_eq!(
            resources_summary_on(&unconfigured.state)
                .unwrap_err()
                .public()
                .code,
            "not-configured"
        );
    }

    #[test]
    fn opening_the_dashboard_only_ever_uses_the_configured_server() {
        let harness = harness();
        assert_eq!(
            open_dashboard_on(&harness.state).unwrap_err().public().code,
            "not-configured"
        );
        assert!(harness.opener.opened().is_empty());

        harness.configure("https://healer.example");
        open_dashboard_on(&harness.state).unwrap();
        assert_eq!(
            harness.opener.opened(),
            vec!["https://healer.example".to_string()]
        );
    }

    #[test]
    fn notification_policy_is_enforced_end_to_end() {
        let harness = harness();
        // Off by default? No: notifications are on until turned off.
        assert!(harness.state.notifications_allowed_snapshot());

        // Non-terminal states stay silent.
        let outcome = push_run_update_on(&harness.state, "heal_1", "verifying");
        assert_eq!(
            (outcome.notified, outcome.reason.as_str()),
            (false, "not-terminal")
        );

        // A terminal state notifies once.
        let outcome = push_run_update_on(&harness.state, "heal_1", "healed");
        assert_eq!((outcome.notified, outcome.reason.as_str()), (true, "sent"));
        let delivered = harness.notifier.delivered();
        assert_eq!(delivered.len(), 1);
        let (identifier, title, body, run_id) = delivered[0].clone();
        assert_eq!(identifier, 1);
        assert_eq!(title, "Repair verified");
        assert_eq!(body, "Run heal_1 finished as healed.");
        assert_eq!(run_id, "heal_1");
        // The clicked notification resolves to the run it announced.
        assert_eq!(
            notification_run_id(&harness.state, identifier, None).as_deref(),
            Some("heal_1")
        );

        // A reconnect that replays the state does not notify twice.
        let outcome = push_run_update_on(&harness.state, "heal_1", "healed");
        assert_eq!(
            (outcome.notified, outcome.reason.as_str()),
            (false, "duplicate")
        );
        assert_eq!(harness.notifier.delivered().len(), 1);

        // Invalid identifiers are refused before they reach a notification.
        let outcome = push_run_update_on(&harness.state, "../../etc", "healed");
        assert_eq!(
            (outcome.notified, outcome.reason.as_str()),
            (false, "invalid-run-id")
        );

        // The user's opt-out wins over everything.
        set_notifications_allowed_on(&harness.state, false).unwrap();
        let outcome = push_run_update_on(&harness.state, "heal_2", "healed");
        assert_eq!(
            (outcome.notified, outcome.reason.as_str()),
            (false, "disabled")
        );
        assert_eq!(harness.notifier.delivered().len(), 1);
    }

    #[test]
    fn a_notification_backend_failure_is_reported_and_retryable() {
        let harness = harness_with(
            ScriptedTransport::default(),
            RecordingOpener::new(),
            RecordingNotifier::failing(),
        );
        let outcome = push_run_update_on(&harness.state, "heal_9", "timed-out");
        assert_eq!(
            (outcome.notified, outcome.reason.as_str()),
            (false, "delivery-failed")
        );
        // The pair was forgotten, so the next report tries again.
        let outcome = push_run_update_on(&harness.state, "heal_9", "timed-out");
        assert_eq!(outcome.reason.as_str(), "delivery-failed");
        assert_eq!(harness.notifier.delivered().len(), 2);
        // Nothing was recorded as announced.
        assert!(notification_run_id(&harness.state, 1, None).is_none());
    }

    #[test]
    fn notification_targets_are_validated_deep_links() {
        assert_eq!(
            notification_target("heal_69977a13".into()).unwrap(),
            "tracehealer://run/heal_69977a13"
        );
        for hostile in ["", "../etc", "run with spaces", "run/../other"] {
            assert_eq!(
                notification_target(hostile.into())
                    .unwrap_err()
                    .public()
                    .code,
                "invalid-input",
                "{hostile}"
            );
        }
    }

    #[test]
    fn deep_links_accept_only_known_targets() {
        let run = parse_deep_link("tracehealer://run/heal_69977a13").unwrap();
        assert_eq!(
            (run.kind.as_str(), run.id.as_str()),
            ("run", "heal_69977a13")
        );
        let incident = parse_deep_link("tracehealer://incident/inc-42").unwrap();
        assert_eq!(incident.kind, "incident");

        for hostile in [
            "tracehealer://shell/delete-everything",
            "tracehealer://incident/",
            "tracehealer://incident/..%2Fescape",
            "https://evil.example/run/heal_1",
            "tracehealer://run/../../../etc/passwd",
            "not a url",
        ] {
            let error = parse_deep_link(hostile).unwrap_err();
            assert_eq!(error.public().code, "unknown-deep-link", "{hostile}");
        }
    }

    #[test]
    fn the_auth_callback_is_distinguished_from_run_links() {
        assert!(is_auth_callback(
            "tracehealer://auth/callback?state=s&code=c"
        ));
        assert!(is_auth_callback("tracehealer://auth/callback"));
        assert!(!is_auth_callback("tracehealer://run/heal_1"));
        assert!(!is_auth_callback("https://evil.example/auth/callback"));
        assert!(!is_auth_callback("not a url"));
    }

    #[test]
    fn settings_persist_the_server_and_the_notification_preference_only() {
        let harness = harness();
        configure_server_on(&harness.state, "https://healer.example").unwrap();
        set_notifications_allowed_on(&harness.state, false).unwrap();

        let written = std::fs::read_to_string(&harness.settings_path).unwrap();
        assert!(written.contains("https://healer.example"), "{written}");
        assert!(written.contains("false"), "{written}");
        for forbidden in ["token", "secret", "session", "verifier", "cookie"] {
            assert!(
                !written.to_ascii_lowercase().contains(forbidden),
                "{written}"
            );
        }

        let reloaded = settings::load(&harness.settings_path);
        assert_eq!(reloaded.server_url, "https://healer.example");
        assert!(!reloaded.notifications_allowed);
        std::fs::remove_file(&harness.settings_path).ok();
    }
}
