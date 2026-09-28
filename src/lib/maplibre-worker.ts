import * as maplibregl from 'maplibre-gl';

// Match earth#13: WebKit's tauri:// origin cannot infer MapLibre's worker URL.
// The prebuild step copies its module worker and shared chunk to this origin.
export function configureMapLibreWorker(): void {
  maplibregl.setWorkerUrl('/globe/maplibre-gl-worker.mjs');
}
