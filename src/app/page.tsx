'use client';

import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const files = [
  ['KEY', 'key', 'zega pitch — Sept.key', 'Documents › zega', '12 min ago'],
  ['PDF', 'pdf', 'Lisbon itinerary.pdf', 'Downloads', 'Yesterday'],
  ['XLS', 'xls', 'Budget 2026.numbers', 'Documents › Money', 'Tue'],
  ['FIG', 'fig', 'search results v10.fig', 'Desktop', 'Mon'],
  ['TXT', 'txt', 'notes — desktop fork.md', 'Documents › zega', 'Mon'],
];
const photos = [['Sunset','#F0B35B,#C8553D'],['Lisbon','#6FB1C9,#2E5E7E'],['Bow River','#A7C38A,#4E7A43'],['Studio','#D9D2C3,#8C7E68'],['Flowers','#E3A9B5,#9B4F6B'],['Porto','#9FB3D9,#44547E'],['Canola','#F2D68A,#C99A2E'],['Snow','#B9C4C9,#5F6B72']];

export default function Home() {
  const [graph, setGraph] = useState('computer');
  const [screen, setScreen] = useState<'landing'|'results'|'add'|'launcher'>('landing');
  const [query, setQuery] = useState('');
  const [prior, setPrior] = useState<'landing'|'results'|'add'>('landing');
  const input = useRef<HTMLInputElement>(null);
  const windowAction = async (action: 'close' | 'minimize' | 'toggleMaximize') => {
    try { await getCurrentWindow()[action](); } catch { /* Browser preview has no native window. */ }
  };
  const search = () => { setScreen('results'); };
  const launch = () => { setPrior(screen === 'launcher' ? 'landing' : screen); setScreen('launcher'); setTimeout(() => input.current?.focus(), 0); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.altKey && event.code === 'Space') { event.preventDefault(); launch(); }
      if (event.key === 'Escape') setScreen(screen === 'launcher' ? prior : 'landing');
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [screen, prior]);
  const searchBox = (floating = false) => <form className="search" role="search" onSubmit={e => {e.preventDefault();search();}}>
    <span className={`ph ${query ? 'typed' : ''}`}>{query || <>Ask <span className="v">{graph}</span> anything…</>}</span>
    <input ref={floating ? input : undefined} aria-label={`Ask ${graph} anything`} placeholder={`Ask ${graph} anything…`} value={query} onChange={e=>setQuery(e.target.value)} autoComplete="off" />
    {!floating && <span className="kbd">⌥ Space</span>}
    <button className="round" type="button" aria-label="Speak">🎙</button><button className="round go" aria-label="Search">→</button>
  </form>;
  return <main className="stage"><div className="window">
    <header className="titlebar" data-tauri-drag-region><span className="lights"><button type="button" aria-label="Close window" onClick={()=>void windowAction('close')}><i/></button><button type="button" aria-label="Minimize window" onClick={()=>void windowAction('minimize')}><i/></button><button type="button" aria-label="Toggle window size" onClick={()=>void windowAction('toggleMaximize')}><i/></button></span><span className="tb-word">zega <span className="v">{graph}</span></span><span className="tb-sp"/><button className="sign-in" type="button">Sign in</button><div className="signed-in" data-auth-signed-in hidden><img data-auth-avatar alt="" width="22" height="22" hidden/><span data-auth-name/><button data-auth-signout type="button">Sign out</button></div></header>
    <div className="app"><nav className="rail" aria-label="Graphs">
      {['computer','earth','hockey','film'].map((g,i)=><button key={g} type="button" aria-pressed={graph===g} aria-label={g} title={g} onClick={()=>{setGraph(g);setScreen('landing');}}>{['▣','◎','⌁','▤'][i]}</button>)}<button className="plus" style={{marginTop:'auto',borderStyle:'dashed'}} aria-label="Add a graph" onClick={()=>setScreen('add')}>+</button>
    </nav><div className="content">
      {screen==='landing' && <section className="screen landing"><div className="hello"><h2>Good afternoon, Sami</h2><p>Everything on this Mac, in one graph. Nothing leaves it.</p></div>{searchBox()}<div className="shelves">
        <div className="shelf"><h3>Recent files <a href="#files">All files</a></h3><div className="rows">{files.map(([tag,cls,name,path,when])=><div className="row" key={name}><span className={`fi ${cls}`}>{tag}</span><span><b>{name}</b><small>{path}</small></span><span className="when">{when}</span></div>)}</div></div>
        <div className="shelf"><h3>Recent photos <a href="#photos">All photos</a></h3><div className="photos">{photos.map(([name,colors])=><div key={name} className="ph-tile" style={{background:`linear-gradient(135deg,${colors})`}}><span>{name}</span></div>)}</div><div className="quick" aria-label="Settings">{['◐ Dark mode','🔈 Sound','▭ Displays','⌁ Wi-Fi'].map(x=><button key={x}>{x}</button>)}</div></div>
      </div></section>}
      {screen==='results' && <section className="screen"><div className="res-top">{searchBox()}<button onClick={()=>setScreen('landing')}>×</button></div><div className="kinds"><span className="on">All <em>12</em></span><span>Files <em>5</em></span><span>Settings <em>3</em></span><span>Photos <em>4</em></span></div><div className="res"><div className="groups"><section className="grp"><h3>Files <small>5 results</small></h3>{files.slice(0,3).map(([tag,cls,name,path])=><div className="row" key={name}><span className={`fi ${cls}`}>{tag}</span><span><b>{name}</b><small>{path}</small></span></div>)}</section><section className="grp"><h3>Settings <small>3 results</small></h3>{['Wi-Fi','Displays','Sound'].map(x=><div className="setrow" key={x}><span className="gear">⚙</span><b>{x}</b><span className="open">Open ↗</span></div>)}</section><section className="grp"><h3>Photos <small>4 results</small></h3><div className="pgrid">{photos.slice(0,6).map(([n,c])=><div className="ph-tile" key={n} style={{background:`linear-gradient(135deg,${c})`}}><span>{n}</span></div>)}</div></section></div><aside className="web"><h3>Search transparency</h3><p>Your search stays on this Mac.</p></aside></div></section>}
      {screen==='add' && <section className="screen addg"><div className="add-head"><h2>Add a graph</h2><p>Choose a graph to connect to zega. Your computer graph stays local.</p></div><div className="add-cols"><div><h3 className="sub">Available graphs</h3><div className="gcards">{[['earth','◎','The world around you'],['hockey','⌁','Hockey, at a glance'],['film','▤','Movies and shows']].map(([n,ic,d])=><div className="gcard" key={n}><span className="gi2">{ic}</span><b>{n}</b><small>{d}</small><button onClick={()=>setGraph(n)}>Add graph</button></div>)}</div></div><div className="create"><h3 className="sub">Create a graph</h3><label className="fld"><span>Name</span><input className="inp" placeholder="e.g. recipes"/></label><button className="make">Create graph</button></div></div><button onClick={()=>setScreen('landing')}>Back</button></section>}
    </div></div>
  </div>{screen==='launcher' && <div className="launcher-window"><div className="launch-head"><span>zega <span className="v">{graph}</span></span><span>⌥ Space</span></div>{searchBox(true)}<div className="lrows">{['Wi-Fi · Settings','Displays · Settings','Lisbon itinerary.pdf · Downloads'].map((x,i)=><div className={`lrow ${i===0?'sel':''}`} key={x}><b>{x.split(' · ')[0]}</b><small>{x.split(' · ')[1]}</small><span className="hint">↵</span></div>)}</div><div className="lfoot"><span>↑↓ Navigate</span><span>↵ Open</span><span>esc Close</span></div></div>}</main>;
}
