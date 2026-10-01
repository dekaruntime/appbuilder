'use client';
import { useEffect, useRef, useState } from 'react';
import { loadRuntime, NativePreview } from '../lib/deka/runtime';
import { WebGLRenderer, type NativeScene } from '../lib/deka/webgl';
import { runtimeLabel } from '../lib/deka/plain';
import { snapshots } from '../lib/snapshots';
import type { ReactNode } from 'react';

// The live app: DekaScript compiles, runs and lays out in deka's WASM VM, and
// webgl.ts draws the scene (from deka's tour, dekaruntime/website). A source
// that fails to compile leaves the last working app running.
export type PreviewStatus = { kind: 'ok' } | { kind: 'compile'; error: string } | { kind: 'runtime'; error: string };

export default function DekaPreview({ source, width, height, zoom, reload = 0, onStatus, notOpened }: {
  source: string;
  /** The app window's logical size, and how much it is scaled down to fit. */
  width: number; height: number; zoom: number;
  /** Bump to recompile and restart the app with the same source. */
  reload?: number;
  /** Whether the source compiled, and any error while it runs. */
  onStatus?: (status: PreviewStatus) => void;
  /** Shown in the window when no version has opened yet (instead of black). */
  notOpened?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<NativePreview | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Whether any source has compiled yet: until one does, there's no last
  // working app to keep showing, so say why the window is empty.
  const [compiled, setCompiled] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const report = useRef(onStatus);
  report.current = onStatus;
  const size = useRef({ width, height, zoom });
  size.current = { width, height, zoom };

  useEffect(() => {
    const canvas = canvasRef.current!;
    let disposed = false;
    let frame = 0;
    let renderer: WebGLRenderer | undefined;
    let observer: ResizeObserver | undefined;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const draw = () => {
      cancelAnimationFrame(frame); frame = 0;
      const runtime = runtimeRef.current;
      if (!runtime || !renderer || disposed) return;
      try {
        // Layout at the window's real size; raster at the size it is shown.
        const { width, height, zoom } = size.current;
        const scale = Math.min(3, Math.max(0.5, (devicePixelRatio || 1) * zoom));
        const scene: NativeScene = JSON.parse(runtime.frame_at(width, height, scale, performance.now(), motion.matches));
        renderer.draw(scene, scale);
        if (scene.animating) frame = requestAnimationFrame(draw);
      } catch (cause) { setFailure(String(cause)); report.current?.({ kind: 'runtime', error: String(cause instanceof Error ? cause.message : cause) }); }
    };
    void loadRuntime().then(() => {
      if (disposed) return;
      renderer = new WebGLRenderer(canvas);
      runtimeRef.current = new NativePreview();
      drawRef.current = draw;
      observer = new ResizeObserver(draw); observer.observe(canvas);
      // A picture of the app: draw, then read the canvas in the same task
      // (WebGL keeps the frame until it is shown).
      snapshots.deka = async () => { draw(); try { return canvas.toDataURL('image/png'); } catch { return null; } };
      setReady(true);
    }).catch(cause => setFailure(String(cause)));
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer?.disconnect(); snapshots.deka = null;
      renderer?.dispose(); runtimeRef.current?.free(); runtimeRef.current = null; drawRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || !source.trim()) return;
    try {
      runtimeRef.current!.compile(source, true);
      setFailure(null); setCompiled(true); setCompileError(null);
      report.current?.({ kind: 'ok' });
      drawRef.current?.();
    } catch (cause) {
      const error = String(cause instanceof Error ? cause.message : cause);
      setCompileError(error);
      report.current?.({ kind: 'compile', error });
    }
  }, [source, ready, reload]);
  useEffect(() => { drawRef.current?.(); }, [width, height, zoom]);

  const act = (run: () => void) => {
    try { run(); drawRef.current?.(); } catch (cause) { setFailure(String(cause)); report.current?.({ kind: 'runtime', error: String(cause instanceof Error ? cause.message : cause) }); }
  };
  return <div className="deka-preview">
    <canvas ref={canvasRef} tabIndex={0} style={{ width: width * zoom, height: height * zoom }} aria-label="The app. Tab selects a control; Enter or Space activates it."
      onPointerUp={event => {
        if (event.button !== 0) return;
        event.currentTarget.focus();
        const bounds = event.currentTarget.getBoundingClientRect();
        act(() => { runtimeRef.current?.pointer((event.clientX - bounds.left) / zoom, (event.clientY - bounds.top) / zoom); });
      }}
      onKeyDown={event => act(() => { if (runtimeRef.current?.key(event.key, event.shiftKey)) event.preventDefault(); })}
      onBlur={() => act(() => runtimeRef.current?.blur())} />
    {!ready && !failure && <p className="deka-preview-status" role="status">Getting your app ready…</p>}
    {failure && <p className="deka-preview-status" role="status">{runtimeLabel(failure)}</p>}
    {ready && !failure && !compiled && compileError && <div className="deka-preview-status deka-not-opened">{notOpened}</div>}
  </div>;
}
