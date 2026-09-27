import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const source = 'node_modules/maplibre-gl/dist';
const target = 'public/globe';
mkdirSync(target, { recursive: true });
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  const contents = readFileSync(`${source}/${file}`, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  writeFileSync(`${target}/${file}`, contents);
}
