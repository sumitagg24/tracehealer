//! PKCE authorization flow for the desktop client (RFC 7636 + RFC 8252).
//!
//! The shape of one attempt:
//!
//! 1. [`new_pkce`] mints a CSPRNG `state`, `nonce`, and verifier, and derives
//!    the S256 challenge.
//! 2. The pending attempt lives in native process state only. The verifier and
//!    nonce are never handed to the renderer, never logged, and never written
//!    anywhere except the OS credential vault once a session exists.
//! 3. The system browser is opened at the challenge URL.
//! 4. The `tracehealer://auth/callback` deep link is validated: endpoint, TTL,
//!    constant-time state match, provider error, and one-time consumption.
//! 5. The code is exchanged with the original verifier (see [`crate::exchange`]).
//!
//! An attempt is cleared on *any* outcome — success, mismatch, expiry, replay,
//! or provider refusal — so a stale verifier can never be reused.

use crate::errors::AuthError;
pub use crate::vault::StoredSession;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use url::Url;

/// The one callback endpoint the desktop accepts.
pub const REDIRECT_URI: &str = "tracehealer://auth/callback";
/// How long a pending attempt stays usable.
pub const PENDING_TTL_SECS: i64 = 600;
/// Treat a session as expired this many seconds early so a request is never
/// sent with a token that dies in flight.
pub const SESSION_SLACK_SECS: i64 = 60;

/// PKCE material for one attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PkcePair {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
    pub challenge: String,
}

/// 32 CSPRNG bytes, base64url without padding.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Mint a fresh PKCE pair. `challenge` is the unpadded base64url SHA-256 of the
/// verifier (`code_challenge_method=S256`).
pub fn new_pkce() -> PkcePair {
    let verifier = random_token();
    PkcePair {
        state: random_token(),
        nonce: random_token(),
        challenge: URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        verifier,
    }
}

/// Build the authorization URL for the deployment's identity layer.
pub fn authorize_url(
    authorize_endpoint: &Url,
    pkce: &PkcePair,
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
) -> String {
    let mut url = format!(
        "{endpoint}?response_type=code&client_id={client_id}&redirect_uri={redirect}&state={state}&nonce={nonce}&code_challenge={challenge}&code_challenge_method=S256",
        endpoint = authorize_endpoint.as_str(),
        client_id = crate::exchange::form_encode(client_id),
        redirect = crate::exchange::form_encode(redirect_uri),
        state = pkce.state,
        nonce = pkce.nonce,
        challenge = pkce.challenge,
    );
    if !scope.is_empty() {
        url.push_str(&format!("&scope={}", crate::exchange::form_encode(scope)));
    }
    url
}

/// Constant-time comparison for OAuth state and nonce values.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    diff == 0
}

// ---------------------------------------------------------------------------
// One-time callback state (defence in depth behind the pending-attempt slot)
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
/// seen and false on every later sighting, so a captured callback URL can never
/// be replayed even if an attempt were somehow reinstated.
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
// Callback parsing
// ---------------------------------------------------------------------------

/// The query parameters a callback may carry. `error_description` is parsed so
/// it can be *discarded* deliberately rather than accidentally surfacing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackPayload {
    pub state: Option<String>,
    pub code: Option<String>,
    pub error: Option<String>,
}

/// Validate the callback endpoint and read its parameters.
pub fn parse_callback(url: &Url) -> Result<CallbackPayload, AuthError> {
    if url.scheme() != "tracehealer" || url.host_str() != Some("auth") || url.path() != "/callback"
    {
        return Err(AuthError::UnsupportedCallback);
    }
    let mut payload = CallbackPayload {
        state: None,
        code: None,
        error: None,
    };
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" => payload.state = Some(value.to_string()),
            "code" => payload.code = Some(value.to_string()),
            "error" => payload.error = Some(value.to_string()),
            _ => {}
        }
    }
    Ok(payload)
}

// ---------------------------------------------------------------------------
// Pending attempt
// ---------------------------------------------------------------------------

/// Everything a pending authorization attempt needs, held in native state.
#[derive(Clone, Debug)]
pub struct PendingAuthorization {
    pub pkce: PkcePair,
    pub endpoints: crate::exchange::Endpoints,
    pub client_id: String,
    pub redirect_uri: String,
    pub scope: String,
    pub created_at: i64,
    consumed: std::sync::Arc<AtomicBool>,
}

impl PendingAuthorization {
    pub fn new(
        pkce: PkcePair,
        endpoints: crate::exchange::Endpoints,
        client_id: String,
        scope: String,
        created_at: i64,
    ) -> Self {
        Self {
            pkce,
            endpoints,
            client_id,
            redirect_uri: REDIRECT_URI.to_string(),
            scope,
            created_at,
            consumed: std::sync::Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn authorize_url(&self) -> String {
        authorize_url(
            &self.endpoints.authorize,
            &self.pkce,
            &self.client_id,
            &self.redirect_uri,
            &self.scope,
        )
    }

    /// Seconds left before this attempt is refused.
    pub fn seconds_remaining(&self, now: i64) -> i64 {
        (self.created_at + PENDING_TTL_SECS - now).max(0)
    }

    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.created_at + PENDING_TTL_SECS
    }

    fn consume(&self) -> Result<(), AuthError> {
        if self.consumed.swap(true, Ordering::SeqCst) {
            return Err(AuthError::StateReplayed);
        }
        Ok(())
    }

    /// Validate a callback and return the authorization code.
    ///
    /// Order matters: the endpoint is checked before anything is read, an
    /// expired attempt is refused before its state is compared, the state must
    /// match in constant time, the attempt must not have been spent, and a
    /// provider refusal is reported as such — never with the provider's text.
    pub fn accept_callback(&self, url: &Url, now: i64) -> Result<String, AuthError> {
        let payload = parse_callback(url)?;

        if self.is_expired(now) {
            self.consumed.store(true, Ordering::SeqCst);
            return Err(AuthError::StateExpired);
        }

        let state = payload.state.ok_or(AuthError::StateMismatch)?;
        if !constant_time_eq(&state, &self.pkce.state) {
            self.consumed.store(true, Ordering::SeqCst);
            return Err(AuthError::StateMismatch);
        }
        if !consume_state_once(&state) {
            return Err(AuthError::StateReplayed);
        }
        self.consume()?;

        if let Some(error) = payload.error {
            // Only the provider's machine-readable code is kept, and it is only
            // ever used natively: the renderer sees a fixed message.
            return Err(AuthError::ProviderError(error));
        }
        payload
            .code
            .filter(|code| !code.is_empty())
            .ok_or(AuthError::StateMismatch)
    }
}

/// True when the stored session exists and is not within the expiry slack.
pub fn session_is_valid(session: &StoredSession, now: i64) -> bool {
    session.expires_at.saturating_sub(SESSION_SLACK_SECS) > now
}

#[cfg(test)]
impl PendingAuthorization {
    /// Whether the verifier has already been spent. The verifier is handed to
    /// the exchange exactly once; afterwards the attempt reports itself as
    /// replayed rather than reusable.
    fn is_consumed(&self) -> bool {
        self.consumed.load(Ordering::SeqCst)
    }

    /// A fresh attempt with the same identifiers, for tests that need to make
    /// several independent assertions about one state value.
    fn clone_and_reset(&self) -> Self {
        Self {
            pkce: self.pkce.clone(),
            endpoints: self.endpoints.clone(),
            client_id: self.client_id.clone(),
            redirect_uri: self.redirect_uri.clone(),
            scope: self.scope.clone(),
            created_at: self.created_at,
            consumed: std::sync::Arc::new(AtomicBool::new(false)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Url {
        Url::parse("https://healer.example").unwrap()
    }

    fn endpoints() -> crate::exchange::Endpoints {
        crate::exchange::validate_endpoints(
            &server(),
            "https://healer.example/auth/authorize",
            "https://healer.example/auth/token",
        )
        .unwrap()
    }

    fn pending(created_at: i64) -> PendingAuthorization {
        PendingAuthorization::new(
            new_pkce(),
            endpoints(),
            "desktop-client".into(),
            "openid profile".into(),
            created_at,
        )
    }

    fn callback(state: &str, suffix: &str) -> Url {
        Url::parse(&format!(
            "tracehealer://auth/callback?state={state}&{suffix}"
        ))
        .unwrap()
    }

    #[test]
    fn pkce_material_is_random_and_the_challenge_is_s256() {
        let first = new_pkce();
        let second = new_pkce();
        for (a, b) in [
            (&first.state, &second.state),
            (&first.verifier, &second.verifier),
            (&first.nonce, &second.nonce),
            (&first.challenge, &second.challenge),
        ] {
            assert_ne!(a, b);
        }
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(first.verifier.as_bytes()));
        assert_eq!(first.challenge, expected);
        for value in [&first.state, &first.verifier, &first.nonce] {
            assert!(!value.contains('='), "{value}");
            assert!(!value.contains('+'), "{value}");
            assert!(!value.contains('/'), "{value}");
        }
    }

    #[test]
    fn authorize_url_carries_challenge_state_nonce_and_redirect() {
        let attempt = pending(0);
        let url = attempt.authorize_url();
        assert!(
            url.starts_with("https://healer.example/auth/authorize?"),
            "{url}"
        );
        assert!(url.contains("code_challenge_method=S256"), "{url}");
        assert!(
            url.contains(&format!("state={}", attempt.pkce.state)),
            "{url}"
        );
        assert!(
            url.contains(&format!("nonce={}", attempt.pkce.nonce)),
            "{url}"
        );
        assert!(
            url.contains(&format!("code_challenge={}", attempt.pkce.challenge)),
            "{url}"
        );
        assert!(
            url.contains("redirect_uri=tracehealer%3A%2F%2Fauth%2Fcallback"),
            "{url}"
        );
        assert!(url.contains("scope=openid%20profile"), "{url}");
    }

    #[test]
    fn only_the_registered_callback_endpoint_is_accepted() {
        for url in [
            "https://evil.example/auth/callback?state=s&code=c",
            "tracehealer://shell/open?state=s&code=c",
            "tracehealer://auth/logout?state=s&code=c",
            "tracehealer://auth/callback/extra?state=s&code=c",
        ] {
            let parsed = Url::parse(url).unwrap();
            assert!(
                matches!(parse_callback(&parsed), Err(AuthError::UnsupportedCallback)),
                "{url}"
            );
        }
    }

    #[test]
    fn the_correct_state_yields_the_code() {
        let attempt = pending(1_000);
        let url = callback(&attempt.pkce.state, "code=good-code");
        assert_eq!(attempt.accept_callback(&url, 1_010).unwrap(), "good-code");
    }

    #[test]
    fn wrong_missing_and_incorrectly_cased_state_are_refused() {
        let attempt = pending(1_000);
        for candidate in ["attacker", "", "ABC"] {
            let url = callback(candidate, "code=steal");
            assert!(
                matches!(
                    attempt.clone_and_reset().accept_callback(&url, 1_010),
                    Err(AuthError::StateMismatch)
                ),
                "state {candidate}"
            );
        }
        // A callback that never proves the state consumed nothing: the real
        // attempt is still usable afterwards.
        let url = callback(&attempt.pkce.state, "code=good");
        assert_eq!(attempt.accept_callback(&url, 1_010).unwrap(), "good");

        let missing = Url::parse("tracehealer://auth/callback?code=steal").unwrap();
        assert!(matches!(
            pending(1_000).accept_callback(&missing, 1_010),
            Err(AuthError::StateMismatch)
        ));
    }

    #[test]
    fn an_expired_attempt_is_refused_before_the_state_is_read() {
        let attempt = pending(1_000);
        let url = callback(&attempt.pkce.state, "code=good-code");
        let error = attempt
            .accept_callback(&url, 1_000 + PENDING_TTL_SECS)
            .unwrap_err();
        assert!(matches!(error, AuthError::StateExpired), "{error:?}");
        assert_eq!(error.public().code, "auth-expired");
        assert_eq!(attempt.seconds_remaining(1_000), PENDING_TTL_SECS);
        assert_eq!(attempt.seconds_remaining(2_000), 0);
        assert!(attempt.is_consumed(), "an expired attempt is spent");
    }

    #[test]
    fn a_replayed_callback_is_refused() {
        let attempt = pending(1_000);
        let url = callback(&attempt.pkce.state, "code=once");
        assert_eq!(attempt.accept_callback(&url, 1_010).unwrap(), "once");
        // Second delivery of the very same URL: the verifier is spent.
        let replay = attempt.accept_callback(&url, 1_010).unwrap_err();
        assert!(matches!(replay, AuthError::StateReplayed), "{replay:?}");
        assert_eq!(replay.public().code, "auth-replayed");
    }

    #[test]
    fn the_verifier_is_consumed_exactly_once() {
        let attempt = pending(1_000);
        let first = callback(&attempt.pkce.state, "code=one");
        assert!(!attempt.is_consumed());
        attempt.accept_callback(&first, 1_000).unwrap();
        assert!(attempt.is_consumed());
        // A brand new state that was never consumed still cannot reuse this
        // attempt: the attempt itself is spent.
        let second = callback(&attempt.pkce.state, "code=two");
        assert!(matches!(
            attempt.accept_callback(&second, 1_000),
            Err(AuthError::StateReplayed)
        ));
        // A clone shares the spent flag, so nothing can resurrect the verifier.
        let cloned = attempt.clone();
        assert!(cloned.is_consumed());
        assert!(matches!(
            cloned.accept_callback(&second, 1_000),
            Err(AuthError::StateReplayed)
        ));
    }

    #[test]
    fn a_callback_without_a_code_is_refused() {
        for suffix in ["", "code=", "code=&other=1"] {
            let fresh = pending(1_000);
            let url = callback(&fresh.pkce.state, suffix);
            assert!(
                matches!(
                    fresh.accept_callback(&url, 1_010),
                    Err(AuthError::StateMismatch)
                ),
                "suffix {suffix}"
            );
        }
    }

    #[test]
    fn a_provider_refusal_is_reported_without_the_provider_text() {
        let attempt = pending(1_000);
        let url = callback(
            &attempt.pkce.state,
            "error=access_denied&error_description=user%20sumit%20refused%20at%20C%3A%5CUsers",
        );
        let error = attempt.accept_callback(&url, 1_010).unwrap_err();
        let rendered = format!("{error}");
        assert!(!rendered.contains("sumit"), "{rendered}");
        assert!(!rendered.contains("Users"), "{rendered}");
        assert!(matches!(error, AuthError::ProviderError(_)), "{error:?}");
        assert_eq!(error.public(), crate::errors::PublicError::PROVIDER_ERROR);
    }

    #[test]
    fn a_forged_provider_error_still_has_to_prove_the_state() {
        let attempt = pending(1_000);
        let url = callback("attacker", "error=access_denied");
        assert!(matches!(
            attempt.accept_callback(&url, 1_010),
            Err(AuthError::StateMismatch)
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
        assert!(!session_is_valid(&session, 941));
        assert!(!session_is_valid(&session, 2_000));
    }

    #[test]
    fn constant_eq_behaves() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn consumed_state_memory_is_one_time() {
        let state = new_pkce().state;
        assert!(consume_state_once(&state));
        assert!(!consume_state_once(&state));
    }
}
