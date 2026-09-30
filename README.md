# zega desktop

The zega app for your computer: **your computer as a graph**. Files, photos
and settings, searched from a floating search box (⌥Space on macOS, Ctrl+Alt+Space on
Windows, Super+Z on Linux, all configurable) or the menu bar, with every other zega graph one click away on the
rail. Built with [Tauri](https://tauri.app) on macOS, Windows and Linux.

- **Local first.** The computer graph is built and stored on this machine and
  never leaves it. Indexing runs on the embedded
  [zega](https://github.com/zegadb/zega) engine.
- **Download:** [zega.earth/download](https://zega.earth/download). On Linux,
  see [zega.earth/download/linux](https://zega.earth/download/linux) for apt,
  pacman and AppImage.

## Build from source

You need Node 24 or newer, Rust 1.96 (see `rust-toolchain.toml`) and
[Tauri's system prerequisites](https://tauri.app/start/prerequisites/) for
your platform.

```sh
npm ci
npm run tauri dev        # run the app with hot reload
npm run tauri build      # build a local bundle
```

`npm run build:desktop` creates the static export the app loads.

## Test

```sh
npm run check                                              # TypeScript
npm run test:desktop                                       # the exported shell
cargo test --locked --manifest-path src-tauri/Cargo.toml   # native side and the index
```

More in `docs/`: [the index](docs/index.md), [shortcuts](docs/shortcuts/README.md),
[appearance](docs/appearance.md) and [developing on Windows](docs/windows-development.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities
privately, as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Bundled data and fonts keep their own licences: see
[NOTICE](NOTICE).
