// Always-ready desktop app: a tray icon, a global shortcut (Ctrl+Alt+Space)
// that brings the window up with a new chat, closing to the tray (the model
// stays loaded), and starting with Windows (minimised, `--minimized`).
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Close the window to the tray instead of quitting (Settings → App).
pub static KEEP_IN_TRAY: AtomicBool = AtomicBool::new(true);

pub const SHORTCUT: &str = "Ctrl+Alt+Space";

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Show and focus the window; `new_chat`: also start a new conversation.
pub fn summon(app: &AppHandle, new_chat: bool) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if new_chat {
            let _ = w.emit("quick-ask", ());
        }
    }
}

pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                summon(app, true);
            }
        })
        .build()
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    // Ctrl+Alt+Space from any app (ignored if another program already took it).
    let _ = handle.global_shortcut().register(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space));

    let open = MenuItem::with_id(app, "open", "Open My Own AI", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new", format!("New chat\t{SHORTCUT}"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new_chat, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("My Own AI")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => summon(app, false),
            "new" => summon(app, true),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                summon(tray.app_handle(), false);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    // Started with Windows: stay in the tray until called.
    if std::env::args().any(|a| a == "--minimized") {
        if let Some(w) = main_window(handle) {
            let _ = w.hide();
        }
    }
    Ok(())
}

/// Closing the window hides it while "keep in tray" is on.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if KEEP_IN_TRAY.load(Ordering::Relaxed) && window.label() == "main" {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn set_keep_in_tray(on: bool) {
    KEEP_IN_TRAY.store(on, Ordering::Relaxed);
}
