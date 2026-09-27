mod account;
mod local;
mod loopback;

use account::AccountState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            account::account_start,
            account::account_cancel,
            account::account_status,
            account::account_signout,
            local::local_recent_files,
            local::local_settings_panes,
            local::open_local_file,
            local::open_settings_pane,
        ])
        .setup(|app| {
            app.manage(local::SettingsIndex::discover());
            let handle = app.handle().clone();
            let state = AccountState::new(handle).map_err(|error| error.to_string())?;
            app.manage(Arc::new(state));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running zega desktop");
}
