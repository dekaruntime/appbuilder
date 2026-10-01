import type { SketchHtml } from './html';

// Compile a sketch in the worker. A compile that takes over 2 s means
// something is wrong with the sketch: the worker is replaced, not waited on.
let worker: Worker | null = null;
let nextId = 0;
const TIMEOUT_MS = 2000;

export function compileInWorker(markdown: string): Promise<SketchHtml> {
  worker ??= new Worker(new URL('./sketch.worker.ts', import.meta.url), { type: 'module' });
  const id = ++nextId;
  const w = worker;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.terminate(); if (worker === w) worker = null; reject(new Error('The sketch took too long to draw.')); }, TIMEOUT_MS);
    const onMessage = (event: MessageEvent<{ id: number; result?: SketchHtml; error?: string }>) => {
      if (event.data.id !== id) return;
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      if (event.data.result) resolve(event.data.result); else reject(new Error(event.data.error ?? 'The sketch could not be drawn.'));
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, markdown });
  });
}
