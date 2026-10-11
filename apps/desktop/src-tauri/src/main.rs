// TraceHealer desktop shell (Tauri 2).
//
// Responsibilities stay small and explicit: the renderer asks this side for
// data by path, and the shell owns the session, the browser, the tray, native
// notifications, and the single credential vault. No generic shell, filesystem,
// or process bridge is exposed to the renderer, and no arbitrary URL can be
// opened on its behalf.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod commands;
mod errors;
mod exchange;
mod http;
mod notifier;
mod notify;
mod opener;
mod redact;
mod server;
mod settings;
mod tray;
mod vault;

use commands::{clock, DesktopState};
use errors::DesktopError;
use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Write a redacted diagnostic line. The redaction policy is compiled in every
/// profile (so it is covered by tests and cannot rot), but the line is only
/// emitted for developers: a released build does not scatter state on stderr.
fn diagnose(context: &str, error: &DesktopError) {
    if cfg!(debug_assertions) {
        eprintln!("[tracehealer] {context}: {}", error.diagnostic());
    }
}

/// Route a `tracehealer://` URL: the OAuth callback goes to the sign-in flow,
/// everything else must be a known run or incident link.
fn route_deep_link(app: &AppHandle, url: &str) {
    let state = app.state::<DesktopState>();
    if commands::is_auth_callback(url) {
        match commands::handle_callback_on(&state, url, clock::epoch_secs()) {
            Ok(outcome) => {
                commands::focus_main_window(app);
                state.record_event(
                    "auth-callback",
                    serde_json::to_value(&outcome).unwrap_or_default(),
                );
                state.record_event(
                    "connection-state",
                    serde_json::to_value(state.connection_snapshot()).unwrap_or_default(),
                );
                tray::refresh(app);
            }
            Err(error) => {
                diagnose("auth callback rejected", &error);
                // The renderer only ever receives the fixed public shape.
                state.record_event(
                    "auth-error",
                    serde_json::to_value(error.public()).unwrap_or_default(),
                );
            }
        }
        return;
    }

    match commands::parse_deep_link(url) {
        Ok(target) => {
            commands::focus_main_window(app);
            state.record_event(
                "open-target",
                serde_json::to_value(&target).unwrap_or_default(),
            );
        }
        Err(error) => {
            diagnose("deep link rejected", &error);
            state.record_event(
                "deep-link-rejected",
                serde_json::to_value(error.public()).unwrap_or_default(),
            );
        }
    }
}

/// A notification was clicked: open the run it announced.
fn notification_clicked(app: &AppHandle, identifier: i32, fallback_run_id: Option<&str>) {
    let state = app.state::<DesktopState>();
    let Some(run_id) = commands::notification_run_id(&state, identifier, fallback_run_id) else {
        // Nothing to open: just surface the window rather than doing nothing.
        commands::focus_main_window(app);
        return;
    };
    let Some(target) = notify::notification_target(&run_id) else {
        commands::focus_main_window(app);
        return;
    };
    commands::focus_main_window(app);
    if let Ok(parsed) = commands::parse_deep_link(&target) {
        state.record_event(
            "open-target",
            serde_json::to_value(&parsed).unwrap_or_default(),
        );
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .manage(DesktopState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<DesktopState>();

            // Persisted preferences (never credentials) live beside the app's
            // own configuration.
            if let Ok(config_directory) = app.path().app_config_dir() {
                let path = settings::settings_path(&config_directory);
                let loaded = settings::load(&path);
                state.attach_settings(path, loaded);
            }

            // Bind the real notification backend now that a handle exists.
            state.bind_notifier(Box::new(notifier::OsNotifier::new(handle.clone())));

            tray::build(&handle)?;

            // Notifications: a tap opens the run that was announced, resolved
            // from shell state rather than from any text in the notification.
            {
                use tauri_plugin_notification::NotificationExt;
                let handle = handle.clone();
                let _ = app.notification().on_action(move |performed| {
                    if performed.action_id() != "tap" {
                        return;
                    }
                    let notification = performed.notification();
                    let identifier = notification.map(|entry| entry.id()).unwrap_or(0);
                    let fallback = notification
                        .and_then(|entry| entry.extra().get("run_id").cloned())
                        .and_then(|value| value.as_str().map(str::to_string));
                    notification_clicked(&handle, identifier, fallback.as_deref());
                });
            }

            // Deep links: the OS hands us URLs from this run or a previous one.
            {
                let listener_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        route_deep_link(&listener_handle, url.as_str());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        route_deep_link(&handle, url.as_str());
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_session_state,
            commands::logout,
            commands::configure_server,
            commands::begin_authorization,
            commands::handle_callback,
            commands::report_connection,
            commands::push_run_update,
            commands::request_notification_permission,
            commands::set_notifications_allowed,
            commands::notifications_allowed,
            commands::get_settings,
            commands::notification_target,
            commands::server_request,
            commands::resources_summary,
            commands::open_dashboard,
            commands::handle_deep_link,
            commands::take_events,
        ])
        .on_window_event(|window, event| {
            // Closing the window keeps the tray alive; quitting goes via tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running TraceHealer desktop");
}

#[cfg(test)]
mod tests {
    use crate::notify::TERMINAL_STATES;

    #[test]
    fn notification_states_are_terminal_only() {
        for state in TERMINAL_STATES {
            assert!(
                matches!(
                    state,
                    "healed" | "needs-review" | "cancelled" | "timed-out" | "delivery-failed"
                ),
                "{state}"
            );
        }
        for active in [
            "queued",
            "verifying",
            "reproducing",
            "patching",
            "delivering",
        ] {
            assert!(!TERMINAL_STATES.contains(&active), "{active}");
        }
    }
}
