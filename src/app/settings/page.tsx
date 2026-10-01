'use client';
import TimingCorner from '../../components/TimingCorner';
import AppTitlebar from '../../components/AppTitlebar';
import BuilderSettings from '../../components/BuilderSettings';
import ChatGptSettings from '../../components/ChatGptSettings';
import IndexSettings from '../../components/IndexSettings';
import ShortcutHint from '../../components/ShortcutHint';
import UpdateSettings from '../../components/UpdateSettings';

export default function SettingsPage() {
  return <main className="stage"><div className="window">
    <AppTitlebar />
    <div className="settings-scroll">
    <section className="settings-page" aria-labelledby="settings-title">
      <a className="settings-back" href="/">← Back to the builder</a>
      <h1 id="settings-title">Settings</h1>
      <section className="settings-section" aria-labelledby="shortcut-title">
        <h2 id="shortcut-title">Search shortcut</h2>
        <p>Open zega from another app. Select the shortcut to change or test it.</p>
        <ShortcutHint />
      </section>
      <BuilderSettings />
      <ChatGptSettings />
      <IndexSettings />
      <UpdateSettings />
    </section>
    </div>
    <TimingCorner />
  </div></main>;
}
