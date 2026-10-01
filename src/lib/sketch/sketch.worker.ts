// The sketch compiler, off the main thread: a huge or pathological sketch can't
// freeze the builder, and the builder can terminate the worker on a timeout.
import { compileSketchHtml } from './html';

self.onmessage = (event: MessageEvent<{ id: number; markdown: string }>) => {
  const { id, markdown } = event.data;
  try {
    (self as unknown as Worker).postMessage({ id, result: compileSketchHtml(markdown) });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: String(error) });
  }
};
