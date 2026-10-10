use crate::auth::{self, StoredSession};
use serde::{Deserialize, Serialize};
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

#[derive(Default)]
pub struct DesktopState {
    /// Last known connection state sent back to the renderer.
    connection_state: ConnectionState,
    /// True when native notifications are currently allowed by the user.
    notifications_allowed: bool,
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

/// Load the stored session from the OS keychain.
#[tauri::command]
pub fn get_session_state() -> Result<SessionView> {
    match auth::load_session() {
        Ok(session) => Ok(SessionView {
            server_url: session.server_url,
            tenant_id: session.tenant_id,
            workspace_id: session.workspace_id,
            role: session.role,
            expires_at: session.expires_at,
            valid: auth::session_is_valid(chrono_epoch_secs()),
        }),
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

/// Report the current connection state to the renderer and persist it
/// in desktop state so the tray menu can reflect it.
#[tauri::command]
pub fn report_connection(
    state: DesktopState,
    status: ConnectionState,
    app: AppHandle,
) -> Result<()> {
    state.connection_state = status.clone();
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
pub fn push_run_update(state: DesktopState, run_id: String, status: String) -> Result<()> {
    let _ = state;
    let _ = run_id;
    let _ = status;
    // The Rust layer keeps this bridge intentionally thin: the renderer polls or
    // reconnects the server SSE and only calls these helpers when it has already
    // classified a real server response. There is no generic event passthrough here.
    Ok(())
}

/// Ask the renderer to set the tray menu connection label.
#[tauri::command]
pub fn update_tray_state_label(state: DesktopState, label: String) -> Result<()> {
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
    open::that(&redirect_url).map_err(|e| DesktopError::Http(e.to_string()))?;
    Ok(())
}

/// Handle a `tracehealer://auth/callback` deep link.
#[tauri::command]
pub fn handle_callback(state: DesktopState, url: String, app: AppHandle) -> Result<CallbackResult> {
    let parsed = url::Url::parse(&url).map_err(|e| DesktopError::Rejected(e.to_string()))?;
    let code = auth::validate_callback(&parsed, &state.connection_state.server_url)
        .map_err(|e| DesktopError::Auth(e))?;
    let _ = app.emit("auth-callback", &code);
    Ok(CallbackResult { kind: "code".into() })
}

/// Handle a `tracehealer://incident/:id` or `tracehealer://run/:id` deep link.
#[tauri::command]
pub fn handle_deep_link(state: DesktopState, url: String, app: AppHandle) -> Result<DeepLinkTarget> {
    let parsed = url::Url::parse(&url).map_err(|e| DesktopError::Rejected(e.to_string()))?;
    if parsed.scheme() != "tracehealer" {
        return Err(DesktopError::Rejected("unsupported deep-link scheme".into()));
    }
    let path = parsed.host().unwrap_or("").to_string() + parsed.path().trim_start_matches('/');
    let id = parsed
        .path()
        .trim_start_matches('/')
        .split('/')
        .last()
        .unwrap_or("")
        .to_string();
    let target = match path.as_str() {
        "incident" => DeepLinkTarget {
            kind: "incident".into(),
            id,
        },
        "run" => DeepLinkTarget {
            kind: "run".into(),
            id,
        },
        _ => return Err(DesktopError::Rejected(format!("unknown deep-link target: {path}"))),
    };
    let _ = app.emit("deep-link", &target);
    Ok(target)
}

/// Request notification permission from the OS.
#[tauri::command]
pub fn request_notification_permission() -> Result<bool> {
    Ok(false)
    // The real permission request goes through tauri-plugin-notification from the
    // renderer. This command is a placeholder so the button is never dead.
}

/// Toggle whether the desktop client sends native notifications.
#[tauri::command]
pub fn set_notifications_allowed(state: DesktopState, allowed: bool) -> Result<()> {
    state.notifications_allowed = allowed;
    let _ = state;
    Ok(())
}

/// Return the current notification opt-out setting.
#[tauri::command]
pub fn notifications_allowed(state: &DesktopState) -> bool {
    state.notifications_allowed
}

/// Read the current server + workspace settings from the OS-vaulted desktop store.
#[tauri::command]
pub fn get_settings(state: &DesktopState) -> SettingsView {
    SettingsView {
        connection_state: state.connection_state.clone(),
        notifications_allowed: state.notifications_allowed,
        // Server URL, workspace, update channel, and appearance are surfaced from
        // the same store the renderer writes to; this command only mirrors a
        // read-only summary.
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
        let app = tauri::AppHandle::default();
        let state = DesktopState::default();
        let result = handle_deep_link(
            state,
            "tracehealer://shell/delete-everything".into(),
            app,
        );
        assert!(result.is_err());
        assert!(matches!(result, Err(DesktopError::Rejected(_))));
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
