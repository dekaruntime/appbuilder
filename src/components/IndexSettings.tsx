'use client';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { IndexStatus } from '../lib/index-search';

export default function IndexSettings() {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      const next = await invoke<IndexStatus>('index_status');
      if (typeof next?.itemsIndexed !== 'number' || typeof next?.scanning !== 'boolean' || typeof next?.paused !== 'boolean') throw new Error('Index status unavailable');
      setStatus(next); setError(null);
    }
    catch (error) { setError(String(error)); }
  };
  useEffect(() => {
    if (!isTauri()) return;
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, []);
  const action = async (command: string, args?: Record<string, unknown>) => {
    setBusy(true);
    try { await invoke(command, args); await refresh(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  return <details className="index-settings"><summary>Settings</summary><section aria-label="Index settings"><h3>Index</h3>
    <p role="status">{status ? `${status.itemsIndexed.toLocaleString()} items indexed · ${status.paused ? 'Paused' : status.scanning ? 'Scanning' : 'Up to date'} · Last scan: ${status.lastScan ? new Date(status.lastScan * 1000).toLocaleString() : 'Not yet scanned'}` : 'Index status unavailable'}</p>
    {status && status.skipped > 0 && <p>{status.skipped} locations were skipped or could not be read.</p>}
    {status?.warnings?.map(warning => <p key={warning}>{warning}</p>)}
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    <button type="button" disabled={busy || !status} onClick={() => void action('index_pause', { paused: !status?.paused })}>{status?.paused ? 'Resume indexing' : 'Pause indexing'}</button>{' '}
    <button type="button" disabled={busy || !status || status.scanning} onClick={() => void action('index_rebuild')}>Rebuild index</button>
    <small>Place names: <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>. City data reduced from cities15000; neighbourhood entries omitted. Nearest city within 100 km.</small>
  </section></details>;
}
