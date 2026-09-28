'use client';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function AppTitlebar({ graph = 'computer' }: { graph?: string }) {
  const windowAction = async (action: 'close' | 'minimize' | 'toggleMaximize') => {
    try { await getCurrentWindow()[action](); } catch { /* Browser preview has no native window. */ }
  };
  return <header className="titlebar" data-tauri-drag-region><span className="lights"><button type="button" aria-label="Close window" onClick={() => void windowAction('close')}><i /></button><button type="button" aria-label="Minimize window" onClick={() => void windowAction('minimize')}><i /></button><button type="button" aria-label="Toggle window size" onClick={() => void windowAction('toggleMaximize')}><i /></button></span><span className="tb-word">zega <span className="v">{graph}</span></span><span className="tb-sp" /><a className="settings-link" href="/settings/" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 3-.7 2.5-2.3 1L3.7 6 2 9l1.8 1.8v2.4L2 15l1.7 3 2.3-.5 2.3 1L9 21h6l.7-2.5 2.3-1 2.3.5 1.7-3-1.8-1.8v-2.4L22 9l-1.7-3-2.3.5-2.3-1L15 3Z"/><circle cx="12" cy="12" r="3"/></svg></a><button className="sign-in" type="button">Sign in</button><div className="signed-in" data-auth-signed-in hidden><img data-auth-avatar alt="" width="22" height="22" hidden /><span data-auth-name /><button data-auth-signout type="button">Sign out</button></div></header>;
}
