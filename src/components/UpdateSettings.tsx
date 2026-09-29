'use client';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

type UpdateStatus = {
  enabled: boolean;
  channel: 'stable' | 'canary';
  currentVersion: string;
  pendingVersion: string | null;
};

// APS 37: canary is an opt-in; the default is stable. Package-manager
// installs (apt, AUR, Homebrew, winget) are updated by the package manager,
// so those builds report enabled: false and this section explains that
// instead of offering a channel choice.
export default function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    invoke<UpdateStatus>('update_status')
      .then(next => {
        if (typeof next?.enabled !== 'boolean' || (next.channel !== 'stable' && next.channel !== 'canary')) throw new Error('Update status unavailable');
        setStatus(next);
      })
      .catch(error => setError(String(error)));
  }, []);
  const choose = async (channel: 'stable' | 'canary') => {
    if (!status || channel === status.channel) return;
    setBusy(true);
    try {
      await invoke('set_update_channel', { channel });
      setStatus({ ...status, channel });
      setError(null);
    }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  if (!status && !error) return null;
  return <section className="settings-section" aria-label="Updates"><h2>Updates</h2>
    {error && <p role="alert">{error}</p>}
    {status && !status.enabled && <p>zega {status.currentVersion} · This install is updated by its package manager.</p>}
    {status?.enabled && <>
      <p role="status">
        zega {status.currentVersion}
        {status.pendingVersion ? ` · ${status.pendingVersion} is ready — restart to update from the menu bar` : ' · Up to date checks run in the background'}
      </p>
      <label><input type="radio" name="update-channel" checked={status.channel === 'stable'} disabled={busy} onChange={() => void choose('stable')} /> Stable</label>{' '}
      <label><input type="radio" name="update-channel" checked={status.channel === 'canary'} disabled={busy} onChange={() => void choose('canary')} /> Canary</label>{' '}
      <small>Canary carries every merge to main before it is promoted to stable.</small>
    </>}
  </section>;
}
