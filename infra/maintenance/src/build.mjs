#!/usr/bin/env node
// Builds infra/maintenance/index.html from this directory. The page is served by
// Caddyfile.maintenance while /srv/www is mid-publish, so every asset is inlined.
//   node infra/maintenance/src/build.mjs
// Inputs (all tracked): template.html; brand_wordmark.png = the "PIXEL KINGDOM WARS"
// band of art/source/brand-wave2/brand_logo_main.png (rows 405-588, trimmed; owner
// 2026-09-25: text logo only, no castle over the wallpaper's keep); backdrop_*.png =
// art/loading-v1 masters, nearest-neighbour to 720x324 / 324x720 and quantized to 80
// colours (~75 KB each, so the self-contained page stays under 250 KB); the VT323 woff2
// the game itself ships. Re-run after changing any input; scripts/src/maintenance-page.test.ts
// pins the output to these inputs.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const b64 = (p) => readFileSync(p).toString('base64');
const html = readFileSync(join(here, 'template.html'), 'utf8')
  .replace('@@FONT@@', b64(join(root, 'apps/web/src/assets/fonts/VT323-latin-v18.woff2')))
  .replace('@@WORDMARK@@', b64(join(here, 'brand_wordmark.png')))
  .replace('@@BG@@', b64(join(here, 'backdrop_landscape.png')))
  .replace('@@BG_PORTRAIT@@', b64(join(here, 'backdrop_portrait.png')));
writeFileSync(join(here, '..', 'index.html'), html);
console.log(`infra/maintenance/index.html: ${Buffer.byteLength(html)} bytes`);
