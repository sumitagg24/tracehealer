//! Tray icon and menu.
//!
//! The tray is the desktop client's always-available surface: it shows the
//! connection label, reopens the dashboard, jumps to incidents, toggles native
//! notifications, and quits. Every item does something real — there is no
//! decorative entry.

use crate::commands::{self, DesktopState};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "main-tray";

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    connection_label: &str,
    notifications_allowed: bool,
) -> tauri::Result<Menu<R>> {
    let state = MenuItem::with_id(app, "state", connection_label, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open TraceHealer", true, None::<&str>)?;
    let incidents = MenuItem::with_id(app, "incidents", "Recent incidents", true, None::<&str>)?;
    let pause = MenuItem::with_id(
        app,
        "pause",
        if notifications_allowed {
            "Turn notifications off"
        } else {
            "Turn notifications on"
        },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit TraceHealer", true, None::<&str>)?;
    Menu::with_items(app, &[&state, &open, &incidents, &pause, &quit])
}

fn show(app: &AppHandle<impl Runtime>, channel: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    app.state::<DesktopState>()
        .record_event("navigate", serde_json::json!({ "channel": channel }));
}

/// Create the tray icon with its menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let state = app.state::<DesktopState>();
    let menu = build_menu(
        app,
        commands::connection_label(&state.connection_snapshot()),
        state.notifications_allowed_snapshot(),
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("TraceHealer")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app, "/"),
            "incidents" => show(app, "/incidents"),
            "pause" => {
                let state = app.state::<DesktopState>();
                let allowed = !state.notifications_allowed_snapshot();
                state.set_notifications_allowed(allowed);
                refresh(app);
                state.record_event(
                    "notifications-changed",
                    serde_json::json!({ "allowed": allowed }),
                );
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the menu so it shows the current connection label and preference.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<DesktopState>();
    let label = commands::connection_label(&state.connection_snapshot());
    let allowed = state.notifications_allowed_snapshot();
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app, label, allowed) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
