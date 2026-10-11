// Composed TRUE picking golden (GLOBE-NATIVE-PLAN §7, N3 fix pass defect 7): what a tap selects, computed by the PINNED
// web engine end to end — map.js pick() = BASES first (bases.js pick: keep/icon rects, nearest the viewer, then the shield
// dome ellipses), then the deed cell (a base on it, else an open deed of this realm, else nothing).
//
//   node tools/world-pick-golden.mjs --source <SHARDKEEP-globe repo>           write renderer/src/test/resources/world/pickbases
//   node tools/world-pick-golden.mjs --source <SHARDKEEP-globe repo> --check   regenerate in memory and byte-compare
//
// The keep rects are not a formula the generator can transcribe: they come from bases.js buildAtlases' ink boxes over the
// real keeps atlas (trim, size-class placement, the marker icon's mode reduction), keepScale, iconLook, baseMode and
// plotOffset. So the pinned bases.js runs as in the browser — createBases(fakeCore).load(pack, shared), setBases(list),
// update(view), pick(sx, sy) — on a recording-free fake GL core, over the pinned pack's realm/shared/keeps.json and
// keeps.png (checked byte for byte against the pack manifest at the pin, and copied next to the golden so the Kotlin
// consumer reads the same atlas). Only map.js pick() is transcribed (it builds a DOM map); its pinned source text is
// compared to the transcription, so a web change to the tap order fails the export instead of hiding.
//
// The realm around the kingdoms is synthetic (grid, catalog mask, kingdoms: mulberry32 samples, listed in the golden), so
// the Kotlin consumer builds the same inputs without the real pack's WebP art; the keeps atlas is the real one.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, LOCK_FILE, SHARED, extractPinned, moduleLoader } from './world-shaders.mjs';
import { PACK_DIR, pinnedManifest } from './world-debug-content.mjs';
import { serialize } from './world-golden.mjs';

export const OUT_DIR = 'renderer/src/test/resources/world/pickbases';
export const GOLDEN = 'pick-bases.json';
/** The shared pack files the golden is computed over, copied beside it (verified against the pinned manifest). */
export const KEEPS = ['keeps.json', 'keeps.png'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The catalog lattice width (GLOBE-PRODUCTION-PLAN §2.4.2; native RealmGrid.LATTICE_W): a base's id is its tile id. */
const LATTICE_W = 720;
/** map.js pick() at the pin, whitespace-folded: the transcription below must be this text (a changed tap order fails). */
export const MAP_PICK = 'function pick(sx, sy) { const b = basesMod?.pick?.(sx, sy); if (b) return b; const [u, v] = cam.screenToDeed(sx, sy), x = Math.floor(u), y = Math.floor(v); '
  + 'if (x < 0 || y < 0 || x >= R.cols || y >= R.rows) return null; const hit = R.byCell.get(y * R.cols + x); if (hit) return hit; '
  + 'return P.first.deeds[y * R.cols + x] === DEED_PX.thisRealm ? { free: true, x, y } : null; }';
/** CSS px + dpr: the Seeker as the native engine draws it (1200×2670 at density 3.0 on the dpr-2 buffer), and landscape. */
export const VIEWPORTS = [['seeker-3.0-native', 400, 890, 2], ['seeker-2.75-landscape', 2670 / 2.75, 1200 / 2.75, 2.75]];
/** d (device px per deed): MAP marker icons, the per-base icon/keep switch, MAP live keeps, TRUE, the TRUE pixel snap. */
export const DS = [150, 240, 400, 1400, 3136];
/** Result codes, one per point. */
export const CODE = Object.freeze({ lane: 0, cell: 100000, open: 200000, none: -1 });

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const q256 = v => Math.round(v * 256) / 256;   // probe coordinates on a 1/256 px grid: exact in binary, short in JSON

/** The synthetic realm: a 24×16 grid at a real lattice origin, the catalog mask, and kingdoms with levels, yours, shields. */
export function realmOf(seed) {
  const r = rng(seed), cols = 24, rows = 16, x0 = 300, y0 = 150, mask = new Array(cols * rows), bases = [];
  for (let i = 0; i < cols * rows; i++) { const u = r(); mask[i] = u < 0.7 ? 255 : u < 0.9 ? 96 : 0; }
  for (let y = 2; y < rows - 2; y++) for (let x = 2; x < cols - 2; x++) {
    if (r() >= 0.6) continue;
    mask[y * cols + x] = 255;
    bases.push({ id: (y0 + y) * LATTICE_W + x0 + x, x, y, level: 1 + Math.floor(r() * 20), mine: false, shield: r() < 0.35 });
  }
  bases[Math.floor(bases.length / 2)].mine = true;
  return { cols, rows, x0, y0, mask, bases };
}

/** A GL core that accepts every call bases.js makes and draws nothing (only update()'s pick geometry is read). */
function fakeCore() {
  const noop = () => ({});
  const gl = new Proxy({}, { get: () => noop });
  return { gl, quadBuffer: {}, tex: { data: noop, array: noop, layer: noop, free: noop, update: noop }, program: name => ({ name, u: () => null }),
    invalidate() {}, animating() {} };
}

/** map.js pick() (MAP_PICK), with the pinned bases.js as basesMod. Returns a result code. */
function pickCode(bases, cam, realm, byCell, index, DEED_PX, sx, sy) {
  const b = bases.pick(sx, sy); if (b) return CODE.lane + index.get(b);
  const [u, v] = cam.screenToDeed(sx, sy), x = Math.floor(u), y = Math.floor(v);
  if (x < 0 || y < 0 || x >= realm.cols || y >= realm.rows) return CODE.none;
  const hit = byCell.get(y * realm.cols + x); if (hit) return CODE.cell + index.get(hit);
  return realm.mask[y * realm.cols + x] === DEED_PX.thisRealm ? CODE.open + y * realm.cols + x : CODE.none;
}

async function viewsFor(M, realmId, realm, keeps, viewports, ds) {
  const { createBases } = M.bases, K = M.camera, DEED_PX = M.contracts.DEED_PX;
  const bases = createBases(fakeCore(), null);
  const pack = { id: realmId, meta: { grid: { cols: realm.cols, rows: realm.rows } }, first: { deeds: Uint8Array.from(realm.mask) },
    pixels: async k => { throw Object.assign(new Error('404 ' + k), { status: 404 }); }, json: async k => { throw Object.assign(new Error('404 ' + k), { status: 404 }); } };
  const shared = { json: async f => { if (f === 'keeps.json') return JSON.parse(keeps.json.toString('utf8')); throw new Error('404 ' + f); },
    pixels: async f => { if (f === 'keeps.png') return M.loader.decodePng(keeps.png); throw new Error('404 ' + f); } };
  await bases.load(pack, shared);
  const list = realm.bases.map(b => ({ ...b })), index = new Map(list.map((b, i) => [b, i])), byCell = new Map(list.map(b => [b.y * realm.cols + b.x, b]));
  bases.setBases(list);
  const { ready, why } = bases.stats();
  const mine = list.find(b => b.mine), shielded = list.find(b => b.shield && !b.mine), P = M.contracts;
  const seat = b => { const o = P.plotOffset(b.x, b.y, b.level); return [b.x + (P.PLOT_CENTRE + o.dx) / P.TILES, b.y + (P.KEEP_FOOTPRINT[1] / 2 + P.PLOT_CENTRE + o.dy) / P.TILES]; };
  const centres = [['your keep seat', ...seat(mine)], ['a shielded plot', shielded.x + (P.PLOT_CENTRE + P.plotOffset(shielded.x, shielded.y, shielded.level).dx) / P.TILES,
    shielded.y + (P.PLOT_CENTRE + P.plotOffset(shielded.x, shielded.y, shielded.level).dy) / P.TILES], ['a deed corner', 12.013, 8.021]];
  const out = [];
  for (const [vpName, W, H, dpr] of viewports) for (const d of ds) for (const [centre, cx, cy] of centres) {
    const cam = K.createCamera({ now: () => 0 }); cam.setViewport(W, H, dpr); cam.setGrid(realm.cols, realm.rows); cam.set(cx, cy, d / dpr);
    const r = cam.rect();
    const view = { x: cam.x, y: cam.y, s: cam.s, dpr, d: cam.d, W, H, ms: 0, pulseMs: 0, frozen: true, reducedMotion: false, safe: false,
      rect: { x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(realm.cols, Math.ceil(r.x1)), y1: Math.min(realm.rows, Math.ceil(r.y1)), fx0: r.x0, fy0: r.y0, fx1: r.x1, fy1: r.y1 },
      grid: { cols: realm.cols, rows: realm.rows, x0: realm.x0, y0: realm.y0 } };
    bases.update(view);
    const nx = 20, ny = Math.round(20 * H / W), pts = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([(i + 0.5) * W / nx, (j + 0.5) * H / ny]);
    // Edge probes. bases.js keeps its rects and domes private, so each base's tap region is found through pick() itself:
    // from a point inside it (a quarter px under its tag anchor = its rect's top edge + 2 px, and its dome centre) march
    // in 2 px steps along ±x and +y (and −y from the dome centre) until the tap leaves the base, bisect the edge, then
    // probe a quarter px either side. A native rect or dome off by more than that fails the golden.
    const probes = [], seen = new Set();
    const onBase = (b, x, y) => bases.pick(x, y) === b;
    const edge = (b, x, y, dx, dy) => {
      let k = 0; while (k < 1000 && onBase(b, x + dx * 2 * (k + 1), y + dy * 2 * (k + 1)) && x + dx * 2 * (k + 1) >= -8 && x + dx * 2 * (k + 1) <= W + 8 && y + dy * 2 * (k + 1) >= -8 && y + dy * 2 * (k + 1) <= H + 8) k++;
      let lo = 2 * k, hi = 2 * (k + 1); for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (onBase(b, x + dx * m, y + dy * m)) lo = m; else hi = m; }
      for (const t of [lo - 0.25, lo + 0.25]) {
        const p = [q256(x + dx * t), q256(y + dy * t)], key = p.join();   // a tap lands on the screen: off-screen edges are no probe
        if (p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H && !seen.has(key)) { seen.add(key); probes.push(p); }
      }
    };
    const toCss = (x, y) => [(x - view.x) * view.s + W / 2, (y - view.y) * view.s + H / 2];
    const starts = [];
    for (const t of bases.tagCandidates(view)) starts.push([t.base, t.sx, t.sy + 2.25, [[-1, 0], [1, 0], [0, 1]]]);
    for (const b of list) if (b.shield) {
      const o = P.plotOffset(b.x, b.y, b.level), [sx, sy] = toCss(b.x + (P.PLOT_CENTRE + o.dx) / P.TILES, b.y + (P.PLOT_CENTRE + o.dy) / P.TILES);
      if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) starts.push([b, sx, sy, [[-1, 0], [1, 0], [0, 1], [0, -1]]]);
    }
    for (const [b, x, y, dirs] of starts) if (onBase(b, x, y)) for (const [dx, dy] of dirs) edge(b, x, y, dx, dy);
    const codes = [...pts, ...probes].map(([sx, sy]) => pickCode(bases, cam, realm, byCell, index, DEED_PX, sx, sy));
    const st = bases.stats();
    out.push({ realm: realmId, viewport: vpName, W, H, dpr, d, centre, cam: [cam.x, cam.y, cam.s], grid: { nx, ny }, probes: probes.flat(), codes,
      laneHits: codes.filter(c => c >= 0 && c < CODE.cell).length, stats: { keeps: st.keeps, icons: st.icons, domes: st.domes, visible: st.visible } });
  }
  bases.dispose();
  return { ready, why, views: out };
}

// ---- driver -------------------------------------------------------------------------------------------------------------
export async function generate({ repo, root = ROOT }) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')), pin = lock.source.commit;
  const pinned = pinnedManifest(repo, lock), byPath = new Map(pinned.manifest.files.map(f => [f.path, f]));
  const read = rel => { const f = byPath.get(rel), b = fs.readFileSync(path.join(repo, PACK_DIR, rel));
    if (!f || f.bytes !== b.length || f.sha256 !== sha256(b)) throw new Error(`REFUSED: ${rel} is not the pinned pack byte for byte`); return b; };
  const keeps = { json: read('realm/shared/keeps.json'), png: read('realm/shared/keeps.png') };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-pick-golden-'));
  try {
    extractPinned(repo, pin, [ENGINE, ...SHARED], tmp);
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(tmp, 'packages/shared/node_modules'), 'dir');
    const load = await moduleLoader(repo), dir = path.join(tmp, ENGINE);
    const files = { bases: 'bases.js', camera: 'camera.js', contracts: 'contracts.js', decor: 'decor.js', loader: 'loader.js' };
    const entry = path.join(tmp, 'pick-entry.mjs');
    fs.writeFileSync(entry, Object.entries(files).map(([k, f]) => `export * as ${k} from ${JSON.stringify('./' + path.posix.join(ENGINE, f))};`).join('\n') + '\n');
    const M = { ...(await load(entry)) };
    const mapText = fs.readFileSync(path.join(dir, 'map.js'), 'utf8'), m = mapText.match(/function pick\(sx, sy\) \{[\s\S]*?\n {2}\}/);
    const fold = s => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    if (!m || fold(m[0]) !== fold(MAP_PICK)) throw new Error(`map.js pick() at the pin is not the transcribed tap order:\n  ${m ? fold(m[0]) : '(not found)'}`);
    const sources = Object.fromEntries([...Object.values(files), 'map.js'].map(f => [`${ENGINE}/${f}`, sha256(fs.readFileSync(path.join(dir, f)))]));
    const realm = realmOf(0x9e3779b9);
    const dressed = Object.keys(M.decor.KIT_DRESSING).sort();
    const undressed = ['elderwood', 'thornwake', 'seeker-reach'].find(id => !M.decor.KIT_DRESSING[id]) ?? null;
    const a = await viewsFor(M, 'crownlands', realm, keeps, VIEWPORTS, DS);
    const b = undressed ? await viewsFor(M, undressed, realm, keeps, VIEWPORTS.slice(0, 1), [1400, 3136]) : null;
    const views = [...a.views, ...(b?.views ?? [])];
    if (!a.ready) throw new Error(`bases.js did not load the keeps for crownlands: ${a.why}`);
    if (b?.ready) throw new Error(`${undressed} has no kit dressing at the pin, yet bases.js loaded it`);
    const body = {
      schema: 1, suite: 'pick-bases', pin, generator: sha256(fs.readFileSync(SELF)), sources,
      pack: { manifestSha256: pinned.sha256, packVersion: pinned.manifest.packVersion },
      files: Object.fromEntries(KEEPS.map(f => [f, sha256(f === 'keeps.json' ? keeps.json : keeps.png)])),
      tolerance: 'exact codes',
      note: 'map.js pick(): BASES pick first (keep/icon rects, largest seat y wins, then dome ellipses), then the deed cell. The pinned bases.js ran '
        + 'load(pack, shared) over the pinned keeps atlas (no decor, no realm art: neither moves a keep rect or a dome), setBases(bases), update(view), pick. '
        + 'Points: the grid (i + 0.5)·W/nx, (j + 0.5)·H/ny (index j·nx + i), then the edge probes (flat [sx, sy] pairs, index nx·ny + k): a quarter px either side of '
        + 'every tap region edge on the screen, found by marching pick() out of each keep rect and dome. A base id is its catalog tile id (native RealmGrid.tileId, x0/y0 below).',
      columns: { bases: ['id', 'dx', 'dy', 'level', 'mine', 'shield'], codes: 'per point: base index (BASES rect or dome) | 100000 + base index (the deed cell) | 200000 + dy·cols + dx (open deed) | -1 nothing' },
      realm: { cols: realm.cols, rows: realm.rows, x0: realm.x0, y0: realm.y0, mask: realm.mask, bases: realm.bases.map(b => [b.id, b.x, b.y, b.level, b.mine ? 1 : 0, b.shield ? 1 : 0]) },
      dressed, undressed, ready: { crownlands: a.ready, ...(undressed ? { [undressed]: b.ready } : {}) }, mapPick: MAP_PICK, views,
      count: views.reduce((n, v) => n + v.codes.length, 0),
    };
    const out = new Map();
    out.set(GOLDEN, Buffer.from(serialize(body) + '\n'));
    out.set('keeps.json', keeps.json); out.set('keeps.png', keeps.png);
    return out;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function compare(root, files) {
  const dir = path.join(root, OUT_DIR), drift = [];
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const [rel, bytes] of files) { const p = path.join(dir, rel); if (!fs.existsSync(p)) drift.push(`missing ${rel}`); else if (!fs.readFileSync(p).equals(bytes)) drift.push(`changed ${rel}`); }
  for (const f of present) if (!files.has(f)) drift.push(`extra ${f}`);
  return drift;
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = path.resolve(opt('--root') ?? ROOT), repo = opt('--source') ?? process.env.PKW_GLOBE_SOURCE;
  if (!repo) throw new Error('Pass --source <SHARDKEEP-globe repo> (or PKW_GLOBE_SOURCE)');
  const files = await generate({ repo: path.resolve(repo), root });
  if (argv.includes('--check')) {
    const drift = compare(root, files);
    if (drift.length) { console.error(`world pick golden drift:\n  ${drift.join('\n  ')}`); return 1; }
    console.log(`world pick golden: no drift (${files.size} files)`);
    return 0;
  }
  const dir = path.join(root, OUT_DIR);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  let bytes = 0; for (const [rel, b] of files) { fs.writeFileSync(path.join(dir, rel), b); bytes += b.length; }
  console.log(`world pick golden: wrote ${files.size} files (${bytes} bytes) into ${OUT_DIR}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
