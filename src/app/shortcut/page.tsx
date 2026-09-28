'use client';

import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Binding, ShortcutStatus, defaults, bindingLabel, platformDefault } from '../../lib/shortcut';

export default function ShortcutSetup() {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [binding, setBinding] = useState<Binding>(defaults);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [timeout, setTimeoutReached] = useState(false);
  const [native, setNative] = useState(false);
  const [view, setView] = useState<'shortcut' | 'change' | 'help'>('shortcut');
  const [keyboardPane, setKeyboardPane] = useState<string | null>(null);
  const mac = status?.platform === 'macos';
  const recommended = platformDefault(status?.platform ?? 'macos');

  useEffect(() => {
    if (!isTauri()) { setError('Open this page in the zega desktop app to set up a global shortcut.'); return; }
    setNative(true);
    void invoke<{label: string; bundleId: string}[]>('local_settings_panes').then(panes => setKeyboardPane(panes.find(pane => pane.label === 'Keyboard')?.bundleId ?? null)).catch(() => {});
    let disposed = false;
    const update = (value: ShortcutStatus) => { if (!disposed) setStatus(value); };
    const stop = listen<ShortcutStatus>('shortcut-status', event => update(event.payload));
    void invoke<ShortcutStatus>('shortcut_status').then(value => { if (!disposed) { update(value); setBinding(value.binding); } }).catch(reason => setError(String(reason)));
    return () => { disposed = true; void stop.then(unlisten => unlisten()); };
  }, []);
  useEffect(() => {
    setTimeoutReached(false);
    if (status?.phase !== 'waiting') return;
    const timer = window.setTimeout(() => { setTimeoutReached(true); }, 30_000);
    return () => window.clearTimeout(timer);
  }, [status?.phase]);

  const action = async (command: string, args?: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { setStatus(await invoke<ShortcutStatus>(command, args)); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const record = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setRecording(false); return; }
    if (!/^(Space|Key[A-Z]|F([1-9]|1[0-2]))$/.test(event.code)) return;
    if (!(event.altKey || event.ctrlKey || event.metaKey)) { setError('Include Alt/Option, Control, or Super/Command.'); return; }
    setBinding({ key: event.code, alt: event.altKey, control: event.ctrlKey, shift: event.shiftKey, superKey: event.metaKey });
    setRecording(false); setError('');
  };
  const applied = status && JSON.stringify(binding) === JSON.stringify(status.binding);
  const test = () => {
    setBusy(true); setError('');
    void (async () => {
      const value = applied && status?.registered ? status : await invoke<ShortcutStatus>('shortcut_apply', {binding});
      setStatus(value);
      if (!value.registered || value.error) { setView('shortcut'); return; }
      setStatus(await invoke<ShortcutStatus>('shortcut_begin_test'));
      setView('shortcut');
    })().catch(reason => setError(String(reason))).finally(() => setBusy(false));
  };
  const waiting = applied && status?.phase === 'waiting' && !timeout;
  const received = applied && status?.phase === 'received';
  const confirmed = applied && status?.phase === 'confirmed';
  const problem = error || (applied && status?.error);
  return <main className="shortcut-page">
    <header><span className="tb-word">zega <span className="v">computer</span></span><h1>{view === 'help' ? 'Shortcut help' : 'Search shortcut'}</h1></header>
    {view === 'help' ? <section className="shortcut-help" aria-label="Shortcut help">
      {status?.platform === 'macos' && <><p>If macOS or another launcher uses these keys, choose a different combination or change its shortcut in Keyboard Settings.</p>{keyboardPane && <button type="button" onClick={() => { void invoke('open_settings_pane', { bundleId: keyboardPane }).catch(reason => setError(String(reason))); }}>Open Keyboard Settings</button>}</>}
      {status?.platform === 'windows' && <p>Alt+Space can open a window menu or PowerToys Run. If it conflicts, try Control+Alt+Space or change the other app’s shortcut.</p>}
      {status?.platform === 'linux' && <p>Your desktop manages shortcuts. Approve any permission prompt. If these keys are busy, choose another combination or change it in your desktop’s Keyboard Settings. zega preserves existing shortcuts.</p>}
      <p>Test from another app. Only zega search should appear, and typing should work without a click.</p>
      <button type="button" className="shortcut-primary" onClick={() => setView('shortcut')}>Back</button>
    </section> : <>
      {view === 'shortcut' && <p className="shortcut-intro">Open search from any app.</p>}
      <div className="shortcut-key-row">
        <button type="button" className="shortcut-key" aria-pressed={recording} disabled={!status || busy} onClick={() => setRecording(true)} onKeyDown={record} onBlur={() => setRecording(false)}>{!status ? 'Loading…' : recording ? 'Press a combination… (Esc cancels)' : bindingLabel(binding, mac)}</button>
        <button type="button" className="shortcut-link" disabled={!status || busy} onClick={() => { if (view === 'change' && status) setBinding(status.binding); setView(view === 'change' ? 'shortcut' : 'change'); setRecording(false); setError(''); }}>{view === 'change' ? 'Cancel' : 'Change'}</button>
      </div>
      {view === 'change' && <fieldset className="shortcut-manual"><legend>Choose keys</legend>
        <div className="shortcut-actions">{(['control', 'alt', 'shift', 'superKey'] as const).map(modifier => <label key={modifier}><input type="checkbox" checked={binding[modifier]} onChange={event => setBinding(current => ({...current, [modifier]: event.target.checked}))} />{{control: 'Control', alt: mac ? 'Option' : 'Alt', shift: 'Shift', superKey: mac ? 'Command' : 'Super'}[modifier]}</label>)}
          <select aria-label="Key" value={binding.key} onChange={event => setBinding(current => ({...current, key: event.target.value}))}>{['Space', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(key => `Key${key}`), ...Array.from({length: 12}, (_, index) => `F${index + 1}`)].map(key => <option key={key} value={key}>{key.replace(/^Key/, '')}</option>)}</select>
        </div>
        <button type="button" className="shortcut-link" disabled={!native || busy} onClick={() => { setBinding(recommended); setRecording(false); setView('shortcut'); void action('shortcut_apply', { binding: recommended }); }}>Use default</button>
      </fieldset>}
      {view === 'shortcut' && <div className="shortcut-status" role="status" aria-live="polite">
        {problem ? <p role="alert">{problem}</p> : waiting ? <p>Switch to another app and press <strong>{status?.label}</strong> within 30 seconds.</p>
          : received ? <p>Keypress received. Did only zega open, and did typing work without a click?</p>
          : confirmed ? <p>Shortcut tested successfully.</p>
          : timeout || status?.phase === 'expired' ? <p>No shortcut received. Try again or change the keys.</p>
          : <p>{applied && status?.registered ? 'Saved. Try it from another app.' : 'Save these keys, then try them from another app.'}</p>}
      </div>}
      <div className="shortcut-actions">
        {received ? <><button type="button" className="shortcut-primary" disabled={busy} onClick={() => void action('shortcut_confirm')}>Yes, it worked</button><button type="button" onClick={test}>Try again</button></>
          : confirmed ? <button type="button" className="shortcut-primary" onClick={() => { void invoke('close_shortcut_setup').catch(reason => setError(String(reason))); }}>Done</button>
          : <button type="button" className="shortcut-primary" disabled={!native || !status || busy || recording || !!waiting} onClick={test}>{busy ? 'Checking…' : waiting ? 'Listening…' : applied && status?.registered ? 'Test shortcut' : 'Save & test'}</button>}
      </div>
    </>}
    {view !== 'shortcut' && error && <p role="alert">{error}</p>}
    <footer><button type="button" className="shortcut-link" disabled={!native} onClick={() => { void invoke('open_search_window').catch(reason => setError(String(reason))); }}>Open search</button>{view !== 'help' && <button type="button" className="shortcut-link" onClick={() => { setView('help'); setRecording(false); }}>Help</button>}</footer>
  </main>;
}
