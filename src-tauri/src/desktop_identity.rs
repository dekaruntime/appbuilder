//! Host portals require a discoverable desktop entry, including in `tauri dev`.
use std::{fs, io::Write, path::Path};
use tauri::{AppHandle, Manager};

pub fn prepare(app: &AppHandle) -> Result<(), String> {
    let id = &app.config().identifier;
    let filename = format!("{id}.desktop");
    if gdk::gio::DesktopAppInfo::new(&filename).is_some() {
        return Ok(());
    }
    let directory = app
        .path()
        .data_dir()
        .map_err(|e| e.to_string())?
        .join("applications");
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    install_entry(&directory.join(filename), &executable)
}

fn install_entry(path: &Path, executable: &Path) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Missing desktop entry directory")?)
        .map_err(|e| e.to_string())?;
    let contents = desktop_entry(executable)?;
    // Never overwrite an entry installed by a package manager or the user.
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(contents.as_bytes())
            .map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("Cannot install zega's desktop identity: {error}")),
    }
}

pub(crate) fn desktop_entry(executable: &Path) -> Result<String, String> {
    let path = executable
        .to_str()
        .ok_or("The app's executable path is not UTF-8")?;
    if path.contains(['\n', '\r', '\0']) {
        return Err("Invalid executable path".into());
    }
    // Exec quoting is desktop-entry syntax, not shell syntax. Escape field codes
    // and both the Exec quoting layer and the desktop string-value layer.
    let mut quoted = String::new();
    for ch in path.chars() {
        match ch {
            '%' => quoted.push_str("%%"),
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(ch);
            }
            _ => quoted.push(ch),
        }
    }
    Ok(format!("[Desktop Entry]\nType=Application\nName=zega\nExec=\"{quoted}\" --shortcut-setup\nNoDisplay=true\nTerminal=false\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gdk::gio::prelude::*;

    #[test]
    fn desktop_entry_round_trips_executable_without_shell_expansion() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("zega-desktop-entry-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("zega space\"$`\\app");
        let marker = directory.join("launched");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\n[ \"$1\" = \"--shortcut-setup\" ] && touch '{}'\n",
                marker.to_string_lossy().replace('\'', "'\\''")
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let entry = directory.join("zega.desktop");
        install_entry(&entry, &executable).unwrap();
        let contents = fs::read_to_string(&entry).unwrap();
        let key_file = gdk::glib::KeyFile::new();
        key_file
            .load_from_data(&contents, gdk::glib::KeyFileFlags::NONE)
            .unwrap();
        let info = gdk::gio::DesktopAppInfo::from_keyfile(&key_file).unwrap();
        info.launch(&[], None::<&gdk::gio::AppLaunchContext>)
            .unwrap();
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            marker.exists(),
            "GIO must launch the exact executable and argument"
        );
        fs::remove_file(marker).unwrap();
        fs::write(&entry, "user-managed entry").unwrap();
        install_entry(&entry, &executable).unwrap();
        assert_eq!(fs::read_to_string(&entry).unwrap(), "user-managed entry");
        fs::remove_file(entry).unwrap();
        fs::remove_file(executable).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn rejects_desktop_entry_line_injection() {
        assert!(desktop_entry(Path::new("/a\nHidden=false")).is_err());
    }
}
