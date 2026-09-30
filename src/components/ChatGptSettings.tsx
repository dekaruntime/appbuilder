'use client';
import { useEffect, useRef, useState } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type ChatGptView = { status: 'signed_out' | 'pending' | 'signed_in'; email: string | null; error: string | null };
type Model = { slug: string; display_name: string };
type AskEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'completed' }
  | { kind: 'failed'; code: string | null; message: string; usage_limited: boolean };

// Sign in with ChatGPT (developers.openai.com/siwc): answers run on the
// user's own ChatGPT plan. The copy below ("Continue with ChatGPT", the
// welcome line, "Using ChatGPT plan", "Manage usage") is OpenAI's required
// wording. Only the typed question is sent; nothing from the computer graph.
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const openUsage = () => { void invoke('plugin:opener|open_url', { url: USAGE_URL }).catch(() => {}); };

export default function ChatGptSettings() {
  const [view, setView] = useState<ChatGptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Extract<AskEvent, { kind: 'failed' }> | null>(null);
  const signedIn = view?.status === 'signed_in';
  const answerId = useRef(0);

  const refresh = async () => {
    try { setView(await invoke<ChatGptView>('chatgpt_status')); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  useEffect(() => {
    if (!isTauri()) return;
    void refresh();
    const stop = listen('chatgpt-changed', () => void refresh());
    return () => { void stop.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!signedIn) { setModels([]); return; }
    invoke<Model[]>('chatgpt_models')
      .then(list => { setModels(list); setModel(current => list.some(m => m.slug === current) ? current : list[0]?.slug ?? ''); })
      .catch(reason => setError(String(reason)));
  }, [signedIn]);

  const run = async (command: string) => {
    try { setView(await invoke<ChatGptView>(command)); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  const ask = async () => {
    if (!question.trim() || !model || asking) return;
    const id = ++answerId.current;
    setAsking(true); setAnswer(''); setFailure(null); setError(null);
    const channel = new Channel<AskEvent>();
    channel.onmessage = event => {
      if (id !== answerId.current) return;
      if (event.kind === 'delta') setAnswer(text => text + event.text);
      else if (event.kind === 'failed') setFailure(event);
    };
    try { await invoke('chatgpt_ask', { question, model, onEvent: channel }); }
    catch (reason) { setError(String(reason)); }
    finally { if (id === answerId.current) setAsking(false); }
  };

  if (!view && !error) return null;
  return <section className="settings-section chatgpt-settings" aria-labelledby="chatgpt-title">
    <h2 id="chatgpt-title">ChatGPT</h2>
    {!signedIn && <>
      <p>Answer questions with your ChatGPT plan. Only the question you type is sent to ChatGPT; nothing on this computer is shared.</p>
      {view?.status === 'pending'
        ? <p role="status">Finish signing in in your browser. <button type="button" className="chatgpt-link" onClick={() => void run('chatgpt_cancel')}>Cancel</button></p>
        : <button type="button" className="chatgpt-continue" onClick={() => void run('chatgpt_start')}>Continue with ChatGPT</button>}
    </>}
    {signedIn && <>
      <p>Eligible usage in this app uses your ChatGPT plan. Manage usage in your <button type="button" className="chatgpt-link" onClick={openUsage}>ChatGPT settings</button>.</p>
      <p role="status">Connected{view?.email ? ` as ${view.email}` : ''} · <button type="button" className="chatgpt-link" onClick={() => void run('chatgpt_disconnect')}>Disconnect</button></p>
      <form className="chatgpt-ask" onSubmit={event => { event.preventDefault(); void ask(); }}>
        <textarea aria-label="Ask ChatGPT" placeholder="Ask anything…" rows={3} value={question} onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask(); } }} />
        <div className="chatgpt-row">
          <select aria-label="Model" value={model} onChange={event => setModel(event.target.value)} disabled={!models.length}>
            {models.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}
          </select>
          <small>Using ChatGPT plan · <button type="button" className="chatgpt-link" onClick={openUsage}>Usage</button></small>
          <button type="submit" disabled={asking || !question.trim() || !model}>{asking ? 'Answering…' : 'Ask'}</button>
        </div>
      </form>
      {answer && <div className="chatgpt-answer" aria-live="polite">{answer}</div>}
      {failure && <p role="alert">{failure.message}{failure.usage_limited && <> <button type="button" className="chatgpt-continue" onClick={openUsage}>Manage usage</button></>}</p>}
    </>}
    {(error || view?.error) && <p role="alert">{error || view?.error}</p>}
  </section>;
}
