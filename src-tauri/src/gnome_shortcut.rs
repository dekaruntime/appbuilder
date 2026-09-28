//! GNOME releases without GlobalShortcuts use the desktop's custom shortcuts.
//! Only zega's own entry is written; existing shortcuts are checked first.
use crate::shortcut_config::Binding;
use gdk::glib::{variant::ToVariant, Variant};
use std::{path::Path, process::Command};

const MEDIA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const OWN: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/zega-desktop/";

pub async fn available() -> Result<bool, String> {
    let connection = ashpd::zbus::Connection::session()
        .await
        .map_err(|e| e.to_string())?;
    let bus = ashpd::zbus::fdo::DBusProxy::new(&connection)
        .await
        .map_err(|e| e.to_string())?;
    if !bus
        .name_has_owner(
            "org.gnome.Shell"
                .try_into()
                .map_err(|e: ashpd::zbus::names::Error| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(false);
    }
    let portal = ashpd::zbus::fdo::IntrospectableProxy::builder(&connection)
        .destination("org.freedesktop.portal.Desktop")
        .map_err(|e| e.to_string())?
        .path("/org/freedesktop/portal/desktop")
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    let xml = portal.introspect().await.map_err(|e| e.to_string())?;
    Ok(!xml.contains("interface name=\"org.freedesktop.portal.GlobalShortcuts\""))
}

fn run(args: &[&str]) -> Result<String, String> {
    let output = Command::new("gsettings")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "GNOME shortcut settings failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_owned())
        .map_err(|e| e.to_string())
}

trait Settings {
    fn get(&self, schema: &str, key: &str) -> Result<Variant, String>;
    fn set(&mut self, schema: &str, key: &str, value: &Variant) -> Result<(), String>;
    fn shortcuts(&self) -> Result<Vec<(String, String)>, String>;
}
struct Desktop;
impl Settings for Desktop {
    fn get(&self, schema: &str, key: &str) -> Result<Variant, String> {
        Variant::parse(None, &run(&["get", schema, key])?).map_err(|e| e.to_string())
    }
    fn set(&mut self, schema: &str, key: &str, value: &Variant) -> Result<(), String> {
        if run(&["writable", schema, key])? != "true" {
            return Err("Your administrator has locked this GNOME shortcut setting.".into());
        }
        run(&["set", schema, key, &value.print(true)]).map(|_| ())
    }
    fn shortcuts(&self) -> Result<Vec<(String, String)>, String> {
        let mut shortcuts = Vec::new();
        for schema in run(&["list-schemas"])?
            .lines()
            .filter(|s| s.ends_with(".keybindings") || *s == MEDIA)
        {
            for key in run(&["list-keys", schema])?
                .lines()
                .filter(|k| *k != "custom-keybindings")
            {
                let value = self.get(schema, key)?;
                if let Some(values) = value.get::<Vec<String>>() {
                    shortcuts.extend(values.into_iter().map(|v| (format!("{schema}: {key}"), v)));
                } else if let Some(value) = value.get::<String>() {
                    shortcuts.push((format!("{schema}: {key}"), value));
                }
            }
        }
        Ok(shortcuts)
    }
}

fn strings(value: Variant) -> Result<Vec<String>, String> {
    value
        .get()
        .ok_or_else(|| "GNOME returned an invalid shortcut list.".into())
}
fn string(value: Variant) -> Result<String, String> {
    value
        .get()
        .ok_or_else(|| "GNOME returned an invalid shortcut value.".into())
}
fn accelerator(binding: &Binding) -> String {
    let mut result = String::new();
    for (enabled, modifier) in [
        (binding.control, "Control"),
        (binding.alt, "Alt"),
        (binding.shift, "Shift"),
        (binding.super_key, "Super"),
    ] {
        if enabled {
            result.push_str(&format!("<{modifier}>"));
        }
    }
    let key = binding.key.strip_prefix("Key").unwrap_or(&binding.key);
    result.push_str(&key.to_ascii_lowercase());
    result
}
fn normalized(value: &str) -> (Vec<String>, String) {
    let value = value.to_ascii_lowercase();
    let mut rest = value.as_str();
    let mut modifiers = Vec::new();
    while let Some(modifier) = rest.strip_prefix('<').and_then(|s| s.split_once('>')) {
        modifiers.push(
            match modifier.0 {
                "primary" | "ctrl" | "control" => "control",
                "mod1" | "alt" => "alt",
                "mod4" | "super" => "super",
                other => other,
            }
            .to_owned(),
        );
        rest = modifier.1;
    }
    modifiers.sort();
    modifiers.dedup();
    (modifiers, rest.to_owned())
}

fn configure(settings: &mut impl Settings, binding: &Binding, command: &str) -> Result<(), String> {
    binding.validate()?;
    let desired = accelerator(binding);
    let original = settings.get(MEDIA, "custom-keybindings")?;
    let mut paths = strings(original.clone())?;
    let own_schema = format!("{CUSTOM}:{OWN}");
    let old_name = settings.get(&own_schema, "name")?;
    let old_command = settings.get(&own_schema, "command")?;
    let old_binding = settings.get(&own_schema, "binding")?;
    let previous_command = string(old_command.clone())?;
    if !previous_command.is_empty() && previous_command != command {
        return Err("The zega shortcut entry belongs to another installation. Review it in GNOME Keyboard Settings before retrying.".into());
    }
    let mut occupied = settings.shortcuts()?;
    for path in paths.iter().filter(|path| path.as_str() != OWN) {
        let schema = format!("{CUSTOM}:{path}");
        occupied.push((
            string(settings.get(&schema, "name")?)?,
            string(settings.get(&schema, "binding")?)?,
        ));
    }
    if let Some((name, _)) = occupied
        .iter()
        .find(|(_, value)| !value.is_empty() && normalized(value) == normalized(&desired))
    {
        return Err(format!("{} is already used by {name}. Choose another shortcut or change it in GNOME Keyboard Settings.", binding.label()));
    }
    if !paths.iter().any(|path| path == OWN) {
        paths.push(OWN.into());
    }
    // Check again before changing the list, preserving unrelated custom entries.
    if settings.get(MEDIA, "custom-keybindings")? != original {
        return Err("GNOME shortcuts changed during setup. Retry.".into());
    }
    let updated = paths.to_variant();
    let result = (|| {
        settings.set(&own_schema, "name", &"zega Search".to_variant())?;
        settings.set(&own_schema, "command", &command.to_variant())?;
        settings.set(&own_schema, "binding", &desired.to_variant())?;
        if settings.get(MEDIA, "custom-keybindings")? != original {
            return Err("GNOME shortcuts changed during setup. Retry.".into());
        }
        settings.set(MEDIA, "custom-keybindings", &updated)?;
        if settings.get(&own_schema, "binding")? != desired.to_variant()
            || settings.get(&own_schema, "command")? != command.to_variant()
            || !strings(settings.get(MEDIA, "custom-keybindings")?)?
                .iter()
                .any(|p| p == OWN)
        {
            return Err("GNOME did not save the shortcut. Retry in Keyboard Settings.".into());
        }
        Ok(())
    })();
    if result.is_err() {
        // Roll back only our entry; never replace a list someone else just edited.
        let _ = settings.set(&own_schema, "name", &old_name);
        let _ = settings.set(&own_schema, "command", &old_command);
        let _ = settings.set(&own_schema, "binding", &old_binding);
        if settings.get(MEDIA, "custom-keybindings").ok().as_ref() == Some(&updated) {
            let _ = settings.set(MEDIA, "custom-keybindings", &original);
        }
    }
    result
}

pub fn install(binding: &Binding, executable: &Path) -> Result<String, String> {
    static CONFIGURING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = CONFIGURING.lock().map_err(|e| e.to_string())?;
    let quoted = gdk::glib::shell_quote(executable)
        .into_string()
        .map_err(|_| "The application path must be valid UTF-8 for GNOME shortcuts.")?;
    let command = format!("{quoted} --global-shortcut");
    configure(&mut Desktop, binding, &command)?;
    Ok(binding.label())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[tokio::test]
    #[ignore = "requires GNOME without GlobalShortcuts; checks an existing system conflict without writing settings"]
    async fn installed_gnome_detects_reserved_system_shortcut() {
        assert!(available().await.unwrap());
        let before = Desktop.get(MEDIA, "custom-keybindings").unwrap();
        let mut binding = Binding::for_platform("linux");
        binding.key = "Space".into();
        let error = install(&binding, &std::env::current_exe().unwrap()).unwrap_err();
        assert!(error.contains("already used"), "{error}");
        assert_eq!(Desktop.get(MEDIA, "custom-keybindings").unwrap(), before);
    }
    struct Memory {
        values: BTreeMap<(String, String), Variant>,
        occupied: Vec<(String, String)>,
        writes: usize,
        fail_write: Option<usize>,
    }
    impl Memory {
        fn new() -> Self {
            let schema = format!("{CUSTOM}:{OWN}");
            Self {
                values: [
                    (
                        (MEDIA.into(), "custom-keybindings".into()),
                        Vec::<String>::new().to_variant(),
                    ),
                    ((schema.clone(), "name".into()), "".to_variant()),
                    ((schema.clone(), "command".into()), "".to_variant()),
                    ((schema, "binding".into()), "".to_variant()),
                ]
                .into(),
                occupied: vec![],
                writes: 0,
                fail_write: None,
            }
        }
    }
    impl Settings for Memory {
        fn get(&self, s: &str, k: &str) -> Result<Variant, String> {
            self.values
                .get(&(s.into(), k.into()))
                .cloned()
                .ok_or_else(|| "missing setting".into())
        }
        fn set(&mut self, s: &str, k: &str, v: &Variant) -> Result<(), String> {
            self.writes += 1;
            if self.fail_write == Some(self.writes) {
                return Err("simulated settings failure".into());
            }
            self.values.insert((s.into(), k.into()), v.clone());
            Ok(())
        }
        fn shortcuts(&self) -> Result<Vec<(String, String)>, String> {
            Ok(self.occupied.clone())
        }
    }
    #[test]
    fn saves_a_real_desktop_command_and_rejects_conflicts_without_writes() {
        let mut settings = Memory::new();
        let binding = Binding::for_platform("linux");
        settings
            .occupied
            .push(("Other launcher".into(), "<Mod4>Z".into()));
        assert!(
            configure(&mut settings, &binding, "'/apps/zega' --global-shortcut")
                .unwrap_err()
                .contains("Other launcher")
        );
        assert_eq!(settings.writes, 0);
        settings.occupied.clear();
        configure(&mut settings, &binding, "'/apps/zega' --global-shortcut").unwrap();
        assert_eq!(
            strings(settings.get(MEDIA, "custom-keybindings").unwrap()).unwrap(),
            [OWN]
        );
        let schema = format!("{CUSTOM}:{OWN}");
        assert_eq!(
            string(settings.get(&schema, "command").unwrap()).unwrap(),
            "'/apps/zega' --global-shortcut"
        );
        assert_eq!(
            string(settings.get(&schema, "binding").unwrap()).unwrap(),
            "<Super>z"
        );
        let snapshot = settings.values.clone();
        assert!(configure(&mut settings, &binding, "'/another/app' --global-shortcut").is_err());
        assert_eq!(snapshot, settings.values);
    }
    #[test]
    fn restores_own_entry_when_saving_fails() {
        let mut settings = Memory::new();
        let snapshot = settings.values.clone();
        settings.fail_write = Some(2);
        assert!(configure(
            &mut settings,
            &Binding::for_platform("linux"),
            "zega --global-shortcut"
        )
        .is_err());
        assert_eq!(settings.values, snapshot);
    }
    #[test]
    fn preserves_other_custom_shortcuts() {
        let mut settings = Memory::new();
        let other = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
        settings.values.insert(
            (MEDIA.into(), "custom-keybindings".into()),
            vec![other].to_variant(),
        );
        settings.values.insert(
            (format!("{CUSTOM}:{other}"), "name".into()),
            "Other".to_variant(),
        );
        settings.values.insert(
            (format!("{CUSTOM}:{other}"), "binding".into()),
            "<Super>z".to_variant(),
        );
        let snapshot = settings.values.clone();
        assert!(configure(
            &mut settings,
            &Binding::for_platform("linux"),
            "zega --global-shortcut"
        )
        .unwrap_err()
        .contains("Other"));
        assert_eq!(settings.values, snapshot);
        assert_eq!(settings.writes, 0);
        settings.values.insert(
            (format!("{CUSTOM}:{other}"), "binding".into()),
            "<Super>x".to_variant(),
        );
        configure(
            &mut settings,
            &Binding::for_platform("linux"),
            "zega --global-shortcut",
        )
        .unwrap();
        assert_eq!(
            strings(settings.get(MEDIA, "custom-keybindings").unwrap()).unwrap(),
            [other, OWN]
        );
        assert_eq!(
            string(
                settings
                    .get(&format!("{CUSTOM}:{other}"), "binding")
                    .unwrap()
            )
            .unwrap(),
            "<Super>x"
        );
    }
}
