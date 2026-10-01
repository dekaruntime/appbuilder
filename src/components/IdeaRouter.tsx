'use client';
import { useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// An idea typed into the floating prompt arrives here, in the main window,
// whatever page it is on: it is parked, the builder is brought up, and the
// builder starts building it (Builder reads PENDING_IDEA).
export const PENDING_IDEA = 'zega.pending-idea';
export const IDEA_EVENT = 'zega-idea';

export default function IdeaRouter() {
  useEffect(() => {
    let label = '';
    try { label = getCurrentWindow().label; } catch { return; }
    if (!isTauri() || label !== 'main') return;
    let unlisten: (() => void) | undefined;
    void listen<string>('builder-idea', event => {
      try { sessionStorage.setItem(PENDING_IDEA, event.payload); } catch { return; }
      if (location.pathname !== '/') location.assign('/');
      else dispatchEvent(new Event(IDEA_EVENT));
    }).then(stop => { unlisten = stop; });
    return () => unlisten?.();
  }, []);
  return null;
}
