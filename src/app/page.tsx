'use client';

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function Home() {
  const [graph, setGraph] = useState('computer');
  const [greeting, setGreeting] = useState('');
  const [query, setQuery] = useState('');
  const windowAction = async (action: 'close' | 'minimize' | 'toggleMaximize') => {
    try { await getCurrentWindow()[action](); } catch { /* Browser preview has no native window. */ }
  };
  useEffect(() => {
    const hour = new Date().getHours();
    setGreeting(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
  }, []);

  return <main className="stage"><div className="window">
    <header className="titlebar" data-tauri-drag-region><span className="lights"><button type="button" aria-label="Close window" onClick={() => void windowAction('close')}><i /></button><button type="button" aria-label="Minimize window" onClick={() => void windowAction('minimize')}><i /></button><button type="button" aria-label="Toggle window size" onClick={() => void windowAction('toggleMaximize')}><i /></button></span><span className="tb-word">zega <span className="v">{graph}</span></span><span className="tb-sp" /><button className="sign-in" type="button">Sign in</button><div className="signed-in" data-auth-signed-in hidden><img data-auth-avatar alt="" width="22" height="22" hidden /><span data-auth-name /><button data-auth-signout type="button">Sign out</button></div></header>
    <div className="app"><nav className="rail" aria-label="Graphs">
      {['computer', 'earth', 'hockey', 'film'].map((name, index) => <button key={name} type="button" aria-pressed={graph === name} aria-label={name} title={name} onClick={() => setGraph(name)}>{['▣', '◎', '⌁', '▤'][index]}</button>)}<button className="plus" style={{ marginTop: 'auto', borderStyle: 'dashed' }} aria-label="Add a graph">+</button>
    </nav><div className="content"><section className="screen landing"><div className="hello"><h2>{greeting}</h2><p>Everything on this Mac, in one graph. Nothing leaves it.</p></div>
      <form className="search" role="search" onSubmit={event => event.preventDefault()}><span className={`ph ${query ? 'typed' : ''}`}>{query || <>Ask <span className="v">{graph}</span> anything…</>}</span><input aria-label={`Ask ${graph} anything`} placeholder={`Ask ${graph} anything…`} value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" /><span className="kbd">⌘⌥ Space</span><button className="round go" aria-label="Search">→</button></form>
      <div className="shelves"><div className="shelf"><h3>Recent files</h3><div className="rows"><p className="empty">No recent files yet.</p></div></div>
        <div className="shelf"><h3>Recent photos</h3><p className="empty">Allow zega to access your Pictures folder to show recent photos.</p></div></div>
    </section></div></div>
  </div></main>;
}
