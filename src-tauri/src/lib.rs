mod account;
mod local;
mod loopback;
mod menu;
#[cfg(target_os = "macos")]
mod shortcut;

use account::AccountState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts(["super+alt+Space"])
            .expect("the fixed global shortcut is valid")
            .with_handler(|app, shortcut, event| {
                use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
                if event.state == ShortcutState::Pressed
                    && shortcut.matches(Modifiers::ALT | Modifiers::SUPER, Code::Space)
                {
                    menu::toggle_search_window(app);
                }
            })
            .build(),
    );
    builder
        .invoke_handler(tauri::generate_handler![
            account::account_start,
            account::account_cancel,
            account::account_status,
            account::account_signout,
            local::local_recent_files,
            local::local_recent_photos,
            local::local_pictures_access_granted,
            local::request_pictures_access,
            local::local_user_first_name,
            local::local_settings_panes,
            local::open_local_file,
            local::open_settings_pane,
            menu::hide_search_window,
            menu::show_main_window,
        ])
        .setup(|app| {
            menu::install_tray(app.handle())?;
            #[cfg(target_os = "macos")]
            if let Err(error) = shortcut::install(app.handle()) {
                use tauri_plugin_dialog::DialogExt;
                app.dialog()
                    .message(error)
                    .title("Search shortcut unavailable")
                    .show(|_| {});
            }
            app.manage(local::SettingsIndex::discover());
            app.manage(local::PictureAccess::load(app.handle()));
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
                    menu::main_window_closed(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building zega desktop")
        .run(|_app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Exit) {
                shortcut::uninstall();
            }
        });
}
