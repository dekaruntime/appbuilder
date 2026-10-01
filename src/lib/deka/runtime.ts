import init, { NativePreview } from './generated/deka_native_web';

// One WASM instance per window. The checker is a second VM used only to ask
// "does this source compile?" without disturbing the app on screen.
let ready: Promise<unknown> | undefined;
let checker: NativePreview | undefined;

export function loadRuntime(): Promise<unknown> {
  ready ??= init({ module_or_path: '/deka-runtime/deka_native_web_bg.wasm' }).catch(cause => { ready = undefined; throw cause; });
  return ready;
}

/** The compiler's diagnostic for this source, or null when it compiles. */
export async function compileError(source: string): Promise<string | null> {
  await loadRuntime();
  checker ??= new NativePreview();
  try { checker.compile(source, true); return null; }
  catch (cause) { return String(cause instanceof Error ? cause.message : cause); }
}

export { NativePreview };
