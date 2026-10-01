import { isTauri } from '@tauri-apps/api/core';

// Copied from cqx desktop (cqxai/desktop src/lib/terminal.ts) without its
// agent-usage reading.

type Output = { kind: 'data'; value: number[] } | { kind: 'end' } | { kind: 'error'; value: string };
// StrictMode, a fast close/reopen, and switching repositories must all finish
// the previous native cleanup before allocating the one available session.
let lifecycle: Promise<unknown> = Promise.resolve();
const sequence = <T>(run: () => Promise<T>) => {
  const next = lifecycle.then(run);
  lifecycle = next.catch(() => {});
  return next;
};

export function connectTerminal(
  path: string, rows: number, cols: number,
  output: (bytes: Uint8Array) => void,
  ended: () => void,
  trouble: (message: string) => void,
) {
  const id = crypto.randomUUID();
  let closed = false;
  let opened = false;
  let finished = false;
  const ready = sequence(async () => {
    if (closed) return;
    if (!isTauri()) throw new Error('The terminal is available in the desktop app.');
    const { Channel, invoke } = await import('@tauri-apps/api/core');
    const channel = new Channel<Output>((message) => {
      if (closed) return;
      if (message.kind === 'data') output(new Uint8Array(message.value));
      if (message.kind === 'error') trouble(message.value);
      if (message.kind === 'end') {
        finished = true;
        ended();
        void close().catch((e) => trouble(String(e)));
      }
    });
    await invoke('term_open', { id, path, rows, cols, output: channel });
    opened = true;
  });
  // Inputs and resizes stay in order, even if IPC replies arrive out of order.
  let pending: Promise<unknown> = ready;
  const send = (command: string, args: Record<string, unknown>) => {
    pending = pending.then(async () => {
      if (!opened || closed || finished) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke(command, { id, ...args });
    }).catch((e) => { if (!closed) trouble(String(e)); });
  };
  const close = () => {
    if (closed) return lifecycle;
    closed = true;
    return sequence(async () => {
      if (!opened) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('term_close', { id });
      opened = false;
    });
  };
  return {
    ready,
    write: (bytes: Uint8Array) => send('term_write', { bytes: Array.from(bytes) }),
    resize: (rows: number, cols: number) => send('term_resize', { rows, cols }),
    close,
  };
}
