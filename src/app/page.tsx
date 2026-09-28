'use client';

import ShortcutHint from '../components/ShortcutHint';

import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

type LocalFile = { name: string; location: string; fileType: string; modifiedLabel: string; path: string };
type LocalPhoto = { name: string; path: string };
type LocalPane = { label: string; icon: string; bundleId: string };

export default function Home() {
  const [graph, setGraph] = useState('computer');
  const [greeting, setGreeting] = useState('');
  const [query, setQuery] = useState('');
  const [screen, setScreen] = useState<'landing' | 'results'>('landing');
  const [files, setFiles] = useState<LocalFile[] | null>(null);
  const [settings, setSettings] = useState<LocalPane[]>([]);
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [photoAccess, setPhotoAccess] = useState<'checking' | 'required' | 'ready' | 'error'>('checking');
  const [requestingAccess, setRequestingAccess] = useState(false);

  const refreshPhotos = async () => {
    const granted = await invoke<boolean>('local_pictures_access_granted');
    if (!granted) { setPhotoAccess('required'); return; }
    try {
      setPhotos(await invoke<LocalPhoto[]>('local_recent_photos'));
      setPhotoAccess('ready');
    } catch {
      setPhotoAccess('error');
    }
  };

  useEffect(() => {
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    if (!isTauri()) {
      setGreeting(timeGreeting);
      setFiles([]);
      setPhotoAccess('ready');
      return;
    }
    void Promise.all([
      invoke<LocalFile[]>('local_recent_files'),
      invoke<LocalPane[]>('local_settings_panes'),
      invoke<string | null>('local_user_first_name'),
    ]).then(([recent, panes, firstName]) => {
      setFiles(recent);
      setSettings(panes);
      setGreeting(firstName ? `${timeGreeting}, ${firstName}` : timeGreeting);
    }).catch(() => {
      setFiles([]);
      setGreeting(timeGreeting);
    });
    void refreshPhotos().catch(() => setPhotoAccess('required'));
  }, []);

  const windowAction = async (action: 'close' | 'minimize' | 'toggleMaximize') => {
    try { await getCurrentWindow()[action](); } catch { /* Browser preview has no native window. */ }
  };
  const openSettings = (pane: LocalPane) => {
    void invoke('open_settings_pane', { bundleId: pane.bundleId }).catch(() => {});
  };
  const search = () => setScreen('results');
  const requestPhotos = async () => {
    setRequestingAccess(true);
    try {
      if (await invoke<boolean>('request_pictures_access')) await refreshPhotos();
    } catch {
      setPhotoAccess('error');
    } finally {
      setRequestingAccess(false);
    }
  };
  const visibleFiles = useMemo(() => (files ?? []).filter(file => `${file.name} ${file.location}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [files, query]);
  const visibleSettings = useMemo(() => settings.filter(pane => pane.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [query, settings]);
  const visiblePhotos = useMemo(() => photos.filter(photo => photo.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [photos, query]);
  const fileClass = (kind: string) => ({ KEY: 'key', PDF: 'pdf', XLS: 'xls', NUMBERS: 'xls', FIG: 'fig', TXT: 'txt', DOC: 'doc' }[kind.toUpperCase()] || 'txt');
  const searchBox = () => <form className="search" role="search" onSubmit={event => { event.preventDefault(); search(); }}>
    <span className={`ph ${query ? 'typed' : ''}`}>{query || <>Ask <span className="v">{graph}</span> anything…</>}</span>
    <input aria-label={`Ask ${graph} anything`} placeholder={`Ask ${graph} anything…`} value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" />
    <ShortcutHint /><button className="round go" aria-label="Search">→</button>
  </form>;
  const photoShelf = <div className="shelf"><h3>Recent photos</h3>{photoAccess === 'checking' ? <div className="skeleton" aria-label="Loading recent photos" /> : photoAccess === 'required' ? <div className="empty"><p>Allow access to your Pictures folder to show recent photos. Your photos stay on this Mac.</p><button type="button" disabled={requestingAccess} onClick={() => void requestPhotos()}>{requestingAccess ? 'Waiting for permission…' : 'Choose Pictures folder'}</button></div> : photoAccess === 'error' ? <div className="empty"><p>Photos could not be loaded from Pictures.</p><button type="button" onClick={() => void refreshPhotos()}>Try again</button></div> : photos.length ? <div className="photos">{photos.map(photo => <figure className="photo-tile" key={photo.path}><img src={convertFileSrc(photo.path)} alt={photo.name} /><figcaption>{photo.name}</figcaption></figure>)}</div> : <p className="empty">No recent photos yet.</p>}</div>;

  return <main className="stage"><div className="window">
    <header className="titlebar" data-tauri-drag-region><span className="lights"><button type="button" aria-label="Close window" onClick={() => void windowAction('close')}><i /></button><button type="button" aria-label="Minimize window" onClick={() => void windowAction('minimize')}><i /></button><button type="button" aria-label="Toggle window size" onClick={() => void windowAction('toggleMaximize')}><i /></button></span><span className="tb-word">zega <span className="v">{graph}</span></span><span className="tb-sp" /><button className="sign-in" type="button">Sign in</button><div className="signed-in" data-auth-signed-in hidden><img data-auth-avatar alt="" width="22" height="22" hidden /><span data-auth-name /><button data-auth-signout type="button">Sign out</button></div></header>
    <div className="app"><nav className="rail" aria-label="Graphs">
      {['computer', 'earth', 'hockey', 'film'].map((name, index) => <button key={name} type="button" aria-pressed={graph === name} aria-label={name} title={name} onClick={() => setGraph(name)}>{['▣', '◎', '⌁', '▤'][index]}</button>)}<button className="plus" style={{ marginTop: 'auto', borderStyle: 'dashed' }} aria-label="Add a graph">+</button>
    </nav><div className="content"><section className="screen landing"><div className="hello"><h2>{greeting}</h2><p>Everything on this Mac, in one graph. Nothing leaves it.</p></div>{searchBox()}
      {screen === 'landing' ? <div className="shelves"><div className="shelf"><h3>Recent files</h3><div className="rows">{files === null ? <div className="skeleton" aria-label="Loading recent files" /> : visibleFiles.length ? visibleFiles.map(file => <button className="row file-row" key={file.path} type="button" onDoubleClick={() => void invoke('open_local_file', { path: file.path })}><span className={`fi ${fileClass(file.fileType)}`}>{file.fileType.slice(0, 3).toUpperCase()}</span><span><b>{file.name}</b><small>{file.location}</small></span><span className="when">{file.modifiedLabel}</span></button>) : <p className="empty">No recent files yet.</p>}</div></div>{photoShelf}<div className="quick" aria-label="Settings">{settings.map(pane => <button key={pane.bundleId} type="button" onClick={() => openSettings(pane)}><span aria-hidden="true">{pane.icon}</span>{pane.label}</button>)}</div></div> : <div className="res"><div className="groups">{visibleFiles.length > 0 && <section className="grp"><h3>Files <small>{visibleFiles.length} results</small></h3>{visibleFiles.map(file => <button className="row file-row" key={file.path} type="button" onDoubleClick={() => void invoke('open_local_file', { path: file.path })}><span className={`fi ${fileClass(file.fileType)}`}>{file.fileType.slice(0, 3).toUpperCase()}</span><span><b>{file.name}</b><small>{file.location}</small></span></button>)}</section>}{visibleSettings.length > 0 && <section className="grp"><h3>Settings <small>{visibleSettings.length} destinations</small></h3>{visibleSettings.map(pane => <button className="setrow" key={pane.bundleId} type="button" onClick={() => openSettings(pane)}><span className="gear">{pane.icon}</span><b>{pane.label}</b><span className="open">Open ↗</span></button>)}</section>}{visiblePhotos.length > 0 && <section className="grp"><h3>Photos <small>{visiblePhotos.length} results</small></h3><div className="pgrid">{visiblePhotos.map(photo => <img className="photo-result" key={photo.path} src={convertFileSrc(photo.path)} alt={photo.name} />)}</div></section>}{!visibleFiles.length && !visibleSettings.length && !visiblePhotos.length && <p className="empty">No local matches.</p>}</div></div>}
    </section></div></div>
  </div></main>;
}
