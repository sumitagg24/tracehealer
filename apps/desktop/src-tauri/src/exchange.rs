//! Authorization-code exchange (RFC 6749 §4.1.3, RFC 7636 §4.5).
//!
//! The verifier never leaves native memory: the renderer only ever sees the
//! authorization URL, and the code travels from the deep-link callback straight
//! into this module. The response is parsed strictly, and a provider body is
//! never copied into an error, a log, or anything the renderer can read.

use crate::errors::AuthError;
use crate::http::{self, HttpError, MAX_BODY_BYTES};
use serde_json::Value;
use url::Url;

/// The endpoints a desktop client is willing to talk to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub authorize: Url,
    pub token: Url,
}

/// Which URLs the desktop will send a browser to or a secret to: https
/// anywhere, plain http only on loopback (development).
pub fn is_allowed_remote(url: &Url) -> bool {
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
        ),
        _ => false,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Validate the endpoints a server advertises for its identity layer.
///
/// Both endpoints must be well-formed, allowed for the desktop (https, or http
/// on loopback), and share the configured server's origin. A server that
/// advertises an endpoint elsewhere would be asking the desktop to hand a
/// verified authorization code to a third party, which is exactly the
/// confused-deputy case this check exists to block.
pub fn validate_endpoints(
    server_url: &Url,
    authorize: &str,
    token: &str,
) -> Result<Endpoints, AuthError> {
    let authorize = Url::parse(authorize).map_err(|_| AuthError::EndpointNotSameOrigin)?;
    let token = Url::parse(token).map_err(|_| AuthError::EndpointNotSameOrigin)?;
    for endpoint in [&authorize, &token] {
        if !is_allowed_remote(endpoint) || !same_origin(server_url, endpoint) {
            return Err(AuthError::EndpointNotSameOrigin);
        }
    }
    Ok(Endpoints { authorize, token })
}

/// The grant that comes back from a successful exchange. Only the fields the
/// desktop actually stores are kept: a provider-issued `refresh_token` is
/// intentionally dropped, because this client re-runs the browser flow instead
/// of silently renewing a long-lived credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenGrant {
    pub access_token: String,
    pub expires_at: i64,
    pub token_type: String,
}

/// Something the native side can do a bounded HTTP request with. Production
/// uses [`HttpTransport`]; tests substitute a scripted transport so no network
/// is required.
pub trait Transport: Send + Sync {
    /// Returns `(status, content_type, body)`.
    fn request(
        &self,
        method: &str,
        url: &Url,
        headers: &[(String, String)],
        body: Option<&str>,
    ) -> Result<(u16, String, String), HttpError>;
}

/// The real transport, bounded and redirect-free.
pub struct HttpTransport;

impl Transport for HttpTransport {
    fn request(
        &self,
        method: &str,
        url: &Url,
        headers: &[(String, String)],
        body: Option<&str>,
    ) -> Result<(u16, String, String), HttpError> {
        let response = http::send(http::Request {
            method,
            url,
            headers,
            body,
            limit: MAX_BODY_BYTES,
            timeout: http::DEFAULT_TIMEOUT,
        })?;
        Ok((response.status, response.content_type, response.body))
    }
}

/// POST a form body through any transport.
pub fn post_form<T: Transport + ?Sized>(
    transport: &T,
    url: &Url,
    form: &str,
) -> Result<(u16, String, String), HttpError> {
    let headers = [(
        "Content-Type".to_string(),
        "application/x-www-form-urlencoded".to_string(),
    )];
    transport.request("POST", url, &headers, Some(form))
}

/// Percent-encode one form field (RFC 3986 `application/x-www-form-urlencoded`).
pub fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Decode the payload of an id_token without trusting it.
///
/// The signature is deliberately not verified: this client does not accept
/// identity claims from an id_token. The payload is read for one purpose only —
/// to *reject* a response whose nonce does not match the pending attempt, which
/// is an additional fail-closed check, never a source of trust.
fn id_token_nonce(id_token: &str) -> Option<String> {
    let mut parts = id_token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let bytes = base64url_decode(payload)?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("nonce")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let index = alphabet.iter().position(|candidate| *candidate == byte)? as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// A token response may be a few kilobytes; anything larger is a misbehaving
/// endpoint and is refused before it is interpreted.
const MAX_TOKEN_CHARS: usize = 8192;

fn read_access_token(value: &Value) -> Result<String, AuthError> {
    let token = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| AuthError::ExchangeFailed("response carried no access_token".into()))?;
    if token.len() < 16 || token.len() > MAX_TOKEN_CHARS {
        return Err(AuthError::ExchangeFailed(
            "access_token length is outside the accepted range".into(),
        ));
    }
    if token.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AuthError::ExchangeFailed(
            "access_token contains control characters".into(),
        ));
    }
    Ok(token.to_string())
}

fn read_expiry(value: &Value, now: i64) -> i64 {
    let seconds = value
        .get("expires_in")
        .and_then(|raw| {
            raw.as_i64()
                .or_else(|| raw.as_str().and_then(|text| text.parse::<i64>().ok()))
        })
        .filter(|seconds| (60..=86_400).contains(seconds))
        .unwrap_or(3600);
    now.saturating_add(seconds)
}

/// Exchange an authorization code for a session token using the original
/// verifier.
///
/// `expected_nonce` must be the nonce minted for this attempt; when the
/// provider returns an `id_token`, a mismatching nonce fails the exchange.
#[allow(clippy::too_many_arguments)]
pub fn exchange_code<T: Transport + ?Sized>(
    transport: &T,
    endpoints: &Endpoints,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
    expected_nonce: &str,
    now: i64,
) -> Result<TokenGrant, AuthError> {
    if client_id.is_empty() || code.is_empty() || verifier.is_empty() {
        return Err(AuthError::ExchangeFailed(
            "client_id, code, and verifier are all required".into(),
        ));
    }
    let form = [
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("code_verifier", verifier.to_string()),
        ("client_id", client_id.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
    ]
    .iter()
    .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(value)))
    .collect::<Vec<_>>()
    .join("&");

    let (status, _content_type, body) = post_form(transport, &endpoints.token, &form)
        .map_err(|error| AuthError::ExchangeFailed(format!("transport: {error}")))?;

    // A provider error body is never reproduced, only the fact that it failed.
    if !(200..300).contains(&status) {
        return Err(AuthError::ExchangeFailed(format!(
            "token endpoint returned status {status}"
        )));
    }
    if body.len() > MAX_TOKEN_CHARS.saturating_mul(4) {
        return Err(AuthError::ExchangeFailed(
            "token response was too large".into(),
        ));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|_| AuthError::ExchangeFailed("token response was not JSON".into()))?;

    if let Some(id_token) = value.get("id_token").and_then(Value::as_str) {
        match id_token_nonce(id_token) {
            Some(nonce) if crate::auth::constant_time_eq(&nonce, expected_nonce) => {}
            _ => {
                return Err(AuthError::ExchangeFailed(
                    "id_token nonce did not match the pending attempt".into(),
                ))
            }
        }
    }

    Ok(TokenGrant {
        access_token: read_access_token(&value)?,
        expires_at: read_expiry(&value, now),
        token_type: value
            .get("token_type")
            .and_then(Value::as_str)
            .unwrap_or("Bearer")
            .to_string(),
    })
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// One recorded request.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SentRequest {
        pub method: String,
        pub url: String,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    /// A transport that replays scripted responses and records what it was
    /// asked to send.
    #[derive(Default)]
    pub struct ScriptedTransport {
        responses: Mutex<VecDeque<(u16, String, String)>>,
        pub sent: Mutex<Vec<SentRequest>>,
    }

    impl ScriptedTransport {
        pub fn new(responses: Vec<(u16, String)>) -> Self {
            Self::with_content_type(responses, "application/json")
        }

        fn with_content_type(responses: Vec<(u16, String)>, content_type: &str) -> Self {
            Self {
                responses: Mutex::new(
                    responses
                        .into_iter()
                        .map(|(status, body)| (status, content_type.to_string(), body))
                        .collect(),
                ),
                sent: Mutex::new(Vec::new()),
            }
        }

        pub fn push(&self, response: (u16, String)) {
            self.responses.lock().expect("scripted").push_back((
                response.0,
                "application/json".to_string(),
                response.1,
            ));
        }

        pub fn requests(&self) -> Vec<SentRequest> {
            self.sent.lock().expect("scripted").clone()
        }

        pub fn last_form(&self) -> String {
            self.requests()
                .last()
                .map(|recorded| recorded.body.clone())
                .unwrap_or_default()
        }
    }

    impl Transport for ScriptedTransport {
        fn request(
            &self,
            method: &str,
            url: &Url,
            headers: &[(String, String)],
            body: Option<&str>,
        ) -> Result<(u16, String, String), HttpError> {
            self.sent.lock().expect("scripted").push(SentRequest {
                method: method.to_string(),
                url: url.to_string(),
                headers: headers.to_vec(),
                body: body.unwrap_or("").to_string(),
            });
            self.responses
                .lock()
                .expect("scripted")
                .pop_front()
                .ok_or_else(|| HttpError::Io("no scripted response left".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::ScriptedTransport;
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use serde_json::json;

    const SERVER: &str = "https://healer.example";

    fn server() -> Url {
        Url::parse(SERVER).unwrap()
    }

    fn endpoints() -> Endpoints {
        validate_endpoints(
            &server(),
            "https://healer.example/auth/authorize",
            "https://healer.example/auth/token",
        )
        .unwrap()
    }

    fn id_token_with_nonce(nonce: &str) -> String {
        let payload = json!({ "nonce": nonce, "sub": "user-1" });
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        format!("header.{encoded}.signature")
    }

    #[test]
    fn endpoints_must_share_the_configured_server_origin() {
        let cross_origin = validate_endpoints(
            &server(),
            "https://attacker.example/authorize",
            "https://attacker.example/token",
        );
        assert!(matches!(
            cross_origin,
            Err(AuthError::EndpointNotSameOrigin)
        ));

        // A different port is a different origin.
        let other_port = validate_endpoints(
            &server(),
            "https://healer.example:8443/auth/authorize",
            "https://healer.example/auth/token",
        );
        assert!(matches!(other_port, Err(AuthError::EndpointNotSameOrigin)));

        // Plain http off loopback is refused even when same-origin.
        let plain = validate_endpoints(
            &Url::parse("http://healer.example").unwrap(),
            "http://healer.example/auth/authorize",
            "http://healer.example/auth/token",
        );
        assert!(matches!(plain, Err(AuthError::EndpointNotSameOrigin)));

        // Loopback development is allowed.
        let loopback = validate_endpoints(
            &Url::parse("http://localhost:3000").unwrap(),
            "http://localhost:3000/auth/authorize",
            "http://localhost:3000/auth/token",
        );
        assert!(loopback.is_ok());

        let not_a_url = validate_endpoints(&server(), "not a url", "https://healer.example/token");
        assert!(matches!(not_a_url, Err(AuthError::EndpointNotSameOrigin)));
    }

    #[test]
    fn a_valid_response_yields_a_bounded_grant() {
        let transport = ScriptedTransport::new(vec![(
            200,
            json!({ "access_token": "tok_abcdefghijklmnop", "expires_in": 900, "token_type": "Bearer" })
                .to_string(),
        )]);
        let grant = exchange_code(
            &transport,
            &endpoints(),
            "desktop-client",
            "tracehealer://auth/callback",
            "auth-code-1",
            "verifier-value-1",
            "nonce-1",
            1_000,
        )
        .unwrap();
        assert_eq!(grant.access_token, "tok_abcdefghijklmnop");
        assert_eq!(grant.expires_at, 1_900);
        assert_eq!(grant.token_type, "Bearer");

        let form = transport.last_form();
        assert!(form.contains("grant_type=authorization_code"), "{form}");
        assert!(form.contains("code=auth-code-1"), "{form}");
        assert!(form.contains("code_verifier=verifier-value-1"), "{form}");
        // The redirect URI is percent-encoded rather than injected raw.
        assert!(
            form.contains("redirect_uri=tracehealer%3A%2F%2Fauth%2Fcallback"),
            "{form}"
        );
    }

    #[test]
    fn missing_endpoints_are_rejected_before_any_request() {
        let transport = ScriptedTransport::new(vec![]);
        assert!(exchange_code(&transport, &endpoints(), "", "r", "c", "v", "n", 0).is_err());
        assert!(exchange_code(&transport, &endpoints(), "client", "r", "", "v", "n", 0).is_err());
        assert!(exchange_code(&transport, &endpoints(), "client", "r", "c", "", "n", 0).is_err());
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn a_provider_error_body_is_never_reproduced() {
        let transport = ScriptedTransport::new(vec![(
            400,
            json!({ "error": "invalid_grant", "error_description": "secret detail 4f3a9c" })
                .to_string(),
        )]);
        let error = exchange_code(
            &transport,
            &endpoints(),
            "client",
            "tracehealer://auth/callback",
            "code",
            "verifier",
            "nonce",
            0,
        )
        .unwrap_err();
        let rendered = format!("{error}");
        assert!(!rendered.contains("4f3a9c"), "{rendered}");
        assert!(!rendered.contains("invalid_grant"), "{rendered}");
        assert!(rendered.contains("status 400"), "{rendered}");
        assert_eq!(error.public().code, "exchange-failed");
    }

    #[test]
    fn malformed_or_hostile_responses_are_refused() {
        for body in [
            "not json at all".to_string(),
            json!({ "token_type": "Bearer" }).to_string(),
            json!({ "access_token": "short" }).to_string(),
            json!({ "access_token": "tok_with\nnewline_inside_value" }).to_string(),
            json!({ "access_token": 12 }).to_string(),
        ] {
            let transport = ScriptedTransport::new(vec![(200, body.clone())]);
            let result = exchange_code(
                &transport,
                &endpoints(),
                "client",
                "tracehealer://auth/callback",
                "code",
                "verifier",
                "nonce",
                0,
            );
            assert!(result.is_err(), "accepted {body}");
        }
    }

    #[test]
    fn id_token_nonce_must_match_the_pending_attempt() {
        let matching = ScriptedTransport::new(vec![(
            200,
            json!({
                "access_token": "tok_abcdefghijklmnop",
                "id_token": id_token_with_nonce("nonce-1"),
            })
            .to_string(),
        )]);
        assert!(exchange_code(
            &matching,
            &endpoints(),
            "client",
            "tracehealer://auth/callback",
            "code",
            "verifier",
            "nonce-1",
            0,
        )
        .is_ok());

        let mismatch = ScriptedTransport::new(vec![(
            200,
            json!({
                "access_token": "tok_abcdefghijklmnop",
                "id_token": id_token_with_nonce("attacker-nonce"),
            })
            .to_string(),
        )]);
        let error = exchange_code(
            &mismatch,
            &endpoints(),
            "client",
            "tracehealer://auth/callback",
            "code",
            "verifier",
            "nonce-1",
            0,
        )
        .unwrap_err();
        assert!(format!("{error}").contains("nonce"), "{error}");

        // An id_token with no readable payload is also refused.
        let opaque = ScriptedTransport::new(vec![(
            200,
            json!({ "access_token": "tok_abcdefghijklmnop", "id_token": "not-a-jwt" }).to_string(),
        )]);
        assert!(exchange_code(
            &opaque,
            &endpoints(),
            "client",
            "tracehealer://auth/callback",
            "code",
            "verifier",
            "nonce-1",
            0,
        )
        .is_err());
    }

    #[test]
    fn refresh_tokens_are_never_kept() {
        let transport = ScriptedTransport::new(vec![(
            200,
            json!({
                "access_token": "tok_abcdefghijklmnop",
                "refresh_token": "refresh-should-never-be-stored",
                "expires_in": 600,
            })
            .to_string(),
        )]);
        let grant = exchange_code(
            &transport,
            &endpoints(),
            "client",
            "tracehealer://auth/callback",
            "code",
            "verifier",
            "nonce",
            0,
        )
        .unwrap();
        let rendered = format!("{grant:?}");
        assert!(
            !rendered.contains("refresh-should-never-be-stored"),
            "{rendered}"
        );
        assert!(!rendered.contains("refresh"), "{rendered}");
        // The grant carries only the three fields the desktop stores.
        for field in ["access_token", "expires_at", "token_type"] {
            assert!(rendered.contains(field), "{rendered}");
        }
        assert_eq!(rendered.matches(": ").count(), 3, "{rendered}");
    }

    #[test]
    fn expiry_is_clamped_to_sane_bounds() {
        for (raw, now, expected) in [
            (json!({ "expires_in": 60 }), 100, 160),
            (json!({ "expires_in": 86_400 }), 100, 86_500),
            // Absurd or absent values fall back to one hour.
            (json!({ "expires_in": 1 }), 100, 3_700),
            (json!({ "expires_in": -5 }), 100, 3_700),
            (json!({ "expires_in": "900" }), 100, 1_000),
            (json!({}), 100, 3_700),
        ] {
            let mut payload = raw.as_object().cloned().unwrap();
            payload.insert("access_token".into(), json!("tok_abcdefghijklmnop"));
            let transport = ScriptedTransport::new(vec![(200, Value::Object(payload).to_string())]);
            let grant = exchange_code(
                &transport,
                &endpoints(),
                "client",
                "tracehealer://auth/callback",
                "code",
                "verifier",
                "nonce",
                now,
            )
            .unwrap();
            assert_eq!(grant.expires_at, expected, "{raw}");
        }
    }

    #[test]
    fn form_encoding_escapes_reserved_characters() {
        assert_eq!(form_encode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(
            form_encode("tracehealer://auth/callback"),
            "tracehealer%3A%2F%2Fauth%2Fcallback"
        );
        assert_eq!(form_encode("ABC-_~.9"), "ABC-_~.9");
    }
}
