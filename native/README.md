# Native DekaScript launcher experiment

This is an isolated consumer of the experimental Deka VM. The production
Next.js/Tauri application is unchanged. `launcher.dsx` owns the markup, query,
keyboard selection, selected-row styles and event handlers. Rust owns the index,
native input editing, OS menus/shortcut/window, and scene drawing. No React,
JavaScript or WebView executes in this application.

`deka.json` contains packaging metadata and the native host's shortcut, menu,
index directory and indexed roots. The checked-in demo uses Control–Option–Z
and a separate index so the existing application's Option–Space and data remain
available. Its index directory is an explicit local demo path; change it and the
roots before running on another machine. The first scan may take time. Only the
configured roots are indexed.

## Architecture

- Native input supports selection, clipboard editing, Unicode grapheme movement
  and GPUI's input-method interface (adapted from its Apache-licensed example).
- Input events invoke VM closures. `search()` queues work and returns immediately;
  a worker calls the existing `computer-index` crate. Result delivery wakes GPUI
  through a channel. Older query generations cannot overwrite current results.
- The worker owns index startup and OS-open operations too; they do not block the
  UI thread. The existing index service owns filesystem watching/reconciliation.
- DekaScript maps stable result keys to DSX buttons and styles. Arrow keys change
  selection; Enter opens the selected index key; Escape hides the app. The
  menu-bar icon and configured shortcut toggle the window. Menus include Search
  and Quit. The window remains available in the background.
- Body/results use the existing shared Deka scene renderer. The editable input
  uses a GPUI text-input adapter over the input rectangle from that same scene.
  System light/dark changes update the DekaScript view and text editor.
- The app renders on changes. There is no timer polling the VM or hotkey receiver.
  Index scanning retains the existing backend's scheduling behavior.

This prototype shows at most six results. Rows have fixed heights and clip long
labels. It does not implement the full Zega application, account features,
shortcut setup UI, accessibility for the complete canvas, login launch, or Linux
and Windows desktop adapters. macOS is the current launch/packaging target.
The configuration schema and VM component protocol remain experimental.

The component protocol returns named callbacks (`view`, `opened`, `results`)
from its entry function. Native events call DSX handler closures with scalar
arguments. Background results are event-driven; this adapter does not yet expose
`await search()` inside UI handlers. Dynamic frames are reconstructed on events,
not dependency-indexed updates. Input editing and result selection are separate:
Rust owns caret/selection/composition, while DekaScript owns the query and result
selection. The compiler is a build-time feature and can be omitted from the app.

## Build and try it

From the desktop repository root on macOS, with Rust 1.96 and Xcode tools:

```sh
mkdir -p .tmp .target
chmod 700 .tmp
export CARGO_TARGET_DIR="$PWD/.target" TMPDIR="$PWD/.tmp"
cargo build --locked --release --manifest-path native/Cargo.toml --features compiler
.target/release/zega-native --compile native/deka.json .tmp/launcher.dvm.json
cargo build --locked --release --manifest-path native/Cargo.toml
.target/release/zega-native --config native/deka.json --program .tmp/launcher.dvm.json
```

Adjust the explicit paths in `deka.json` first. Close this instance from its menu
before starting another one; the index directory has an exclusive instance lock.

Use the Deka experiment's `dvm-package` tool to make a local app bundle:

```sh
dvm-package native/deka.json .target/release/zega-native --out .tmp/native-package --bytecode .tmp/launcher.dvm.json
open ".tmp/native-package/bundle/macos/Zega Native Search.app"
```

This is local ad-hoc signing, not a notarized distribution. The `.app` contains
one executable plus bytecode, icon and configuration resources. The compiler,
Tauri bundler, JavaScript engine and WebView are not shipped.

## Tests

```sh
cargo test --locked --release --manifest-path native/Cargo.toml --features compiler --test launcher
.target/release/zega-native --config native/deka.json --program .tmp/launcher.dvm.json --smoke launcher
```

The test creates a real fixture index, compiles this exact DSX, verifies input,
rendered result content, stale response rejection, keyboard selection, open-key
resolution, Escape and Unicode input. It does not open user files. The native
smoke mode types through GPUI's actual input interface and requires matching
worker results and native hit targets before exiting successfully. It needs a
macOS GUI session and a matching configured root; it is not a headless CI test.
The CI workflow runs the fixture integration test on macOS. Physical hotkey,
menu interaction, full IME behavior and accessibility still need manual QA.

## Local measurement (Intel macOS, 2026-09-30)

The compiler-free release executable measured 7,943,248 bytes (7.58 MiB); all
bundle files totalled 7,966,351 bytes (7.60 MiB), including 9,438 bytes of VM
bytecode. `codesign --verify --strict` passed for the local ad-hoc bundle.

With the window visible after initial indexing of the configured application
folders and this native source folder, `vmmap -summary` reported **33.6M physical
footprint** (also the peak at that sample). `ps` reported **49,324 KiB RSS** and
0.0% CPU at the sample. These are different macOS memory measures. This is a
small-root launcher measurement, not a matched full-production Zega comparison
or a sustained CPU benchmark. Index files and caches are separate from bundle
size.

The native smoke log recorded `input="launcher", rows=3, rendered targets=4`.
A deliberately nonexistent query timed out with exit status 1; the matching
query exited successfully. The original proposed Control–Option–Space was
rejected as a reserved macOS shortcut; Control–Option–Z registered successfully.

-codex
