//! Read colour data only; Omarchy theme scripts are never executed.
use serde::{Deserialize, Deserializer, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Color(String);

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.len() != 7
            || !value.starts_with('#')
            || !value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err(serde::de::Error::custom("expected a six-digit hex colour"));
        }
        Ok(Self(value.to_ascii_lowercase()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    mode: Mode,
    background: Color,
    foreground: Color,
    muted: Color,
    border: Color,
    tint: Color,
    accent: Color,
    accent_foreground: Color,
    selection: Color,
    selection_foreground: Color,
    link: Color,
}

#[cfg(any(target_os = "linux", test))]
mod source {
    use super::*;
    use std::{fs::File, io::Read, path::Path};

    #[derive(Deserialize)]
    struct RawPalette {
        mode: Option<Mode>,
        background: Color,
        foreground: Color,
        accent: Option<Color>,
        selection: Option<Color>,
        muted: Option<Color>,
        light_foreground: Option<Color>,
        dark_background: Option<Color>,
        blue: Option<Color>,
    }

    fn luminance(color: &Color) -> f64 {
        [0.2126, 0.7152, 0.0722]
            .iter()
            .enumerate()
            .map(|(index, weight)| {
                let value = u8::from_str_radix(&color.0[1 + index * 2..3 + index * 2], 16).unwrap()
                    as f64
                    / 255.0;
                weight
                    * if value <= 0.04045 {
                        value / 12.92
                    } else {
                        ((value + 0.055) / 1.055).powf(2.4)
                    }
            })
            .sum()
    }

    fn contrast(a: &Color, b: &Color) -> f64 {
        let (a, b) = (luminance(a), luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    fn readable(background: &Color, preferred: &Color) -> Color {
        if contrast(background, preferred) >= 4.5 {
            return preferred.clone();
        }
        let black = Color("#000000".into());
        let white = Color("#ffffff".into());
        if contrast(background, &black) > contrast(background, &white) {
            black
        } else {
            white
        }
    }

    pub(super) fn parse(text: &str) -> Option<Palette> {
        let raw: RawPalette = toml::from_str(text).ok()?;
        let foreground = readable(&raw.background, &raw.foreground);
        let accent = raw.accent.unwrap_or_else(|| foreground.clone());
        let selection = raw.selection.unwrap_or_else(|| accent.clone());
        let muted = raw
            .light_foreground
            .or(raw.muted)
            .filter(|value| contrast(&raw.background, value) >= 4.5)
            .unwrap_or_else(|| foreground.clone());
        Some(Palette {
            mode: raw.mode.unwrap_or(if luminance(&raw.background) > 0.5 {
                Mode::Light
            } else {
                Mode::Dark
            }),
            tint: raw
                .dark_background
                .unwrap_or_else(|| raw.background.clone()),
            border: selection.clone(),
            muted,
            accent_foreground: readable(&accent, &raw.background),
            selection_foreground: readable(&selection, &foreground),
            link: readable(&raw.background, &raw.blue.unwrap_or_else(|| accent.clone())),
            background: raw.background,
            foreground,
            accent,
            selection,
        })
    }

    pub(super) fn read(path: &Path) -> Option<Palette> {
        // Bound both allocation and parsing even for a malformed custom theme.
        let mut text = String::new();
        File::open(path)
            .ok()?
            .take(32_769)
            .read_to_string(&mut text)
            .ok()?;
        if text.len() > 32_768 {
            return None;
        }
        parse(&text)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn preserves_theme_backgrounds_and_readable_selection() {
            for (fixture, background) in [
                (
                    include_str!("../../tests/fixtures/themes/brown.toml"),
                    "#282828",
                ),
                (
                    include_str!("../../tests/fixtures/themes/purple.toml"),
                    "#221b30",
                ),
                (
                    include_str!("../../tests/fixtures/themes/light.toml"),
                    "#fafafa",
                ),
            ] {
                let palette = parse(fixture).unwrap();
                assert_eq!(palette.background.0, background);
                assert!(contrast(&palette.background, &palette.foreground) >= 4.5);
                assert!(contrast(&palette.accent, &palette.accent_foreground) >= 4.5);
                assert!(contrast(&palette.selection, &palette.selection_foreground) >= 4.5);
            }
        }
        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "reads installed Omarchy colour palettes and exports validated test data"]
        fn installed_omarchy_palettes_are_valid_and_readable() {
            let mut palettes = std::collections::BTreeMap::new();
            for entry in std::fs::read_dir("/usr/share/omarchy/themes").unwrap() {
                let entry = entry.unwrap();
                let path = entry.path().join("colors.toml");
                if !path.is_file() {
                    continue;
                }
                let palette =
                    read(&path).unwrap_or_else(|| panic!("invalid palette {}", path.display()));
                assert!(contrast(&palette.background, &palette.foreground) >= 4.5);
                assert!(contrast(&palette.accent, &palette.accent_foreground) >= 4.5);
                palettes.insert(entry.file_name().to_string_lossy().into_owned(), palette);
            }
            assert!(!palettes.is_empty());
            let path = std::env::temp_dir().join("installed-omarchy-palettes.json");
            std::fs::write(path, serde_json::to_vec(&palettes).unwrap()).unwrap();
            println!("validated {} installed palettes", palettes.len());
        }
        #[test]
        fn reads_only_bounded_palette_files_and_handles_missing_files() {
            let path =
                std::env::temp_dir().join(format!("zega-theme-size-{}.toml", std::process::id()));
            std::fs::write(
                &path,
                include_str!("../../tests/fixtures/themes/brown.toml"),
            )
            .unwrap();
            assert_eq!(read(&path).unwrap().background.0, "#282828");
            std::fs::write(&path, "x".repeat(32_769)).unwrap();
            assert!(read(&path).is_none());
            std::fs::remove_file(&path).unwrap();
            assert!(read(&path).is_none());
        }
        #[test]
        fn rejects_code_invalid_colours_and_missing_required_values() {
            assert!(
                parse("background = 'url(https://example.invalid)'\nforeground = '#ffffff'")
                    .is_none()
            );
            assert!(parse("background = '#ffffff'\nforeground = '#gggggg'").is_none());
            assert!(parse("mode = 'dark'").is_none());
            assert!(parse("background = '#ffffff'\nforeground = '#000000'").is_some());
            assert!(
                parse("background = '#ffffff'\nforeground = '#000000'\nmode = 'unknown'").is_none()
            );
        }
    }
}

pub struct AppearanceState(Arc<Mutex<Option<Palette>>>);

#[tauri::command]
pub fn native_theme(state: State<'_, AppearanceState>) -> Result<Option<Palette>, String> {
    state
        .0
        .lock()
        .map(|palette| palette.clone())
        .map_err(|error| error.to_string())
}

pub fn initialize(app: &AppHandle) {
    let palette = Arc::new(Mutex::new(None));
    app.manage(AppearanceState(palette.clone()));
    #[cfg(target_os = "linux")]
    {
        use tauri::Emitter;
        if !std::path::Path::new("/usr/share/omarchy").is_dir() {
            return;
        }
        // Match omarchy-theme-set's HOME-relative state location.
        let Ok(home) = app.path().home_dir() else {
            return;
        };
        let root = home.join(".local/state/omarchy/current");
        if let Ok(mut value) = palette.lock() {
            *value = source::read(&root.join("theme/colors.toml"));
        }
        let handle = app.clone();
        match watching::start(root, move |next| {
            if let Ok(mut value) = palette.lock() {
                *value = next.clone();
            }
            let _ = handle.emit("native-theme-changed", next);
        }) {
            Ok(watcher) => {
                app.manage(Mutex::new(Some(watcher)));
            }
            Err(error) => eprintln!("Could not watch the Omarchy palette: {error}"),
        }
    }
}

pub fn shutdown(_app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if let Some(state) = _app.try_state::<Mutex<Option<watching::ThemeWatch>>>() {
        if let Ok(mut watcher) = state.lock() {
            drop(watcher.take());
        }
    }
}

#[cfg(target_os = "linux")]
mod watching {
    use super::{source, Palette};
    use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    pub(super) struct ThemeWatch {
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }
    impl Drop for ThemeWatch {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    pub(super) fn start(
        root: PathBuf,
        changed: impl Fn(Option<Palette>) + Send + 'static,
    ) -> Result<ThemeWatch, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let (tx, rx) = mpsc::channel();
            let theme = root.join("theme");
            let file = theme.join("colors.toml");
            let relevant_file = file.clone();
            let result = (|| {
                let mut watcher = RecommendedWatcher::new(
                    move |event: notify::Result<Event>| {
                        if let Ok(event) = event {
                            if !matches!(event.kind, EventKind::Access(_))
                                && event
                                    .paths
                                    .iter()
                                    .any(|path| path == &theme || path == &relevant_file)
                            {
                                let _ = tx.send(());
                            }
                        }
                    },
                    Config::default().with_follow_symlinks(false),
                )
                .map_err(|e| e.to_string())?;
                // Omarchy replaces the theme directory. Watching its stable parent
                // also catches the replacement and subsequent edits to the new file.
                watcher
                    .watch(&root, RecursiveMode::Recursive)
                    .map_err(|e| e.to_string())?;
                Ok::<_, String>(watcher)
            })();
            let watcher = match result {
                Ok(watcher) => {
                    let _ = ready_tx.send(Ok(()));
                    watcher
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let mut previous = source::read(&file);
            changed(previous.clone());
            while !stopped.load(Ordering::Relaxed) {
                if rx.recv_timeout(Duration::from_millis(250)).is_err() {
                    continue;
                }
                let started = Instant::now();
                while started.elapsed() < Duration::from_millis(400)
                    && rx.recv_timeout(Duration::from_millis(80)).is_ok()
                {}
                let next = source::read(&file);
                if next != previous {
                    changed(next.clone());
                    previous = next;
                }
            }
            drop(watcher);
        });
        match ready_rx.recv().map_err(|e| e.to_string())? {
            Ok(()) => Ok(ThemeWatch {
                stop,
                worker: Some(worker),
            }),
            Err(error) => {
                let _ = worker.join();
                Err(error)
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs;
        #[test]
        fn follows_directory_replacement_edits_and_invalid_palette_recovery() {
            let root =
                std::env::temp_dir().join(format!("zega-theme-watch-{}", std::process::id()));
            fs::create_dir_all(root.join("theme")).unwrap();
            let file = root.join("theme/colors.toml");
            fs::write(
                &file,
                include_str!("../../tests/fixtures/themes/brown.toml"),
            )
            .unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = start(root.clone(), move |palette| {
                tx.send(palette).unwrap();
            })
            .unwrap();
            let initial = rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
            assert_eq!(initial.background.0, "#282828");
            fs::create_dir(root.join("next-theme")).unwrap();
            fs::write(
                root.join("next-theme/colors.toml"),
                include_str!("../../tests/fixtures/themes/purple.toml"),
            )
            .unwrap();
            fs::rename(root.join("theme"), root.join("old-theme")).unwrap();
            fs::rename(root.join("next-theme"), root.join("theme")).unwrap();
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap()
                    .background
                    .0,
                "#221b30"
            );
            fs::write(&file, "not a palette").unwrap();
            assert!(rx.recv_timeout(Duration::from_secs(3)).unwrap().is_none());
            fs::write(
                &file,
                include_str!("../../tests/fixtures/themes/light.toml"),
            )
            .unwrap();
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap()
                    .mode,
                super::super::Mode::Light
            );
            fs::remove_file(&file).unwrap();
            assert!(rx.recv_timeout(Duration::from_secs(3)).unwrap().is_none());
            drop(watcher);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
