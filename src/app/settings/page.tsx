'use client';
import AppTitlebar from '../../components/AppTitlebar';
import ChatGptSettings from '../../components/ChatGptSettings';
import IndexSettings from '../../components/IndexSettings';
import ShortcutHint from '../../components/ShortcutHint';
import UpdateSettings from '../../components/UpdateSettings';

export default function SettingsPage() {
  return <main className="stage"><div className="window">
    <AppTitlebar />
    <section className="settings-page" aria-labelledby="settings-title">
      <a className="settings-back" href="/">← Back to search</a>
      <h1 id="settings-title">Settings</h1>
      <section className="settings-section" aria-labelledby="shortcut-title">
        <h2 id="shortcut-title">Search shortcut</h2>
        <p>Open zega from another app. Select the shortcut to change or test it.</p>
        <ShortcutHint />
      </section>
      <ChatGptSettings />
      <IndexSettings />
      <UpdateSettings />
    </section>
  </div></main>;
}
