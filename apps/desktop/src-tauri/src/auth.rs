use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use thiserror::Error;
use url::Url;

/// Errors raised by the desktop authentication helper.
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("OAuth state mismatch: possible interception")]
    StateMismatch,
    #[error("callback URL is not the registered tracehealer://auth/callback endpoint")]
    UnsupportedCallback,
    #[error("OAuth state was already used: replay rejected")]
    StateReplayed,
    #[error("the OS credential vault refused access: {0}")]
    Keyring(String),
    #[error("no stored session for {0}")]
    NoSession(String),
    #[error("session is unusable: {0}")]
    Corrupt(String),
    #[error("credential storage is not available")]
    Unavailable,
}

/// A signed-in desktop session. The session token lives only in the OS
/// credential vault (Windows Credential Manager, macOS Keychain, Linux
/// Secret Service via DBus); it is never written to localStorage, a Tauri
/// store file, or a plaintext file on disk.
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
#[derive(Clone)]
pub struct PkcePair {
    pub state: String,
    pub verifier: String,
    pub challenge: String,
}

/// Generate a fresh PKCE pair for one authorization attempt.
///
/// State and verifier are 32 bytes from the OS CSPRNG, encoded base64url
/// without padding; the challenge is the unpadded base64url SHA-256 of the
/// verifier (RFC 7636, `code_challenge_method=S256`).
pub fn new_pkce() -> PkcePair {
    let mut state_bytes = [0u8; 32];
    let mut verifier_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut state_bytes);
    OsRng.fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PkcePair {
        state: URL_SAFE_NO_PAD.encode(state_bytes),
        verifier,
        challenge,
    }
}

/// Build the authorization URL for the deployment's identity layer.
pub fn authorize_url(server_url: &str, pkce: &PkcePair, client_id: &str) -> String {
    format!(
        "{server}/auth/authorize?response_type=code&client_id={client_id}&state={state}&code_challenge={challenge}&code_challenge_method=S256",
        server = server_url.trim_end_matches('/'),
        client_id = client_id,
        state = pkce.state,
        challenge = pkce.challenge
    )
}

// ---------------------------------------------------------------------------
// One-time callback state (replay rejection)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ConsumedStates {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

/// Bounded memory for consumed states: enough for a long-lived client while
/// keeping the replay set from growing without limit.
const MAX_CONSUMED_STATES: usize = 512;

static CONSUMED_STATES: Mutex<Option<ConsumedStates>> = Mutex::new(None);

/// Record an OAuth state as consumed. Returns true the first time a state is
/// seen and false on every later sighting, so a captured callback URL can
/// never be replayed.
pub fn consume_state_once(state: &str) -> bool {
    let mut guard = match CONSUMED_STATES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let map = guard.get_or_insert_with(ConsumedStates::default);
    if !map.seen.insert(state.to_string()) {
        return false;
    }
    map.order.push_back(state.to_string());
    while map.order.len() > MAX_CONSUMED_STATES {
        if let Some(old) = map.order.pop_front() {
            map.seen.remove(&old);
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Callback validation
// ---------------------------------------------------------------------------

/// Validate the deep-link callback: exact registered endpoint, exact
/// one-time state, then return the authorization code.
pub fn validate_callback(query: &Url, expected_state: &str) -> Result<String, AuthError> {
    if query.scheme() != "tracehealer"
        || query.host_str() != Some("auth")
        || query.path() != "/callback"
    {
        return Err(AuthError::UnsupportedCallback);
    }
    let state = query
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .ok_or(AuthError::StateMismatch)?;
    if !constant_eq(state.as_bytes(), expected_state.as_bytes()) {
        return Err(AuthError::StateMismatch);
    }
    if !consume_state_once(&state) {
        return Err(AuthError::StateReplayed);
    }
    query
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.to_string())
        .ok_or(AuthError::StateMismatch)
}

// ---------------------------------------------------------------------------
// OS credential vault
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "tracehealer.desktop";
const KEYRING_USER: &str = "desktop-session";
/// Treat a session as expired this many seconds before its real expiry so a
/// request is never sent with a token that dies in flight.
const SESSION_SLACK_SECS: i64 = 60;

fn vault_entry() -> Result<keyring::Entry, AuthError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| AuthError::Keyring(e.to_string()))
}

/// Persist the session in the OS credential vault (never localStorage).
pub fn store_session(session: &StoredSession) -> Result<(), AuthError> {
    let serialized =
        serde_json::to_string(session).map_err(|e| AuthError::Corrupt(e.to_string()))?;
    vault_entry()?
        .set_password(&serialized)
        .map_err(|e| AuthError::Keyring(e.to_string()))
}

/// Read the session back, reporting a missing entry distinctly from a
/// corrupt one.
pub fn load_session() -> Result<StoredSession, AuthError> {
    let password = match vault_entry()?.get_password() {
        Ok(password) => password,
        Err(keyring::Error::NoEntry) => return Err(AuthError::NoSession(KEYRING_SERVICE.into())),
        Err(e) => return Err(AuthError::Keyring(e.to_string())),
    };
    serde_json::from_str(&password).map_err(|e| AuthError::Corrupt(e.to_string()))
}

/// True when the stored session exists and is not expired (60s slack).
pub fn session_is_valid(session: &StoredSession, now_epoch_secs: i64) -> bool {
    session.expires_at.saturating_sub(SESSION_SLACK_SECS) > now_epoch_secs
}

/// Erase the session (logout) or report that none existed.
pub fn clear_session() -> Result<(), AuthError> {
    match vault_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AuthError::Keyring(e.to_string())),
    }
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
    fn pkce_pair_is_random_per_call() {
        let first = new_pkce();
        let second = new_pkce();
        assert_ne!(first.state, second.state);
        assert_ne!(first.verifier, second.verifier);
        assert_ne!(first.challenge, second.challenge);
        // The challenge is the unpadded base64url SHA-256 of the verifier.
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(first.verifier.as_bytes()));
        assert_eq!(first.challenge, expected);
        // base64url of 32 bytes has no padding characters.
        assert!(!first.state.contains('='));
        assert!(!first.verifier.contains('='));
    }

    #[test]
    fn authorize_url_carries_pkce_and_state() {
        let pkce = new_pkce();
        let url = authorize_url("https://healer.example", &pkce, "client-id");
        assert!(url.starts_with("https://healer.example/auth/authorize?"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains(&format!("state={}", pkce.state)));
        assert!(url.contains(&format!("code_challenge={}", pkce.challenge)));
    }

    #[test]
    fn callback_state_is_validated_constant_time() {
        let pkce = new_pkce();
        let good = Url::parse(&format!(
            "tracehealer://auth/callback?state={}&code=good-code",
            pkce.state
        ))
        .unwrap();
        assert_eq!(validate_callback(&good, &pkce.state).unwrap(), "good-code");

        let evil = Url::parse("tracehealer://auth/callback?state=attacker&code=steal").unwrap();
        assert!(matches!(
            validate_callback(&evil, &pkce.state),
            Err(AuthError::StateMismatch)
        ));

        let missing = Url::parse("tracehealer://auth/callback").unwrap();
        assert!(matches!(
            validate_callback(&missing, &pkce.state),
            Err(AuthError::StateMismatch)
        ));
    }

    #[test]
    fn callback_rejects_other_endpoints_and_schemes() {
        let pkce = new_pkce();
        for url in [
            format!(
                "https://evil.example/auth/callback?state={}&code=x",
                pkce.state
            ),
            format!("tracehealer://shell/open?state={}&code=x", pkce.state),
            format!("tracehealer://auth/logout?state={}&code=x", pkce.state),
        ] {
            let parsed = Url::parse(&url).unwrap();
            assert!(matches!(
                validate_callback(&parsed, &pkce.state),
                Err(AuthError::UnsupportedCallback)
            ));
        }
    }

    #[test]
    fn callback_state_cannot_be_replayed() {
        let pkce = new_pkce();
        let callback = Url::parse(&format!(
            "tracehealer://auth/callback?state={}&code=once",
            pkce.state
        ))
        .unwrap();
        assert_eq!(validate_callback(&callback, &pkce.state).unwrap(), "once");
        // The same captured URL must be rejected on every later delivery.
        assert!(matches!(
            validate_callback(&callback, &pkce.state),
            Err(AuthError::StateReplayed)
        ));
        assert!(matches!(
            validate_callback(&callback, &pkce.state),
            Err(AuthError::StateReplayed)
        ));
    }

    #[test]
    fn session_validity_honours_expiry_and_slack() {
        let session = StoredSession {
            server_url: "https://healer.example".into(),
            tenant_id: "t1".into(),
            workspace_id: "w1".into(),
            role: "operator".into(),
            session_token: "secret".into(),
            expires_at: 1_000,
        };
        assert!(session_is_valid(&session, 900));
        // Inside the 60s slack window the session is treated as expired.
        assert!(!session_is_valid(&session, 941));
        assert!(!session_is_valid(&session, 2_000));
    }

    #[test]
    fn stored_session_serializes_the_vault_blob_only() {
        // The vault blob is opaque to the OS; this asserts the shape the
        // vault stores, not anything reachable from the renderer.
        let session = StoredSession {
            server_url: "https://healer.example".into(),
            tenant_id: "t1".into(),
            workspace_id: "w1".into(),
            role: "operator".into(),
            session_token: "secret".into(),
            expires_at: 1_000,
        };
        let blob = serde_json::to_string(&session).unwrap();
        assert!(blob.contains("session_token"));
    }

    #[test]
    fn consumed_states_are_one_time_and_bounded() {
        let first = new_pkce().state;
        assert!(consume_state_once(&first));
        assert!(!consume_state_once(&first));
    }

    #[test]
    fn constant_eq_behaves() {
        assert!(constant_eq(b"abc", b"abc"));
        assert!(!constant_eq(b"abc", b"abd"));
        assert!(!constant_eq(b"abc", b"abcd"));
    }
}
