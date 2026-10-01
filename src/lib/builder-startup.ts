// How the builder opens, chosen in Settings. Stored in this app's own web
// storage: a per-computer preference, read once when the builder mounts.
export type StartupSide = 'chat' | 'terminal' | 'none';
export type StartupDesktop = 'auto' | 'macos' | 'windows' | 'omarchy';
export type Startup = { side: StartupSide; desktop: StartupDesktop; size: string };

export const WINDOW_SIZES = [[800, 600], [1024, 700], [1280, 800], [420, 640]] as const;
const KEY = 'zega.builder.startup';
export const DEFAULT_STARTUP: Startup = { side: 'chat', desktop: 'auto', size: '1024x700' };

export function readStartup(): Startup {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return { ...DEFAULT_STARTUP, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch { return DEFAULT_STARTUP; }
}

export function saveStartup(startup: Startup) {
  try { localStorage.setItem(KEY, JSON.stringify(startup)); } catch { /* storage unavailable: defaults apply */ }
}
