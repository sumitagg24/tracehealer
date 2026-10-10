// TraceHealer desktop shell (Tauri 2).
//
// Responsibilities kept deliberately small: the renderer talks HTTP-only
// to the user-configured server; the Rust side provides tray, deep links,
// native notifications, and the OS-keychain session vault. No generic shell,
// filesystem, or process bridge is exposed to the renderer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod commands;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// Terminal run states that deserve a native notification.
const NOTIFY_STATES: &[&str] = &["healed", "needs-review", "cancelled", "timed-out", "delivery-failed"];

fn notify_run_state(app: &tauri::AppHandle, run_id: &str, state: &str) {
    if !NOTIFY_STATES.contains(&state) {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let title = match state {
        "healed" => "Repair verified",
        "needs-review" => "Run needs review",
        "cancelled" => "Run cancelled",
        "timed-out" => "Run timed out",
        _ => "Delivery failed",
    };
    app.notification()
        .builder()
        .title(title)
        .body(format!("{run_id} finished as {state}."))
        .show()
        .ok();
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
    let incidents = MenuItem::with_id(app, "incidents", "Recent incidents…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause notifications", true, None::<&str>)?;
    let state = MenuItem::with_id(app, "state", "Connection: unknown", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TraceHealer", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&state, &open, &incidents, &pause, &quit])?;

    if let Some(window) = app.get_webview_window("main") {
        TrayIconBuilder::with_id("main-tray")
            .menu(&menu)
            .tooltip("TraceHealer")
            .on_menu_event(|app, event| match event.id().as_ref() {
                "open" => {
                    if let Some(window) = app.get_webview_window("main") {
                        window.show().ok();
                        window.set_focus().ok();
                    }
                }
                "quit" => app.exit(0),
                // incidents/pause/state are handled by the renderer via events.
                _ => {}
            })
            .build(app)?;
        let _ = window;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(commands::DesktopState::default())
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_session_state,
            commands::persist_session,
            commands::clear_session,
            commands::report_connection,
            commands::push_run_update,
            commands::update_tray_state_label,
            commands::open_authorize_url,
            commands::handle_callback,
            commands::handle_deep_link,
            commands::request_notification_permission,
            commands::set_notifications_allowed,
            commands::notifications_allowed,
            commands::get_settings,
            commands::resources_summary,
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
    #[test]
    fn notification_states_are_terminal_only() {
        for state in super::NOTIFY_STATES {
            assert!(matches!(
                *state,
                "healed" | "needs-review" | "cancelled" | "timed-out" | "delivery-failed"
            ));
        }
        assert!(!super::NOTIFY_STATES.contains(&"verifying"));
    }
}
