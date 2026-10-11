// Golden vectors for the native globe port's pure functions (GLOBE-NATIVE-PLAN §7), computed by the PINNED web code.
//
//   node tools/world-golden.mjs --source <SHARDKEEP-globe repo>           write renderer/src/test/resources/world/golden
//   node tools/world-golden.mjs --source <SHARDKEEP-globe repo> --check   regenerate in memory and byte-compare (drift fails)
//
// Every value comes from the web modules at the shader pin (world-shaders.lock.json), extracted with git archive and
// imported under Node (the source repo's tsx transpiles packages/shared): contracts.js, groundcost.js, camera.js, ui.js
// (clusterCounters), loader.js (decodePng), core.js (gpuRecord, the crash memory; bandLimit, the band gate) and
// packages/shared fantasyWorld.ts (the frozen deed catalog, server truth).
// The only realm pack bytes read are realm.json and deeds.png, checked against the pack manifest at the pin. Where the
// web has no exported function (the §2.4.2 deed ↔ tile pair, map.js's pick fallback) the generator states the formula
// it transcribes, with its source line, and every other number still comes from the pinned modules.
//
// One JSON per suite: { schema, suite, pin, generator (sha256 of this file), sources (sha256 per pinned module),
// tolerance, count, ... }. Keys are sorted, integers exact, floats are JavaScript's shortest round-trip form, and a
// non-finite number is written as the string "Infinity" / "-Infinity" / "NaN".
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, LOCK_FILE, SHARED, extractPinned, moduleLoader } from './world-shaders.mjs';
import { PACK_DIR, pinnedManifest } from './world-debug-content.mjs';

export const OUT_DIR = 'renderer/src/test/resources/world/golden';
export const SUITES = ['contracts', 'camera', 'grid', 'deedmask', 'pick', 'cluster', 'gpurecord', 'bandlimit'];
/** The engine's presentation constants as Kotlin (plan §4.3), generated from the same pinned modules as the goldens. */
export const KOTLIN_CONSTANTS = 'renderer/src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/generated/WorldEngineConstants.kt';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const LATTICE_W = 720, LATTICE_H = 360;

// ---- serialization ----------------------------------------------------------------------------------------------------
const prim = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : JSON.stringify(String(v));
  return JSON.stringify(v);
};
const flat = v => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every(x => x === null || typeof x !== 'object'));
/** Sorted keys; an array of primitives (or of primitive tuples) stays on one line, so a table is one line per row. */
export function serialize(v, ind = '') {
  if (v === null || typeof v !== 'object') return prim(v);
  const i2 = ind + ' ';
  if (Array.isArray(v)) {
    if (v.every(x => x === null || typeof x !== 'object')) return '[' + v.map(prim).join(',') + ']';
    if (v.every(flat)) return '[\n' + v.map(x => i2 + serialize(x, i2)).join(',\n') + '\n' + ind + ']';
    return '[\n' + v.map(x => i2 + serialize(x, i2)).join(',\n') + '\n' + ind + ']';
  }
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  if (!keys.length) return '{}';
  return '{\n' + keys.map(k => `${i2}${JSON.stringify(k)}: ${serialize(v[k], i2)}`).join(',\n') + '\n' + ind + '}';
}

// ---- deterministic samples ----------------------------------------------------------------------------------------------
/** mulberry32: the web tests' own sample generator (ui.test.mjs rng), so a sample set is reproducible anywhere. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const floorMod = (a, n) => ((a % n) + n) % n;
/** GLOBE-PRODUCTION-PLAN §2.4.2 (the web has no exported pair): tileId = (y0 + dy)·720 + ((x0 + dx) mod 720). */
const tileOf = (g, dx, dy) => (dx < 0 || dy < 0 || dx >= g.cols || dy >= g.rows || g.y0 + dy < 0 || g.y0 + dy >= LATTICE_H ? -1 : (g.y0 + dy) * LATTICE_W + floorMod(g.x0 + dx, LATTICE_W));
const deedOf = (g, tile) => { const dx = floorMod((tile % LATTICE_W) - g.x0, LATTICE_W), dy = Math.floor(tile / LATTICE_W) - g.y0; return dx < g.cols && dy >= 0 && dy < g.rows ? [dx, dy] : null; };

// ---- suites -------------------------------------------------------------------------------------------------------------
function contractsSuite(M) {
  const C = M.contracts, G = M.groundcost;
  const levels = [-3, 0, 0.4, 1, 1.5, 2.5, 7, 19.5, 20, 21, 99];
  const r = rng(0x5eed01), deeds = [[0, 0], [1, 0], [0, 1], [719, 359], [118, 58], [177, 130], [123456, 654321], [-5, 3], [2147483647, -2147483648]];
  while (deeds.length < 500) deeds.push([Math.floor(r() * 720), Math.floor(r() * 360)]);
  const hash = deeds.map(([x, y]) => [x, y, C.plotHash(x, y)]);
  const offsets = {}; for (let L = 1; L <= 20; L++) offsets[L] = deeds.flatMap(([x, y]) => { const o = C.plotOffset(x, y, L); return [o.dx, o.dy]; });
  const centres = deeds.slice(0, 50).map(([x, y]) => Array.from({ length: 20 }, (_, i) => { const c = C.plotCentre(x, y, i + 1); return [c.x, c.y]; }));
  const decorKeys = Object.keys(C.DECOR_CAP).sort();
  return {
    tolerance: 'exact',
    note: 'plotOffset[L] = [dx0, dy0, dx1, dy1, …] over deeds in order; plotCentre[i][L-1] = [x, y] for deeds[i], i < 50.',
    constants: {
      TILES: C.TILES, ART: C.ART, CELL: C.CELL, CELLS: C.CELLS, DEED_ART: C.DEED_ART, MAP_ART: C.MAP_ART, WORLD_ORIGIN: C.WORLD_ORIGIN, DEED_DEG: C.DEED_DEG,
      BANDS: C.BANDS, SELECT_D: C.SELECT_D, MY_BASE_D: C.MY_BASE_D, KEEP_FIT: C.KEEP_FIT, LINES: C.LINES, IDLE: C.IDLE, GPU_SAFE: C.GPU_SAFE,
      CLASS: C.CLASS, FLAG: C.FLAG, KIND: C.KIND, DEED_PX: C.DEED_PX, PLOT_CENTRE: C.PLOT_CENTRE, PLOT_OFFSET: C.PLOT_OFFSET, UNITS: C.UNITS, UBO_VIEW: C.UBO_VIEW,
      REALMS_WITH_MAPS: C.REALMS_WITH_MAPS, REALM_NAMES: C.REALM_NAMES, DEED_COUNTS: C.DEED_COUNTS, GROUND_API: C.GROUND_API,
    },
    groundcost: {
      PASS: G.PASS, ITERS: G.ITERS, PASS_BUDGET: G.PASS_BUDGET, ITER_BUDGET: G.ITER_BUDGET, FRAME_BUDGET: G.FRAME_BUDGET, FRAME_ITER_BUDGET: G.FRAME_ITER_BUDGET,
      DISPLAY_BUDGET: G.DISPLAY_BUDGET, RESOLVE_BUDGET: G.RESOLVE_BUDGET, RESOLVE: G.RESOLVE, REC_PAGES: G.REC_PAGES,
    },
    plotRule: levels.map(L => ({ in: L, ...C.plotRule(L) })),
    plotRoom: Array.from({ length: 20 }, (_, i) => C.plotRoom(i + 1)),
    towerTier: Array.from({ length: 20 }, (_, i) => C.towerTier(i + 1)),
    wallCapForKeepLevel: Array.from({ length: 20 }, (_, i) => C.wallCapForKeepLevel(i + 1)),
    decorCap: Object.fromEntries(decorKeys.map(k => [k, Array.from({ length: 20 }, (_, i) => C.decorCap(k, i + 1))])),
    deeds: hash.map(([x, y]) => [x, y]),
    plotHash: hash.map(h => h[2]),
    plotOffset: offsets,
    plotCentre: centres,
    count: hash.length * 21 + 50 * 20,
  };
}

function cameraSuite(M) {
  const K = M.camera, B = M.contracts.BANDS;
  const edges = [...new Set([B.farEnd, B.mapStart, B.trueStart, B.trueFull, ...B.impostor, ...B.twins, B.snap])].sort((a, b) => a - b);
  const ds = new Set();
  for (const e of edges) for (const v of [e - 1, e - 1e-6, e * (1 - 1e-8), e * (1 - 1e-10), e, e * (1 + 1e-10), e * (1 + 1e-8), e + 1e-6, e + 1]) ds.add(v);
  for (let i = 0; i < 2000; i++) ds.add(Math.exp(Math.log(0.5) + (Math.log(20000) - Math.log(0.5)) * i / 1999));
  const D = [...ds].sort((a, b) => a - b);
  const bands = D.map(d => { const b = K.bands(d); return [d, K.snapEdge(d), K.inRest(d) ? 1 : 0, K.bandOf(d), b.fadeWeight, K.restTarget(d), b.w.far, b.w.map, b.w.true, b.w.twins, b.w.decor, b.w.herds, b.w.creatures, b.w.sway]; });
  const inside = [];
  for (const [a, b] of B.rest) for (let i = 1; i < 12; i++) inside.push(a * (b / a) ** (i / 12));
  const limits = [[0, Infinity], [30, Infinity], [0, 40], [50, 300], [250, 900], [210, 270], [900, 1000]];
  const rest = inside.flatMap(d => limits.map(([lo, hi]) => [d, lo, hi, K.restTarget(d, lo, hi)]));
  const snap = [3000, 3135.9, 3136, 3500, 4704, 4705, 6272, 9407, 9408, 15000, 20000].flatMap(d => [Infinity, 6272, 9000, 3136, 2000].map(hi => [d, hi, K.snapD(d, hi)]));
  const traces = cameraTraces(K, B, M.contracts.GPU_SAFE.rehearse);
  return {
    tolerance: 'relative 1e-9 (log/exp/sin/hypot); band names, rest flags and moving/goal/pressing exact',
    edges,
    bandsColumns: ['d', 'snapEdge', 'inRest', 'bandOf', 'fadeWeight', 'restTarget', 'w.far', 'w.map', 'w.true', 'w.twins', 'w.decor', 'w.herds', 'w.creatures', 'w.sway'],
    bands,
    restColumns: ['d', 'lo', 'hi', 'restTarget(d, lo, hi)'],
    rest,
    snapColumns: ['d', 'hi', 'snapD(d, hi)'],
    snap,
    tracesNote: 'createCamera({now}) replayed: each op is [clockMs, name, ...args] applied after setting the fake clock; '
      + 'state after the op is [x, y, s, moving 0|1, goal kind|null, pressing 0|1, return value|null]. Ops: viewport(W,H,dpr) grid(cols,rows) '
      + 'set(x,y,s) begin() pan(dx,dy) zoomAt(sx,sy,k) end(vx,vy,fx,fy) step(t) wheel(sx,sy,k) flyToD(x,y,d,ms) zoomAround(sx,sy,k,ms) limitD(d) settle(fx,fy). '
      + 'Stage B (D-173, camera.js 911b39c5/46c197f7): floorD(d|null) = setFloorD(d) (null: no floor, sMin is the fit); '
      + 'flyToDRaw(x,y,d,ms) = flyToD(x,y,d,ms,{raw:true}) (the leave: no rest rule, no floor, s1 = clamp(d, 1e-3, dHi) / dpr); '
      + 'setFree(x,y,s) = set(x,y,s,{free:true}) (QA placement below the floor). The floor itself is not in the state tuple: '
      + 'it is exactly the last floorD op of the trace.',
    traces,
    count: bands.length + rest.length + snap.length + traces.reduce((s, t) => s + t.states.length, 0),
  };
}

const VIEWPORTS = {
  // CSS px + dpr. Seeker: the public 1200×2670 panel at the three candidate densities (plan §1.2, unverified).
  'seeker-2.625': [1200 / 2.625, 2670 / 2.625, 2.625],
  'seeker-2.75-landscape': [2670 / 2.75, 1200 / 2.75, 2.75],
  'phone-390': [390, 844, 3],
  // N3 (NM): the Seeker as measured in the owner's N1/N2 session (1200×2670 at density 3.0 → 400×890 dp), drawn by the
  // native engine on its fixed dpr-2 buffer (800×1780): the camera the owner actually pinches.
  'seeker-3.0-native': [1200 / 3, 2670 / 3, 2],
};
function cameraTraces(K, B, RH) {
  const out = [];
  const run = (name, vp, grid, script) => {
    let T = 0; const cam = K.createCamera({ now: () => T }), ops = [], states = [];
    const state = ret => [cam.x, cam.y, cam.s, cam.moving ? 1 : 0, cam.goal?.kind ?? null, cam.pressing ? 1 : 0, ret === undefined ? null : ret];
    const call = (t, op, ...args) => {
      T = t; let ret;
      switch (op) {
        case 'viewport': cam.setViewport(...args); break; case 'grid': cam.setGrid(...args); break; case 'set': cam.set(...args); break;
        case 'begin': cam.beginGesture(); break; case 'pan': cam.panBy(...args); break; case 'zoomAt': cam.zoomAt(...args); break;
        case 'end': cam.endGesture({ vx: args[0], vy: args[1], fx: args[2], fy: args[3] }); break; case 'step': ret = cam.step(args[0]); break;
        case 'wheel': cam.wheel(...args); break; case 'flyToD': cam.flyToD(...args); break; case 'zoomAround': cam.zoomAround(...args); break;
        case 'limitD': cam.limitD(args[0]); break; case 'settle': ret = cam.settle(args[0], args[1]); break;
        case 'floorD': cam.setFloorD(args[0]); break; case 'flyToDRaw': cam.flyToD(args[0], args[1], args[2], args[3], { raw: true }); break;
        case 'setFree': cam.set(args[0], args[1], args[2], { free: true }); break;
        default: throw new Error(`unknown op ${op}`);
      }
      ops.push([t, op, ...args]); states.push(state(ret));
    };
    const steps = (from, ms) => { let t = from; for (let i = 0; t < from + ms; i++) { t = from + (i + 1) * 16.667; call(t, 'step', t); } return t; };
    call(0, 'viewport', ...vp); call(0, 'grid', ...grid);
    script({ call, steps, cam, vp, grid });
    out.push({ name, viewport: vp, grid, ops, states });
  };
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    const [W, H, dpr] = vp, cx = W / 2, cy = H / 2, crown = [178, 131];
    run(`${vpName}: pinch into the FAR→MAP rest band, release, ease to the nearer edge`, vp, crown, ({ call, steps, cam }) => {
      call(0, 'set', 89, 65.5, cam.sMin()); call(10, 'begin'); call(20, 'zoomAt', cx + 30, cy - 40, 30 / (cam.s * dpr)); call(40, 'end', 0, 0, cx + 30, cy - 40); steps(40, 320);
    });
    run(`${vpName}: pan then fling with inertia`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 60, 40, 60 / dpr); call(10, 'begin');
      for (let i = 0; i < 5; i++) call(10 + (i + 1) * 16, 'pan', 40, -10);
      call(100, 'end', 1.2, -0.3, cx, cy); steps(100, 1500);
    });
    run(`${vpName}: fly to a deed at selectD`, vp, crown, ({ call, steps, cam }) => {
      call(0, 'set', 89, 65.5, cam.sMin()); call(5, 'flyToD', 140.5, 30.5, B.selectD, 700); steps(5, 800);
    });
    run(`${vpName}: double-tap ×2.4 into the impostor rest band`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 100, 70, 100 / dpr); call(5, 'zoomAround', cx - 20, cy + 50, 2.4, 320); steps(5, 700);
    });
    run(`${vpName}: zoom past the pixel-snap threshold and settle on whole device px per art px`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 100.3, 70.7, 3300 / dpr); call(5, 'begin'); call(15, 'zoomAt', cx, cy, 1.1); call(30, 'end', 0, 0, cx, cy); steps(30, 320);
    });
    run(`${vpName}: a flight aimed past a closed band gate waits at the edge and resumes when it opens`, vp, crown, ({ call, steps, cam }) => {
      call(0, 'set', 89, 65.5, cam.sMin()); call(1, 'limitD', B.farEnd); call(5, 'flyToD', 120.5, 80.5, B.selectD, 700); let t = steps(5, 800);
      call(t + 10, 'limitD', Infinity); steps(t + 10, 600);
    });
    run(`${vpName}: wheel burst then the delayed rest rule`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 89, 65.5, 30 / dpr); call(10, 'wheel', cx, cy, 1.25); call(30, 'wheel', cx, cy, 1.25); call(50, 'wheel', cx, cy, 1.1); steps(50, 500);
    });
    run(`${vpName}: Cinderfall pinch-out below the fit floor, clamp and settle`, vp, [119, 59], ({ call, steps, cam }) => {
      call(0, 'set', 59.5, 29.5, cam.sMin() * 1.5); call(5, 'begin'); call(15, 'zoomAt', cx, cy, 0.3); call(25, 'pan', -500, 300); call(30, 'end', 0, 0, cx, cy); steps(30, 320);
      call(400, 'settle', cx, cy);
    });
    // ---- N3 (NM): the MAP and TRUE bands the native realm map now enters (band gate, rest bands, pixel snap at TRUE) ----
    run(`${vpName}: fly from the fit to your base at TRUE (myBaseD) and stay there`, vp, crown, ({ call, steps, cam }) => {
      call(0, 'set', 89, 65.5, cam.sMin()); call(5, 'flyToD', 101.37, 58.64, B.myBaseD, 900); steps(5, 1000);
    });
    run(`${vpName}: pinch out of TRUE into the MAP→TRUE rest band, release, ease to the nearer edge`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 101.37, 58.64, B.myBaseD / dpr); call(10, 'begin'); call(20, 'zoomAt', cx - 15, cy + 25, 0.7); call(40, 'end', 0, 0, cx - 15, cy + 25); steps(40, 320);
    });
    run(`${vpName}: a flight to TRUE held at the TRUE gate waits at trueStart and resumes when it opens`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 101.2, 58.3, 150 / dpr); call(1, 'limitD', B.trueStart); call(5, 'flyToD', 101.5, 58.5, B.myBaseD, 700); let t = steps(5, 800);
      call(t + 10, 'limitD', Infinity); steps(t + 10, 600);
    });
    run(`${vpName}: at TRUE pan then fling, and settle on the pixel-snap`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 101.37, 58.64, B.snap / dpr); call(10, 'begin');
      for (let i = 0; i < 5; i++) call(10 + (i + 1) * 16, 'pan', -30, 12);
      call(100, 'end', -0.8, 0.3, cx, cy); steps(100, 1500);
    });
    run(`${vpName}: double-tap at MAP ×2.4 toward TRUE rests outside the MAP→TRUE fade`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 101.37, 58.64, 400 / dpr); call(5, 'zoomAround', cx + 20, cy - 30, 2.4, 320); steps(5, 700);
    });
    // ---- stage B, D-173 (owner 2026-09-25): the zoom floor is BANDS.mapStart once the dive landed; the dive holds in the
    // chart at farEnd until the band gate opens, then flies diveMs to the floor; the leave is a raw flight into the chart.
    // map.js order: enter() set(d0) → startDive limitD(farEnd) + flyToD(mapStart, diveMs) → landing setFloorD(mapStart);
    // exit() setFloorD(null) + flyToD(x, y, min(d, farEnd·0.9), leaveMs, {raw}). d0 is the web camera test's entry.
    const floor = B.mapStart;
    run(`${vpName}: D-173 floor: a deep pinch-out undershoots to 0.6 × the floor, release, settle back on the floor`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 89, 65.5, floor * 1.5 / dpr); call(1, 'floorD', floor); call(10, 'begin'); call(20, 'zoomAt', cx + 10, cy - 20, 0.05); call(40, 'end', 0, 0, cx + 10, cy - 20); steps(40, 400);
    });
    run(`${vpName}: D-173 floor: a wheel burst out, then the delayed settle on the floor`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 89, 65.5, 64 / dpr); call(1, 'floorD', floor);
      for (let i = 0; i < 8; i++) call(10 + i * 16, 'wheel', cx - 25, cy + 15, 0.8);
      steps(10 + 7 * 16, 600);
    });
    run(`${vpName}: D-173 floor: a flight aimed at the chart lands on the floor`, vp, crown, ({ call, steps }) => {
      call(0, 'set', 89, 65.5, 64 / dpr); call(1, 'floorD', floor); call(5, 'flyToD', 110.5, 72.5, 10, 300); steps(5, 400);
    });
    run(`${vpName}: D-173 QA setFree places below the floor, and settle returns to the floor`, vp, crown, ({ call, steps }) => {
      call(0, 'floorD', floor); call(1, 'setFree', 89, 65.5, 6 / dpr); call(2, 'set', 89, 65.5, 6 / dpr); call(3, 'setFree', 89, 65.5, 6 / dpr);
      call(10, 'settle', cx, cy); steps(10, 400);
    });
    run(`${vpName}: D-173 leave: from TRUE, the floor lifts and the raw flight zooms out below it into the chart`, vp, crown, ({ call, steps, cam }) => {
      call(0, 'set', 101.37, 58.64, B.myBaseD / dpr); call(1, 'floorD', floor);
      call(10, 'floorD', null); call(10, 'flyToDRaw', cam.x, cam.y, Math.min(cam.d, B.farEnd * 0.9), RH.leaveMs); steps(10, RH.leaveMs + 50);
    });
    const dive = (name, open) => run(`${vpName}: D-173 dive: ${name}`, vp, crown, ({ call, steps, cam }) => {
      const d0 = Math.min(12, cam.sMin() * dpr * 2);
      call(0, 'set', 89, 65, d0 / dpr); call(0, 'limitD', B.farEnd); call(0, 'flyToD', 89, 65, floor, RH.diveMs);
      let t = open === 'held' ? steps(0, RH.diveMs + 200) : steps(0, open);
      call(t + 1, 'limitD', Infinity); t = steps(t + 1, RH.diveMs + 500);
      call(t + 1, 'floorD', floor);
    });
    dive('the gate opens on the first frame, while the camera still flies to the chart edge (resumes at k ≥ 1)', 16);
    dive('the gate opens mid-approach (resumes at k ≥ 1, no stop at the edge)', Math.round(RH.diveMs * 0.6));
    dive('held at farEnd until the gate opens after the camera stopped at the edge (limitD resumes it), then lands on the floor', 'held');
  }
  return out;
}

/** The first-frame files of every realm the pinned manifest lists, verified against it. */
function realmPacks(repo, pinned) {
  const byPath = new Map(pinned.manifest.files.map(f => [f.path, f])), out = [];
  for (const { id } of pinned.manifest.realms) {
    const read = rel => {
      const f = byPath.get(rel), b = fs.readFileSync(path.join(repo, PACK_DIR, rel));
      if (!f || f.bytes !== b.length || f.sha256 !== sha256(b)) throw new Error(`REFUSED: ${rel} is not the pinned pack byte for byte`);
      return b;
    };
    out.push({ id, meta: JSON.parse(read(`realm/${id}/realm.json`).toString('utf8')), deedsPng: read(`realm/${id}/deeds.png`), deedsSha: byPath.get(`realm/${id}/deeds.png`).sha256 });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function catalogOf(W) {
  const byTile = new Map(); // tileId → { realmId, allocation }
  for (const t of W.fantasyTiles()) byTile.set(t.tileId, t);
  return byTile;
}

function gridSuite(M, packs, cat) {
  const realms = packs.map(({ id, meta }) => {
    const g = meta.grid, r = rng(0x9e1d0000 + id.length * 97 + g.cols);
    const own = [...cat.values()].filter(t => t.realmId === id).map(t => t.tileId);
    const stride = Math.max(1, Math.ceil(own.length / 1250));
    const wrapZone = t => { const c = t % LATTICE_W; return floorMod(c - g.x0, LATTICE_W) < 8 || floorMod(g.x0 + g.cols - 1 - c, LATTICE_W) < 8; };
    const pick = own.filter((t, i) => i % stride === 0 || wrapZone(t));
    const catalogTiles = pick.map(t => { const d = deedOf(g, t); return [t, d ? d[0] : -1, d ? d[1] : -1]; });
    const forward = [];
    for (let i = 0; i < 250; i++) {
      const dx = Math.floor(r() * g.cols), dy = Math.floor(r() * g.rows), t = tileOf(g, dx, dy), c = cat.get(t);
      forward.push([dx, dy, t, c?.realmId ?? null, c?.allocation ?? null]);
    }
    for (const [dx, dy] of [[0, 0], [g.cols - 1, 0], [0, g.rows - 1], [g.cols - 1, g.rows - 1], [-1, 0], [0, -1], [g.cols, 0], [0, g.rows]]) {
      const t = tileOf(g, dx, dy), c = t >= 0 ? cat.get(t) : null; forward.push([dx, dy, t, c?.realmId ?? null, c?.allocation ?? null]);
    }
    const lonlat = [];
    for (let i = 0; i < 100; i++) {
      const x = r() * g.cols, y = r() * g.rows, lon = -180 + (g.x0 + x) * M.contracts.DEED_DEG, lat = 90 - (g.y0 + y) * M.contracts.DEED_DEG;
      const t = M.world.fantasyTileAt(lon, lat), tile = t ? t.tileId : -1, d = t ? deedOf(g, t.tileId) : null;
      lonlat.push([lon, lat, tile, t?.realmId ?? null, d ? d[0] : -1, d ? d[1] : -1]);
    }
    const others = [];
    for (let dy = 0; dy < g.rows; dy++) for (let dx = 0; dx < g.cols; dx++) { const t = tileOf(g, dx, dy), c = cat.get(t); if (c && c.realmId !== id) others.push([t, dx, dy, c.realmId]); }
    const otherSample = others.filter((_, i) => i % Math.max(1, Math.ceil(others.length / 200)) === 0);
    return { id, grid: { x0: g.x0, y0: g.y0, cols: g.cols, rows: g.rows, deeds: g.deeds }, catalogCount: own.length, catalogTiles, forward, lonlat, otherRealmTilesInGrid: others.length, otherRealmSample: otherSample };
  });
  return {
    tolerance: 'exact (lon/lat inputs are doubles; tile ids and deed cells exact)',
    formula: 'GLOBE-PRODUCTION-PLAN §2.4.2: tileId = (y0 + dy)·720 + ((x0 + dx) mod 720); inverse dx = (tileId mod 720 − x0) mod 720, dy = ⌊tileId / 720⌋ − y0, −1/−1 outside the grid. Realm membership, allocation and fantasyTileAt come from the pinned packages/shared fantasyWorld.ts.',
    lattice: [LATTICE_W, LATTICE_H],
    catalog: { membershipSha256: M.world.FANTASY_MEMBERSHIP_HASH, catalogHash: M.world.FANTASY_CATALOG_HASH },
    columns: { catalogTiles: ['tileId', 'dx', 'dy'], forward: ['dx', 'dy', 'tileId', 'catalog realmId|null', 'allocation|null'], lonlat: ['lon', 'lat', 'fantasyTileAt tileId|-1', 'realmId|null', 'dx', 'dy'], otherRealmSample: ['tileId', 'dx', 'dy', 'realmId'] },
    realms,
    count: realms.reduce((s, x) => s + x.catalogTiles.length + x.forward.length + x.lonlat.length + x.otherRealmSample.length, 0),
  };
}

async function deedmaskSuite(M, packs, cat) {
  const DP = M.contracts.DEED_PX, realms = [];
  for (const { id, meta, deedsPng, deedsSha } of packs) {
    const g = meta.grid, im = await M.loader.decodePng(new Uint8Array(deedsPng));
    if (!im || im.width !== g.cols || im.height !== g.rows) throw new Error(`${id}: deeds.png is not ${g.cols}×${g.rows}`);
    const counts = { packThis: 0, packOther: 0, packNone: 0, packOtherValue: 0, catalogThis: 0 }, mismatch = [];
    for (let dy = 0; dy < g.rows; dy++) for (let dx = 0; dx < g.cols; dx++) {
      const v = im.data[(dy * g.cols + dx) * 4], t = tileOf(g, dx, dy), c = cat.get(t);
      const want = c?.realmId === id ? DP.thisRealm : c ? DP.otherRealm : DP.none;
      if (v === DP.thisRealm) counts.packThis++; else if (v === DP.otherRealm) counts.packOther++; else if (v === DP.none) counts.packNone++; else counts.packOtherValue++;
      if (want === DP.thisRealm) counts.catalogThis++;
      if (v !== want) mismatch.push([t, dx, dy, v, want, c?.realmId ?? null]);
    }
    realms.push({ id, deedsSha256: deedsSha, cols: g.cols, rows: g.rows, packDeclaredDeeds: g.deeds, counts, mismatchCount: mismatch.length, mismatch });
  }
  return {
    tolerance: 'exact',
    note: 'Each realm pack deeds.png (decoded by the pinned loader.js decodePng, R channel) against the frozen catalog per grid cell: '
      + 'want = 255 when the catalog puts the tile in this realm, 96 in another realm, 0 none. A mismatch is a pack defect (plan §7: the grid is never bent '
      + 'to fit a pack); native reports the same list (stats.maskMismatch) and draws the catalog.',
    columns: { mismatch: ['tileId', 'dx', 'dy', 'pack value', 'catalog value', 'catalog realmId|null'] },
    realms,
    count: realms.reduce((s, x) => s + x.cols * x.rows, 0),
  };
}

/** A deterministic base population on the catalog tiles of a realm (about a quarter of them; one is mine). */
function basesFor(id, g, cat) {
  const r = rng(0xba5e0000 + id.charCodeAt(0) * 31 + id.length), bases = [];
  for (let dy = 0; dy < g.rows; dy++) for (let dx = 0; dx < g.cols; dx++) {
    const t = tileOf(g, dx, dy); if (cat.get(t)?.realmId !== id) continue;
    if (r() < 0.24) bases.push({ id: bases.length, x: dx, y: dy, level: 1 + Math.floor(r() * 20), mine: false });
  }
  if (bases.length) bases[Math.floor(bases.length / 2)].mine = true;
  return bases;
}
const views = (K, g, W, H, dpr) => {
  const cam = K.createCamera({ now: () => 0 }); cam.setViewport(W, H, dpr); cam.setGrid(g.cols, g.rows);
  const sMin = cam.sMin();
  return [['fit', g.cols / 2, g.rows / 2, sMin], ['fit×2 off-centre', g.cols * 0.3, g.rows * 0.6, sMin * 2], ['far d 20', g.cols * 0.7, g.rows * 0.4, 20 / dpr], ['map d 64', g.cols * 0.5, g.rows * 0.5, 64 / dpr],
    // N3 (NM): picking at TRUE (map.js pick's deed-cell fallback; BASES' keep rects and domes are the bases lane's), at
    // myBaseD and at the pixel snap, centred off the deed lines so a view spans a deed edge
    ['true d 1400', Math.floor(g.cols * 0.5) + 0.93, Math.floor(g.rows * 0.5) + 0.21, 1400 / dpr], ['true snap d 3136', Math.floor(g.cols * 0.35) + 0.06, Math.floor(g.rows * 0.6) + 0.9, 3136 / dpr]];
};

function pickSuite(M, packs, cat) {
  const K = M.camera, cases = [];
  for (const { id, meta } of packs) {
    const g = meta.grid, bases = basesFor(id, g, cat), byCell = new Map(bases.map(b => [b.y * g.cols + b.x, b]));
    for (const [vpName, [W, H, dpr]] of Object.entries(VIEWPORTS)) {
      if (vpName === 'phone-390') continue;
      for (const [view, x, y, s] of views(K, g, W, H, dpr)) {
        const cam = K.createCamera({ now: () => 0 }); cam.setViewport(W, H, dpr); cam.setGrid(g.cols, g.rows); cam.set(x, y, s);
        const nx = 25, ny = 40, hits = [];
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const sx = (i + 0.5) * W / nx, sy = (j + 0.5) * H / ny;
          // map.js pick() fallback (map.js:439-445 at the pin), with the frozen catalog as the deed mask (§2.4.3)
          const [u, v] = cam.screenToDeed(sx, sy), dx = Math.floor(u), dy = Math.floor(v);
          if (dx < 0 || dy < 0 || dx >= g.cols || dy >= g.rows) continue;
          const b = byCell.get(dy * g.cols + dx);
          if (b) hits.push([j * nx + i, dx, dy, b.id]);
          else if (cat.get(tileOf(g, dx, dy))?.realmId === id) hits.push([j * nx + i, dx, dy, -1]);
        }
        cases.push({ realm: id, viewport: vpName, view, W, H, dpr, cam: [cam.x, cam.y, cam.s], points: { nx, ny, sx: '(i + 0.5)·W/nx', sy: '(j + 0.5)·H/ny', index: 'j·nx + i' }, hits: hits.flat() });
      }
    }
  }
  return {
    tolerance: 'exact ids',
    note: 'The camera is the pinned createCamera after set(x, y, s); a point hits the base on its deed cell (bases: ' +
      'basesFor(), listed in the cluster suite per realm) or an open catalog deed of this realm (base id −1); every other point is null and not listed.',
    columns: { hits: ['point index', 'dx', 'dy', 'base id | -1 open deed'], hitsLayout: 'flat: 4 numbers per hit' },
    bases: Object.fromEntries(packs.map(({ id, meta }) => [id, basesFor(id, meta.grid, cat).map(b => [b.x, b.y, b.level, b.mine ? 1 : 0])])),
    basesColumns: ['dx', 'dy', 'level', 'mine'],
    cases,
    count: cases.length * 1000,
  };
}

function clusterSuite(M, packs, cat) {
  const K = M.camera, cases = [];
  for (const { id, meta } of packs) {
    const g = meta.grid, bases = basesFor(id, g, cat).map(b => ({ x: b.x, y: b.y, mine: b.mine }));
    for (const [vpName, [W, H, dpr]] of Object.entries(VIEWPORTS)) {
      // representative approved-HUD chrome (top bar, chips, tools, minimap, scale) in CSS px; the function is under test
      const chrome = [[0, 0, W, 56], [8, 60, W - 8, 100], [W - 60, 120, W - 8, 330], [W - 140, H - 240, W - 8, H - 108], [8, H - 48, 160, H - 16]];
      const box = [8, 8, W - 8, H - 8];
      for (const [view, x, y, s] of views(K, g, W, H, dpr).slice(0, 3)) {
        const r = M.ui.clusterCounters({ bases, cam: { x, y }, s, W, H, chrome, box });
        cases.push({ realm: id, viewport: vpName, view, W, H, s, cam: [x, y], chrome, box, onScreen: r.onScreen, list: r.list.map(c => [c.n, c.px, c.py, c.w, c.u, c.v, c.mine ? 1 : 0]) });
      }
    }
  }
  return {
    tolerance: 'n, w, mine exact; px, py, u, v relative 1e-9 (the spiral uses cos/sin)',
    note: 'ui.js clusterCounters({ bases, cam, s, W, H, chrome, box }) with its defaults (sep 44, max 40, clear 12). bases per realm = the pick suite bases (x, y, mine).',
    columns: { list: ['n', 'px', 'py', 'w', 'u', 'v', 'mine'] },
    cases,
    count: cases.length,
  };
}

// ---- gpurecord: crash memory (W1 S5; W1 fix pass 2 #6) -----------------------------------------------------------------
/**
 * core.js gpuRecord replayed call by call: each call is { op, rec (the stored record going in, null = none), args, out }.
 * Records are the web's localStorage JSON: { level, reason, t, clean, crashes, crashBand, pending?, band?, hold? }, keys
 * absent when the web leaves them out. `dirtyLeave` is map.js markPending(false) after a lost context (the visit ends,
 * nothing counts as clean: `delete r.pending; delete r.band`), transcribed because the web has no exported function for it.
 * bandSet is map.js BAND_SET read from the pinned source; steadyBand transcribes map.js steadyBand with the pinned
 * GPU_SAFE.crash.steady.
 */
function gpurecordSuite(M, mapSource) {
  const R = M.core.gpuRecord, crash = M.contracts.GPU_SAFE.crash;
  const copy = v => (v == null ? null : JSON.parse(JSON.stringify(v)));
  const T0 = 1_000_000_000_000, MIN = 60_000, traces = [];
  const dirtyLeave = rec => { if (!rec) return rec; const r = { ...rec }; delete r.pending; delete r.band; return r; };
  const trace = (name, fn) => {
    const calls = []; let t = T0;
    const now = () => (t += MIN);
    const call = (op, rec, ...args) => {
      const out = op === 'dirtyLeave' ? dirtyLeave(copy(rec)) : R[op](copy(rec), ...args);
      calls.push({ op, rec: copy(rec), args, out: copy(out) });
      return op === 'start' ? out.rec : out;
    };
    fn(call, now); traces.push({ name, calls });
  };
  const visit = (call, now, rec, band, steadyBand) => { rec = call('enter', rec, now()); if (band > 0) rec = call('at', rec, band); return call('leave', rec, { steadyBand }); };
  trace('no record: a first visit that leaves cleanly stores nothing', (call, now) => {
    call('start', null, now(), null); visit(call, now, null, 1, 1);
  });
  trace('a MAP freeze: safe at the next start; visits without steady MAP frames never clear it; clean × crashes (2) visits with them do', (call, now) => {
    let r = call('enter', null, now()); r = call('at', r, 1);
    r = call('start', r, now(), null);
    r = visit(call, now, r, 0, 0); r = visit(call, now, r, 1, -1); r = visit(call, now, r, 1, 1); r = visit(call, now, r, 2, 2);
    call('start', r, now(), null);
  });
  trace('a second crash, in TRUE: clean × crashes (4) visits, each with steady TRUE frames', (call, now) => {
    let r = { crashes: 1 }; r = call('enter', r, now()); r = call('at', r, 2);
    r = call('start', r, now(), null);
    r = visit(call, now, r, 2, 1);
    for (let i = 0; i < 2 * crash.clean; i++) r = visit(call, now, r, 2, 2);
    call('start', r, now(), null);
  });
  trace('a freeze while already safe holds the map until TRY AGAIN, which keeps the crash count', (call, now) => {
    let r = call('enter', null, now()); r = call('at', r, 1); r = call('start', r, now(), null);
    r = call('enter', r, now()); r = call('at', r, 1); r = call('start', r, now(), null);
    call('tryAgain', call('enter', r, now()));
    r = call('tryAgain', r); call('start', r, now(), null);
  });
  trace('a lost context in the map stores safe mode at its band; the dirty visit is not a clean one', (call, now) => {
    let r = call('enter', null, now()); r = call('at', r, 1); r = call('loss', r, now(), 'a lost graphics context', 1); r = call('dirtyLeave', r);
    r = call('start', r, now(), null);
    r = visit(call, now, r, 0, 0); r = visit(call, now, r, 1, 1); r = visit(call, now, r, 1, 1);
    r = call('loss', null, now(), 'a lost graphics context', 0); r = visit(call, now, r, 0, 0);
  });
  trace('the ?gpusafe parameter: 0 clears, 1 and 2 force the level and keep the record', (call, now) => {
    const rec = { level: 2, reason: 'x', t: T0, clean: 1, crashes: 3, crashBand: 1 };
    call('start', rec, now(), '0'); call('start', rec, now(), '1'); call('start', null, now(), '2'); call('start', rec, now(), 'yes');
  });
  trace('bands clamp to 0..2 (a non-integer is FAR); at() outside a visit changes nothing', (call, now) => {
    call('at', null, 1); call('at', { level: 2, crashes: 1, crashBand: 1 }, 2);
    const r = call('enter', { crashes: 1 }, now());
    call('at', r, 5); call('at', r, -3); call('at', r, 1.5); call('at', r, null);
  });
  trace('records from older builds: no band counts as MAP, no crashBand as MAP, levels clamp to 2', (call, now) => {
    call('start', { pending: T0 }, now(), null); call('start', { pending: T0, band: 0 }, now(), null); call('start', { pending: T0, level: 1, crashBand: 2, band: 0 }, now(), null);
    call('start', { level: 1 }, now(), null); call('start', { level: 5, reason: 'r', hold: true }, now(), null); call('start', { crashes: 4 }, now(), null);
    call('leave', { level: 2, crashes: 1, clean: 0 }, { steadyBand: 0 }); call('leave', { level: 2, crashes: 1, clean: 0 }, { steadyBand: 1 }); call('leave', { level: 2, crashes: 1, clean: 1 }, null);
  });
  trace('edge records: nothing in, nothing out; a crash count alone survives', (call, now) => {
    call('leave', null, null); call('leave', { crashes: 3, pending: T0, band: 1 }, { steadyBand: 2 }); call('leave', { level: 0 }, { steadyBand: 2 });
    call('tryAgain', null); call('tryAgain', { level: 2, crashes: 0 }); call('tryAgain', { level: 2, crashes: 2, pending: T0 });
    call('loss', { crashes: 1, crashBand: 2, pending: T0, band: 0 }, now(), 'reset', 0);
  });
  const m = mapSource.match(/^\s*const BAND_SET = (\{[^}]*\});/m);
  if (!m) throw new Error('map.js at the pin has no BAND_SET table');
  const bandSet = Function(`return (${m[1]});`)();
  // map.js: const steadyBand = () => { for (let b = 2; b >= 0; b--) if (Q.visit.steady[b] >= GPU_SAFE.crash.steady) return b; return -1; };
  const steadyBand = st => { for (let b = 2; b >= 0; b--) if (st[b] >= crash.steady) return b; return -1; };
  const S = crash.steady;
  const steady = [[0, 0, 0], [S, 0, 0], [S - 1, S - 1, S - 1], [0, S, 0], [4 * S, S, S - 1], [0, 0, S], [S, S, S], [S + 1, 0, 1]].map(st => ({ steady: st, band: steadyBand(st) }));
  const calls = traces.reduce((n, t) => n + t.calls.length, 0);
  return {
    tolerance: 0,
    note: 'core.js gpuRecord, call by call (rec in, args, out); start returns { level, reason, hold, rec }, every other op the next record '
      + '(null = remove it). A trace chains each out into the next call where it continues a visit. dirtyLeave = map.js markPending(false) '
      + 'after a lost context (delete pending and band, no clean count). The web never keeps a record on a software rasteriser. '
      + 'steadyBand: map.js steadyBand (the deepest band with ≥ crash.steady steady GPU samples this visit, else −1); bandSet: map.js BAND_SET '
      + '(the view band → the crash band index).',
    crash, bandSet, steadyBand: steady, traces, count: calls + steady.length,
  };
}

// ---- bandlimit: the band gate (W1 S2 + stage B D-173 dive rule, core.js bandLimit 911b39c5) -----------------------------
/**
 * core.js bandLimit({ on, bypass, valve, items, dive, lanesIn }) over every flag combination and a fixed list of rehearsal
 * item sets (it.set: 1 = MAP set, 2 = TRUE set; gating: that item still holds its band). Pure: the camera's zoom limit
 * (lim), the band it holds and why. map.js calls it once per frame (bandGate) and feeds lim to camera.limitD.
 */
function bandlimitSuite(M) {
  const L = M.core.bandLimit;
  if (typeof L !== 'function') throw new Error('core.js at the pin exports no bandLimit');
  const itemSets = [[], [{ set: 1, gating: true }], [{ set: 1, gating: false }], [{ set: 2, gating: true }], [{ set: 1, gating: false }, { set: 2, gating: true }],
    [{ set: 2, gating: true }, { set: 1, gating: true }], [{ set: 3, gating: true }], [{ set: 0, gating: true }], [{ set: 2, gating: false }, { set: 3, gating: true }]];
  const rows = [], bools = [false, true];
  for (const on of bools) for (const bypass of bools) for (const valve of bools) for (const dive of bools) for (const lanesIn of bools)
    itemSets.forEach((items, i) => { const r = L({ on, bypass, valve, items, dive, lanesIn }); rows.push([on ? 1 : 0, bypass ? 1 : 0, valve ? 1 : 0, dive ? 1 : 0, lanesIn ? 1 : 0, i, r.lim, r.band, r.reason]); });
  const d = L(), dEmpty = L({});
  return {
    tolerance: 'exact',
    note: 'core.js bandLimit, every combination of the five flags × itemSets (index i). lim is a device-px d (the string "Infinity" = no limit). '
      + 'defaults = bandLimit() and bandLimit({}) (on true, bypass/valve/dive false, lanesIn true, no items).',
    itemSets: itemSets.map(set => set.map(it => [it.set, it.gating ? 1 : 0])),
    itemSetsColumns: ['set', 'gating'],
    columns: ['on', 'bypass', 'valve', 'dive', 'lanesIn', 'itemSet', 'lim', 'band', 'reason'],
    rows,
    defaults: [[d.lim, d.band, d.reason], [dEmpty.lim, dEmpty.band, dEmpty.reason]],
    count: rows.length + 2,
  };
}

// ---- WorldEngineConstants.kt --------------------------------------------------------------------------------------------
// Presentation numbers only (bands, idle policy, GPU safety, texture units, plot offset hashing, cost budgets, enums).
// Game numbers (tiles per deed, art px, keep/wall tables) are NOT emitted: native reads them from the constants catalogue.
const snake = k => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const ktNum = v => (Number.isInteger(v) && Math.abs(v) <= 2147483647 ? String(v) : Number.isInteger(v) ? `${v}.0` : JSON.stringify(v));
const ktDbl = v => (Number.isInteger(v) ? `${v}.0` : JSON.stringify(v));
function ktLeaf(name, v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${name}: non-finite constant`);
    return Number.isInteger(v) && Math.abs(v) <= 2147483647 ? `const val ${name}: Int = ${v}` : `const val ${name}: Double = ${ktDbl(v)}`;
  }
  if (typeof v === 'boolean') return `const val ${name}: Boolean = ${v}`;
  if (typeof v === 'string') return `const val ${name}: String = ${JSON.stringify(v).replace(/\$/g, '\\$')}`;
  if (Array.isArray(v)) {
    const flatNums = a => a.flat(Infinity);
    if (v.every(x => typeof x === 'string')) return `val ${name}: List<String> = listOf(${v.map(x => JSON.stringify(x)).join(', ')})`;
    if (v.every(x => typeof x === 'boolean')) return `val ${name}: BooleanArray = booleanArrayOf(${v.join(', ')})`;
    if (v.every(x => typeof x === 'number')) return v.every(Number.isInteger) ? `val ${name}: IntArray = intArrayOf(${v.join(', ')})` : `val ${name}: DoubleArray = doubleArrayOf(${v.map(ktDbl).join(', ')})`;
    if (v.every(x => Array.isArray(x) && x.every(y => typeof y === 'number'))) {
      const ints = flatNums(v).every(Number.isInteger);
      return ints ? `val ${name}: Array<IntArray> = arrayOf(${v.map(x => `intArrayOf(${x.join(', ')})`).join(', ')})`
        : `val ${name}: Array<DoubleArray> = arrayOf(${v.map(x => `doubleArrayOf(${x.map(ktDbl).join(', ')})`).join(', ')})`;
    }
  }
  throw new Error(`${name}: no Kotlin form for ${JSON.stringify(v)}`);
}
/** Leaves of a (nested) object as [UPPER_SNAKE path, value]; nested keys join with '_'. */
export function leaves(v, prefix = '') {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).sort().flatMap(k => leaves(v[k], prefix ? `${prefix}_${snake(k)}` : snake(k)));
  return [[prefix, v]];
}
/** name → [contracts.js / groundcost.js export, its value]; the order is the file's. */
export function constantGroups(M) {
  const C = M.contracts, G = M.groundcost;
  return [
    ['Bands', 'contracts.js BANDS', C.BANDS], ['Idle', 'contracts.js IDLE', C.IDLE],
    ['GpuSafe', 'contracts.js GPU_SAFE (GOV_*: the web\'s level-0 MAP-rest governor, deliberately unused natively: FrameLadder steps L0 → L1 on frame time)', C.GPU_SAFE],
    ['Units', 'contracts.js UNITS', C.UNITS], ['PlotOffset', 'contracts.js PLOT_OFFSET, PLOT_CENTRE', { ...C.PLOT_OFFSET, centre: C.PLOT_CENTRE }],
    ['DeedPx', 'contracts.js DEED_PX', C.DEED_PX], ['Kind', 'contracts.js KIND', C.KIND], ['Flag', 'contracts.js FLAG', C.FLAG], ['Classes', 'contracts.js CLASS', C.CLASS],
    ['GroundCost', 'groundcost.js PASS, ITERS and budgets', { pass: G.PASS, iters: G.ITERS, passBudget: G.PASS_BUDGET, iterBudget: G.ITER_BUDGET, frameBudget: G.FRAME_BUDGET,
      frameIterBudget: G.FRAME_ITER_BUDGET, displayBudget: G.DISPLAY_BUDGET, resolveBudget: G.RESOLVE_BUDGET, resolve: G.RESOLVE, recPages: G.REC_PAGES }],
    ['View', 'contracts.js UBO_VIEW', { uboBinding: C.UBO_VIEW }],
  ];
}
export function kotlinConstants(M, pin, generator) {
  const body = constantGroups(M).map(([name, from, value]) => `    /** ${from} */\n    object ${name} {\n${leaves(value).map(([k, v]) => `        ${ktLeaf(k, v)}`).join('\n')}\n    }`).join('\n\n');
  return Buffer.from(`// GENERATED by tools/world-golden.mjs from the pinned web contracts. Do not edit: re-run the generator.
// Pin: globe-realms ${pin}. Generator sha256 ${generator}.
// Presentation constants only: every game number (tiles per deed, art px, keep and wall tables) comes from the
// constants catalogue, never from here. Nested web keys are joined with '_' (GPU_SAFE.rehearse.idleMs → GpuSafe.REHEARSE_IDLE_MS).
package gg.pixelkingdomwars.nativeclient.renderer.generated

@Suppress("unused")
object WorldEngineConstants {
    const val PIN: String = ${JSON.stringify(pin)}

${body}
}
`);
}

// ---- driver -------------------------------------------------------------------------------------------------------------
export async function generate({ repo, root = ROOT }) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')), pin = lock.source.commit;
  const pinned = pinnedManifest(repo, lock), packs = realmPacks(repo, pinned);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-golden-'));
  try {
    extractPinned(repo, pin, [ENGINE, ...SHARED], tmp);
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(tmp, 'packages/shared/node_modules'), 'dir');
    const load = await moduleLoader(repo), dir = path.join(tmp, ENGINE);
    const files = { contracts: 'contracts.js', groundcost: 'groundcost.js', camera: 'camera.js', ui: 'ui.js', loader: 'loader.js', core: 'core.js' };
    // one entry module: one transpile of the shared graph (tsImport isolates every call, so separate loads repeat it)
    const entry = path.join(tmp, 'golden-entry.mjs');
    fs.writeFileSync(entry, Object.entries(files).map(([k, f]) => `export * as ${k} from ${JSON.stringify('./' + path.posix.join(ENGINE, f))};`).join('\n')
      + `\nexport * as world from './packages/shared/src/fantasyWorld.ts';\n`);
    const M = { ...(await load(entry)) };
    const sources = Object.fromEntries([...[...Object.values(files), 'map.js'].map(f => [`${ENGINE}/${f}`, path.join(dir, f)]),
      ['packages/shared/src/fantasyWorld.ts', path.join(tmp, 'packages/shared/src/fantasyWorld.ts')],
      ['packages/shared/src/data/fantasy-world-v1.json', path.join(tmp, 'packages/shared/src/data/fantasy-world-v1.json')],
      ['packages/shared/src/constants.ts', path.join(tmp, 'packages/shared/src/constants.ts')]].map(([k, p]) => [k, sha256(fs.readFileSync(p))]));
    const cat = catalogOf(M.world);
    const bodies = {
      contracts: contractsSuite(M), camera: cameraSuite(M), grid: gridSuite(M, packs, cat),
      deedmask: await deedmaskSuite(M, packs, cat), pick: pickSuite(M, packs, cat), cluster: clusterSuite(M, packs, cat),
      gpurecord: gpurecordSuite(M, fs.readFileSync(path.join(dir, 'map.js'), 'utf8')), bandlimit: bandlimitSuite(M),
    };
    const generator = sha256(fs.readFileSync(SELF)), out = new Map();
    for (const suite of SUITES) {
      const body = bodies[suite];
      const packInfo = ['grid', 'deedmask', 'pick', 'cluster'].includes(suite) ? { manifestSha256: pinned.sha256, packVersion: pinned.manifest.packVersion } : undefined;
      out.set(`${suite}.json`, Buffer.from(serialize({ schema: 1, suite, pin, generator, sources, pack: packInfo, ...body }) + '\n'));
    }
    out.kotlin = kotlinConstants(M, pin, generator);
    return out;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function compare(root, files) {
  const dir = path.join(root, OUT_DIR), drift = [];
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  for (const [rel, bytes] of files) { const p = path.join(dir, rel); if (!fs.existsSync(p)) drift.push(`missing ${rel}`); else if (!fs.readFileSync(p).equals(bytes)) drift.push(`changed ${rel}`); }
  for (const f of present) if (!files.has(f)) drift.push(`extra ${f}`);
  if (files.kotlin) { const kt = path.join(root, KOTLIN_CONSTANTS); if (!fs.existsSync(kt) || !fs.readFileSync(kt).equals(files.kotlin)) drift.push(`changed ${KOTLIN_CONSTANTS}`); }
  return drift;
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = path.resolve(opt('--root') ?? ROOT), repo = opt('--source') ?? process.env.PKW_GLOBE_SOURCE;
  if (!repo) throw new Error('Pass --source <SHARDKEEP-globe repo> (or PKW_GLOBE_SOURCE)');
  const files = await generate({ repo: path.resolve(repo), root });
  if (argv.includes('--check')) {
    const drift = compare(root, files);
    if (drift.length) { console.error(`world golden drift:\n  ${drift.join('\n  ')}`); return 1; }
    console.log(`world golden: no drift (${files.size} suites)`);
    return 0;
  }
  const dir = path.join(root, OUT_DIR);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  let bytes = 0; for (const [rel, b] of files) { fs.writeFileSync(path.join(dir, rel), b); bytes += b.length; }
  fs.mkdirSync(path.dirname(path.join(root, KOTLIN_CONSTANTS)), { recursive: true }); fs.writeFileSync(path.join(root, KOTLIN_CONSTANTS), files.kotlin);
  console.log(`world golden: wrote ${files.size} suites (${bytes} bytes) into ${OUT_DIR}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
