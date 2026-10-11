//! Native notification delivery.
//!
//! Delivery is a trait so the decision logic can be tested without a
//! notification service, and so a missing platform backend degrades into a
//! reportable failure instead of a panic.

/// Something that can show a native notification.
pub trait Notifier: Send + Sync {
    /// Deliver one notification. Errors are reported, never fatal.
    fn deliver(
        &self,
        identifier: i32,
        title: &str,
        body: &str,
        run_id: &str,
    ) -> std::result::Result<(), String>;
}

/// The platform notification centre, through the Tauri notification plugin.
pub struct OsNotifier {
    app: tauri::AppHandle,
}

impl OsNotifier {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl Notifier for OsNotifier {
    fn deliver(
        &self,
        identifier: i32,
        title: &str,
        body: &str,
        run_id: &str,
    ) -> std::result::Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        self.app
            .notification()
            .builder()
            .id(identifier)
            .title(title)
            .body(body)
            .extra("run_id", run_id)
            .show()
            .map_err(|error| error.to_string())
    }
}

/// Used before the platform notifier is bound (and in unit tests): a delivery
/// attempt reports itself as unavailable rather than silently succeeding.
pub struct UnattachedNotifier;

impl Notifier for UnattachedNotifier {
    fn deliver(
        &self,
        _identifier: i32,
        _title: &str,
        _body: &str,
        _run_id: &str,
    ) -> std::result::Result<(), String> {
        Err("the notification backend is not attached".to_string())
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    /// Records deliveries so tests can assert what the notification centre
    /// would have shown.
    #[derive(Default)]
    pub struct RecordingNotifier {
        pub delivered: Mutex<Vec<(i32, String, String, String)>>,
        pub fail: bool,
    }

    impl RecordingNotifier {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn failing() -> Self {
            Self {
                delivered: Mutex::new(Vec::new()),
                fail: true,
            }
        }

        pub fn delivered(&self) -> Vec<(i32, String, String, String)> {
            self.delivered.lock().expect("notifier").clone()
        }
    }

    impl Notifier for RecordingNotifier {
        fn deliver(
            &self,
            identifier: i32,
            title: &str,
            body: &str,
            run_id: &str,
        ) -> std::result::Result<(), String> {
            self.delivered.lock().expect("notifier").push((
                identifier,
                title.to_string(),
                body.to_string(),
                run_id.to_string(),
            ));
            if self.fail {
                return Err("the notification service refused the request".into());
            }
            Ok(())
        }
    }
}
