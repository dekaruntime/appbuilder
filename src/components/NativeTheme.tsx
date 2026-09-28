'use client';

import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Palette = {
  mode: 'light' | 'dark';
  background: string; foreground: string; muted: string; border: string; tint: string;
  accent: string; accentForeground: string; selection: string; selectionForeground: string; link: string;
};

const properties: Record<string, keyof Omit<Palette, 'mode'>> = {
  '--bg': 'background', '--win': 'background', '--panel': 'background', '--ink': 'foreground',
  '--soft': 'muted', '--edge': 'border', '--tint': 'tint', '--accent': 'accent',
  '--accent-ink': 'accentForeground', '--accent-soft': 'selection', '--var-bg': 'selection',
  '--var-ink': 'selectionForeground', '--link': 'link',
};

export default function NativeTheme() {
  useEffect(() => {
    if (!isTauri()) return;
    const root = document.documentElement;
    let disposed = false;
    let palette: Palette | null = null;
    let receivedEvent = false;
    const apply = () => {
      // Reuse cqx's data-theme contract: an explicit light/dark choice wins.
      const override = root.dataset.theme === 'light' || root.dataset.theme === 'dark';
      const current = override ? null : palette;
      for (const [property, field] of Object.entries(properties)) {
        if (current) root.style.setProperty(property, current[field]);
        else root.style.removeProperty(property);
      }
      if (current) { root.style.colorScheme = current.mode; root.dataset.nativeTheme = 'omarchy'; }
      else { root.style.removeProperty('color-scheme'); delete root.dataset.nativeTheme; }
    };
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    const stop = listen<Palette | null>('native-theme-changed', event => {
      if (!disposed) { receivedEvent = true; palette = event.payload; apply(); }
    });
    // Subscribe before reading, so a theme switch during startup cannot be lost.
    void stop.then(() => invoke<Palette | null>('native_theme')).then(value => {
      if (!disposed && !receivedEvent) { palette = value; apply(); }
    }).catch(() => { /* Missing palette/unsupported host keeps the CSS system theme. */ });
    return () => {
      disposed = true;
      observer.disconnect();
      void stop.then(unlisten => unlisten()).catch(() => {});
    };
  }, []);
  return null;
}
