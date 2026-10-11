//! Error types for the desktop shell.
//!
//! Two shapes exist on purpose:
//!
//! * the internal enums ([`AuthError`], [`VaultError`], [`DesktopError`]) carry
//!   whatever detail a maintainer needs to debug a failure natively, and
//! * [`PublicError`] is the only shape that crosses the Tauri IPC boundary or
//!   is written to a diagnostic sink.
//!
//! `PublicError` holds `&'static str` fields, so it is impossible for a caller
//! to smuggle a path, token, user name, vault identifier, or provider body into
//! a message the renderer can read — there is simply nowhere to put it.

use crate::redact::scrub;
use serde::Serialize;
use thiserror::Error;

/// The stable, renderer-visible error shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PublicError {
    /// Stable machine-readable code; renders as `code` over IPC.
    pub code: &'static str,
    /// Fixed human-readable text selected by `code`.
    pub message: &'static str,
}

impl PublicError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const INVALID_INPUT: Self =
        Self::new("invalid-input", "The desktop client rejected that input.");
    pub const SERVER_URL_NOT_ALLOWED: Self = Self::new(
        "server-url-not-allowed",
        "The server address must use https, or http on loopback.",
    );
    pub const AUTH_REJECTED: Self = Self::new(
        "auth-rejected",
        "The sign-in response did not match the pending authorization attempt.",
    );
    pub const AUTH_EXPIRED: Self = Self::new(
        "auth-expired",
        "The sign-in attempt expired. Start sign-in again.",
    );
    pub const AUTH_REPLAYED: Self = Self::new(
        "auth-replayed",
        "That sign-in response was already used and was refused.",
    );
    pub const AUTH_NO_ATTEMPT: Self = Self::new(
        "auth-no-attempt",
        "No sign-in is in progress on this machine.",
    );
    pub const PROVIDER_UNCONFIGURED: Self = Self::new(
        "provider-unconfigured",
        "External OIDC is not configured on this server, so no sign-in can be completed.",
    );
    pub const PROVIDER_ERROR: Self = Self::new(
        "provider-error",
        "The identity provider refused the sign-in.",
    );
    pub const EXCHANGE_FAILED: Self = Self::new(
        "exchange-failed",
        "The authorization code could not be exchanged for a session.",
    );
    pub const VAULT_UNAVAILABLE: Self = Self::new(
        "vault-unavailable",
        "The operating system credential vault is unavailable on this machine.",
    );
    pub const NO_SESSION: Self = Self::new("no-session", "No stored session exists.");
    pub const SESSION_UNUSABLE: Self = Self::new(
        "session-unusable",
        "The stored session could not be read and must be recreated.",
    );
    pub const TRANSPORT_FAILED: Self =
        Self::new("transport-failed", "The server could not be reached.");
    pub const UNKNOWN_DEEP_LINK: Self = Self::new(
        "unknown-deep-link",
        "That link is not a supported TraceHealer link.",
    );
    pub const NOT_CONFIGURED: Self =
        Self::new("not-configured", "No TraceHealer server is configured yet.");
}

/// Failures from the OS credential vault.
#[derive(Debug, Clone, Error)]
pub enum VaultError {
    /// The platform vault refused access (locked store, missing D-Bus, policy).
    #[error("credential storage is unavailable: {0}")]
    Unavailable(String),
    /// A non-recoverable backend disagreement.
    #[error("credential storage backend failed: {0}")]
    Backend(String),
    /// The stored blob exists but cannot be interpreted.
    #[error("stored credential is unusable: {0}")]
    Corrupt(String),
}

/// Failures from the PKCE / OAuth helper.
#[derive(Debug, Clone, Error)]
pub enum AuthError {
    #[error("no authorization attempt is pending")]
    NoAttempt,
    #[error("OAuth state mismatch: possible interception")]
    StateMismatch,
    #[error("OAuth state expired before the callback arrived")]
    StateExpired,
    #[error("OAuth state was already used: replay rejected")]
    StateReplayed,
    #[error("callback URL is not the registered tracehealer://auth/callback endpoint")]
    UnsupportedCallback,
    // The provider's own text is never carried: only its machine-readable code.
    #[error("the identity provider reported an error: {0}")]
    ProviderError(String),
    #[error("external OIDC is not configured on this server")]
    ProviderUnconfigured,
    // Detail here is native diagnostic text only; `public()` never uses it, and
    // `DesktopError::diagnostic()` scrubs it before it is written anywhere.
    #[error("the authorization code could not be exchanged ({0})")]
    ExchangeFailed(String),
    #[error("authorization endpoints must share the configured server origin")]
    EndpointNotSameOrigin,
    #[error("no stored session for this workspace")]
    NoSession,
    #[error("session is unusable: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Vault(#[from] VaultError),
}

impl AuthError {
    pub const fn public(&self) -> PublicError {
        match self {
            AuthError::NoAttempt => PublicError::AUTH_NO_ATTEMPT,
            AuthError::StateMismatch | AuthError::UnsupportedCallback => PublicError::AUTH_REJECTED,
            AuthError::StateExpired => PublicError::AUTH_EXPIRED,
            AuthError::StateReplayed => PublicError::AUTH_REPLAYED,
            AuthError::ProviderError(_) => PublicError::PROVIDER_ERROR,
            AuthError::ProviderUnconfigured => PublicError::PROVIDER_UNCONFIGURED,
            AuthError::ExchangeFailed(_) => PublicError::EXCHANGE_FAILED,
            AuthError::EndpointNotSameOrigin => PublicError::SERVER_URL_NOT_ALLOWED,
            AuthError::NoSession => PublicError::NO_SESSION,
            AuthError::Corrupt(_) => PublicError::SESSION_UNUSABLE,
            AuthError::Vault(_) => PublicError::VAULT_UNAVAILABLE,
        }
    }
}

/// Failures reported by a desktop command.
#[derive(Debug, Error)]
pub enum DesktopError {
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("transport failed")]
    Transport(#[from] crate::http::HttpError),
    #[error("command input was rejected")]
    Rejected(PublicError),
}

impl DesktopError {
    /// The only representation the renderer ever sees.
    pub fn public(&self) -> PublicError {
        match self {
            DesktopError::Auth(error) => error.public(),
            DesktopError::Transport(_) => PublicError::TRANSPORT_FAILED,
            DesktopError::Rejected(public) => *public,
        }
    }

    /// Redacted detail for native diagnostics. Never serialized.
    pub fn diagnostic(&self) -> String {
        scrub(&self.to_string())
    }
}

impl Serialize for DesktopError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        self.public().serialize(serializer)
    }
}

pub type Result<T> = std::result::Result<T, DesktopError>;

#[cfg(test)]
mod tests {
    use super::*;

    fn serialized(error: &DesktopError) -> String {
        serde_json::to_string(error).expect("serializes")
    }

    #[test]
    fn public_errors_never_carry_internal_detail() {
        let hostile = DesktopError::Auth(AuthError::Vault(VaultError::Unavailable(
            r"failed to unlock C:\Users\Sumit\AppData\Local\keyring tracehealer.desktop \
              with token eyJhbGciOiJIUzI1NiJ9.secret.secret"
                .into(),
        )));
        let json = serialized(&hostile);
        for leaked in [
            "Sumit",
            "AppData",
            "keyring",
            "tracehealer.desktop",
            "eyJhbGciOiJIUzI1NiJ9",
            "C:",
        ] {
            assert!(!json.contains(leaked), "leaked {leaked} in {json}");
        }
        assert_eq!(
            hostile.public(),
            PublicError::new(
                "vault-unavailable",
                "The operating system credential vault is unavailable on this machine."
            )
        );
    }

    #[test]
    fn provider_failures_do_not_echo_provider_bodies() {
        let error = DesktopError::Auth(AuthError::ProviderError(
            "error=invalid_client&error_description=client secret 7f3a rejected".into(),
        ));
        let json = serialized(&error);
        assert!(!json.contains("7f3a"), "{json}");
        assert!(!json.contains("invalid_client"), "{json}");
        assert!(json.contains("provider-error"), "{json}");
    }

    #[test]
    fn exchange_and_transport_failures_are_opaque() {
        let exchange = DesktopError::Auth(AuthError::ExchangeFailed(
            "HTTP 500 from https://idp.example/token while posting code=abc".into(),
        ));
        assert!(
            !serialized(&exchange).contains("idp.example"),
            "{exchange:?}"
        );
        assert!(serialized(&exchange).contains("exchange-failed"));

        let transport = DesktopError::Transport(crate::http::HttpError::Connect(
            "dial tcp 127.0.0.1:9: refused".into(),
        ));
        let json = serialized(&transport);
        assert!(!json.contains("127.0.0.1"), "{json}");
        assert!(json.contains("transport-failed"), "{json}");
    }

    #[test]
    fn rejection_codes_are_stable_and_message_free_of_input() {
        for public in [
            PublicError::INVALID_INPUT,
            PublicError::SERVER_URL_NOT_ALLOWED,
            PublicError::AUTH_REJECTED,
            PublicError::UNKNOWN_DEEP_LINK,
        ] {
            let json = serde_json::to_string(&DesktopError::Rejected(public)).unwrap();
            assert!(json.contains(public.code), "{json}");
            assert!(
                public
                    .message
                    .chars()
                    .all(|c| c.is_ascii() || c.is_ascii_punctuation()),
                "{}",
                public.message
            );
        }
    }

    #[test]
    fn diagnostic_text_is_scrubbed() {
        let error = DesktopError::Auth(AuthError::ExchangeFailed(
            r"post to C:\Users\Sumit\idp\token.exe failed with session_token=leak".into(),
        ));
        let diagnostic = error.diagnostic();
        assert!(!diagnostic.contains("Sumit"), "{diagnostic}");
        assert!(!diagnostic.contains("token.exe"), "{diagnostic}");
        assert!(!diagnostic.contains("leak"), "{diagnostic}");
    }
}
