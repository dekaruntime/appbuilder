use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub key: String,
    pub alt: bool,
    pub control: bool,
    pub shift: bool,
    pub super_key: bool,
}

impl Default for Binding {
    fn default() -> Self {
        Self::for_platform(std::env::consts::OS)
    }
}

impl Binding {
    pub fn for_platform(platform: &str) -> Self {
        let mut defaults: std::collections::HashMap<String, Self> =
            serde_json::from_str(include_str!("../../src/lib/launcher-shortcut.json"))
                .expect("the bundled launcher shortcuts are valid");
        defaults
            .remove(platform)
            .unwrap_or_else(|| defaults.remove("macos").unwrap())
    }
    pub fn validate(&self) -> Result<(), String> {
        if !(self.alt || self.control || self.super_key) {
            return Err("Include Alt/Option, Control, or Super/Command.".into());
        }
        self.mac_key_code().map(|_| ())
    }

    pub fn accelerator(&self) -> String {
        let mut parts = Vec::new();
        if self.control {
            parts.push("Control");
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.shift {
            parts.push("Shift");
        }
        if self.super_key {
            parts.push("Super");
        }
        parts.push(&self.key);
        parts.join("+")
    }

    pub fn label(&self) -> String {
        let label = self.accelerator().replace("Key", "");
        if cfg!(target_os = "macos") {
            label
                .replace("Control+", "⌃")
                .replace("Alt+", "⌥")
                .replace("Shift+", "⇧")
                .replace("Super+", "⌘")
        } else {
            label
        }
    }

    pub fn mac_key_code(&self) -> Result<u32, String> {
        // Physical key codes, matching KeyboardEvent.code and Tauri's Code enum.
        let code = match self.key.as_str() {
            "Space" => 49,
            "KeyA" => 0,
            "KeyB" => 11,
            "KeyC" => 8,
            "KeyD" => 2,
            "KeyE" => 14,
            "KeyF" => 3,
            "KeyG" => 5,
            "KeyH" => 4,
            "KeyI" => 34,
            "KeyJ" => 38,
            "KeyK" => 40,
            "KeyL" => 37,
            "KeyM" => 46,
            "KeyN" => 45,
            "KeyO" => 31,
            "KeyP" => 35,
            "KeyQ" => 12,
            "KeyR" => 15,
            "KeyS" => 1,
            "KeyT" => 17,
            "KeyU" => 32,
            "KeyV" => 9,
            "KeyW" => 13,
            "KeyX" => 7,
            "KeyY" => 16,
            "KeyZ" => 6,
            "F1" => 122,
            "F2" => 120,
            "F3" => 99,
            "F4" => 118,
            "F5" => 96,
            "F6" => 97,
            "F7" => 98,
            "F8" => 100,
            "F9" => 101,
            "F10" => 109,
            "F11" => 103,
            "F12" => 111,
            _ => return Err("Choose Space, a letter, or F1–F12.".into()),
        };
        Ok(code)
    }

    #[cfg(target_os = "macos")]
    pub fn mac_modifiers(&self) -> u32 {
        (u32::from(self.super_key) << 8)
            | (u32::from(self.shift) << 9)
            | (u32::from(self.alt) << 11)
            | (u32::from(self.control) << 12)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_and_custom_binding_use_the_same_validated_configuration() {
        let mut binding = Binding::for_platform("macos");
        assert_eq!(binding.accelerator(), "Alt+Space");
        assert_eq!(binding.mac_key_code(), Ok(49));
        binding.control = true;
        binding.key = "KeyK".into();
        assert_eq!(binding.accelerator(), "Control+Alt+KeyK");
        assert!(binding.validate().is_ok());
        binding.key = "Enter".into();
        assert!(binding.validate().is_err());
        binding = Binding::for_platform("macos");
        binding.alt = false;
        assert!(binding.validate().is_err());
        let linux = Binding::for_platform("linux");
        assert_eq!(linux.accelerator(), "Super+KeyZ");
        assert!(linux.validate().is_ok());
    }
}
