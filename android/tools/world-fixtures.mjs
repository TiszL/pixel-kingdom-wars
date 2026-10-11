// Synthetic world fixtures for the native globe port's JVM tests (GLOBE-NATIVE-PLAN §6.1, §8.2).
//
//   node tools/world-fixtures.mjs            write renderer/src/test/resources/world/fixtures
//   node tools/world-fixtures.mjs --check    regenerate in memory and byte-compare (drift fails)
//
// Until the web commits a pack manifest (§6.1), no real realm or globe-v2 content may be exported, so N1/N2 run on
// these. They are small, deterministic and fully synthetic: no pack bytes, no art, no game numbers. What they carry:
//  - packs/overview: realm pack index + two realms' first-frame set (realm.json schema 1, chart8, deeds mask), one of
//    them west of the dateline like Cinderfall (x0 < 0), and a manifest in the §6.1 draft shape;
//  - packs/tampered and packs/miscounted: the same pack with exactly one declared defect each, for refusal tests;
//  - png/: exact-decoder goldens (every colour type, tRNS, all five row filters, stored and fixed-Huffman deflate, a
//    split IDAT, alpha-0 texels that keep RGB) with the RGBA the web loader's exact decoder produces.
// Every PNG is encoded here with a hand-written deflate (stored or fixed-Huffman literals), so the bytes do not
// depend on the zlib build of whichever Node runs the drift check. chart8 is PNG, not WebP: the JVM cannot decode WebP.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT_DIR = 'renderer/src/test/resources/world/fixtures';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
/** The deeds-mask values of the web pack (loader.js, realm.json `deeds`): this realm, another realm, no deed. */
export const DEED_PX = Object.freeze({ thisRealm: 255, otherRealm: 96, none: 0 });

// ---- PNG encoding (deterministic, no zlib) ---------------------------------------------------------------------------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const adler32 = bytes => { let a = 1, b = 0; for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; };
const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
function deflateStored(data) {
  const out = [];
  for (let i = 0; i < data.length || i === 0; i += 65535) {
    const n = Math.min(65535, data.length - i), last = i + 65535 >= data.length;
    out.push(last ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255, ...data.subarray(i, i + n));
    if (last) break;
  }
  return out;
}
function deflateFixedLiterals(data) { // one BTYPE=01 block, every byte a literal (no back-references)
  const out = []; let acc = 0, n = 0;
  const put = (v, bits) => { acc |= v << n; n += bits; while (n >= 8) { out.push(acc & 255); acc >>>= 8; n -= 8; } };
  const code = (c, len) => { let r = 0; for (let i = 0; i < len; i++) r = (r << 1) | ((c >> i) & 1); put(r, len); }; // Huffman codes go MSB-first
  put(1, 1); put(1, 2);
  for (const b of data) if (b < 144) code(0x30 + b, 8); else code(0x190 + b - 144, 9);
  code(0, 7);
  if (n) out.push(acc & 255);
  return out;
}
const zlibWrap = (data, deflate) => Uint8Array.from([0x78, 0x01, ...(deflate === 'fixed' ? deflateFixedLiterals(data) : deflateStored(data)), ...u32(adler32(data))]);
function chunk(type, data) {
  const body = Uint8Array.from([...Buffer.from(type, 'latin1'), ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
/**
 * rows: packed scanline bytes (Uint8Array per row). filters: the filter type per row. The encoder filters each row
 * with the PNG spec's own predictors so a decoder has to undo exactly them.
 */
function encodePng({ width, height, depth, colorType, rows, filters, plte, trns, deflate = 'stored', idatChunks = 1 }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType], bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8), raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y], row = rows[y], prev = y ? rows[y - 1] : new Uint8Array(stride);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + i] = (row[i] - pred) & 255;
    }
  }
  const z = zlibWrap(raw, deflate), parts = [];
  for (let k = 0; k < idatChunks; k++) parts.push(z.subarray(Math.floor((k * z.length) / idatChunks), Math.floor(((k + 1) * z.length) / idatChunks)));
  return Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', [...u32(width), ...u32(height), depth, colorType, 0, 0, 0]),
    ...(plte ? chunk('PLTE', plte) : []), ...(trns ? chunk('tRNS', trns) : []),
    ...parts.flatMap(p => chunk('IDAT', [...p])), ...chunk('IEND', []),
  ]);
}
const rgbRows = (w, h, px) => Array.from({ length: h }, (_, y) => Uint8Array.from({ length: w * 3 }, (_, i) => px(i / 3 | 0, y)[i % 3]));
const expandRgb = (w, h, px) => Buffer.from(Array.from({ length: w * h }, (_, i) => [...px(i % w, i / w | 0), 255]).flat());

// ---- decoder goldens -----------------------------------------------------------------------------------------------
function pngGoldens() {
  const out = [];
  { // RGB, all five filters, fixed-Huffman deflate split over three IDAT chunks
    const w = 7, h = 10, px = (x, y) => [(x * 37 + y * 11) & 255, (x * x * 5 + y * 29) & 255, (250 - x * 13 - y * 7) & 255];
    out.push({ name: 'rgb-filters', colorType: 2, depth: 8, deflate: 'fixed', idatChunks: 3, png: encodePng({ width: w, height: h, depth: 8, colorType: 2, rows: rgbRows(w, h, px), filters: [0, 1, 2, 3, 4, 4, 3, 2, 1, 0], deflate: 'fixed', idatChunks: 3 }), rgba: expandRgb(w, h, px), width: w, height: h });
  }
  { // RGBA whose alpha-0 texels keep RGB: a premultiplying decoder (BitmapFactory with premultiply, a 2D canvas) zeroes them
    const w = 6, h = 5, px = (x, y) => [x * 40, y * 50, 200 - x * 10, (x + y) % 3 === 0 ? 0 : 60 + x * 30];
    const rows = Array.from({ length: h }, (_, y) => Uint8Array.from({ length: w * 4 }, (_, i) => px(i / 4 | 0, y)[i % 4]));
    out.push({ name: 'rgba-alpha0', colorType: 6, depth: 8, deflate: 'stored', idatChunks: 1, png: encodePng({ width: w, height: h, depth: 8, colorType: 6, rows, filters: [4, 1, 0, 2, 3] }), rgba: Buffer.from(rows.flatMap(r => [...r])), width: w, height: h });
  }
  { // grey with a tRNS colour key: the key grey decodes to alpha 0, every other grey to 255
    const w = 5, h = 4, g = (x, y) => (x + y) % 4 === 0 ? 17 : x * 50 + y;
    out.push({ name: 'gray-trns', colorType: 0, depth: 8, deflate: 'fixed', idatChunks: 1, png: encodePng({ width: w, height: h, depth: 8, colorType: 0, rows: Array.from({ length: h }, (_, y) => Uint8Array.from({ length: w }, (_, x) => g(x, y))), filters: [1, 2, 3, 4], trns: [0, 17], deflate: 'fixed' }),
      rgba: Buffer.from(Array.from({ length: w * h }, (_, i) => { const v = g(i % w, i / w | 0); return [v, v, v, v === 17 ? 0 : 255]; }).flat()), width: w, height: h });
  }
  { // 4-bit palette with a partial tRNS (entries past its end are opaque), odd width so the last byte is half used
    const w = 5, h = 3, plte = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 91) & 255]), trns = [0, 128, 255];
    const idx = (x, y) => (x * 3 + y * 5) & 15, rows = Array.from({ length: h }, (_, y) => { const r = new Uint8Array(Math.ceil(w / 2)); for (let x = 0; x < w; x++) r[x >> 1] |= idx(x, y) << (x & 1 ? 0 : 4); return r; });
    out.push({ name: 'palette4-trns', colorType: 3, depth: 4, deflate: 'stored', idatChunks: 2, png: encodePng({ width: w, height: h, depth: 4, colorType: 3, rows, filters: [0, 2, 0], plte: plte.flat(), trns, idatChunks: 2 }),
      rgba: Buffer.from(Array.from({ length: w * h }, (_, i) => { const v = idx(i % w, i / w | 0); return [...plte[v], v < trns.length ? trns[v] : 255]; }).flat()), width: w, height: h });
  }
  { // grey + alpha
    const w = 4, h = 3, px = (x, y) => [x * 60 + y, y * 100];
    const rows = Array.from({ length: h }, (_, y) => Uint8Array.from({ length: w * 2 }, (_, i) => px(i >> 1, y)[i & 1]));
    out.push({ name: 'gray-alpha', colorType: 4, depth: 8, deflate: 'stored', idatChunks: 1, png: encodePng({ width: w, height: h, depth: 8, colorType: 4, rows, filters: [3, 4, 1] }),
      rgba: Buffer.from(Array.from({ length: w * h }, (_, i) => { const [g, a] = px(i % w, i / w | 0); return [g, g, g, a]; }).flat()), width: w, height: h });
  }
  return out;
}

// ---- synthetic realm packs -----------------------------------------------------------------------------------------
const REALMS = [
  // A realm fully east of the dateline, an ellipse of deeds with another realm's deeds on its east edge.
  { id: 'alpha', name: 'Alpha', status: 'ready', x0: 40, y0: 100, cols: 12, rows: 8, frame: { lon: -159.75, lat: 38.25, half: 4 },
    deed: (x, y) => (((x - 5.5) / 5.2) ** 2 + ((y - 3.5) / 3.6) ** 2 <= 1 ? 'thisRealm' : x >= 10 && y >= 2 && y <= 5 ? 'otherRealm' : 'none') },
  // x0 < 0: the pack grid starts west of the dateline and wraps (the Cinderfall case, RealmGrid's hard edge).
  { id: 'wrap', name: 'Wrap', status: 'preview', x0: -3, y0: 250, cols: 10, rows: 6, frame: { lon: 178.75, lat: -37.25, half: 3.5 },
    deed: (x, y) => (x >= 1 && x <= 8 && y >= 1 && y <= 4 && !(x === 4 && y === 2) ? 'thisRealm' : y === 5 && x < 3 ? 'otherRealm' : 'none') },
];
const PACK_VERSION = 'fixture-1', KIT_COMMIT = '0'.repeat(40), BUILDER_COMMIT = 'f'.repeat(40);
const CHART_PX = 8; // chart8: 8 px per deed (realm.json chart8.pxPerDeed)
function realmFiles(r) {
  const grey = (x, y) => DEED_PX[r.deed(x, y)];
  const deeds = encodePng({ width: r.cols, height: r.rows, depth: 8, colorType: 2, rows: rgbRows(r.cols, r.rows, (x, y) => [grey(x, y), grey(x, y), grey(x, y)]), filters: Array(r.rows).fill(0) });
  const W = r.cols * CHART_PX, H = r.rows * CHART_PX;
  const chart = (x, y) => { const k = r.deed(x / CHART_PX | 0, y / CHART_PX | 0), edge = x % CHART_PX === 0 || y % CHART_PX === 0;
    return k === 'thisRealm' ? [edge ? 90 : 120, 150 + (x % 7), 80] : k === 'otherRealm' ? [140, 120, 100] : [30, 60 + (y % 5), 110]; };
  const chart8 = encodePng({ width: W, height: H, depth: 8, colorType: 2, rows: rgbRows(W, H, chart), filters: Array.from({ length: H }, (_, y) => y % 5) });
  const thisRealm = Array.from({ length: r.cols * r.rows }, (_, i) => r.deed(i % r.cols, i / r.cols | 0)).filter(k => k === 'thisRealm').length;
  const files = { 'chart8.png': chart8, 'deeds.png': deeds };
  const realm = {
    schema: 1, id: r.id, name: r.name, status: r.status, packVersion: PACK_VERSION, synthetic: true,
    grid: { x0: r.x0, y0: r.y0, cols: r.cols, rows: r.rows, deeds: thisRealm },
    frame: { id: r.id, ...r.frame, projection: 'gnomonic', size: 256 },
    first: ['realm.json', 'chart8.png', 'deeds.png'],
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { sha256: sha256(v), bytes: v.length, stage: 'first' }])),
    chart8: { file: 'chart8.png', pxPerDeed: CHART_PX, w: W, h: H },
    deeds: { file: 'deeds.png', w: r.cols, h: r.rows, thisRealm: DEED_PX.thisRealm, otherRealm: DEED_PX.otherRealm },
  };
  return { files: { ...files, 'realm.json': json(realm) }, thisRealm };
}
function pack(mutate = null) {
  const files = new Map(), realms = [];
  for (const r of REALMS) {
    const built = realmFiles(r);
    for (const [k, v] of Object.entries(built.files)) files.set(`realm/${r.id}/${k}`, v);
    realms.push({ id: r.id, name: r.name, packVersion: PACK_VERSION, kitCommit: KIT_COMMIT, status: r.status, deeds: built.thisRealm });
  }
  files.set('realm/index.json', json({ schema: 1, synthetic: true, realms }));
  const manifest = () => json({
    schema: 1, synthetic: true, shape: 'GLOBE-NATIVE-PLAN §6.1 draft: the web pack manifest is not written yet',
    packVersion: PACK_VERSION, builderCommit: BUILDER_COMMIT,
    realms: Object.fromEntries(REALMS.map(r => [r.id, { kitCommit: KIT_COMMIT, packVersion: PACK_VERSION }])),
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, v]) => ({ path: p, sha256: sha256(v), size: v.length })),
  });
  files.set('manifest.json', manifest());
  mutate?.(files);
  return files;
}

/** Every fixture file, keyed by its path under the fixtures directory. */
export function buildFixtures() {
  const out = new Map(), packs = [];
  const add = (name, files, expect) => { for (const [k, v] of files) out.set(`packs/${name}/${k}`, v); packs.push({ name, ...expect, manifestSha256: sha256(files.get('manifest.json')) }); };
  add('overview', pack(), { valid: true, realms: REALMS.map(r => r.id), wrapsDateline: ['wrap'] });
  add('tampered', pack(files => { // a VALID mask with one deed flipped: only the hashes in realm.json and the manifest catch it
    const alpha = REALMS[0], flipped = { ...alpha, deed: (x, y) => (x === 0 && y === 0 ? 'thisRealm' : alpha.deed(x, y)) };
    files.set('realm/alpha/deeds.png', realmFiles(flipped).files['deeds.png']);
  }), { valid: false, defect: 'sha256-mismatch', file: 'realm/alpha/deeds.png' });
  add('miscounted', pack(files => { // hashes agree, but grid.deeds disagrees with the mask: the grid is never bent to fit a pack
    const p = 'realm/wrap/realm.json', realm = JSON.parse(files.get(p)); realm.grid.deeds += 1; files.set(p, json(realm));
    const manifest = JSON.parse(files.get('manifest.json'));
    for (const f of manifest.files) if (f.path === p) Object.assign(f, { sha256: sha256(files.get(p)), size: files.get(p).length });
    files.set('manifest.json', json(manifest));
  }), { valid: false, defect: 'deed-count', file: 'realm/wrap/realm.json', declared: 'grid.deeds', off: 1 });
  const png = [];
  for (const g of pngGoldens()) {
    out.set(`png/${g.name}.png`, g.png); out.set(`png/${g.name}.rgba`, g.rgba);
    png.push({ name: g.name, png: `png/${g.name}.png`, rgba: `png/${g.name}.rgba`, width: g.width, height: g.height, colorType: g.colorType, bitDepth: g.depth, deflate: g.deflate, idatChunks: g.idatChunks });
  }
  out.set('index.json', json({
    schema: 1, synthetic: true, generator: 'tools/world-fixtures.mjs',
    note: 'Synthetic only (GLOBE-NATIVE-PLAN §6.1): no real pack bytes may be exported until the web pack manifest exists.',
    deedPx: DEED_PX, packs, png,
  }));
  return out;
}

export function compareFixtures(dir, files) {
  const drift = [], present = new Set();
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else present.add(path.relative(dir, p).split(path.sep).join('/')); } };
  if (fs.existsSync(dir)) walk(dir);
  for (const [rel, bytes] of files) if (!present.has(rel)) drift.push(`missing ${rel}`); else if (!fs.readFileSync(path.join(dir, rel)).equals(bytes)) drift.push(`changed ${rel}`);
  for (const rel of present) if (!files.has(rel)) drift.push(`extra ${rel}`);
  return drift;
}

function main(argv) {
  const dir = path.join(ROOT, OUT_DIR), files = buildFixtures();
  if (argv.includes('--check')) {
    const drift = compareFixtures(dir, files);
    if (drift.length) { console.error(`world fixtures drift:\n  ${drift.join('\n  ')}`); return 1; }
    console.log(`world fixtures: no drift (${files.size} files)`);
    return 0;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, bytes] of files) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), bytes); }
  console.log(`world fixtures: wrote ${files.size} files into ${OUT_DIR}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
