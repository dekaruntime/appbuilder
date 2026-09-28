mod account;
#[cfg(target_os = "linux")]
mod desktop_identity;
#[cfg(target_os = "linux")]
mod gnome_shortcut;
#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
mod hyprland;
mod local;
mod loopback;
mod menu;
#[cfg(target_os = "macos")]
mod shortcut;
mod shortcut_config;
#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
mod shortcut_portal;
mod shortcut_setup;
mod window_placement;

use account::AccountState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            #[cfg(target_os = "linux")]
            if args.iter().any(|arg| arg == "--global-shortcut") {
                shortcut_setup::activated(app);
                return;
            }
            if args.iter().any(|arg| arg == "--default-shortcut") {
                shortcut_setup::apply_default(app.clone());
            } else if args.iter().any(|arg| arg == "--shortcut-setup") {
                let _ = shortcut_setup::show_shortcut_setup(app.clone());
            } else if !args.iter().any(|arg| arg == "--autostart") {
                let _ = menu::open_search_window(app.clone());
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
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
            menu::open_search_window,
            shortcut_setup::shortcut_status,
            shortcut_setup::shortcut_apply,
            shortcut_setup::shortcut_begin_test,
            shortcut_setup::shortcut_confirm,
            shortcut_setup::close_shortcut_setup,
            shortcut_setup::show_shortcut_setup,
        ])
        .setup(|app| {
            menu::install_tray(app.handle())?;
            app.manage(local::SettingsIndex::discover());
            app.manage(local::PictureAccess::load(app.handle()));
            let handle = app.handle().clone();
            let state = AccountState::new(handle).map_err(|error| error.to_string())?;
            app.manage(Arc::new(state));
            #[cfg(target_os = "linux")]
            if let Err(error) = desktop_identity::prepare(app.handle()) {
                eprintln!("Could not install the zega launcher entry: {error}");
            }
            let first_launch = shortcut_setup::initialize(app.handle())?;
            let login_launch = std::env::args().any(|arg| arg == "--autostart");
            let shortcut_launch = cfg!(target_os = "linux") && std::env::args().any(|arg| arg == "--global-shortcut");
            if (first_launch || std::env::args().any(|arg| arg == "--shortcut-setup"))
                && !login_launch && !shortcut_launch
            {
                shortcut_setup::show_shortcut_setup(app.handle().clone())?;
            }
            if (std::env::args().any(|arg| arg == "--search") || shortcut_launch) && !login_launch {
                menu::open_search_window(app.handle().clone())?;
            }
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
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if matches!(_event, tauri::RunEvent::Exit) {
                shortcut::uninstall();
            }
        });
}
