'use client';
import { useEffect, useRef, useState } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BuilderRail from './BuilderRail';
import { BUILDER_INSTRUCTIONS, buildRequest, extractHtml } from '../lib/builder';
import { openUsage, type AskEvent, type ChatGptView, type Model } from '../lib/chatgpt';
import { formatMs, reportTiming, type Tokens } from '../lib/timing';

type Version = { n: number; ask: string; html: string; basedOn: number | null; ms: number; tokens: Tokens | null };
type Building = { ask: string; basedOn: number | null; html: string };

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
  const [failure, setFailure] = useState<string | null>(null);
  const answer = useRef('');
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
  const frame = building ? preview : current?.html ?? '';

  const build = async (text: string) => {
    const request = text.trim();
    if (!request || !model || building) return;
    const base = current;
    const n = versions.length + 1;
    answer.current = '';
    lastDraw.current = 0;
    setAsk(''); setFailure(null); setPreview('');
    setBuilding({ ask: request, basedOn: base?.n ?? null, html: '' });
    const channel = new Channel<AskEvent>();
    channel.onmessage = event => {
      if (event.kind === 'delta') {
        answer.current += event.text;
        const now = performance.now();
        if (now - lastDraw.current > PREVIEW_EVERY_MS) { lastDraw.current = now; setPreview(extractHtml(answer.current)); }
      } else if (event.kind === 'failed') {
        setFailure(event.message);
      } else {
        const html = extractHtml(answer.current);
        setVersions(list => [...list, { n, ask: request, html, basedOn: base?.n ?? null, ms: event.elapsed_ms, tokens: event.tokens }]);
        setShown(n);
        reportTiming({ label: 'Built', ms: event.elapsed_ms, tokens: event.tokens });
      }
    };
    try { await invoke('chatgpt_ask', { question: buildRequest(request, base?.html ?? null), model, instructions: BUILDER_INSTRUCTIONS, onEvent: channel }); }
    catch (reason) { setFailure(String(reason)); }
    finally { setBuilding(null); }
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
          <b>v{v.n}</b>{v.basedOn ? ` from v${v.basedOn}` : ''} · {formatMs(v.ms)}{v.tokens ? ` · ${(v.tokens.input + v.tokens.output).toLocaleString()} tokens` : ''}
        </button>
      </div>)}
      {building && <div className="bmsg">
        <p className="bmsg-ask">{building.ask}</p>
        <p className="bmsg-done" role="status">Building v{versions.length + 1}{building.basedOn ? ` from v${building.basedOn}` : ''}…</p>
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
      {frame
        ? <iframe title={building ? 'Design in progress' : `Design v${current?.n}`} sandbox="allow-scripts" srcDoc={frame} />
        : <p className="bpreview-empty">{building ? 'Starting…' : 'Your design appears here.'}</p>}
    </section>
  </div>;
}
