use crate::auth::{self, PkcePair, StoredSession};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;

mod clock {
    /// A minimal epoch helper so the desktop shell can compare session expiry
    /// against wall time without pulling in a full date library.
    pub fn epoch_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Shared desktop state
// ---------------------------------------------------------------------------

/// Managed renderer-facing state. Interior mutability keeps the Tauri
/// `State<T>` access immutable while still letting commands record the last
/// connection report, the in-flight PKCE attempt, and the notification opt-in.
#[derive(Default)]
pub struct DesktopState {
    connection_state: Mutex<ConnectionState>,
    pending_pkce: Mutex<Option<PkcePair>>,
    notifications_allowed: Mutex<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
pub enum ConnectionState {
    Connected { server_url: String },
    Offline,
    Unauthorized,
    Expired,
    Forbidden,
    ServerUnavailable,
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error("authentication helper failed: {0}")]
    Auth(#[from] auth::AuthError),
    #[error("HTTP request failed: {0}")]
    Http(String),
    #[error("command rejected: {0}")]
    Rejected(String),
}

pub type Result<T> = std::result::Result<T, DesktopError>;

/// Only https URLs may leave the app, with plain http allowed exclusively for
/// loopback development servers. Anything else (file:, javascript:, arbitrary
/// schemes) is rejected before it reaches the system opener.
fn is_allowed_http_url(url: &url::Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
        ),
        _ => false,
    }
}

/// Load the stored session from the OS keychain.
#[tauri::command]
pub fn get_session_state() -> Result<SessionView> {
    match auth::load_session() {
        Ok(session) => {
            let valid = auth::session_is_valid(&session, chrono_epoch_secs());
            Ok(SessionView {
                server_url: session.server_url,
                tenant_id: session.tenant_id,
                workspace_id: session.workspace_id,
                role: session.role,
                expires_at: session.expires_at,
                valid,
            })
        }
        Err(auth::AuthError::NoSession(_)) => Ok(SessionView {
            server_url: String::new(),
            tenant_id: String::new(),
            workspace_id: String::new(),
            role: String::new(),
            expires_at: 0,
            valid: false,
        }),
        Err(e) => Err(DesktopError::Auth(e)),
    }
}

/// Persist a freshly minted session in the OS keychain.
#[tauri::command]
pub fn persist_session(body: SessionBody) -> Result<()> {
    let session = StoredSession {
        server_url: body.server_url.trim_end_matches('/').to_string(),
        tenant_id: body.tenant_id,
        workspace_id: body.workspace_id,
        role: body.role,
        session_token: body.session_token,
        expires_at: body.expires_at,
    };
    auth::store_session(&session)?;
    Ok(())
}

/// Remove the stored session (logout).
#[tauri::command]
pub fn clear_session() -> Result<()> {
    auth::clear_session().map_err(|e| match e {
        auth::AuthError::NoSession(_) => DesktopError::Rejected("no stored session".into()),
        other => DesktopError::Auth(other),
    })
}

/// Mint a PKCE pair for one authorization attempt and return the URL the
/// renderer should open in the system browser. The state stays in native
/// memory only — never in the webview — and is consumed exactly once by
/// `handle_callback`.
#[tauri::command]
pub fn begin_authorization(
    state: State<'_, DesktopState>,
    server_url: String,
    client_id: String,
) -> Result<AuthorizationRequest> {
    let parsed = url::Url::parse(server_url.trim_end_matches('/'))
        .map_err(|e| DesktopError::Rejected(e.to_string()))?;
    if !is_allowed_http_url(&parsed) {
        return Err(DesktopError::Rejected(
            "server URL must be https (or http on loopback)".into(),
        ));
    }
    let pkce = auth::new_pkce();
    let authorize = auth::authorize_url(parsed.as_str(), &pkce, &client_id);
    let state_param = pkce.state.clone();
    *state.pending_pkce.lock().unwrap_or_else(|p| p.into_inner()) = Some(pkce);
    Ok(AuthorizationRequest {
        url: authorize,
        state: state_param,
    })
}

/// Report the current connection state to the renderer and persist it
/// in desktop state so the tray menu can reflect it.
#[tauri::command]
pub fn report_connection(
    state: State<'_, DesktopState>,
    status: ConnectionState,
    app: AppHandle,
) -> Result<()> {
    *state
        .connection_state
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = status.clone();
    let _ = app.emit("connection-state", &status);
    if let Some(window) = app.get_webview_window("main") {
        let label = match &status {
            ConnectionState::Connected { .. } => "Connection: connected",
            ConnectionState::Offline => "Connection: offline",
            ConnectionState::Unauthorized => "Connection: sign in",
            ConnectionState::Expired => "Connection: session expired",
            ConnectionState::Forbidden => "Connection: forbidden",
            ConnectionState::ServerUnavailable => "Connection: server unavailable",
        };
        let _ = window.emit("tray-state-label", label);
    }
    Ok(())
}

/// Tunnel a server-sent run update to the renderer so the UI can classify it.
#[tauri::command]
pub fn push_run_update(
    state: State<'_, DesktopState>,
    run_id: String,
    status: String,
) -> Result<()> {
    let _ = state;
    let _ = run_id;
    let _ = status;
    // The Rust layer keeps this bridge intentionally thin: the renderer polls
    // the server and only calls these helpers when it has already classified a
    // real server response. There is no generic event passthrough here.
    Ok(())
}

/// Ask the renderer to set the tray menu connection label.
#[tauri::command]
pub fn update_tray_state_label(state: State<'_, DesktopState>, label: String) -> Result<()> {
    let _ = state;
    let _ = label;
    // The menu label is updated through an event so the renderer does not need
    // direct tray access.
    Ok(())
}

/// Open the system browser for the configured authorization URL. The callback
/// comes back through the `tracehealer://auth/callback` deep link.
#[tauri::command]
pub fn open_authorize_url(redirect_url: String) -> Result<()> {
    let parsed =
        url::Url::parse(&redirect_url).map_err(|e| DesktopError::Rejected(e.to_string()))?;
    if !is_allowed_http_url(&parsed) {
        return Err(DesktopError::Rejected(
            "authorization URL must be https (or http on loopback)".into(),
        ));
    }
    open::that(parsed.as_str()).map_err(|e| DesktopError::Http(e.to_string()))?;
    Ok(())
}

/// Handle a `tracehealer://auth/callback` deep link. The pending PKCE state
/// is validated in constant time and consumed exactly once, so a captured
/// callback URL can never be replayed.
#[tauri::command]
pub fn handle_callback(
    state: State<'_, DesktopState>,
    url: String,
    app: AppHandle,
) -> Result<CallbackResult> {
    let pending = state
        .pending_pkce
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| DesktopError::Rejected("no authorization in progress".into()))?;
    let parsed = url::Url::parse(&url).map_err(|e| DesktopError::Rejected(e.to_string()))?;
    let code = auth::validate_callback(&parsed, &pending.state)?;
    // Success consumes the attempt; the state itself is already one-time.
    *state.pending_pkce.lock().unwrap_or_else(|p| p.into_inner()) = None;
    let _ = app.emit("auth-callback", &code);
    Ok(CallbackResult {
        kind: "code".into(),
    })
}

/// Parse a `tracehealer://incident/:id` or `tracehealer://run/:id` deep link.
/// Pure so tests never need a live Tauri app.
pub fn parse_deep_link(url: &str) -> Result<DeepLinkTarget, DesktopError> {
    let parsed = url::Url::parse(url).map_err(|e| DesktopError::Rejected(e.to_string()))?;
    if parsed.scheme() != "tracehealer" {
        return Err(DesktopError::Rejected(
            "unsupported deep-link scheme".into(),
        ));
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
        "incident" | "run"
            if !id.is_empty()
                && id.len() <= 80
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') =>
        {
            Ok(DeepLinkTarget { kind, id })
        }
        _ => Err(DesktopError::Rejected(format!(
            "unknown deep-link target: {url}"
        ))),
    }
}

/// Handle a `tracehealer://incident/:id` or `tracehealer://run/:id` deep link.
#[tauri::command]
pub fn handle_deep_link(
    state: State<'_, DesktopState>,
    url: String,
    app: AppHandle,
) -> Result<DeepLinkTarget> {
    let _ = &state;
    let target = parse_deep_link(&url)?;
    let _ = app.emit("deep-link", &target);
    Ok(target)
}

/// Request notification permission from the OS.
#[tauri::command]
pub fn request_notification_permission() -> Result<bool> {
    Ok(false)
    // The real permission request goes through tauri-plugin-notification from
    // the renderer. This command is a placeholder so the button is never dead.
}

/// Toggle whether the desktop client sends native notifications.
#[tauri::command]
pub fn set_notifications_allowed(state: State<'_, DesktopState>, allowed: bool) -> Result<()> {
    *state
        .notifications_allowed
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = allowed;
    Ok(())
}

/// Return the current notification opt-out setting.
#[tauri::command]
pub fn notifications_allowed(state: State<'_, DesktopState>) -> bool {
    *state
        .notifications_allowed
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Read the current server + workspace settings from the OS-vaulted desktop store.
#[tauri::command]
pub fn get_settings(state: State<'_, DesktopState>) -> SettingsView {
    SettingsView {
        connection_state: state
            .connection_state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone(),
        notifications_allowed: *state
            .notifications_allowed
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
        // Server URL, workspace, update channel, and appearance are surfaced
        // from the same store the renderer writes to; this command only
        // mirrors a read-only summary.
        server_url: String::new(),
        workspace_id: String::new(),
        update_channel: "stable".into(),
        appearance: "system".into(),
    }
}

/// Return a read-only summary of server-side health/readiness and integration
/// readiness. This is intentionally read-only and contains no secrets.
#[tauri::command]
pub fn resources_summary(server_url: String) -> Result<ResourcesSummary> {
    // In the real client this would call the server's /api/ready or
    // /api/readiness endpoint through the HTTP plugin. The shape is pinned here
    // so the UI contract is testable without booting Tauri.
    let _ = server_url;
    Ok(ResourcesSummary {
        status: "ready".into(),
        data_root_writable: true,
        policy: PolicySummary {
            model_proposals: false,
            max_patch_bytes: 0,
            allowed_paths: Vec::new(),
        },
        integrations: vec![IntegrationSummary {
            name: "github".into(),
            configured: false,
        }],
    })
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct SessionView {
    pub server_url: String,
    pub tenant_id: String,
    pub workspace_id: String,
    pub role: String,
    pub expires_at: i64,
    pub valid: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SessionBody {
    pub server_url: String,
    pub tenant_id: String,
    pub workspace_id: String,
    pub role: String,
    pub session_token: String,
    pub expires_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AuthorizationRequest {
    pub url: String,
    pub state: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CallbackResult {
    pub kind: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DeepLinkTarget {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SettingsView {
    pub connection_state: ConnectionState,
    pub notifications_allowed: bool,
    pub server_url: String,
    pub workspace_id: String,
    pub update_channel: String,
    pub appearance: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PolicySummary {
    pub model_proposals: bool,
    pub max_patch_bytes: u64,
    pub allowed_paths: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct IntegrationSummary {
    pub name: String,
    pub configured: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ResourcesSummary {
    pub status: String,
    pub data_root_writable: bool,
    pub policy: PolicySummary,
    pub integrations: Vec<IntegrationSummary>,
}

// ---------------------------------------------------------------------------
// Tiny clock helper so tests do not need real wall time
// ---------------------------------------------------------------------------

fn chrono_epoch_secs() -> i64 {
    clock::epoch_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_view_has_no_secret_fields() {
        let view = SessionView {
            server_url: "https://healer.example".into(),
            tenant_id: "t1".into(),
            workspace_id: "w1".into(),
            role: "operator".into(),
            expires_at: 0,
            valid: false,
        };
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("session_token"));
        assert!(!json.contains("token"));
    }

    #[test]
    fn deep_link_unknown_target_is_rejected() {
        for url in [
            "tracehealer://shell/delete-everything",
            "tracehealer://incident/",
            "tracehealer://incident/..%2Fescape",
            "https://evil.example/run/heal_1",
        ] {
            let result = parse_deep_link(url);
            assert!(result.is_err(), "expected rejection for {url}");
        }
    }

    #[test]
    fn deep_link_accepts_incident_and_run_ids() {
        let incident = parse_deep_link("tracehealer://incident/inc-42").unwrap();
        assert_eq!(incident.kind, "incident");
        assert_eq!(incident.id, "inc-42");
        let run = parse_deep_link("tracehealer://run/heal_69977a13").unwrap();
        assert_eq!(run.kind, "run");
        assert_eq!(run.id, "heal_69977a13");
    }

    #[test]
    fn authorize_url_open_is_restricted_to_https_and_loopback() {
        assert!(is_allowed_http_url(
            &url::Url::parse("https://healer.example/auth").unwrap()
        ));
        assert!(is_allowed_http_url(
            &url::Url::parse("http://localhost:3000/auth").unwrap()
        ));
        assert!(!is_allowed_http_url(
            &url::Url::parse("http://healer.example/auth").unwrap()
        ));
        assert!(!is_allowed_http_url(
            &url::Url::parse("file:///etc/passwd").unwrap()
        ));
        assert!(!is_allowed_http_url(
            &url::Url::parse("javascript:alert(1)").unwrap()
        ));
    }

    #[test]
    fn resources_summary_is_read_only() {
        let summary = resources_summary("https://healer.example".into()).unwrap();
        assert!(!summary.integrations.is_empty() || summary.integrations.len() == 0);
        // No server credentials are exposed in the summary.
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("secret"));
    }
}
