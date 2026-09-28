'use client';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { GraphResult, resultIcon } from '../lib/index-search';

const cache = new Map<string, Promise<string | null>>();
export default function ResultIcon({ result }: { result: GraphResult }) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setIcon(null);
    if (isTauri() && result.kind !== 'actions' && !result.offline) {
      if (!cache.has(result.key)) {
        if (cache.size >= 256) cache.clear();
        cache.set(result.key, invoke<string | null>('index_result_icon', { key: result.key }).catch(() => null));
      }
      void cache.get(result.key)?.then(value => { if (active) setIcon(value); });
    }
    return () => { active = false; };
  }, [result.key, result.kind, result.offline]);
  return icon ? <img className="result-icon" src={icon} alt="" aria-hidden="true" /> : <span className={result.kind === 'actions' ? 'gear' : 'fi txt'} aria-hidden="true">{resultIcon(result)}</span>;
}
