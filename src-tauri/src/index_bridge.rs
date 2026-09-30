//! Tauri adapter only; crawler, engine and query logic live in computer-index.
use computer_index::{Index, Root, SearchResult, Service, Status};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

pub struct IndexState {
    service: std::result::Result<Mutex<Service>, String>,
    /// Icons (Windows) and thumbnails (macOS) for results already shown,
    /// keyed by result and, on macOS, the file's modified time.
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    icons: Mutex<std::collections::HashMap<String, Option<String>>>,
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
            let apps: Vec<std::path::PathBuf> = Vec::new();
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
            #[cfg(target_os = "windows")]
            index.set_registered_apps(&crate::windows_apps::discover()?)?;
            Service::start(index, roots).map(Mutex::new)
        };
        Self {
            service: start(),
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            icons: Mutex::new(std::collections::HashMap::new()),
        }
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
pub async fn index_rebuild(state: State<'_, IndexState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let index = state.index()?;
        tauri::async_runtime::spawn_blocking(move || {
            index.set_registered_apps(&crate::windows_apps::discover()?)
        })
        .await
        .map_err(|e| e.to_string())??;
        state.icons.lock().map_err(|e| e.to_string())?.clear();
    }
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
    #[cfg(target_os = "windows")]
    if path.starts_with("shell:AppsFolder\\") {
        return tauri::async_runtime::spawn_blocking(move || crate::windows_apps::open(&path))
            .await
            .map_err(|e| e.to_string())?;
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn index_result_icon(
    key: String,
    state: State<'_, IndexState>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(icon) = state.icons.lock().map_err(|e| e.to_string())?.get(&key).cloned() {
            return Ok(icon);
        }
        let index = state.index()?;
        let target_key = key.clone();
        let icon = tauri::async_runtime::spawn_blocking(move || {
            let path = index.resolve(&target_key)?;
            crate::windows_apps::icon(&path)
        })
        .await
        .map_err(|e| e.to_string())??;
        remember(&state, key, Some(icon.clone()))?;
        Ok(Some(icon))
    }
    #[cfg(target_os = "macos")]
    {
        let index = state.index()?;
        let path = index.resolve(&key)?;
        // A changed file gets a fresh thumbnail: the modified time is part of the key.
        let modified = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_millis());
        let cache_key = format!("{key}@{modified}");
        if let Some(thumbnail) = state.icons.lock().map_err(|e| e.to_string())?.get(&cache_key).cloned() {
            return Ok(thumbnail);
        }
        let thumbnail = tauri::async_runtime::spawn_blocking(move || crate::thumbnail::thumbnail(&path))
            .await
            .map_err(|e| e.to_string())?;
        remember(&state, cache_key, thumbnail.clone())?;
        Ok(thumbnail)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (key, state);
        Ok(None)
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn remember(state: &IndexState, key: String, icon: Option<String>) -> Result<(), String> {
    let mut cache = state.icons.lock().map_err(|e| e.to_string())?;
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(key, icon);
    Ok(())
}
