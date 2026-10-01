'use client';
import { useEffect, useState } from 'react';
import { DEFAULT_STARTUP, WINDOW_SIZES, readStartup, saveStartup, type Startup } from '../lib/builder-startup';

const SIDES = [['chat', 'Chat'], ['terminal', 'Terminal'], ['none', 'Neither: full-width desktop']] as const;
const DESKTOPS = [['auto', 'Match this computer'], ['macos', 'macOS'], ['windows', 'Windows'], ['omarchy', 'Omarchy']] as const;

export default function BuilderSettings() {
  const [startup, setStartup] = useState<Startup>(DEFAULT_STARTUP);
  useEffect(() => { setStartup(readStartup()); }, []);
  const update = (change: Partial<Startup>) => setStartup(current => { const next = { ...current, ...change }; saveStartup(next); return next; });
  return <section className="settings-section builder-settings" aria-labelledby="builder-startup-title">
    <h2 id="builder-startup-title">When the builder opens</h2>
    <p>Choose what you see first. ⌘J toggles the terminal and ⌘K the chat at any time.</p>
    <label>Side panel
      <select value={startup.side} onChange={event => update({ side: event.target.value as Startup['side'] })}>
        {SIDES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <label>Desktop
      <select value={startup.desktop} onChange={event => update({ desktop: event.target.value as Startup['desktop'] })}>
        {DESKTOPS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <label>Window size for new apps
      <select value={startup.size} onChange={event => update({ size: event.target.value })}>
        {WINDOW_SIZES.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h}</option>)}
      </select>
    </label>
  </section>;
}
