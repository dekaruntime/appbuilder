'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { useGraphSearch, openGraphResult, GraphResult, resultGroups, resultIcon } from '../../lib/index-search';

export default function FloatingSearch() {
  const [query, setQuery] = useState('');
  const { results, loading, error } = useGraphSearch(query);
  const [openError, setOpenError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState(true);
  const [nativeMaterial, setNativeMaterial] = useState(false);
  const [squareCorners, setSquareCorners] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    if (!isTauri()) return;
    void invoke<{platform: string; squareCorners: boolean}>('shortcut_status')
      .then(status => { setNativeMaterial(status.platform === 'macos'); setSquareCorners(status.squareCorners); })
      .catch(() => setNativeMaterial(false));
    let unlisten: (() => void) | undefined;
    void listen('launcher-opened', () => {
      setQuery('');
      setActive(0);
      setVisible(true);
      requestAnimationFrame(() => input.current?.focus());
    }).then(stop => { unlisten = stop; });
    return () => unlisten?.();
  }, []);

  const close = useCallback(async () => {
    setVisible(false);
    try { await invoke('hide_search_window'); } catch { /* Browser mock has no native window. */ }
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void close();
      }
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [close]);

  const openZega = async () => {
    try { await invoke('show_main_window'); } catch { /* Browser mock has no main window. */ }
    await close();
  };

  const open = async (result: GraphResult) => {
    try { await openGraphResult(result); setOpenError(null); await close(); }
    catch (error) { setOpenError(String(error)); }
  };
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, results.length - 1))); }, [results]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setActive(index => (index + 1) % results.length); }
    if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setActive(index => (index - 1 + results.length) % results.length); }
    if (event.metaKey && event.key === 'Enter') { event.preventDefault(); void openZega(); return; }
    if (event.key === 'Enter' && results[active]) { event.preventDefault(); void open(results[active]); }
  };

  if (!visible) return <main className="float-root" aria-hidden="true" />;
  let resultIndex = -1;
  const renderGroup = (title: string, rows: GraphResult[]) => rows.length > 0 && <section className="float-group" aria-label={title}>
    <h2 className="lsec">{title}</h2>
    {rows.map(result => {
      resultIndex += 1;
      const index = resultIndex;
      return <button key={result.key} disabled={result.offline} className={`lrow ${index === active ? 'sel' : ''}`} type="button" role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => void open(result)}>
        <span className={result.kind === 'actions' ? 'gear' : 'fi txt'}>{resultIcon(result)}</span>
        <span><b>{result.name}</b><small>{result.offline ? 'Offline · ' : ''}{result.path}</small></span>
        <span className="hint">↵</span>
      </button>;
    })}
  </section>;

  return <main className="float-root" data-native-material={nativeMaterial} data-square-corners={squareCorners}><div className="launcher float-panel" role="dialog" aria-label="zega floating search">
    <header className="lhead" onMouseDown={event => {
      if (event.button === 0 && isTauri()) {
        event.preventDefault();
        void getCurrentWindow().startDragging().catch(error => console.error('Could not move search window', error));
      }
    }}><span className="gi" aria-hidden="true">⌕</span><span className="float-word">zega <span className="v">computer</span></span></header>
    <form className="search float-search" role="search" onSubmit={event => { event.preventDefault(); if (results[active]) void open(results[active]); }}>
      <input ref={input} aria-label="Search this Mac" autoComplete="off" spellCheck={false} placeholder="Ask computer anything…" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown}/>
    </form>
    <div className="lres" role="listbox" aria-label="Local results">
      {resultGroups.map(group => <div key={group}>{renderGroup(group[0].toUpperCase() + group.slice(1), results.filter(row => row.kind === group))}</div>)}
      {(error || openError) && <p role="alert">{error || openError}</p>}
      {loading ? <div className="skeleton" aria-label="Loading local results" /> : !results.length && <p className="float-empty">No local matches.</p>}
    </div>
    <footer className="lfoot"><span><kbd className="kbd">↑↓</kbd> Navigate</span><span><kbd className="kbd">↵</kbd> Open</span><span><kbd className="kbd">esc</kbd> Close</span><span className="local-note">Private. Secure. Local.</span></footer>
  </div></main>;
}
