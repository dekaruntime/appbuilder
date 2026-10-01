'use client';
import { useEffect, useRef, useState } from 'react';
import { compileInWorker } from '../lib/sketch/worker-client';

// A sketch running as HTML: compiled in a worker, shown in a sandboxed iframe
// with no same-origin access and a no-network CSP. Laid out at the window's
// real size and scaled to fit, like the deka preview.
export default function SketchPreview({ sketch, width, height, zoom, reload = 0, onStatus }: {
  sketch: string; width: number; height: number; zoom: number; reload?: number;
  onStatus?: (status: { kind: 'ok' } | { kind: 'runtime'; error: string }) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The sketch's runtime says "ready" once it has drawn. If it never does
  // (blocked or broken), say so instead of leaving a blank window.
  const [started, setStarted] = useState(false);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStarted(false); setStalled(false);
    if (!html) return;
    const timer = setTimeout(() => setStalled(true), 1500);
    return () => clearTimeout(timer);
  }, [html, reload]);
  const frame = useRef<HTMLIFrameElement>(null);
  const report = useRef(onStatus);
  report.current = onStatus;

  useEffect(() => {
    let live = true;
    compileInWorker(sketch).then(result => { if (live) { setHtml(result.html); setFailure(null); } }).catch(error => { if (live) setFailure(String(error instanceof Error ? error.message : error)); });
    return () => { live = false; };
  }, [sketch, reload]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.zegaSketch) return;
      if (event.data.zegaSketch === 'ready') setStarted(true);
      report.current?.(event.data.zegaSketch === 'error' ? { kind: 'runtime', error: event.data.detail } : { kind: 'ok' });
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

  return <div className="sketch-preview" style={{ width: width * zoom, height: height * zoom }}>
    {html && <iframe ref={frame} key={reload} title="Sketch" sandbox="allow-scripts" srcDoc={html}
      style={{ width, height, transform: `scale(${zoom})`, transformOrigin: '0 0' }} />}
    {failure && <p className="deka-preview-status" role="status">{failure}</p>}
    {!failure && stalled && !started && <p className="deka-preview-status" role="status">This sketch couldn't start. Try the refresh button below; if it stays blank, tell us what you asked for.</p>}
    <span className="sketch-badge" title="This is a sketch: it runs as HTML. Make it real to run it on deka.">Sketch</span>
  </div>;
}
