'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BuilderRail from './BuilderRail';
import { BUILDER_INSTRUCTIONS, EMPTY_DOCUMENT, buildRequest, extractHtml, withPreviewBridge } from '../lib/builder';
import { openUsage, type AskEvent, type ChatGptView, type Model } from '../lib/chatgpt';
import { RIXSE_INSTRUCTIONS, applyOp, collapseBulk, editRequest, expandOp, parseDocument, parseOp, serialize, takeLines } from '../lib/rixse-edit';
import { formatMs, formatTokens, reportTiming, type Tokens } from '../lib/timing';

type Mode = 'full' | 'rixse';
// How a version was made: a full rewrite, rixse edit ops, or rixse asking
// for a full rewrite because the change rebuilt most of the page.
type Made = { how: 'full' } | { how: 'rixse'; ops: number; missed: number } | { how: 'escalated'; reason: string };
type Version = { n: number; ask: string; html: string; basedOn: number | null; ms: number; tokens: Tokens | null; made: Made };
type Building = { ask: string; basedOn: number | null; mode: Mode; ops: number };
type Done = Extract<AskEvent, { kind: 'completed' }>;

const madeLabel = (made: Made) => made.how === 'full' ? 'full rewrite'
  : made.how === 'escalated' ? 'rixse → full rewrite'
  : `rixse · ${made.ops} ${made.ops === 1 ? 'op' : 'ops'}${made.missed ? ` (${made.missed} missed)` : ''}`;

const addTokens = (a: Tokens | null, b: Tokens | null): Tokens | null => !a ? b : !b ? a
  : { input: a.input + b.input, cached_input: a.cached_input + b.cached_input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning };

const EXAMPLES = [
  'A booking page for a barber shop in Lisbon: services with prices, opening hours, a book button',
  'A pricing page for a developer tool with three tiers, monthly and yearly',
  'A one-page menu for a ramen bar, dark, with a short story about the chef',
];

// How often the preview redraws while an answer streams in. Every delta
// would reload the frame dozens of times a second.
const PREVIEW_EVERY_MS = 600;

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
  const [failure, setFailure] = useState<string | null>(null);
  const answer = useRef('');
  // One prompt-cache key per design session: its requests share an opening
  // (the rules, then the design), which ChatGPT can serve from cache.
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
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [versions.length, building?.ask]);

  const current = versions.find(v => v.n === shown) ?? null;
  // The frame loads a document once per version (or once per build, from
  // the version it starts from); streamed updates are posted into the live
  // page instead of reloading it, which would jump back to the top.
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameScroll = useRef(0);
  const buildBase = building ? versions.find(v => v.n === building.basedOn) ?? null : null;
  const frameKey = building ? `build-from-${building.basedOn ?? 'nothing'}` : `v${current?.n ?? 'none'}`;
  const frameDoc = useMemo(() => {
    const html = building ? buildBase?.html ?? EMPTY_DOCUMENT : current?.html ?? '';
    return html ? withPreviewBridge(html, frameScroll.current) : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === frameRef.current?.contentWindow && typeof event.data?.zegaScroll === 'number') frameScroll.current = event.data.zegaScroll;
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    if (building && preview) frameRef.current?.contentWindow?.postMessage({ zegaHtml: preview }, '*');
  }, [building, preview]);

  // One request to ChatGPT; resolves with its completion, or null when it failed.
  const request = async (question: string, instructions: string, onText: (text: string) => void): Promise<Done | null> => {
    let done: Done | null = null;
    const channel = new Channel<AskEvent>();
    channel.onmessage = event => {
      if (event.kind === 'delta') onText(event.text);
      else if (event.kind === 'failed') setFailure(event.message);
      else done = event;
    };
    try { await invoke('chatgpt_ask', { question, model, instructions, cacheKey: session.current, onEvent: channel }); }
    catch (reason) { setFailure(String(reason)); return null; }
    return done;
  };

  const fullPass = async (ask: string, base: Version | null) => {
    answer.current = '';
    lastDraw.current = 0;
    setPreview(base?.html ?? '');
    const done = await request(buildRequest(ask, base?.html ?? null), BUILDER_INSTRUCTIONS, text => {
      answer.current += text;
      const now = performance.now();
      if (now - lastDraw.current > PREVIEW_EVERY_MS) { lastDraw.current = now; setPreview(extractHtml(answer.current)); }
    });
    return done && { html: extractHtml(answer.current), done };
  };

  // rixse: the whole current document goes in, edit ops come back one per
  // line and are applied to the page as they arrive.
  const rixsePass = async (ask: string, base: Version) => {
    const doc = parseDocument(base.html);
    const collapsed = collapseBulk(base.html);
    let buffer = '';
    let ops = 0;
    let missed = 0;
    let full: string | null = null;
    lastDraw.current = 0;
    setPreview(base.html);
    const apply = (lines: string[]) => {
      for (const line of lines) {
        const op = parseOp(line);
        if (!op) continue;
        if (op.op === 'full') { full = op.reason; continue; }
        ops += 1;
        if (!applyOp(doc, expandOp(op, collapsed.bulk))) missed += 1;
      }
      setBuilding(state => state && { ...state, ops });
    };
    const done = await request(editRequest(ask, collapsed.text), RIXSE_INSTRUCTIONS, text => {
      const taken = takeLines(buffer + text);
      buffer = taken.rest;
      if (!taken.lines.length) return;
      apply(taken.lines);
      const now = performance.now();
      if (now - lastDraw.current > PREVIEW_EVERY_MS / 2) { lastDraw.current = now; setPreview(serialize(doc)); }
    });
    if (!done) return null;
    apply(takeLines(`${buffer}\n`).lines);
    return { html: serialize(doc), done, ops, missed, full: full as string | null };
  };

  const build = async (text: string) => {
    const ask = text.trim();
    if (!ask || !model || building) return;
    const base = current;
    const n = versions.length + 1;
    const how: Mode = base ? mode : 'full';
    setAsk(''); setFailure(null);
    setBuilding({ ask, basedOn: base?.n ?? null, mode: how, ops: 0 });
    try {
      let version: Omit<Version, 'n' | 'ask' | 'basedOn'> | null = null;
      if (how === 'rixse' && base) {
        const edited = await rixsePass(ask, base);
        if (edited?.full) {
          setBuilding(state => state && { ...state, mode: 'full' });
          const rewritten = await fullPass(ask, base);
          if (rewritten) version = { html: rewritten.html, ms: edited.done.elapsed_ms + rewritten.done.elapsed_ms, tokens: addTokens(edited.done.tokens, rewritten.done.tokens), made: { how: 'escalated', reason: edited.full } };
        } else if (edited) {
          version = { html: edited.html, ms: edited.done.elapsed_ms, tokens: edited.done.tokens, made: { how: 'rixse', ops: edited.ops, missed: edited.missed } };
        }
      } else {
        const written = await fullPass(ask, base);
        if (written) version = { html: written.html, ms: written.done.elapsed_ms, tokens: written.done.tokens, made: { how: 'full' } };
      }
      if (version) {
        const made = version;
        setVersions(list => [...list, { n, ask, basedOn: base?.n ?? null, ...made }]);
        setShown(n);
        reportTiming({ label: made.made.how === 'rixse' ? 'Edited' : 'Built', ms: made.ms, tokens: made.tokens });
      }
    } finally {
      setBuilding(null);
    }
  };

  const chat = !view ? null : !signedIn ? <div className="bchat-empty">
    <h2>Build with your ChatGPT plan</h2>
    <p>Describe a page and zega designs it here. Requests run on your own ChatGPT plan; only what you type is sent.</p>
    {view.status === 'pending'
      ? <p role="status">Finish signing in in your browser. <button type="button" className="chatgpt-link" onClick={() => void invoke<ChatGptView>('chatgpt_cancel').then(setView)}>Cancel</button></p>
      : <button type="button" className="chatgpt-continue" onClick={() => void invoke<ChatGptView>('chatgpt_start').then(setView).catch(reason => setFailure(String(reason)))}>Continue with ChatGPT</button>}
  </div> : <>
    <div className="bchat-log" ref={log}>
      {!versions.length && !building && <div className="bchat-empty">
        <h2>What should we build?</h2>
        <p>Describe a page. Each answer becomes a version you can go back to.</p>
        <div className="bchat-examples">{EXAMPLES.map(example => <button key={example} type="button" onClick={() => void build(example)}>{example}</button>)}</div>
      </div>}
      {versions.map(v => <div key={v.n} className="bmsg">
        <p className="bmsg-ask">{v.ask}</p>
        <button type="button" className="bmsg-done" aria-pressed={shown === v.n} onClick={() => setShown(v.n)}>
          <b>v{v.n}</b>{v.basedOn ? ` from v${v.basedOn}` : ''} · {madeLabel(v.made)} · {formatMs(v.ms)}{v.tokens ? ` · ${formatTokens(v.tokens)}` : ''}
        </button>
      </div>)}
      {building && <div className="bmsg">
        <p className="bmsg-ask">{building.ask}</p>
        <p className="bmsg-done" role="status">{building.mode === 'rixse' ? 'Editing' : 'Building'} v{versions.length + 1}{building.basedOn ? ` from v${building.basedOn}` : ''}{building.mode === 'rixse' ? ` with rixse · ${building.ops} ${building.ops === 1 ? 'op' : 'ops'}` : ''}…</p>
      </div>}
      {failure && <p className="bmsg-fail" role="alert">{failure}</p>}
    </div>
    <form className="bchat-compose" onSubmit={event => { event.preventDefault(); void build(ask); }}>
      <textarea aria-label="Describe the design" rows={3} value={ask} onChange={event => setAsk(event.target.value)}
        placeholder={current ? `Change v${current.n}…` : 'Describe a page…'}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void build(ask); } }} />
      <div className="bchat-row">
        <select aria-label="Model" value={model} onChange={event => setModel(event.target.value)} disabled={!models.length}>
          {models.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
        </select>
        {current && <span className="bmode" role="group" aria-label="How changes are made">
          {(['rixse', 'full'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} title={m === 'rixse' ? 'Edit the page in place' : 'Rewrite the whole page'}>{m === 'rixse' ? 'rixse edit' : 'Full rewrite'}</button>)}
        </span>}
        <small>Using ChatGPT plan · <button type="button" className="chatgpt-link" onClick={openUsage}>Usage</button></small>
        <button type="submit" className="bchat-go" disabled={!!building || !ask.trim() || !model}>{building ? 'Building…' : 'Build'}</button>
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
    <section className="bpreview" aria-label="Design">
      {frameDoc && (building ? preview || buildBase : current)
        ? <iframe ref={frameRef} title={building ? 'Design in progress' : `Design v${current?.n}`} sandbox="allow-scripts" srcDoc={frameDoc} />
        : <p className="bpreview-empty">{building ? 'Starting…' : 'Your design appears here.'}</p>}
    </section>
  </div>;
}
