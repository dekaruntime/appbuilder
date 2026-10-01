//! The builder's app on disk: ~/Documents/Zega Apps/<name>/ holds app.dsx and
//! deka.json. The terminal opens there, and the builder reads the folder back,
//! so edits made outside the builder (Codex in the terminal, an editor) show up
//! in the preview the same way the builder's own edits do.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

const SOURCE: &str = "app.dsx";
const MANIFEST: &str = "deka.json";

/// A folder name from the app's name: letters, digits, spaces and dashes.
fn folder_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { "Untitled app".into() } else { cleaned.chars().take(60).collect() }
}

fn identifier(name: &str) -> String {
    let slug: String = folder_name(name).to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    format!("app.zega.{}", slug.trim_matches('-'))
}

fn manifest(name: &str, width: u32, height: u32) -> serde_json::Value {
    serde_json::json!({
        "name": identifier(name).trim_start_matches("app.zega.").to_string(),
        "version": "0.1.0",
        "desktop": {
            "productName": folder_name(name),
            "identifier": identifier(name),
            "entry": SOURCE,
            "entryFunction": "App",
            "window": { "width": width, "height": height },
        }
    })
}

fn apps_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    let documents = app.path().document_dir().map_err(|_| "Could not find your Documents folder.".to_string())?;
    Ok(documents.join("Zega Apps"))
}

#[derive(Serialize)]
pub struct ProjectFile {
    path: String,
    source: Option<String>,
    modified_ms: Option<u64>,
}

fn read(dir: &Path) -> ProjectFile {
    let file = dir.join(SOURCE);
    let modified_ms = fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    ProjectFile { path: dir.to_string_lossy().into_owned(), source: fs::read_to_string(&file).ok(), modified_ms }
}

/// The error a new app's save returns when its folder already exists; the
/// builder then picks a fresh id rather than overwriting another app.
pub const FOLDER_TAKEN: &str = "folder-taken";

/// Write the app's source and manifest into its folder (named by the app's
/// id). `create` makes the folder exclusively: a new app never reuses one.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one field per thing the builder saves, straight from the IPC call
pub fn project_save(app: tauri::AppHandle, folder: String, name: String, source: String, width: u32, height: u32, agents: String, create: bool) -> Result<ProjectFile> {
    write_project(&apps_root(&app)?, &folder, &name, &source, (width, height), &agents, create)
}

fn write_project(root: &Path, folder: &str, name: &str, source: &str, (width, height): (u32, u32), agents: &str, create: bool) -> Result<ProjectFile> {
    fs::create_dir_all(root).map_err(|e| format!("Could not create {}: {e}", root.display()))?;
    let dir = root.join(folder_name(folder));
    if create {
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(FOLDER_TAKEN.into()),
            Err(e) => return Err(format!("Could not create {}: {e}", dir.display())),
        }
    } else {
        fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    fs::write(dir.join(SOURCE), source).map_err(|e| format!("Could not save {SOURCE}: {e}"))?;
    let manifest = serde_json::to_string_pretty(&manifest(name, width, height)).map_err(|e| e.to_string())?;
    fs::write(dir.join(MANIFEST), manifest + "\n").map_err(|e| format!("Could not save {MANIFEST}: {e}"))?;
    // What an agent working in this folder (Codex in the terminal) must know.
    fs::write(dir.join("AGENTS.md"), agents).map_err(|e| format!("Could not save AGENTS.md: {e}"))?;
    Ok(read(&dir))
}

/// The app's current source on disk, with its modification time, so the
/// builder can notice edits made elsewhere.
#[tauri::command]
pub fn project_read(path: String) -> ProjectFile {
    read(Path::new(&path))
}

// --- History: every version of every app, kept in the app's own folder -----
//
// .zega/history.json is the app's chat (one entry per version, as the builder
// shows it); .zega/versions/v<n>.dsx is the source at that version. The
// builder records each version as it lands, including edits made in the
// folder, so History can show every idea and every iteration and reopen them.

const HISTORY_DIR: &str = ".zega";
const HISTORY_FILE: &str = "history.json";

fn history_path(dir: &Path) -> PathBuf {
    dir.join(HISTORY_DIR).join(HISTORY_FILE)
}

fn version_path(dir: &Path, n: u64) -> PathBuf {
    dir.join(HISTORY_DIR).join("versions").join(format!("v{n}.dsx"))
}

fn read_history(dir: &Path) -> serde_json::Value {
    fs::read_to_string(history_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({ "versions": [] }))
}

/// Record one version: its chat entry (`entry`, whatever the builder shows,
/// with `n`) and its source. Re-recording a version replaces it.
fn record(dir: &Path, name: &str, entry: serde_json::Value, source: &str) -> Result<()> {
    let n = entry["n"].as_u64().ok_or("A version needs a number.")?;
    fs::create_dir_all(dir.join(HISTORY_DIR).join("versions")).map_err(|e| format!("Could not create the history folder: {e}"))?;
    fs::write(version_path(dir, n), source).map_err(|e| format!("Could not save version {n}: {e}"))?;
    let mut history = read_history(dir);
    history["name"] = serde_json::json!(name);
    let versions = history["versions"].as_array_mut().ok_or("The history file is damaged.")?;
    versions.retain(|v| v["n"].as_u64() != Some(n));
    versions.push(entry);
    versions.sort_by_key(|v| v["n"].as_u64().unwrap_or(0));
    let text = serde_json::to_string_pretty(&history).map_err(|e| e.to_string())?;
    // Write then rename, so a crash never leaves a half-written history.
    let tmp = history_path(dir).with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("Could not save the history: {e}"))?;
    fs::rename(&tmp, history_path(dir)).map_err(|e| format!("Could not save the history: {e}"))
}

#[tauri::command]
pub fn project_record(path: String, name: String, entry: serde_json::Value, source: String) -> Result<()> {
    record(Path::new(&path), &name, entry, &source)
}

#[derive(Serialize)]
pub struct AppSummary {
    path: String,
    id: String,
    name: String,
    first_ask: Option<String>,
    versions: usize,
    updated_ms: Option<u64>,
}

fn list(root: &Path) -> Vec<AppSummary> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut apps: Vec<AppSummary> = entries
        .flatten()
        .filter(|e| e.path().join(HISTORY_DIR).join(HISTORY_FILE).is_file())
        .map(|e| {
            let dir = e.path();
            let history = read_history(&dir);
            let versions = history["versions"].as_array().cloned().unwrap_or_default();
            let id = e.file_name().to_string_lossy().into_owned();
            let updated_ms = fs::metadata(history_path(&dir)).and_then(|m| m.modified()).ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
            AppSummary {
                path: dir.to_string_lossy().into_owned(),
                name: history["name"].as_str().map(str::to_owned).unwrap_or_else(|| id.clone()),
                id,
                first_ask: versions.first().and_then(|v| v["ask"].as_str()).map(str::to_owned),
                versions: versions.len(),
                updated_ms,
            }
        })
        .collect();
    apps.sort_by_key(|a| std::cmp::Reverse(a.updated_ms));
    apps
}

/// Every app with a history, most recently changed first.
#[tauri::command]
pub fn project_list(app: tauri::AppHandle) -> Result<Vec<AppSummary>> {
    Ok(list(&apps_root(&app)?))
}

/// One app's whole history: its chat entries, each with the source it had.
#[tauri::command]
pub fn project_history(path: String) -> Result<serde_json::Value> {
    let dir = Path::new(&path);
    let mut history = read_history(dir);
    if let Some(versions) = history["versions"].as_array_mut() {
        for version in versions {
            if let Some(n) = version["n"].as_u64() {
                version["source"] = serde_json::json!(fs::read_to_string(version_path(dir, n)).unwrap_or_default());
            }
        }
    }
    history["path"] = serde_json::json!(path);
    history["id"] = serde_json::json!(dir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default());
    Ok(history)
}

// --- Run on desktop: `deka dev` in the app's folder ---------------------------
//
// The real native window, with deka's fast refresh: every version the builder
// saves to app.dsx shows up there too. One run at a time; a new run replaces
// the last. Output goes to .zega/run.log for troubleshooting.

/// `deka` from the usual install places, else the local 0.60.1 build until
/// the native CLI is published to R2 (deka#1198). A GUI app doesn't get the
/// shell's PATH, so the locations are checked directly.
fn deka_cli() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    [home.join(".deka/bin/deka"), PathBuf::from("/usr/local/bin/deka"), PathBuf::from("/opt/homebrew/bin/deka"), PathBuf::from("/Volumes/Projects/claude/deka-runtime-0.60.1/bin/deka")]
        .into_iter()
        .find(|p| p.is_file())
}

#[derive(Default)]
pub struct RunState(std::sync::Mutex<Option<std::process::Child>>);

impl Drop for RunState {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.lock().ok().and_then(|mut c| c.take()) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
pub fn project_run(state: tauri::State<'_, RunState>, path: String) -> Result<()> {
    let dir = Path::new(&path);
    let cli = deka_cli().ok_or("The deka CLI isn't installed yet.")?;
    let mut running = state.0.lock().map_err(|_| "Run state unavailable.".to_string())?;
    if let Some(mut previous) = running.take() {
        let _ = previous.kill();
        let _ = previous.wait();
    }
    fs::create_dir_all(dir.join(HISTORY_DIR)).map_err(|e| e.to_string())?;
    let log = fs::File::create(dir.join(HISTORY_DIR).join("run.log")).map_err(|e| format!("Could not open the run log: {e}"))?;
    let child = std::process::Command::new(cli)
        .args(["dev", MANIFEST])
        .current_dir(dir)
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("Could not start deka dev: {e}"))?;
    *running = Some(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_are_safe_and_readable() {
        assert_eq!(folder_name("Horse Tinder"), "Horse Tinder");
        assert_eq!(folder_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(folder_name("   "), "Untitled app");
        assert_eq!(identifier("Horse Tinder!"), "app.zega.horse-tinder");
    }

    #[test]
    fn a_new_app_never_reuses_a_folder() {
        let root = tempfile::tempdir().unwrap();
        let first = write_project(root.path(), "excited-strawberry-x83k", "Horse Tinder", "a", (420, 640), "agents", true).unwrap();
        assert_eq!(fs::read_to_string(root.path().join("excited-strawberry-x83k/app.dsx")).unwrap(), "a");
        // A second new app with the same id is refused, and the first app is untouched.
        assert_eq!(write_project(root.path(), "excited-strawberry-x83k", "Other", "b", (420, 640), "agents", true).err().as_deref(), Some(FOLDER_TAKEN));
        assert_eq!(fs::read_to_string(root.path().join("excited-strawberry-x83k/app.dsx")).unwrap(), "a");
        // Saving an existing app updates it in place.
        write_project(root.path(), "excited-strawberry-x83k", "Horse Tinder", "c", (420, 640), "agents", false).unwrap();
        assert_eq!(read(Path::new(&first.path)).source.as_deref(), Some("c"));
    }

    #[test]
    fn history_keeps_every_version_and_lists_apps() {
        let root = tempfile::tempdir().unwrap();
        let app = write_project(root.path(), "glad-tiger-ir8r", "Horse Tinder", "v1 source", (420, 640), "agents", true).unwrap();
        let dir = Path::new(&app.path);
        record(dir, "Horse Tinder", serde_json::json!({ "n": 1, "ask": "make horse tinder" }), "v1 source").unwrap();
        record(dir, "Horse Tinder", serde_json::json!({ "n": 2, "ask": "more horses" }), "v2 source").unwrap();
        // Re-recording a version replaces it rather than duplicating it.
        record(dir, "Horse Tinder", serde_json::json!({ "n": 2, "ask": "more horses", "fixes": 1 }), "v2 fixed").unwrap();
        let history = project_history(app.path.clone()).unwrap();
        let versions = history["versions"].as_array().unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0]["source"], "v1 source");
        assert_eq!(versions[1]["source"], "v2 fixed");
        assert_eq!(versions[1]["fixes"], 1);
        let apps = list(root.path());
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].first_ask.as_deref(), Some("make horse tinder"));
        assert_eq!(apps[0].versions, 2);
        assert_eq!(apps[0].name, "Horse Tinder");
    }

    #[test]
    fn manifest_points_at_the_source_and_window_size() {
        let m = manifest("Horse Tinder", 420, 640);
        assert_eq!(m["desktop"]["entry"], "app.dsx");
        assert_eq!(m["desktop"]["productName"], "Horse Tinder");
        assert_eq!(m["desktop"]["window"]["width"], 420);
    }
}
