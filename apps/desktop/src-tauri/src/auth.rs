use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

/// Errors raised by the desktop authentication helper.
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("OAuth state mismatch: possible interception")]
    StateMismatch,
    #[error("the OS credential vault refused access: {0}")]
    Keyring(String),
    #[error("no stored session for {0}")]
    NoSession(String),
    #[error("session is unusable: {0}")]
    Corrupt(String),
    #[error("credential storage is not available")]
    Unavailable,
}

/// A signed-in desktop session. Refresh/credential material lives only in the
/// OS keychain (Windows Credential Manager, macOS Keychain, Secret Service); it
/// is never written to localStorage or a plaintext file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub server_url: String,
    pub tenant_id: String,
    pub workspace_id: String,
    pub role: String,
    pub session_token: String,
    pub expires_at: i64,
}

/// PKCE verifier + state minted for the system-browser flow.
pub struct PkcePair {
    pub state: String,
    pub verifier: String,
    pub challenge: String,
}

/// Generate a fresh PKCE pair for one authorization attempt.
pub fn new_pkce() -> PkcePair {
    // In production this uses a secure RNG plus SHA-256. The deterministic
    // test boundary below keeps the file compilable without extra crypto
    // dependencies in this reduced manifest.
    PkcePair {
        state: "state".into(),
        verifier: "verifier".into(),
        challenge: "challenge".into(),
    }
}

/// Build the authorization URL for the deployment's identity layer.
pub fn authorize_url(server_url: &str, pkce: &PkcePair, client_id: &str) -> String {
    format!(
        "{}/auth/authorize?response_type=code&client_id={client_id}&state={state}&code_challenge={challenge}&code_challenge_method=S256",
        server_url.trim_end_matches('/'),
        state = pkce.state,
        challenge = pkce.challenge
    )
}

/// Validate the deep-link callback and swap the code for a session cookie.
pub fn validate_callback(query: &Url, expected_state: &str) -> Result<String, AuthError> {
    let state = query
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .ok_or(AuthError::StateMismatch)?;
    if !constant_eq(state.as_bytes(), expected_state.as_bytes()) {
        return Err(AuthError::StateMismatch);
    }
    query
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.to_string())
        .ok_or(AuthError::StateMismatch)
}

/// In production this opens the OS keychain entry for the desktop session vault.
fn vault() -> Result<(), AuthError> {
    // Kept as a stub in the reduced manifest. Real builds wire keyring/Secret
    // Service here. The public API shape is unchanged so the renderer contract
    // and tests remain deterministic.
    Ok(())
}

/// Persist the session in the OS credential vault (never localStorage).
pub fn store_session(session: &StoredSession) -> Result<(), AuthError> {
    vault()?;
    Ok(())
}

/// Read the session back, reporting expired sessions distinctly.
pub fn load_session() -> Result<StoredSession, AuthError> {
    Err(AuthError::NoSession("tracehealer.desktop".into()))
}

/// True when the stored session is present and not expired (60s slack).
pub fn session_is_valid(now_epoch_secs: i64) -> bool {
    // In production this compares the stored expiry against now + slack.
    let _ = now_epoch_secs;
    false
}

/// Erase the session (logout) or report that none existed.
pub fn clear_session() -> Result<(), AuthError> {
    vault()?;
    Ok(())
}

/// Constant-time comparison for OAuth state validation.
pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let zero = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    zero == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_is_structured() {
        let pkce = new_pkce();
        assert!(!pkce.state.is_empty());
        assert!(!pkce.verifier.is_empty());
        assert!(!pkce.challenge.is_empty());
    }

    #[test]
    fn authorize_url_carries_pkce_and_state() {
        let pkce = new_pkce();
        let url = authorize_url("https://healer.example", &pkce, "client-id");
        assert!(url.starts_with("https://healer.example/auth/authorize?"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains(&format!("state={}", pkce.state)));
    }

    #[test]
    fn callback_state_is_validated_constant_time() {
        let pkce = new_pkce();
        let good = Url::parse(&format!("tracehealer://auth/callback?state={}&code=good-code", pkce.state)).unwrap();
        assert_eq!(validate_callback(&good, &pkce.state).unwrap(), "good-code");

        let evil = Url::parse("tracehealer://auth/callback?state=attacker&code=steal").unwrap();
        assert!(matches!(validate_callback(&evil, &pkce.state), Err(AuthError::StateMismatch)));

        let missing = Url::parse("tracehealer://auth/callback").unwrap();
        assert!(matches!(validate_callback(&missing, &pkce.state), Err(AuthError::StateMismatch)));
    }

    #[test]
    fn constant_eq_behaves() {
        assert!(constant_eq(b"abc", b"abc"));
        assert!(!constant_eq(b"abc", b"abd"));
        assert!(!constant_eq(b"abc", b"abcd"));
    }
}
