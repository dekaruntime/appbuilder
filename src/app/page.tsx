'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

type LocalFile = { name: string; location: string; fileType: string; modifiedLabel: string; path: string };
type LocalPane = { label: string; icon: string; bundleId: string };

const sampleFiles = [
  ['KEY', 'key', 'zega pitch — Sept.key', 'Documents › zega', '12 min ago'],
  ['PDF', 'pdf', 'Lisbon itinerary.pdf', 'Downloads', 'Yesterday'],
  ['XLS', 'xls', 'Budget 2026.numbers', 'Documents › Money', 'Tue'],
  ['FIG', 'fig', 'search results v10.fig', 'Desktop', 'Mon'],
  ['TXT', 'txt', 'notes — desktop fork.md', 'Documents › zega', 'Mon'],
];
const samplePanes: LocalPane[] = [
  { label: 'Dark mode', icon: '◐', bundleId: '' },
  { label: 'Sound', icon: '🔈', bundleId: '' },
  { label: 'Displays', icon: '▭', bundleId: '' },
  { label: 'Wi-Fi', icon: '⌁', bundleId: '' },
];
const photos = [['Sunset','#F0B35B,#C8553D'],['Lisbon','#6FB1C9,#2E5E7E'],['Bow River','#A7C38A,#4E7A43'],['Studio','#D9D2C3,#8C7E68'],['Flowers','#E3A9B5,#9B4F6B'],['Porto','#9FB3D9,#44547E'],['Canola','#F2D68A,#C99A2E'],['Snow','#B9C4C9,#5F6B72']];

export default function Home() {
  const [graph, setGraph] = useState('computer');
  const [screen, setScreen] = useState<'landing'|'results'|'add'|'launcher'>('landing');
  const [query, setQuery] = useState('');
  const [prior, setPrior] = useState<'landing'|'results'|'add'>('landing');
  const [native, setNative] = useState(false);
  const [localFiles, setLocalFiles] = useState<LocalFile[]>([]);
  const [settings, setSettings] = useState<LocalPane[]>([]);
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
  useEffect(() => {
    if (!isTauri()) return;
    setNative(true);
    void Promise.all([
      invoke<LocalFile[]>('local_recent_files'),
      invoke<LocalPane[]>('local_settings_panes'),
    ]).then(([recent, panes]) => {
      setLocalFiles(recent);
      setSettings(panes);
    }).catch(() => {
      setLocalFiles([]);
      setSettings([]);
    });
  }, []);
  const displayFiles: (LocalFile | (typeof sampleFiles)[number])[] = native ? localFiles : sampleFiles;
  const displaySettings = native ? settings : samplePanes;
  const openFile = (path: string) => { void invoke('open_local_file', { path }).catch(() => {}); };
  const openSettings = (pane: LocalPane) => {
    if (pane.bundleId) void invoke('open_settings_pane', { bundleId: pane.bundleId }).catch(() => {});
  };
  const fileClass = (kind: string) => ({ KEY: 'key', PDF: 'pdf', XLS: 'xls', NUMBERS: 'xls', FIG: 'fig', TXT: 'txt', DOC: 'doc' }[kind.toUpperCase()] || 'txt');
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
        <div className="shelf"><h3>Recent files <a href="#files">All files</a></h3><div className="rows">{displayFiles.length ? displayFiles.map(file=>{
          const real = 'fileType' in file;
          const [tag,cls,name,path,when] = real ? [file.fileType,fileClass(file.fileType),file.name,file.location,file.modifiedLabel] : file;
          return <button className="row file-row" key={real ? file.path : name} type="button" onDoubleClick={()=>real && openFile(file.path)} aria-label={`Open ${name}`}><span className={`fi ${cls}`}>{tag.slice(0,3).toUpperCase()}</span><span><b>{name}</b><small>{path}</small></span><span className="when">{when}</span></button>;
        }) : <p className="empty">No files modified in the last seven days.</p>}</div></div>
        <div className="shelf"><h3>Recent photos <small>Preview placeholder</small><a href="#photos">All photos</a></h3><div className="photos">{photos.map(([name,colors])=><div key={name} className="ph-tile" style={{background:`linear-gradient(135deg,${colors})`}}><span>{name}</span></div>)}</div><div className="quick" aria-label="Settings">{displaySettings.map(pane=><button key={pane.label} type="button" onClick={()=>openSettings(pane)}><span aria-hidden="true">{pane.icon}</span>{pane.label}</button>)}</div></div>
      </div></section>}
      {screen==='results' && <section className="screen"><div className="res-top">{searchBox()}<button onClick={()=>setScreen('landing')}>×</button></div><div className="kinds"><span className="on">All <em>12</em></span><span>Files <em>5</em></span><span>Settings <em>3</em></span><span>Photos <em>4</em></span></div><div className="res"><div className="groups"><section className="grp"><h3>Files <small>{displayFiles.length} results</small></h3>{displayFiles.slice(0,3).map(file=>{
        const real = 'fileType' in file;
        const [tag,cls,name,path] = real ? [file.fileType,fileClass(file.fileType),file.name,file.location] : file;
        return <button className="row file-row" key={real ? file.path : name} type="button" onDoubleClick={()=>real && openFile(file.path)}><span className={`fi ${cls}`}>{tag.slice(0,3).toUpperCase()}</span><span><b>{name}</b><small>{path}</small></span></button>;
      })}</section><section className="grp"><h3>Settings <small>{displaySettings.length} destinations</small></h3>{displaySettings.map(pane=><button className="setrow" key={pane.label} type="button" onClick={()=>openSettings(pane)}><span className="gear">{pane.icon}</span><b>{pane.label}</b><span className="open">Open ↗</span></button>)}</section><section className="grp"><h3>Photos <small>Placeholder</small></h3><div className="pgrid">{photos.slice(0,6).map(([n,c])=><div className="ph-tile" key={n} style={{background:`linear-gradient(135deg,${c})`}}><span>{n}</span></div>)}</div></section></div><aside className="web"><h3>Search transparency</h3><p>Your search stays on this Mac.</p></aside></div></section>}
      {screen==='add' && <section className="screen addg"><div className="add-head"><h2>Add a graph</h2><p>Choose a graph to connect to zega. Your computer graph stays local.</p></div><div className="add-cols"><div><h3 className="sub">Available graphs</h3><div className="gcards">{[['earth','◎','The world around you'],['hockey','⌁','Hockey, at a glance'],['film','▤','Movies and shows']].map(([n,ic,d])=><div className="gcard" key={n}><span className="gi2">{ic}</span><b>{n}</b><small>{d}</small><button onClick={()=>setGraph(n)}>Add graph</button></div>)}</div></div><div className="create"><h3 className="sub">Create a graph</h3><label className="fld"><span>Name</span><input className="inp" placeholder="e.g. recipes"/></label><button className="make">Create graph</button></div></div><button onClick={()=>setScreen('landing')}>Back</button></section>}
    </div></div>
  </div>{screen==='launcher' && <div className="launcher-window"><div className="launch-head"><span>zega <span className="v">{graph}</span></span><span>⌥ Space</span></div>{searchBox(true)}<div className="lrows">{['Wi-Fi · Settings','Displays · Settings','Lisbon itinerary.pdf · Downloads'].map((x,i)=><div className={`lrow ${i===0?'sel':''}`} key={x}><b>{x.split(' · ')[0]}</b><small>{x.split(' · ')[1]}</small><span className="hint">↵</span></div>)}</div><div className="lfoot"><span>↑↓ Navigate</span><span>↵ Open</span><span>esc Close</span></div></div>}</main>;
}
