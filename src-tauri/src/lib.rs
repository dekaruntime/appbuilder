mod account;
mod local;
mod loopback;
mod menu;

use account::AccountState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+space"])
                .expect("the fixed global shortcut is valid")
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
                    if event.state == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::ALT, Code::Space)
                    {
                        menu::toggle_search_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            account::account_start,
            account::account_cancel,
            account::account_status,
            account::account_signout,
            local::local_recent_files,
            local::local_settings_panes,
            local::open_local_file,
            local::open_settings_pane,
            menu::hide_search_window,
        ])
        .setup(|app| {
            menu::install_tray(app.handle())?;
            app.manage(local::SettingsIndex::discover());
            let handle = app.handle().clone();
            let state = AccountState::new(handle).map_err(|error| error.to_string())?;
            app.manage(Arc::new(state));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running zega desktop");
}
