'use client';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type GraphResult = { id: number; key: string; kind: 'actions' | 'apps' | 'files' | 'photos'; name: string; path: string; offline: boolean; detail: string };
export type IndexStatus = { itemsIndexed: number; lastScan: number | null; scanning: boolean; paused: boolean; error: string | null; skipped: number; warnings: string[] };
export function resultIcon(row: GraphResult) {
  if (row.kind === 'actions') return '⚙';
  if (row.kind === 'apps') return 'APP';
  if (row.kind === 'photos') return 'IMG';
  return row.path.split('.').pop()?.slice(0, 3).toUpperCase() || 'FILE';
}
export const resultGroups = ['actions', 'apps', 'files', 'photos'] as const;
export function useGraphSearch(query: string) {
  const [results, setResults] = useState<GraphResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) { setLoading(false); return; }
    let alive = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const rows = await invoke<GraphResult[]>('index_search', { query });
        if (alive && request === sequence) { setResults(rows); setError(null); }
      } catch (error) {
        if (alive && request === sequence) { setResults([]); setError(String(error)); }
      } finally { if (alive && request === sequence) setLoading(false); }
    };
    setLoading(true);
    void refresh();
    const interval = setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(interval); };
  }, [query]);
  return { results, loading, error };
}
export async function openGraphResult(result: GraphResult) {
  if (result.offline) throw new Error('Connect this volume to open the file.');
  if (result.kind === 'actions') await invoke('open_settings_pane', { bundleId: result.path });
  else await invoke('index_open_result', { key: result.key });
}
