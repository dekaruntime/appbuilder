// How the builder opens, chosen in Settings. Stored in this app's own web
// storage: a per-computer preference, read once when the builder mounts.
export type StartupSide = 'chat' | 'terminal' | 'none';
export type StartupDesktop = 'auto' | 'macos' | 'windows' | 'omarchy';
export type Harness = 'codex' | 'claude' | 'kimi' | 'shell';
export type Startup = { side: StartupSide; desktop: StartupDesktop; size: string; harness: Harness };

// The agent the terminal offers: typed at the prompt of each new session, and
// what "Fix with …" starts. Kimi has no interactive starting prompt, so its
// fix starts the CLI and types the request once it is up.
export const HARNESSES: Record<Harness, { label: string; start: string; fix: ((prompt: string) => { line: string; then?: string }) | null }> = {
  codex: { label: 'Codex', start: 'codex', fix: prompt => ({ line: `codex ${quote(prompt)}` }) },
  claude: { label: 'Claude Code', start: 'claude', fix: prompt => ({ line: `claude ${quote(prompt)}` }) },
  kimi: { label: 'Kimi', start: 'kimi', fix: prompt => ({ line: 'kimi', then: prompt }) },
  shell: { label: 'None (plain shell)', start: '', fix: null },
};

function quote(text: string) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export const WINDOW_SIZES = [[800, 600], [1024, 700], [1280, 800], [420, 640]] as const;
const KEY = 'zega.builder.startup';
export const DEFAULT_STARTUP: Startup = { side: 'chat', desktop: 'auto', size: '1024x700', harness: 'codex' };

export function readStartup(): Startup {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return { ...DEFAULT_STARTUP, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch { return DEFAULT_STARTUP; }
}

export function saveStartup(startup: Startup) {
  try { localStorage.setItem(KEY, JSON.stringify(startup)); } catch { /* storage unavailable: defaults apply */ }
}
