//! Tauri adapter only; crawler, engine and query logic live in computer-index.
use computer_index::{Index, Root, SearchResult, Service, Status};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

pub struct IndexState {
    service: std::result::Result<Mutex<Service>, String>,
}
impl IndexState {
    pub fn start(app: &tauri::AppHandle, actions: &[(String, String)]) -> Self {
        let start = || -> Result<Mutex<Service>, String> {
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            let mut roots = vec![Root {
                path: home.clone(),
                apps: false,
            }];
            // Home includes Documents, Pictures, Movies/Videos, Downloads and
            // Desktop. App roots are explicit; no platform indexer is required.
            #[cfg(target_os = "macos")]
            let apps = vec![
                home.join("Applications"),
                "/Applications".into(),
                "/System/Applications".into(),
            ];
            #[cfg(target_os = "linux")]
            let apps = vec![
                home.join(".local/share/applications"),
                "/usr/share/applications".into(),
                "/usr/local/share/applications".into(),
            ];
            #[cfg(target_os = "windows")]
            let apps = vec![
                home.join("AppData/Roaming/Microsoft/Windows/Start Menu/Programs"),
                "C:/ProgramData/Microsoft/Windows/Start Menu/Programs".into(),
                "C:/Program Files".into(),
                "C:/Program Files (x86)".into(),
            ];
            roots.extend(
                apps.into_iter()
                    .filter(|path| path.is_dir())
                    .map(|path| Root { path, apps: true }),
            );
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("computer");
            let index = Arc::new(Index::open(&directory)?);
            index.set_actions(actions)?;
            Service::start(index, roots).map(Mutex::new)
        };
        Self { service: start() }
    }
    fn index(&self) -> Result<Arc<Index>, String> {
        Ok(self
            .service
            .as_ref()
            .map_err(Clone::clone)?
            .lock()
            .map_err(|e| e.to_string())?
            .index
            .clone())
    }
}

#[tauri::command]
pub async fn index_search(
    query: String,
    state: State<'_, IndexState>,
) -> Result<Vec<SearchResult>, String> {
    let index = state.index()?;
    tauri::async_runtime::spawn_blocking(move || index.search(&query))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn index_status(state: State<'_, IndexState>) -> Result<Status, String> {
    Ok(state.index()?.status())
}
#[tauri::command]
pub fn index_pause(paused: bool, state: State<'_, IndexState>) -> Result<(), String> {
    state.index()?.pause(paused);
    Ok(())
}
#[tauri::command]
pub fn index_rebuild(state: State<'_, IndexState>) -> Result<(), String> {
    state
        .service
        .as_ref()
        .map_err(Clone::clone)?
        .lock()
        .map_err(|e| e.to_string())?
        .rebuild()
}
#[tauri::command]
pub async fn index_open_result(
    key: String,
    app: tauri::AppHandle,
    state: State<'_, IndexState>,
) -> Result<(), String> {
    let index = state.index()?;
    let path = tauri::async_runtime::spawn_blocking(move || index.resolve(&key))
        .await
        .map_err(|e| e.to_string())??;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}
