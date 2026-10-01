'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import SearchBar from '../../components/SearchBar';

// The floating prompt: one question, no results. Enter hands the idea to the
// builder in the main window, which comes forward and starts building it.
export default function FloatingPrompt() {
  const [idea, setIdea] = useState('');
  const [visible, setVisible] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [nativeMaterial, setNativeMaterial] = useState(false);
  const [windows, setWindows] = useState(false);
  const [squareCorners, setSquareCorners] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    if (!isTauri()) return;
    void invoke<{ platform: string; squareCorners: boolean }>('shortcut_status')
      .then(status => { setNativeMaterial(status.platform === 'macos'); setWindows(status.platform === 'windows'); setSquareCorners(status.squareCorners); })
      .catch(() => setNativeMaterial(false));
    let unlisten: (() => void) | undefined;
    void listen('launcher-opened', () => {
      setIdea('');
      setFailure(null);
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
      if (event.key === 'Escape') { event.preventDefault(); void close(); }
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [close]);

  const build = async () => {
    const text = idea.trim();
    if (!text) return;
    try {
      await emitTo('main', 'builder-idea', text);
      await invoke('show_main_window');
      await close();
    } catch (error) { setFailure(String(error)); }
  };

  if (!visible) return <main className="float-root" aria-hidden="true" />;
  return <main className="float-root" data-native-material={nativeMaterial} data-square-corners={squareCorners}><div className="launcher float-panel float-prompt" role="dialog" aria-label="zega: what are we building today?">
    <SearchBar className="float-search" inputRef={input} label="What are we building today?" placeholder="What are we building today?" value={idea} onChange={setIdea} onSubmit={() => void build()} />
    {failure && <p role="alert" className="float-failure">{failure}</p>}
    {/* The footer carries the wordmark and is where the window is dragged from. */}
    <footer className="lfoot" onMouseDown={event => {
      if (event.button === 0 && isTauri()) {
        event.preventDefault();
        void getCurrentWindow().startDragging().catch(error => console.error('Could not move the prompt window', error));
      }
    }}><span><kbd className="kbd">↵</kbd> Build it</span><span><kbd className="kbd">esc</kbd> Close</span><span className="float-word">zega</span></footer>
  </div></main>;
}
