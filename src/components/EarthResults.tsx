'use client';
import { invoke } from '@tauri-apps/api/core';
import type { EarthHit } from '../lib/earth-search';

// Classic results from zega.earth: name, the site's one-line snippet, and the
// page it links to. Opening a result opens its zega.earth page.
export default function EarthResults({ graph, results, total, loading, error }: { graph: string; results: EarthHit[]; total: number; loading: boolean; error: string | null }) {
  const open = (hit: EarthHit) => { void invoke('earth_open', { url: hit.url }).catch(() => {}); };
  return <div className="res"><div className="groups">
    {error && <p role="alert">{error}</p>}
    {results.length > 0 && <section className="grp earth-results"><h3>zega.earth <small>{total.toLocaleString()} {total === 1 ? 'result' : 'results'}</small></h3>
      {results.map(hit => <button className="row earth-row" key={hit.zid} type="button" onClick={() => open(hit)} title={hit.why.join(' · ')}>
        <span><b>{hit.name}</b><small className="earth-url">{hit.url.replace(/^https:\/\//, '')}</small><small>{hit.snippet}</small></span>
        <span className="when">{hit.type}</span>
      </button>)}
    </section>}
    {loading && <div className="skeleton" aria-label={`Searching ${graph} on zega.earth`} />}
    {!loading && !error && !results.length && <p className="empty">No matches on zega.earth.</p>}
    <p className="earth-note">Results from zega.earth. Only the words you type here are sent; nothing on this computer is.</p>
  </div></div>;
}
