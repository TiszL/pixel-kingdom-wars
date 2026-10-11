// Golden vectors for the native GROUND port (lane NR, N3; GLOBE-NATIVE-PLAN §7 suites "classify" and "groundcost"),
// computed by the PINNED web code over the real realm packs.
//
//   node tools/world-ground-golden.mjs --source <SHARDKEEP-globe repo>           write renderer/src/test/resources/world/ground
//   node tools/world-ground-golden.mjs --source <SHARDKEEP-globe repo> --check   regenerate in memory and byte-compare (drift fails)
//
// Every value comes from the web modules at the shader pin (world-shaders.lock.json: classify.js, groundcost.js, contracts.js,
// ground.js mapNoiseTable, loader.js decodePng, minimap.js farDeeds, glsl/common.glsl.js), extracted with git archive and
// imported under Node, and from the realm pack files checked byte for byte against the pack manifest at the pin. Nothing
// here re-implements a web function, with two stated exceptions: the MAP slot of a terrain (ground.js mapTables' three-line
// slotOf, a closure the module does not export) and the order ground.js runs its load passes in (load(): foreignSeaRows,
// then clipTarns, then makeFields). chart8.webp is decoded with sharp (libwebp) for clipTarns; the browser and Android use
// libwebp too, but a byte-identical decode across the three is NOT verified here (clipTarns' result is recorded per realm).
//
// A NR tool, next to NT's world-golden.mjs (same serialisation, same pin); NT may fold it in. Output: one JSON per suite,
// sorted keys. Exact doubles are 16-hex-digit IEEE-754 bit strings ("h" fields); crops of decoded images are gzip + base64.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ENGINE, LOCK_FILE, SHARED, extractPinned, moduleLoader } from './world-shaders.mjs';
import { PACK_DIR, pinnedManifest } from './world-debug-content.mjs';
import { serialize } from './world-golden.mjs';

export const OUT_DIR = 'renderer/src/test/resources/world/ground';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// ---- encodings ----------------------------------------------------------------------------------------------------
const F64 = new Float64Array(1), U8 = new Uint8Array(F64.buffer);
/** A double as its 16-hex-digit IEEE-754 bit pattern (big-endian digits), so the JVM reads it back bit for bit. */
export function hx(v) { F64[0] = v; let s = ''; for (let i = 7; i >= 0; i--) s += U8[i].toString(16).padStart(2, '0'); return s; }
const gz = bytes => zlib.gzipSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { level: 9, mtime: 0 }).toString('base64');
const i32le = arr => { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeInt32LE(v | 0, i * 4)); return b; };
const f64le = arr => { const b = Buffer.alloc(arr.length * 8); arr.forEach((v, i) => b.writeDoubleLE(v, i * 8)); return b; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const HEXC = '0123456789abcdef';

// ---- suites -------------------------------------------------------------------------------------------------------
function mathSuite(M) {
  const K = M.classify, Cm = M.common, r = rng(0x9a0d);
  const hyp = [[0, 0], [3, 4], [-3, 4], [1e-300, 1e-300], [1e300, 1e300], [0.1, 0.2], [5, 12], [1, 1e-17]];
  while (hyp.length < 1000) { const e = Math.floor(r() * 12) - 6; hyp.push([(r() - 0.5) * 10 ** e * 200, (r() - 0.5) * 10 ** (Math.floor(r() * 12) - 6) * 200]); }
  const noise = [];
  for (let i = 0; i < 700; i++) {
    const x = (r() - 0.5) * 40000, y = (r() - 0.5) * 30000, p = [1, 2, 3, 5, 7, 9, 11, 14, 17, 20, 26, 29, 44, 48][i % 14] + (i % 7 === 0 ? 0.5 : 0), seed = [0x1c0a, 0x7c33, 0x3a91, 0x71c3, -5, 0x7fffffff, 0][i % 7];
    noise.push([hx(x), hx(y), hx(p), seed, hx(Cm.vnoise(x, y, p, seed)), hx(K.znoise(x, y, p, seed))]);
  }
  const hashes = [];
  for (let i = 0; i < 500; i++) { const a = Math.floor((r() - 0.5) * 2 ** 32), b = Math.floor((r() - 0.5) * 2 ** 32); hashes.push([a | 0, b | 0, K.kitHash(a, b) | 0, Cm.pcg2d(a >>> 0, b >>> 0)[0] | 0]); }
  const halves = [0, -0, 1, -1, 0.5, 65504, 65520, 1e-8, 6.1e-5, 5.96e-8, 2.98e-8, 1e9, -1e9, Infinity, -Infinity, NaN, 20, 64, 1 / 3];
  while (halves.length < 400) halves.push((r() - 0.5) * 10 ** (Math.floor(r() * 12) - 7));
  const bridges = [];
  for (let i = 0; i < 400; i++) {
    const a = r() * Math.PI * 2 - Math.PI, len = i % 17 === 0 ? 0 : r() * 140 - 5, hw = r() * 70;
    const u = K.packBridge(Math.cos(a), Math.sin(a), len, hw); const d = K.unpackBridge(u);
    bridges.push([hx(Math.cos(a)), hx(Math.sin(a)), hx(len), hx(hw), u | 0, hx(d[0]), hx(d[1]), hx(d[2]), hx(d[3])]);
  }
  const rounds = [0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, -0.49999999999999994, 1e16 + 1, 3.7, -3.7];
  return {
    tolerance: 'exact (IEEE-754 bits)',
    hypotColumns: ['a', 'b', 'Math.hypot(a, b)'], hypot: hyp.map(([a, b]) => [hx(a), hx(b), hx(Math.hypot(a, b))]),
    noiseColumns: ['x', 'y', 'period', 'seed', 'vnoise', 'znoise'], noise,
    hashColumns: ['tx', 'ty', 'kitHash (int32 bits)', 'pcg2d[0] (int32 bits)'], hashes,
    halfColumns: ['v', 'toHalf(v)', 'fromHalf(toHalf(v))'], half: halves.map(v => [hx(v), K.toHalf(v), hx(K.fromHalf(K.toHalf(v)))]),
    bridgeColumns: ['ux', 'uy', 'len', 'hw', 'packBridge (int32 bits)', 'unpack ux', 'uy', 'len', 'hw'], bridges,
    roundColumns: ['x', 'Math.round(x)'], round: rounds.map(x => [hx(x), hx(Math.round(x))]),
    trig: Array.from({ length: 200 }, (_, i) => { const t = (i - 100) * 0.0731 + r() * 1e-3; return [hx(t), hx(Math.cos(t)), hx(Math.sin(t)), hx(Math.atan2(Math.sin(t) * 3, Math.cos(t) - 0.2))]; }),
    // bridgeOf's ray directions (classify.js: th = TAU·k / bridge.dirs): the only sin/cos arguments that are fixed values
    dirsColumns: ['k', 'cos(TAU·k/24)', 'sin(TAU·k/24)'], dirs: Array.from({ length: 24 }, (_, k) => { const th = Math.PI * 2 * k / 24; return [k, hx(Math.cos(th)), hx(Math.sin(th))]; }),
    count: hyp.length + noise.length + hashes.length + halves.length + bridges.length + rounds.length + 224,
  };
}

function groundcostSuite(M) {
  const G = M.groundcost, r = rng(0x6c057);
  // canvas px: the Seeker rows' dpr-2 buffers (plan §5.5), the web's reference screens, and a log sweep
  const canvases = [914 * 2034, 873 * 1942, 800 * 1780, 1200 * 2670, 2560 * 1600, 780 * 1688, 3840 * 2160, 1280 * 800, 1, 1000, 100000];
  for (let i = 0; i < 60; i++) canvases.push(Math.round(Math.exp(Math.log(1e4) + (Math.log(2e7) - Math.log(1e4)) * i / 59)));
  const budget = [];
  for (const px of canvases) for (const far of [false, true]) for (const dp of [0, 2, 6]) { const b = G.resolveBudget(px, { far, despecklePasses: dp }); budget.push([px, far ? 1 : 0, dp, b.subs, b.pages]); }
  const sizes = [[914, 2034], [873, 1942], [800, 1780], [1200, 2670], [2560, 1600], [780, 1688], [457, 1017], [1, 1], [3, 7]];
  const ks = [1, 0.999, 0.5, 1 / 3, 0.25, 0.75, 0.6667];
  const frame = [];
  for (const [w, h] of sizes) for (const k of ks) for (let m = 0; m < 8; m++) {
    const drawn = { chart: !!(m & 1), map: !!(m & 2), true: !!(m & 4) }, subs = Math.floor(r() * 4), pages = Math.floor(r() * 5), dp = [2, 6][Math.floor(r() * 2)];
    const c = G.frameCost({ w, h, k, drawn, subs, pages, despecklePasses: dp });
    frame.push([w, h, hx(k), m, subs, pages, dp, hx(c.fetches), hx(c.iters), hx(c.perPx), hx(c.itersPerPx), hx(c.passesPerPx), hx(c.resolvePerPx), hx(c.groundPx)]);
  }
  const plans = [];
  for (let i = 0; i < 120; i++) {
    const n = i < 5 ? i : Math.floor(r() * 120), cap = Math.floor(r() * 100), bud = i % 9 === 0 ? 1e9 : Math.floor(r() * 6);
    const want = Array.from({ length: n }, (_, j) => [Math.floor(r() * 5000), Math.floor(r() * 40) / 4 + (j % 3 === 0 ? 0 : r())]);
    const has = new Set(want.filter(() => r() < 0.4).map(e => e[0]));
    const p = G.planPages(want, cap, k => has.has(k), bud === 1e9 ? Infinity : bud);
    plans.push({ want: want.flatMap(([k, d]) => [k, hx(d)]), cap, budget: bud === 1e9 ? -1 : bud, has: [...has].sort((a, b) => a - b), keep: p.keep, fetch: p.fetch, missing: p.missing });
  }
  const screens = [[2560, 1600], [3024, 1964], [3840, 2160], [5120, 2880], [1170, 2532], [914, 2034], [873, 1942], [800, 1780], [1200, 2670], [100, 100]];
  const demand = screens.flatMap(([w, h]) => [300, 600, 800, 1100].map(d => [w, h, d, G.pageDemand(w, h, d), G.recCapacity(w, h, d)]));
  return {
    tolerance: 'exact (integers; doubles as IEEE-754 bits)',
    constants: { SITES: G.SITES, HELPER: G.HELPER, PASS: G.PASS, ITERS: G.ITERS, PASS_BUDGET: G.PASS_BUDGET, ITER_BUDGET: G.ITER_BUDGET, FRAME_BUDGET: G.FRAME_BUDGET,
      FRAME_ITER_BUDGET: G.FRAME_ITER_BUDGET, DISPLAY_BUDGET: G.DISPLAY_BUDGET, RESOLVE_BUDGET: G.RESOLVE_BUDGET, RESOLVE: G.RESOLVE, LATTICE_PASSES: G.LATTICE_PASSES, REC_PAGES: G.REC_PAGES },
    subTile: [hx(G.subTileFetches()), hx(G.subTileFetches(G.ITERS))],
    pageColumns: ['despecklePasses', 'fetches', 'iters'], page: Array.from({ length: 9 }, (_, dp) => [dp, hx(G.pageFetches(dp)), hx(G.pageFetches(dp, G.ITERS))]),
    budgetColumns: ['canvasPx', 'far', 'despecklePasses', 'subs', 'pages'], budget,
    frameColumns: ['w', 'h', 'k', 'drawn bits (1 chart, 2 map, 4 true)', 'subs', 'pages', 'despecklePasses', 'fetches', 'iters', 'perPx', 'itersPerPx', 'passesPerPx', 'resolvePerPx', 'groundPx'], frame,
    plansNote: 'want = [key, dist bits, …]; has = resident keys; budget −1 = Infinity',
    plans,
    demandColumns: ['wDev', 'hDev', 'd', 'pageDemand', 'recCapacity'], demand,
    count: budget.length + frame.length + plans.length + demand.length + 11,
  };
}

/** classify.js constants the port carries (checked value for value). */
function classifyCommonSuite(M, plotRuleOf) {
  const K = M.classify, C = M.contracts;
  const geom = K.PLOT_GEOM.slice(1).map(g => [g.level, g.claim, g.ring, hx(g.half), hx(g.R), hx(g.min), hx(g.max)]);
  // a synthetic lines set with a track, non-finite points, a string coordinate and a far point (the real packs have no
  // tracks yet: PACK open item), prepared on a 12 × 9 grid, and its land / river pages
  const synth = { rivers: [{ pts: [[100.5, 200.25], [260, 330], [410.75, 300], [NaN, 5], [500, 120], [640, 90]], hw: [2.5, 3.1, 4, 1, 2.2, 0.4] },
    { pts: [700, 100, 760, 180, '812.5', 260, 1e9, -1e9], hw: 5 }],
    tracks: [{ pts: [[50, 50], [300, 60], [520, 400], [900, 820]], hw: [1.2, 0.8, 1.5, 3] }, { pts: [[1000, 10], [1100, 700]], hw: null }] };
  const cfg = K.classConfig({});
  const L = K.prepareLines(synth, { cols: 12, rows: 9 }, cfg);
  const segHash = s => sha256(f64le(Array.from(s.segs)));
  const cellsHash = s => sha256(i32le([...s.cells].flatMap(([k, a]) => [k, a.length, ...a])));
  const pages = [];
  for (const k of [...L.tracks.cells.keys()].slice(0, 4)) {
    const dx = k % 12, dy = Math.floor(k / 12), p = K.bakeLandPage(L.tracks, dx, dy, cfg);
    pages.push({ kind: 'land', dx, dy, sha256: sha256(i32le(Array.from(p.track, v => (K.toHalf(v) | (K.toHalf(0) << 16)) | 0))) });
  }
  for (const k of [...L.rivers.cells.keys()].slice(0, 4)) {
    const dx = k % 12, dy = Math.floor(k / 12), p = K.bakeRiverPage(L.rivers, dx, dy, cfg);
    pages.push({ kind: 'river', dx, dy, sha256: sha256(i32le(Array.from(p.sdf, (v, i) => (K.toHalf(v) | (K.toHalf(p.amp[i]) << 16)) | 0))) });
  }
  return {
    tolerance: 'exact',
    CLASS_CFG: JSON.parse(JSON.stringify(K.CLASS_CFG, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))),
    LINES: C.LINES, BAKE: K.BAKE, LINE_CAP: K.LINE_CAP, DESPECKLE_PASSES: K.DESPECKLE_PASSES, MAP_DESPECKLE: K.MAP_DESPECKLE,
    CLASS_RANK: K.CLASS_RANK, TILES: C.TILES, PLOT_CENTRE: C.PLOT_CENTRE,
    islandMaxMargin: hx(K.islandMaxMargin()), islandReach: hx(K.islandReach()),
    plotGeomColumns: ['level', 'claim', 'ring', 'half', 'R', 'min', 'max'], plotGeom: geom,
    plotRule: Array.from({ length: 20 }, (_, i) => { const p = plotRuleOf(i + 1); return [p.claim, p.ring]; }),
    mapNoiseDefault: Array.from(M.ground.mapNoiseTable(cfg)),
    synthLines: { json: JSON.parse(JSON.stringify(synth, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))), note: 'non-finite numbers are the strings "NaN" / "Infinity" here; feed them back as numbers',
      grid: [12, 9], bad: L.bad, rivers: { count: L.rivers.count, dropped: L.rivers.dropped, segs: segHash(L.rivers), cells: cellsHash(L.rivers) },
      tracks: { count: L.tracks.count, dropped: L.tracks.dropped, segs: segHash(L.tracks), cells: cellsHash(L.tracks) }, pages },
    count: geom.length + 20 + 112 + pages.length + 4,
  };
}

// ---- one realm ------------------------------------------------------------------------------------------------------
const WIN = 32, LWIN = 24, LSTEP = 7, DETAIL_EVERY = 32, MARGIN_DEEDS = 3;

async function realmSuite(M, sharp, pack) {
  const K = M.classify, C = M.contracts, T = C.TILES;
  const { meta, id } = pack, { cols, rows } = meta.grid, cfg = K.classConfig(meta.classes ?? {});
  const r = rng(0x5eed0000 + id.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  const deeds = new Uint8Array(cols * rows);
  { const d = await M.loader.decodePng(pack.files['deeds.png']); for (let i = 0; i < cols * rows; i++) deeds[i] = d.data[i * 4]; }
  const pa = await M.loader.decodePng(pack.files['fieldsA.png']), pb = await M.loader.decodePng(pack.files['fieldsBC.png']);
  const rawA = Uint8Array.from(pa.data);
  // ground.js load(): foreignSeaRows then clipTarns (unless realm.json says PACK baked them: fields.fieldsA.baked, else the
  // top-level fieldsA.baked, stage B precedence, ground.js:292), then makeFields
  const baked = new Set(meta.fields?.fieldsA?.baked ?? meta.fieldsA?.baked ?? []), farD = M.minimap.farDeeds(deeds, cols, rows);
  let fsStats = { baked: true }, tarns = { baked: true };
  if (!baked.has('foreignSea')) { const g = K.foreignSeaRows(pa, farD, cols, rows); let x; while (!(x = g.next()).done); fsStats = x.value; }
  const chartRaw = await sharp(pack.files['chart8.webp']).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const chart = { width: chartRaw.info.width, height: chartRaw.info.height, data: new Uint8Array(chartRaw.data), channels: 4 };
  if (!baked.has('clipTarns')) tarns = K.clipTarns(pa, chart);
  const img = x => ({ width: x.width, height: x.height, data: x.data, channels: 4 });
  const fields = K.makeFields({ fieldsA: img(pa), fieldsBC: img(pb) });
  const lines = K.prepareLines(pack.lines, { cols, rows }, cfg);
  const own = k => deeds[k] === C.DEED_PX.thisRealm;
  const centre = k => [(k % cols + 0.5) * T, (Math.floor(k / cols) + 0.5) * T];
  // candidate deeds of this realm, shuffled deterministically; features read at the deed centre
  const cand = []; for (let k = 0; k < cols * rows; k++) if (own(k) && k % cols > 2 && k % cols < cols - 3 && Math.floor(k / cols) > 2 && Math.floor(k / cols) < rows - 3) cand.push(k);
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const at = (k, f) => { const [x, y] = centre(k); return fields[f](x, y); };
  const pick = (test, used) => cand.find(k => !used.has(k) && test(k)) ?? cand.find(k => !used.has(k));
  const used = new Set(), bases = [], windows = [];
  const addBase = (k, level) => { if (!bases.some(b => b.k === k)) bases.push({ k, x: k % cols, y: Math.floor(k / cols), level, mine: r() < 0.3 }); };
  const lvl = () => 1 + Math.floor(r() * 20);
  const near = (k, dx, dy) => { const x = k % cols + dx, y = Math.floor(k / cols) + dy; return x >= 0 && y >= 0 && x < cols && y < rows ? y * cols + x : k; };
  // W0 river + plot, W1 plot near / in water, W2 coast (no plot), W3 forest/field + a neighbour plot, W4 rock/snow + a neighbour
  // plot, W5 lake; W6/W7 lattice windows (step 7) over W0 and W2
  const kinds = [
    ['river-plot', k => { const [x, y] = centre(k); return K.strokeSdf(lines.rivers, x, y, cfg, true).sdf < 18; }, true, 0],
    ['water-plot', k => at(k, 'coast') < 6 && at(k, 'coast') > -40, true, 0],
    ['coast', k => Math.abs(at(k, 'coast')) < 12, false, 0],
    ['forest-field', k => at(k, 'forest') > 0.5 || at(k, 'field') > 0.5, false, 1],
    ['rock-snow', k => at(k, 'rock') > 0.5 || at(k, 'snow') > 0.5, false, 1],
    ['lake', k => at(k, 'lake') < 4, false, 0],
  ];
  for (const [name, test, plotHere, nbPlot] of kinds) {
    const k = pick(test, used); used.add(k);
    let ox = 49 - WIN / 2, oy = 49 - WIN / 2;
    if (plotHere) { const L = lvl(); addBase(k, L); const o = C.plotOffset(k % cols, Math.floor(k / cols), L), g = K.PLOT_GEOM[L]; ox = Math.round(49 + o.dx + g.half - WIN / 2); oy = Math.round(49 + o.dy + g.half * 0.5 - WIN / 2); }
    if (nbPlot) addBase(near(k, 1, 0), lvl());
    if (name === 'coast') { // centre on a coast crossing inside the deed
      const [x0, y0] = [(k % cols) * T, Math.floor(k / cols) * T]; let best = null;
      for (let j = 4; j < T - 4; j += 6) for (let i = 4; i < T - 4; i += 6) { const c = Math.abs(fields.coast(x0 + i, y0 + j)); if (!best || c < best[0]) best = [c, i, j]; }
      ox = best[1] - WIN / 2; oy = best[2] - WIN / 2;
    }
    windows.push({ name, x0: (k % cols) * T + ox, y0: Math.floor(k / cols) * T + oy, w: WIN, h: WIN, step: 1, deed: k });
  }
  for (const [name, w] of [['lattice-river', windows[0]], ['lattice-coast', windows[2]]]) windows.push({ name, x0: w.x0 - (LWIN / 2) * LSTEP + WIN / 2, y0: w.y0 - (LWIN / 2) * LSTEP + WIN / 2, w: LWIN, h: LWIN, step: LSTEP, deed: w.deed });
  // one more plot beside W0 (neighbour effects on the river bend / bridges)
  addBase(near(windows[0].deed, 0, 1), lvl());
  const state = K.makeState(cols, rows, bases.map(b => ({ x: b.x, y: b.y, level: b.level, mine: b.mine })));
  // ground.js keeps the state's bent rivers and bridges (updateBends / queueBridges); classAt's riversOf/bridgesFor compute the same
  const bent = K.bendRivers(lines, state, cfg);
  const bridges = K.plotBridges(fields, lines, state, cfg);
  const st = { ...state, rivers: bent, bridges };
  // expected classes per window (classAt semantics), the ground class, the ring flag, sampledWet, and exact detail doubles
  const results = windows.map(w => {
    const c = w.step > 1 ? K.latticeCfg(cfg) : cfg;
    let cls = '', ground = '', ring = '', wet = ''; const detail = [];
    for (let j = 0; j < w.h; j++) for (let i = 0; i < w.w; i++) {
      const x = w.x0 + i * w.step, y = w.y0 + j * w.step, d = K.classDetail(fields, lines, st, [x, y], c);
      cls += HEXC[d.cls]; ground += HEXC[d.ground]; ring += d.ring ? '1' : '0'; wet += K.sampledWet(fields, lines, st, [x, y], c);
      if ((j * w.w + i) % DETAIL_EVERY === 0) detail.push([i, j, ...[d.coast, d.inland, d.river, d.lake, d.bridge, d.island, d.plot, d.track].map(hx)]);
    }
    return { ...w, cls, ground, ring, wet, detail };
  });
  // resolveRegion (the CPU reference of the GPU passes): a TRUE-page region in W0 and a lattice region in W6
  const trueTable = meta.true ? M.classify.bandTable({ classToTerrain: meta.true.classToTerrain ?? {}, families: (meta.true.families ?? []).map(f => ({ lower: f.lower, upper: f.upper })), fallback: meta.true.fallback ?? {} }) : null;
  const mapTable = meta.map?.families ? K.mapBandTable(meta.map) : null;
  const slotOf = t => (t === meta.map?.wild ? 0 : /^M[1-5]$/.test(t) ? Number(t[1]) : 0); // ground.js mapTables (transcribed: a closure)
  const slots = mapTable ? mapTable.terrainOf.map(slotOf) : null;
  const region = (w, table, step, useSlots) => {
    const rr = K.resolveRegion(fields, lines, st, { x0: w.x0 + 4 * step, y0: w.y0 + 4 * step, w: 16, h: 16, step }, table, cfg, { slots: useSlots ? slots : null });
    const s = a => Array.from(a, v => HEXC[v & 15]).join('');
    return { x0: w.x0 + 4 * step, y0: w.y0 + 4 * step, w: 16, h: 16, step, withSlots: useSlots, grid: s(rr.grid), ground: s(rr.ground), ring: s(rr.ring), pure: rr.pure ? s(rr.pure) : null,
      collapsed: rr.collapsed, illegal: rr.illegal, flipped: rr.flipped ?? 0 };
  };
  const regions = [];
  if (trueTable) { regions.push(region(windows[0], trueTable, 1, false)); regions.push(region(windows[2], trueTable, 1, false)); }
  if (mapTable) { regions.push(region(windows[6], mapTable, LSTEP, true)); regions.push(region(windows[7], mapTable, LSTEP, true)); }
  // the line bake: every bent-river deed in page order (ground.js linesJob assigns pages in cells order), three pages' words
  const pageKeys = [...bent.cells.keys()];
  const bakeDeeds = pageKeys.filter(k => windows.some(w => Math.abs(k % cols - w.deed % cols) <= 1 && Math.abs(Math.floor(k / cols) - Math.floor(w.deed / cols)) <= 1)).slice(0, 3);
  const pages = bakeDeeds.map(k => { const p = K.bakeRiverPage(bent, k % cols, Math.floor(k / cols), cfg), h = K.riverHint(bent, k);
    return { k, sha256: sha256(i32le(Array.from(p.sdf, (v, i) => (K.toHalf(v) | (K.toHalf(p.amp[i]) << 16)) | 0))), hint: [hx(h[0]), hx(h[1])] }; });
  // crops of the post-load fieldsA (and the raw one, for foreignSea) and of fieldsBC (both halves), covering every window
  // and every plot the classifier reads (bridges march ≤ ~1.1 deeds from a plot centre)
  const rects = [];
  for (const w of windows) {
    const dx0 = Math.floor(w.x0 / T) - 1 - MARGIN_DEEDS, dy0 = Math.floor(w.y0 / T) - 1 - MARGIN_DEEDS;
    const dx1 = Math.floor((w.x0 + (w.w - 1) * w.step) / T) + 1 + MARGIN_DEEDS, dy1 = Math.floor((w.y0 + (w.h - 1) * w.step) / T) + 1 + MARGIN_DEEDS;
    rects.push([dx0, dy0, dx1, dy1]);
  }
  const crop = (im, ppd, [dx0, dy0, dx1, dy1], xOff = 0, halfW = im.width) => {
    const x0 = Math.max(0, dx0 * ppd - 1), y0 = Math.max(0, dy0 * ppd - 1), x1 = Math.min(halfW - 1, (dx1 + 1) * ppd), y1 = Math.min(im.height - 1, (dy1 + 1) * ppd);
    const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++) out.set(im.data.subarray(((y0 + j) * im.width + xOff + x0) * 4, ((y0 + j) * im.width + xOff + x0 + w) * 4), j * w * 4);
    return { x0: xOff + x0, y0, w, h, gz: gz(out) };
  };
  const rawImg = { width: pa.width, height: pa.height, data: rawA };
  const trimMap = m => m && { wild: m.wild, families: m.families, classToTerrain: m.classToTerrain, layerOrder: m.layerOrder ?? null, snowPeaks: m.snowPeaks ?? null, atlas: m.atlas ?? null,
    mask: m.mask ?? null, trueThin: m.trueThin ?? null };
  const trimTrue = t => t && { atlas: t.atlas, decals: t.decals ?? null, mask: t.mask ?? null, classToTerrain: t.classToTerrain ?? null, fallback: t.fallback ?? null,
    terrains: (t.terrains ?? []).map(x => ({ id: x.id, kind: x.kind, layer: x.layer ?? null, pure: x.pure ?? null })), families: (t.families ?? []).map(f => ({ lower: f.lower, upper: f.upper, first: f.first })),
    water: t.water ?? null, waterByClass: t.waterByClass ?? null, decalGroups: t.decalGroups ?? null };
  const laneMeta = { id, grid: meta.grid, classes: meta.classes ?? null, chart8: meta.chart8 ?? null, tone: meta.tone ?? null, fieldsA: meta.fieldsA ?? null,
    plots: meta.plots ? { file: meta.plots.file, yards: meta.plots.yards ?? [] } : null, plotStyle: meta.plotStyle ?? null, palette: meta.palette ?? null,
    map: trimMap(meta.map), true: trimTrue(meta.true) };
  const lane = await laneTrace(M, sharp, pack, meta, bases.map(b => [b.x, b.y, b.level, b.mine ? 1 : 0]), [(windows[0].deed % cols) + 0.5, Math.floor(windows[0].deed / cols) + 0.5]);
  const stageB = await stageBRealm(M, pack, meta, [...baked]);
  const half = pb.width / 2;
  return {
    realm: id, status: meta.status, grid: [cols, rows], tolerance: 'exact: classes, ground, ring, sampledWet per vertex; detail doubles as IEEE-754 bits',
    classesOverride: meta.classes ?? null, hasShore: cfg.hasShore,
    // the realm.json sections GROUND's tables read (ground.js mapTables / trueSetup), trimmed to the keys they use
    mapMeta: meta.map ? { wild: meta.map.wild, families: meta.map.families, classToTerrain: meta.map.classToTerrain, layerOrder: meta.map.layerOrder ?? null, snowPeaks: meta.map.snowPeaks ?? null } : null,
    trueMeta: meta.true ? { atlas: { reserved0: meta.true.atlas?.reserved0 ?? null, layers: meta.true.atlas?.layers ?? null }, classToTerrain: meta.true.classToTerrain ?? null,
      families: (meta.true.families ?? []).map(f => ({ lower: f.lower, upper: f.upper, first: f.first })), fallback: meta.true.fallback ?? null,
      terrains: (meta.true.terrains ?? []).map(t => ({ id: t.id, kind: t.kind, layer: t.layer ?? null, pure: t.pure ?? null })),
      decalGroups: meta.true.decalGroups ?? null, water: meta.true.water ?? null, waterByClass: meta.true.waterByClass ?? null } : null,
    deeds: gz(deeds), fieldsA: { width: pa.width, height: pa.height, crops: rects.map(q => crop(pa, 8, q)), raw: rects.map(q => crop(rawImg, 8, q)) },
    fieldsBC: { width: pb.width, height: pb.height, crops: [...rects.map(q => crop(pb, 4, q, 0, half)), ...rects.map(q => crop(pb, 4, q, half, half))] },
    foreignSea: fsStats, clipTarns: tarns,
    lines: pack.lines,
    prepared: { bad: lines.bad, rivers: { count: lines.rivers.count, dropped: lines.rivers.dropped, segs: sha256(f64le(Array.from(lines.rivers.segs))) }, tracks: { count: lines.tracks.count } },
    bent: { moved: bent.moved ?? 0, blocked: bent.blocked ?? 0, count: bent.count, segs: sha256(f64le(Array.from(bent.segs))), pageKeys: sha256(i32le(pageKeys)), pages: pageKeys.length },
    basesColumns: ['deedX', 'deedY', 'level', 'mine'], bases: bases.map(b => [b.x, b.y, b.level, b.mine ? 1 : 0]),
    bridgesColumns: ['k', 'ux', 'uy', 'len', 'hw'],
    bridges: bases.map(b => b.k).sort((a, b) => a - b).map(k => [k, hx(bridges[k * 4]), hx(bridges[k * 4 + 1]), hx(bridges[k * 4 + 2]), hx(bridges[k * 4 + 3])]),
    windowsNote: 'vertices (x0 + i·step, y0 + j·step), row-major; cls / ground one hex digit per vertex, ring 0/1, wet = sampledWet 0/1/2; step 7 = the MAP lattice config (latticeCfg); detail = [i, j, coast, inland, river, lake, bridge, island, plot, track] every 32nd vertex',
    windows: results,
    regions,
    pages,
    laneMeta,
    lane,
    stageB,
    count: results.reduce((a, w) => a + w.w * w.h, 0) + regions.length * 256 + pages.length + bases.length + stageB.count,
  };
}


// ---- stage B pure exports (ground.js c87af40d, 36956b3d, f3cbda55, 2d134d40) -------------------------------------------
/** The loops GROUND draws (ground.js trueSetup: sea = waterByClass.SEA ?? DEEP ?? water, inland = WATER ?? water). */
const DEFAULT_LOOP = { first: 0, frames: 8, frameMs: 200, phases: 4 }; // ground.js trueSetup's fallback when true.water is absent
const loopsOf = t => { const w = t?.water ?? DEFAULT_LOOP, wbc = t?.waterByClass ?? {}; return { sea: wbc.SEA ?? wbc.DEEP ?? w, inland: wbc.WATER ?? w }; };
/** Synthetic deep colours for deepTint (the realm's own pal.deep is measured on chart8.webp, a WebP the JVM does not decode). */
const DEEP_SAMPLES = [[0, 0, 0], [0.1, 0.2, 0.3], [0.25, 0.5, 0.625], [0.07, 0.22, 0.49], [0.6, 0.7, 0.8], [1, 1, 1]];
/**
 * Per realm: the stage B values GROUND derives from realm.json alone (exact: no pixels), and for a gem-sea realm the gem
 * colours measured on ground.png (a PNG: the pinned loader.js decodePng is exact, so the JVM can match it bit for bit).
 * gemK = gemColours / max(kitWater, 0.02), clamped 0…8, where kitWater is ground.js trueSetup's meanOf (a closure,
 * transcribed: the opaque texels (alpha ≥ 128) of the sea loop's first cell, their mean / 255, null under 65 texels).
 */
async function stageBRealm(M, pack, meta, baked) {
  const G = M.ground, loops = loopsOf(meta.true), gems = G.waterGems(meta);
  const loopRow = w => [w.first ?? null, w.frames ?? null, w.phases ?? null, w.phaseStep ?? null, G.waterPhaseStep(w)];
  const byClass = Object.fromEntries(Object.entries(meta.true?.waterByClass ?? {}).map(([k, w]) => [k, loopRow(w)]));
  const out = {
    fieldsABaked: baked.sort(),
    loopColumns: ['first', 'frames', 'phases', 'phaseStep (realm.json)', 'waterPhaseStep'],
    loops: { sea: loopRow(loops.sea), inland: loopRow(loops.inland), water: meta.true?.water ? loopRow(meta.true.water) : null, waterByClass: byClass },
    famClamp: G.famClamp(meta).map(hx), waterGems: hx(gems), gemHighlight: hx(G.gemHighlight(meta)), gemD: [48, 150],
    gemDrift: G.gemDrift(meta.true?.waterByClass?.SEA ?? meta.true?.water).map(hx),
    deepTintColumns: ['deep r', 'g', 'b', 'deepTint r', 'g', 'b'], deepTint: DEEP_SAMPLES.map(d => [...d, ...G.deepTint(d, meta)].map(hx)),
    gems: null,
  };
  if (gems > 0) {
    const A = meta.true?.atlas ?? {}, gp = await M.loader.decodePng(pack.files[A.file ?? 'ground.png']);
    const cell = A.cell ?? 32, colsA = A.cols ?? Math.floor(gp.width / cell), first = loops.sea.first ?? 0, ox = (first % colsA) * cell, oy = Math.floor(first / colsA) * cell;
    const sm = [0, 0, 0, 0];
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) { const o = ((oy + y) * gp.width + ox + x) * 4; if (gp.data[o + 3] < 128) continue; sm[0] += gp.data[o]; sm[1] += gp.data[o + 1]; sm[2] += gp.data[o + 2]; sm[3]++; }
    const kitWater = sm[3] > 64 ? [sm[0] / sm[3] / 255, sm[1] / sm[3] / 255, sm[2] / sm[3] / 255] : null;
    const col = G.gemColours(gp.data, gp.width, ox, oy, cell);
    const k = col && kitWater ? col.map(c => c.map((v, i) => Math.max(0, Math.min(8, v / Math.max(kitWater[i], 0.02))))) : null;
    out.gems = { file: A.file ?? 'ground.png', cell, colsA, cellOrigin: [ox, oy], kitWater: kitWater && kitWater.map(hx), colours: col && col.map(c => c.map(hx)), gemK: k && k.map(c => c.map(hx)) };
  }
  out.count = 5 + Object.keys(byClass).length + DEEP_SAMPLES.length + (out.gems ? 3 : 0);
  return out;
}

/** Realm-independent stage B vectors: waterPhaseStep, famClamp and waterGems on synthetic loops and overrides. */
function stageBCommon(M) {
  const G = M.ground;
  const loops = [null, {}, { frames: 8 }, { frames: 8, phases: 4 }, { frames: 16, phases: 4 }, { frames: 16, phases: 4, phaseStep: 4 }, { frames: 16, phases: 4, phaseStep: 3 },
    { frames: 8, phases: 4, phaseStep: 0 }, { frames: 8, phases: 4, phaseStep: -2 }, { frames: 8, phases: 4, phaseStep: 2.5 }, { frames: 8, phases: 4, phaseStep: 99 }, { frames: 6, phases: 4 },
    { frames: 3, phases: 4 }, { frames: 1, phases: 4 }, { frames: 0, phases: 0 }, { frames: 12, phases: 5 }, { frames: 7.9, phases: 2 }, { frames: '8', phases: 4 }];
  const ids = ['crownlands', 'elderwood', 'thornwake', 'seeker-reach', 'cinderfall', 'nowhere'];
  const clampOverrides = [undefined, [0.5, 2], [0, 2], [0.5, 1], [0.5, 4], [0.5, 4.5], [0.5], ['0.5', 2], [0.99, 1.01], [NaN, 2]];
  const gemOverrides = [undefined, 0, 0.05, 0.2, 0.21, -0.01, NaN, '0.1'];
  const enc = v => (v === undefined ? 'undefined' : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v);
  return {
    note: 'waterPhaseStep(loop) (loop null = absent); famClamp({ id, map: { famClamp } }) and waterGems({ id, map: { waterGems } }) per realm id × override '
      + '("undefined" = the key absent; "NaN" = the number NaN; a string stays a string, which the web rejects). Doubles as IEEE-754 bits.',
    waterPhaseStep: loops.map(w => [w && JSON.parse(JSON.stringify(w)), G.waterPhaseStep(w)]),
    famClamp: ids.flatMap(id => clampOverrides.map(o => [id, o === undefined ? 'undefined' : o.map(enc), G.famClamp({ id, map: o === undefined ? {} : { famClamp: o } }).map(hx)])),
    waterGems: ids.flatMap(id => gemOverrides.map(o => [id, enc(o), hx(G.waterGems({ id, map: o === undefined ? {} : { waterGems: o } }))])),
    gemHighlight: ids.map(id => [id, hx(G.gemHighlight({ id }))]),
    gemDrift: [null, {}, { drift: [7, 0], frameMs: 200 }, { drift: [3, -2], frameMs: 150 }, { drift: [1], frameMs: 200 }, { drift: [1, 1], frameMs: 0 }].map(w => [w, G.gemDrift(w).map(hx)]),
  };
}

// ---- the lane parity trace: the pinned ground.js on a recording fake core over the real pack ------------------------
// createGround(core).load(pack) runs as in the browser (the exact PNG decoder, sharp for the WebP art, the real lru), then
// setBases (the realm suite's plots), one MAP frame and one TRUE frame (update + draw) on a 914×2034 canvas. Every uniform
// ground.js sets is recorded per program, first and last value (WebGL's float32 for floats, int32 bits for ints). The native
// GroundLane test runs the same frames on its fake GL and compares every value that does not depend on the painting's
// pixels (the palette and family grade are measured on chart8 / mapkit colours, which the JVM test does not decode).
const GL_CONST = { FRAMEBUFFER: 0x8d40, TEXTURE_2D: 0x0de1, TEXTURE_2D_ARRAY: 0x8c1a, BLEND: 0x0be2, DEPTH_TEST: 0x0b71, CULL_FACE: 0x0b44,
  SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, MAX_TEXTURE_SIZE: 0x0d33, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, RGBA_INTEGER: 0x8d99, UNSIGNED_INT: 0x1405 };
async function laneTrace(M, sharp, pack, meta, bases, at) {
  const W = 914, H = 2034, rec = { first: new Map(), last: new Map(), cur: null };
  const put = (p, n, vals, isInt) => {
    const v = Array.from(vals, x => (isInt ? (Number(x) | 0) : Math.fround(Number(x))));
    for (const m of [rec.last, rec.first]) { let e = m.get(p.name); if (!e) m.set(p.name, e = new Map()); if (m === rec.last || !e.has(n)) e.set(n, v); }
  };
  const I = (l, ...a) => l && put(l.p, l.n, a, true), F = (l, ...a) => l && put(l.p, l.n, a, false);
  const IV = (l, v) => l && put(l.p, l.n, v, true), FV = (l, v) => l && put(l.p, l.n, v, false);
  const gl = { ...GL_CONST, drawingBufferWidth: W, drawingBufferHeight: H, canvas: { width: W, height: H },
    getParameter: k => (k === GL_CONST.MAX_TEXTURE_SIZE ? 4096 : 0),
    uniform1i: I, uniform2i: I, uniform4i: I, uniform4ui: I, uniform1f: F, uniform2f: F, uniform3f: F, uniform4f: F,
    uniform1iv: IV, uniform2iv: IV, uniform4iv: IV, uniform3fv: FV, uniform4fv: FV,
    viewport() {}, bindFramebuffer() {}, bindTexture() {}, generateMipmap() {}, enable() {}, disable() {}, blendFunc() {}, clearColor() {}, clear() {}, readPixels() {} };
  const progs = new Map();
  const prog = name => { const p = { name, ready: true, drawn: true, use() { rec.cur = p; return p; }, u: n => ({ p, n }), tex(n, unit) { put(p, n, [unit], true); return p; } }; progs.set(name, p); return p; };
  // (stage B D3: ground.js shares chart8, deeds and the far field with the minimap through core.tex.shared(key, make);
  // one module here, so the first caller makes it)
  const shared = new Map();
  const tex = { image: () => ({ w: 1, h: 1, t: {} }), data: (w, h) => ({ w, h, t: {} }), array: (w, h, n) => ({ w, h, layers: n, t: {} }), layer() {}, update() {}, free() {},
    shared: (key, make) => { if (!shared.has(key)) shared.set(key, make()); return shared.get(key); } };
  const core = { gl, include() {}, program: name => prog(name), tex, lru: M.core.lru, fbo() {}, fullscreen() {}, invalidate() {}, sinceInput: () => 1e9, animating() {},
    stats: () => ({ gpu: { groundScale: 1 } }) };
  const cache = new Map();
  const pixels = key => { if (!cache.has(key)) cache.set(key, (async () => { const b = pack.files[key]; if (!b) throw Object.assign(new Error('404 ' + key), { status: 404 });
    if (key.endsWith('.png')) return M.loader.decodePng(b);
    const r = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: r.info.width, height: r.info.height, data: new Uint8Array(r.data) }; })()); return cache.get(key); };
  const deeds = new Uint8Array(meta.grid.cols * meta.grid.rows); { const d = await pixels('deeds.png'); for (let i = 0; i < deeds.length; i++) deeds[i] = d.data[i * 4]; }
  const P = { id: meta.id, meta, first: { chart8: {}, deeds, chartKey: 'chart8.webp' },
    bitmap: async k => { if (!pack.files[k]) throw Object.assign(new Error('404 ' + k), { status: 404 }); return {}; },
    json: async k => { if (k === 'lines.json') return pack.lines; throw Object.assign(new Error('404 ' + k), { status: 404 }); }, pixels };
  const g = M.ground.createGround(core);
  await g.load(P);
  g.setBases(bases.map(([x, y, level, mine]) => ({ x, y, level, mine: !!mine })));
  for (let i = 0; i < 500 && !g.classState(); i++) await new Promise(r => setTimeout(r, 10));
  if (!g.classState()) throw new Error(`${meta.id}: ground base-state work never settled`);
  const view = (x, y, d, w) => { const hw = W / d / 2, hh = H / d / 2; return { x, y, d, rect: { fx0: x - hw, fx1: x + hw, fy0: y - hh, fy1: y + hh }, w, moving: false, band: '', reducedMotion: false }; };
  const snap = () => { const o = {}; for (const [k, m] of [['first', rec.first], ['last', rec.last]]) { o[k] = {}; for (const [p, e] of m) { o[k][p] = {}; for (const [n, v] of e) o[k][p][n] = v; } } rec.first.clear(); rec.last.clear(); return o; };
  const frames = {};
  const mapV = view(at[0], at[1], 150, { far: 0, map: 1, true: 0, decor: 0 });
  g.update(mapV); g.draw(mapV); frames.map = snap();
  const trueV = view(at[0], at[1], 1200, { far: 0, map: 0, true: 1, decor: 1 });
  g.update(trueV); g.draw(trueV); frames.true = snap();
  // the band rehearsal hook (W1 G1) on every GROUND program at the TRUE view, its data in: probes, then the real states
  for (const n of ['rm-raw', 'rm-despeckle', 'rm-legalise', 'rm-pure', 'rm-record', 'rm-map', 'rm-true']) if (!g.rehearse(progs.get(n), trueV)) throw new Error(`${meta.id}: ground.rehearse(${n}) drew nothing`);
  frames.rehearse = snap();
  const st = g.stats();
  const L = st.lines ?? {}; // (bakeMs is a wall time: never in a golden; nor is stage B's bends.ms)
  const bends = st.bends ? { moved: st.bends.moved, blocked: st.bends.blocked } : null;
  return { canvas: [W, H], at, frames, stats: { recPages: st.recPages, bends, lines: { capacity: L.capacity, riverPages: L.riverPages, landPages: L.landPages, texture: L.texture, rebakes: L.rebakes } } };
}

// ---- driver -------------------------------------------------------------------------------------------------------
export async function generate({ repo, root = ROOT }) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')), pin = lock.source.commit;
  const pinned = pinnedManifest(repo, lock);
  const byPath = new Map(pinned.manifest.files.map(f => [f.path, f]));
  const read = rel => { const f = byPath.get(rel), b = fs.readFileSync(path.join(repo, PACK_DIR, rel));
    if (!f || f.bytes !== b.length || f.sha256 !== sha256(b)) throw new Error(`REFUSED: ${rel} is not the pinned pack byte for byte`); return b; };
  const packs = pinned.manifest.realms.map(({ id }) => ({ id, meta: JSON.parse(read(`realm/${id}/realm.json`).toString('utf8')), lines: JSON.parse(read(`realm/${id}/lines.json`).toString('utf8')),
    files: Object.fromEntries(['deeds.png', 'fieldsA.png', 'fieldsBC.png', 'chart8.webp', 'mapkit.png', 'mapmask.png', 'ground.png', 'groundmask.png', 'decals.png', 'tone.webp', 'plots.webp']
      .filter(f => byPath.has(`realm/${id}/${f}`)).map(f => [f, new Uint8Array(read(`realm/${id}/${f}`))])) })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-ground-golden-'));
  try {
    extractPinned(repo, pin, [ENGINE, ...SHARED], tmp);
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(tmp, 'packages/shared/node_modules'), 'dir');
    const load = await moduleLoader(repo), dir = path.join(tmp, ENGINE);
    const files = { classify: 'classify.js', groundcost: 'groundcost.js', contracts: 'contracts.js', ground: 'ground.js', loader: 'loader.js', minimap: 'minimap.js', common: 'glsl/common.glsl.js', core: 'core.js' };
    const entry = path.join(tmp, 'ground-golden-entry.mjs');
    fs.writeFileSync(entry, Object.entries(files).map(([k, f]) => `export * as ${k} from ${JSON.stringify('./' + path.posix.join(ENGINE, f))};`).join('\n') + '\n');
    const M = { ...(await load(entry)) };
    // ground.js farField is minimap.js farDeeds verbatim (the generator uses the exported one): prove it on the pinned text
    const body = s => s.replace(/\s+/g, '');
    const gsrc = fs.readFileSync(path.join(dir, 'ground.js'), 'utf8'), msrc = fs.readFileSync(path.join(dir, 'minimap.js'), 'utf8');
    const gf = gsrc.slice(gsrc.indexOf('function farField(deeds) {'), gsrc.indexOf('return D;', gsrc.indexOf('function farField(deeds) {')));
    const mf = msrc.slice(msrc.indexOf('export function farDeeds(deeds, cols, rows) {'), msrc.indexOf('return D;', msrc.indexOf('export function farDeeds(deeds, cols, rows) {')));
    if (body(gf.replace('function farField(deeds) {', '')) !== body(mf.replace('export function farDeeds(deeds, cols, rows) {', ''))) throw new Error('ground.js farField is no longer minimap.js farDeeds: update the generator');
    const sharp = createRequire(path.join(repo, 'scripts/package.json'))('sharp');
    const sources = Object.fromEntries([...Object.values(files)].map(f => [`${ENGINE}/${f}`, sha256(fs.readFileSync(path.join(dir, f)))]));
    const generator = sha256(fs.readFileSync(SELF)), out = new Map();
    const packInfo = { manifestSha256: pinned.sha256, packVersion: pinned.manifest.packVersion };
    const put = (suite, bodyObj, withPack) => out.set(`${suite}.json`, Buffer.from(serialize({ schema: 1, suite, pin, generator, sources, pack: withPack ? packInfo : undefined, ...bodyObj }) + '\n'));
    put('math', mathSuite(M), false);
    put('groundcost', groundcostSuite(M), false);
    { const c = classifyCommonSuite(M, L => M.contracts.plotRule(L)), b = stageBCommon(M);
      put('classify-common', { ...c, stageB: b, count: c.count + b.waterPhaseStep.length + b.famClamp.length + b.waterGems.length + b.gemHighlight.length + b.gemDrift.length }, false); }
    for (const p of packs) put(`classify-${p.id}`, await realmSuite(M, sharp, p), true);
    return out;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function compare(root, files) {
  const dir = path.join(root, OUT_DIR), drift = [];
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
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
    if (drift.length) { console.error(`world ground golden drift:\n  ${drift.join('\n  ')}`); return 1; }
    console.log(`world ground golden: no drift (${files.size} suites)`);
    return 0;
  }
  const dir = path.join(root, OUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.rmSync(path.join(dir, f));
  let bytes = 0; for (const [rel, b] of files) { fs.writeFileSync(path.join(dir, rel), b); bytes += b.length; }
  console.log(`world ground golden: wrote ${files.size} suites (${bytes} bytes) into ${OUT_DIR}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
