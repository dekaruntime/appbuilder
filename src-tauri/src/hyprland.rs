//! Hyprland exposes portal actions but requires an explicit compositor binding.
use crate::shortcut_config::Binding;
use serde::Deserialize;
#[cfg(target_os = "linux")]
use std::{fs, path::Path, process::Command};

const START: &str = "-- BEGIN ZEGA SEARCH SHORTCUT\n";
const END: &str = "-- END ZEGA SEARCH SHORTCUT\n";

#[derive(Deserialize)]
struct ExistingBinding {
    modmask: u32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    keycode: u32,
    #[serde(default)]
    catch_all: bool,
    #[serde(default)]
    description: String,
}

fn keys(binding: &Binding) -> String {
    let mut keys = Vec::new();
    if binding.control {
        keys.push("CTRL");
    }
    if binding.alt {
        keys.push("ALT");
    }
    if binding.shift {
        keys.push("SHIFT");
    }
    if binding.super_key {
        keys.push("SUPER");
    }
    keys.push(binding.key.strip_prefix("Key").unwrap_or(&binding.key));
    keys.join(" + ")
}

fn block(binding: &Binding, id: &str) -> String {
    format!(
        "{START}-- {}\nhl.bind({}, hl.dsp.global({}), {{description={}}})\n{END}",
        serde_json::to_string(binding).unwrap(),
        serde_json::to_string(&keys(binding)).unwrap(),
        serde_json::to_string(&format!("{id}:search")).unwrap(),
        serde_json::to_string(&format!("zega search ({id})")).unwrap()
    )
}

fn replace_block(contents: &str, binding: &Binding, id: &str) -> Result<String, String> {
    let desired = block(binding, id);
    match (contents.find(START), contents.find(END)) {
        (None, None) => Ok(format!("{contents}\n{desired}")),
        (Some(start), Some(end))
            if end > start
                && contents.matches(START).count() == 1
                && contents.matches(END).count() == 1 =>
        {
            let old = &contents[start..end + END.len()];
            let old_binding: Binding = serde_json::from_str(old.lines().nth(1).and_then(|line| line.strip_prefix("-- ")).ok_or("The zega shortcut block was edited. Remove that block manually before retrying.")?)
                .map_err(|_| "The zega shortcut block was edited. Remove that block manually before retrying.")?;
            old_binding.validate()?;
            if old != block(&old_binding, id) {
                return Err("The zega shortcut block was edited. Remove that block manually before retrying.".into());
            }
            let mut updated = contents.to_owned();
            updated.replace_range(start..end + END.len(), &desired);
            Ok(updated)
        }
        _ => Err(
            "The zega shortcut block is incomplete or duplicated. Repair it before retrying."
                .into(),
        ),
    }
}

fn modifier_mask(binding: &Binding) -> u32 {
    u32::from(binding.shift)
        | (u32::from(binding.control) << 2)
        | (u32::from(binding.alt) << 3)
        | (u32::from(binding.super_key) << 6)
}

fn conflicts(
    bindings: &[ExistingBinding],
    binding: &Binding,
    owned_description: &str,
) -> Vec<String> {
    let mask = modifier_mask(binding);
    bindings
        .iter()
        .filter(|item| {
            item.modmask & 77 == mask
                && (owned_description.is_empty() || item.description != owned_description)
                && (item.catch_all
                    || item.key.eq_ignore_ascii_case(
                        binding.key.strip_prefix("Key").unwrap_or(&binding.key),
                    )
                    || item.keycode != 0)
        })
        .map(|item| {
            if item.description.is_empty() {
                "another desktop action".into()
            } else {
                item.description.clone()
            }
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn atomic_replace(path: &Path, expected: &str, updated: &str) -> Result<(), String> {
    use std::io::Write;
    let staging = path.with_extension(format!("lua.zega-{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.set_permissions(fs::metadata(path).map_err(|e| e.to_string())?.permissions())
            .map_err(|e| e.to_string())?;
        file.write_all(updated.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if fs::read_to_string(path).map_err(|e| e.to_string())? != expected {
            return Err(
                "Your bindings changed while saving. Retry with the latest configuration.".into(),
            );
        }
        fs::rename(&staging, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

#[cfg(target_os = "linux")]
fn ctl(instance: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("hyprctl")
        .args(["-i", instance])
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Hyprland rejected the shortcut change: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(target_os = "linux")]
pub fn configure(config_dir: &Path, binding: &Binding, id: &str) -> Result<Option<String>, String> {
    let output = match Command::new("hyprctl").args(["-j", "instances"]).output() {
        Ok(output) if output.status.success() => output,
        _ => return Ok(None), // Other Wayland desktops use their portal's binding UI.
    };
    let instances: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    if instances.is_empty() {
        return Ok(None);
    }
    if instances.len() != 1 {
        return Err("Multiple Hyprland sessions are running. Configure the shortcut in the intended session.".into());
    }
    let instance = instances[0]["instance"]
        .as_str()
        .ok_or("Hyprland did not identify its session")?;
    let version: serde_json::Value =
        serde_json::from_str(&ctl(instance, &["-j", "version"])?).map_err(|e| e.to_string())?;
    let version = version["version"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v');
    let minor = version
        .split('.')
        .nth(1)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    if !version.starts_with("0.") || minor < 55 {
        return Err("Automatic setup needs Hyprland 0.55 or newer with Lua configuration. Use the platform guide for this version.".into());
    }
    let path = config_dir.join("hypr/bindings.lua");
    if !fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Err("Your Hyprland configuration uses a custom layout. Add the search binding in your personal configuration using the platform guide.".into());
    }
    let original = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let updated = replace_block(&original, binding, id)?;
    let bindings: Vec<ExistingBinding> =
        serde_json::from_str(&ctl(instance, &["-j", "binds"])?).map_err(|e| e.to_string())?;
    let description = format!("zega search ({id})");
    // Only recognize ownership when a valid managed block exists in the user's file.
    let owned = if original.contains(START) {
        description.as_str()
    } else {
        ""
    };
    let occupied = conflicts(&bindings, binding, owned);
    if !occupied.is_empty() {
        return Err(format!(
            "{} is already used by {}. Choose another shortcut; existing bindings were preserved.",
            binding.label(),
            occupied.join(", ")
        ));
    }
    if !ctl(instance, &["configerrors"])?.is_empty() {
        return Err(
            "Hyprland has configuration errors. Resolve them before saving a shortcut.".into(),
        );
    }
    atomic_replace(&path, &original, &updated)?;
    let applied = (|| {
        let reply = ctl(instance, &["reload", "config-only"])?;
        if reply != "ok" {
            return Err(reply);
        }
        let errors = ctl(instance, &["configerrors"])?;
        if !errors.is_empty() {
            return Err(errors);
        }
        let active: Vec<ExistingBinding> =
            serde_json::from_str(&ctl(instance, &["-j", "binds"])?).map_err(|e| e.to_string())?;
        if !active.iter().any(|item| {
            item.description == description
                && item.modmask & 77 == modifier_mask(binding)
                && item
                    .key
                    .eq_ignore_ascii_case(binding.key.strip_prefix("Key").unwrap_or(&binding.key))
        }) {
            return Err(
                "The personal bindings file is not included by your Hyprland configuration.".into(),
            );
        }
        Ok(())
    })();
    if let Err(error) = applied {
        if fs::read_to_string(&path).ok().as_deref() == Some(updated.as_str()) {
            atomic_replace(&path, &updated, &original).map_err(|e| {
                format!("{error}; could not restore the original configuration: {e}")
            })?;
            let _ = ctl(instance, &["reload", "config-only"]);
        }
        return Err(format!("Could not enable the desktop shortcut: {error}"));
    }
    Ok(Some(binding.label()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn atomic_write_preserves_newer_user_edits_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::current_dir().unwrap().join(".tmp");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("bindings-test-{}.lua", std::process::id()));
        fs::write(&path, "personal binding").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        atomic_replace(&path, "personal binding", "personal plus zega").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "personal plus zega");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::write(&path, "newer user edit").unwrap();
        assert!(atomic_replace(&path, "personal plus zega", "replacement").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "newer user edit");
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn preserves_personal_bindings_and_replaces_only_its_own_block() {
        let original = "-- personal settings\nhl.bind(\"SUPER + Q\", hl.dsp.killactive())\n";
        let first = replace_block(
            original,
            &Binding::for_platform("linux"),
            "dev.zega.desktop",
        )
        .unwrap();
        let next =
            replace_block(&first, &Binding::for_platform("macos"), "dev.zega.desktop").unwrap();
        assert!(next.starts_with(original));
        assert_eq!(next.matches(START).count(), 1);
        assert!(!next.contains("SUPER + Z"));
        assert!(next.contains("ALT + Space"));
        assert!(replace_block(
            &first.replace("hl.dsp.global", "user.changed"),
            &Binding::default(),
            "dev.zega.desktop"
        )
        .is_err());
    }
    #[test]
    fn detects_occupied_combinations_without_overriding_them() {
        let bindings: Vec<ExistingBinding> =
            serde_json::from_str(r#"[{"modmask":64,"key":"Z","description":"Other launcher"}]"#)
                .unwrap();
        assert_eq!(
            conflicts(&bindings, &Binding::for_platform("linux"), "zega search"),
            ["Other launcher"]
        );
        let unnamed: Vec<ExistingBinding> =
            serde_json::from_str(r#"[{"modmask":64,"key":"Z"}]"#).unwrap();
        assert_eq!(
            conflicts(&unnamed, &Binding::for_platform("linux"), ""),
            ["another desktop action"]
        );
        assert!(conflicts(&bindings, &Binding::for_platform("macos"), "zega search").is_empty());
    }
}
