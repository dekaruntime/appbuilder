'use client';

import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ShortcutStatus, defaults, bindingLabel } from '../lib/shortcut';

export default function ShortcutHint() {
  const [label, setLabel] = useState(bindingLabel(defaults, false));
  useEffect(() => {
    if (!isTauri()) { setLabel(bindingLabel(defaults, /Mac/.test(navigator.platform))); return; }
    let disposed = false;
    const update = (status: ShortcutStatus | null) => {
      if (!disposed && status) setLabel(status.registered ? status.label : 'Set shortcut');
    };
    const stop = listen<ShortcutStatus>('shortcut-status', event => update(event.payload));
    void invoke<ShortcutStatus>('shortcut_status').then(update).catch(() => setLabel('Set shortcut'));
    return () => { disposed = true; void stop.then(unlisten => unlisten()); };
  }, []);
  return <button type="button" className="kbd" aria-label="Set up search shortcut" onMouseDown={event => event.stopPropagation()} onClick={() => { if (isTauri()) void invoke('show_shortcut_setup'); else window.location.href = '/shortcut/'; }}>{label}</button>;
}
