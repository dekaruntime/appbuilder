# Desktop appearance

On Omarchy, zega follows the active palette in
`~/.local/state/omarchy/current/theme/colors.toml`. This is the location used by
the installed `omarchy-theme-set` command. Main, search, and shortcut setup share
the same palette; switching themes updates open windows without restarting.
The search surface keeps its existing translucency and square Omarchy corners.

The native reader accepts only six-digit hex colours, limits the input to 32 KiB,
and never runs theme scripts. It preserves the background and accent, choosing
readable text when a supplied foreground has insufficient contrast. A missing
or invalid palette falls back to the usual system light/dark appearance and
recovers when a valid palette returns.

An explicit `data-theme="light"` or `data-theme="dark"` overrides the native
palette. This reuses cqx desktop's appearance contract; this change adds no new
preference controls. Other platforms keep their existing appearance.

## Checks

- `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`: parser,
  contrast, bounded reads, and (Linux) replacing the whole theme directory,
  editing its replacement, invalid-file fallback, and recovery.
- `npm run test:desktop:theme`: headless checks of all three routes, live updates,
  explicit overrides, fallback, translucency, and console errors.
- On Omarchy, run the ignored native
  `installed_omarchy_palettes_are_valid_and_readable` test to export validated
  installed palettes into the configured temporary directory. Pass that JSON
  path to `npm run test:desktop:theme -- <path>` to check every installed palette
  on every route, including the computed surface colour.

The watcher observes the stable parent because Omarchy replaces the active
theme directory. Regression evidence must include replacing the directory;
editing one existing file alone does not exercise that failure.
