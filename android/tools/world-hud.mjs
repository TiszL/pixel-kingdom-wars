// World HUD reference for the native globe port (GLOBE-NATIVE-PLAN §3.6 and §7 "HUD tokens"; D-166, D-167, D-169).
//
//   node tools/world-hud.mjs --source <SHARDKEEP-globe repo> --pin <commit>   export the reference at a pin
//   node tools/world-hud.mjs --source <SHARDKEEP-globe repo> --check          re-export at the recorded pin; byte-compare
//
// The native Compose HUD reproduces the approved web HUD (hud.js tokens, the realm-map ui.js chips and layout, the
// globe index.html/main.js tools, rail, panel and labels). This tool exports, from the pinned COMMIT only (git archive,
// never the working tree), everything the JVM tests compare the Kotlin port against:
//  - tokens: every `:root` custom property of hud.js HUD_CSS, evaluated exactly as the browser receives it, plus the
//    media overrides (>= 2 dppx type scale, portrait and short-landscape display sizes);
//  - realms: landmarks.js REALM_INFO presentation (numeral, nav, accent, colour) and ui.js REALM_ACCENT;
//  - chips: the approved realm-map filter set with its long/short labels (D-169), and the band/flag contracts the HUD
//    reads (BANDS s-thresholds, FLAG bits);
//  - golden vectors of the pure functions the Compose HUD ports: ui.js scaleBar and clusterCounters (imported from the
//    pinned module) and main.js placeLabel (read as text; main.js starts WebGL on import).
// Nothing here is a game number: TILES (98 tiles per deed) is passed in from the pinned constants only to drive the
// vectors, and the Kotlin port reads it from the generated catalogue at runtime.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONCEPT = 'concepts/globe3d-2026-09-23';
export const OUT_FILE = 'app/src/test/resources/world-hud/source-reference.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args, options = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 28, ...options });

export function resolvePin(repo, pin) {
  if (!/^[0-9a-f]{7,40}$/.test(pin ?? '')) throw new Error('Pass --pin as a commit sha');
  const full = git(repo, ['rev-parse', '--verify', '--quiet', `${pin}^{commit}`]).toString().trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`Pin ${pin} is not a commit in ${repo}`);
  return full;
}

/** Deterministic PRNG (the web ui.test.mjs mulberry32). */
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Balanced-brace body of the first `head{…}` in text, from the index of `head`. */
function braceBody(text, at) {
  const open = text.indexOf('{', at); let depth = 0;
  for (let i = open; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i); }
  throw new Error('Unbalanced braces');
}
/** `--name:value` pairs of a CSS declaration block, values trimmed (commas inside values kept). */
export function cssVars(block) {
  const out = {}; let depth = 0, cur = '';
  const flush = () => { const m = cur.trim().match(/^(--[\w-]+)\s*:\s*([\s\S]*)$/); if (m) out[m[1]] = m[2].trim(); cur = ''; };
  for (const c of block) { if (c === '(') depth++; if (c === ')') depth--; if (c === ';' && depth === 0) flush(); else cur += c; }
  flush();
  return out;
}

/** hud.js HUD_CSS, evaluated: its PNG imports become inert strings so Node can load it (no icon is exported). */
async function loadHudCss(dir) {
  const src = fs.readFileSync(path.join(dir, `${CONCEPT}/src/hud.js`), 'utf8');
  const shim = src.replace(/^import\s+(\w+)\s+from\s+'[^']+\.png';$/gm, "const $1 = 'png:$1';");
  if (/^import\s/m.test(shim)) throw new Error('hud.js gained an import this exporter does not understand');
  const file = path.join(dir, 'hud.node.mjs'); fs.writeFileSync(file, shim);
  return (await import(pathToFileURL(file).href)).HUD_CSS;
}
export function hudTokens(css) {
  const root = cssVars(braceBody(css, css.indexOf(':root{')));
  const media = {};
  for (const [key, query] of [['dppx2', '@media (min-resolution:2dppx)'], ['portrait', '@media (orientation:portrait)'],
    ['shortLandscape', '@media (orientation:landscape) and (max-height:520px)']]) {
    const at = css.indexOf(query + '{'); if (at < 0) throw new Error(`HUD_CSS lost ${query}`);
    const inner = braceBody(css, at); media[key] = cssVars(braceBody(inner, inner.indexOf(':root{')));
  }
  return { root, media };
}

/** landmarks.js REALM_INFO: a plain object literal, evaluated as data (landmarks.js imports geo.js, which imports apps/web). */
function realmInfo(dir) {
  const src = fs.readFileSync(path.join(dir, `${CONCEPT}/src/landmarks.js`), 'utf8');
  const at = src.indexOf('export const REALM_INFO = {'); if (at < 0) throw new Error('REALM_INFO moved');
  const info = new Function(`return {${braceBody(src, at)}};`)();
  return Object.fromEntries(Object.entries(info).map(([id, r]) => [id, { numeral: r.numeral, nav: r.nav, accent: r.accent, color: r.color }]));
}

/** The realm-map filter chips as the approved markup declares them (ui.js createUI). */
function chipSet(uiSrc) {
  const bar = uiSrc.slice(uiSrc.indexOf('<div class="rmx-chips"'), uiSrc.indexOf('<div class="rmx-lvl'));
  const chips = [];
  for (const m of bar.matchAll(/<button class="hud-filter[^"]*" (?:data-f="(\w+)"|data-a="(\w+)")([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, f, a, attrs, body] = m, aria = attrs.match(/aria-label="([^"]*)"/)?.[1] ?? null;
    const lg = body.match(/<span class="lg">([^<]*)<\/span>/)?.[1] ?? body.trim(), sm = body.match(/<span class="sm">([^<]*)<\/span>/)?.[1] ?? lg;
    chips.push({ id: f ?? a, kind: f ? 'filter' : 'action', lg, sm, aria });
  }
  return chips;
}

/** main.js placeLabel, read as text (main.js creates a WebGL context when imported). */
function placeLabelFn(dir) {
  const src = fs.readFileSync(path.join(dir, `${CONCEPT}/src/main.js`), 'utf8');
  const at = src.indexOf('function placeLabel('); if (at < 0) throw new Error('placeLabel moved');
  const head = src.slice(at, src.indexOf('{', at));
  return new Function(`${head}{${braceBody(src, at)}}; return placeLabel;`)();
}

function vectors(ui, placeLabel, tiles) {
  const scale = [];
  for (let i = 0; i <= 400; i++) scale.push(+(0.5 * Math.pow(6272 / 0.5, i / 400)).toPrecision(12));
  for (const k of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) for (const d of [-1e-6, 0, 1e-6]) { const s = 40 / k + d; if (s > 0) scale.push(s); scale.push(tiles * 40 / k + d); }
  scale.push(100, 100.000001, 99.999999);
  const scaleBar = scale.map(s => ({ s, out: ui.scaleBar(s) }));

  const clusters = [];
  const cases = [['phone fit', 400, 890, 2, 181, 132, 900], ['phone s 10', 457, 1017, 10, 119, 59, 600], ['landscape fit', 1017, 457, 3.5, 181, 132, 900],
    ['landscape s 20', 971, 436, 20, 226, 120, 700], ['tiny s', 436, 971, 0.7, 181, 132, 500], ['dense cell', 400, 890, 6, 60, 40, 800]];
  cases.forEach(([name, W, H, s, cols, rows, n], ci) => {
    const r = rng(1000 + ci * 7919), hubs = Array.from({ length: 12 }, () => [r() * cols, r() * rows]), used = new Set(), bases = [];
    for (let g = 0; bases.length < n && g < n * 40; g++) {
      const h = hubs[Math.floor(r() * hubs.length)], sp = 1 + r() * 9, x = Math.floor(h[0] + (r() + r() - 1) * sp), y = Math.floor(h[1] + (r() + r() - 1) * sp);
      if (x < 0 || y < 0 || x >= cols || y >= rows || used.has(y * cols + x)) continue; used.add(y * cols + x); bases.push({ x, y, mine: r() < 0.01 });
    }
    const cam = { x: cols / 2 + 3.25, y: rows / 2 - 2.5 };
    const chrome = [[0, 0, W, 108], [W - 146, 112, W, 300], [W - 62, H / 2 - 90, W, H / 2 + 90], [W / 2 - 60, H - 64, W / 2 + 60, H], [8, H - 180, 150, H - 60]];
    const box = [2, 2, W - 2, H - 2];
    const res = ui.clusterCounters({ bases, cam, s, W, H, chrome, box });
    clusters.push({ name, W, H, s, cam, chrome, box, bases: bases.map(b => [b.x, b.y, b.mine ? 1 : 0]),
      onScreen: res.onScreen, list: res.list.map(c => ({ n: c.n, px: c.px, py: c.py, w: c.w, u: c.u, v: c.v, mine: c.mine })) });
  });

  const labels = [], r = rng(424242);
  for (let i = 0; i < 300; i++) {
    const W = [400, 457, 1017, 971][i % 4], H = [890, 1017, 457, 436][i % 4];
    const rects = Array.from({ length: Math.floor(r() * 6) }, () => { const x0 = r() * W, y0 = r() * H; return { x0, y0, x1: x0 + 20 + r() * 200, y1: y0 + 20 + r() * 120 }; });
    const s = [r() * W, r() * H], w = 40 + Math.floor(r() * 90), h = 12 + Math.floor(r() * 6);
    labels.push({ s, w, h, W, H, rects: rects.map(q => [q.x0, q.y0, q.x1, q.y1]), out: placeLabel(s, w, h, rects, W, H) });
  }
  return { tiles, scaleBar, clusters, labels };
}

export async function buildReference(repo, pin) {
  const full = resolvePin(repo, pin);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-hud-'));
  try {
    const tar = git(repo, ['archive', '--format=tar', full, '--', `${CONCEPT}/src`, `${CONCEPT}/index.html`, 'packages/shared/package.json', 'packages/shared/src']);
    execFileSync('tar', ['-x', '-C', dir], { input: tar, maxBuffer: 1 << 28 });
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(dir, 'packages/shared/node_modules'), 'dir');
    const tsxApi = path.join(repo, 'scripts/node_modules/tsx/dist/esm/api/index.mjs');
    if (!fs.existsSync(tsxApi)) throw new Error('The source repo needs scripts/node_modules/tsx (the pinned contracts.js imports TypeScript)');
    const { tsImport } = await import(pathToFileURL(tsxApi).href);
    const load = rel => tsImport(pathToFileURL(path.join(dir, rel)).href, import.meta.url);
    const ui = await load(`${CONCEPT}/src/realm/ui.js`), contracts = await load(`${CONCEPT}/src/realm/contracts.js`);
    const uiSrc = fs.readFileSync(path.join(dir, `${CONCEPT}/src/realm/ui.js`), 'utf8');
    const html = fs.readFileSync(path.join(dir, `${CONCEPT}/index.html`), 'utf8');
    const B = contracts.BANDS;
    const reference = {
      header: { suite: 'world-hud', pin: full, generatorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
        note: 'Exported from the pinned commit by tools/world-hud.mjs; regenerate, never hand-edit.' },
      tokens: hudTokens(await loadHudCss(dir)),
      realms: realmInfo(dir),
      realmAccentUi: { ...ui.REALM_ACCENT },
      chips: chipSet(uiSrc),
      bands: { uiDots: B.uiDots, uiIcons: B.uiIcons, keepMinCss: B.keepMinCss, mapStart: B.mapStart, trueFull: B.trueFull,
        impostor: [...B.impostor], selectD: B.selectD, myBaseD: B.myBaseD },
      flag: { ...contracts.FLAG },
      globe: {
        hint: html.match(/<div class="hint[^>]*>([^<]*)<\/div>/)?.[1] ?? null,
        loading: html.match(/<div class="ld">([^<]*)</)?.[1] ?? null,
        tools: [...html.matchAll(/<button class="hud-tool(?! dbg)[^"]*" data-a="(\w+)"(?:[^>]*aria-label="([^"]*)")?[^>]*>(?:<i class="hud-i hud-i--(\w+)"><\/i>)?([^<]*)<\/button>/g)]
          .filter(m => !/\bdbg\b/.test(m[0])).map(m => ({ id: m[1], aria: m[2] ?? null, icon: m[3] ?? null, label: m[4] || null })),
      },
      vectors: vectors(ui, placeLabelFn(dir), contracts.TILES),
    };
    return Buffer.from(JSON.stringify(reference) + "\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = arg('--source'); if (!repo) { console.error('Pass --source <SHARDKEEP-globe repo>'); return 2; }
  const out = path.join(ROOT, OUT_FILE);
  if (argv.includes('--check')) {
    if (!fs.existsSync(out)) { console.error(`world hud: ${OUT_FILE} is missing`); return 1; }
    const pin = JSON.parse(fs.readFileSync(out, 'utf8')).header.pin, bytes = await buildReference(repo, pin);
    if (!fs.readFileSync(out).equals(bytes)) { console.error(`world hud drift: ${OUT_FILE} differs from a re-export at ${pin}`); return 1; }
    console.log(`world hud: no drift (pin ${pin.slice(0, 8)})`);
    return 0;
  }
  const bytes = await buildReference(repo, arg('--pin'));
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, bytes);
  console.log(`world hud: wrote ${OUT_FILE} (${bytes.length} bytes)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
