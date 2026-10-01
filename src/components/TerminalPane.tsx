'use client';
import { useEffect, useRef, useState } from 'react';
import type { Terminal as Xterm, ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { connectTerminal } from '../lib/terminal';

// A real shell in the app's project folder, sliding in from the right like
// cqx desktop's terminal (cqxai/desktop src/app/Terminal.tsx). Edits made
// here land in the folder the builder watches, so they show up in the preview.

function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const colour = (name: string) => css.getPropertyValue(`--${name}`).trim();
  const ground = colour('win'), ink = colour('ink');
  return {
    background: ground, foreground: ink, cursor: ink, cursorAccent: ground,
    selectionBackground: colour('edge'), selectionForeground: ink,
    black: ground, brightBlack: colour('soft'), white: ink, brightWhite: ink,
    red: '#d4543f', brightRed: '#e0705a', green: colour('accent'), brightGreen: colour('accent'),
    yellow: '#c99a2e', brightYellow: '#e2c445', blue: colour('link'), brightBlue: colour('link'),
    magenta: '#a36ac7', brightMagenta: '#b98ad6', cyan: '#2f9aa0', brightCyan: '#49b7bd',
  };
}

function Terminal({ path, visible, command }: { path: string; visible: boolean; command: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Xterm | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const shown = useRef(visible);
  shown.current = visible;
  const send = useRef<((text: string) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    let gone = false;
    let dispose = () => {};
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), document.fonts.ready])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (gone || !container.current) return;
        const host = container.current;
        const term = new Terminal({ theme: theme(), cursorBlink: true, fontFamily: getComputedStyle(host).fontFamily, fontSize: 13, lineHeight: 1.25 });
        const addon = new FitAddon();
        term.loadAddon(addon);
        term.open(host);
        terminal.current = term;
        if (shown.current) addon.fit();
        const report = (message: string) => { if (!gone) setError(message); };
        const session = connectTerminal(path, term.rows, term.cols, bytes => term.write(bytes), () => setEnded(true), report);
        send.current = text => session.write(new TextEncoder().encode(text));
        const data = term.onData(text => session.write(new TextEncoder().encode(text)));
        const binary = term.onBinary(text => session.write(Uint8Array.from(text, c => c.charCodeAt(0))));
        // Fit the renderer every frame; debounce the PTY resize (SIGWINCH redraws).
        let ptyResize: ReturnType<typeof setTimeout> | undefined;
        const resizePty = () => { clearTimeout(ptyResize); ptyResize = setTimeout(() => session.resize(term.rows, term.cols), 100); };
        const resize = term.onResize(resizePty);
        let frame = 0;
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (shown.current) addon.fit(); }); };
        const observer = new ResizeObserver(schedule); observer.observe(host);
        fit.current = schedule;
        const retheme = () => { term.options.theme = theme(); };
        const media = matchMedia('(prefers-color-scheme: dark)');
        media.addEventListener('change', retheme);
        void session.ready.then(() => { if (!gone) { resizePty(); if (shown.current) term.focus(); } }).catch(e => report(String(e)));
        dispose = () => {
          observer.disconnect(); cancelAnimationFrame(frame); media.removeEventListener('change', retheme);
          clearTimeout(ptyResize); data.dispose(); binary.dispose(); resize.dispose();
          void session.close().catch(e => console.error('Could not close terminal:', e));
          term.dispose(); terminal.current = null; fit.current = null; send.current = null;
        };
      }).catch(e => { if (!gone) setError(String(e)); });
    return () => { gone = true; dispose(); };
  }, [path]);

  useEffect(() => { if (visible) { fit.current?.(); terminal.current?.focus(); } }, [visible]);
  // A command handed in from the builder (e.g. "start Codex on this error"):
  // typed once the shell is up, as if the user had typed it.
  useEffect(() => {
    if (!command) return;
    const timer = setTimeout(() => send.current?.(`${command}\r`), send.current ? 0 : 900);
    return () => clearTimeout(timer);
  }, [command]);

  return <>
    {error && <p role="alert" className="terminal-message">{error}</p>}
    {ended && <p role="status" className="terminal-message">Shell exited. Close the terminal to start another.</p>}
    <div ref={container} className="terminal-screen" />
  </>;
}

export default function TerminalPane({ path, open, command, onHide }: {
  path: string | null; open: boolean; command: string | null; onHide: () => void;
}) {
  const [width, setWidth] = useState(520);
  const [generation, setGeneration] = useState(0);
  const [started, setStarted] = useState(false);
  const drag = useRef<{ origin: number; size: number } | null>(null);
  useEffect(() => { if (open) setStarted(true); }, [open]);
  const clamp = (n: number) => Math.max(320, Math.min(n, innerWidth - 420));
  // Width animates from 0, pushing the desktop aside like the sidebar does;
  // the inner panel keeps its full width so the shell never reflows mid-slide.
  return <aside className="terminal-slide" data-open={open} style={{ width: open ? width : 0 }} aria-label="Terminal" aria-hidden={!open}>
    <div role="separator" aria-label="Resize terminal" aria-orientation="vertical" tabIndex={open ? 0 : -1} className="terminal-divider"
      onPointerDown={e => { drag.current = { origin: e.clientX, size: width }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (drag.current) setWidth(clamp(drag.current.size + drag.current.origin - e.clientX)); }}
      onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setWidth(clamp(width + (e.key === 'ArrowLeft' ? 24 : -24))); } }} />
    <div className="terminal-panel" style={{ width: width - 5 }}>
      <header className="terminal-header"><span title={path ?? ''}>{path ? path.replace(/^.*\/Zega Apps\//, '~/Documents/Zega Apps/') : 'terminal'}</span><div>
        <button type="button" onClick={onHide}>hide</button>
        <button type="button" aria-label="Close terminal session" onClick={() => { setStarted(false); setGeneration(n => n + 1); onHide(); }}>×</button>
      </div></header>
      {!path ? <p className="terminal-message">Build an app first: the terminal opens in its folder.</p>
        : started ? <Terminal key={`${path}-${generation}`} path={path} visible={open} command={command} /> : null}
    </div>
  </aside>;
}
