'use client';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { reportTiming } from './timing';

// zega.earth results for the earth and hockey graphs (zegadb/earth#42's
// /api/search, through the native earth_search command). The computer graph
// never calls this: only words typed while an earth graph is selected leave
// the machine.
export type EarthHit = { zid: string; name: string; type: string; url: string; snippet: string; why: string[] };
type EarthResults = { results: EarthHit[]; total: number; tookMs: number };

export const EARTH_GRAPHS = new Set(['earth', 'hockey']);

export function useEarthSearch(query: string, enabled: boolean) {
  const [results, setResults] = useState<EarthHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!enabled || !q || !isTauri()) { setResults([]); setTotal(0); setLoading(false); setError(null); return; }
    let alive = true;
    setLoading(true);
    // Wait for a pause in typing: one request per search, not per keystroke.
    const timer = setTimeout(async () => {
      const started = performance.now();
      try {
        const found = await invoke<EarthResults>('earth_search', { query: q });
        if (!alive) return;
        setResults(found.results); setTotal(found.total); setError(null);
        reportTiming({ label: `${found.total.toLocaleString()} zega.earth ${found.total === 1 ? 'result' : 'results'}`, ms: performance.now() - started });
      } catch (reason) {
        if (alive) { setResults([]); setTotal(0); setError(String(reason)); }
      } finally { if (alive) setLoading(false); }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, enabled]);
  return { results, total, loading, error };
}
