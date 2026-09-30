'use client';
import TimingCorner from '../components/TimingCorner';

import ShortcutHint from '../components/ShortcutHint';
import AppTitlebar from '../components/AppTitlebar';
import SearchBar from '../components/SearchBar';
import GraphResults from '../components/GraphResults';
import EarthResults from '../components/EarthResults';
import { EARTH_GRAPHS, useEarthSearch } from '../lib/earth-search';
import { useGraphSearch } from '../lib/index-search';

import { useEffect, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';

type LocalFile = { key: string; name: string; location: string; fileType: string; modifiedLabel: string; path: string };
type LocalPhoto = { name: string; path: string };
type LocalPane = { label: string; icon: string; bundleId: string };

export default function Home() {
  const [graph, setGraph] = useState('computer');
  const [greeting, setGreeting] = useState('');
  const [query, setQuery] = useState('');
  const [screen, setScreen] = useState<'landing' | 'results'>('landing');
  const onEarth = EARTH_GRAPHS.has(graph);
  const graphSearch = useGraphSearch(graph === 'computer' ? query : '');
  const earthSearch = useEarthSearch(query, onEarth);
  const recentSearch = useGraphSearch('');
  const files: LocalFile[] | null = recentSearch.loading ? null : recentSearch.results.filter(row => row.kind === 'files').slice(0, 5).map(row => ({ key: row.key, name: row.name, path: row.path, location: row.path, fileType: row.path.split('.').pop() || 'file', modifiedLabel: row.offline ? 'Offline' : '' }));
  const [settings, setSettings] = useState<LocalPane[]>([]);
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [photoAccess, setPhotoAccess] = useState<'checking' | 'required' | 'ready' | 'error'>('checking');
  const [requestingAccess, setRequestingAccess] = useState(false);

  const refreshPhotos = async () => {
    const granted = await invoke<boolean>('local_pictures_access_granted');
    if (!granted) { setPhotoAccess('required'); return; }
    try {
      const rows = await invoke<import('../lib/index-search').GraphResult[]>('index_search', { query: 'photos' });
      setPhotos(rows.filter(row => !row.offline).slice(0, 6));
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
      setPhotoAccess('ready');
      return;
    }
    void Promise.all([
      invoke<LocalPane[]>('local_settings_panes'),
      invoke<string | null>('local_user_first_name'),
    ]).then(([panes, firstName]) => {
      setSettings(panes);
      setGreeting(firstName ? `${timeGreeting}, ${firstName}` : timeGreeting);
    }).catch(() => {
      setGreeting(timeGreeting);
    });
    void refreshPhotos().catch(() => setPhotoAccess('required'));
  }, []);

  useEffect(() => {
    if (photoAccess === 'ready') setPhotos(recentSearch.results.filter(row => row.kind === 'photos' && !row.offline && /[\\/]Pictures[\\/]/.test(row.path)).slice(0, 6));
  }, [recentSearch.results, photoAccess]);

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
  const visibleFiles = files ?? [];
  const fileClass = (kind: string) => ({ KEY: 'key', PDF: 'pdf', XLS: 'xls', NUMBERS: 'xls', FIG: 'fig', TXT: 'txt', DOC: 'doc' }[kind.toUpperCase()] || 'txt');
  const searchBox = () => <SearchBar value={query} placeholder={`Ask ${graph} anything…`} onChange={value => { setQuery(value); setScreen(value ? 'results' : 'landing'); }} onSubmit={search}>
    <ShortcutHint /><button className="round go" aria-label="Search">→</button>
  </SearchBar>;
  const photoShelf = <div className="shelf"><h3>Recent photos</h3>{photoAccess === 'checking' ? <div className="skeleton" aria-label="Loading recent photos" /> : photoAccess === 'required' ? <div className="empty"><p>Allow access to your Pictures folder to show recent photos. Your photos stay on this computer.</p><button type="button" disabled={requestingAccess} onClick={() => void requestPhotos()}>{requestingAccess ? 'Waiting for permission…' : 'Choose Pictures folder'}</button></div> : photoAccess === 'error' ? <div className="empty"><p>Photos could not be loaded from Pictures.</p><button type="button" onClick={() => void refreshPhotos()}>Try again</button></div> : photos.length ? <div className="photos">{photos.map(photo => <figure className="photo-tile" key={photo.path}><img src={convertFileSrc(photo.path)} alt={photo.name} /><figcaption>{photo.name}</figcaption></figure>)}</div> : <p className="empty">No recent photos yet.</p>}</div>;

  return <main className="stage"><div className="window">
    <AppTitlebar graph={graph} />
    <div className="app"><nav className="rail" aria-label="Graphs">
      {['computer', 'earth', 'hockey', 'film'].map((name, index) => <button key={name} type="button" aria-pressed={graph === name} aria-label={name} title={name} onClick={() => setGraph(name)}>{['▣', '◎', '⌁', '▤'][index]}</button>)}<button className="plus" style={{ marginTop: 'auto', borderStyle: 'dashed' }} aria-label="Add a graph">+</button>
    </nav><div className="content"><section className="screen landing"><div className="hello"><h2>{greeting}</h2><p>Everything on this computer, in one graph. Nothing leaves it.</p></div>{searchBox()}
      {screen === 'landing' ? <div className="shelves"><div className="shelf"><h3>Recent files</h3><div className="rows">{files === null ? <div className="skeleton" aria-label="Loading recent files" /> : visibleFiles.length ? visibleFiles.map(file => <button className="row file-row" key={file.path} type="button" onDoubleClick={() => void invoke('index_open_result', { key: file.key })}><span className={`fi ${fileClass(file.fileType)}`}>{file.fileType.slice(0, 3).toUpperCase()}</span><span><b>{file.name}</b><small>{file.location}</small></span><span className="when">{file.modifiedLabel}</span></button>) : <p className="empty">No recent files yet.</p>}</div></div>{photoShelf}<div className="quick" aria-label="Settings">{settings.map(pane => <button key={pane.bundleId} type="button" onClick={() => openSettings(pane)}><span aria-hidden="true">{pane.icon}</span>{pane.label}</button>)}</div></div> : onEarth ? <EarthResults graph={graph} {...earthSearch} /> : graph === 'computer' ? <GraphResults {...graphSearch} photoPreviews={photoAccess === 'ready'} /> : <div className="res"><p className="empty">The {graph} graph isn't on zega.earth yet.</p></div>}
    </section></div></div>
    <TimingCorner />
  </div></main>;
}
