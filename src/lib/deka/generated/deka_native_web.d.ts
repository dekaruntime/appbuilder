/* tslint:disable */
/* eslint-disable */

export class NativePreview {
    free(): void;
    [Symbol.dispose](): void;
    binding_stats(): string;
    blur(): void;
    /**
     * Compile and validate a replacement before touching the running app.
     * Edits restart VM state. The boolean is retained for host API compatibility.
     */
    compile(source: string, _reset: boolean): string;
    frame(width: number, height: number, scale: number): string;
    /**
     * Explicit presentation clock for browser animation and deterministic CI.
     */
    frame_at(width: number, height: number, scale: number, milliseconds: number, reduced_motion: boolean): string;
    /**
     * Return false at tab boundaries to let focus leave the canvas.
     */
    key(key: string, backwards: boolean): boolean;
    constructor();
    pointer(x: number, y: number): boolean;
}

/**
 * Experimental shared world; no browser layout or JavaScript movement simulation.
 */
export class PortfolioWorld {
    free(): void;
    [Symbol.dispose](): void;
    static audio_samples(id: number): Float32Array;
    blur(): void;
    frame(width: number, height: number, milliseconds: number, reduced_motion: boolean): string;
    interact(): void;
    key(key: string, down: boolean): boolean;
    constructor();
    set_muted(muted: boolean): void;
    snapshot(): string;
    sounds(): Uint8Array;
    start(): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_nativepreview_free: (a: number, b: number) => void;
    readonly __wbg_portfolioworld_free: (a: number, b: number) => void;
    readonly nativepreview_binding_stats: (a: number) => [number, number];
    readonly nativepreview_blur: (a: number) => void;
    readonly nativepreview_compile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly nativepreview_frame: (a: number, b: number, c: number, d: number) => [number, number];
    readonly nativepreview_frame_at: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly nativepreview_key: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly nativepreview_new: () => number;
    readonly nativepreview_pointer: (a: number, b: number, c: number) => [number, number, number];
    readonly portfolioworld_audio_samples: (a: number) => [number, number];
    readonly portfolioworld_blur: (a: number) => void;
    readonly portfolioworld_frame: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly portfolioworld_interact: (a: number) => void;
    readonly portfolioworld_key: (a: number, b: number, c: number, d: number) => number;
    readonly portfolioworld_new: () => number;
    readonly portfolioworld_set_muted: (a: number, b: number) => void;
    readonly portfolioworld_snapshot: (a: number) => [number, number];
    readonly portfolioworld_sounds: (a: number) => [number, number];
    readonly portfolioworld_start: (a: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
