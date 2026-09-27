'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type LocalFile = { name: string; location: string; fileType: string; modifiedLabel: string; path: string };
type LocalPane = { label: string; icon: string; bundleId: string };
type Result =
  | { kind: 'setting'; label: string; detail: string; icon: string; bundleId: string }
  | { kind: 'file'; label: string; detail: string; icon: string; path: string };

const sampleFiles: LocalFile[] = [
  { name: 'Lisbon itinerary.pdf', location: 'Downloads', fileType: 'PDF', modifiedLabel: 'Yesterday', path: '' },
  { name: 'zega pitch — Sept.key', location: 'Documents › zega', fileType: 'KEY', modifiedLabel: '12 min ago', path: '' },
];
const sampleSettings: LocalPane[] = [
  { label: 'Wi-Fi', icon: '⌁', bundleId: '' },
  { label: 'Displays', icon: '▭', bundleId: '' },
  { label: 'Sound', icon: '🔈', bundleId: '' },
  { label: 'Dark mode', icon: '◐', bundleId: '' },
];

export default function FloatingSearch() {
  const [files, setFiles] = useState<LocalFile[]>(sampleFiles);
  const [settings, setSettings] = useState<LocalPane[]>(sampleSettings);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    if (!isTauri()) return;
    void Promise.all([
      invoke<LocalFile[]>('local_recent_files'),
      invoke<LocalPane[]>('local_settings_panes'),
    ]).then(([recent, panes]) => {
      setFiles(recent);
      setSettings(panes);
    }).catch(() => {
      setFiles([]);
      setSettings([]);
    });
    let unlisten: (() => void) | undefined;
    void listen('launcher-opened', () => {
      setQuery('');
      setActive(0);
      setVisible(true);
      requestAnimationFrame(() => input.current?.focus());
    }).then(stop => { unlisten = stop; });
    return () => unlisten?.();
  }, []);

  const results = useMemo<Result[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
    return [
      ...settings
        .filter(pane => matches(`${pane.label} System Settings`))
        .map(pane => ({ kind: 'setting' as const, label: pane.label, detail: 'System Settings', icon: pane.icon, bundleId: pane.bundleId })),
      ...files
        .filter(file => matches(`${file.name} ${file.location}`))
        .map(file => ({ kind: 'file' as const, label: file.name, detail: file.location, icon: file.fileType.slice(0, 3).toUpperCase(), path: file.path })),
    ];
  }, [files, query, settings]);

  const close = async () => {
    setVisible(false);
    try { await invoke('hide_search_window'); } catch { /* Browser mock has no native window. */ }
  };

  const open = async (result: Result) => {
    try {
      if (result.kind === 'file' && result.path) await invoke('open_local_file', { path: result.path });
      if (result.kind === 'setting' && result.bundleId) await invoke('open_settings_pane', { bundleId: result.bundleId });
    } catch {
      // Local targets may disappear between indexing and selection.
    } finally {
      await close();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setActive(index => (index + 1) % results.length); }
    if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setActive(index => (index - 1 + results.length) % results.length); }
    if (event.key === 'Enter' && results[active]) { event.preventDefault(); void open(results[active]); }
  };

  if (!visible) return <main className="float-root" aria-hidden="true" />;
  const settingsResults = results.filter(result => result.kind === 'setting');
  const fileResults = results.filter(result => result.kind === 'file');
  let resultIndex = -1;
  const renderGroup = (title: string, rows: Result[]) => rows.length > 0 && <section className="float-group" aria-label={title}>
    <h2 className="lsec">{title}</h2>
    {rows.map(result => {
      resultIndex += 1;
      const index = resultIndex;
      return <button key={`${result.kind}:${result.label}`} className={`lrow ${index === active ? 'sel' : ''}`} type="button" role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => void open(result)}>
        <span className={result.kind === 'setting' ? 'gear' : `fi ${result.icon.toLowerCase()}`}>{result.icon}</span>
        <span><b>{result.label}</b><small>{result.detail}</small></span>
        <span className="hint">↵</span>
      </button>;
    })}
  </section>;

  return <main className="float-root"><div className="launcher float-panel" role="dialog" aria-label="zega floating search">
    <header className="lhead"><span className="gi" aria-hidden="true">⌕</span><span className="float-word">zega <span className="v">computer</span></span><span className="tb-sp"/><span className="kbd">⌥ Space</span></header>
    <form className="search float-search" role="search" onSubmit={event => { event.preventDefault(); if (results[active]) void open(results[active]); }}>
      <input ref={input} aria-label="Search this Mac" autoComplete="off" spellCheck={false} placeholder="Ask computer anything…" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown}/>
      <button className="round go" type="submit" aria-label="Open selected result">↵</button>
    </form>
    <div className="lres" role="listbox" aria-label="Local results">
      {renderGroup('Settings', settingsResults)}
      {renderGroup('Files', fileResults)}
      {!results.length && <p className="float-empty">No local matches.</p>}
    </div>
    <footer className="lfoot"><span><kbd className="kbd">↑↓</kbd> Navigate</span><span><kbd className="kbd">↵</kbd> Open</span><span><kbd className="kbd">esc</kbd> Close</span><span className="local-note">Private. Secure. Local.</span></footer>
  </div></main>;
}
