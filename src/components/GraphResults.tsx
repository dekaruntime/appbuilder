'use client';
import { useState } from 'react';
import ResultIcon from './ResultIcon';
import { convertFileSrc } from '@tauri-apps/api/core';
import { GraphResult, openGraphResult, resultGroups, resultGroupLabels } from '../lib/index-search';
export default function GraphResults({ results, loading, error, photoPreviews }: { results: GraphResult[]; loading: boolean; error: string | null; photoPreviews: boolean }) {
  const [openError, setOpenError] = useState<string | null>(null);
  const open = async (row: GraphResult) => { try { await openGraphResult(row); setOpenError(null); } catch (error) { setOpenError(String(error)); } };
  return <div className="res"><div className="groups">
    {(error || openError) && <p role="alert">{error || openError}</p>}
    {resultGroups.map(group => {
      const rows = results.filter(row => row.kind === group);
      return rows.length > 0 && <section className="grp" key={group}><h3>{resultGroupLabels[group]} <small>{rows.length} results</small></h3>{group === 'photos' ? <div className="pgrid">{rows.map(row => <button key={row.key} className="photo-result-button" type="button" disabled={row.offline} onClick={() => void open(row)}>{photoPreviews && /[\\/]Pictures[\\/]/.test(row.path) && !row.offline ? <img className="photo-result" src={convertFileSrc(row.path)} alt={row.name} /> : <span aria-hidden="true">▧</span>}<span>{row.name}{row.offline ? ' · Offline' : ''}</span></button>)}</div> : rows.map(row => <button className="row file-row" key={row.key} type="button" disabled={row.offline} onClick={() => void open(row)}><ResultIcon result={row} /><span><b>{row.name}</b><small>{row.path.startsWith('shell:AppsFolder\\') ? 'Application' : row.path}</small></span><span className="when">{row.offline ? 'Offline' : row.detail}</span></button>)}</section>;
    })}
    {loading && <div className="skeleton" aria-label="Searching local graph" />}
    {!loading && !error && !results.length && <p className="empty">No local matches.</p>}
  </div></div>;
}
