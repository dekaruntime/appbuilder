'use client';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import AppTitlebar from '../../components/AppTitlebar';
import BuilderRail from '../../components/BuilderRail';
import DekaPreview from '../../components/DekaPreview';
import { formatMs } from '../../lib/timing';

// Every app built here, from each app folder's .zega/history.json: pick an
// idea to see its whole conversation and every iteration, run any version,
// or reopen the app in the builder with all its versions.
type AppSummary = { path: string; id: string; name: string; first_ask: string | null; versions: number; updated_ms: number | null };
type Entry = { n: number; ask: string; basedOn: number | null; ms: number; tokens: { output: number } | null; made: { how: string; ops?: number }; fixes: number; error: string | null; at?: number; source: string };
type History = { id: string; name?: string; path: string; versions: Entry[] };

const when = (ms: number | null | undefined) => {
  if (!ms) return '';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const how = (e: Entry) => !e.basedOn ? 'first build' : e.made.how === 'rixse' ? `rixse · ${e.made.ops ?? 0} ops` : e.made.how === 'outside' ? 'edited in the folder' : e.made.how === 'escalated' ? 'rixse → rewrite' : 'rewrite';

export default function HistoryPage() {
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [selected, setSelected] = useState<History | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) { setApps([]); return; }
    void invoke<AppSummary[]>('project_list').then(list => { setApps(list); if (list[0]) void open(list[0].path); }).catch(reason => setFailure(String(reason)));
  }, []);

  const open = async (path: string) => {
    try {
      const history = await invoke<History>('project_history', { path });
      setSelected(history);
      setVersion(history.versions.at(-1)?.n ?? null);
    } catch (reason) { setFailure(String(reason)); }
  };
  const shown = selected?.versions.find(v => v.n === version) ?? null;

  return <main className="stage"><div className="window">
    <AppTitlebar bare />
    <div className="history">
      <BuilderRail current="history" />
      <section className="history-apps" aria-label="Apps">
        <h1>History</h1>
        {failure && <p role="alert" className="bmsg-fail">{failure}</p>}
        {apps === null ? <p className="history-empty">Loading…</p>
          : !apps.length ? <p className="history-empty">Nothing yet. Every app you build shows up here, with every version.</p>
          : apps.map(a => <button key={a.path} type="button" className="history-app" aria-pressed={selected?.path === a.path} onClick={() => void open(a.path)}>
            <b>{a.name}</b>
            <span>{a.first_ask ?? 'No requests yet'}</span>
            <small>{a.versions} {a.versions === 1 ? 'version' : 'versions'} · {when(a.updated_ms)}{a.name !== a.id ? ` · ${a.id}` : ''}</small>
          </button>)}
      </section>
      <section className="history-detail" aria-label="Versions">
        {selected ? <>
          <header>
            <div><h2>{selected.name ?? selected.id}</h2><small>{selected.path.replace(/^.*\/Zega Apps\//, '~/Documents/Zega Apps/')}</small></div>
            <a className="history-open" href={`/?app=${encodeURIComponent(selected.path)}`}>Open in the builder</a>
          </header>
          <div className="history-body">
            <ol className="history-chat">
              {selected.versions.map(v => <li key={v.n}>
                <p className="bmsg-ask">{v.ask}</p>
                <button type="button" className="bmsg-done" aria-pressed={version === v.n} onClick={() => setVersion(v.n)}>
                  <b>v{v.n}</b>{v.basedOn ? ` from v${v.basedOn}` : ''} · {how(v)}{v.ms ? ` · ${formatMs(v.ms)}` : ''}{v.tokens ? ` · ${v.tokens.output.toLocaleString()} output tokens` : ''}{v.fixes ? ` · fixed ${v.fixes}` : ''}{v.at ? ` · ${when(v.at)}` : ''}
                </button>
                {v.error && <pre className="history-error">{v.error}</pre>}
              </li>)}
            </ol>
            <div className="history-preview">
              {shown ? <><div className="history-frame"><DekaPreview source={shown.source} width={800} height={600} zoom={0.5} /></div>
                <p>v{shown.n} running · {shown.source.split('\n').length} lines of DekaScript</p></> : <p className="history-empty">Pick a version to run it.</p>}
            </div>
          </div>
        </> : <p className="history-empty">Pick an app to see its versions.</p>}
      </section>
    </div>
  </div></main>;
}
