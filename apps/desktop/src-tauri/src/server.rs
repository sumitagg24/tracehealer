//! The only place the desktop talks to a TraceHealer server.
//!
//! The renderer never holds the session token and never chooses a URL: it names
//! an `/api/...` path, the shell attaches the vaulted session cookie, and the
//! response comes back as data. Destinations are pinned to the origin the user
//! configured, so a compromised renderer cannot use the shell as a proxy to
//! another host.

use crate::errors::{AuthError, DesktopError, PublicError, Result};
use crate::exchange::Transport;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

/// A response handed back to the renderer. Response headers are dropped on
/// purpose: nothing in the renderer needs them, and `Set-Cookie` in particular
/// must never reach the webview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

/// Longest API path the shell will send.
const MAX_PATH_LEN: usize = 512;
/// Largest request body the renderer may ask the shell to POST.
pub const MAX_REQUEST_BODY: usize = 256 * 1024;

/// Accept only an in-app API path: rootless, query-only, and free of anything
/// that could change the request target.
pub fn valid_api_path(path: &str) -> bool {
    path.starts_with("/api/")
        && path.len() <= MAX_PATH_LEN
        && !path.starts_with("//")
        && !path.contains("..")
        && !path.contains('\\')
        && !path.contains('#')
        && !path.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Join an API path onto the configured server, then prove the result is still
/// on that server.
pub fn api_url(server: &Url, path: &str) -> Result<Url> {
    if !valid_api_path(path) {
        return Err(DesktopError::Rejected(PublicError::INVALID_INPUT));
    }
    let base = server.as_str().trim_end_matches('/');
    let url = Url::parse(&format!("{base}{path}"))
        .map_err(|_| DesktopError::Rejected(PublicError::INVALID_INPUT))?;
    if url.scheme() != server.scheme()
        || url.host_str() != server.host_str()
        || url.port_or_known_default() != server.port_or_known_default()
    {
        return Err(DesktopError::Rejected(PublicError::SERVER_URL_NOT_ALLOWED));
    }
    Ok(url)
}

/// Perform an authenticated API call. The token is attached here and nowhere
/// else, so it cannot leak through the renderer.
pub fn send_api<T: Transport + ?Sized>(
    transport: &T,
    server: &Url,
    path: &str,
    method: &str,
    body: Option<&str>,
    token: Option<&str>,
) -> Result<ServerResponse> {
    if !matches!(method, "GET" | "POST") {
        return Err(DesktopError::Rejected(PublicError::INVALID_INPUT));
    }
    if let Some(body) = body {
        if body.len() > MAX_REQUEST_BODY {
            return Err(DesktopError::Rejected(PublicError::INVALID_INPUT));
        }
    }
    let url = api_url(server, path)?;
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(token) = token {
        // The server issues signed session cookies; the desktop presents the
        // vaulted value exactly as a browser would.
        headers.push(("Cookie".to_string(), format!("tracehealer_session={token}")));
    }
    if body.is_some() {
        headers.push(("Content-Type".to_string(), "application/json".to_string()));
    }

    let (status, content_type, body) = transport
        .request(method, &url, &headers, body)
        .map_err(DesktopError::from)?;
    Ok(ServerResponse {
        status,
        content_type,
        body,
    })
}

// ---------------------------------------------------------------------------
// Identity-provider boundary
// ---------------------------------------------------------------------------

/// What the server advertises about its external identity layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub configured: bool,
    pub provider: String,
    pub client_id: String,
    pub authorize_endpoint: String,
    pub token_endpoint: String,
    pub scope: String,
    pub reason: String,
}

impl ProviderConfig {
    fn unconfigured(reason: &str) -> Self {
        Self {
            configured: false,
            provider: String::new(),
            client_id: String::new(),
            authorize_endpoint: String::new(),
            token_endpoint: String::new(),
            scope: String::new(),
            reason: reason.to_string(),
        }
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Interpret the server's provider boundary.
///
/// A server that does not implement the endpoint, answers with a non-200, or
/// advertises an incomplete provider is reported as **unconfigured** — the
/// desktop then refuses to open a browser or fabricate a session, rather than
/// pretending sign-in is available.
pub fn provider_config(status: u16, body: &str) -> ProviderConfig {
    if status != 200 {
        return ProviderConfig::unconfigured(
            "this server does not expose a desktop sign-in boundary",
        );
    }
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return ProviderConfig::unconfigured(
            "the sign-in boundary returned an unreadable response",
        );
    };
    if !value
        .get("configured")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        // The server's own `reason` text is remote-controlled and is therefore
        // never surfaced; the desktop has fixed wording for this case.
        return ProviderConfig::unconfigured("external OIDC is not configured on this server");
    }
    let config = ProviderConfig {
        configured: true,
        provider: text(&value, "provider"),
        client_id: text(&value, "clientId"),
        authorize_endpoint: text(&value, "authorizeEndpoint"),
        token_endpoint: text(&value, "tokenEndpoint"),
        scope: text(&value, "scope"),
        reason: String::new(),
    };
    // Fail closed on a half-configured provider.
    if config.client_id.is_empty()
        || config.authorize_endpoint.is_empty()
        || config.token_endpoint.is_empty()
        || config.client_id.len() > 128
        || config.scope.len() > 256
    {
        return ProviderConfig::unconfigured("the advertised provider configuration is incomplete");
    }
    config
}

/// The endpoints a validated provider configuration implies, checked against
/// the configured server origin.
pub fn provider_endpoints(
    server: &Url,
    config: &ProviderConfig,
) -> std::result::Result<crate::exchange::Endpoints, AuthError> {
    // A caller that ignores `configured` must not be able to mint endpoints
    // out of an empty advertisement.
    if !config.configured {
        return Err(AuthError::ProviderUnconfigured);
    }
    crate::exchange::validate_endpoints(server, &config.authorize_endpoint, &config.token_endpoint)
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicySummary {
    pub model_proposals: bool,
    pub allowed_repositories: usize,
    pub allowed_paths: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrationSummary {
    pub name: String,
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourcesSummary {
    pub status: String,
    pub data_root_writable: bool,
    pub persistence: String,
    pub database_ok: bool,
    pub policy: PolicySummary,
    pub integrations: Vec<IntegrationSummary>,
    pub sandbox_provider: String,
    pub server_url: String,
}

fn string_array_len(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}

/// Map the server's own readiness payload into the summary the desktop shows.
///
/// Only counts of allowlisted paths and repositories are surfaced: the desktop
/// has no use for the patterns themselves, and not mirroring them keeps
/// server-side paths out of the webview.
pub fn readiness_summary(server_url: &str, status: u16, body: &str) -> ResourcesSummary {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let policy = value.get("policy");
    let integrations = value.get("integrations");
    let mut listed = Vec::new();
    for name in ["github", "neatlogs", "slack"] {
        listed.push(IntegrationSummary {
            name: name.to_string(),
            configured: integrations
                .and_then(|value| value.get(name))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    ResourcesSummary {
        status: value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("http-{status}")),
        data_root_writable: value
            .get("dataRootWritable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        persistence: value
            .get("persistence")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        database_ok: value
            .get("database")
            .and_then(|database| database.get("ok"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        policy: PolicySummary {
            model_proposals: policy
                .and_then(|policy| policy.get("modelPatchesEnabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            allowed_repositories: string_array_len(
                policy.and_then(|policy| policy.get("allowlistedRepositories")),
            ),
            allowed_paths: string_array_len(
                policy.and_then(|policy| policy.get("allowlistedPatchPaths")),
            ),
        },
        integrations: listed,
        sandbox_provider: integrations
            .and_then(|value| value.get("sandbox"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        server_url: server_url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exchange::testing::ScriptedTransport;
    use serde_json::json;

    fn server() -> Url {
        Url::parse("https://healer.example").unwrap()
    }

    #[test]
    fn only_in_app_api_paths_are_accepted() {
        assert!(valid_api_path("/api/ready"));
        assert!(valid_api_path("/api/runs/heal_1/progress?since=2"));
        for hostile in [
            "",
            "/",
            "/api",
            "/api/../secret",
            "/api/../../etc/passwd",
            "//evil.example/api/x",
            "https://evil.example/api/x",
            "/api/x\\..\\y",
            "/api/x y",
            "/api/x\nHost: evil",
            "/api/x#frag",
            &format!("/api/{}", "a".repeat(MAX_PATH_LEN)),
        ] {
            assert!(!valid_api_path(hostile), "{hostile}");
        }
    }

    #[test]
    fn the_joined_url_cannot_leave_the_configured_origin() {
        let url = api_url(&server(), "/api/runs?since=1").unwrap();
        assert_eq!(url.as_str(), "https://healer.example/api/runs?since=1");

        for hostile in [
            "//evil.example/api/x",
            "https://evil.example/api/x",
            "/api/../x",
        ] {
            assert!(api_url(&server(), hostile).is_err(), "{hostile}");
        }
    }

    #[test]
    fn the_session_cookie_is_attached_only_when_a_token_exists() {
        let transport = ScriptedTransport::new(vec![(200, "{}".into())]);
        let response = send_api(
            &transport,
            &server(),
            "/api/runs",
            "GET",
            None,
            Some("session-token-value"),
        )
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/json");
        let request = transport.requests().pop().unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.url, "https://healer.example/api/runs");
        assert!(
            request.headers.iter().any(|(name, value)| name == "Cookie"
                && value == "tracehealer_session=session-token-value"),
            "{:?}",
            request.headers
        );

        // The token is attached on the wire only; the response the renderer
        // receives never carries it.
        assert!(!response.body.contains("session-token-value"));
        assert!(!serde_json::to_string(&response)
            .unwrap()
            .contains("session-token-value"));

        // Without a token there is no cookie at all.
        let anonymous = ScriptedTransport::new(vec![(200, "{}".into())]);
        send_api(&anonymous, &server(), "/api/ready", "GET", None, None).unwrap();
        let request = anonymous.requests().pop().unwrap();
        assert!(
            request.headers.iter().all(|(name, _)| name != "Cookie"),
            "{:?}",
            request.headers
        );
    }

    #[test]
    fn unsupported_methods_and_oversized_bodies_are_refused() {
        let transport = ScriptedTransport::new(vec![]);
        for method in ["DELETE", "PUT", "PATCH", "get", ""] {
            assert!(
                send_api(&transport, &server(), "/api/runs", method, None, None).is_err(),
                "{method}"
            );
        }
        let huge = "x".repeat(MAX_REQUEST_BODY + 1);
        assert!(send_api(
            &transport,
            &server(),
            "/api/runs",
            "POST",
            Some(&huge),
            None
        )
        .is_err());
        assert!(transport.requests().is_empty(), "nothing may be sent");
    }

    #[test]
    fn a_transport_failure_is_reported_as_such_not_as_data() {
        let transport = ScriptedTransport::new(vec![]);
        let error = send_api(&transport, &server(), "/api/ready", "GET", None, None).unwrap_err();
        assert_eq!(error.public().code, "transport-failed");
    }

    #[test]
    fn the_provider_boundary_fails_closed() {
        let unconfigured = provider_config(
            200,
            &json!({ "configured": false, "reason": "C:\\Users\\Sumit\\secret" }).to_string(),
        );
        assert!(!unconfigured.configured);
        // Fixed wording: a server cannot inject text into what the UI shows.
        assert_eq!(
            unconfigured.reason,
            "external OIDC is not configured on this server"
        );
        assert!(!unconfigured.reason.contains("Sumit"));

        // No endpoint, wrong status, unreadable body: all unconfigured.
        for (status, body) in [
            (404, "not found".to_string()),
            (503, json!({ "configured": true }).to_string()),
            (200, "not json".to_string()),
            (
                200,
                json!({ "configured": true, "clientId": "x" }).to_string(),
            ),
            (
                200,
                json!({
                    "configured": true,
                    "clientId": "x",
                    "authorizeEndpoint": "https://idp.example/a",
                    "tokenEndpoint": ""
                })
                .to_string(),
            ),
        ] {
            let config = provider_config(status, &body);
            assert!(!config.configured, "{status} {body}");
        }
    }

    #[test]
    fn a_complete_provider_config_is_accepted_and_origin_checked() {
        let config = provider_config(
            200,
            &json!({
                "configured": true,
                "provider": "corp-oidc",
                "clientId": "tracehealer-desktop",
                "authorizeEndpoint": "https://healer.example/auth/authorize",
                "tokenEndpoint": "https://healer.example/auth/token",
                "scope": "openid profile"
            })
            .to_string(),
        );
        assert!(config.configured);
        assert_eq!(config.client_id, "tracehealer-desktop");
        assert_eq!(config.provider, "corp-oidc");
        assert!(provider_endpoints(&server(), &config).is_ok());

        // A provider that points somewhere else is refused.
        let mut hostile = config.clone();
        hostile.token_endpoint = "https://attacker.example/token".into();
        assert!(provider_endpoints(&server(), &hostile).is_err());

        // An unconfigured advertisement can never yield endpoints.
        let absent = ProviderConfig::unconfigured("none");
        let error = provider_endpoints(&server(), &absent).unwrap_err();
        assert_eq!(error.public().code, "provider-unconfigured");
    }

    #[test]
    fn readiness_is_mapped_from_the_server_payload_without_inventing_state() {
        let summary = readiness_summary(
            "https://healer.example",
            200,
            &json!({
                "status": "ready",
                "dataRootWritable": true,
                "persistence": "sqlite",
                "database": { "ok": true },
                "policy": {
                    "modelPatchesEnabled": false,
                    "allowlistedRepositories": ["acme/one", "acme/two"],
                    "allowlistedPatchPaths": ["src/**"]
                },
                "integrations": { "github": true, "neatlogs": false, "slack": false, "sandbox": "docker" }
            })
            .to_string(),
        );
        assert_eq!(summary.status, "ready");
        assert!(summary.data_root_writable);
        assert_eq!(summary.persistence, "sqlite");
        assert!(summary.database_ok);
        assert!(!summary.policy.model_proposals);
        assert_eq!(summary.policy.allowed_repositories, 2);
        assert_eq!(summary.policy.allowed_paths, 1);
        assert_eq!(summary.sandbox_provider, "docker");
        assert_eq!(summary.integrations.len(), 3);
        assert!(summary.integrations[0].configured);

        // An unreadable payload yields an explicitly not-ready summary rather
        // than a fabricated "ready".
        let degraded = readiness_summary("https://healer.example", 503, "gateway timeout");
        assert_eq!(degraded.status, "http-503");
        assert!(!degraded.data_root_writable);
        assert!(!degraded.database_ok);
        assert_eq!(degraded.persistence, "unknown");
        assert!(degraded.integrations.iter().all(|entry| !entry.configured));
    }
}
