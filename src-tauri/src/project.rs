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
    fn manifest_points_at_the_source_and_window_size() {
        let m = manifest("Horse Tinder", 420, 640);
        assert_eq!(m["desktop"]["entry"], "app.dsx");
        assert_eq!(m["desktop"]["productName"], "Horse Tinder");
        assert_eq!(m["desktop"]["window"]["width"], 420);
    }
}
