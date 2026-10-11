// ground.test — GROUND's frame logic on a recording fake core (no GL): W1 follow-up of RM-GPU-1.
// Why these matter: (G1) a band change must not build pipelines — SHELL's rehearsal pre-draws every GROUND program through
// ground.rehearse(), which must draw each one with REAL fragments in every GL state its real passes use (the P0 zero-fragment
// rehearsal left MAP d 150 at 14.6–18.7 s on SwiftShader); (G4) `missing` must not read 0 while the screen still shows a
// strip of unresolved lattice (the critic's Crownlands d 150 edge), mapReady(view) must say whether MAP can draw the view
// whole (SHELL holds the FAR→MAP crossover on it), and the view's lattice must resolve while the camera rests at FAR.
// Run: scripts/node_modules/.bin/tsx --test concepts/globe3d-2026-09-23/src/realm/*.test.mjs
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from './ground.mjs';
import { CLASS, BANDS, GPU_SAFE } from './contracts.mjs';

const COLS = 40, ROWS = 30;
const BAKE = ['rm-raw', 'rm-despeckle', 'rm-legalise', 'rm-pure']; // the lattice resolve's programs (fix pass 2 #3)
/** A fake core that records what GROUND asks of GL: the bound target's format, blend state, uniforms, draws and uploads. */
function fakeCore() {
  const rec = { draws: [], uploads: 0, programs: [], invalidations: 0 }, st = { blend: false, bf: null, target: 'canvas', uni: {} };
  let cur = null, since = 0, nextId = 1;
  const C = { BLEND: 0xbe2, DEPTH_TEST: 0xb71, CULL_FACE: 0xb44, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, FRAMEBUFFER: 0x8d40, TEXTURE_2D_ARRAY: 0x8c1a, MAX_TEXTURE_SIZE: 0xd33 };
  const gl = new Proxy({ drawingBufferWidth: 1280, drawingBufferHeight: 800, canvas: { width: 1280, height: 800 } }, { get(t, k) {
    if (k in t) return t[k];
    if (k in C) return C[k];
    if (k === 'enable' || k === 'disable') return cap => { if (cap === C.BLEND) st.blend = k === 'enable'; };
    if (k === 'blendFunc') return (a, b) => { st.bf = [a, b]; };
    if (k === 'getParameter') return p => (p === C.MAX_TEXTURE_SIZE ? 4096 : 0);
    if (k === 'bindFramebuffer') return (_, f) => { if (!f) st.target = 'canvas'; };
    if (typeof k === 'string' && k.startsWith('uniform')) return (loc, ...v) => { if (cur && loc) (st.uni[cur.name] ??= {})[loc] = v.length === 1 ? v[0] : v; };
    return () => {};
  } });
  const texture = (fmt, target = 'TEXTURE_2D', w = 1, h = 1) => ({ t: nextId++, target: target === 'ARRAY' ? C.TEXTURE_2D_ARRAY : 1, format: fmt, w, h, bytes: 0 });
  const upload = () => { if (rec.counting) rec.uploads++; };
  const core = {
    gl,
    include() {},
    program(name) {
      const p = { name, ready: true, use() { cur = p; return p; }, u(n) { return n; }, tex(n, unit, t) { (st.uni[name] ??= {})[n] = t; return p; } };
      rec.programs.push(p); return p;
    },
    tex: {
      image(src, o = {}) { upload(); return texture('RGBA8', '2D', src.width, src.height); },
      data(w, h, fmt, _a, _b, arr) { upload(); return texture(fmt, '2D', w, h); },
      array(w, h, layers, fmt = 'RGBA8') { upload(); return texture(fmt, 'ARRAY', w, h); },
      layer() { upload(); }, update() { upload(); }, queue(fn) { fn(); }, free() {}, shared(k, make) { return make(); },
    },
    lru(n) { const m = new Map(); return { has: k => m.has(k), get: k => { const v = m.get(k); m.delete(k); m.set(k, v); return v; }, put(k, v, ev) { m.set(k, v); if (m.size > n) { const [o] = m.keys(); const ov = m.get(o); m.delete(o); ev?.(ov, o); } }, delete: k => m.delete(k), keys: () => m.keys(), get size() { return m.size; } }; },
    fbo(t) { st.target = t.target === C.TEXTURE_2D_ARRAY ? `${t.format}[]` : t.format; return {}; },
    fullscreen() { rec.draws.push({ prog: cur?.name, target: st.target, blend: st.blend ? st.bf.join(',') : 'off', at: st.uni[cur?.name]?.uRhAt ?? null }); if (cur) cur.drawn = true; }, // (core: a program's first draw builds its pipeline)
    invalidate() { rec.invalidations++; }, animating() {}, sinceInput: () => since, stats: () => ({}),
  };
  return { core, rec, st, setSince: v => { since = v; } };
}
/** A synthetic 40×30-deed realm: dry land, one forest map slot, no TRUE data (the lattice and MAP paths only). */
function fakePack() {
  const px = (w, h, v) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
  const toT = Object.fromEntries(Object.keys(CLASS).map(c => [c, c === 'FOREST' ? 'M1' : 'WILD']));
  const meta = { id: 'test', grid: { cols: COLS, rows: ROWS }, classes: {}, map: { wild: 'W', families: { M1: { lower: 'W', upper: 'forest' } }, classToTerrain: toT } };
  return { meta, first: { chart8: { width: COLS * 8, height: ROWS * 8 }, deeds: new Uint8Array(COLS * ROWS).fill(255) },
    bitmap: async () => ({ width: COLS * 4 * 2, height: ROWS * 4 }), json: async () => ({}),
    pixels: async k => (k.startsWith('fieldsBC') ? px(COLS * 4 * 2, ROWS * 4, 0) : px(COLS * 8, ROWS * 8, 150)) };
}
async function loaded() { const f = fakeCore(), g = createGround(f.core); await g.load(fakePack()); return { ...f, g }; }
const view = (d, { x = 20, y = 15, moving = false, w } = {}) => {
  const W = 1280 / d, H = 800 / d;
  return { x, y, d, s: d, dpr: 1, W: 1280, H: 800, moving, band: d < BANDS.farEnd ? 'far' : 'map', w: w ?? (d < BANDS.farEnd ? { far: 1, map: 0, true: 0 } : { far: 0, map: 1, true: 0 }),
    rect: { fx0: x - W / 2, fx1: x + W / 2, fy0: y - H / 2, fy1: y + H / 2 } };
};

test('G1 rehearse: every GROUND program draws real fragments in every state its real passes use, into targets of the real format, with no upload', async () => {
  const { g, rec, st } = await loaded();
  assert.equal(g.ready.map, true, 'the synthetic realm loads its MAP data');
  // display programs: the probe draws (stand-in textures, every sampling path), then — once that band's data is loaded — the
  // same states with the real textures at the view centre (probe off). This realm has MAP data, no TRUE data.
  const B = `canvas:${0x302},${0x303}`;
  const want = { 'rm-raw': ['R8UI:off'], 'rm-despeckle': ['R8UI:off'], 'rm-legalise': ['R8UI:off'], 'rm-pure': ['R8UI[]:off'], 'rm-record': ['RGBA16UI[]:off'],
    'rm-chart': ['canvas:off', 'canvas:off'], 'rm-map': ['canvas:off', B, 'canvas:off', B], 'rm-true': ['canvas:off', B] };
  const probes = { 'rm-chart': [1, 0], 'rm-map': [1, 1, 0, 0], 'rm-true': [1, 1] };
  assert.deepEqual(rec.programs.map(p => p.name).sort(), Object.keys(want).sort(), 'the hook knows every program GROUND creates');
  for (const p of rec.programs) {
    rec.draws.length = 0; rec.counting = true; st.target = 'canvas';
    assert.equal(g.rehearse(p, view(10), { target: 'canvas', k: 1, box: 8 }), true, `${p.name}: rehearsed`);
    rec.counting = false;
    assert.equal(rec.uploads, 0, `${p.name}: the hook uploaded (it must be idempotent: no uploads)`);
    assert.deepEqual(rec.draws.map(d => `${d.target}:${d.blend}`), want[p.name], `${p.name}: states drawn`);
    // display programs shade a chosen deed point (uRhAt z = 1) and leave the probe off for the real draws
    if (probes[p.name]) {
      assert.deepEqual(rec.draws.map(d => d.at?.[2]), probes[p.name], `${p.name}: probe draws first (z 1), then the real ones at the view centre (z 0)`);
      assert.deepEqual(st.uni[p.name].uRhAt, [0, 0, 0, 0], `${p.name}: uRhAt reset after the rehearsal`);
      if (p.name !== 'rm-chart') assert.deepEqual(rec.draws.slice(0, 2).map(d => d.at[3]), [0, 1], `${p.name}: magnified and minified sampling paths`);
    }
  }
  // idempotent: a second call draws the same again (SHELL may call a hook several times per program)
  const map = rec.programs.find(p => p.name === 'rm-map'); rec.draws.length = 0; g.rehearse(map, view(10));
  assert.equal(rec.draws.length, 4);
  assert.equal(g.rehearse({ name: 'life-x', ready: true, use() { return this; } }, view(10)), false, 'a program it does not own');
});

test('G4 honest missing, mapReady and the FAR pre-resolve', async () => {
  const f = await loaded(), { g } = f;
  // MAP d 150: the view needs its lattice; a frame that resolves sub-tiles still reports them missing
  const v = view(150); let s, frames = 0, resolvedFrames = 0;
  assert.equal(g.mapReady(v), false, 'nothing resolved yet');
  for (;;) { g.update(v); s = g.stats(); frames++; if (s.lastSubs > 0) { resolvedFrames++; assert.ok(s.missing > 0, `frame ${frames}: resolved ${s.lastSubs} sub-tiles yet missing reads 0`); }
    if (s.missing === 0) break; assert.ok(frames < 20); }
  assert.equal(s.lastSubs, 0, 'missing reaches 0 only on a frame that resolved nothing (the previous frame was already whole)');
  assert.ok(resolvedFrames >= 1 && g.mapReady(v), 'the view is ready once its sub-tiles are resolved');
  // draw() makes the decision passes() reports (SHELL picks the ground scale from it): at rest one pass, MAP
  f.rec.draws.length = 0; g.draw(v);
  assert.deepEqual(g.passes(v), { chart: false, map: true, true: false });
  assert.deepEqual(f.rec.draws.map(d => d.prog), ['rm-map'], 'draw() draws what passes() said');
  const fade = view(36, { w: { far: 0.5, map: 0.5, true: 0 } }); f.rec.draws.length = 0; g.update(fade); g.draw(fade);
  assert.deepEqual(f.rec.draws.filter(d => d.prog !== 'rm-raw' && d.prog !== 'rm-despeckle' && d.prog !== 'rm-legalise' && d.prog !== 'rm-pure').map(d => d.prog), ['rm-chart', 'rm-map']);
  assert.equal(g.passes(fade).chart && g.passes(fade).map, true);
  // mapReady covers the view only: a far corner of the realm is not resolved
  assert.equal(g.mapReady(view(150, { x: 38, y: 28 })), false);
  // FAR: while input is recent, nothing resolves (a wake-up is scheduled); once the camera rests, one sub-tile per frame
  // (after SHELL's rehearsal built the bake programs: W1 fix pass 2 #3, next test)
  const f2 = await loaded(), fv = view(10);
  for (const n of BAKE) f2.g.rehearse(f2.rec.programs.find(p => p.name === n), fv);
  f2.setSince(0); f2.g.update(fv); let s2 = f2.g.stats();
  assert.equal(s2.lastSubs, 0, 'no pre-resolve during input'); assert.ok(s2.preMap > 0, 'but the view has lattice left to pre-resolve');
  assert.equal(s2.missing, 0, 'at FAR the lattice is not drawn: not missing');
  f2.setSince(GPU_SAFE.rehearse.idleMs + 1);
  f2.g.update(view(10, { moving: true })); assert.equal(f2.g.stats().lastSubs, 0, 'a moving camera never pre-resolves');
  const left = s2.preMap; let n = 0;
  for (let i = 0; ; i++) { f2.g.update(fv); s2 = f2.g.stats(); if (s2.lastSubs) n++; assert.ok(s2.lastSubs <= 1, 'at most one sub-tile per resting frame'); if (!s2.preMap) break; assert.ok(i < 40, `frame ${i}: ${s2.preMap} sub-tiles still to pre-resolve`); }
  assert.equal(n, left, 'every sub-tile of the FAR view pre-resolves, one per frame');
  assert.equal(f2.g.mapReady(view(30)), true, 'the FAR→MAP crossover finds its lattice ready');
  f2.g.dispose();
});

// W1 fix pass 2 #3 (gate evidence: rm-raw, rm-despeckle, rm-legalise and rm-pure were first drawn by REAL lattice resolves
// at FAR — from d 18 = 0.75·farEnd, the entry zoom, with no idle check and up to four new pipelines in one frame, rm-raw's
// built by a 266²-vertex classifier resolve while the player pans). At FAR (MAP not on screen) a resolve must never be a
// bake program's first draw: lattice work waits until SHELL's rehearsal has drawn all four (one per idle frame, rm-raw
// first) and asks for no frames while it waits (an idle map stays idle). Once MAP is on screen it resolves regardless
// (?rehearse=0 or the gate's valve): a late pipeline beats a map that never resolves.
test('fix pass 2 #3: at FAR no lattice resolve is the first draw of a bake program; the rehearsal builds them first', async () => {
  const f = await loaded(), { g, rec } = f, P = n => rec.programs.find(p => p.name === n);
  f.setSince(GPU_SAFE.rehearse.idleMs + 1); // resting: the FAR pre-resolve would run
  for (const d of [BANDS.farEnd * 0.75 + 2, BANDS.farEnd, 10]) { // the entry zoom band (lattice wanted), the FAR edge, the pre-resolve
    const inv = rec.invalidations; rec.draws.length = 0; g.update(view(d, { w: { far: 1, map: 0, true: 0 } }));
    assert.deepEqual(rec.draws.map(x => x.prog), [], `d ${d}: no resolve draw while the bake programs are cold`);
    assert.equal(g.stats().bakeHeld, true, `d ${d}: held`);
    assert.equal(rec.invalidations, inv, `d ${d}: a held resolve asks for no frame`);
    assert.ok(g.stats().preMap > 0 || g.stats().missing > 0, `d ${d}: the work is still counted`);
  }
  for (const [i, n] of BAKE.entries()) { // SHELL's order: one program per idle frame
    assert.equal(P(n).drawn, undefined, `${n}: not drawn before its rehearsal`);
    g.rehearse(P(n), view(10)); assert.equal(P(n).drawn, true, `${n}: its rehearsal drew it`);
    rec.draws.length = 0; g.update(view(10));
    const resolved = rec.draws.filter(x => BAKE.includes(x.prog)).map(x => x.prog);
    if (i < BAKE.length - 1) assert.deepEqual(resolved, [], `after ${n} only: still held`);
    else { assert.deepEqual([...new Set(resolved)], BAKE, 'all four built: the FAR pre-resolve runs'); assert.equal(g.stats().bakeHeld, false); }
  }
  // MAP on screen without a rehearsal (?rehearse=0, the valve): the lattice resolves anyway
  const f2 = await loaded(); f2.rec.draws.length = 0; f2.g.update(view(30, { w: { far: 0.9, map: 0.1, true: 0 } }));
  assert.ok(f2.rec.draws.some(x => x.prog === 'rm-raw'), 'MAP on screen: resolves with cold programs (liveness)');
  g.dispose(); f2.g.dispose();
});

// G3 (D-167: no main-thread stall > 50 ms): a realm's load uploads ~190 MAP atlas layers (× 1 + 5 mask mips) and 208–384
// TRUE layers, packs the masks and measures the decal boxes; P0 ran each of these as ONE task (ImageBitmap sub-rect uploads
// that extract the whole atlas per call). Here every layer upload costs 0.3 ms (a slow phone) and GROUND's yields (a
// message-channel task) are counted: no stretch between two yields may hold more than SLICE_MS (8 ms) + one step of
// uploads. Counted, not timed: an overloaded test machine that preempts the process only shortens a stretch. Teeth: P0's
// shape (this realm's 64 × 7 MAP atlas uploads in one loop) is one stretch of 448.
test('G3 the load never blocks the main thread: atlas uploads and mask / decal passes run in short slices', async () => {
  const busy = ms => { const t = performance.now(); while (performance.now() - t < ms); };
  const f = fakeCore(), up = f.core.tex.layer; let run = 0, worst = 0, yields = 0;
  f.core.tex.layer = (...a) => { busy(0.3); run++; worst = Math.max(worst, run); return up(...a); };
  const MC = globalThis.MessageChannel;
  globalThis.MessageChannel = class extends MC { constructor() { super(); const post = this.port2.postMessage.bind(this.port2); this.port2.postMessage = m => { yields++; run = 0; post(m); }; } };
  const pack = fakePack(), px = (w, h, v = 0) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
  const mips = [16, 8, 4, 2, 1].map((cell, k) => ({ cell, y: [864, 1296, 1512, 1620, 1674][k] }));
  Object.assign(pack.meta.map, { atlas: { file: 'mapkit.png', cell: 32, cols: 16, layers: 64, mips, families: { M1: 4 }, wild: [0, 4] }, mask: { file: 'mapmask.png' } });
  pack.meta.true = { atlas: { file: 'ground.png', cell: 32, cols: 16, layers: 128 }, mask: { file: 'groundmask.png' }, decals: { file: 'decals.png', cols: 16, count: 16 },
    terrains: [{ id: 'sand', pure: [0, 4], layer: 1 }], classToTerrain: { WILD: 'sand' }, families: [] };
  const base = pack.pixels;
  pack.pixels = async k => (k === 'mapkit.png' || k === 'mapmask.png' ? px(512, 1680, 90) : k === 'ground.png' || k === 'groundmask.png' ? px(512, 608, 200) : k === 'decals.png' ? px(512, 32, 255) : base(k));
  let g;
  try { g = createGround(f.core); await g.load(pack); } finally { globalThis.MessageChannel = MC; }
  assert.equal(g.ready.map && g.ready.true, true, 'the synthetic realm loads MAP and TRUE');
  const uploads = 64 * 7 + 128 + 33 + 16;
  assert.ok(yields >= uploads * 0.3 / 8 * 0.8, `the load yielded ${yields} times for ${(uploads * 0.3).toFixed(0)} ms of uploads`);
  assert.ok(worst <= Math.ceil(8 / 0.3) + 7 + 4, `a stretch held ${worst} uploads (${(worst * 0.3).toFixed(0)} ms)`);
  // and the TRUE band runs on what it loaded: pages resolve, rm-true draws over MAP in the fade, alone at rest
  const tv = view(900, { w: { far: 0, map: 1, true: 0.4 } });
  for (let i = 0; i < 30 && (i === 0 || g.stats().missing); i++) g.update(tv);
  f.rec.draws.length = 0; g.draw(tv);
  assert.deepEqual(f.rec.draws.map(d => d.prog).filter(n => n === 'rm-map' || n === 'rm-true'), ['rm-map', 'rm-true']);
  assert.equal(f.rec.draws.at(-1).blend, `${0x302},${0x303}`, 'TRUE blends over MAP in the fade');
  g.dispose();
});

// W1 G3 request to PACK: a pack that bakes the foreign-sea cap and the tarn clip into fieldsA.png says so (realm.json
// fieldsA.baked), and GROUND then skips those two main-thread passes at entry — and only then (an unbaked pack still needs them).
test('G3 baked load passes: realm.json fieldsA.baked skips foreignSea / clipTarns, nothing else does', async () => {
  const f = fakeCore(), g = createGround(f.core), pack = fakePack(); await g.load(pack);
  assert.ok(Number.isFinite(g.stats().foreignSea?.ms) && !g.stats().foreignSea.baked, 'an unbaked pack runs foreignSea');
  const f2 = fakeCore(), g2 = createGround(f2.core), p2 = fakePack(); p2.meta.fieldsA = { baked: ['foreignSea', 'clipTarns'] }; await g2.load(p2);
  assert.deepEqual([g2.stats().foreignSea, g2.stats().tarns], [{ baked: true }, { baked: true }]);
  assert.equal(g2.ready.map, true); g.dispose(); g2.dispose();
});

// W1 G5 (owner-bar critic + the owner, NIGHT 01:30): (1) d 49–110 read airbrushed — the painting's smooth low-pass relief
// (the tone grade) under crisp pixel patches — so the grade eases out across the FAR→MAP blend and is gone by d 80 (P0 kept
// 0.71 at d 80, 0.38 at d 110); (2) Sunscar's dense dark MAP forest jumped to sparse palms on bright sand at TRUE (a 44
// mean/channel jump d 790 → 1120), so the slots TRUE draws on the wild ground ease toward it over d 450 → 800, by the
// measured share (0.63 for Sunscar), and nowhere else (realms without a measured share keep their map art).
test('G5 hand-overs: the painting grade is gone by d 80; Sunscar forest eases toward sand over d 450 → 800 only', async () => {
  const run = async id => {
    const f = fakeCore(), g = createGround(f.core), pack = fakePack(); pack.meta.id = id; pack.meta.true = { classToTerrain: { WILD: 'sand', FOREST: 'sand' } };
    await g.load(pack);
    const at = d => { const v = view(d); g.update(v); g.draw(v); const u = f.st.uni['rm-map']; return { grade: u.uMpGrade[0], thin: u.uMpThin[0], mask: u.uMpThinMask }; };
    return { at, g };
  };
  const s = await run('sunscar');
  assert.ok(s.at(30).grade > 0.8, 'the grade still matches the chart early in the FAR→MAP blend');
  const g49 = s.at(49).grade; assert.ok(g49 > 0.3 && g49 < 0.45, `d 49 grade ${g49}`);
  assert.equal(s.at(80).grade, 0, 'no painting relief from d 80 (P0: 0.71)'); assert.equal(s.at(110).grade, 0);
  assert.equal(s.at(450).thin, 0); const t620 = s.at(620).thin; assert.ok(t620 > 0.2 && t620 < 0.63, `d 620 ${t620}`);
  assert.ok(Math.abs(s.at(800).thin - 0.63) < 1e-6 && Math.abs(s.at(1000).thin - 0.63) < 1e-6, 'the measured share from d 800');
  assert.equal((s.at(800).mask >> 1) & 1, 1, 'the forest slot is one TRUE draws on the wild ground');
  const o = await run('crownlands');
  assert.equal(o.at(800).thin, 0, 'a realm without a measured share keeps its map art');
  s.g.dispose(); o.g.dispose();
});

// ---- Stage B (2026-09-25) ------------------------------------------------------------------------------------------------
// Solana Reach's water is its "one thing to remember" (owner): a 16-frame gem loop whose kit drift [2,-2] gives each of the
// four open-water phases its own gem rows. The TRUE shader stepped phases by a literal 2 (8-frame loops), so on a 16-frame
// loop the phases sat only an eighth of a loop apart and their gem rows clustered. The step now comes from the pack
// (realm.json true.waterByClass.<cls>.phaseStep), per loop (sea and inland), and 0 keeps the old step for a pinned caller.
import { waterPhaseStep } from './ground.mjs';
import { TRUE_FS } from './glsl/trueground.glsl.mjs';
import { kitHash } from './classify.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { decodePng } from './loader.mjs';
function truePack({ sea, inland }) {
  const pack = fakePack(), px = (w, h, v = 0) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
  pack.meta.true = { atlas: { file: 'ground.png', cell: 32, cols: 16, layers: 64 }, mask: { file: 'groundmask.png' },
    terrains: [{ id: 'sand', pure: [0, 4], layer: 1 }, { id: 'water', pure: [32, 1], kind: 'water', layer: 0 }], classToTerrain: { WILD: 'sand', SEA: 'water', DEEP: 'water', WATER: 'water' }, families: [],
    water: sea, waterByClass: { DEEP: sea, SEA: sea, WATER: inland } };
  const base = pack.pixels; pack.pixels = async k => (k === 'ground.png' || k === 'groundmask.png' ? px(512, 128, 120) : base(k));
  return pack;
}
test('Stage B TRUE water: the phase step is the pack\'s (Solana\'s 16-frame gem loop 4, the 8-frame loops 2), per loop', async () => {
  assert.equal(waterPhaseStep({ frames: 16, phases: 4, phaseStep: 4 }), 4);
  assert.equal(waterPhaseStep({ frames: 8, phases: 4, phaseStep: 2 }), 2);
  assert.equal(waterPhaseStep({ frames: 8, phases: 4 }), 2, 'no phaseStep (the five first packs): frames / phases, the old 2');
  assert.equal(waterPhaseStep({ frames: 16, phases: 4 }), 4, 'no phaseStep on a 16-frame loop: a quarter loop');
  assert.equal(waterPhaseStep({}), 2); assert.equal(waterPhaseStep({ frames: 8, phaseStep: 0 }), 2, 'a bad step falls back');
  assert.equal(waterPhaseStep({ frames: 4, phaseStep: 9 }), 4, 'never more than the loop');
  const sea = { first: 0, frames: 16, frameMs: 110, phases: 4, phaseStep: 4, drift: [2, -2] }, inland = { first: 16, frames: 8, frameMs: 200, phases: 4 };
  const f = fakeCore(), g = createGround(f.core); await g.load(truePack({ sea, inland }));
  assert.equal(g.ready.true, true);
  const v = view(1200, { w: { far: 0, map: 0, true: 1 } }); for (let i = 0; i < 40 && (i === 0 || g.stats().missing); i++) g.update(v); g.draw(v);
  const u = f.st.uni['rm-true'];
  assert.deepEqual(u.uTgWater, [1, 16, 110, 4], 'sea loop: first (+ the reserved layer 0), frames, frame ms, phase step 4');
  assert.deepEqual(u.uTgWater2, [17, 8, 200, 2], 'inland loop: its own step');
  // the shader steps the record's phase by the uniform's w (0 → the old 2), never by a literal
  assert.match(TRUE_FS, /int phase = int\(\(rec\.w >> 4u\) & 3u\) \* \(wl\.w > 0 \? wl\.w : 2\);/);
  assert.doesNotMatch(TRUE_FS, /& 3u\) \* 2;/, 'the pre-Stage-B literal step');
  g.dispose();
});
// On the real Solana Reach pack (gitignored build output; skipped where absent): at the pack's step the gem highlights of a
// 32 × 32-tile sea (the kit's phase hash) spread most evenly over the 32 texel rows and columns — no dotted-row lattice —
// and the pre-Stage-B step 2 is visibly more row-bound. Frame 0 only: every tile shifts together from frame to frame.
test('Stage B TRUE water on the real Solana Reach pack: its gem rows spread most evenly at the pack\'s phase step', async t => {
  const dir = PACK_ROOT + 'realm/seeker-reach/';
  if (!existsSync(dir + 'realm.json') || !existsSync(dir + 'ground.png')) { t.skip('no seeker-reach pack built here'); return; }
  const meta = JSON.parse(readFileSync(dir + 'realm.json', 'utf8')), w = meta.true.waterByClass.SEA, A = meta.true.atlas;
  const img = await decodePng(new Uint8Array(readFileSync(dir + 'ground.png')), { yieldTask: async () => {} }), W = img.width, colsA = A.cols ?? Math.floor(W / 32);
  const lum = (L, x, y) => { const o = ((Math.floor(L / colsA) * 32 + y) * W + (L % colsA) * 32 + x) * 4; return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]; };
  let m = 0; for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) m += lum(w.first, x, y) / 1024;
  const hi = Array.from({ length: w.frames }, (_, f) => { const a = []; for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (lum(w.first + f, x, y) > m + 30) a.push(x, y); return a; });
  const cv = h => { const mu = h.reduce((a, b) => a + b) / h.length; return Math.sqrt(h.reduce((a, b) => a + (b - mu) ** 2, 0) / h.length) / mu; };
  const spread = step => { const row = new Float64Array(32), col = new Float64Array(32);
    for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 32; tx++) { const a = hi[((kitHash(tx ^ 0x77, ty ^ 0x99) % 4) * step) % w.frames]; for (let i = 0; i < a.length; i += 2) { col[a[i]]++; row[a[i + 1]]++; } }
    return Math.max(cv(row), cv(col)); };
  const s = waterPhaseStep(w), at = [1, 2, 3, 4].map(spread);
  assert.equal(w.frames, 16); assert.equal(s, 4, 'the pack records the quarter-loop step');
  assert.ok(at[s - 1] <= Math.min(...at) + 1e-9, `the pack's step spreads the gems most evenly (${at.map(x => x.toFixed(3))})`);
  assert.ok(at[1] > at[s - 1] * 1.05, `the old step 2 is more row-bound (${at[1].toFixed(3)} vs ${at[s - 1].toFixed(3)})`);
});

// realm.json describes fieldsA under fields.fieldsA; PACK's W1 G3 bake flag is honoured there as well as at the top level.
test('Stage B baked load passes: fields.fieldsA.baked is honoured like fieldsA.baked', async () => {
  const f = fakeCore(), g = createGround(f.core), p = fakePack(); p.meta.fields = { fieldsA: { file: 'fieldsA.png', baked: ['foreignSea'] } }; await g.load(p);
  assert.deepEqual(g.stats().foreignSea, { baked: true }); assert.ok(Number.isFinite(g.stats().tarns?.ms), 'clipTarns not baked: still run');
  g.dispose();
});

// Stage B (RM-GPU-1 W1 blocker 5): the river bend (G16) ran synchronously inside every base-state change (20–129 ms in one
// task on the QA host). It is queued base-state work now, run in slices before the bridges and river pages it moves. With a
// clock that advances 1 ms per read, the bend (hundreds of steps) cannot finish inside the call's first 8 ms slice: the call
// returns with the rivers unbent and classState() null (LIFE waits); after the queue drains, the rivers are bent and their
// pages re-baked. (Bridges queued with the bend wait for it: drainBaseWork drains the bend first. This synthetic realm has no
// sea or lake plots, so no bridge depends on the order here: that ordering is by construction, not tested.)
// Teeth: the pre-Stage-B updateBends replaced the rivers synchronously inside setBases.
test('Stage B: a base-state change queues the river bend as sliced work, not inside the call', async () => {
  const rivers = []; for (let r = 0; r < 6; r++) { const pts = []; for (let i = 0; i <= 40; i++) pts.push([i * COLS * 98 / 40, (r * 5 + 3.5) * 98 + 6 * Math.sin(i * 0.5 + r)]); rivers.push({ pts, hw: 5 }); }
  const pack = fakePack(); pack.json = async k => (k === 'lines.json' ? { rivers } : {});
  const f = fakeCore(), g = createGround(f.core); await g.load(pack);
  const before = g.debug().rivers, bases = [];
  for (let r = 0; r < 6; r++) for (let x = 2; x < COLS - 2; x += 4) bases.push({ x, y: r * 5 + 3, level: 1 + ((x * 7 + r) % 20) });
  const now = performance.now; let clock = now.call(performance);
  performance.now = () => (clock += 1);
  try {
    g.setBases(bases);
    assert.ok(g.debug().rivers === before, 'the call returned before the bend landed (it is not run synchronously)'); // (ok, not equal: a diff of two segment sets is huge)
    assert.ok(g.classState() === null, 'LIFE reads no class state while the bend is pending');
  } finally { performance.now = now; }
  for (let i = 0; i < 20000 && !g.classState(); i++) await new Promise(r => setTimeout(r, 0));
  const d = g.debug(); assert.ok(g.classState(), 'the base-state work drained');
  assert.ok(d.rivers !== before, 'the bent rivers replaced the plain ones'); assert.ok(g.stats().bends.moved > 0, 'the plots bent the rivers');
  // the river pages the bend moved were re-baked (the GPU samples the bent rivers)
  assert.ok(g.stats().lines.rebakes > 0, 'river pages re-baked after the bend');
  g.dispose();
});

// Stage B, the MAP grade toward each new realm's painting (engine-owed.json, GROUND): at the FAR→MAP hand-over (d 48, famW 1)
// the family grade scales each map slot's art to the painting's mean colour for its classes. The three new realms' MAP art
// is far darker than their paintings (Elderwood's glade ground needs ×2.0 in blue, Thornwake's jungle floor ×2.1 and its
// rock ×2.3), so GA2-05's 1.8 clamp left a visible step (CPU slot model: ΔE 5.8–10.7). Their range is 2.4; the five first
// realms keep 1.8 (measured, owner-seen), and realm.json map.famClamp overrides either.
import { famClamp } from './ground.mjs';
test('Stage B MAP grade: the new realms\' family grade reaches 2.4 toward their painting, the first five stay at 1.8', async () => {
  for (const id of ['elderwood', 'thornwake', 'seeker-reach']) assert.deepEqual(famClamp({ id }), [0.6, 2.4], id);
  for (const id of ['crownlands', 'frostveil', 'sunscar', 'cinderfall', 'stormcairn', 'test']) assert.deepEqual(famClamp({ id }), [0.6, 1.8], id);
  assert.deepEqual(famClamp({ id: 'sunscar', map: { famClamp: [0.5, 2.2] } }), [0.5, 2.2], 'realm.json map.famClamp overrides');
  assert.deepEqual(famClamp({ id: 'elderwood', map: { famClamp: [2, 1] } }), [0.6, 2.4], 'a nonsense override is ignored');
  // end to end: a painting 2.5× the map art's colour (RGB 150 over 60) grades to the realm's cap
  const grade = async id => {
    const f = fakeCore(), g = createGround(f.core), pack = fakePack(); pack.meta.id = id;
    const art = (w, h) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) d.set([60, 60, 60, 255], i * 4); return { width: w, height: h, data: d }; };
    Object.assign(pack.meta.map, { atlas: { file: 'mapkit.png', cell: 32, cols: 16, layers: 64, families: { M1: 4 }, wild: [0, 4] }, mask: { file: 'mapmask.png' } });
    const base = pack.pixels; pack.pixels = async k => (k === 'mapkit.png' || k === 'mapmask.png' ? art(512, 128) : base(k));
    await g.load(pack); const k = g.stats().famK[0]; g.dispose(); return k;
  };
  assert.deepEqual(await grade('elderwood'), [2.4, 2.4, 2.4], 'Elderwood: the wild ground grades up to its painting (capped at 2.4)');
  assert.deepEqual(await grade('crownlands'), [1.8, 1.8, 1.8], 'Crownlands keeps the GA2-05 cap');
});

// Stage B, Solana Reach's gem sea at MAP: the orchestrator's bar for its water (the owner's "one thing to remember") is that the
// gem shards stay visible at MAP as well as TRUE, drifting on both axes like the kit loop, never a dotted-row lattice. MAP now
// lights 3 % of its ≥ 1-device-px cells with a sparkle in the loop's two gem colours, on a hashed field that drifts with the
// kit's drift. rm-water's rmGem is ALU only; gemAt is its JS twin.
import { waterGems, gemDrift, gemAt, gemColours } from './ground.mjs';
import { RM_WATER } from './glsl/water.glsl.mjs';
import { MAP_FS } from './glsl/mapground.glsl.mjs';
test('Stage B gem sea: Solana Reach\'s MAP water sparkles in its gem colours, 3 % of cells, drifting on both axes, never in rows', async () => {
  assert.equal(waterGems({ id: 'seeker-reach' }), 0.03); assert.equal(waterGems({ id: 'crownlands' }), 0, 'every other realm: off');
  assert.equal(waterGems({ id: 'seeker-reach', map: { waterGems: 0 } }), 0, 'realm.json can switch it off');
  const sea = { first: 0, frames: 16, frameMs: 110, phases: 4, phaseStep: 4, drift: [2, -2] }, d = gemDrift(sea);
  assert.ok(Math.abs(d[0] - 2000 / 110 / 7) < 1e-9 && Math.abs(d[1] + 2000 / 110 / 7) < 1e-9, `drift in map art px/s: ${d}`);
  // the twin's field: the lit share, evenness over rows and columns (a random field; a lattice puts all its dots in a few
  // rows or columns), and a pure translation by the drift on BOTH axes
  const g = [0.03, d[0], d[1], 1], N = 256, lit = (ms, ox = 0, oy = 0) => { const a = new Uint8Array(N * N); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) a[y * N + x] = gemAt(x + ox, y + oy, 1, g, ms) ? 1 : 0; return a; };
  const a = lit(0), share = a.reduce((s, v) => s + v, 0) / (N * N);
  assert.ok(Math.abs(share - 0.03) < 0.004, `lit share ${share}`);
  const cv = h => { const m = h.reduce((s, v) => s + v) / h.length; return Math.sqrt(h.reduce((s, v) => s + (v - m) ** 2, 0) / h.length) / m; };
  const rows = Array.from({ length: N }, (_, y) => a.subarray(y * N, (y + 1) * N).reduce((s, v) => s + v, 0)), cols = Array.from({ length: N }, (_, x) => rows.reduce((s, _r, y) => s + a[y * N + x], 0));
  assert.ok(cv(rows) < 0.6 && cv(cols) < 0.6, `rows / columns evenly lit (CV ${cv(rows).toFixed(2)} / ${cv(cols).toFixed(2)}; binomial ≈ 0.37)`);
  const T = 2000, sx = Math.floor(Math.fround(d[0]) * T / 1000), sy = Math.floor(Math.fround(d[1]) * T / 1000);
  assert.ok(sx !== 0 && sy !== 0, `after ${T} ms the field moved on both axes (${sx}, ${sy})`);
  const b = lit(T, sx, sy); assert.ok(a.every((v, i) => v === b[i]), 'the field at T is the field at 0 shifted by the drift');
  assert.ok(gemAt(5, 5, 1, [0.03, d[0], d[1], 0], 0) === 0 && gemAt(5, 5, 1, [0, d[0], d[1], 1], 0) === 0, 'off, or a zero share: none');
  // the shader: ALU only (no fetch, no loop), in the sea and the inland water, the twin's constants
  const fn = RM_WATER.slice(RM_WATER.indexOf('int rmGem('), RM_WATER.indexOf('// flow dashes'));
  assert.doesNotMatch(fn, /texture|texelFetch|for\s*\(|while/); assert.match(fn, /mod\(floor\(g\.yz \* \(rmMs\(\) \* 0\.001\) \/ dq\), 65536\.0\)/); assert.match(fn, /\(cell - ivec2\(sh\)\) & ivec2\(0xffff\)\) \^ uvec2\(0x6e57u, 0x2a1bu\)/);
  assert.equal((MAP_FS.match(/rmGem\(dpx, dq, uMpGem\)/g) ?? []).length, 2, 'MAP calls it for the sea and the inland water');
  // the gem colours come from the kit loop's highlight texels (warm and cool shards)
  const W = 32, px = new Uint8Array(W * W * 4); for (let i = 0; i < W * W; i++) px.set([45, 124, 166, 255], i * 4);
  px.set([230, 221, 255, 255], (3 * W + 4) * 4); px.set([202, 248, 255, 255], (9 * W + 20) * 4);
  assert.deepEqual(gemColours(px, W, 0, 0).map(c => c.map(v => Math.round(v * 255))), [[230, 221, 255], [202, 248, 255]]);
  assert.equal(gemColours(new Uint8Array(W * W * 4).fill(200), W, 0, 0), null, 'a loop with no highlight texels: none');
  // end to end: drawMap sends the share (grown in over d 48 → 150), the drift and the measured colours; other realms off
  const run = async id => {
    const pack = truePack({ sea, inland: sea }); pack.meta.id = id; const base = pack.pixels;
    pack.pixels = async k => { const r = await base(k); if (k === 'ground.png') { for (let i = 3; i < r.data.length; i += 4) r.data[i] = 255; r.data.set([230, 221, 255, 255], (5 * r.width + 6) * 4); r.data.set([202, 248, 255, 255], (20 * r.width + 9) * 4); } return r; };
    const f = fakeCore(), gr = createGround(f.core); await gr.load(pack);
    const at = dd => { const v = view(dd); gr.update(v); gr.draw(v); return [...f.st.uni['rm-map'].uMpGem]; };
    return { at, g: gr, f };
  };
  const s = await run('seeker-reach');
  assert.equal(s.at(48)[0], 0, 'none at the FAR→MAP hand-over (the painting has none)');
  const m = s.at(90); assert.ok(m[0] > 0 && m[0] < 0.03, `d 90 share ${m[0]}`);
  const r = s.at(300); assert.ok(Math.abs(r[0] - 0.03) < 1e-6 && Math.abs(r[1] - d[0]) < 1e-6 && Math.abs(r[2] - d[1]) < 1e-6 && r[3] === 1, `d 300 ${r}`);
  // each gem as colour ÷ the loop's mean colour (frame 0: 1022 texels of 120 and the two gems), × the MAP water under it
  const mean = [120 * 1022 + 230 + 202, 120 * 1022 + 221 + 248, 120 * 1022 + 255 + 255].map(v => v / 1024);
  const k = [[230, 221, 255], [202, 248, 255]].flatMap(c => c.map((v, i) => v / mean[i]));
  assert.ok(Array.from(s.f.st.uni['rm-map'].uMpGemCol).every((v, i) => Math.abs(v - k[i]) < 1e-3), `gem ÷ water ratios ${Array.from(s.f.st.uni['rm-map'].uMpGemCol)}`);
  assert.equal((MAP_FS.match(/min\(col \* uMpGemCol\[gm - 1\], vec3\(1\.0\)\)/g) ?? []).length, 2, 'the gem scales the water under it (TRUE\'s contrast at every depth)');
  const c = await run('crownlands'); assert.equal(c.at(300)[3], 0, 'Crownlands: off');
  s.g.dispose(); c.g.dispose();
});

// Stage B (help attribute the first-visit band-change spike, RM-GPU-1 W1 item 1): stats().work is GROUND's own work in each of
// the last 64 update() frames, oldest first — the lattice sub-tiles and TRUE pages that frame resolved, update()'s CPU ms,
// the zoom — so QA can line a long band-change task up with a destination resolve (or rule GROUND's resolves out).
test('Stage B stats().work: the last 64 frames of GROUND work, with the resolves of a band change', async () => {
  const { g } = await loaded();
  assert.deepEqual(g.stats().work, [], 'no frame yet');
  g.update(view(10)); g.update(view(150));
  const w = g.stats().work; assert.equal(w.length, 2);
  assert.deepEqual(w.map(x => x.d), [10, 150], 'oldest first, with the zoom');
  assert.equal(w[0].subs, 0, 'FAR during input: no resolve'); assert.ok(w[1].subs > 0, 'the first MAP frame resolved its destination sub-tiles');
  assert.ok(w[1].missing > 0 && w[1].t >= w[0].t && w[1].ms >= 0);
  for (let i = 0; i < 70; i++) g.update(view(150));
  const w2 = g.stats().work; assert.equal(w2.length, 64, 'a ring of 64');
  assert.equal(w2.at(-1).subs, 0, 'once resolved, a frame resolves nothing'); assert.equal(w2.at(-1).missing, 0);
  g.dispose();
});

// ---- Fix pass (Stage B QA round 1 + critic, 2026-09-25) --------------------------------------------------------------------
// RM-23: LIFE's scrub and rocks floated in one row just outside every realm-grid edge at MAP d 150 (Solana Reach, Frostveil),
// in the open sea that D-173 makes a resting view. The sampled lattice read "unresolved" (0 → WILD) for a vertex outside the
// grid, so mapClassAt / mapClassFine / classAtTile called the sea past the edge land. Outside the grid is the open sea: DEEP.
// latClassAt is the JS twin; the shader's bounds branch is pinned to it below.
import { latClassAt, deepTint, gemHighlight } from './ground.mjs';
import { CLASSES } from './glsl/classes.glsl.mjs';
test('RM-23: a lattice read outside the realm grid is the open sea (DEEP), never the unresolved WILD', () => {
  const W = COLS * 14 + 1, H = ROWS * 14 + 1, land = () => CLASS.WILD + 1, sea = () => CLASS.SEA + 1; // resolved texels
  // tiles just past each edge, and far out: the sea, whatever the lattice inside says
  for (const [x, y] of [[-4, 700], [-1000, 700], [COLS * 98 + 4, 700], [COLS * 98 + 500, 700], [700, -4], [700, ROWS * 98 + 4]])
    assert.equal(latClassAt(land, W, H, x, y), CLASS.DEEP, `tile (${x}, ${y}) outside the grid`);
  // (-1, y) and (cols·98, y) round to the grid's own edge vertices (0 and cols·14): the lattice's class there, resolved like
  // any vertex (the foreign sea makes it sea on a real realm)
  assert.equal(latClassAt(sea, W, H, -1, 700), CLASS.SEA); assert.equal(latClassAt(sea, W, H, COLS * 98, 700), CLASS.SEA);
  assert.equal(latClassAt(land, W, H, -1, 700), CLASS.WILD, 'an edge vertex reads the lattice, not a guess');
  // inside the grid nothing changed: unresolved is still WILD, a clearing is RING, and no lattice yet reads unresolved everywhere
  assert.equal(latClassAt(() => 0, W, H, 700, 700), CLASS.WILD);
  assert.equal(latClassAt(() => 128 | (CLASS.WILD + 1), W, H, 700, 700), CLASS.RING);
  assert.equal(latClassAt(land, 0, 0, -40, 700), CLASS.WILD, 'before the lattice exists (W 0): unresolved, as before');
  // the shader: the bounds branch returns the encoded DEEP (class 0 + 1) once a lattice exists, and rmLatClass decodes 1u to 0
  assert.match(CLASSES, /l\.x >= uRmLat\.z \|\| l\.y >= uRmLat\.w\) return uRmLat\.z > 0 \? 1u : 0u;/);
  assert.match(CLASSES, /uint rmLatClass\(uint r\) \{ uint c = r & 15u; return c == 0u \? 4u : \(r & 128u\) != 0u \? 12u : c - 1u; \}/);
});

// RM-24: the "Crownlands TRUE 1-px gold line" was GROUND's TRUE selection outline of the selected DEED: at d 1600 a deed is ~1,600
// px wide, so one stray gold edge showed under the trees, far from the kingdom (Thornwake too). TRUE draws no deed outline now:
// MAP's (mapground) fades out with the MAP layer across the MAP → TRUE hand-over, and BASES' selection ring marks the kingdom.
test('RM-24: TRUE draws no selected-deed outline; MAP keeps its deed outline', async () => {
  assert.doesNotMatch(TRUE_FS, /uSel/, 'TRUE reads no selection');
  assert.match(MAP_FS, /if \(all\(equal\(d, ivec2\(uSel\.xy\)\)\)\) \{/, 'MAP still outlines the selected deed');
  const sea = { first: 0, frames: 8, frameMs: 200, phases: 4 }, f = fakeCore(), g = createGround(f.core); await g.load(truePack({ sea, inland: sea }));
  const v = view(1200, { w: { far: 0, map: 0, true: 1 } }); for (let i = 0; i < 40 && (i === 0 || g.stats().missing); i++) g.update(v); g.draw(v);
  assert.deepEqual(Array.from(f.st.uni['rm-true'].uTgPal).slice(6, 9), [0, 0, 0], 'the old gold slot is empty (the layout stays for a pinned port)');
  g.dispose();
});

// Owner 2026-09-26, Seeker code 31, Sunscar at MAP zoom: "grey overlay is visible on current screen on realm map and it looks
// ugly"; then code 31b, Crownlands at the FAR overview: "check crownland also have that grey area on the edges, which sunscar
// had, fix it for all realms, sunscar does not have it anymore while zoomed in but when you zoom out a bit you will see it
// again". A realm's art paints land the catalogue gives to another realm (Sunscar's northern coast, Crownlands' snow coast), and
// every per-deed other-realm veil greyed that land deed by deed with hard, stair-stepped edges: MAP first, then the FAR chart
// (×0.85, the D-177 landing overview) and so the chart → MAP crossfade, the minimap (×0.12) and SHELL's stand-in ground (×0.8).
// The rule now, at every zoom: an other-realm deed draws exactly as a cell with no deed does, as the realm art paints it. Only
// the soft foreign fade (distance from THIS realm's deeds, not who owns a deed) still eases far land into the open sea.
// How it is checked: every shader read of a deed's realm (deeds.png via uDeeds, the base-state kind via uRmBase, the legacy
// ?rm1 renderer's uState) is found in the realm-map sources, and every branch on it is evaluated for an other-realm deed and for
// no deed; the two must agree. A read or a use this checker cannot evaluate fails loud instead of passing.
import { readdirSync } from 'node:fs';
import { DEED_PX, KIND } from './contracts.mjs';
const REALM_READ = /\b(?:texelFetch|texture|textureLod)\s*\(\s*(uDeeds|uRmBase|uState)\b/g;
/** [an other-realm deed, no deed] as each source encodes a deed's realm (deeds.png byte, base-state kind, normalised byte). */
const REALM_VALUES = { uDeeds: [DEED_PX.otherRealm, DEED_PX.none], uRmBase: [KIND.otherRealm, KIND.none], uState: [DEED_PX.otherRealm / 255, 0] };
const closeParen = (s, open) => { for (let d = 0, i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d === 0) return i; } return -1; };
const lineOf = (s, i) => s.slice(0, i).split('\n').length;
/** → { reads: ['uDeeds dv', …], branches, veils: [where], problems: [where] } for one source text (JS with GLSL strings, or GLSL). */
function otherRealmVeils(raw) {
  const s = raw.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length)), out = { reads: [], branches: 0, veils: [], problems: [] };
  for (const m of s.matchAll(REALM_READ)) {
    const tex = m[1], at = m.index, st0 = Math.max(s.lastIndexOf(';', at), s.lastIndexOf('{', at), s.lastIndexOf('}', at)) + 1;
    const st1 = s.indexOf(';', at), stmt = s.slice(st0, st1), decl = stmt.match(/^\s*(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*=/);
    if (!decl) { out.problems.push(`${lineOf(s, at)}: a ${tex} read that is not a declaration: ${stmt.trim()}`); continue; }
    const after = s.slice(closeParen(s, s.indexOf('(', at)) + 1), ch = after.match(/^\s*\.([xyzwrgba]+)\b/);
    if (ch && !/[rx]/.test(ch[1])) continue;                   // reads other channels only (flags, claim, level)
    const scalar = !!ch, name = decl[1], [vOther, vNone] = REALM_VALUES[tex];
    out.reads.push(`${tex} ${scalar ? name : name + '.r'}`);
    let end = st1 + 1; for (let d = 0; end < s.length; end++) { if (s[end] === '{') d++; else if (s[end] === '}' && --d < 0) break; }
    const judged = new Set();                                  // one verdict per branch (dv > 80u && dv < 128u is one)
    for (const u of s.slice(st1 + 1, end).matchAll(new RegExp(`\\b${name}\\b(\\s*\\.\\s*([xyzwrgba]+)\\b)?`, 'g'))) {
      if (!scalar && !u[1]) { out.problems.push(`${lineOf(s, st1 + 1 + u.index)}: ${name} used whole`); continue; }
      if (!scalar && !/[rx]/.test(u[2])) continue;
      const j = st1 + 1 + u.index, where = `${lineOf(s, j)}: ${s.slice(s.lastIndexOf('\n', j) + 1, s.indexOf('\n', j)).trim()}`;
      if (!scalar && u[2].length !== 1) { out.problems.push(`${where} (swizzle ${u[2]})`); continue; }
      // the innermost if-condition or step() around this use
      let best = null;
      for (const c of s.slice(0, j).matchAll(/\b(if|step)\s*\(/g)) {
        const o = c.index + c[0].length - 1, cl = closeParen(s, o);
        if (cl > j && (!best || o > best.o)) best = { kind: c[1], o, cl };
      }
      if (!best) { out.problems.push(`${where} (not in an if-condition or step())`); continue; }
      if (judged.has(best.o)) continue; judged.add(best.o);
      const sym = scalar ? `\\b${name}\\b` : `\\b${name}\\s*\\.\\s*[rx]\\b`, expr = s.slice(best.o + 1, best.cl);
      const val = v => {
        const e = expr.replace(new RegExp(sym, 'g'), String(v)).replace(/(\d)u\b/g, '$1');
        if (best.kind === 'step') { const a = e.split(','); return a.length === 2 && /^[\s\d.]+$/.test(a.join('')) ? (+a[1] >= +a[0] ? 1 : 0) : undefined; }
        return /^[\s\d.<>=!&|()]+$/.test(e) ? Function(`return (${e});`)() : undefined;
      };
      const a = val(vOther), b = val(vNone);
      if (a === undefined || b === undefined) { out.problems.push(`${where} (cannot evaluate ${best.kind}(${expr.trim()}))`); continue; }
      out.branches++;
      if (a !== b) out.veils.push(where);
    }
  }
  return out;
}
test('owner 2026-09-26: no realm-map shader or JS path veils other-realm deeds, at any zoom (FAR chart, crossfade, MAP, TRUE, minimap, stand-in)', () => {
  const dir = new URL('./', import.meta.url), glslDir = new URL('./glsl/', import.meta.url);
  const files = [...readdirSync(dir).filter(f => f.endsWith('.mjs') && !/\.(test|cases|fixture|support)\.mjs$/.test(f)).map(f => new URL(f, dir)), ...readdirSync(glslDir).filter(f => f.endsWith('.mjs')).map(f => new URL(f, glslDir))]
    // web port (patches.md P3): the concept's legacy ?rm1 renderer (realmmap.js) is not ported, so it is not scanned here
    .map(u => ({ f: u.pathname.slice(u.pathname.lastIndexOf('/src/') + 1), text: readFileSync(u, 'utf8') }));
  const all = files.map(x => ({ ...x, ...otherRealmVeils(x.text) }));
  assert.deepEqual(all.flatMap(x => x.problems.map(p => `${x.f}:${p}`)), [], 'every read of a deed\'s realm is one this test can judge');
  assert.deepEqual(all.flatMap(x => x.veils.map(v => `${x.f}:${v}`)), [], 'an other-realm deed takes exactly the branch a cell with no deed takes');
  // teeth: the scanner reaches the reads that remain (a regex that silently matched nothing would pass everything above)
  const reads = all.flatMap(x => x.reads.map(r => `${x.f.split('/').pop()} ${r}`));
  for (const r of ['mapground.glsl.mjs uRmBase bs.r', 'classes.glsl.mjs uRmBase b.r', 'map.mjs uDeeds dv'])
    assert.ok(reads.includes(r), `the scanner found ${r} (found: ${reads.join(', ')})`);
  assert.ok(all.reduce((n, x) => n + x.branches, 0) >= 2, 'MAP\'s deed lines and the stand-in\'s deed lines are judged (the legacy ?rm1 deed step is not ported)');
  // teeth: each veil removed on 2026-09-26 is caught if it comes back, and a use the checker cannot read fails loud
  const VEILS = {
    'FAR chart': 'void main() { ivec2 cell = ivec2(floor(p)); uint dv = texelFetch(uDeeds, cell, 0).r; if (dv > 80u && dv < 128u) col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), 0.25) * 0.85; }',
    minimap: 'void main() { uint dv = texelFetch(uDeeds, ivec2(floor(p)), 0).r; if (dv > 80u && dv < 128u) keep *= 0.12; }',
    MAP: 'void main() { uvec4 bs = texelFetch(uRmBase, d, 0); if (bs.r == 1u) col = line; if (bs.r == 2u) col = mix(col, vec3(lum(col)), 0.25) * 0.88; }',
    'legacy ?rm1': 'void main(){ivec2 cell=ivec2(floor(p));vec4 st=inside?texelFetch(uState,cell,0):vec4(0.);float deed=step(.9,st.r);\n if(st.r>.3&&st.r<.5)col=mix(col,vec3(luma(col)),.35)*.8;\n o=vec4(col,1.);}',
  };
  for (const [k, src] of Object.entries(VEILS)) assert.deepEqual([otherRealmVeils(src).veils.length, otherRealmVeils(src).problems], [1, []], `${k}: the old veil is caught`);
  assert.equal(otherRealmVeils('void main() { uint dv = texelFetch(uDeeds, c, 0).r; col *= dv == 96u ? 0.85 : 1.0; }').problems.length, 1, 'a ternary veil fails loud');
  assert.equal(otherRealmVeils('void main() { col *= texelFetch(uDeeds, c, 0).r == 96u ? 0.85 : 1.0; }').problems.length, 1, 'an inline read fails loud');
  // JS: the other-realm identity is carried as data only, into the base-state kind the shaders above never draw differently;
  // a JS path that dimmed by it (a CPU texture, a canvas, a dot alpha) would name it somewhere else
  const js = all.filter(x => !x.f.endsWith('/contracts.mjs')).flatMap(x => x.text.split('\n').map((l, i) => ({ f: x.f.split('/').pop(), l, i: i + 1 })))
    .filter(({ l }) => /\botherRealm\b/.test(l));
  assert.deepEqual(js.filter(({ l }) => !/\b(?:stateData\[k\]|baseCpu\[i \* 4\])\s*=/.test(l)).map(({ f, i, l }) => `${f}:${i}: ${l.trim()}`), [], 'only the base-state encoders name the other realm');
  assert.deepEqual([...new Set(js.map(({ f }) => f))].sort(), ['bases.mjs', 'ground.mjs'], 'the encoders were found');
});

// D3 (perf critic): chart8 was uploaded twice per realm (GROUND's own and the minimap's shared copy: +8.8–10 MB of GPU memory and
// a second texImage2D + generateMipmap in the entry's first task); the deeds and far field too. GROUND now takes the minimap's
// shared keys with the same options and bytes, so whichever loads first uploads once — and GROUND's dispose() never frees a
// texture the minimap may still sample (core.tex.freeAll frees it with the realm).
import { farDeeds } from './minimap.mjs';
test('D3: chart8, the deeds and the far field are shared with the minimap (one upload each), and GROUND does not free them', async () => {
  const f = fakeCore(), made = new Map(), freed = new Set(), data0 = f.core.tex.data;
  f.core.tex.shared = (k, make) => { if (!made.has(k)) made.set(k, make()); return made.get(k); };
  f.core.tex.data = (w, h, fmt, a, b, arr, o) => Object.assign(data0(w, h, fmt, a, b, arr, o), { arr });
  f.core.tex.free = o => freed.add(o);
  const pack = fakePack(); pack.id = 'test'; for (let i = 0; i < COLS * ROWS; i++) if (i % COLS >= COLS / 2) pack.first.deeds[i] = 0; // half the grid is sea
  const g = createGround(f.core); await g.load(pack);
  assert.deepEqual([...made.keys()].filter(k => k.startsWith('test:')).sort(), ['test:chart8', 'test:deeds', 'test:minifar']);
  // the far field GROUND uploads is the minimap's farDeeds, byte for byte (so either module's make() serves both)
  assert.deepEqual(Array.from(made.get('test:minifar').arr), Array.from(farDeeds(pack.first.deeds, COLS, ROWS), v => Math.min(255, Math.round(v * 16))));
  // the minimap's calls get GROUND's objects: no second upload
  f.rec.counting = true; f.rec.uploads = 0;
  const mini = ['chart8', 'deeds', 'minifar'].map(k => f.core.tex.shared(`test:${k}`, () => f.core.tex.image({ width: 1, height: 1 })));
  assert.equal(f.rec.uploads, 0, 'the minimap reuses the shared textures');
  g.dispose();
  for (const t of mini) assert.ok(!freed.has(t), 'GROUND leaves the shared textures to core.tex.freeAll');
  assert.ok(freed.size > 0, 'GROUND still frees its own textures');
});

// Fix pass #5 (critic, Solana Reach TRUE open sea): the depth tint (× the painting's navy DEEP ×1.6) turned the kit's teal
// gem water navy (18,56,126) against the kit's (45,124,166), ΔE 37.3, and dimmed the white, pink and cyan shards to lavender
// specks (bright share 0.012 at d 1400). A gem-sea realm takes a third of the tint (one step at the deepest water), and TRUE
// keeps the loop's highlight texels out of it. MAP's kit-water ends use the same tint, so the MAP → TRUE hand-over matches.
test('fix pass #5: Solana Reach\'s TRUE sea stays kit teal with bright gems; every other realm keeps its depth tint', async () => {
  const navy = [18, 56, 126].map(v => v / 255), old = navy.map(v => clamp01(v * 1.6, 0.4, 1));
  assert.deepEqual(deepTint(navy, { id: 'crownlands' }), old, 'other realms: the tint as before');
  const t = deepTint(navy, { id: 'seeker-reach' }); t.forEach((v, i) => assert.ok(Math.abs(v - (1 + (old[i] - 1) / 3)) < 1e-12));
  assert.equal(gemHighlight({ id: 'crownlands' }), 0); assert.equal(gemHighlight({ id: 'seeker-reach' }), 0.45);
  // the shader's rule on the loop's own colours, with what GROUND sends: the body at full depth stays teal, a gem keeps its colour
  const hk = (c, w) => { if (!(w > 0)) return 1; const L = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], s = Math.min(1, Math.max(0, (L - w) / 0.15)); return 1 - s * s * (3 - 2 * s); };
  const tinted = (c, tt, w) => { const k = hk(c, w); return c.map((v, i) => v * (1 + (tt[i] - 1) * k)); };
  const body = [45, 124, 166].map(v => v / 255), gems = [[230, 221, 255], [202, 248, 255]].map(c => c.map(v => v / 255));
  assert.ok(dE(tinted(body, t, 0.45), body) < 15, `deepest body ΔE ${dE(tinted(body, t, 0.45), body).toFixed(1)} (the old tint: ${dE(tinted(body, old, 0), body).toFixed(1)})`);
  for (const c of gems) assert.ok(dE(tinted(c, t, 0.45), c) < 1, `gem ${c.map(v => Math.round(v * 255))} keeps its colour`);
  assert.ok(dE(tinted(body, old, 0), body) > 30, 'the old tint is what the critic saw (navy)');
  assert.match(TRUE_FS, /col\.rgb = mix\(col\.rgb, col\.rgb \* uTgPal\[0\], step_ \* hk\);/);
  assert.match(TRUE_FS, /float hk = uTgOpt\.w > 0\.0 \? 1\.0 - smoothstep\(uTgOpt\.w, uTgOpt\.w \+ 0\.15, dot\(col\.rgb, vec3\(0\.299, 0\.587, 0\.114\)\)\) : 1\.0;/);
  // end to end: drawTrue sends the tint and the highlight luma; MAP's deep water at d 800 is the kit loop × the same tint
  const sea = { first: 0, frames: 16, frameMs: 110, phases: 4, phaseStep: 4, drift: [2, -2] };
  const run = async id => { const pack = opaque(truePack({ sea, inland: sea })); pack.meta.id = id; const f = fakeCore(), g = createGround(f.core); await g.load(pack);
    const v = view(1200, { w: { far: 0, map: 0, true: 1 } }); for (let i = 0; i < 40 && (i === 0 || g.stats().missing); i++) g.update(v); g.draw(v);
    const tu = f.st.uni['rm-true'], m = view(900); g.update(m); g.draw(m); return { g, pal: Array.from(tu.uTgPal).slice(0, 3), opt: tu.uTgOpt, mapDeep: Array.from(f.st.uni['rm-map'].uMpPal).slice(6, 9) }; };
  const s = await run('seeker-reach'), c = await run('crownlands');
  assert.equal(s.opt[3], 0.45); assert.equal(c.opt[3], 0, 'Crownlands: every texel tinted, as before');
  const kit = 120 / 255; // truePack's loop cells are flat grey 120
  s.mapDeep.forEach((v, i) => assert.ok(Math.abs(v - kit * s.pal[i]) < 1e-5, `MAP deep = the kit loop × TRUE's tint (${s.mapDeep} vs ${s.pal})`));
  assert.ok(s.pal.every((v, i) => v > c.pal[i] - 1e-9), 'the gem realm\'s tint is never darker than the full one');
  s.g.dispose(); c.g.dispose();
});

// Fix pass #6 (critic, Solana Reach "crystal rivers"): the painting's pale icy rivers (158,208,227 at d 30) read dark steel
// (67,135,178) from d 49, ΔE 30.8 — the box-median hand-over metric averaged the rivers away. MAP's inland water was meant to
// start at the painting's river colour at d 48 and ease to the kit loop by d 120 (fix iteration 2 #15), but it started at
// palette.water, which PACK sets to the KIT's water in every pack. It now starts at the painting's WATER colour (paintWater).
test('fix pass #6: MAP rivers start at the painting\'s water colour at the FAR → MAP hand-over and reach the kit loop by d 120', async () => {
  const sea = { first: 0, frames: 8, frameMs: 200, phases: 4 }, pack = opaque(truePack({ sea, inland: sea })), base = pack.pixels;
  pack.meta.palette = { water: '#327fa8' }; // PACK: the kit's water
  // a lake over the west half (fieldsA G < 128), painted pale ice blue in the chart there
  pack.pixels = async k => { const r = await base(k);
    if (k === 'fieldsA.png' || k === 'chart8.webp') { const d = new Uint8Array(r.data); for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width / 2; x++) { const o = (y * r.width + x) * 4; if (k === 'fieldsA.png') d[o + 1] = 100; else d.set([158, 208, 227, 255], o); } return { ...r, data: d }; }
    return r; };
  const f = fakeCore(), g = createGround(f.core); await g.load(pack);
  const inl = d => { const v = view(d); g.update(v); g.draw(v); return Array.from(f.st.uni['rm-map'].uMpPal).slice(15, 18); };
  const paint = [158, 208, 227].map(v => v / 255), kit = [120, 120, 120].map(v => v / 255), pw = [0x32, 0x7f, 0xa8].map(v => v / 255);
  assert.ok(dE(inl(48), paint) < 3, `d 48: the painting's river (${inl(48).map(v => Math.round(v * 255))}), not the kit's ${pw.map(v => Math.round(v * 255))}`);
  assert.ok(dE(inl(130), kit) < 1e-3, 'd 120+: the kit loop TRUE draws');
  const mid = inl(77); assert.ok(dE(mid, paint) > 3 && dE(mid, kit) > 3, 'eased between');
  g.dispose();
});
function clamp01(x, a, b) { return Math.max(a, Math.min(b, x)); }
// truePack's loop cells with opaque texels (GROUND measures the kit loop's mean colour over opaque texels only): flat grey 120
function opaque(pack) { const base = pack.pixels; pack.pixels = async k => { const r = await base(k); if (k === 'ground.png') for (let i = 3; i < r.data.length; i += 4) r.data[i] = 255; return r; }; return pack; }
function dE(a, b) { // CIE76 on 0…1 sRGB
  const lab = c => { const f = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4), [R, G, B] = c.map(f);
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const h = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))]; };
  const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
