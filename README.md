# zega desktop

The zega app for your computer (Tauri): **your computer as a graph** — files, photos and System Settings first — searched from a floating ⌥Space box or the menu bar, with every other zega graph (earth, hockey, …) one click away on the rail.

A hard fork of the desktop shell that started in zegadb/earth (#6 sign-in, #13 globe fix). The web (zega.earth) and the desktop now diverge; shared UI comes from zegadb/components.

- Design: zegadb/aps APS 31 (desktop) and APS 29 (search results and Search Transparency).
- Mock: landing, grouped results, floating search.
- Local first: the computer graph lives on this machine and never leaves it.

Agents: read `~/Projects/AGENTS.md` (bugsy) or `/Volumes/Projects/AGENTS.md` (iMac) first.

## Run the desktop shell

```sh
npm ci
npm run tauri dev
```

`npm run build:desktop` creates the static export loaded by Tauri. This first
scaffold includes the landing shell, screen previews, and desktop sign-in.
Spotlight-backed data and the native menu-bar/global shortcut arrive in follow-up PRs.
