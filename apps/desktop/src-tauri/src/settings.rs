//! Non-secret desktop settings.
//!
//! The server address, the notification preference, and the appearance/channel
//! choices are ordinary preferences and live in a single fixed-name file under
//! the OS application-config directory. No credential ever appears here: the
//! session token lives in the platform vault ([`crate::vault`]) and nothing in
//! this module knows what a token is.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The one file this module owns.
pub const SETTINGS_FILE: &str = "desktop-settings.json";

fn default_true() -> bool {
    true
}

fn default_update_channel() -> String {
    "stable".to_string()
}

fn default_appearance() -> String {
    "system".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopSettings {
    #[serde(default)]
    pub server_url: String,
    /// Optional OAuth scope override requested from the server.
    #[serde(default)]
    pub scope: String,
    /// Notifications are on until the user turns them off.
    #[serde(default = "default_true")]
    pub notifications_allowed: bool,
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    #[serde(default = "default_appearance")]
    pub appearance: String,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            scope: String::new(),
            notifications_allowed: true,
            update_channel: default_update_channel(),
            appearance: default_appearance(),
        }
    }
}

/// The settings path inside the OS application-config directory.
pub fn settings_path(config_directory: &Path) -> PathBuf {
    config_directory.join(SETTINGS_FILE)
}

/// Read settings, falling back to defaults when the file is absent or
/// unreadable: preferences are not worth failing a start-up over.
pub fn load(path: &Path) -> DesktopSettings {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => DesktopSettings::default(),
    }
}

/// Write settings by replacing the file atomically enough that an interrupted
/// write cannot leave a half-parsed preference file behind.
pub fn save(path: &Path, settings: &DesktopSettings) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(settings).unwrap_or_default();
    std::fs::write(&temporary, body)?;
    // `rename` refuses to clobber on Windows, so remove the target first.
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "tracehealer-settings-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).expect("scratch directory");
        directory.join(SETTINGS_FILE)
    }

    #[test]
    fn round_trips_through_disk() {
        let path = scratch("round-trip");
        let settings = DesktopSettings {
            server_url: "https://healer.example".into(),
            notifications_allowed: false,
            ..DesktopSettings::default()
        };
        save(&path, &settings).expect("save");
        assert_eq!(load(&path), settings);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_or_corrupt_files_fall_back_to_defaults() {
        let missing = scratch("missing");
        assert_eq!(load(&missing), DesktopSettings::default());

        let corrupt = scratch("corrupt");
        std::fs::write(&corrupt, "{ not json").expect("write");
        assert_eq!(load(&corrupt), DesktopSettings::default());
        std::fs::remove_file(&corrupt).ok();
    }

    #[test]
    fn notifications_default_on_and_partial_files_keep_defaults() {
        let path = scratch("partial");
        std::fs::write(&path, r#"{"server_url":"https://healer.example"}"#).expect("write");
        let loaded = load(&path);
        assert_eq!(loaded.server_url, "https://healer.example");
        assert!(loaded.notifications_allowed);
        assert_eq!(loaded.update_channel, "stable");
        assert_eq!(loaded.appearance, "system");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn settings_never_carry_a_credential() {
        let settings = DesktopSettings {
            server_url: "https://healer.example".into(),
            ..DesktopSettings::default()
        };
        let path = scratch("no-credential");
        save(&path, &settings).expect("save");
        let written = std::fs::read_to_string(&path).expect("read");
        let lower = written.to_ascii_lowercase();
        for forbidden in [
            "token",
            "secret",
            "password",
            "verifier",
            "cookie",
            "authorization",
        ] {
            assert!(!lower.contains(forbidden), "{written}");
        }
        // The session-shaped fields are not part of the settings type at all.
        assert!(!written.contains("tenant_id"), "{written}");
        assert!(!written.contains("session"), "{written}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_rewrite_replaces_the_file_without_leaving_temporary_files() {
        let path = scratch("rewrite");
        save(&path, &DesktopSettings::default()).expect("first save");
        let updated = DesktopSettings {
            server_url: "https://second.example".into(),
            notifications_allowed: false,
            ..DesktopSettings::default()
        };
        save(&path, &updated).expect("second save");
        assert_eq!(load(&path), updated);
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn the_path_is_pinned_to_a_fixed_file_name() {
        let directory = Path::new("/var/lib/tracehealer");
        let path = settings_path(directory);
        assert_eq!(path.file_name().unwrap(), SETTINGS_FILE);
        assert_eq!(path.parent().unwrap(), directory);
    }
}
