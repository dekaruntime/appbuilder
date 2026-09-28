use plist::Value;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{Manager, State};

const SPOTLIGHT_QUERY: &str = "kMDItemContentModificationDate >= $time.now(-604800) && kMDItemContentTypeTree == \"public.data\"";
const PHOTO_SPOTLIGHT_QUERY: &str = "kMDItemContentModificationDate >= $time.now(-604800) && kMDItemContentTypeTree == \"public.image\"";
const MAX_SPOTLIGHT_CANDIDATES: usize = 500;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    name: String,
    location: String,
    file_type: String,
    modified_label: String,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPane {
    label: &'static str,
    icon: &'static str,
    bundle_id: String,
}

#[derive(Default)]
pub struct SettingsIndex(Vec<SettingsPane>);

pub struct PictureAccess(Mutex<Option<PathBuf>>);

impl PictureAccess {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let allowed = pictures_directory().ok().and_then(|pictures| {
            let saved = app.path().app_config_dir().ok()?.join("pictures-folder");
            let selected = fs::read_to_string(saved).ok()?;
            let selected = PathBuf::from(selected).canonicalize().ok()?;
            (selected == pictures.canonicalize().ok()?).then_some(selected)
        });
        Self(Mutex::new(allowed))
    }

    fn selected(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .map_err(|_| "Pictures access state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Pictures access has not been granted".to_owned())
    }

    fn grant(&self, path: PathBuf) -> Result<(), String> {
        *self
            .0
            .lock()
            .map_err(|_| "Pictures access state is unavailable".to_owned())? = Some(path);
        Ok(())
    }
}

impl SettingsIndex {
    pub fn search_actions(&self) -> Vec<(String, String)> {
        self.0
            .iter()
            .map(|pane| (pane.label.to_owned(), pane.bundle_id.clone()))
            .collect()
    }

    pub fn discover() -> Self {
        let roots = [
            PathBuf::from("/System/Library/ExtensionKit/Extensions"),
            PathBuf::from("/System/Library/PreferencePanes"),
            PathBuf::from("/Library/PreferencePanes"),
        ];
        Self(discover_in(&roots))
    }
}

fn recent_files() -> Result<Vec<RecentFile>, String> {
    let home = home_directory()?;
    let mut child = Command::new("/usr/bin/mdfind")
        .arg("-onlyin")
        .arg(&home)
        .arg(SPOTLIGHT_QUERY)
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not query the local Spotlight index: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Spotlight output is unavailable")?;
    let mut candidates = Vec::new();
    for path in BufReader::new(stdout)
        .lines()
        .map_while(Result::ok)
        .take(MAX_SPOTLIGHT_CANDIDATES)
    {
        candidates.push(PathBuf::from(path));
    }
    let stopped_at_limit = candidates.len() == MAX_SPOTLIGHT_CANDIDATES;
    if stopped_at_limit {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|error| format!("Could not finish the local Spotlight query: {error}"))?;
    if !status.success() && !stopped_at_limit {
        return Err("The local Spotlight query did not complete".to_owned());
    }

    let cutoff = SystemTime::now() - Duration::from_secs(7 * 24 * 60 * 60);
    let mut files = candidates
        .into_iter()
        .filter_map(|path| recent_file(path, &home, cutoff))
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    Ok(files.into_iter().take(5).map(|(_, file)| file).collect())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentPhoto {
    name: String,
    path: String,
}

fn home_directory() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "The current user's home directory is unavailable".to_owned())
}

fn pictures_directory() -> Result<PathBuf, String> {
    Ok(home_directory()?.join("Pictures"))
}

fn recent_photos(pictures: &Path) -> Result<Vec<RecentPhoto>, String> {
    let mut child = Command::new("/usr/bin/mdfind")
        .arg("-onlyin")
        .arg(pictures)
        .arg(PHOTO_SPOTLIGHT_QUERY)
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not query the local photo index: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Spotlight photo output is unavailable")?;
    let mut photos = Vec::new();
    for path in BufReader::new(stdout)
        .lines()
        .map_while(Result::ok)
        .take(MAX_SPOTLIGHT_CANDIDATES)
    {
        let path = PathBuf::from(path);
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || !path.starts_with(pictures) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        photos.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            RecentPhoto {
                name: name.to_owned(),
                path: path.to_string_lossy().into_owned(),
            },
        ));
    }
    let status = child
        .wait()
        .map_err(|error| format!("Could not finish the local photo query: {error}"))?;
    if !status.success() {
        return Err("The local photo query did not complete".to_owned());
    }
    photos.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    Ok(photos.into_iter().take(6).map(|(_, photo)| photo).collect())
}

fn recent_file(path: PathBuf, home: &Path, cutoff: SystemTime) -> Option<(SystemTime, RecentFile)> {
    if !is_user_visible_path(&path, home) {
        return None;
    }
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    if name.starts_with('.') {
        return None;
    }
    let modified = metadata.modified().ok()?;
    if modified < cutoff {
        return None;
    }
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default();
    let modified_label = if age < Duration::from_secs(60 * 60) {
        format!("{} min ago", (age.as_secs() / 60).max(1))
    } else if age < Duration::from_secs(24 * 60 * 60) {
        format!("{} hr ago", age.as_secs() / (60 * 60))
    } else if age < Duration::from_secs(2 * 24 * 60 * 60) {
        "Yesterday".to_owned()
    } else {
        format!("{} days ago", age.as_secs() / (24 * 60 * 60))
    };
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_ascii_uppercase();
    let location = path
        .parent()
        .and_then(|parent| parent.strip_prefix(home).ok())
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| relative.to_string_lossy().replace('/', " › "))
        .unwrap_or_else(|| "Home".to_owned());
    Some((
        modified,
        RecentFile {
            name,
            location,
            file_type: extension,
            modified_label,
            path: path.to_string_lossy().into_owned(),
        },
    ))
}

fn is_user_visible_path(path: &Path, home: &Path) -> bool {
    path.strip_prefix(home).ok().is_some_and(|relative| {
        relative.components().all(|component| {
            let name = component.as_os_str().to_string_lossy();
            !name.starts_with('.') && name != "Library" && name != "node_modules"
        })
    })
}

fn recent_files_command() -> Result<Vec<RecentFile>, String> {
    recent_files()
}

#[tauri::command]
pub async fn local_recent_files() -> Result<Vec<RecentFile>, String> {
    tauri::async_runtime::spawn_blocking(recent_files_command)
        .await
        .map_err(|error| format!("Local file search failed: {error}"))?
}

#[tauri::command]
pub fn local_pictures_access_granted(access: State<'_, PictureAccess>) -> bool {
    access.selected().is_ok()
}

#[tauri::command]
pub fn local_user_first_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CStr;
        let full_name = objc2_foundation::NSFullUserName();
        let value = unsafe { CStr::from_ptr(full_name.UTF8String()) }.to_string_lossy();
        value.split_whitespace().next().map(str::to_owned)
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[tauri::command]
pub async fn local_recent_photos(
    access: State<'_, PictureAccess>,
) -> Result<Vec<RecentPhoto>, String> {
    let pictures = access.selected()?;
    tauri::async_runtime::spawn_blocking(move || recent_photos(&pictures))
        .await
        .map_err(|error| format!("Local photo search failed: {error}"))?
}

#[tauri::command]
pub async fn request_pictures_access(
    app: tauri::AppHandle,
    access: State<'_, PictureAccess>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    let pictures = pictures_directory()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose your Pictures folder for local photo previews")
        .set_directory(&pictures)
        .pick_folder(move |selected| {
            let _ = sender.send(selected.and_then(|path| path.into_path().ok()));
        });
    let Some(selected) = receiver
        .await
        .map_err(|error| format!("The Pictures folder dialog failed: {error}"))?
    else {
        return Ok(false);
    };
    let selected = selected
        .canonicalize()
        .map_err(|error| format!("Could not verify the selected folder: {error}"))?;
    if selected != pictures.canonicalize().map_err(|error| error.to_string())? {
        return Err("Select your Pictures folder to grant photo access".to_owned());
    }
    let saved = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("pictures-folder");
    let parent = saved
        .parent()
        .ok_or("App settings location is unavailable")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::write(saved, selected.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
    access.grant(selected)?;
    Ok(true)
}

#[tauri::command]
pub fn local_settings_panes(index: State<'_, SettingsIndex>) -> Vec<SettingsPane> {
    index.0.clone()
}

#[tauri::command]
pub fn open_local_file(path: String) -> Result<(), String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "The current user's home directory is unavailable".to_owned())?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open the selected file: {error}"))?;
    let canonical_home = home
        .canonicalize()
        .map_err(|error| format!("Could not resolve the current user's home directory: {error}"))?;
    if !path.starts_with(canonical_home) || !path.is_file() {
        return Err("Only files in the current user's home directory can be opened".to_owned());
    }
    Command::new("/usr/bin/open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Finder could not open the selected file: {error}"))
}

#[tauri::command]
pub fn open_settings_pane(
    bundle_id: String,
    index: State<'_, SettingsIndex>,
) -> Result<(), String> {
    let pane = index
        .0
        .iter()
        .find(|pane| pane.bundle_id == bundle_id)
        .ok_or_else(|| "The selected System Settings pane is not installed".to_owned())?;
    let url = settings_url(&pane.bundle_id);
    Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("System Settings could not open the selected pane: {error}"))
}

fn settings_url(bundle_id: &str) -> String {
    format!("x-apple.systempreferences:{bundle_id}")
}

fn discover_in(roots: &[PathBuf]) -> Vec<SettingsPane> {
    let mut panes = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let bundle = entry.path();
            let info = bundle.join("Contents/Info.plist");
            let Ok(value) = Value::from_file(info) else {
                continue;
            };
            let Some(dictionary) = value.as_dictionary() else {
                continue;
            };
            let Some(bundle_id) = dictionary
                .get("CFBundleIdentifier")
                .and_then(Value::as_string)
            else {
                continue;
            };
            if !is_settings_bundle_id(bundle_id) {
                continue;
            }
            let name = dictionary
                .get("CFBundleName")
                .and_then(Value::as_string)
                .or_else(|| {
                    dictionary
                        .get("CFBundleDisplayName")
                        .and_then(Value::as_string)
                })
                .unwrap_or_default();
            let Some((label, icon)) = settings_label(name, bundle_id) else {
                continue;
            };
            panes.push(SettingsPane {
                label,
                icon,
                bundle_id: bundle_id.to_owned(),
            });
        }
    }
    panes.sort_by_key(|pane| !pane.bundle_id.ends_with("-Settings.extension"));
    let mut seen = HashSet::new();
    panes.retain(|pane| seen.insert(pane.label));
    panes
}

fn is_settings_bundle_id(bundle_id: &str) -> bool {
    bundle_id.starts_with("com.apple.")
        && (bundle_id.ends_with("-Settings.extension")
            || bundle_id.starts_with("com.apple.preference.")
            || bundle_id.starts_with("com.apple.preferences."))
}

fn settings_label(name: &str, bundle_id: &str) -> Option<(&'static str, &'static str)> {
    let identity = format!("{name} {bundle_id}").to_ascii_lowercase();
    if identity.contains("appearance") || identity.contains("general") {
        Some(("Dark mode", "◐"))
    } else if identity.contains("keyboard") {
        Some(("Keyboard", "⌨"))
    } else if identity.contains("sound") {
        Some(("Sound", "🔈"))
    } else if identity.contains("display") {
        Some(("Displays", "▭"))
    } else if identity.contains("network") || identity.contains("wifi") {
        Some(("Wi-Fi", "⌁"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        discover_in, is_settings_bundle_id, settings_label, settings_url, PictureAccess,
        PHOTO_SPOTLIGHT_QUERY, SPOTLIGHT_QUERY,
    };
    use plist::{Dictionary, Value};
    use std::fs;
    use std::fs::{File, FileTimes};
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime};

    #[test]
    fn spotlight_query_limits_files_to_the_last_seven_days() {
        assert!(SPOTLIGHT_QUERY.contains("$time.now(-604800)"));
        assert!(SPOTLIGHT_QUERY.contains("public.data"));
    }

    #[test]
    fn photo_query_limits_results_to_recent_images_and_requires_user_selection() {
        assert!(PHOTO_SPOTLIGHT_QUERY.contains("$time.now(-604800)"));
        assert!(PHOTO_SPOTLIGHT_QUERY.contains("public.image"));
        assert!(PictureAccess(Mutex::new(None)).selected().is_err());
    }

    #[test]
    fn local_file_filter_excludes_hidden_and_library_paths() {
        let home = PathBuf::from("/Users/example");
        assert!(super::is_user_visible_path(
            &home.join("Documents/notes.txt"),
            &home
        ));
        assert!(!super::is_user_visible_path(
            &home.join(".ssh/config"),
            &home
        ));
        assert!(!super::is_user_visible_path(
            &home.join("Library/Preferences/prefs.plist"),
            &home
        ));
        assert!(!super::is_user_visible_path(
            &PathBuf::from("/Volumes/share/file.txt"),
            &home
        ));
    }

    #[test]
    fn recent_file_results_enforce_the_seven_day_cutoff() {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.tmp/recent-file-fixture");
        let documents = home.join("Documents");
        fs::create_dir_all(&documents).expect("create in-repo recent file fixture");
        let recent = documents.join("recent.txt");
        let expired = documents.join("expired.txt");
        File::create(&recent).expect("create recent fixture");
        File::create(&expired).expect("create expired fixture");
        let now = SystemTime::now();
        let old = now - Duration::from_secs(8 * 24 * 60 * 60);
        File::open(&expired)
            .expect("open expired fixture")
            .set_times(FileTimes::new().set_modified(old))
            .expect("set expired timestamp");
        let cutoff = now - Duration::from_secs(7 * 24 * 60 * 60);

        assert!(super::recent_file(recent, &home, cutoff).is_some());
        assert!(super::recent_file(expired, &home, cutoff).is_none());
        fs::remove_dir_all(home).expect("remove in-repo recent file fixture");
    }

    #[test]
    fn discovered_settings_use_the_identifier_read_from_the_installed_bundle() {
        assert!(is_settings_bundle_id(
            "com.apple.TestNetwork-Settings.extension"
        ));
        assert_eq!(
            settings_label("Network", "com.apple.TestNetwork-Settings.extension"),
            Some(("Wi-Fi", "⌁"))
        );
    }

    #[test]
    fn installed_bundle_identifier_is_used_as_the_settings_deep_link_target() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.tmp/settings-fixture");
        let bundle = root.join("Network.appex");
        let contents = bundle.join("Contents");
        fs::create_dir_all(&contents).expect("create in-repo settings fixture");
        let mut dictionary = Dictionary::new();
        dictionary.insert(
            "CFBundleIdentifier".to_owned(),
            Value::String("com.apple.LocalNetworkSettings-Settings.extension".to_owned()),
        );
        dictionary.insert(
            "CFBundleName".to_owned(),
            Value::String("Network".to_owned()),
        );
        Value::Dictionary(dictionary)
            .to_file_xml(contents.join("Info.plist"))
            .expect("write settings fixture");
        let legacy_contents = root.join("LegacyNetwork.prefPane/Contents");
        fs::create_dir_all(&legacy_contents).expect("create legacy settings fixture");
        let mut legacy = Dictionary::new();
        legacy.insert(
            "CFBundleIdentifier".to_owned(),
            Value::String("com.apple.preference.network".to_owned()),
        );
        legacy.insert(
            "CFBundleName".to_owned(),
            Value::String("Network".to_owned()),
        );
        Value::Dictionary(legacy)
            .to_file_xml(legacy_contents.join("Info.plist"))
            .expect("write legacy settings fixture");

        let discovered = discover_in(std::slice::from_ref(&root));
        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0].bundle_id,
            "com.apple.LocalNetworkSettings-Settings.extension"
        );
        assert_eq!(
            settings_url(&discovered[0].bundle_id),
            "x-apple.systempreferences:com.apple.LocalNetworkSettings-Settings.extension"
        );
        fs::remove_dir_all(root).expect("remove in-repo settings fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn machine_settings_index_contains_identifiers_read_from_installed_panels() {
        let index = super::SettingsIndex::discover();
        assert!(
            !index.0.is_empty(),
            "installed System Settings panels are discovered"
        );
        assert!(index.0.iter().all(|pane| !pane.bundle_id.is_empty()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn spotlight_results_stay_inside_the_current_home_directory() {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("the current user's home directory is available");
        let files = super::recent_files().expect("query local Spotlight index");
        assert!(files.len() <= 5);
        assert!(files
            .iter()
            .all(|file| PathBuf::from(&file.path).starts_with(&home)));
    }
}
