mod account;
mod appearance;
mod chatgpt;
mod earth;
#[cfg(target_os = "linux")]
mod desktop_identity;
#[cfg(target_os = "linux")]
mod gnome_shortcut;
#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
mod hyprland;
mod index_bridge;
mod local;
mod loopback;
mod menu;
mod project;
#[cfg(target_os = "macos")]
mod shortcut;
mod term;
#[cfg(target_os = "macos")]
mod thumbnail;
mod shortcut_config;
#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
mod shortcut_portal;
mod shortcut_setup;
mod update;
mod window_placement;
#[cfg(target_os = "windows")]
mod windows_apps;

use account::AccountState;
use chatgpt::ChatGptState;
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
    // Package-manager builds compile the updater out entirely (APS 37
    // package-manager rule); direct downloads self-update.
    #[cfg(not(feature = "packaged"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .invoke_handler(tauri::generate_handler![
            appearance::native_theme,
            index_bridge::index_search,
            index_bridge::index_status,
            index_bridge::index_pause,
            index_bridge::index_rebuild,
            index_bridge::index_open_result,
            index_bridge::index_result_icon,
            account::account_start,
            account::account_cancel,
            account::account_status,
            account::account_signout,
            chatgpt::chatgpt_status,
            chatgpt::chatgpt_start,
            chatgpt::chatgpt_cancel,
            chatgpt::chatgpt_disconnect,
            chatgpt::chatgpt_models,
            chatgpt::chatgpt_ask,
            chatgpt::chatgpt_stop,
            project::project_save,
            project::project_read,
            project::project_record,
            project::project_list,
            project::project_history,
            project::project_run,
            term::term_open,
            term::term_write,
            term::term_resize,
            term::term_close,
            chatgpt::chatgpt_usage,
            earth::earth_search,
            earth::earth_open,
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
            update::update_status,
            update::set_update_channel,
            shortcut_setup::shortcut_status,
            shortcut_setup::shortcut_apply,
            shortcut_setup::shortcut_begin_test,
            shortcut_setup::shortcut_confirm,
            shortcut_setup::close_shortcut_setup,
            shortcut_setup::show_shortcut_setup,
        ])
        .setup(|app| {
            appearance::initialize(app.handle());
            menu::install_tray(app.handle())?;
            // The update check runs on its own thread; it never blocks setup,
            // and an unreachable update server cannot hang startup (APS 37).
            update::initialize(app.handle());
            let settings = local::SettingsIndex::discover();
            app.manage(index_bridge::IndexState::start(
                app.handle(),
                &settings.search_actions(),
            ));
            app.manage(settings);
            app.manage(local::PictureAccess::load(app.handle()));
            let handle = app.handle().clone();
            let state = AccountState::new(handle).map_err(|error| error.to_string())?;
            app.manage(Arc::new(state));
            let chatgpt = ChatGptState::new(app.handle().clone()).map_err(|error| error.to_string())?;
            app.manage(Arc::new(chatgpt));
            app.manage(term::TermState::default());
            app.manage(project::RunState::default());
            app.manage(Arc::new(earth::EarthState::new().map_err(|error| error.to_string())?));
            #[cfg(target_os = "linux")]
            if let Err(error) = desktop_identity::prepare(app.handle()) {
                eprintln!("Could not install the zega launcher entry: {error}");
            }
            let first_launch = shortcut_setup::initialize(app.handle())?;
            let login_launch = std::env::args().any(|arg| arg == "--autostart");
            let shortcut_launch =
                cfg!(target_os = "linux") && std::env::args().any(|arg| arg == "--global-shortcut");
            if (first_launch || std::env::args().any(|arg| arg == "--shortcut-setup"))
                && !login_launch
                && !shortcut_launch
            {
                shortcut_setup::show_shortcut_setup(app.handle().clone())?;
            }
            if (std::env::args().any(|arg| arg == "--search") || shortcut_launch) && !login_launch {
                menu::open_search_window(app.handle().clone())?;
            }
            eprintln!("zega desktop {} ready", app.package_info().version);
            Ok(())
        })
        .on_window_event(|window, event| {
            term::window_closed(window, event);
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
            if matches!(_event, tauri::RunEvent::Exit) {
                appearance::shutdown(_app);
            }
            #[cfg(target_os = "macos")]
            if matches!(_event, tauri::RunEvent::Exit) {
                shortcut::uninstall();
            }
        });
}
