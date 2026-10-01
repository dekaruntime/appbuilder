import { compileSketchHtml, type SketchHtml } from './html';

// Compile a sketch in a worker, so a huge or pathological sketch can't freeze
// the builder. If the worker can't start (or doesn't answer in time), compile
// here instead: sketches are small, and a sketch must always render.
let worker: Worker | null = null;
let workerBroken = false;
let nextId = 0;
const TIMEOUT_MS = 1500;

function startWorker(): Worker | null {
  if (workerBroken) return null;
  try {
    worker ??= new Worker(new URL('./sketch.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('error', () => { workerBroken = true; worker = null; });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

export function compileInWorker(markdown: string): Promise<SketchHtml> {
  const w = startWorker();
  if (!w) return Promise.resolve(compileSketchHtml(markdown));
  const id = ++nextId;
  return new Promise(resolve => {
    const fallback = () => { w.removeEventListener('message', onMessage); resolve(compileSketchHtml(markdown)); };
    const timer = setTimeout(() => { w.terminate(); if (worker === w) worker = null; workerBroken = true; fallback(); }, TIMEOUT_MS);
    const onMessage = (event: MessageEvent<{ id: number; result?: SketchHtml; error?: string }>) => {
      if (event.data.id !== id) return;
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      if (event.data.result) resolve(event.data.result); else resolve(compileSketchHtml(markdown));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', () => { clearTimeout(timer); fallback(); }, { once: true });
    w.postMessage({ id, markdown });
  });
}
