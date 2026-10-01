'use client';
import { useEffect, useRef, useState } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BuilderRail from './BuilderRail';
import DekaPreview, { type PreviewStatus } from './DekaPreview';
import SketchPreview from './SketchPreview';
import DesktopStage, { defaultDesktop, type DesktopTheme } from './DesktopStage';
import TerminalPane, { type TerminalCommand } from './TerminalPane';
import { IDEA_EVENT, PENDING_IDEA } from './IdeaRouter';
import { openUsage, type AskEvent, type ChatGptView, type Model } from '../lib/chatgpt';
import { DEKA_APP_INSTRUCTIONS, DEKA_EDIT_INSTRUCTIONS, agentsFile, appRequest, editRequest, extractSource, fixRequest } from '../lib/deka/guide';
import { applySourceOp, jsonObjects, parseSourceOp } from '../lib/deka/edit';
import { compileError } from '../lib/deka/runtime';
import { compileSketch } from '../lib/sketch/compile';
import { SKETCH_EDIT_INSTRUCTIONS, SKETCH_INSTRUCTIONS, extractSketch, realRequest, sketchEditRequest, sketchRequest } from '../lib/sketch/guide';
import { problemsLabel, runtimeLabel } from '../lib/deka/plain';
import { formatMs, formatTokens, reportTiming, useLastTiming, type Tokens } from '../lib/timing';
import { HARNESSES, WINDOW_SIZES, readStartup, type Harness } from '../lib/builder-startup';
import { newAppId } from '../lib/app-name';

type Mode = 'full' | 'rixse';
// How a version was made: written whole, edited by rixse ops, or rixse asking
// for a rewrite because the change rebuilt most of the app.
type Made = { how: 'full' } | { how: 'rixse'; ops: number; missed: number } | { how: 'escalated' } | { how: 'outside' };
// fixes: compile errors the model repaired on its own; error: one it couldn't.
// sketch: the Markdown sketch a sketch version was made from (source is then
// the DekaScript compiled from it).
type Version = { n: number; ask: string; source: string; sketch?: string; basedOn: number | null; ms: number; tokens: Tokens | null; made: Made; fixes: number; error: string | null };
// "thinking" until the first word of the answer arrives (reasoning models can
// think for minutes), then "writing"; "fixing" while a compile error is repaired.
type Building = { ask: string; basedOn: number | null; mode: Mode | 'fix'; ops: number; started: number; writing: boolean };
type Done = Extract<AskEvent, { kind: 'completed' }>;

const MAX_FIXES = 2;

const madeLabel = (made: Made) => made.how === 'outside' ? 'edited in the folder' : made.how === 'full' ? 'rewrite'
  : made.how === 'escalated' ? 'rixse → rewrite'
  : `rixse · ${made.ops} ${made.ops === 1 ? 'op' : 'ops'}${made.missed ? ` (${made.missed} missed)` : ''}`;

const elapsed = (started: number) => {
  const seconds = Math.floor((performance.now() - started) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const addTokens = (a: Tokens | null, b: Tokens | null): Tokens | null => !a ? b : !b ? a
  : { input: a.input + b.input, cached_input: a.cached_input + b.cached_input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning };

const EXAMPLES = [
  'A focus timer: 25 minute sessions, start/pause/reset, a count of sessions done today',
  'A habit tracker with five daily habits I can tick off, and a streak for each',
  'A tip calculator for splitting a restaurant bill between friends',
];

const PREVIEW_EVERY_MS = 400;

// The app's window sizes; the model designs for the chosen one.
const SIZES = WINDOW_SIZES;
const DESKTOPS: { id: DesktopTheme; label: string }[] = [{ id: 'macos', label: 'macOS' }, { id: 'windows', label: 'Windows' }, { id: 'omarchy', label: 'Omarchy' }];

export default function Builder() {
  const [view, setView] = useState<ChatGptView | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [building, setBuilding] = useState<Building | null>(null);
  const [preview, setPreview] = useState('');
  // While a sketch round streams, `preview` holds Markdown, not DekaScript.
  const [previewIsSketch, setPreviewIsSketch] = useState(false);
  const [ask, setAsk] = useState('');
  const [mode, setMode] = useState<Mode>('rixse');
  // What a new idea starts as: a quick sketch, or a full app.
  const [kind, setKind] = useState<'sketch' | 'app'>('sketch');
  const [, setTick] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const lastTiming = useLastTiming();
  const [desktop, setDesktop] = useState<DesktopTheme>('macos');
  const [size, setSize] = useState<readonly [number, number]>(SIZES[1]);
  const custom = !SIZES.some(s => s[0] === size[0] && s[1] === size[1]);
  const [appName, setAppName] = useState('');
  // Startup choices from Settings: side panel, desktop and window size.
  useEffect(() => {
    const startup = readStartup();
    setDesktop(startup.desktop === 'auto' ? defaultDesktop() : startup.desktop);
    setSize(SIZES.find(s => s.join('x') === startup.size) ?? SIZES[1]);
    setSide(startup.side);
    setHarness(startup.harness);
  }, []);
  // The app's folder on disk (~/Documents/Zega Apps/<name>), what the builder
  // last wrote there, and the terminal that opens in it.
  const [projectPath, setProjectPath] = useState<string | null>(null);
  // The app's id (excited-strawberry-x83k): its folder, and its name until
  // one is typed. `created` is false until the folder exists.
  const app = useRef<{ id: string; created: boolean }>({ id: '', created: false });
  const written = useRef<{ source: string; modified: number | null } | null>(null);
  // Chat and terminal are one side at a time: opening the terminal hides the
  // chat, closing it brings the chat back; ⌘K shows the chat and closes the
  // terminal (or hides the chat for a full-width desktop).
  const [side, setSide] = useState<'chat' | 'terminal' | 'none'>('chat');
  const terminalOpen = side === 'terminal';
  const setTerminalOpen = (open: boolean | ((open: boolean) => boolean)) =>
    setSide(current => (typeof open === 'function' ? open(current === 'terminal') : open) ? 'terminal' : 'chat');
  const [terminalCommand, setTerminalCommand] = useState<TerminalCommand | null>(null);
  const [harness, setHarness] = useState<Harness>('codex');
  const chatOpen = side === 'chat';
  // ⌘J toggles the terminal, ⌘K the chat (Ctrl on Windows and Linux). Caught
  // before the terminal sees the keys, so they work while typing in a shell.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc stops a build in progress (the terminal keeps Esc otherwise).
      if (event.key === 'Escape' && buildingRef.current && !(event.target as HTMLElement | null)?.closest?.('.terminal-slide')) { event.preventDefault(); stopRef.current(); return; }
      const mod = /Mac/.test(navigator.userAgent) ? event.metaKey : event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); event.stopPropagation(); setTerminalCommand(null); setTerminalOpen(open => !open); }
      if (key === 'k') { event.preventDefault(); event.stopPropagation(); setSide(current => current === 'chat' ? 'none' : 'chat'); }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  // One prompt-cache key per session: its requests share an opening.
  const session = useRef(`zega-builder-${crypto.randomUUID()}`);
  const lastDraw = useRef(0);
  const log = useRef<HTMLDivElement>(null);
  const signedIn = view?.status === 'signed_in';

  const refresh = () => { void invoke<ChatGptView>('chatgpt_status').then(setView).catch(reason => setFailure(String(reason))); };
  useEffect(() => {
    if (!isTauri()) return;
    refresh();
    const stop = listen('chatgpt-changed', refresh);
    return () => { void stop.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    invoke<Model[]>('chatgpt_models')
      .then(list => { setModels(list); setModel(current => list.some(m => m.slug === current) ? current : list[0]?.slug ?? ''); })
      .catch(reason => setFailure(String(reason)));
  }, [signedIn]);
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => setTick(tick => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [building !== null]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [versions.length, building?.ask, building?.mode]);

  const current = versions.find(v => v.n === shown) ?? null;

  // The shown version is what's on disk, so the terminal edits what you see.
  useEffect(() => {
    if (!current || building || !isTauri()) return;
    if (written.current?.source === current.source && app.current.created) return;
    const save = async (): Promise<void> => {
      if (!app.current.id) app.current = { id: newAppId(), created: false };
      try {
        const file = await invoke<{ path: string; modified_ms: number | null }>('project_save', {
          folder: app.current.id, name: appName || app.current.id, source: current.source,
          width: size[0], height: size[1], agents: agentsFile(appName || app.current.id), create: !app.current.created, sketch: current.sketch ?? null,
        });
        app.current.created = true;
        written.current = { source: current.source, modified: file.modified_ms };
        setProjectPath(file.path);
      } catch (reason) {
        if (String(reason) !== 'folder-taken') { setFailure(String(reason)); return; }
        app.current = { id: newAppId(), created: false };
        return save();
      }
    };
    void save();
  }, [current?.n, current?.source, building, appName, size]);

  // Every version is recorded in the app's .zega/ history (chat entry +
  // source), so History can show and reopen every iteration of every idea.
  const recorded = useRef(new Set<number>());
  useEffect(() => {
    if (!projectPath || !isTauri()) return;
    for (const v of versions) {
      if (recorded.current.has(v.n)) continue;
      recorded.current.add(v.n);
      const { source, ...entry } = v;
      void invoke('project_record', { path: projectPath, name: appName || app.current.id, entry: { ...entry, at: Date.now() }, source })
        .catch(reason => { recorded.current.delete(v.n); setFailure(String(reason)); });
    }
  }, [versions, projectPath, appName]);

  // Opened from History (/?app=<folder>): restore the app with every version.
  useEffect(() => {
    const path = new URLSearchParams(location.search).get('app');
    if (!path || !isTauri()) return;
    void invoke<{ id: string; name?: string; versions: Version[] }>('project_history', { path }).then(saved => {
      if (!saved.versions.length) return;
      const restored = saved.versions.map(v => ({ ...v, basedOn: v.basedOn ?? null, fixes: v.fixes ?? 0, error: v.error ?? null }));
      const last = restored[restored.length - 1];
      app.current = { id: saved.id, created: true };
      recorded.current = new Set(restored.map(v => v.n));
      written.current = { source: last.source, modified: null };
      if (saved.name && saved.name !== saved.id) setAppName(saved.name);
      setVersions(restored);
      setShown(last.n);
      setProjectPath(path);
      window.history.replaceState(null, '', '/');
    }).catch(reason => setFailure(String(reason)));
  }, []);

  // Edits made in the folder (Codex in the terminal, an editor) become versions.
  const versionsRef = useRef(versions);
  versionsRef.current = versions;
  useEffect(() => {
    if (!projectPath || building) return;
    const timer = setInterval(() => {
      void invoke<{ source: string | null; modified_ms: number | null }>('project_read', { path: projectPath }).then(async file => {
        const known = written.current;
        if (!file.source || !known || file.source === known.source || file.modified_ms === known.modified) return;
        written.current = { source: file.source, modified: file.modified_ms };
        const source = file.source;
        const error = await compileError(source);
        const list = versionsRef.current;
        const n = list.length + 1;
        setVersions([...list, { n, ask: 'Edited in the app folder', source, basedOn: list.find(v => v.n === shown)?.n ?? null, ms: 0, tokens: null, made: { how: 'outside' }, fixes: 0, error }]);
        setShown(n);
      }).catch(() => {});
    }, 800);
    return () => clearInterval(timer);
  }, [projectPath, building, shown]);

  // The real native window (`deka dev`, run by the app in the background), with
  // fast refresh: every version the builder saves shows up there too.
  const [running, setRunning] = useState(false);
  // What the preview reports for the app on screen, and a counter that
  // recompiles and restarts it.
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>({ kind: 'ok' });
  const [reload, setReload] = useState(0);
  // Refresh: pick up the folder's app.dsx right now (an agent's fix in the
  // terminal), then recompile and restart whatever is shown.
  const refreshApp = async () => {
    if (projectPath && isTauri()) {
      try {
        const file = await invoke<{ source: string | null; modified_ms: number | null }>('project_read', { path: projectPath });
        const known = written.current;
        if (file.source && known && file.source !== known.source) {
          written.current = { source: file.source, modified: file.modified_ms };
          const source = file.source;
          const error = await compileError(source);
          const list = versionsRef.current;
          const n = list.length + 1;
          setVersions([...list, { n, ask: 'Edited in the app folder', source, basedOn: shown, ms: 0, tokens: null, made: { how: 'outside' }, fixes: 0, error }]);
          setShown(n);
        }
      } catch (reason) { setFailure(String(reason)); }
    }
    setReload(r => r + 1);
  };
  const statusText = previewStatus.kind === 'compile' ? `${problemsLabel(previewStatus.error)} · Can't open yet`
    : previewStatus.kind === 'runtime' ? 'Stopped working' : null;
  // Not on the bar for now: Sami has another place in mind for it.
  const runOnDesktop = () => {
    if (!projectPath) return;
    void invoke('project_run', { path: projectPath }).then(() => { setRunning(true); setFailure(null); }).catch(reason => setFailure(String(reason)));
  };


  const fixInTerminal = (error: string) => {
    const prompt = `The deka app in app.dsx fails to compile in the zega preview with: ${error}. Read AGENTS.md for the runtime's limits, then fix app.dsx.`;
    const fix = HARNESSES[harness].fix?.(prompt);
    if (fix) setTerminalCommand({ ...fix, id: Date.now() });
    setTerminalOpen(true);
  };

  // While building, the preview shows the source as it streams in; a source
  // that doesn't compile yet leaves the last working app on screen.
  const shownSource = building ? preview || current?.source || '' : current?.source ?? '';

  // Stop: every request in flight resolves as stopped at once (the UI frees
  // up immediately), and the stream itself is cut at its next chunk.
  const stopped = useRef(false);
  const stopWaiters = useRef(new Set<() => void>());
  const stop = () => {
    stopped.current = true;
    void invoke('chatgpt_stop').catch(() => {});
    stopWaiters.current.forEach(wake => wake());
    stopWaiters.current.clear();
  };

  // One request to ChatGPT; resolves with its completion, or null when it
  // failed or was stopped.
  const request = async (question: string, instructions: string, onText: (text: string) => void): Promise<Done | null> => {
    if (stopped.current) return null;
    let done: Done | null = null;
    const channel = new Channel<AskEvent>();
    channel.onmessage = event => {
      if (stopped.current) return;
      if (event.kind === 'delta') { setBuilding(state => state && !state.writing ? { ...state, writing: true } : state); onText(event.text); }
      else if (event.kind === 'failed') { if (event.code !== 'stopped') setFailure(event.message); }
      else done = event;
    };
    const halted = new Promise<'stopped'>(resolve => { stopWaiters.current.add(() => resolve('stopped')); });
    try {
      const result = await Promise.race([invoke('chatgpt_ask', { question, model, instructions, cacheKey: session.current, onEvent: channel }), halted]);
      if (result === 'stopped' || stopped.current) return null;
    } catch (reason) { if (!stopped.current) setFailure(String(reason)); return null; }
    return done;
  };

  // The whole app, written by the model.
  const fullPass = async (ask: string, base: string | null) => {
    let answer = '';
    lastDraw.current = 0;
    const windowSize = `The app window is ${size[0]}×${size[1]}; lay it out for that size.`;
    const question = base ? `Current source (app.dsx):\n\n${base}\n\nRewrite the app with this change: ${ask}\n\n${windowSize}` : `${appRequest(ask)}\n\n${windowSize}`;
    const done = await request(question, DEKA_APP_INSTRUCTIONS, text => {
      answer += text;
      const now = performance.now();
      if (now - lastDraw.current > PREVIEW_EVERY_MS) { lastDraw.current = now; setPreview(extractSource(answer)); }
    });
    return done && { source: extractSource(answer), done };
  };

  // rixse: the whole source goes in, replace ops come back and are applied to
  // the source as they arrive, so the running app changes in place.
  // `show` turns the edited text into what the preview runs (a sketch compiles
  // to DekaScript first).
  const rixsePass = async (question: string, base: string, instructions = DEKA_EDIT_INSTRUCTIONS, show = (text: string) => text) => {
    let source = base;
    let buffer = '';
    let ops = 0, missed = 0, full = false;
    lastDraw.current = 0;
    setPreview(show(base));
    const done = await request(question, instructions, text => {
      const taken = jsonObjects(buffer + text);
      buffer = taken.rest;
      for (const raw of taken.objects) {
        const op = parseSourceOp(raw);
        if (!op) continue;
        if (op.op === 'full') { full = true; continue; }
        ops += 1;
        const next = applySourceOp(source, op);
        if (next === null) missed += 1; else source = next;
      }
      setBuilding(state => state && { ...state, ops });
      const now = performance.now();
      if (now - lastDraw.current > PREVIEW_EVERY_MS) { lastDraw.current = now; setPreview(show(source)); }
    });
    return done && { source, done, ops, missed, full };
  };

  // A sketch round: the model writes or edits sketch.md; the app compiles it
  // to DekaScript (it always compiles) and runs it. Streams into the preview.
  const sketchPass = async (ask: string, base: Version | null) => {
    setPreviewIsSketch(true);
    if (base?.sketch) {
      const edited = await rixsePass(sketchEditRequest(ask, base.sketch), base.sketch, SKETCH_EDIT_INSTRUCTIONS);
      if (edited && !edited.full) return { sketch: edited.source, done: edited.done, made: { how: 'rixse', ops: edited.ops, missed: edited.missed } as Made };
      if (!edited) return null;
    }
    let answer = '';
    lastDraw.current = 0;
    const question = base?.sketch ? `Current sketch (sketch.md):\n\n${base.sketch}\n\nRewrite the sketch with this change: ${ask}` : sketchRequest(ask);
    const done = await request(question, SKETCH_INSTRUCTIONS, text => {
      answer += text;
      const now = performance.now();
      // Only whole lines while streaming: a half-written line would show as
      // one kind of block, then morph into another a moment later.
      if (now - lastDraw.current > PREVIEW_EVERY_MS) { lastDraw.current = now; setPreview(extractSketch(answer.slice(0, answer.lastIndexOf('\n') + 1))); }
    });
    return done && { sketch: extractSketch(answer), done, made: { how: 'full' } as Made };
  };

  // fresh: a new app from nothing, ignoring the version on screen.
  const build = async (text: string, fresh = false) => {
    const ask = text.trim();
    if (!ask || !model || building) return;
    stopped.current = false;
    const base = fresh ? null : current;
    // No base means a new app: a fresh id and folder, and its own version list
    // (the previous app stays in History).
    if (!base) { app.current = { id: newAppId(), created: false }; written.current = null; recorded.current = new Set(); setProjectPath(null); setVersions([]); }
    const n = base ? versions.length + 1 : 1;
    const how: Mode = base ? mode : 'full';
    setAsk(''); setFailure(null); setPreview(''); setPreviewIsSketch(false);
    setBuilding({ ask, basedOn: base?.n ?? null, mode: how, ops: 0, started: performance.now(), writing: false });
    try {
      // Sketch versions stay sketches; a new app follows the Sketch/App switch.
      if (base ? !!base.sketch : kind === 'sketch') {
        const sketched = await sketchPass(ask, base);
        if (!sketched || stopped.current) return;
        // A sketch runs as HTML and can't fail to open. Its DekaScript
        // translation is kept as Make it real's working starting point.
        const compiled = compileSketch(sketched.sketch);
        const error = null;
        setVersions(list => [...list, { n, ask, basedOn: base?.n ?? null, source: compiled.source, sketch: sketched.sketch, ms: sketched.done.elapsed_ms, tokens: sketched.done.tokens, made: sketched.made, fixes: 0, error }]);
        setShown(n);
        if (!appName && compiled.name !== 'Untitled app') setAppName(compiled.name);
        reportTiming({ label: 'Sketched', ms: sketched.done.elapsed_ms, tokens: sketched.done.tokens });
        return;
      }
      let made: Omit<Version, 'n' | 'ask' | 'basedOn' | 'fixes' | 'error'> | null = null;
      if (how === 'rixse' && base) {
        const edited = await rixsePass(editRequest(ask, base.source), base.source);
        if (edited?.full) {
          setBuilding(state => state && { ...state, mode: 'full', writing: false });
          const rewritten = await fullPass(ask, base.source);
          if (rewritten) made = { source: rewritten.source, ms: edited.done.elapsed_ms + rewritten.done.elapsed_ms, tokens: addTokens(edited.done.tokens, rewritten.done.tokens), made: { how: 'escalated' } };
        } else if (edited) {
          made = { source: edited.source, ms: edited.done.elapsed_ms, tokens: edited.done.tokens, made: { how: 'rixse', ops: edited.ops, missed: edited.missed } };
        }
      } else {
        const written = await fullPass(ask, base?.source ?? null);
        if (written) made = { source: written.source, ms: written.done.elapsed_ms, tokens: written.done.tokens, made: { how: 'full' } };
      }
      if (!made) return;
      // The compiler's errors go back to the model as rixse fixes.
      let { source, ms, tokens } = made;
      let fixes = 0;
      let error = await compileError(source);
      while (error && fixes < MAX_FIXES && !stopped.current) {
        setBuilding(state => state && { ...state, mode: 'fix', ops: 0, writing: false });
        const fixed = await rixsePass(fixRequest(error, source), source);
        if (!fixed) break;
        source = fixed.source; ms += fixed.done.elapsed_ms; tokens = addTokens(tokens, fixed.done.tokens); fixes += 1;
        error = await compileError(source);
      }
      if (stopped.current) return;
      setVersions(list => [...list, { n, ask, basedOn: base?.n ?? null, ...made, source, ms, tokens, fixes, error }]);
      setShown(n);
      reportTiming({ label: made.made.how === 'rixse' ? 'Edited' : 'Built', ms, tokens });
    } finally {
      setBuilding(null);
    }
  };

  // "Make it real": the sketch is the spec for a full DekaScript app, built the
  // normal way (including the compile-error fixes).
  const makeItReal = async () => {
    const base = current;
    if (!base?.sketch || !model || building) return;
    stopped.current = false;
    const n = versions.length + 1;
    const ask = 'Make it real';
    setFailure(null); setPreview(''); setPreviewIsSketch(false);
    setBuilding({ ask, basedOn: base.n, mode: 'full', ops: 0, started: performance.now(), writing: false });
    try {
      let answer = '';
      lastDraw.current = 0;
      const done = await request(`${realRequest(base.sketch, base.source)}\n\nThe app window is ${size[0]}×${size[1]}; lay it out for that size.`, DEKA_APP_INSTRUCTIONS, text => {
        answer += text;
        const now = performance.now();
        if (now - lastDraw.current > PREVIEW_EVERY_MS) { lastDraw.current = now; setPreview(extractSource(answer)); }
      });
      if (!done || stopped.current) return;
      let source = extractSource(answer), ms = done.elapsed_ms, tokens = done.tokens, fixes = 0;
      let error = await compileError(source);
      while (error && fixes < MAX_FIXES && !stopped.current) {
        setBuilding(state => state && { ...state, mode: 'fix', ops: 0, writing: false });
        const fixed = await rixsePass(fixRequest(error, source), source);
        if (!fixed) break;
        source = fixed.source; ms += fixed.done.elapsed_ms; tokens = addTokens(tokens, fixed.done.tokens); fixes += 1;
        error = await compileError(source);
      }
      setVersions(list => [...list, { n, ask, basedOn: base.n, source, ms, tokens, made: { how: 'full' }, fixes, error }]);
      setShown(n);
      reportTiming({ label: 'Built', ms, tokens });
    } finally {
      setBuilding(null);
    }
  };

  // An idea from the floating prompt: start a fresh app with it as soon as
  // ChatGPT and a model are ready (on launch or while the builder is open).
  const [pendingIdea, setPendingIdea] = useState<string | null>(null);
  useEffect(() => {
    const take = () => {
      try {
        const idea = sessionStorage.getItem(PENDING_IDEA);
        if (idea) { sessionStorage.removeItem(PENDING_IDEA); setPendingIdea(idea); }
      } catch { /* storage unavailable */ }
    };
    take();
    addEventListener(IDEA_EVENT, take);
    return () => removeEventListener(IDEA_EVENT, take);
  }, []);
  const buildRef = useRef(build);
  buildRef.current = build;
  useEffect(() => {
    if (!pendingIdea || !model || building) return;
    const idea = pendingIdea;
    setPendingIdea(null);
    setSide(current => current === 'none' ? 'chat' : current);
    // A new idea is a new app: build from nothing, not on top of the shown version.
    void buildRef.current(idea, true);
  }, [pendingIdea, model, building]);

  // "Fix it for me": the same rixse repair the automatic fixes use, run on
  // the version on screen, landing as a new version.
  const repair = async (error: string) => {
    const base = current;
    // Sketches run as HTML and never fail to compile; nothing to repair.
    if (!base || base.sketch || !model || building) return;
    stopped.current = false;
    const n = versions.length + 1;
    setFailure(null);
    setBuilding({ ask: 'Fix the problems', basedOn: base.n, mode: 'fix', ops: 0, started: performance.now(), writing: false });
    try {
      let source = base.source, ms = 0, fixes = 0;
      let tokens: Tokens | null = null;
      let left: string | null = error;
      while (left && fixes < MAX_FIXES + 1 && !stopped.current) {
        const fixed = await rixsePass(fixRequest(left, source), source);
        if (!fixed) break;
        source = fixed.source; ms += fixed.done.elapsed_ms; tokens = addTokens(tokens, fixed.done.tokens); fixes += 1;
        left = await compileError(source);
      }
      if (stopped.current) return;
      setVersions(list => [...list, { n, ask: 'Fix the problems', basedOn: base.n, source, ms, tokens, made: { how: 'rixse', ops: fixes, missed: 0 }, fixes, error: left }]);
      setShown(n);
    } finally {
      setBuilding(null);
    }
  };

  const buildingRef = useRef(building);
  buildingRef.current = building;
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const status = (b: Building) => b.mode === 'fix' ? `Fixing a compile error in v${versions.length + 1} · ${elapsed(b.started)}${b.writing ? ` · ${b.ops} ${b.ops === 1 ? 'op' : 'ops'}` : ''}…`
    : `${b.mode === 'rixse' ? 'Editing' : 'Building'} v${versions.length + 1}${b.basedOn ? ` from v${b.basedOn}` : ''} · ${elapsed(b.started)} · ${b.writing ? (b.mode === 'rixse' ? `${b.ops} ${b.ops === 1 ? 'op' : 'ops'}` : 'writing') : 'thinking'}…`;

  const chat = !view ? null : !signedIn ? <div className="bchat-empty">
    <h2>Build with your ChatGPT plan</h2>
    <p>Describe an app and zega builds it here, as a real deka desktop app. Requests run on your own ChatGPT plan; only what you type is sent.</p>
    {view.status === 'pending'
      ? <p role="status">Finish signing in in your browser. <button type="button" className="chatgpt-link" onClick={() => void invoke<ChatGptView>('chatgpt_cancel').then(setView)}>Cancel</button></p>
      : <button type="button" className="chatgpt-continue" onClick={() => void invoke<ChatGptView>('chatgpt_start').then(setView).catch(reason => setFailure(String(reason)))}>Continue with ChatGPT</button>}
  </div> : <>
    <div className="bchat-log" ref={log}>
      {!versions.length && !building && <div className="bchat-empty">
        <h2>What app should we build?</h2>
        <p>Describe a desktop app. It runs right here as you build it, and each answer becomes a version you can go back to.</p>
        <div className="bchat-examples">{EXAMPLES.map(example => <button key={example} type="button" onClick={() => void build(example)}>{example}</button>)}</div>
      </div>}
      {versions.map(v => <div key={v.n} className="bmsg">
        <p className="bmsg-ask">{v.ask}</p>
        <button type="button" className="bmsg-done" aria-pressed={shown === v.n} onClick={() => setShown(v.n)}>
          <b>v{v.n}</b>{v.basedOn ? ` from v${v.basedOn}` : ''} · {v.sketch ? (v.basedOn ? `sketch · ${madeLabel(v.made)}` : 'sketch') : v.basedOn ? madeLabel(v.made) : 'first build'} · {formatMs(v.ms)}{v.tokens ? ` · ${formatTokens(v.tokens)}` : ''}{v.fixes ? ` · fixed ${v.fixes} ${v.fixes === 1 ? 'problem' : 'problems'}` : ''}
        </button>
        {v.sketch && <details className="bmsg-sketch"><summary>View the sketch</summary><pre>{v.sketch}</pre></details>}
        {v.error && <div className="bmsg-error" role="alert">
          <p>This version has {problemsLabel(v.error)} that couldn't be fixed automatically, so it can't open yet.</p>
          <div className="bmsg-error-actions">
            <button type="button" className="primary" disabled={!!building || shown !== v.n} onClick={() => void repair(v.error!)}>Fix it for me</button>
            {harness !== 'shell' && <button type="button" onClick={() => fixInTerminal(v.error!)}>Fix with {HARNESSES[harness].label}</button>}
          </div>
          <details><summary>Show details</summary><pre>{v.error}</pre></details>
        </div>}
      </div>)}
      {building && <div className="bmsg">
        <p className="bmsg-ask">{building.ask}</p>
        <p className="bmsg-done" role="status">{status(building)}</p>
      </div>}
      {failure && <p className="bmsg-fail" role="alert">{failure}</p>}
    </div>
    <form className="composer" onSubmit={event => { event.preventDefault(); void build(ask); }}>
      <textarea aria-label="Describe the app" rows={2} value={ask} onChange={event => setAsk(event.target.value)}
        placeholder={current ? `Change v${current.n}…` : kind === 'sketch' ? 'Sketch an app idea…' : 'Describe an app…'}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void build(ask); } }} />
      <div className="composer-bar">
        <label className="composer-model">
          <span className="sr-only">Model</span>
          <select value={model} onChange={event => setModel(event.target.value)} disabled={!models.length}>
            {models.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
          </select>
        </label>
        {!current && <span className="composer-mode" role="group" aria-label="Start as">
          {(['sketch', 'app'] as const).map(k => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} title={k === 'sketch' ? 'A quick, clickable sketch in seconds' : 'A full app straight away'}>{k === 'sketch' ? 'Sketch' : 'App'}</button>)}
        </span>}
        {current?.sketch && <button type="button" className="composer-real" disabled={!!building} onClick={() => void makeItReal()} title="Build a full app from this sketch">Make it real</button>}
        {current && !current.sketch && <span className="composer-mode" role="group" aria-label="How changes are made">
          {(['rixse', 'full'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} title={m === 'rixse' ? 'Edit the app in place' : 'Rewrite the whole app'}>{m === 'rixse' ? 'Edit' : 'Rewrite'}</button>)}
        </span>}
        {building && <span className="composer-timer" aria-live="off">{elapsed(building.started)}</span>}
        {building ? <button type="button" className="composer-send composer-stop" onClick={stop} aria-label="Stop" title="Stop (Esc)">
          <span className="composer-spin" aria-hidden="true" /><i aria-hidden="true" />
        </button> : <button type="submit" className="composer-send" disabled={!ask.trim() || !model} aria-label="Build" title="Build (Enter)">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
        </button>}
      </div>
    </form>
    <p className="composer-foot">
      <span>Using ChatGPT plan · <button type="button" className="chatgpt-link" onClick={openUsage}>Usage</button></span>
      {lastTiming && <span>{lastTiming.label} in {formatMs(lastTiming.ms)}{lastTiming.tokens ? ` · ${formatTokens(lastTiming.tokens)}` : ''}</span>}
    </p>
  </>;

  return <div className="builder" data-chat={chatOpen ? 'shown' : 'hidden'}>
    <BuilderRail current="build" />
    <section className="bchat" aria-label="Chat">{chat}</section>
    <nav className="bversions" aria-label="Versions">
      {versions.map(v => <button key={v.n} type="button" aria-pressed={!building && shown === v.n} onClick={() => setShown(v.n)} title={v.ask}>v{v.n}</button>)}
      {building && <span className="bversions-live" role="status" aria-label={`Building v${versions.length + 1}`}>v{versions.length + 1}</span>}
    </nav>
    <section className="bpreview" aria-label="App">
      <div className="bapp-bar">
        <input aria-label="App name" placeholder={app.current.id || 'App name'} value={appName} onChange={event => setAppName(event.target.value)} />
        <select aria-label="Window size" value={size.join('x')} onChange={event => setSize(SIZES.find(s => s.join('x') === event.target.value) ?? SIZES[1])}>
          {custom && <option value={size.join('x')}>Custom · {size[0]} × {size[1]}</option>}
          {SIZES.map(s => <option key={s.join('x')} value={s.join('x')}>{s[0]} × {s[1]}</option>)}
        </select>
        <span className="bmode" role="group" aria-label="Desktop">
          {DESKTOPS.map(d => <button key={d.id} type="button" aria-pressed={desktop === d.id} onClick={() => setDesktop(d.id)}>{d.label}</button>)}
        </span>
      </div>
      <div className="bstage">
      <DesktopStage theme={desktop} name={appName || app.current.id} width={size[0]} height={size[1]} onResize={(w, h) => setSize([w, h])} footer={shownSource ? <>
        {statusText && previewStatus.kind !== 'ok' && <button type="button" className="win-status" title={previewStatus.kind === 'runtime' ? runtimeLabel(previewStatus.error) : 'Click to fix it'} onClick={() => void repair(previewStatus.error)}>{statusText}</button>}
        <button type="button" className="win-refresh" aria-label="Refresh the app" title="Reload app.dsx from the folder and restart the app" onClick={() => void refreshApp()}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></svg>
        </button>
      </> : null}>
        {zoom => (building ? previewIsSketch && !!preview : !!current?.sketch)
          ? <SketchPreview sketch={building ? preview : current!.sketch!} width={size[0]} height={size[1]} zoom={zoom} reload={reload}
              onStatus={status => setPreviewStatus(status.kind === 'ok' ? { kind: 'ok' } : { kind: 'runtime', error: status.error })} />
          : shownSource
          ? <DekaPreview source={shownSource} width={size[0]} height={size[1]} zoom={zoom} reload={reload} onStatus={setPreviewStatus}
              notOpened={<div className="not-opened">
                <b>Almost there</b>
                <p>This version has a few mistakes, so it can't open yet. They're usually quick to fix.</p>
                <button type="button" disabled={!!building} onClick={() => previewStatus.kind === 'compile' && void repair(previewStatus.error)}>{building ? 'Fixing…' : 'Fix it for me'}</button>
              </div>} />
          : <p className="bpreview-empty">{building ? (building.writing ? 'Writing…' : 'Thinking…') : 'Your app runs here.'}</p>}
      </DesktopStage>
      <TerminalPane path={projectPath} open={terminalOpen} command={terminalCommand} start={HARNESSES[harness].start} onHide={() => setTerminalOpen(false)} />
      </div>
    </section>
  </div>;
}
