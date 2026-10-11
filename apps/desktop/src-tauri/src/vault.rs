//! OS credential vault for the desktop session.
//!
//! Every durable credential the desktop holds lives in the platform vault:
//! Windows Credential Manager, macOS Keychain, or the Linux Secret Service over
//! D-Bus. There is deliberately **no plaintext fallback** — if the vault cannot
//! be reached, storing a session fails and the user is told the vault is
//! unavailable rather than having a token written to a file.
//!
//! Credentials are keyed by `(tenant, workspace)` so two accounts or two
//! workspaces on the same machine never overwrite each other, and an
//! `active-session` pointer records which entry the app is currently showing.

use crate::errors::{AuthError, VaultError};
use serde::{Deserialize, Serialize};

/// Service name used for every entry the desktop owns.
pub const KEYRING_SERVICE: &str = "tracehealer.desktop";
/// Pointer entry naming the tenant/workspace whose session is active.
pub const ACTIVE_USER: &str = "active-session";
/// Prefix for per-(tenant, workspace) session entries.
const SESSION_PREFIX: &str = "session:";

/// A credential backend. Only the real OS vault is used in production; tests
/// substitute an in-memory or deliberately failing backend.
pub trait CredentialVault: Send + Sync {
    /// `Ok(None)` means "no entry", which is not an error.
    fn get(&self, user: &str) -> Result<Option<String>, VaultError>;
    fn set(&self, user: &str, secret: &str) -> Result<(), VaultError>;
    fn delete(&self, user: &str) -> Result<(), VaultError>;
}

/// The real platform vault.
pub struct OsVault {
    service: &'static str,
}

impl OsVault {
    pub fn new() -> Self {
        Self {
            service: KEYRING_SERVICE,
        }
    }
}

impl Default for OsVault {
    fn default() -> Self {
        Self::new()
    }
}

/// Classify a backend error into "no entry", "unavailable", or "corrupt".
///
/// A locked store or a missing `NoEntry` must be distinguishable: the first is
/// a hard failure the user has to fix, the second is simply "not signed in".
fn classify(error: keyring::Error) -> VaultError {
    match error {
        keyring::Error::NoStorageAccess(inner) => VaultError::Unavailable(inner.to_string()),
        keyring::Error::PlatformFailure(inner) => VaultError::Unavailable(inner.to_string()),
        keyring::Error::BadEncoding(_) => {
            VaultError::Corrupt("stored credential is not valid UTF-8".into())
        }
        other => VaultError::Backend(other.to_string()),
    }
}

impl CredentialVault for OsVault {
    fn get(&self, user: &str) -> Result<Option<String>, VaultError> {
        let entry = keyring::Entry::new(self.service, user).map_err(classify)?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(classify(error)),
        }
    }

    fn set(&self, user: &str, secret: &str) -> Result<(), VaultError> {
        let entry = keyring::Entry::new(self.service, user).map_err(classify)?;
        entry.set_password(secret).map_err(classify)
    }

    fn delete(&self, user: &str) -> Result<(), VaultError> {
        let entry = keyring::Entry::new(self.service, user).map_err(classify)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(classify(error)),
        }
    }
}

/// A signed-in desktop session. The session token is only ever handed to the
/// credential backend; it is never returned to the renderer and never written
/// to web storage, a settings file, or a log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSession {
    pub server_url: String,
    pub tenant_id: String,
    pub workspace_id: String,
    pub role: String,
    pub session_token: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ActivePointer {
    tenant_id: String,
    workspace_id: String,
}

/// Restrict an identifier to characters that are safe in a vault key.
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

/// The vault key for one (tenant, workspace) pair.
pub fn session_user(tenant_id: &str, workspace_id: &str) -> String {
    format!(
        "{SESSION_PREFIX}{}:{}",
        sanitize(tenant_id),
        sanitize(workspace_id)
    )
}

/// Persist a session, then point `active-session` at it.
pub fn store_session<V: CredentialVault + ?Sized>(
    vault: &V,
    session: &StoredSession,
) -> Result<(), AuthError> {
    let blob =
        serde_json::to_string(session).map_err(|error| AuthError::Corrupt(error.to_string()))?;
    vault.set(
        &session_user(&session.tenant_id, &session.workspace_id),
        &blob,
    )?;
    let pointer = ActivePointer {
        tenant_id: session.tenant_id.clone(),
        workspace_id: session.workspace_id.clone(),
    };
    let pointer_blob =
        serde_json::to_string(&pointer).map_err(|error| AuthError::Corrupt(error.to_string()))?;
    vault.set(ACTIVE_USER, &pointer_blob)?;
    Ok(())
}

/// Read the session the active pointer names.
pub fn load_active_session<V: CredentialVault + ?Sized>(
    vault: &V,
) -> Result<StoredSession, AuthError> {
    let pointer_blob = vault.get(ACTIVE_USER)?.ok_or(AuthError::NoSession)?;
    let pointer: ActivePointer = serde_json::from_str(&pointer_blob)
        .map_err(|error| AuthError::Corrupt(error.to_string()))?;
    let blob = vault
        .get(&session_user(&pointer.tenant_id, &pointer.workspace_id))?
        .ok_or(AuthError::NoSession)?;
    serde_json::from_str(&blob).map_err(|error| AuthError::Corrupt(error.to_string()))
}

/// Logout: erase the active session entry *and* the pointer. Returns whether
/// anything was removed, so the UI can distinguish "signed out" from
/// "there was nothing to sign out of". Other workspaces are left untouched.
pub fn clear_active_session<V: CredentialVault + ?Sized>(vault: &V) -> Result<bool, AuthError> {
    let pointer_blob = vault.get(ACTIVE_USER)?;
    let removed = match pointer_blob {
        Some(blob) => {
            if let Ok(pointer) = serde_json::from_str::<ActivePointer>(&blob) {
                vault.delete(&session_user(&pointer.tenant_id, &pointer.workspace_id))?;
            }
            true
        }
        None => false,
    };
    vault.delete(ACTIVE_USER)?;
    Ok(removed)
}

/// The vault key for a session. Exposed for tests and diagnostics.
#[cfg(test)]
pub fn key_for(session: &StoredSession) -> String {
    session_user(&session.tenant_id, &session.workspace_id)
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory backend standing in for the OS vault in unit tests.
    #[derive(Default)]
    pub struct MemoryVault {
        pub entries: Mutex<HashMap<String, String>>,
        /// Every `set` call, so tests can assert what was (and was not) written.
        pub writes: Mutex<Vec<(String, String)>>,
    }

    impl MemoryVault {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn seed(&self, user: &str, secret: &str) {
            self.entries
                .lock()
                .expect("memory vault")
                .insert(user.to_string(), secret.to_string());
        }
    }

    impl CredentialVault for MemoryVault {
        fn get(&self, user: &str) -> Result<Option<String>, VaultError> {
            Ok(self
                .entries
                .lock()
                .expect("memory vault")
                .get(user)
                .cloned())
        }

        fn set(&self, user: &str, secret: &str) -> Result<(), VaultError> {
            self.writes
                .lock()
                .expect("memory vault")
                .push((user.to_string(), secret.to_string()));
            self.entries
                .lock()
                .expect("memory vault")
                .insert(user.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, user: &str) -> Result<(), VaultError> {
            self.entries.lock().expect("memory vault").remove(user);
            Ok(())
        }
    }

    /// A backend that is present but refuses access, like a locked keychain or
    /// a Linux session with no Secret Service.
    pub struct DeadVault {
        pub reason: String,
    }

    impl DeadVault {
        pub fn new(reason: &str) -> Self {
            Self {
                reason: reason.to_string(),
            }
        }
    }

    impl CredentialVault for DeadVault {
        fn get(&self, _user: &str) -> Result<Option<String>, VaultError> {
            Err(VaultError::Unavailable(self.reason.clone()))
        }

        fn set(&self, _user: &str, _secret: &str) -> Result<(), VaultError> {
            Err(VaultError::Unavailable(self.reason.clone()))
        }

        fn delete(&self, _user: &str) -> Result<(), VaultError> {
            Err(VaultError::Unavailable(self.reason.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{DeadVault, MemoryVault};
    use super::*;

    fn session(tenant: &str, workspace: &str, token: &str) -> StoredSession {
        StoredSession {
            server_url: "https://healer.example".into(),
            tenant_id: tenant.into(),
            workspace_id: workspace.into(),
            role: "operator".into(),
            session_token: token.into(),
            expires_at: 4_000_000_000,
        }
    }

    #[test]
    fn production_backend_is_the_os_vault() {
        // The production type is the keyring-backed one, not a file backend.
        assert_eq!(
            std::any::type_name::<OsVault>(),
            "tracehealer_desktop::vault::OsVault"
        );
        assert_eq!(OsVault::new().service, KEYRING_SERVICE);
    }

    #[test]
    fn set_get_delete_and_missing_round_trip() {
        let vault = MemoryVault::new();
        assert_eq!(
            vault.get(ACTIVE_USER).unwrap(),
            None,
            "missing entry is not an error"
        );

        let stored = session("tenant-a", "workspace-a", "tok_1");
        store_session(&vault, &stored).unwrap();
        assert!(
            store_session(&vault, &stored).is_ok(),
            "overwrite is idempotent"
        );

        let loaded = load_active_session(&vault).unwrap();
        assert_eq!(loaded, stored);
        assert_eq!(loaded.session_token, "tok_1");

        assert!(clear_active_session(&vault).unwrap());
        assert!(matches!(
            load_active_session(&vault),
            Err(AuthError::NoSession)
        ));
        assert_eq!(vault.get(&key_for(&stored)).unwrap(), None);
        // Logout is complete: the pointer is gone too, not just the session.
        assert_eq!(vault.get(ACTIVE_USER).unwrap(), None);
    }

    #[test]
    fn logout_cleanup_is_idempotent() {
        let vault = MemoryVault::new();
        assert!(!clear_active_session(&vault).unwrap(), "nothing stored yet");
        store_session(&vault, &session("t", "w", "tok")).unwrap();
        assert!(clear_active_session(&vault).unwrap());
        assert!(!clear_active_session(&vault).unwrap());
    }

    #[test]
    fn accounts_and_workspaces_do_not_overwrite_each_other() {
        let vault = MemoryVault::new();
        let first = session("tenant-a", "workspace-a", "tok_a");
        let second = session("tenant-a", "workspace-b", "tok_b");
        let third = session("tenant-b", "workspace-a", "tok_c");

        store_session(&vault, &first).unwrap();
        store_session(&vault, &second).unwrap();
        store_session(&vault, &third).unwrap();

        assert_eq!(load_active_session(&vault).unwrap(), third);
        // Every workspace entry is still present and distinct.
        assert_eq!(
            vault.get(&key_for(&first)).unwrap().as_deref(),
            Some(serde_json::to_string(&first).unwrap().as_str())
        );
        assert_eq!(
            vault.get(&key_for(&second)).unwrap().as_deref(),
            Some(serde_json::to_string(&second).unwrap().as_str())
        );
        assert_ne!(key_for(&first), key_for(&second));
        assert_ne!(key_for(&first), key_for(&third));
    }

    #[test]
    fn switching_workspace_never_returns_the_other_workspace_token() {
        let vault = MemoryVault::new();
        store_session(&vault, &session("t", "w1", "tok_w1")).unwrap();
        store_session(&vault, &session("t", "w2", "tok_w2")).unwrap();
        assert_eq!(load_active_session(&vault).unwrap().session_token, "tok_w2");
        clear_active_session(&vault).unwrap();
        // The first workspace was not the active one, so it survives untouched.
        assert!(vault
            .get(&key_for(&session("t", "w1", "tok_w1")))
            .unwrap()
            .is_some());
        assert!(matches!(
            load_active_session(&vault),
            Err(AuthError::NoSession)
        ));
    }

    #[test]
    fn an_unavailable_backend_fails_closed_and_writes_nothing() {
        let vault = DeadVault::new("Secret Service is not running on this session");
        let error = store_session(&vault, &session("t", "w", "tok")).unwrap_err();
        assert!(matches!(
            error,
            AuthError::Vault(VaultError::Unavailable(_))
        ));
        assert_eq!(error.public().code, "vault-unavailable");
        // A missing entry is reported as such; a dead backend never masquerades
        // as "not signed in".
        assert!(matches!(
            load_active_session(&vault),
            Err(AuthError::Vault(_))
        ));
        assert!(matches!(
            clear_active_session(&vault),
            Err(AuthError::Vault(_))
        ));
    }

    #[test]
    fn a_corrupt_entry_is_reported_as_corrupt_not_missing() {
        let vault = MemoryVault::new();
        vault.seed(ACTIVE_USER, "not-json");
        assert!(matches!(
            load_active_session(&vault),
            Err(AuthError::Corrupt(_))
        ));

        vault.seed(ACTIVE_USER, r#"{"tenant_id":"t","workspace_id":"w"}"#);
        vault.seed(&session_user("t", "w"), "also-not-json");
        assert!(matches!(
            load_active_session(&vault),
            Err(AuthError::Corrupt(_))
        ));
    }

    #[test]
    fn vault_keys_are_bounded_and_path_free() {
        let hostile = session("../../etc", "w o r k space", "tok");
        let key = key_for(&hostile);
        assert!(!key.contains('/'), "{key}");
        assert!(!key.contains('\\'), "{key}");
        assert!(!key.contains(' '), "{key}");
        assert!(key.len() < 140, "{key}");
        let long = key_for(&session(&"a".repeat(500), &"b".repeat(500), "tok"));
        assert!(long.len() < 140, "{long}");
    }

    /// Guard against a future "plaintext fallback": nothing in the vault or
    /// exchange modules may reach for the filesystem directly.
    #[test]
    fn no_plaintext_credential_fallback_exists_in_source() {
        // Assembled at runtime so this test does not match its own needles.
        let needles = [
            ["fs", "::", "write"].concat(),
            ["File", "::", "create"].concat(),
            ["Open", "Options"].concat(),
            ["write", "_all"].concat(),
        ];
        for (name, source) in [
            ("vault.rs", include_str!("vault.rs")),
            ("exchange.rs", include_str!("exchange.rs")),
        ] {
            for forbidden in &needles {
                assert!(
                    !source.contains(forbidden.as_str()),
                    "{name} must not write credentials to disk"
                );
            }
        }
    }
}
