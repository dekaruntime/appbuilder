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
  const [help, setHelp] = useState('macos');
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
    void invoke<ShortcutStatus>('shortcut_status').then(value => { if (!disposed) { update(value); setBinding(value.binding); setHelp(value.platform); } }).catch(reason => setError(String(reason)));
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
  return <main className="shortcut-page">
    <header><span className="tb-word">zega <span className="v">computer</span></span><h1>Search from anywhere</h1><p>Set a shortcut, then try it while another app is in front. You can also open search with the button below or from zega’s tray menu.</p></header>
    <section aria-labelledby="choose-title"><h2 id="choose-title">1. Choose your shortcut</h2>
      <div className="shortcut-actions"><button type="button" aria-pressed={recording} onClick={() => setRecording(true)} onKeyDown={record} onBlur={() => setRecording(false)}>{recording ? 'Press a combination… (Esc cancels)' : bindingLabel(binding, mac)}</button><button type="button" disabled={!native || busy} onClick={() => { setBinding(recommended); setRecording(false); void action('shortcut_apply', { binding: recommended }); }}>Use default</button></div>
      <details className="shortcut-manual"><summary>Choose keys without pressing the shortcut</summary>
        <div className="shortcut-actions">{(['control', 'alt', 'shift', 'superKey'] as const).map(modifier => <label key={modifier}><input type="checkbox" checked={binding[modifier]} onChange={event => setBinding(current => ({...current, [modifier]: event.target.checked}))} />{{control: 'Control', alt: mac ? 'Option' : 'Alt', shift: 'Shift', superKey: mac ? 'Command' : 'Super'}[modifier]}</label>)}</div>
        <label>Key <select value={binding.key} onChange={event => setBinding(current => ({...current, key: event.target.value}))}>{['Space', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(key => `Key${key}`), ...Array.from({length: 12}, (_, index) => `F${index + 1}`)].map(key => <option key={key} value={key}>{key.replace(/^Key/, '')}</option>)}</select></label>
      </details>
      <p className="shortcut-note">Default: {bindingLabel(recommended, mac)}. Use default saves it immediately. Click the combination to record a different one. Use Space, a letter, or F1–F12 with modifiers.</p>
      <button type="button" className="shortcut-primary" disabled={!native || busy || recording} onClick={() => void action('shortcut_apply', { binding })}>{busy ? 'Checking…' : 'Save & check availability'}</button>
      {status?.registered && <p>{status.portal ? 'Desktop accepted the search action' : 'Registered'}: <kbd>{status.label}</kbd>. A keypress test is still needed after changes or restart.</p>}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </section>
    <section aria-labelledby="test-title"><h2 id="test-title">2. Test outside zega</h2>
      <p>Start the test, click another app, and press {status?.label || bindingLabel(binding, mac)} within 30 seconds. Search should appear without opening the main zega window.</p>
      <div className="shortcut-actions"><button type="button" disabled={!native || !status?.registered || !applied || busy} onClick={() => void action('shortcut_begin_test')}>Start keypress test</button><button type="button" disabled={!native} onClick={() => { void invoke('open_search_window').catch(reason => setError(String(reason))); }}>Open search by click</button></div>
      <div role="status" aria-live="polite">
        {status?.phase === 'waiting' && !timeout && <p>Waiting for the global shortcut… Switch to another app now.</p>}
        {(timeout || status?.phase === 'expired') && <p>No shortcut received in time. Check the guidance below, choose another combination, or retry. Click-to-open still works.</p>}
        {status?.phase === 'received' && <><p>Keypress received. Without clicking, type a few letters in search. If typing goes to the previous app, or another launcher also opened, retry with another shortcut or adjust the conflicting binding.</p><button type="button" onClick={() => void action('shortcut_confirm')}>Only zega opened, and typing worked</button></>}
        {status?.phase === 'confirmed' && <p>Shortcut tested successfully for this session. Retest if another launcher or system setting changes.</p>}
      </div>
    </section>
    <section aria-labelledby="help-title"><h2 id="help-title">Platform help</h2><nav className="shortcut-actions" aria-label="Platform help">{['macos', 'windows', 'linux'].map(platform => <button type="button" key={platform} aria-pressed={help === platform} onClick={() => setHelp(platform)}>{platform === 'macos' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux / Omarchy'}</button>)}</nav>
      {help === 'macos' && <><p>macOS system shortcuts are checked before registration. Other launchers can share a shortcut without reporting a conflict, so the keypress test matters. Change a reserved binding in System Settings → Keyboard → Keyboard Shortcuts, or choose another combination here. zega does not change system shortcuts.</p>{keyboardPane && <button type="button" onClick={() => { void invoke('open_settings_pane', { bundleId: keyboardPane }).catch(reason => setError(String(reason))); }}>Open Keyboard Settings</button>}</>}
      {help === 'windows' && <p>Alt+Space can overlap with the window menu or PowerToys Run. zega reports registration errors, but another app may still intercept keys. Try Control+Alt+Space if needed. Retest while another app is focused, including any app running as administrator.</p>}
      {help === 'linux' && <p>Linux desktops control global shortcuts differently. On Wayland, Save requests access through your desktop’s global-shortcut portal. Approve the prompt; the desktop may choose a different combination. On current Omarchy, Save adds a managed shortcut to your personal Hyprland bindings and checks for conflicts. Existing bindings are preserved. Custom or older Hyprland setups can use the platform guide. Portal acceptance alone does not prove a key is bound: run the keypress test. On X11, zega checks direct registration. If either is unavailable, use the tray’s Search action.</p>}
    </section>
  </main>;
}
