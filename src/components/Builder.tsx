'use client';
import { useEffect, useRef, useState } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BuilderRail from './BuilderRail';
import DekaPreview from './DekaPreview';
import DesktopStage, { defaultDesktop, type DesktopTheme } from './DesktopStage';
import { openUsage, type AskEvent, type ChatGptView, type Model } from '../lib/chatgpt';
import { DEKA_APP_INSTRUCTIONS, DEKA_EDIT_INSTRUCTIONS, appRequest, editRequest, extractSource, fixRequest } from '../lib/deka/guide';
import { applySourceOp, jsonObjects, parseSourceOp } from '../lib/deka/edit';
import { compileError } from '../lib/deka/runtime';
import { formatMs, formatTokens, reportTiming, type Tokens } from '../lib/timing';

type Mode = 'full' | 'rixse';
// How a version was made: written whole, edited by rixse ops, or rixse asking
// for a rewrite because the change rebuilt most of the app.
type Made = { how: 'full' } | { how: 'rixse'; ops: number; missed: number } | { how: 'escalated' };
// fixes: compile errors the model repaired on its own; error: one it couldn't.
type Version = { n: number; ask: string; source: string; basedOn: number | null; ms: number; tokens: Tokens | null; made: Made; fixes: number; error: string | null };
// "thinking" until the first word of the answer arrives (reasoning models can
// think for minutes), then "writing"; "fixing" while a compile error is repaired.
type Building = { ask: string; basedOn: number | null; mode: Mode | 'fix'; ops: number; started: number; writing: boolean };
type Done = Extract<AskEvent, { kind: 'completed' }>;

const MAX_FIXES = 2;

const madeLabel = (made: Made) => made.how === 'full' ? 'rewrite'
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
const SIZES = [[800, 600], [1024, 700], [1280, 800], [420, 640]] as const;
const DESKTOPS: { id: DesktopTheme; label: string }[] = [{ id: 'macos', label: 'macOS' }, { id: 'windows', label: 'Windows' }, { id: 'omarchy', label: 'Omarchy' }];

export default function Builder() {
  const [view, setView] = useState<ChatGptView | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [building, setBuilding] = useState<Building | null>(null);
  const [preview, setPreview] = useState('');
  const [ask, setAsk] = useState('');
  const [mode, setMode] = useState<Mode>('rixse');
  const [, setTick] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<DesktopTheme>('macos');
  const [size, setSize] = useState<readonly [number, number]>(SIZES[1]);
  const [appName, setAppName] = useState('');
  useEffect(() => { setDesktop(defaultDesktop()); }, []);
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
  // While building, the preview shows the source as it streams in; a source
  // that doesn't compile yet leaves the last working app on screen.
  const shownSource = building ? preview || current?.source || '' : current?.source ?? '';

  // One request to ChatGPT; resolves with its completion, or null when it failed.
  const request = async (question: string, instructions: string, onText: (text: string) => void): Promise<Done | null> => {
    let done: Done | null = null;
    const channel = new Channel<AskEvent>();
    channel.onmessage = event => {
      if (event.kind === 'delta') { setBuilding(state => state && !state.writing ? { ...state, writing: true } : state); onText(event.text); }
      else if (event.kind === 'failed') setFailure(event.message);
      else done = event;
    };
    try { await invoke('chatgpt_ask', { question, model, instructions, cacheKey: session.current, onEvent: channel }); }
    catch (reason) { setFailure(String(reason)); return null; }
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
  const rixsePass = async (question: string, base: string) => {
    let source = base;
    let buffer = '';
    let ops = 0, missed = 0, full = false;
    lastDraw.current = 0;
    setPreview(base);
    const done = await request(question, DEKA_EDIT_INSTRUCTIONS, text => {
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
      if (now - lastDraw.current > PREVIEW_EVERY_MS) { lastDraw.current = now; setPreview(source); }
    });
    return done && { source, done, ops, missed, full };
  };

  const build = async (text: string) => {
    const ask = text.trim();
    if (!ask || !model || building) return;
    const base = current;
    const n = versions.length + 1;
    const how: Mode = base ? mode : 'full';
    setAsk(''); setFailure(null); setPreview('');
    setBuilding({ ask, basedOn: base?.n ?? null, mode: how, ops: 0, started: performance.now(), writing: false });
    try {
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
      while (error && fixes < MAX_FIXES) {
        setBuilding(state => state && { ...state, mode: 'fix', ops: 0, writing: false });
        const fixed = await rixsePass(fixRequest(error, source), source);
        if (!fixed) break;
        source = fixed.source; ms += fixed.done.elapsed_ms; tokens = addTokens(tokens, fixed.done.tokens); fixes += 1;
        error = await compileError(source);
      }
      setVersions(list => [...list, { n, ask, basedOn: base?.n ?? null, ...made, source, ms, tokens, fixes, error }]);
      setShown(n);
      reportTiming({ label: made.made.how === 'rixse' ? 'Edited' : 'Built', ms, tokens });
    } finally {
      setBuilding(null);
    }
  };

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
          <b>v{v.n}</b>{v.basedOn ? ` from v${v.basedOn}` : ''} · {v.basedOn ? madeLabel(v.made) : 'first build'} · {formatMs(v.ms)}{v.tokens ? ` · ${formatTokens(v.tokens)}` : ''}{v.fixes ? ` · fixed ${v.fixes} compile ${v.fixes === 1 ? 'error' : 'errors'}` : ''}
        </button>
        {v.error && <pre className="bmsg-error" role="alert">{v.error}</pre>}
      </div>)}
      {building && <div className="bmsg">
        <p className="bmsg-ask">{building.ask}</p>
        <p className="bmsg-done" role="status">{status(building)}</p>
      </div>}
      {failure && <p className="bmsg-fail" role="alert">{failure}</p>}
    </div>
    <form className="bchat-compose" onSubmit={event => { event.preventDefault(); void build(ask); }}>
      <textarea aria-label="Describe the app" rows={3} value={ask} onChange={event => setAsk(event.target.value)}
        placeholder={current ? `Change v${current.n}…` : 'Describe an app…'}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void build(ask); } }} />
      <div className="bchat-row">
        <select aria-label="Model" value={model} onChange={event => setModel(event.target.value)} disabled={!models.length}>
          {models.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
        </select>
        {current && <span className="bmode" role="group" aria-label="How changes are made">
          {(['rixse', 'full'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} title={m === 'rixse' ? 'Edit the app in place' : 'Rewrite the whole app'}>{m === 'rixse' ? 'rixse edit' : 'Full rewrite'}</button>)}
        </span>}
        <small>Using ChatGPT plan · <button type="button" className="chatgpt-link" onClick={openUsage}>Usage</button></small>
        <button type="submit" className="bchat-go" disabled={!!building || !ask.trim() || !model}>{building ? `Building ${elapsed(building.started)}` : 'Build'}</button>
      </div>
    </form>
  </>;

  return <div className="builder">
    <BuilderRail current="build" />
    <section className="bchat" aria-label="Chat">{chat}</section>
    <nav className="bversions" aria-label="Versions">
      {versions.map(v => <button key={v.n} type="button" aria-pressed={!building && shown === v.n} onClick={() => setShown(v.n)} title={v.ask}>v{v.n}</button>)}
      {building && <span className="bversions-live" role="status" aria-label={`Building v${versions.length + 1}`}>v{versions.length + 1}</span>}
    </nav>
    <section className="bpreview" aria-label="App">
      <div className="bapp-bar">
        <input aria-label="App name" placeholder="App name" value={appName} onChange={event => setAppName(event.target.value)} />
        <select aria-label="Window size" value={size.join('x')} onChange={event => setSize(SIZES.find(s => s.join('x') === event.target.value) ?? SIZES[1])}>
          {SIZES.map(s => <option key={s.join('x')} value={s.join('x')}>{s[0]} × {s[1]}</option>)}
        </select>
        <span className="bmode" role="group" aria-label="Desktop">
          {DESKTOPS.map(d => <button key={d.id} type="button" aria-pressed={desktop === d.id} onClick={() => setDesktop(d.id)}>{d.label}</button>)}
        </span>
      </div>
      <DesktopStage theme={desktop} name={appName} width={size[0]} height={size[1]}>
        {zoom => shownSource
          ? <DekaPreview source={shownSource} width={size[0]} height={size[1]} zoom={zoom} />
          : <p className="bpreview-empty">{building ? (building.writing ? 'Writing…' : 'Thinking…') : 'Your app runs here.'}</p>}
      </DesktopStage>
    </section>
  </div>;
}
