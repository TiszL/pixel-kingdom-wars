// Realm-map GROUND lane (docs/REALM-MAP-PLAN.md §2.2–§2.3, §3.2–§3.5, §3.7, §6.2, §7).
// createGround(core) → Ground { load(pack), setBaseState(tex, geomVersion, cpu?), setBases(list),
//   setOccupancy(arr), update(view), draw(view), bindClasses(program, firstUnit) → nextUnit,
//   rehearse(prog, view, rv) → drew (SHELL's band rehearsal, W1 G1), mapReady(view) (W1 G4), passes(view) → { chart, map, true },
//   classState(), ready: { map, true }, stats(), dispose() }
//
// Bands: FAR = the painted chart (chart8 + 512² chart16 pages); MAP = the layered composite over a lattice
// of classes resolved on the GPU (vertices 7 tiles apart, 1024² R8UI pages, 256² sub-tiles, apron 2 +
// two Jacobi legalise passes → tiling is seamless) plus per-art-px overlays; TRUE = the kit's ground from
// per-deed record pages (99² vertex classes → 98² records, LRU of 48). Cross-fades follow camera.bands().
// Everything GL lives in objects core hands out, so create()+load() rebuild cleanly after a context loss.
import { TILES, CLASS, BANDS, FLAG, KIND, DEED_PX, PLOT_CENTRE, LINES, GPU_SAFE, plotRoom, plotOffset } from './contracts.mjs';
import { RM_FIELDS, RM_SHORE, RM_CLASSIFY, CLASSES } from './glsl/classes.glsl.mjs';
import { RESOLVE_VS, RAW_FS, DESPECKLE_FS, LEGALISE_FS, RECORD_FS, PURE_FS } from './glsl/resolve.glsl.mjs';
import { CHART_VS, CHART_FS } from './glsl/chart.glsl.mjs';
import { MAP_VS, MAP_FS } from './glsl/mapground.glsl.mjs';
import { TRUE_VS, TRUE_FS } from './glsl/trueground.glsl.mjs';
import { RM_WATER } from './glsl/water.glsl.mjs';
import { classConfig, prepareLinesSteps, bendRiversSteps, mapBandTable, bandTable, CLASS_RANK, PLOT_GEOM, makeFields, classAt, kitHash, CLASS_CFG, DESPECKLE_PASSES, despeckleMode, plotAt, resolveRegion, plotBridges, mapDespeckleMode, islandReach,
  BAKE, bakeRiverPage, bakeLandPage, packBridge, riverHint, toHalf, clipTarnsSteps, foreignSeaRows } from './classify.mjs';
import { RESOLVE, LATTICE_PASSES, resolveBudget, frameCost, FRAME_BUDGET, FRAME_ITER_BUDGET, planPages, recCapacity } from './groundcost.mjs';
import { pcg2d } from './glsl/common.glsl.mjs';
import { SLICE_MS, taskClock } from './slice.mjs';

const ROOM4 = new Int32Array(24); for (let L = 1; L <= 20; L++) ROOM4[L] = plotRoom(L); // G8 offset room per level
// P0 fix pass #2/#3: the MAP tone grade ends at d TONE_END; its chroma stays within ±TONE_CHROMA per channel of neutral.
// W1 G5 (owner-bar critic: d 49–110 read airbrushed — the painting's smooth low-pass relief and its bright river bands
// under crisp pixel patches): the grade eases out ACROSS the FAR→MAP blend (from d TONE_START, where the map starts to fade
// in over the chart, which carries the painting's relief itself) and is gone by d 80: weight 0.61 at d 40, 0.36 at d 49,
// 0.14 at d 60, 0 from d 80 (P0: 1 to d 48, then 0.71 at d 80, 0.38 at d 110, 0 at d 200). Rule 7: fix iteration 1's critic
// asked for MORE relief over d 48–150 ("flat"); the round-2 owner-bar critic's airbrush finding is newer, was measured on
// today's packs and the owner asked for it (NIGHT 01:30) — it wins. Captures: lane-ground.md W1 G5.
const TONE_START = BANDS.farEnd, TONE_END = 80, TONE_CHROMA = 0.06;
// W1 G5 (the MAP→TRUE hand-over): per realm, how far an obstacle slot's art eases toward the wild ground by d 800, for
// the slots TRUE draws on the wild ground (mapTables clr: Sunscar's forest is sparse palms on sand at TRUE, dense dark
// canopy in its map art — a 35.8 mean/channel jump d 790 → 1120). Measured on the critic's Sunscar view (12.5, 85.5; SwiftShader,
// lane-ground.md W1): the frame mean at d 790 is linear in the share — (130,121,77) at 0, (218,194,128) at 0.98 — and TRUE
// at d 1120 is (186,165,111), so 0.63 leaves |Δ| (1, 2, 2) (measured as a dissolve; the mix has the same mean).
// realm.json map.trueThin overrides it. Crownlands (Δ ≤ 5)
// and Frostveil (Δ ≤ 8) have no jump: 0.
const TRUE_THIN = { sunscar: 0.63 }, THIN_D = [450, 800];
// Stage B (the MAP grade toward the painting, engine-owed.json): the family grade's per-channel range. GA2-05's [0.6, 1.8]
// held the five first realms; the three new realms' MAP art (PACK's option E / D′ recolours) is much darker than their
// paintings, so their grade clamped at 1.8 — the d 48 hand-over (famW 1, CPU slot model with the shader's 0…1 clip, lane-ground
// Stage B) left Elderwood's glade ground ΔE 5.8, Thornwake's jungle floor 10.0 and its rock 10.7, Solana Reach's quartz snow
// 22.4 and lumen groves 21.0. At 2.4 they are 0.0 / 0.0 / 0.0 / 2.4 / 10.9 (the groves are clip-bound: near-white paint).
// The five first realms keep 1.8 (their measured, owner-seen hand-overs). realm.json map.famClamp overrides.
const FAM_CLAMP = { elderwood: [0.6, 2.4], thornwake: [0.6, 2.4], 'seeker-reach': [0.6, 2.4] }, FAM_CLAMP0 = [0.6, 1.8];
// Stage B, Solana Reach's gem sea at MAP (rm-water rmGem): the share of ≥ 1-device-px cells lit by a gem sparkle. 0.03 ≈ the
// kit loop's own gem density per screen area where TRUE takes over (3 lozenges per 32² tile, a tile ≈ 11 device px at
// d 1100, cells ≈ 1–2.5 device px), so the MAP→TRUE fade keeps the same sparkle; it grows in over d 48 → 150 (the painting
// at FAR has none). realm.json map.waterGems (a share, 0 = off) overrides; every other realm: off.
const WATER_GEMS = { 'seeker-reach': 0.03 }, GEM_D = [48, 150];
// D3 (fix pass): GROUND's textures shared with the minimap (core.tex.shared keys `<id>:chart8`, `:deeds`, `:minifar`)
const SHARED_T = new Set(['chart8', 'deeds', 'far']);
// Fix pass #5 (critic: Solana's TRUE sea read navy with faint lavender specks, body (18,56,126) vs the kit's (45,124,166),
// ΔE 37.3; bright share 0.012 at d 1400): TRUE's depth tint eases off loop texels above this luma (smoothstep over +0.15), so
// the gem highlights (luma 0.84–0.94) keep their colour; the body (0.41) is tinted as before. CPU model (scratch fp/seamodel2:
// a 16 × 16-tile loop mosaic, box-resampled to d 1400's 0.45 px per art px, crop.mjs's metric): bright share 0.020 with the
// old tint, 0.037 with deepTint's third, 0.047 with this too (the luma test runs on the sampled colour, as the shader does;
// a 0.5 start gave 0.043). A model, not a render: the SwiftShader check is in lane-ground.md "Fix pass".
const GEM_HL = 0.45;
const LAT_PAGE = 1024, SUB = RESOLVE.sub, APRON = RESOLVE.apron, C16_PAGE = 512, C16_LRU = 16; // APRON: MAP despeckle ×2 + legalise ×2 + purity (W1)
// P0 fix pass #6: the TRUE record cache holds what the largest view of this screen wants at d 600 (groundcost.js recCapacity:
// 48 on the owner's 1280×800 retina, 96 on a 2560×1440 one); a bigger window later falls back nearest-first (planPages)
const recCap = () => { const g = globalThis, dpr = g.devicePixelRatio || 1, w = (g.screen?.width ?? 0) * dpr, h = (g.screen?.height ?? 0) * dpr;
  return recCapacity(Math.max(w, 1), Math.max(h, 1), BANDS.pageResolve); };
const q = new URLSearchParams(globalThis.location?.search ?? '');
// W1 G3: GROUND's main-thread work runs in slices of ≤ SLICE_MS (load passes, atlas uploads, chart16 pages)
// (stage B D1: SLICE_MS and the yields are the page's ONE task clock, slice.js — shared with LIFE, BASES and SHELL's loadModules)
const yieldTask = taskClock.yieldTask;
// a w × h rect of decoded RGBA pixels (loader pixels(): exact for PNG) as a typed array for core.tex.layer
function crop(img, x, y, w, h) {
  const out = new Uint8Array(w * h * 4), W = img.width, d = img.data;
  for (let j = 0; j < h; j++) out.set(d.subarray(((y + j) * W + x) * 4, ((y + j) * W + x + w) * 4), j * w * 4);
  return { data: out, w, h };
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** Stage B: the gem-sea share of this realm (realm.json map.waterGems, else WATER_GEMS, else 0 = off). */
export function waterGems(meta) {
  const o = meta?.map?.waterGems;
  return Number.isFinite(o) && o >= 0 && o <= 0.2 ? o : WATER_GEMS[meta?.id] ?? 0;
}
/** Stage B: the MAP gem drift in map art px per second from the kit loop (drift = kit px a frame; 7 kit px per map art px). */
export const gemDrift = w => (w?.drift?.length === 2 && w.frameMs > 0 ? w.drift.map(v => (v * 1000) / w.frameMs / 7) : [0, 0]);
/** Stage B: rm-water rmGem's JS twin (QA and tests): the gem at cell (x, y) of the dq-coarsened grid at clock ms → 0, 1, 2. */
export function gemAt(x, y, dq, g, ms) {
  if (!(g[3] >= 0.5) || !(g[0] > 0)) return 0;
  const sh = [g[1], g[2]].map(v => { const f = Math.floor((Math.fround(v) * (ms * 0.001)) / dq); return f - 65536 * Math.floor(f / 65536); });
  const h = pcg2d((((x - sh[0]) & 0xffff) ^ 0x6e57) >>> 0, (((y - sh[1]) & 0xffff) ^ 0x2a1b) >>> 0);
  return (h[0] >>> 8) / 16777216 < g[0] ? 1 + (h[1] & 1) : 0;
}
/** Stage B: the two gem colours of a water loop frame (RGBA pixels of its 32² cell): its highlight texels (luma 30 over the
 *  frame's mean), split warm (r > g: the violet / pink shards) and cool (the cyan / white ones) → [[r,g,b] 0…1, …] or null. */
export function gemColours(px, W, ox, oy, cell = 32) {
  const lum = o => 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]; let m = 0, n = 0;
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) { const o = ((oy + y) * W + ox + x) * 4; if (px[o + 3] < 128) continue; m += lum(o); n++; }
  if (!n) return null; m /= n;
  const grp = [[0, 0, 0, 0], [0, 0, 0, 0]];
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) { const o = ((oy + y) * W + ox + x) * 4; if (px[o + 3] < 128 || lum(o) <= m + 30) continue;
    const q = grp[px[o] > px[o + 1] ? 0 : 1]; q[0] += px[o]; q[1] += px[o + 1]; q[2] += px[o + 2]; q[3]++; }
  const mean = q => q.slice(0, 3).map(v => v / q[3] / 255), got = grp.filter(q => q[3] > 0).map(mean);
  return got.length ? [got[0], got[got.length - 1]] : null;
}
/** Stage B: the family grade's per-channel range for this realm (realm.json map.famClamp, else FAM_CLAMP, else GA2-05's). */
export function famClamp(meta) {
  const o = meta?.map?.famClamp;
  if (Array.isArray(o) && o.length === 2 && o.every(Number.isFinite) && o[0] > 0 && o[0] < 1 && o[1] > 1 && o[1] <= 4) return [o[0], o[1]];
  return FAM_CLAMP[meta?.id] ?? FAM_CLAMP0;
}
/** Stage B: frames between the TRUE water loop's open-water phases (the record's 2-bit phase × this): the pack's
 *  waterByClass.<cls>.phaseStep (Solana Reach's 16-frame gem loop: 4), else floor(frames / phases) (the 8-frame loops: 2).
 *  A step that keeps the 4 phases a quarter-loop apart gives each its own gem rows under the kit's 2-D drift. */
export function waterPhaseStep(w) {
  const f = Math.max(1, w?.frames | 0 || 8), ph = Math.max(1, w?.phases | 0 || 4), s = Number.isInteger(w?.phaseStep) && w.phaseStep > 0 ? w.phaseStep : Math.floor(f / ph);
  return clamp(s, 1, f);
}
/** RM-23 (fix pass): classes.glsl mapClassAt's JS twin (rmLatTexel + rmLatClass): tile vertex (x, y) → CLASS. `read(lx, ly)`
 *  is the lattice texel (class + 1, flags << 4, clearing bit 7; 0 = unresolved) of a W × H lattice (0 × 0 before it
 *  exists). Outside the grid the open sea (DEEP), never the unresolved WILD that seated LIFE's scrub in the sea. */
export function latClassAt(read, W, H, x, y) {
  const lx = Math.floor(x / 7 + 0.5), ly = Math.floor(y / 7 + 0.5);
  const r = lx < 0 || ly < 0 || lx >= W || ly >= H ? (W > 0 ? 1 : 0) : read(lx, ly), c = r & 15;
  return c === 0 ? CLASS.WILD : r & 128 ? CLASS.RING : c - 1;
}
/** Fix pass #5: TRUE's deep-water tint (× the loop, by depth step) from the painting's DEEP colour. A gem-sea realm (Solana
 *  Reach) takes a third of it — its deepest water gets one step of the old tint, the kit teal stays teal, not navy — and
 *  MAP's kit-water ends use the same tint, so the MAP → TRUE hand-over does not jump. */
export function deepTint(deep, meta) {
  const t = deep.map(v => clamp(v * 1.6, 0.4, 1));
  return waterGems(meta) > 0 ? t.map(v => 1 + (v - 1) / 3) : t;
}
/** Fix pass #5: the luma above which TRUE's depth tint eases off a loop texel (its gem highlights stay white, pink and cyan;
 *  the body's luma is ~0.41), over +0.15 (trueground.glsl). 0 = the tint covers every texel (every realm without a gem sea). */
export const gemHighlight = meta => (waterGems(meta) > 0 ? GEM_HL : 0);
const hex = s => { const n = parseInt(String(s).replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

// Per-realm plot styles until PACK's realm.json.plotStyle lands (§6.2: hedge, snow hedge, reed ochre,
// basalt, dyke grey). [edge, edge dark, edge light]
const PLOT_STYLE = {
  crownlands: ['#4f7a34', '#24401c', '#86ab55'], frostveil: ['#dfe9ee', '#6f8591', '#ffffff'],
  sunscar: ['#c29a5b', '#6e4f2a', '#e3c38a'], cinderfall: ['#3a3438', '#141015', '#6c5f63'], stormcairn: ['#8c8f86', '#4a4c47', '#b8bab0'],
};
// wall5 tier colours for the MAP wall-tier line (plan §6.2; decor.json replaces them when BASES ships it)
const WALL_TIER = [[0.45, 0.32, 0.2, 0], [0.87, 0.81, 0.66, 0], [0.87, 0.81, 0.66, 0], [0.87, 0.81, 0.66, 0], [0.88, 0.83, 0.7, 1]];

// W1 G2: rm-map's noise slots (mapground.glsl.js uMpNz: period, seed as int32 bits, group) — the same period and seed each
// of P0's call sites passed (classify.js CLASS_CFG / the realm's classes config via setClassifyUniforms, and the shader's
// own constants), so the shared loop draws the same ground. Groups: 1 class-edge warp, 2 shore, 4 water, 8 islet,
// 16 plot, 32 claim, 64 foreign fade
export function mapNoiseTable(c) {
  const lw = c.lakeWarp, I = CLASS_CFG.island, br = c.bridge, cl = c.clearing, ap = c.apron, u = (x, k = 0) => ((x >>> 0) + k) | 0;
  const S = [[14, 0x7a13, 1], [14, 0x19c5, 1], [5, 0x4e2b, 1], [5, 0x6d07, 1], [11, 0x61b3, 1], [5, 0x2f71, 1],                // 0–5 warp, edge
    [lw?.period ?? 1, u(lw?.seed ?? 0, 0), 2], [lw?.period ?? 1, u(lw?.seed ?? 0, 1), 2],                                    // 6–9 rmLakeWarp
    [lw?.period2 ?? 1, u(lw?.seed ?? 0, 2), 2], [lw?.period2 ?? 1, u(lw?.seed ?? 0, 3), 2],
    [c.coastNoise.period, u(c.coastNoise.seed), 2], [c.coastNoise2.period, u(c.coastNoise2.seed), 2],                         // 10, 11 coast
    [c.inlandNoise.period, u(c.inlandNoise.seed), 4], [c.beachNoise.period, u(c.beachNoise.seed), 4],                         // 12 inland, 13 beach
    [I.period, u(I.seed, 0), 8], [I.period2, u(I.seed, 1), 8], [Math.trunc(I.shallowPeriod), u(I.seed, 3), 8],               // 14–16 islet
    [br.wobPeriod, u(br.seed), 16], [cl.period, u(cl.seed), 16], [ap.period, u(ap.seed), 16],                                 // 17 bridge, 18 clearing, 19 apron
    [5, 0x6e21, 32],                                                                                                         // 20 claim fray
    [48, 0x6f13, 64], [20, 0x1d27, 64], [7, 0x4f1d, 64], [3, 0x2a77, 64],                                                    // 21–24 foreign (at p × 4)
    [2, 0x5d19, 1], [I.zigCell, u(I.seed, 2), 8], [cl.period2, u(cl.seed2), 16]];                                            // 25–27 zig-zag
  const t = new Int32Array(28 * 4); S.forEach((e, k) => t.set([Math.max(1, e[0] | 0), e[1] | 0, e[2], 0], k * 4));
  return t;
}

export function createGround(core) {
  const gl = core.gl;
  core.include('rm-fields', RM_FIELDS); core.include('rm-shore', RM_SHORE); core.include('rm-classify', RM_CLASSIFY);
  core.include('rm-water', RM_WATER); core.include('classes', CLASSES);
  const ready = { map: false, true: false };
  let P = null, meta = null, cols = 0, rows = 0, cfg = null, disposed = false;
  let prog = {}, T = {}, lat = null, trueSt = null, c16 = null, pal = null, mapT = null, trueT = null;
  let baseCpu = null, baseExt = null, geomVersion = -1, occ = null;
  const st = { latticeResolved: 0, latticeSubTiles: 0, pagesResolved: 0, resolveMsLast: 0, collapsedLattice: null, lastBand: null };
  const dummies = {};

  // ---- programs --------------------------------------------------------------------------------------------
  function programs() {
    const rd = {}; if (q.get('gdbg') === 'rawinland') rd.RM_DBG_RAWINLAND = true; if (q.get('gdbg') === 'rawriver') rd.RM_DBG_RAWRIVER = true;
    prog.raw = core.program('rm-raw', { vs: RESOLVE_VS, fs: RAW_FS, defines: rd });
    prog.leg = core.program('rm-legalise', { vs: RESOLVE_VS, fs: LEGALISE_FS });
    prog.dsp = core.program('rm-despeckle', { vs: RESOLVE_VS, fs: DESPECKLE_FS });
    prog.rec = core.program('rm-record', { vs: RESOLVE_VS, fs: RECORD_FS });
    prog.pure = core.program('rm-pure', { vs: RESOLVE_VS, fs: PURE_FS }); // W1 G2: the lattice purity bit (rm-map reads 4 corners, not 16)
    prog.chart = core.program('rm-chart', { vs: CHART_VS, fs: CHART_FS });
    const gd = {}; for (const k of (q.get('gdbg') || '').split(',').filter(Boolean)) gd['RM_DBG_' + k.toUpperCase()] = true; // profiling switches
    if (meta?.id === 'cinderfall') gd.RM_LAVA = true; // P0 fix pass #1: the lava branch compiles only where uMpGrade.w sets it
    prog.map = core.program('rm-map', { vs: MAP_VS, fs: MAP_FS, defines: gd });
    prog.true = core.program('rm-true', { vs: TRUE_VS, fs: TRUE_FS });
  }
  function dummy(kind) { // 1×1 textures for sampler slots a program declares but a band does not use
    if (dummies[kind]) return dummies[kind];
    const z = { u2: () => core.tex.data(1, 1, 'R8UI', null, null, new Uint8Array(1)), f2: () => core.tex.data(1, 1, 'RGBA8', null, null, new Uint8Array(4)),
      uA: () => { const a = core.tex.array(1, 1, 1, 'R8UI'); return a; }, fA: () => core.tex.array(1, 1, 1, 'RGBA8'),
      u16A: () => core.tex.array(1, 1, 1, 'RGBA16UI'), u16: () => core.tex.data(1, 1, 'R16UI', null, null, new Uint16Array(1)),
      rgba8ui: () => core.tex.data(1, 1, 'RGBA8UI', null, null, new Uint8Array(4)), f32: () => core.tex.data(1, 1, 'RGBA32F', null, null, new Float32Array(4), { filter: 'nearest' }),
      u32: () => core.tex.data(1, 1, 'R32UI', null, null, new Uint32Array(1)) };
    return (dummies[kind] = z[kind]());
  }

  // ---- uniforms shared by every program that includes rm-fields / rm-classify ---------------------------
  function setFieldUniforms(p) {
    const u = n => p.u(n);
    const plot = new Float32Array(21 * 4);
    for (let L = 1; L <= 20; L++) { const g = PLOT_GEOM[L]; plot.set([g.claim, g.ring, g.half, g.R], L * 4); }
    gl.uniform4fv(u('uRmPlot'), plot);
    gl.uniform4iv(u('uRmRoom4'), ROOM4);
    gl.uniform4i(u('uRmGrid'), cols, rows, 0, st.bridges > 0 ? 1 : 0);
    gl.uniform4i(u('uRmLinesGeo'), T.lt?.PR ?? 1, T.lt?.R0 ?? 0, T.lt?.W ?? 1, 0); // P0: the baked line fields
    gl.uniform4f(u('uRmBake'), BAKE.cap, BAKE.ampCap, 0, 0);
    gl.uniform4f(u('uRmFieldsPpd'), 8, 4, 0, 0);
  }
  function setClassifyUniforms(p, fine = 1) { // fine 0: the MAP lattice resolve (G11: the class warp's coarse octave only)
    const u = n => p.u(n), c = cfg;
    gl.uniform4f(u('uRmCfgA'), c.coastK, c.inlandK, c.force, 0);
    const cl = c.clearing, ap = c.apron, w = c.classWarp, lw = c.lakeWarp, br = c.bridge; // G11–G15
    gl.uniform4f(u('uRmRing'), cl.extra, cl.corner, cl.amp, cl.amp2); gl.uniform4i(u('uRmRingP'), cl.period, cl.period2, cl.seed, cl.seed2);
    gl.uniform4f(u('uRmRing2'), cl.lobe, ap.min, ap.amp, ap.feather); gl.uniform4i(u('uRmApronP'), ap.period, ap.seed, 0, 0);
    { const rg = cfg.claimRag; gl.uniform4f(u('uRmRag'), rg?.amp ?? 0, rg?.period ?? 5, rg?.seed ?? 0, 0); }
    gl.uniform4f(u('uRmWarp'), w ? w.amp : 0, w ? w.amp2 : 0, w ? w.amp3 : 0, fine); gl.uniform4i(u('uRmWarpP'), w?.period ?? 1, w?.period2 ?? 1, w?.cell3 ?? 1, w?.seed ?? 0); gl.uniform4f(u('uRmWarpZ'), w?.zig ?? 0, w?.zigCell ?? 1, 0, 0);
    gl.uniform4f(u('uRmLakeW'), lw ? lw.amp : 0, lw ? lw.amp2 : 0, 0, 0); gl.uniform4i(u('uRmLakeWP'), lw?.period ?? 1, lw?.period2 ?? 1, lw?.seed ?? 0, 0);
    gl.uniform4f(u('uRmBridge'), br.k, br.wob, br.taper, 0); gl.uniform4i(u('uRmBridgeP'), br.wobPeriod, br.seed, 0, 0);
    gl.uniform4f(u('uRmCfgB'), c.deepT, c.beachW, c.hasShore ? 1 : 0, c.rockT);
    gl.uniform4f(u('uRmCfgC'), Number.isFinite(c.slopeT) ? c.slopeT : -1, c.slopeStep, c.snowT, c.fieldT);
    gl.uniform4f(u('uRmCfgD'), c.forestT, c.specialT, c.g2T, c.riverNoiseReach);
    gl.uniform4f(u('uRmCfgE'), c.rockWaterGap, c.rockPlotGap, c.roadInland, c.roadCoast);
    gl.uniform4f(u('uRmNoiseAmp'), c.coastNoise.amp, c.inlandNoise.amp, c.beachNoise.amp, c.coastNoise2.amp);
    gl.uniform4i(u('uRmCoast2'), c.coastNoise2.period, c.coastNoise2.seed, 0, 0);
    gl.uniform4i(u('uRmNoisePer'), c.coastNoise.period, c.inlandNoise.period, c.beachNoise.period, c.parcel.block);
    gl.uniform4ui(u('uRmNoiseSeed'), c.coastNoise.seed >>> 0, c.inlandNoise.seed >>> 0, c.beachNoise.seed >>> 0, c.parcel.salt >>> 0);
    gl.uniform4i(u('uRmParcel'), c.parcel.min, c.parcel.max, 0, 0);
    gl.uniform4f(u('uRmLines'), LINES.riverHwMin, LINES.trackHwMin, LINES.riverNoiseK, LINES.lensMargin);
    const I = CLASS_CFG.island; // G16 the island (global constants, classify.js islandSdf)
    gl.uniform4f(u('uRmIsle'), I.base, I.corner, I.lobe, I.slope); gl.uniform4f(u('uRmIsle2'), I.amp, I.amp2, I.zig, I.shallow);
    gl.uniform4i(u('uRmIsleP'), I.period, I.period2, I.zigCell, I.seed); gl.uniform4f(u('uRmIsle3'), I.k, I.shallowPeriod, islandReach(I), 0);
    gl.uniform4f(u('uRmIsle4'), I.halo, I.haloFade, I.haloDeep, 0); // P0 fix pass #4: the shallows halo ends inside the window
  }
  // band table → the legalise program's integer tables
  function legaliseTables(table) {
    const ids = [], idx = t => { if (t === null || t === undefined) return 15; let i = ids.indexOf(t); if (i < 0) { ids.push(t); i = ids.length - 1; } return Math.min(i, 14); };
    const terr = table.terrainOf.map(idx), legal = new Int32Array(16);
    for (let a = 0; a < ids.length; a++) for (let b = 0; b < ids.length; b++) if (table.legal(ids[a], ids[b])) legal[a] |= 1 << b;
    legal[15] = 0xffff; for (let a = 0; a < 16; a++) legal[a] |= 1 << 15;
    return { ids, terr: Int32Array.from(terr), legal, fallback: Int32Array.from(table.fallback), rank: Int32Array.from(CLASS_RANK) };
  }
  function setLegalise(t, plusOne, shift) {
    const p = prog.leg; p.use();
    gl.uniform1iv(p.u('uLgTerr'), t.terr); gl.uniform1iv(p.u('uLgLegal'), t.legal);
    gl.uniform1iv(p.u('uLgFallback'), t.fallback); gl.uniform1iv(p.u('uLgRank'), t.rank);
    gl.uniform2i(p.u('uLgShift'), shift[0], shift[1]); gl.uniform1i(p.u('uLgPlusOne'), plusOne ? 1 : 0);
  }
  function bindFieldTextures(p, first) { // rm-fields + rm-classify samplers
    p.tex('uRmBase', first, baseTex()).tex('uRmFieldsA', first + 1, T.fieldsA).tex('uRmLineTex', first + 2, T.lt.tex);
    return first + 3;
  }
  const baseTex = () => baseExt ?? T.base;

  // ---- loading ---------------------------------------------------------------------------------------------
  async function load(pack) {
    P = pack; meta = pack.meta; ({ cols, rows } = meta.grid);
    cfg = classConfig(meta.classes ?? {}); T.nz = mapNoiseTable(cfg);
    programs(); rhTextures(); // (W1 G1: the rehearsal's own tiny textures, made here so rehearse() never uploads)
    // first frame: chart8 + deeds
    // (D3, fix pass: chart8, the deeds and the far field are the minimap's textures too — the same keys, options and bytes as
    // minimap.js — so one upload each, whichever module loads first; core.tex.freeAll frees them, GROUND's dispose() does not)
    T.chart8 = core.tex.shared(`${pack.id}:chart8`, () => core.tex.image(pack.first.chart8, { mips: true, filter: 'linear' }));
    T.deeds = core.tex.shared(`${pack.id}:deeds`, () => core.tex.data(cols, rows, 'R8UI', null, null, pack.first.deeds));
    baseCpu = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) baseCpu[i * 4] = pack.first.deeds[i] === DEED_PX.thisRealm ? KIND.open : pack.first.deeds[i] === DEED_PX.otherRealm ? KIND.otherRealm : KIND.none;
    T.base = core.tex.data(cols, rows, 'RGBA8UI', null, null, baseCpu);
    T.farD = farField(pack.first.deeds);
    T.far = core.tex.shared(`${pack.id}:minifar`, () => core.tex.data(cols, rows, 'R8', null, null, Uint8Array.from(T.farD, v => Math.min(255, Math.round(v * 16))), { filter: 'linear' }));
    setupChart16();
    // MAP data
    try {
      const [fb, lines] = await Promise.all([pack.bitmap('fieldsBC.png'), pack.json('lines.json').catch(() => ({}))]);
      if (disposed) return;
      T.fieldsBC = core.tex.image(fb, { filter: 'nearest' });
      // G14: rivers meandered here (the GPU reads the same segments); Stage B: in ≤ SLICE_MS slices (22–68 ms in one task on
      // the W1 QA host)
      { const r = await sliced(prepareLinesSteps(lines, { cols, rows }, cfg)); if (!r) return; T.lines = r.value; }
      // P0: what the line-data bounds trimmed (classify.js LINE_CAP; 0 on every real pack, loud when not)
      st.lineData = { badPoints: T.lines.bad, riverSegsDropped: T.lines.rivers.dropped, trackSegsDropped: T.lines.tracks.dropped };
      T.rivers = T.lines.rivers;                            // G16: bent round the plots of the current base state (updateBends)
      const [pa, pb] = await Promise.all([pack.pixels('fieldsA.png'), pack.pixels('fieldsBC.png')]);
      // GA2-04: land painted far from the realm is sea for every class, lattice and TRUE page (classify.js foreignSeaRows);
      // P0 fix pass #5: both load passes run in ≤ SLICE_MS slices (one task was ~1 s on the efficiency cores)
      // (W1 G3: a pack that bakes these passes into fieldsA.png says so in realm.json fieldsA.baked — GROUND's request to PACK)
      // (Stage B: read where realm.json describes fieldsA, fields.fieldsA.baked, as well as the top-level fieldsA.baked of the
      // W1 G3 request, so either placement PACK picks is honoured)
      const baked = new Set(meta.fields?.fieldsA?.baked ?? meta.fieldsA?.baked ?? []);
      if (baked.has('foreignSea')) st.foreignSea = { baked: true };
      else { const t0 = performance.now(), r = await sliced(foreignSeaRows(pa, T.farD, cols, rows)); if (!r) return; st.foreignSea = { ...r.value, ms: Math.round(performance.now() - t0) }; }
      // fix iteration 2 #3: painted mountain shadows in PACK's lake channel are not tarns (Stormcairn's blue blobs)
      if (baked.has('clipTarns')) st.tarns = { baked: true };
      else try { const t0 = performance.now(), r = await sliced(clipTarnsSteps(pa, await pack.pixels(meta.chart8?.file ?? 'chart8.webp'))); if (!r) return; st.tarns = { ...r.value, ms: Math.round(performance.now() - t0) }; }
      catch (e) { st.tarns = { error: String(e.message || e) }; }
      T.fieldsA = core.tex.data(pa.width, pa.height, 'RGBA8', null, null, new Uint8Array(pa.data.buffer, pa.data.byteOffset, pa.data.byteLength), { filter: 'nearest' });
      // ImageData keeps width/height/data on its prototype: a spread would drop them (NaN fields)
      const img = x => ({ width: x.width, height: x.height, data: x.data, channels: 4 });
      T.cpuFields = makeFields({ fieldsA: img(pa), fieldsBC: img(pb) });
      T.bridges = new Float32Array(cols * rows * 4); st.bridges = 0; // G15 (no bases yet → none)
      // P0: river + land pages (no shader walks a segment list), baked in slices; a base state that arrived meanwhile
      // bends the rivers / builds the bridges now (updateBends / queueBridges wait for the pages; P0 fix pass #8: sliced)
      if (!(await linesBuildAsync())) return;
      updateBends(); queueBridges(null); await reQ.running; if (disposed) return;
      mapT = mapTables();
      pal = await palette(pack);
      await mapAtlas(pack); if (disposed) return;
      // P0 fix pass #1–#3: the painting grade is PACK's baked tone map again (one fetch; the per-pixel chart16 grade of fix
      // iteration 2 #2 mottled d 150–400 and was rm-map's heaviest compile), chroma-clamped in the shader, gone by d 200
      if (meta.tone?.file) T.tone = core.tex.image(await pack.bitmap(meta.tone.file), { filter: 'linear' });
      if (meta.plots?.file && meta.plots.yards?.length) {
        T.plots = core.tex.image(await pack.bitmap(meta.plots.file), { filter: 'linear' });
        T.yard = new Float32Array(21 * 4); T.yardT = new Float32Array(21 * 4);
        for (const y of meta.plots.yards) if (y.level >= 1 && y.level <= 20) { T.yard.set([y.x, y.y, y.w, y.h], y.level * 4); T.yardT.set([y.tile0[0], y.tile0[1], y.tiles, 1], y.level * 4); }
      }
      latticeSetup();
      ready.map = true;
    } catch (e) { st.mapErr = String(e.message || e); console.error('realm ground: MAP data', e); globalThis.document && (document.body.dataset.rmGroundErr = String(e.stack || e)); }
    // TRUE data (optional until PACK's realm.json.true lands)
    try { if (meta.true?.atlas) { await trueSetup(pack); ready.true = true; } } catch (e) { st.trueErr = String(e.message || e); console.error('realm ground: TRUE data', e); globalThis.document && (document.body.dataset.rmGroundTrueErr = String(e.stack || e)); }
    core.invalidate();
  }

  // GA2-04: distance (deeds) from this realm's deeds, ×16 in an R8 texture (linear): land painted beyond ~4 deeds of the
  // realm (neighbour realms, the chart frame) fades into the open sea at FAR and MAP alike, so no frame or cut block shows
  function farField(deeds) {
    const D = new Float32Array(cols * rows).fill(1e9), S2 = Math.SQRT2;
    for (let i = 0; i < cols * rows; i++) if (deeds[i] === DEED_PX.thisRealm) D[i] = 0;
    const relax = (x, y, dx, dy, w) => { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= cols || Y >= rows) return; const v = D[Y * cols + X] + w; if (v < D[y * cols + x]) D[y * cols + x] = v; };
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { relax(x, y, -1, 0, 1); relax(x, y, 0, -1, 1); relax(x, y, -1, -1, S2); relax(x, y, 1, -1, S2); }
    for (let y = rows - 1; y >= 0; y--) for (let x = cols - 1; x >= 0; x--) { relax(x, y, 1, 0, 1); relax(x, y, 0, 1, 1); relax(x, y, 1, 1, S2); relax(x, y, -1, 1, S2); }
    return D;
  }
  // ---- P0 (RM-GPU-1): the line fields ---------------------------------------------------------------------------
  // The real-GPU hang: the shaders walked a deed's river segment list (≤ 50 segments) per MAP pixel, per lattice / page
  // vertex and per LIFE vertex. Now classify.js bakes the fields (BAKE: river sdf + noise cap, track sdf + bridge force)
  // into 99² pages of packHalf2x16 words, and the shaders sample them. One R32UI texture, W wide: the pages (PR per
  // row) above two header words per deed (river page + 1 | downstream hint; land page + 1). No CPU mirror of the pages
  // (100–300 river deeds per realm = 4–11 MB): each page is uploaded as it is baked. The first bake runs in slices of
  // ≤ SLICE_MS so entering a realm never blocks the main thread; a base-state change re-bakes only the pages whose
  // rivers (updateBends) or bridges (queueBridges) moved — in slices too (P0 fix pass #8).
  const PN = BAKE.size;
  // run a generator on the main thread in ≤ SLICE_MS slices (D-167: no stall > 50 ms) → { value } (its return value), or
  // null when the ground was disposed meanwhile (the generator is closed: its finally blocks free what it held).
  // W1 G3: 8 ms a slice on desktop, 4 ms under a coarse pointer (phones); a slice yields through a message-channel task
  // (setTimeout(0) is clamped to ≥ 4 ms after 5 nested calls: a third of the load's wall time went idle)
  async function sliced(job) {
    for (;;) { // (stage B D1: the shared task clock, checked before EVERY step — a job started in a spent task yields at once)
      if (taskClock.spent()) { await yieldTask(); st.slices = (st.slices ?? 0) + 1; if (disposed) { job.return(); return null; } }
      const r = job.next(); if (r.done) return { value: r.value };
      if (disposed) { job.return(); return null; }
    }
  }
  const landNeeded = k => !!T.lines.tracks.cells.get(k), ZERO = new Float64Array(PN * PN);
  // the pages to bake, in order, into a fresh texture; the caller drives it (sync, or sliced by linesBuildAsync)
  function* linesJob() {
    const t0 = performance.now(), maxW = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096, W = Math.min(4096, maxW), PR = Math.floor(W / PN);
    const riverPage = new Int32Array(cols * rows).fill(-1), landPage = new Int32Array(cols * rows).fill(-1);
    const rv = [...T.rivers.cells.keys()], ld = [];
    for (let k = 0; k < cols * rows; k++) if (landNeeded(k)) ld.push(k);
    const need = rv.length + ld.length, cap = need + Math.max(16, Math.ceil(need * 0.25));
    const R0 = Math.ceil(cap / PR) * PN, H = R0 + Math.ceil(cols * rows * 3 / W);
    if (H > maxW) throw new Error(`realm ground: line fields need ${W}×${H} (max ${maxW})`);
    const L = { W, PR, R0, H, cap, hdr: new Uint32Array((H - R0) * W), riverPage, landPage, free: [], tex: core.tex.data(W, H, 'R32UI', null, null, null), bakeMs: 0, rebakes: 0 };
    let next = 0, done = false;
    try {
      for (const k of rv) { riverPage[k] = next++; bakeRiver(L, k); yield; }
      for (const k of ld) { landPage[k] = next++; bakeLand(L, k); yield; }
      done = true;
    } finally { if (!done) core.tex.free(L.tex); } // abandoned (disposed mid-bake): free the half-filled texture
    for (let i = cap - 1; i >= next; i--) L.free.push(i);
    writeHeaders(L, null); headersUpload(L);
    if (T.lt?.tex) core.tex.free(T.lt.tex);
    T.lt = L; L.bakeMs = Math.round(performance.now() - t0);
    st.lines = { riverPages: rv.length, landPages: ld.length, capacity: cap, texture: `${W}×${H}`, mb: +(W * H * 4 / 1048576).toFixed(1), bakeMs: L.bakeMs, rebakes: 0 };
  }
  async function linesBuildAsync() { return !!(await sliced(linesJob())); }
  function pageUpload(L, pg, a, b) {
    const sub = new Uint32Array(PN * PN);
    for (let i = 0; i < PN * PN; i++) sub[i] = (toHalf(a[i]) | (toHalf(b[i]) << 16)) >>> 0;
    core.tex.update(L.tex, sub, { x: (pg % L.PR) * PN, y: Math.floor(pg / L.PR) * PN, w: PN, h: PN });
  }
  function bakeRiver(L, k) { const r = bakeRiverPage(T.rivers, k % cols, Math.floor(k / cols), cfg); pageUpload(L, L.riverPage[k], r.sdf, r.amp); }
  function bakeLand(L, k) {
    const r = bakeLandPage(T.lines.tracks, k % cols, Math.floor(k / cols), cfg);
    pageUpload(L, L.landPage[k], r.track, ZERO);
  }
  function writeHeaders(L, keys) {
    for (const k of keys ?? Array.from({ length: cols * rows }, (_, i) => i)) {
      const h = riverHint(T.rivers, k), hx = (Math.round(h[0] * 127) + 128) & 255, hy = (Math.round(h[1] * 127) + 128) & 255;
      L.hdr[k * 3] = L.riverPage[k] >= 0 ? ((L.riverPage[k] + 1) | (hx << 16) | (hy << 24)) >>> 0 : 0;
      L.hdr[k * 3 + 1] = L.landPage[k] >= 0 ? L.landPage[k] + 1 : 0;
      const b = T.bridges, o = k * 4; L.hdr[k * 3 + 2] = b ? packBridge(b[o], b[o + 1], b[o + 2], b[o + 3]) : 0; // G15 (P0: one word)
    }
  }
  function headersUpload(L) { core.tex.update(L.tex, L.hdr, { x: 0, y: L.R0, w: L.W, h: L.H - L.R0 }); }
  // the header rows holding `keys`' words only (a deed's 3 words may straddle a row): 16 KB a row, not the whole block
  function headerRowsUpload(L, keys) {
    const rowsOf = new Set(); for (const k of keys) { rowsOf.add(Math.floor(k * 3 / L.W)); rowsOf.add(Math.floor((k * 3 + 2) / L.W)); }
    for (const r of rowsOf) core.tex.update(L.tex, L.hdr.subarray(r * L.W, (r + 1) * L.W), { x: 0, y: L.R0 + r, w: L.W, h: 1 });
  }
  // P0 fix pass #8: re-bake the pages of `touch` (deed keys) of one kind, one page per step (≤ 6 ms each), so a base-state
  // push runs in ≤ SLICE_MS slices. Each page replaces its old one in place in ONE upload, and its header word follows it,
  // so the GPU samples the old page until the new one is whole; then `landed(k)` re-resolves the deeds reading it.
  // → false when the texture is full (the caller rebuilds it, sliced), 'stale' when it was replaced meanwhile
  function* rebakeJob(touch, pages, needs, bake, landed) {
    const L = T.lt;
    for (const k of touch) {
      if (T.lt !== L) return 'stale';
      const need = needs(k);
      if (need && pages[k] < 0) { const pg = L.free.pop(); if (pg === undefined) return false; pages[k] = pg; }
      if (!need && pages[k] >= 0) { L.free.push(pages[k]); pages[k] = -1; }
      if (need) { bake(L, k); L.rebakes++; }
      writeHeaders(L, [k]); headerRowsUpload(L, [k]); st.lines.rebakes = L.rebakes; landed(k);
      yield;
    }
    return true;
  }
  // P0 fix pass #8: the base-state work queue — land bridges (CPU, per deed) and river pages (updateBends) — drained in
  // ≤ SLICE_MS slices. A deed re-resolves when the data it reads has landed: its bridge header word, its re-baked river page.
  // A full page texture is rebuilt in slices (linesJob) while the old one keeps drawing. load() awaits it (same palette).
  // Stage B: the river bend (G16, bendRiversSteps) is queued work too (`bend`), drained first: the bridges and river pages
  // it moves are queued when it lands, and bridges queued with it wait for it (they read the bent rivers)
  const reQ = { bend: false, bridges: new Set(), keys: new Set(), moved: new Set(), running: null };
  const queued = () => reQ.bend || reQ.bridges.size > 0 || reQ.keys.size > 0;
  function kickBaseWork() {
    if (!reQ.running) reQ.running = drainBaseWork().catch(e => console.error('realm ground: base-state work', e))
      .finally(() => { reQ.running = null; if (queued() && !disposed) kickBaseWork(); }); // queued meanwhile
    return reQ.running;
  }
  async function drainBaseWork() {
    while (queued() && !disposed) {
      st.baseWork = { bend: reQ.bend, bridges: reQ.bridges.size, riverPages: reQ.keys.size };
      if (reQ.bend) {
        reQ.bend = false;
        const r = await sliced(bendJob()); if (!r) return;
        for (const k of around(r.value, 1, 1)) reQ.bridges.add(k); // the moved rivers' 3×3 bridges (baseChanged queued the plots')
        continue;
      }
      if (reQ.bridges.size) {
        const list = [...reQ.bridges]; reQ.bridges.clear();
        const r = await sliced(bridgeJob(list)); if (!r) return;
        if (r.value.length) { invalidateDeeds(r.value); core.invalidate(); }
        continue;
      }
      const touch = [...reQ.keys]; reQ.keys.clear();
      const landed = k => { reQ.moved.delete(k); invalidateDeeds([k]); core.invalidate(); };
      const r = await sliced(rebakeJob(touch, T.lt.riverPage, k => T.rivers.cells.has(k), bakeRiver, landed)); if (!r) return;
      if (r.value !== true) { // the page texture is full (or was replaced): rebuild it from the current rivers, sliced
        reQ.keys.clear(); if (!(await linesBuildAsync())) return;
        invalidateDeeds([...reQ.moved]); reQ.moved.clear(); core.invalidate();
      }
    }
    st.baseWork = { bend: false, bridges: 0, riverPages: 0 };
  }
  // a page holds its deed's vertices 0…97 and, in row/column 98, the next deeds' first vertices: a change on deed k reaches
  // the pages of the deeds k − (0…back) in x and y
  function around(keys, back, fwd) {
    const out = new Set();
    for (const k of keys) { const x = k % cols, y = Math.floor(k / cols); for (let j = -back; j <= fwd; j++) for (let i = -back; i <= fwd; i++) { const X = x + i, Y = y + j; if (X >= 0 && Y >= 0 && X < cols && Y < rows) out.add(Y * cols + X); } }
    return out;
  }
  // G15: queue the land bridges of `deeds` (null = every plotted deed and every deed that had one) for a sliced CPU
  // recompute (classify.js plotBridges, the JS reference; P0 fix pass #8: 35–42 ms for 400 plots on the efficiency cores)
  function queueBridges(deeds) {
    if (!T.bridges || !T.lt) return;
    for (const k of deeds ?? [...Array(cols * rows).keys()].filter(k => baseCpu[k * 4 + 1] & FLAG.occupied || T.bridges[k * 4 + 2] > 0)) reQ.bridges.add(k);
    kickBaseWork();
  }
  // → the deeds whose bridge changed, after their header words are uploaded (the GPU evaluates a bridge over the 3×3 deeds,
  // a literal loop: no page to bake); 16 deeds a step
  function* bridgeJob(list) {
    const state = { cols, rows, data: baseCpu, rivers: T.rivers }, changed = [];
    for (let i = 0; i < list.length; i += 16) {
      const part = list.slice(i, i + 16), before = part.map(k => T.bridges.slice(k * 4, k * 4 + 4));
      plotBridges(T.cpuFields, T.lines, state, cfg, T.bridges, part);
      part.forEach((k, j) => { for (let c = 0; c < 4; c++) if (before[j][c] !== T.bridges[k * 4 + c]) { changed.push(k); break; } });
      yield;
    }
    st.bridges = T.bridges.reduce((a, v, i) => a + (i % 4 === 2 && v > 0 ? 1 : 0), 0);
    if (changed.length && T.lt) { writeHeaders(T.lt, changed); headerRowsUpload(T.lt, changed); }
    return changed;
  }

  // G16: bend the rivers round the plots of the current base state (CPU, classify.js bendRiversSteps) and queue the river
  // pages they reach for a sliced re-bake (P0 fix pass #8: it ran synchronously, ≤ 6 ms a page, the whole texture when full);
  // each page's deeds re-resolve when it lands. Stage B (RM-GPU-1 W1 blocker 5: the bend itself was 20–129 ms in one task):
  // updateBends only queues the bend; bendJob runs it in ≤ SLICE_MS slices, on a snapshot of the base state.
  function updateBends() {
    if (!T.lines?.polys?.length || !T.lt) return;
    reQ.bend = true; kickBaseWork();
  }
  // → the deeds whose river segments changed (their river pages are queued for a re-bake)
  function* bendJob() {
    const t0 = performance.now(), before = T.rivers, data = baseCpu.slice(); // (a base state landing meanwhile queues another bend)
    const next = yield* bendRiversSteps(T.lines, { cols, rows, data }, cfg);
    const changed = [];
    for (let k = 0; k < cols * rows; k++) {
      if ((k & 1023) === 1023) yield;
      const a = before.cells.get(k), b = next.cells.get(k);
      if (!a && !b) continue;
      let same = !!a && !!b && a.length === b.length;
      for (let i = 0; same && i < a.length; i++) for (let o = 0; o < 6; o++) if (before.segs[a[i] * 6 + o] !== next.segs[b[i] * 6 + o]) { same = false; break; }
      if (!same) changed.push(k);
    }
    T.rivers = next; st.bends = { moved: next.moved ?? 0, blocked: next.blocked ?? 0, ms: Math.round(performance.now() - t0) };
    if (changed.length) { for (const k of around(changed, 1, 0)) reQ.keys.add(k); for (const k of changed) reQ.moved.add(k); }
    return changed;
  }

  // ---- chart16 pages (512² LRU in one array) ----------------------------------------------------------------
  function setupChart16() {
    const c = meta.chart16; if (!c?.tiles?.length) { c16 = null; return; }
    const P16 = c.P ?? c.pxPerDeed ?? 16, W = cols * P16, H = rows * P16;
    c16 = { P: P16, px: Math.ceil(W / C16_PAGE), py: Math.ceil(H / C16_PAGE), tiles: c.tiles.map(t => ({ key: t.key ?? t.file, x: t.x, y: t.y, w: t.w, h: t.h })),
      arr: core.tex.array(C16_PAGE, C16_PAGE, C16_LRU, 'RGBA8', { filter: 'linear' }), lru: core.lru(C16_LRU), free: [...Array(C16_LRU).keys()], table: new Int32Array(64), pending: new Set(), jobs: [] };
  }
  function c16Want(view) {
    if (!c16 || view.d < BANDS.chart16 || view.d > 64) return; // the FAR chart only (it shows under MAP to d 48 + its fade)
    const r = view.rect, s = C16_PAGE / c16.P;
    const x0 = Math.floor(Math.max(0, r.fx0) / s), x1 = Math.min(c16.px - 1, Math.floor(Math.min(cols - 1e-6, r.fx1) / s));
    const y0 = Math.floor(Math.max(0, r.fy0) / s), y1 = Math.min(c16.py - 1, Math.floor(Math.min(rows - 1e-6, r.fy1) / s));
    const want = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = y * c16.px + x; if (k < 64) want.push([k, Math.hypot(x + 0.5 - view.x / s, y + 0.5 - view.y / s)]); }
    // P0 fix pass #7: the nearest C16_LRU pages only (a retina view at FAR wants 20–32); the rest stay chart8, never churn
    const plan = planPages(want, C16_LRU, k => c16.lru.has(k) || c16.pending.has(k));
    for (let i = plan.keep.length - 1; i >= 0; i--) if (c16.lru.has(plan.keep[i])) c16.lru.get(plan.keep[i]);
    st.c16OverCap = Math.max(0, want.length - C16_LRU);
    for (const k of plan.fetch) {
      const x = k % c16.px, y = Math.floor(k / c16.px);
      // a page may straddle tiles (PACK's tiles are not page-aligned): compose it from every tile it touches
      const gx = x * C16_PAGE, gy = y * C16_PAGE;
      const parts = c16.tiles.filter(t => gx < t.x + t.w && gx + C16_PAGE > t.x && gy < t.y + t.h && gy + C16_PAGE > t.y);
      if (!parts.length) continue;
      c16.pending.add(k);
      Promise.all(parts.map(t => P.bitmap(t.key))).then(bmps => {
        if (disposed) return;
        // W1 G3: composed by GROUND's per-frame pump within SLICE_MS (core's upload queue is byte-budgeted: 4–8 of these
        // 1 MB compositions ran in one frame task)
        c16.jobs.push(() => {
          const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(C16_PAGE, C16_PAGE) : Object.assign(document.createElement('canvas'), { width: C16_PAGE, height: C16_PAGE });
          const cx = cv.getContext('2d');
          parts.forEach((t, i) => cx.drawImage(bmps[i], t.x - gx, t.y - gy)); // opaque chart art: no premultiply concern
          let layer = c16.free.pop();
          if (layer === undefined) { const [old] = c16.lru.keys(); c16.lru.delete(old); layer = c16.free.pop(); }
          core.tex.layer(c16.arr, layer, cv);
          c16.lru.put(k, layer, (lay, key) => { c16.free.push(lay); c16.table[key] = 0; });
          c16.table[k] = layer + 1; c16.pending.delete(k);
        });
        core.invalidate();
      }).catch(e => { c16.pending.delete(k); console.warn('chart16', e); });
    }
  }

  // ---- MAP tables, palette, atlas ---------------------------------------------------------------------------
  function mapTables() {
    const m = meta.map ?? {};
    if (!m.families) return null;
    const table = mapBandTable(m);
    const slotOf = t => (t === m.wild ? 0 : /^M[1-5]$/.test(t) ? Number(t[1]) : 0);
    const terr = table.terrainOf.map(t => slotOf(t));
    const order = (m.layerOrder ?? ['M5', 'M2', 'M1', 'M3', 'M4']).map(s => Number(String(s).slice(1)));
    // G12: map slots drawn only by obstacle classes (the apron's feather clears them), and of those the ones whose classes
    // stand on the realm's wild ground at TRUE (forest, dunes…: the plot's clearing shows the wild ground there, as TRUE
    // does — rock, fields and the like keep their own ground)
    let obst = 0, ground = 0, own = 0;
    for (const c of [CLASS.FIELD, CLASS.FOREST, CLASS.SPECIAL, CLASS.ROCK, CLASS.SNOW]) obst |= 1 << terr[c];
    for (const c of [CLASS.WILD, CLASS.GROUND2, CLASS.SHORE, CLASS.ROAD]) ground |= 1 << terr[c];
    const t2t = meta.true?.classToTerrain ?? {}, wildT = t2t.WILD;
    for (const c of [CLASS.FIELD, CLASS.FOREST, CLASS.SPECIAL, CLASS.ROCK, CLASS.SNOW]) if (!wildT || t2t[Object.keys(CLASS).find(k => CLASS[k] === c)] !== wildT) own |= 1 << terr[c];
    obst &= ~ground & ~1;
    return { table, lg: legaliseTables(table), terr: Int32Array.from(terr), order, wild: m.wild, obst, clr: obst & ~own };
  }
  // Palette: realm.json.palette when PACK writes one, else the painting's own colours per class, measured
  // on the JS reference (so the sea, beach and water at MAP continue the FAR chart's colours).
  async function palette(pack) {
    const pm = meta.palette ?? {};
    const img = await pack.pixels(pack.first.chartKey ?? 'chart8.webp'), W = img.width, H = img.height;
    const sums = Array.from({ length: 14 }, () => [0, 0, 0, 0]);
    // (Stage B: the bent rivers GROUND keeps — without them classAt's riversOf bent the rivers again, 20–129 ms in one step)
    const noLines = null, state = { cols, rows, data: baseCpu, bridges: T.bridges, rivers: T.rivers };
    // (P0 fix pass: 9000 CPU classAt samples were one 105–294 ms task on the efficiency cores; now ≤ SLICE_MS slices)
    await sliced((function* () { for (let i = 0; i < 9000; i++) {
      if ((i & 127) === 127) yield;
      const h = kitHash(i, 0x5eed), x = (h % (cols * TILES)), y = (kitHash(i, 0x7a11) % (rows * TILES));
      if (pack.first.deeds[Math.floor(y / TILES) * cols + Math.floor(x / TILES)] === DEED_PX.none && (h & 3)) continue;
      const c = classAt(T.cpuFields, i & 1 ? T.lines : noLines, state, [x, y], cfg);
      const px = Math.min(W - 1, Math.floor(x / TILES * (W / cols))), py = Math.min(H - 1, Math.floor(y / TILES * (H / rows))), o = (py * W + px) * 4;
      const s = sums[c]; s[0] += img.data[o]; s[1] += img.data[o + 1]; s[2] += img.data[o + 2]; s[3]++;
    } })());
    const mean = (c, fb) => sums[c][3] > 8 ? [sums[c][0] / sums[c][3] / 255, sums[c][1] / sums[c][3] / 255, sums[c][2] / sums[c][3] / 255] : fb;
    // the painting's own open-sea colour at its border (outer 3 px ring, blue-dominant pixels only, so land or surf
    // touching the frame does not tint it): the chart's blurred edge fades into it outside the grid (RM-3)
    const ring = [0, 0, 0, 0], all = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x > 2 && y > 2 && x < W - 3 && y < H - 3) continue;
      const o = (y * W + x) * 4, r = img.data[o], gg = img.data[o + 1], b = img.data[o + 2];
      all[0] += r; all[1] += gg; all[2] += b; all[3]++;
      if (b > r + 12 && b > gg && r + gg + b < 420) { ring[0] += r; ring[1] += gg; ring[2] += b; ring[3]++; }
    }
    if (ring[3] < all[3] * 0.2) ring.splice(0, 4, ...all);
    const sea = pm.sea ? hex(pm.sea) : mean(CLASS.SEA, [0.16, 0.4, 0.55]), deep = pm.deep ? hex(pm.deep) : mean(CLASS.DEEP, sea.map(v => v * 0.7));
    const wild = mean(CLASS.WILD, [0.7, 0.62, 0.45]);
    const out = {
      byClass: Array.from({ length: 14 }, (_, c) => mean(c, wild)), count: sums.map(v => v[3]),
      shallow: pm.shallow ? hex(pm.shallow) : sea.map((v, i) => Math.min(1, v * 1.18 + [0.03, 0.06, 0.05][i])), sea, deep,
      foam: pm.foam ? hex(pm.foam) : [0.93, 0.97, 0.98], beach: pm.beach ? hex(pm.beach) : mean(CLASS.SHORE, [0.86, 0.78, 0.58]),
      water: pm.water ? hex(pm.water) : mean(CLASS.WATER, sea),
      // fix pass #6: the painting's own river / lake colour, always (PACK's palette.water is the kit's water in every pack, so
      // `water` never was the painting's): MAP's inland water starts here at d 48 and eases to the kit loop by d 120
      paintWater: mean(CLASS.WATER, sea), bank: wild.map(v => v * 0.55), road: pm.road ? hex(pm.road) : [0.62, 0.52, 0.38],
      roadEdge: [0.36, 0.29, 0.2], turf: pm.turf ? hex(pm.turf) : wild.map((v, i) => clamp(v * [0.96, 1.02, 0.92][i], 0, 1)), wet: wild.map(v => v * 0.82),
      edge: (meta.plotStyle?.edge ?? PLOT_STYLE[meta.id] ?? PLOT_STYLE.crownlands).map(hex),
      seaFar: [ring[0] / ring[3] / 255, ring[1] / ring[3] / 255, ring[2] / ring[3] / 255],
      wall: meta.plotStyle?.wallTierMean ? meta.plotStyle.wallTierMean.map((c, i) => [...hex(c), i === 4 ? 1 : 0]) : WALL_TIER,
    };
    if (meta.plotStyle?.turf) out.turf = hex(meta.plotStyle.turf);
    if (meta.plotStyle?.track?.colour) out.road = hex(meta.plotStyle.track.colour);
    return out;
  }
  // The map atlas: PACK's mapkit.png (realm.json.map.atlas) when present; otherwise a procedural stand-in
  // from the palette so the MAP band still renders its classes crisply (flagged in stats().ground.mapAtlas).
  async function mapAtlas(pack) {
    const A = meta.map?.atlas;
    if (A?.file && mapT) {
      // W1 G3: typed-array uploads from the decoded pixels in ≤ SLICE_MS slices (≈ 190 layers × (1 + 5 mips) ImageBitmap
      // sub-rect uploads ran in one task, each one extracting the whole atlas); the same bytes (loader pixels(): exact PNG)
      const [img, mimg] = await Promise.all([pack.pixels(A.file), pack.pixels(meta.map.mask?.file ?? 'mapmask.png')]);
      if (disposed) return;
      const cell = A.cell ?? 32, colsA = A.cols ?? Math.floor(img.width / cell), n = A.layers ?? colsA * Math.floor((A.rows0 ?? img.height) / cell);
      const levels = A.mips?.length ? A.mips.length + 1 : 1;
      // Colour mips are box-filtered here (generateMipmap), not PACK's reducer mips: the reducer keeps the darkest ink,
      // so the Sunscar grove's mean fell from (111,103,64) at level 0 to (28,25,16) at level 3 — the near-black grove
      // and the FAR→MAP pop of Gate A2 (GA2-02). A box mip is the true mean the tone map was measured against. The
      // masks keep PACK's reducer mips (crisp class decisions).
      T.mapkit = core.tex.array(cell, cell, n, 'RGBA8', { levels: 6, filter: 'linear' });
      T.mapmask = core.tex.array(cell, cell, n, 'RGBA8', { levels: levels > 1 ? levels : 6, filter: 'nearest' });
      const up = await sliced((function* () {
        for (let i = 0; i < n; i++) {
          const x = (i % colsA) * cell, y = Math.floor(i / colsA) * cell;
          core.tex.layer(T.mapkit, i, crop(img, x, y, cell, cell)); core.tex.layer(T.mapmask, i, crop(mimg, x, y, cell, cell));
          (A.mips ?? []).forEach((m, k) => { const c = cell >> (k + 1); core.tex.layer(T.mapmask, i, crop(mimg, (i % colsA) * c, m.y + Math.floor(i / colsA) * c, c, c), null, k + 1); });
          yield;
        }
      })());
      if (!up) return;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, T.mapkit.t); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      if (!A.mips?.length) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, T.mapmask.t); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); }
      const pu = A.pureUpper ?? {}, fl = meta.plotStyle?.fieldLayers;
      T.mapLayout = { wild: A.wild ?? [0, 4],
        fam: [0, 1, 2, 3, 4, 5].map(s => (s === 0 || A.families?.['M' + s] === undefined ? [0, 0, 0, 0] : [A.families['M' + s], 1, pu['M' + s]?.[0] ?? 0, pu['M' + s]?.[1] ?? 0])),
        field: fl ? [fl[0], fl[1]] : A.families?.M2 !== undefined ? [A.families.M2 + 15, 1] : [0, 0],
        wang: [0, 1, 2, 3, 4, 5].map(s => { const w = A.pureWang?.['M' + s]; return w && w[1] >= 16 && w[0] + 16 <= n ? [w[0], 16, 0, 0] : [0, 0, 0, 0]; }) };
      st.mapAtlas = 'pack';
      T.famK = await familyGrade(pack, A, n); st.famK = T.famK.map(v => v.map(x => +x.toFixed(2)));
      return;
    }
    proceduralAtlas();
    st.mapAtlas = 'procedural (no mapkit.png yet)';
  }
  // GA2-05: per map slot, the painting's mean colour of the classes it draws ÷ the map art's mean colour of that slot's
  // pure cells (level 0). The MAP band applies it (weight 1 → 0 over d 48 → 1100, linear in log d) under the spatial
  // tone, so the drift from the painting's colours to the kit's is spread across the whole band, with no blotches.
  async function familyGrade(pack, A, n) {
    const out = Array.from({ length: 6 }, () => [1, 1, 1]), fc = famClamp(meta);
    try {
      const img = await pack.pixels(A.file), cell = A.cell ?? 32, colsA = A.cols ?? Math.floor(img.width / cell);
      const artMean = layers => { const s = [0, 0, 0]; let k = 0;
        for (const L of layers) { if (L < 0 || L >= n) continue; const ox = (L % colsA) * cell, oy = Math.floor(L / colsA) * cell;
          for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) { const o = ((oy + y) * img.width + ox + x) * 4; if (img.data[o + 3] < 128) continue; s[0] += img.data[o]; s[1] += img.data[o + 1]; s[2] += img.data[o + 2]; k++; } }
        return k ? s.map(v => v / k / 255) : null; };
      const range = (a, c) => (a ? Array.from({ length: c ?? a[1] }, (_, i) => a[0] + i) : []);
      for (let sl = 0; sl <= 5; sl++) {
        const layers = sl === 0 ? range(A.wild ?? [0, 4]) : A.pureUpper?.['M' + sl] ? range(A.pureUpper['M' + sl]) : A.families?.['M' + sl] !== undefined ? [A.families['M' + sl] + 15] : [];
        const am = artMean(layers); if (!am) continue;
        const pm = [0, 0, 0]; let w = 0;
        for (let c = 0; c < 14; c++) if (mapT.terr[c] === sl && c !== CLASS.TURF && c !== CLASS.RING && c > CLASS.WATER) { const k = pal.count[c]; if (k < 8) continue; for (let i = 0; i < 3; i++) pm[i] += pal.byClass[c][i] * k; w += k; }
        if (w) out[sl] = pm.map((v, i) => clamp(v / w / Math.max(am[i], 0.02), fc[0], fc[1]));
      }
    } catch (e) { console.warn('realm ground: family grade', e); }
    return out;
  }
  function proceduralAtlas() {
    const S = 32, fams = 5, n = 4 + fams * 16, px = new Uint8Array(S * S * 4), mk = new Uint8Array(S * S * 4);
    T.mapkit = core.tex.array(S, S, n, 'RGBA8', { levels: 6, filter: 'linear' });
    T.mapmask = core.tex.array(S, S, n, 'RGBA8', { levels: 6, filter: 'nearest' });
    const slotColour = s => { // mean painting colour of the classes this slot draws
      if (!mapT || s === 0) return pal.byClass[CLASS.WILD];
      const cs = [...mapT.terr.keys()].filter(c => mapT.terr[c] === s); if (!cs.length) return pal.byClass[CLASS.WILD];
      return [0, 1, 2].map(i => cs.reduce((a, c) => a + pal.byClass[c][i], 0) / cs.length);
    };
    const fill = (layer, colour, maskFn, seed, style) => {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4, up = maskFn ? maskFn(x, y) : 1, h = kitHash(x + seed * 64, y + seed * 131), j = ((h & 255) / 255 - 0.5) * 0.1;
        let k = 1 + j;
        if (style === 1 && up) k *= ((kitHash((x >> 2) + seed, (y >> 2) - seed) & 3) === 0 ? 0.72 : ((x + y) & 3) === 0 ? 0.85 : 1); // crowns
        if (style === 2 && up) k *= (y % 4 === 0 ? 0.82 : 1);                                                                        // furrows
        const c = up ? colour : slotColour(0);
        px[o] = clamp(c[0] * k * 255, 0, 255); px[o + 1] = clamp(c[1] * k * 255, 0, 255); px[o + 2] = clamp(c[2] * k * 255, 0, 255); px[o + 3] = 255;
        mk[o] = up ? 255 : 0; mk[o + 1] = 0; mk[o + 2] = 0; mk[o + 3] = 255;
      }
      core.tex.layer(T.mapkit, layer, { data: px, w: S, h: S }); core.tex.layer(T.mapmask, layer, { data: mk, w: S, h: S });
    };
    for (let v = 0; v < 4; v++) fill(v, slotColour(0), null, v + 1, 0);
    for (let s = 1; s <= fams; s++) {
      const colour = slotColour(s), style = s === 1 ? 1 : s === 2 ? 2 : 0;
      for (let m = 0; m < 16; m++) {
        const c = [(m >> 3) & 1, (m >> 2) & 1, (m >> 1) & 1, m & 1];
        const fn = (x, y) => { const u = (x + 0.5) / S, v = (y + 0.5) / S, w = c[0] * (1 - u) * (1 - v) + c[1] * u * (1 - v) + c[2] * (1 - u) * v + c[3] * u * v;
          return w + ((kitHash(x + m * 7, y + s * 13) & 255) / 255 - 0.5) * 0.12 > 0.5 ? 1 : 0; };
        fill(4 + (s - 1) * 16 + m, colour, fn, s * 16 + m, style);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, T.mapkit.t); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, T.mapmask.t); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    T.mapLayout = { wild: [0, 4], fam: [0, 1, 2, 3, 4, 5].map(s => (s === 0 ? [0, 0, 0, 0] : [4 + (s - 1) * 16, 1, 0, 0])), field: [4 + 16 + 15, 1], wang: Array.from({ length: 6 }, () => [0, 0, 0, 0]) };
  }

  // ---- lattice (MAP classes) ---------------------------------------------------------------------------------
  function latticeSetup() {
    const W = cols * 14 + 1, H = rows * 14 + 1, px = Math.ceil(W / LAT_PAGE), py = Math.ceil(H / LAT_PAGE);
    const sx = Math.ceil(W / SUB), sy = Math.ceil(H / SUB);
    // W1 G2: R8UI pages (bit 5 = the vertex's 3×3 is one map slot, the PURE pass). steps[0] = the raw target over the
    // apron, steps[i] = the output of LATTICE_PASSES[i − 1], each 2 vertices smaller; the last pass writes the page
    const n = LATTICE_PASSES.length, sz = i => SUB + 2 * (APRON - i);
    lat = { W, H, px, py, sx, sy, arr: core.tex.array(LAT_PAGE, LAT_PAGE, px * py, 'R8UI'), done: new Uint8Array(sx * sy),
      steps: Array.from({ length: n }, (_, i) => core.tex.data(sz(i), sz(i), 'R8UI', null, null, null)) };
    st.latticeSubTiles = sx * sy;
  }
  const LATTICE_PROGS = ['raw', 'dsp', 'leg', 'pure']; // the programs resolveSub draws (W1 fix pass 2 #3: none may be first drawn by it at FAR)
  function resolveSub(i) {
    const sx = i % lat.sx, sy = Math.floor(i / lat.sx), lx = sx * SUB, ly = sy * SUB;
    const pgx = Math.floor(lx / LAT_PAGE), pgy = Math.floor(ly / LAT_PAGE), layer = pgy * lat.px + pgx, S = lat.steps;
    const into = k => { core.fbo(S[k]); gl.viewport(0, 0, S[k].w, S[k].h); core.fullscreen(); };
    // raw over the apron (one vertex per pass that follows)
    const p = prog.raw.use(); setFieldUniforms(p); setClassifyUniforms(p, 0);
    let u = bindFieldTextures(p, 0); p.tex('uRmFieldsBC', u, T.fieldsBC);
    gl.uniform4i(p.u('uRsOrigin'), lx * 7, ly * 7, 7, APRON);
    into(0);
    // two despeckle passes (classify.js MAP_DESPECKLE: mode 12 — 1-wide upper runs + isolated vertices — then mode 4), then
    // legalise ×2 (the second writes class + 1), then (W1 G2) the purity bit into the lattice page
    let ds = prog.dsp.use(); ds.tex('uDsSrc', 0, S[0]); gl.uniform1i(ds.u('uDsMode'), mapDespeckleMode(0)); into(1);
    ds = prog.dsp.use(); ds.tex('uDsSrc', 0, S[1]); gl.uniform1i(ds.u('uDsMode'), mapDespeckleMode(1)); into(2);
    setLegalise(mapT.lg, false, [1, 1]); prog.leg.tex('uLgSrc', 0, S[2]); into(3);
    setLegalise(mapT.lg, true, [1, 1]); prog.leg.tex('uLgSrc', 0, S[3]); into(4);
    const ox = lx - pgx * LAT_PAGE, oy = ly - pgy * LAT_PAGE, pu = prog.pure.use();
    pu.tex('uPuSrc', 0, S[4]); gl.uniform2i(pu.u('uPuShift'), 1 - ox, 1 - oy); gl.uniform1iv(pu.u('uPuSlot'), mapT.terr);
    core.fbo(lat.arr, layer); gl.viewport(ox, oy, SUB, SUB); core.fullscreen();
    lat.done[i] = 1; st.latticeResolved++;
  }
  // the lattice sub-tiles under view rect r grown by m deeds → [x0, x1, y0, y1]
  function subRange(r, m) {
    const at = (v, n) => clamp(Math.floor(v * 14 / SUB), 0, n - 1);
    return [at(r.fx0 - m, lat.sx), at(r.fx1 + m, lat.sx), at(r.fy0 - m, lat.sy), at(r.fy1 + m, lat.sy)];
  }
  // resolve up to `budget` of the view's missing sub-tiles (2 deeds of margin), nearest the view centre first. W1 G4 (honest
  // `missing`): → the sub-tiles this frame found missing, the ones it resolves included — they reach the screen with this
  // frame, so `missing` is 0 only once a frame has needed no resolve (the previous one was already whole): a capture or a
  // band gate that waits for 0 never sees a strip still drawing the chart (the critic's Crownlands d 150 edge)
  function latticeWork(view, budget) {
    if (!lat || !mapT) return 0;
    const [ax0, ax1, ay0, ay1] = subRange(view.rect, 2);
    const cx = view.x * 14 / SUB, cy = view.y * 14 / SUB, want = [];
    for (let y = ay0; y <= ay1; y++) for (let x = ax0; x <= ax1; x++) { const i = y * lat.sx + x; if (!lat.done[i]) want.push([Math.hypot(x + 0.5 - cx, y + 0.5 - cy), i]); }
    want.sort((a, b) => a[0] - b[0]);
    let n = 0;
    for (const [, i] of want) { if (n >= budget) break; resolveSub(i); n++; }
    st.lastSubs = n;
    return want.length;
  }
  /**
   * W1 G4: may the MAP band draw this view whole? True once the MAP data is in and every lattice sub-tile under the view
   * (half a deed of margin: a cell's corners and its warped cell) is resolved. SHELL holds the FAR→MAP crossover on it for a
   * bounded time (GPU_SAFE.rehearse.mapReadyHoldMs); at FAR, GROUND pre-resolves the view's lattice while the camera rests.
   */
  function mapReady(view) {
    if (!ready.map || !lat || !mapT || !view?.rect) return false;
    const [x0, x1, y0, y1] = subRange(view.rect, 0.5);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!lat.done[y * lat.sx + x]) return false;
    return true;
  }

  // ---- TRUE pages ---------------------------------------------------------------------------------------------
  async function trueSetup(pack) {
    const t = meta.true, A = t.atlas;
    // Records reserve layer word 0 for "none": PACK's ground.png layer i is uploaded as global layer i + 1
    // (array A holds globals 0…255, B holds 256…). A pack that already reserves 0 sets atlas.reserved0.
    const off = A.reserved0 ? 0 : 1;
    // W1 G3: every TRUE atlas, mask and decal layer is a typed-array upload from the decoded pixels (loader pixels(): exact
    // PNG), with the mask packing and the decal boxes, in ≤ SLICE_MS slices — 208–384 ImageBitmap sub-rect uploads and the
    // mask / box loops ran in one task
    const gp = await pack.pixels(A.file), mp = await pack.pixels(t.mask?.file ?? 'groundmask.png'), dp = t.decals?.file ? await pack.pixels(t.decals.file) : null;
    if (disposed) return;
    const cell = A.cell ?? 32, colsA = A.cols ?? Math.floor(gp.width / cell);
    const n = A.layers ?? colsA * Math.floor(gp.height / cell), N = n + off;
    T.gA = core.tex.array(cell, cell, Math.min(256, N), 'RGBA8', { levels: 6, filter: 'linear' });
    T.gB = N > 256 ? core.tex.array(cell, cell, N - 256, 'RGBA8', { levels: 6, filter: 'linear' }) : dummy('fA');
    // masks: 4 per RGBA8 layer from groundmask.png's R channel (typed-array upload: no decoder premultiply)
    const ml = Math.ceil(N / 4), md = new Uint8Array(ml * 32 * 32 * 4);
    T.gMask = core.tex.array(32, 32, ml, 'RGBA8', { filter: 'nearest' });
    const dc = dp ? t.decals.cols ?? Math.floor(dp.width / 32) : 0, dn = dp ? t.decals.count ?? dc : 0, box = new Uint8Array(Math.max(1, dn) * 4);
    if (dp) T.gDecal = core.tex.array(32, 32, dn, 'RGBA8', { filter: 'nearest' });
    const up = await sliced((function* () {
      for (let i = 0; i < n; i++) {
        const ox = (i % colsA) * cell, oy = Math.floor(i / colsA) * cell, g = i + off, L = g >> 2, ch = g & 3;
        core.tex.layer(g < 256 ? T.gA : T.gB, g < 256 ? g : g - 256, crop(gp, ox, oy, cell, cell));
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) md[((L * 32 + y) * 32 + x) * 4 + ch] = mp.data[((oy + y) * mp.width + ox + x) * 4] > 127 ? 255 : 0;
        yield;
      }
      for (let L = 0; L < ml; L++) { core.tex.layer(T.gMask, L, { data: md.subarray(L * 4096, (L + 1) * 4096), w: 32, h: 32 }); yield; }
      for (let i = 0; i < dn; i++) {
        const ox = (i % dc) * 32, oy = Math.floor(i / dc) * 32;
        core.tex.layer(T.gDecal, i, crop(dp, ox, oy, 32, 32));
        // fix iteration 2 #4: each decal's opaque bbox (the room its tile leaves for the per-tile shift)
        let x0 = 31, y0 = 31, x1 = 0, y1 = 0;
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (dp.data[((oy + y) * dp.width + ox + x) * 4 + 3] > 127) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        box.set(x1 >= x0 ? [x0, y0, x1, y1] : [0, 0, 31, 31], i * 4);
        yield;
      }
    })());
    if (!up) return;
    for (const a of N > 256 ? [T.gA, T.gB] : [T.gA]) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, a.t); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); }
    if (dp) T.gDecalBox = core.tex.data(dn, 1, 'RGBA8', null, null, box, { filter: 'nearest' });
    else { T.gDecal = dummy('fA'); T.gDecalBox = dummy('f2'); }
    // tables (layer words are globals: PACK index + off)
    const terrIds = t.terrains.map(x => x.id), ti = id => { const i = terrIds.indexOf(id); return i < 0 ? 15 : i; };
    const cls2t = t.classToTerrain ?? {};
    const fams = t.families ?? [];
    const table = bandTable({ classToTerrain: cls2t, families: fams.map(f => ({ lower: f.lower, upper: f.upper })), fallback: t.fallback ?? {} });
    const pair = new Int32Array(256).fill(-1);
    fams.forEach((f, s) => { const a = ti(f.lower), b = ti(f.upper); pair[a * 16 + b] = s; pair[b * 16 + a] = s; });
    const famU = new Int32Array(48 * 4); fams.forEach((f, s) => famU.set([f.first + off, ti(f.upper), ti(f.lower), 0], s * 4));
    const pure = new Int32Array(16 * 4), layer = new Int32Array(16).fill(99);
    t.terrains.forEach((x, i) => { pure.set([(x.pure?.[0] ?? 0) + off, Math.max(1, x.pure?.[1] ?? 1), x.kind === 'water' ? 1 : 0, 0], i * 4); layer[i] = Math.round((x.layer ?? 1) * 10); });
    const terr = new Int32Array(14).fill(15); for (const [c, id] of Object.entries(cls2t)) if (c in CLASS && id) terr[CLASS[c]] = ti(id);
    // decal groups: the kit's exact gate hash, salts pre-mixed on the CPU (Math.imul wraps; GLSL int overflow may not)
    const decalOf = new Int32Array(14), groups = new Int32Array(8 * 4), salts = new Int32Array(8 * 2);
    (t.decalGroups ?? []).slice(0, 8).forEach((g, k) => {
      if (g.class in CLASS) decalOf[CLASS[g.class]] = k + 1;
      const salt = g.salt ?? k;
      groups.set([Math.round(g.density * 10000), g.first ?? 0, g.count ?? 1, 0], k * 4);
      salts.set([Math.imul(salt + 1, 0x9e37) ^ 0x5a5a, Math.imul(salt + 1, 0x7f4a) ^ 0x3c3c], k * 2);
    });
    const w = t.water ?? { first: 0, frames: 8, frameMs: 200, phases: 4 };
    // GA2-03: PACK's true.waterByClass gives the loop per wet class (Cinderfall: a blue sea loop for DEEP/SEA, the lava
    // loop for WATER); one loop for both where it is absent
    const wbc = t.waterByClass ?? {}, wSea = wbc.SEA ?? wbc.DEEP ?? w, wIn = wbc.WATER ?? w;
    // GA2-07: each loop's mean colour (frame 0, opaque texels): the MAP water eases into it before TRUE shows
    try {
      const meanOf = first => { const sm = [0, 0, 0, 0], ox = (first % colsA) * cell, oy = Math.floor(first / colsA) * cell;
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) { const o = ((oy + y) * gp.width + ox + x) * 4; if (gp.data[o + 3] < 128) continue; sm[0] += gp.data[o]; sm[1] += gp.data[o + 1]; sm[2] += gp.data[o + 2]; sm[3]++; }
        return sm[3] > 64 ? [sm[0] / sm[3] / 255, sm[1] / sm[3] / 255, sm[2] / sm[3] / 255] : null; };
      T.kitWater = meanOf(wSea.first); T.kitInland = meanOf(wIn.first); T.seaIsLava = !t.waterByClass && meta.id === 'cinderfall';
      if (waterGems(meta) > 0) {
        T.gemCol = gemColours(gp.data, gp.width, (wSea.first % colsA) * cell, Math.floor(wSea.first / colsA) * cell, cell);
        // (first SwiftShader look: a fixed gem colour read as bright stars over MAP's deep sea, where TRUE's loop shows dim
        // lavender shards — its depth tint darkens the gems with the water. So MAP draws each gem as its colour ÷ the loop's
        // mean, times the MAP water under it: the same gem-to-water contrast as TRUE at every depth)
        T.gemK = T.gemCol && T.kitWater ? T.gemCol.map(c => c.map((v, i) => clamp(v / Math.max(T.kitWater[i], 0.02), 0, 8))) : null;
        st.gems = T.gemK ? { share: waterGems(meta), colours: T.gemCol.map(c => c.map(v => Math.round(v * 255))), k: T.gemK.map(c => c.map(v => +v.toFixed(2))) } : { error: 'no highlight texels' };
      }
    } catch (e) { console.warn('realm ground: kit water mean', e); }
    trueT = { table, lg: legaliseTables(table), pair, famU, pure, layer, terr, decalOf, groups, salts,
      water: { ...wSea, first: wSea.first + off, step: waterPhaseStep(wSea) }, inland: { ...wIn, first: wIn.first + off, step: waterPhaseStep(wIn) } };
    // vertex-class scratch targets 99 + 2k, k = 0 … 2 + DESPECKLE_PASSES (raw on the full apron, then each pass shrinks by 1)
    const steps = Array.from({ length: 3 + DESPECKLE_PASSES }, (_, k) => core.tex.data(99 + 2 * k, 99 + 2 * k, 'R8UI', null, null, null));
    const cap = recCap(); st.recPages = cap;
    trueSt = { cap, rec: core.tex.array(98, 98, cap, 'RGBA16UI'), table: new Uint16Array(cols * rows), lru: core.lru(cap), free: [...Array(cap).keys()], steps };
    T.pageTable = core.tex.data(cols, rows, 'R16UI', null, null, trueSt.table);
  }
  function resolvePage(dx, dy) {
    let layer = trueSt.free.pop();
    if (layer === undefined) { const [old] = trueSt.lru.keys(); trueSt.lru.delete(old); layer = trueSt.free.pop(); }
    const S = trueSt.steps, top = S.length - 1, size = i => 99 + 2 * i;
    const p = prog.raw.use(); setFieldUniforms(p); setClassifyUniforms(p);
    let u = bindFieldTextures(p, 0); p.tex('uRmFieldsBC', u, T.fieldsBC);
    gl.uniform4i(p.u('uRsOrigin'), dx * TILES, dy * TILES, 1, top);
    core.fbo(S[top]); gl.viewport(0, 0, size(top), size(top)); core.fullscreen();
    // G7 despeckle (classify.js resolveRegion: pass 0 fills, the rest fill and erode), then legalise ×2
    let i = top;
    for (let pass = 0; pass < DESPECKLE_PASSES; pass++, i--) {
      const ds = prog.dsp.use(); ds.tex('uDsSrc', 0, S[i]); gl.uniform1i(ds.u('uDsMode'), despeckleMode(pass));
      core.fbo(S[i - 1]); gl.viewport(0, 0, size(i - 1), size(i - 1)); core.fullscreen();
    }
    for (; i > 0; i--) {
      setLegalise(trueT.lg, false, [1, 1]); prog.leg.tex('uLgSrc', 0, S[i]);
      core.fbo(S[i - 1]); gl.viewport(0, 0, size(i - 1), size(i - 1)); core.fullscreen();
    }
    const r = prog.rec.use(), geo = plotAt({ cols, rows, data: baseCpu }, dx, dy); // G8: the claim at the plot's offset
    r.tex('uTrV', 0, S[0]);
    gl.uniform2i(r.u('uTrDeed'), dx, dy); gl.uniform4i(r.u('uTrClaim'), geo ? geo.minX : -1, geo ? geo.minY : -1, geo ? geo.maxX : -1, geo ? geo.maxY : -1);
    gl.uniform1iv(r.u('uTrTerr'), trueT.terr); gl.uniform1iv(r.u('uTrLayer'), trueT.layer); gl.uniform4iv(r.u('uTrPure'), trueT.pure);
    gl.uniform4iv(r.u('uTrPair4'), trueT.pair); gl.uniform4iv(r.u('uTrFam'), trueT.famU); gl.uniform1i(r.u('uTrWaterPhases'), trueT.water.phases ?? 4);
    gl.uniform1iv(r.u('uTrDecal'), trueT.decalOf); gl.uniform4iv(r.u('uTrDecalGroup'), trueT.groups); gl.uniform2iv(r.u('uTrDecalSalt'), trueT.salts);
    core.fbo(trueSt.rec, layer); gl.viewport(0, 0, 98, 98); core.fullscreen();
    const k = dy * cols + dx;
    trueSt.lru.put(k, layer, (lay, key) => { trueSt.free.push(lay); trueSt.table[key] = 0; core.tex.update(T.pageTable, new Uint16Array([0]), { x: key % cols, y: Math.floor(key / cols), w: 1, h: 1 }); });
    trueSt.table[k] = layer + 1; core.tex.update(T.pageTable, new Uint16Array([layer + 1]), { x: dx, y: dy, w: 1, h: 1 });
    st.pagesResolved++;
  }
  function pageWork(view, budget) {
    if (!trueSt || view.d < BANDS.pageResolve) return 0;
    const r = view.rect, want = [];
    for (let y = Math.max(0, Math.floor(r.fy0) - 1); y <= Math.min(rows - 1, Math.floor(r.fy1) + 1); y++)
      for (let x = Math.max(0, Math.floor(r.fx0) - 1); x <= Math.min(cols - 1, Math.floor(r.fx1) + 1); x++) want.push([y * cols + x, Math.hypot(x + 0.5 - view.x, y + 0.5 - view.y)]);
    // P0 fix pass #6: keep the nearest `cap` (touched farthest-first: the LRU evicts only pages outside them), resolve their
    // missing ones nearest-first within the frame's budget; pages past the cache stay MAP and are not missing
    const plan = planPages(want, trueSt.cap, k => trueSt.lru.has(k), budget);
    for (let i = plan.keep.length - 1; i >= 0; i--) if (trueSt.lru.has(plan.keep[i])) trueSt.lru.get(plan.keep[i]);
    for (const k of plan.fetch) resolvePage(k % cols, Math.floor(k / cols));
    st.lastPages = plan.fetch.length; st.pagesOverCap = Math.max(0, want.length - trueSt.cap);
    return plan.missing; // W1 G4 honest `missing`: this frame's resolves count until a frame needs none (see latticeWork)
  }

  // ---- base state ---------------------------------------------------------------------------------------------
  function invalidateDeeds(changed) {
    if (!lat) return;
    if (changed === null) { lat.done.fill(0); if (trueSt) for (const k of trueSt.lru.keys()) trueSt.lru.delete(k); return; }
    for (const k of changed) {
      const dx = k % cols, dy = Math.floor(k / cols);
      // the 3×3 deeds a plot reaches, plus one lattice vertex per pass after the raw one (W1 G2: APRON, was 3)
      for (let y = Math.floor(((dy - 1) * 14 - APRON) / SUB); y <= Math.floor(((dy + 2) * 14 + APRON) / SUB); y++)
        for (let x = Math.floor(((dx - 1) * 14 - APRON) / SUB); x <= Math.floor(((dx + 2) * 14 + APRON) / SUB); x++)
          if (x >= 0 && y >= 0 && x < lat.sx && y < lat.sy) lat.done[y * lat.sx + x] = 0;
      if (trueSt) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const kk = (dy + j) * cols + dx + i; if (trueSt.lru.has(kk)) trueSt.lru.delete(kk); }
    }
  }
  function applyBaseCpu(next) {
    const changed = [];
    for (let i = 0; i < cols * rows; i++) {
      const o = i * 4, occA = baseCpu[o + 1] & FLAG.occupied, occB = next[o + 1] & FLAG.occupied;
      if (occA !== occB || (occB && (baseCpu[o + 3] !== next[o + 3] || baseCpu[o + 2] !== next[o + 2]))) changed.push(i);
    }
    baseCpu.set(next);
    return changed;
  }
  /** BASES' base-state texture (RGBA8UI, §6.1). cpu (optional) = the same bytes, so only changed deeds re-resolve. */
  function setBaseState(tex, version, cpu = null) {
    baseExt = tex ?? null;
    if (version === geomVersion) return;
    geomVersion = version;
    if (cpu && baseCpu) invalidateDeeds(baseChanged(applyBaseCpu(cpu)));
    else { if (cpu && !baseCpu) { /* not loaded yet */ } updateBends(); queueBridges(null); invalidateDeeds(null); }
    core.invalidate();
  }
  // base-state change `ch` (changed plots): they re-resolve NOW; the rivers they bend (G16) and the land bridges of their
  // 3×3 and of the moved rivers' deeds (G15) are queued, and those deeds re-resolve as their data lands (P0 fix pass #8)
  function baseChanged(ch) {
    updateBends(); // (Stage B: queued; the moved rivers' 3×3 bridges are queued when the bend lands, drainBaseWork)
    queueBridges([...around(ch, 1, 1)]);
    return ch;
  }
  /** Stand-in until BASES ships its texture: build the base state from a Base[] list (plan §6.1). */
  function setBases(list) {
    if (!baseCpu) return;
    const next = Uint8Array.from(baseCpu);
    for (let i = 0; i < cols * rows; i++) { next[i * 4 + 1] = 0; next[i * 4 + 2] = 0; next[i * 4 + 3] = 0; }
    for (const b of list ?? []) {
      if (b.x < 0 || b.y < 0 || b.x >= cols || b.y >= rows) continue;
      const o = (b.y * cols + b.x) * 4, L = clamp(b.level | 0, 1, 20);
      next[o + 1] = FLAG.occupied | (b.mine ? FLAG.mine : 0) | (b.shield ? FLAG.shield : 0); next[o + 2] = PLOT_GEOM[L].claim; next[o + 3] = L;
    }
    invalidateDeeds(baseChanged(applyBaseCpu(next)));
    core.tex.update(T.base, baseCpu);
    core.invalidate();
  }
  function setOccupancy(arr) { occ = arr; }

  // ---- frame ---------------------------------------------------------------------------------------------------
  let lastMissing = 0, lastPagesMissing = 0, preT = 0;
  // Stage B (help SHELL / QA attribute the first-visit band-change spike): GROUND's work in each of the last WORK_N update()
  // frames — when (performance.now at entry), the zoom, the lattice sub-tiles and TRUE pages this frame resolved (the
  // destination's pre-resolve), update()'s own CPU ms, the chart16 pump ms, the FAR pre-resolve left and `missing` — in a
  // fixed ring (no allocation per frame); stats().work reads it back oldest-first. A band-change frame whose long task
  // carries a resolve shows it here; one that resolved nothing points away from GROUND's resolve work.
  const WORK_N = 64, WORK_F = 8, work = new Float64Array(WORK_N * WORK_F); let workAt = 0;
  const workLog = () => { const out = [];
    for (let i = 0; i < WORK_N; i++) { const o = ((workAt + i) % WORK_N) * WORK_F; if (!work[o]) continue;
      out.push({ t: +work[o].toFixed(1), d: +work[o + 1].toFixed(1), subs: work[o + 2], pages: work[o + 3], ms: +work[o + 4].toFixed(2), c16Ms: +work[o + 5].toFixed(2), preMap: work[o + 6], missing: work[o + 7] }); }
    return out; };
  // W1 G3: the chart16 compositions of this frame, at least one, then while under SLICE_MS
  function c16Pump() {
    if (!c16?.jobs.length) return 0;
    const t = performance.now();
    do { try { c16.jobs.shift()(); } catch (e) { console.warn('chart16', e); } } while (c16.jobs.length && performance.now() - t < SLICE_MS);
    st.c16PumpMs = Math.round((performance.now() - t) * 10) / 10;
    if (c16.jobs.length) core.invalidate();
    return st.c16PumpMs;
  }
  function update(view) {
    if (!P || !prog.raw) return;
    const t0 = performance.now();
    const c16Ms = c16Pump(); c16Want(view);
    const w = view.w ?? {};
    const needMap = view.d >= BANDS.farEnd * 0.75, wantMap = ready.map && needMap;
    // P0 (c): the resolve slices of one frame scale with the canvas (groundcost.js resolveBudget): ≤ 6 fetches per canvas px
    const rb = resolveBudget(gl.drawingBufferWidth * gl.drawingBufferHeight, { far: view.d < BANDS.mapStart, despecklePasses: DESPECKLE_PASSES });
    st.lastSubs = 0; st.lastPages = 0;
    // W1 fix pass 2 #3: a lattice resolve must never be the first draw (the pipeline build) of a bake program. While the MAP
    // pass is not on screen (d < farEnd, the entry zoom d 18–24 included), lattice work waits until each bake program has
    // been drawn once — by SHELL's band rehearsal, one per idle frame, rm-raw first — instead of building 3–4 pipelines in
    // one frame with a 266²-vertex classifier resolve while the player pans at FAR. Once MAP shows (the gate passed, or
    // the rehearsal is off / its valve opened) it resolves regardless: a late pipeline beats a map that never resolves.
    // (TRUE pages resolve from d 600, always with MAP on screen, after the MAP gate rehearsed rm-record.)
    const mapShown = (w.far ?? 1) < 1, bakeCold = LATTICE_PROGS.some(k => !prog[k].drawn), held = bakeCold && !mapShown;
    st.bakeHeld = held;
    // GA2-16 honest `missing`: a band that is still loading (MAP data, the line-field bake) counts as missing
    lastMissing = wantMap ? latticeWork(view, held ? 0 : rb.subs) : needMap && !ready.map && !st.mapErr ? 1 : 0;
    // W1 G4: at FAR, while the camera rests (no input for the rehearsal's idleMs, not moving), the view's MAP lattice is
    // resolved ahead of the FAR→MAP crossover, one sub-tile per frame (the sub-tiles nearest the view centre first); at FAR
    // it is not drawn, so it is not `missing` (stats().ground.preMap counts what is left)
    st.preMap = 0; let preNow = false;
    if (!needMap && ready.map) {
      const idle = GPU_SAFE.rehearse.idleMs, since = core.sinceInput(); preNow = !view.moving && since >= idle && !held;
      st.preMap = latticeWork(view, preNow ? 1 : 0) - st.lastSubs;
      if (st.preMap > 0 && !preNow && !held && !preT) preT = setTimeout(() => { preT = 0; if (!disposed) core.invalidate(); }, Math.max(16, idle - since));
    }
    lastPagesMissing = ready.true ? pageWork(view, rb.pages) : view.d >= BANDS.pageResolve && meta?.true?.atlas && !st.trueErr ? 1 : 0;
    // (held: no frame is asked for — the rehearsal's own steps draw the frames that end the hold, so an idle map stays idle)
    if ((lastMissing > 0 && !held) || lastPagesMissing > 0 || (preNow && st.preMap > 0)) core.invalidate();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    st.resolveMsLast = performance.now() - t0;
    st.lastBand = view.band; st.w = w;
    { const o = workAt * WORK_F; work[o] = t0; work[o + 1] = view.d; work[o + 2] = st.lastSubs; work[o + 3] = st.lastPages; work[o + 4] = st.resolveMsLast;
      work[o + 5] = c16Ms; work[o + 6] = st.preMap; work[o + 7] = lastMissing + lastPagesMissing; workAt = (workAt + 1) % WORK_N; }
    // what animates on screen (plan §7): cloud drift everywhere (art-px steps ≈ 8 fps), the kit water loop at
    // TRUE, glints at MAP/FAR. core's idle policy caps and freezes it; reduced motion → nothing.
    const water = ready.true && (w.true ?? 0) > 0 ? (trueT?.water.frameMs ?? 200) : 600;
    core.animating('ground', view.reducedMotion ? 0 : Math.min(125, water));
  }
  /** W1 (SHELL's contract v2 §8): the display passes draw(view) will draw after update(view) → { chart, map, true } (SHELL
   *  picks the ground scale from it: full resolution when one pass is drawn at rest). The same decision draw() makes. */
  function passes(view) {
    const w = view.w ?? { far: 1, map: 0, true: 0 }, tFM = 1 - (w.far ?? 1), tMT = w.true ?? 0;
    const mapOn = ready.map && tFM > 0, trueOn = ready.true && tMT > 0;
    return { chart: !!P && (!mapOn || tFM < 1 || lastMissing > 0), map: mapOn && (tMT < 1 || lastPagesMissing > 0 || !trueOn), true: trueOn, tFM, tMT };
  }
  function draw(view) {
    if (!P || !prog.chart) return;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    const ps = passes(view), tFM = ps.tFM, tMT = ps.tMT, chartUnder = ps.chart, mapUnder = ps.map, trueOn = ps.true;
    gl.disable(gl.BLEND);
    st.drawn = { chart: chartUnder, map: mapUnder, true: trueOn };
    if (chartUnder) drawChart(view, 1);
    if (mapUnder) {
      if (tFM < 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
      drawMap(view, Math.min(1, tFM)); gl.disable(gl.BLEND);
    }
    if (trueOn) {
      if (tMT < 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
      drawTrue(view, tMT); gl.disable(gl.BLEND);
    }
    const d = view.d;
    st.mag = { chart: +(d / (c16 && d >= BANDS.chart16 ? c16.P : 8)).toFixed(2), chartW: +(chartUnder ? 1 - (mapUnder ? tFM : 0) : 0).toFixed(2),
      map: +(d / 448).toFixed(2), mapW: +(mapUnder ? 1 - tMT : 0).toFixed(2), true: +(d / 3136).toFixed(3), trueW: +tMT.toFixed(2) };
    st.mag.over = { chart: st.mag.chart > 3 && st.mag.chartW > 0.5, map: st.mag.map > 2.5 && st.mag.mapW > 0, trueSharp: true };
    if (probeReq) { const r = probeReq; probeReq = null; try { r.resolve(runProbe(view, r.opts)); } catch (e) { r.resolve({ error: String(e.stack || e) }); } }
  }

  // ---- QA probes (dev only; plan §11.3 "Coast matches", Gate A fix round) ---------------------------------------------
  // MAP↔TRUE water line: the MAP overlay's wet decision and TRUE's visible water texels, rendered for the same view into
  // an offscreen target (no sprites, no blending) and compared where both layers draw. "coastal" = pixels within 4 px
  // of the water line in either layer; the §11.3 gate is xor/coastal ≤ 1.5 % at V5.
  let probeReq = null, probeT = null;
  function runProbe(view, opts = {}) {
    if (!trueSt || !ready.map) return { error: 'MAP or TRUE not ready' };
    const W = gl.canvas.width, H = gl.canvas.height;
    if (!probeT || probeT.w !== W || probeT.h !== H) { if (probeT) core.tex.free(probeT); probeT = core.tex.data(W, H, 'RGBA8', null, null, null, { filter: 'nearest' }); probeT.w = W; probeT.h = H; }
    prog.mapW ??= core.program('rm-map-wmask', { vs: MAP_VS, fs: MAP_FS, defines: { RM_DBG_WMASK: true } });
    prog.trueW ??= core.program('rm-true-wmask', { vs: TRUE_VS, fs: TRUE_FS, defines: { RM_DBG_WMASK: true } });
    const grab = f => { core.fbo(probeT); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); f(); const a = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a); return a; };
    gl.disable(gl.BLEND);
    const A = grab(() => drawMap(view, 1, prog.mapW)), B = grab(() => drawTrue(view, 1, prog.trueW));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    const both = new Uint8Array(W * H), a = new Uint8Array(W * H), b = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { both[i] = A[i * 4 + 3] > 0 && B[i * 4 + 3] > 0 ? 1 : 0; a[i] = A[i * 4] > 127 ? 1 : 0; b[i] = B[i * 4] > 127 ? 1 : 0; }
    const edge = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (a[i] !== a[i + 1] || a[i] !== a[i + W] || b[i] !== b[i + 1] || b[i] !== b[i + W]) edge[i] = 1; }
    const R = 4, rowD = new Uint8Array(W * H), near = new Uint8Array(W * H); // box dilation, separable
    for (let y = 0; y < H; y++) { let last = -1e9; for (let x = 0; x < W; x++) { if (edge[y * W + x]) last = x; if (x - last <= R) rowD[y * W + x] = 1; } last = 1e9; for (let x = W - 1; x >= 0; x--) { if (edge[y * W + x]) last = x; if (last - x <= R) rowD[y * W + x] = 1; } }
    for (let x = 0; x < W; x++) { let last = -1e9; for (let y = 0; y < H; y++) { if (rowD[y * W + x]) last = y; if (y - last <= R) near[y * W + x] = 1; } last = 1e9; for (let y = H - 1; y >= 0; y--) { if (rowD[y * W + x]) last = y; if (last - y <= R) near[y * W + x] = 1; } }
    let px = 0, coastal = 0, xor = 0, xorAll = 0, wa = 0, wb = 0;
    for (let i = 0; i < W * H; i++) {
      if (!both[i]) continue; px++; wa += a[i]; wb += b[i];
      if (a[i] !== b[i]) xorAll++;
      if (near[i]) { coastal++; if (a[i] !== b[i]) xor++; }
    }
    // the plan's tolerance band: pixels within 1/14 deed (one MAP lattice cell) of the water line in either layer
    const band = Math.max(1, Math.round(view.d / 14)), dist = new Float32Array(W * H).fill(1e9);
    for (let y = 0; y < H; y++) { let last = -1e9; for (let x = 0; x < W; x++) { if (edge[y * W + x]) last = x; dist[y * W + x] = x - last; } last = 1e9; for (let x = W - 1; x >= 0; x--) { if (edge[y * W + x]) last = x; dist[y * W + x] = Math.min(dist[y * W + x], last - x); } }
    let coastalBand = 0, xorBand = 0;
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { const i = y * W + x; if (!both[i]) continue; let dm = dist[i]; for (let k = 1; k <= band && dm > k; k++) { if (y - k >= 0) dm = Math.min(dm, Math.hypot(dist[(y - k) * W + x], k)); if (y + k < H) dm = Math.min(dm, Math.hypot(dist[(y + k) * W + x], k)); } if (dm <= band) { coastalBand++; if (a[i] !== b[i]) xorBand++; } }
    const res = { W, H, d: view.d, px, mapWater: wa, trueWater: wb, coastal4px: coastal, xor4px: xor, xorPct4px: coastal ? +(100 * xor / coastal).toFixed(3) : 0,
      bandPx: band, coastalBand, xorBand, xorPctBand: coastalBand ? +(100 * xorBand / coastalBand).toFixed(3) : 0, xorAllPct: px ? +(100 * xorAll / px).toFixed(3) : 0 };
    if (opts.img && typeof OffscreenCanvas !== 'undefined') { // R = MAP water, G = TRUE water (rows flipped to screen order)
      const cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d'), im = cx.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (H - 1 - y) * W + x, o = (y * W + x) * 4; im.data[o] = a[i] * 255; im.data[o + 1] = b[i] * 255; im.data[o + 2] = both[i] ? 40 : 0; im.data[o + 3] = 255; }
      cx.putImageData(im, 0, 0); res.imgPromise = cv.convertToBlob({ type: 'image/png' });
    }
    return res;
  }
  /** TRUE record page of deed (dx, dy) read back: the 98×98 vertex classes (meta & 15), or null when not resident. */
  function readPage(dx, dy) {
    if (!trueSt || !trueSt.lru.has(dy * cols + dx)) return null;
    const layer = trueSt.table[dy * cols + dx] - 1, u32 = new Uint32Array(98 * 98 * 4), out = new Uint8Array(98 * 98);
    core.fbo(trueSt.rec, layer); gl.readPixels(0, 0, 98, 98, gl.RGBA_INTEGER, gl.UNSIGNED_INT, u32);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < 98 * 98; i++) out[i] = u32[i * 4 + 3] & 15;
    return out;
  }
  // QA: the whole TRUE record page of a resident deed (Uint32Array 98·98·4: base, overlay 1, overlay 2, meta per tile)
  function readRecords(dx, dy) {
    if (!trueSt || !trueSt.lru.has(dy * cols + dx)) return null;
    const layer = trueSt.table[dy * cols + dx] - 1, u32 = new Uint32Array(98 * 98 * 4);
    core.fbo(trueSt.rec, layer); gl.readPixels(0, 0, 98, 98, gl.RGBA_INTEGER, gl.UNSIGNED_INT, u32);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return u32;
  }
  function drawChart(view, alpha) {
    const p = prog.chart.use();
    p.tex('uChart8', 0, T.chart8).tex('uChart16', 1, c16?.arr ?? dummy('fA')).tex('uDeeds', 2, T.deeds).tex('uFieldsA', 4, T.fieldsA ?? dummy('f2')).tex('uFar', 5, T.far);
    const tab = new Int32Array(64); if (c16) tab.set(c16.table);
    gl.uniform4iv(p.u('uC16Page'), tab);
    gl.uniform4i(p.u('uC16Geo'), c16?.px ?? 0, c16?.py ?? 0, C16_PAGE, c16 && view.d >= BANDS.chart16 ? 1 : 0);
    gl.uniform3fv(p.u('uSeaFar'), pal?.seaFar ?? [0.05, 0.13, 0.27]); gl.uniform1f(p.u('uAlpha'), alpha);
    core.fullscreen();
  }
  function drawMap(view, alpha, program = prog.map) {
    const p = program.use(); setFieldUniforms(p); setClassifyUniforms(p);
    p.tex('uMpKit', 0, T.mapkit).tex('uMpMask', 1, T.mapmask).tex('uMpLattice', 2, lat.arr).tex('uRmFieldsA', 3, T.fieldsA).tex('uRmFieldsBC', 4, T.fieldsBC)
      .tex('uRmLineTex', 5, T.lt.tex).tex('uMpTone', 7, T.tone ?? dummy('f2')).tex('uRmBase', 8, baseTex()).tex('uMpPlots', 9, T.plots ?? dummy('f2'))
      .tex('uMpRec', 10, trueSt?.rec ?? dummy('u16A')).tex('uMpPage', 11, T.pageTable ?? dummy('u16')).tex('uMpFar', 12, T.far);
    gl.uniform3fv(p.u('uMpSeaFar'), pal.seaFar); gl.uniform4iv(p.u('uMpNz'), T.nz);
    // the MAP water line takes TRUE's vertex classes wherever a page is resident (resolved from d 600)
    gl.uniform1i(p.u('uMpVtx'), trueSt && view.d >= BANDS.pageResolve ? 1 : 0);
    gl.uniform4fv(p.u('uMpYard'), T.yard ?? new Float32Array(84)); gl.uniform4fv(p.u('uMpYardT'), T.yardT ?? new Float32Array(84));
    gl.uniform1f(p.u('uMpYardW'), T.plots ? (view.w?.decor ?? 0) : 0);
    gl.uniform4i(p.u('uMpLat'), LAT_PAGE, lat.px, lat.W, lat.H);
    const terr = new Int32Array(16); terr.set(mapT.terr); gl.uniform4iv(p.u('uMpTerr4'), terr);
    const fam = new Int32Array(24); T.mapLayout.fam.forEach((f, s) => fam.set(f, s * 4)); gl.uniform4iv(p.u('uMpFam'), fam);
    gl.uniform1i(p.u('uMpObst'), mapT.obst); gl.uniform1i(p.u('uMpClr'), mapT.clr);
    const wang = new Int32Array(24); T.mapLayout.wang.forEach((f, s) => wang.set(f, s * 4)); gl.uniform4iv(p.u('uMpWang'), wang);
    const ord = mapT.order.concat([0, 0, 0, 0, 0]);
    gl.uniform4i(p.u('uMpOrder'), ord[0], ord[1], ord[2], ord[3]); gl.uniform1i(p.u('uMpOrder5'), ord[4]);
    gl.uniform2i(p.u('uMpWild'), T.mapLayout.wild[0], T.mapLayout.wild[1]); gl.uniform2i(p.u('uMpField'), T.mapLayout.field[0], T.mapLayout.field[1]);
    // P0 fix pass #2/#3 (W1 G5: now over d TONE_START 24 → TONE_END 80): the chart tone eases out (smoothstep in log d; it ran to d 400 and mottled
    // d 150–400), luminance relief in full, chroma within ±TONE_CHROMA of neutral; the per-slot family grade (uMpFamK)
    // carries the mean colour on to d 1100, linear in log d (GA2-05)
    const gt = clamp(Math.log(view.d / TONE_START) / Math.log(TONE_END / TONE_START), 0, 1), gradeW = 1 - gt * gt * (3 - 2 * gt);
    gl.uniform4f(p.u('uMpGrade'), gradeW, T.tone ? 1 : 0, alpha, meta.id === 'cinderfall' ? 1 : 0);
    gl.uniform2f(p.u('uMpToneK'), 1, TONE_CHROMA);
    const famW = 1 - clamp(Math.log(view.d / 48) / Math.log(1100 / 48), 0, 1);
    gl.uniform3fv(p.u('uMpFamK'), new Float32Array((T.famK ?? Array.from({ length: 6 }, () => [1, 1, 1])).flat())); gl.uniform1f(p.u('uMpFamW'), famW);
    // GA2-07: MAP water eases from the painting's colours (FAR continuity) to the kit water loop TRUE draws (d 150 → 800,
    // linear in log d), with TRUE's own depth tint; the lava realm keeps its sea (its kit loop is the lava, GA2-03)
    const kw = T.kitWater, wk = kw ? clamp(Math.log(view.d / 150) / Math.log(800 / 150), 0, 1) : 0, lava = meta.id === 'cinderfall', seaLava = !!T.seaIsLava;
    const tint = deepTint(pal.deep, meta), mixc = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const kSea = kw ? kw.map((v, i) => v * (1 + (tint[i] - 1) * 2 / 3)) : null, kDeep = kw ? kw.map((v, i) => v * tint[i]) : null;
    const wS = seaLava ? 0 : wk;
    // fix iteration 2 #15: rivers and lakes take the kit water loop's colour (what TRUE draws) by d 120 — the painting's
    // bright river turquoise only at the FAR→MAP hand-over (d 48), where it continues the chart (fix pass #6: from the
    // painting's WATER colour, paintWater; `water` is PACK's kit water, so Solana's pale crystal rivers read dark steel by d 49)
    const wkIn = clamp(Math.log(view.d / 48) / Math.log(120 / 48), 0, 1);
    const e = pal.edge, cls = [wS ? mixc(pal.shallow, kw, wS) : pal.shallow, wS ? mixc(pal.sea, kSea, wS) : pal.sea, wS ? mixc(pal.deep, kDeep, wS) : pal.deep, pal.foam, pal.beach,
      !lava && T.kitInland ? mixc(pal.paintWater, T.kitInland, wkIn) : pal.water, pal.bank, pal.road, pal.roadEdge, pal.turf, e[0], e[1], e[2], pal.wet];
    gl.uniform3fv(p.u('uMpPal'), new Float32Array(cls.flat()));
    const wall = new Float32Array(24); pal.wall.forEach((c, i) => wall.set(c, (i + 1) * 4)); gl.uniform4fv(p.u('uMpWall'), wall);
    // fix round 1 #11: no deed grid over the map below d 150 (it read as graph paper); faint (α ≤ 0.045) over d 150–1000
    const lineA = 0.045 * clamp((view.d - 150) / 150, 0, 1) * (1 - clamp(Math.log(view.d / 500) / Math.log(2), 0, 1));
    const trackW = 1 - clamp(Math.log(view.d / 500) / Math.log(800 / 500), 0, 1); // the south track has no TRUE twin
    gl.uniform4f(p.u('uMpDeedLine'), lineA, trackW, 0, 0);
    const thin = q.has('gthin') ? Number(q.get('gthin')) : (meta.map?.trueThin ?? TRUE_THIN[meta.id] ?? 0); // (?gthin: QA measurement only)
    const share = thin * clamp(Math.log(view.d / THIN_D[0]) / Math.log(THIN_D[1] / THIN_D[0]), 0, 1); st.thin = { share: +share.toFixed(3), mask: mapT.clr };
    gl.uniform2f(p.u('uMpThin'), share, 0); gl.uniform1i(p.u('uMpThinMask'), mapT.clr);
    // Stage B: the gem sea (off until TRUE's loop colours are measured, and in every realm without a share)
    const gs = T.gemK ? waterGems(meta) * clamp(Math.log(view.d / GEM_D[0]) / Math.log(GEM_D[1] / GEM_D[0]), 0, 1) : 0, gd = gemDrift(meta.true?.waterByClass?.SEA ?? meta.true?.water);
    gl.uniform4f(p.u('uMpGem'), gs, gd[0], gd[1], gs > 0 ? 1 : 0); gl.uniform3fv(p.u('uMpGemCol'), new Float32Array((T.gemK ?? [[1, 1, 1], [1, 1, 1]]).flat()));
    core.fullscreen();
  }
  function drawTrue(view, alpha, program = prog.true) {
    const p = program.use(); setFieldUniforms(p); setClassifyUniforms(p);
    p.tex('uTgA', 0, T.gA).tex('uTgB', 1, T.gB).tex('uTgDecal', 2, T.gDecal).tex('uTgMask', 3, T.gMask).tex('uTgRec', 4, trueSt.rec).tex('uTgDecalBox', 5, T.gDecalBox)
      .tex('uTgPage', 6, T.pageTable).tex('uRmBase', 7, baseTex()).tex('uRmFieldsA', 8, T.fieldsA).tex('uRmLineTex', 9, T.lt.tex).tex('uRmFieldsBC', 10, T.fieldsBC);
    const wt = trueT.water, wi = trueT.inland; gl.uniform4i(p.u('uTgWater'), wt.first, wt.frames, wt.frameMs, wt.step); gl.uniform4i(p.u('uTgWater2'), wi.first, wi.frames, wi.frameMs, wi.step);
    // (RM-24, fix pass: slot 2 was the selected deed's gold outline; TRUE no longer draws it, the slot stays for the layout)
    gl.uniform3fv(p.u('uTgPal'), new Float32Array([...deepTint(pal.deep, meta), ...pal.foam, 0, 0, 0, 0, 0, 0]));
    gl.uniform4f(p.u('uTgOpt'), alpha, q.has('debugPages') ? 1 : 0, 10, gemHighlight(meta));
    core.fullscreen();
  }

  // ---- classes include binding (LIFE / BASES) ---------------------------------------------------------------------
  function bindClasses(p, first = 8) {
    p.tex('uRmLattice', first, lat?.arr ?? dummy('uA')).tex('uRmRecords', first + 1, trueSt?.rec ?? dummy('u16A'))
      .tex('uRmPageTable', first + 2, T.pageTable ?? dummy('u16')).tex('uRmBase', first + 3, baseTex() ?? dummy('rgba8ui'))
      .tex('uRmFieldsA', first + 4, T.fieldsA ?? dummy('f2')).tex('uRmLineTex', first + 5, T.lt?.tex ?? dummy('u32'))
      .tex('uRmFieldsBC', first + 6, T.fieldsBC ?? dummy('f2'));
    if (T.lt) { setFieldUniforms(p); setClassifyUniforms(p); }
    gl.uniform4i(p.u('uRmLat'), LAT_PAGE, lat?.px ?? 1, lat?.W ?? 0, lat?.H ?? 0);
    return first + 7;
  }

  // ---- W1 G1: band rehearsal (SHELL's GPU_SAFE.rehearse contract; docs/realm-map/lane-ground.md "rehearse contract") -------
  // A program's pipeline is built at its first draw, and SwiftShader also JIT-compiles each sampling routine the first time a
  // fragment executes it for a (texture format, view type, sampler state): P0's zero-fragment rehearsals left both to the band
  // change (MAP d 150 +4 GROUND first draws, 14.6–18.7 s). rehearse(prog) draws `prog` once per GL state its real draws use,
  // with REAL fragments: the display programs through their probe uniform uRhAt (the fragment is a chosen deed point, with
  // chosen gradients), the bake programs into small scratch targets of the real formats. Its textures are rehearsal copies
  // of the real ones' kinds — format, 2D / array, filter, mip mode — holding data that sends the fragment down every
  // sampling call site (lattice flags all set, a plot, a river page, a resident TRUE page with base, overlay, decal and
  // water). So it needs none of the realm's data: it works from load() on, before the MAP / TRUE data are in.
  // No uploads after the first call, no resolve, no cache change; SHELL holds the 1×1 scissor at the target's origin and
  // restores FBO, viewport, blend and the VAO afterwards.
  let rh = null;
  function rhTextures() {
    if (rh) return rh;
    const lt8 = new Uint8Array(16 * 16);                 // lattice: class + 1 | water, plot flags; purity on alternate columns
    for (let i = 0; i < 256; i++) lt8[i] = ((i & 3) === 3 ? CLASS.FOREST : CLASS.WILD) + 1 | 16 | 64 | ((i & 1) ? 32 : 0);
    const lat8 = core.tex.array(16, 16, 1, 'R8UI'); core.tex.layer(lat8, 0, { data: lt8, w: 16, h: 16 });
    const kit = (filter, levels) => core.tex.array(32, 32, 1, 'RGBA8', { levels, filter });
    const u8 = new Uint8Array(16).fill(CLASS.WILD + 1); u8[5] = CLASS.WATER + 1; u8[6] = CLASS.FOREST + 1;
    const lt = new Uint32Array(64);                       // line fields 8×8: rows 0–6 = page 0's texels (a dry river / track sdf),
    lt.fill((toHalf(40) | (toHalf(2) << 16)) >>> 0, 0, 56); // row 7 = the deed's three header words (river page 0, land page 0, a bridge)
    lt[56] = 1 | (200 << 16) | (128 << 24); lt[57] = 1; lt[58] = packBridge(0.3, 30, 6, 1);
    const rec = new Uint16Array([1, 257, 0, CLASS.SEA | 1 << 6 | 1 << 7]); // base (array A), overlay 1 (array B, lower texels), wet, decal 0
    const mipped = core.tex.data(1, 1, 'RGBA8', null, null, new Uint8Array([90, 120, 80, 255]), { filter: 'linear', mips: true }); // 1×1: mip-complete
    rh = {
      lat: lat8, u8: core.tex.data(4, 4, 'R8UI', null, null, u8), t8: core.tex.data(4, 4, 'R8UI', null, null, null),
      t8a: core.tex.array(4, 4, 1, 'R8UI'), trec: core.tex.array(4, 4, 1, 'RGBA16UI'),
      base: core.tex.data(1, 1, 'RGBA8UI', null, null, new Uint8Array([KIND.open, FLAG.occupied, PLOT_GEOM[RH_L].claim, RH_L])),
      fA: core.tex.data(2, 2, 'RGBA8', null, null, new Uint8Array(16).fill(150), { filter: 'nearest' }), // coast / lake +44 t: dry
      fBC: core.tex.data(2, 2, 'RGBA8', null, null, new Uint8Array(16).fill(200), { filter: 'nearest' }),
      lt: core.tex.data(8, 8, 'R32UI', null, null, lt), deeds: core.tex.data(1, 1, 'R8UI', null, null, new Uint8Array([DEED_PX.thisRealm])),
      far: core.tex.data(1, 1, 'R8', null, null, new Uint8Array([8]), { filter: 'linear' }),
      lin: core.tex.data(1, 1, 'RGBA8', null, null, new Uint8Array([128, 128, 128, 255]), { filter: 'linear' }), // tone, plots
      mipped, c16: core.tex.array(1, 1, 1, 'RGBA8', { filter: 'linear' }),
      kitLin: kit('linear', 6), kitNear: kit('nearest', 6), near1: core.tex.array(1, 1, 1, 'RGBA8', { filter: 'nearest' }),
      box: core.tex.data(1, 1, 'RGBA8', null, null, new Uint8Array([0, 0, 31, 31]), { filter: 'nearest' }),
      rec: core.tex.array(1, 1, 1, 'RGBA16UI'), page: core.tex.data(1, 1, 'R16UI', null, null, new Uint16Array([1])),
    };
    core.tex.layer(rh.rec, 0, { data: rec, w: 1, h: 1 });
    for (const k of ['fA', 'f2', 'u16A', 'u16']) dummy(k); // (the stand-ins the real draws bind while a band's data is missing: made now, not in the hook)
    return rh;
  }
  const RH_L = 5; // the rehearsal plot's keep level
  function rhFields(p) { // the rm-fields uniforms over the rehearsal textures: a 1×1-deed grid with a plot and a bridge
    setFieldUniforms(p); gl.uniform4i(p.u('uRmGrid'), 1, 1, 0, 1); gl.uniform4i(p.u('uRmLinesGeo'), 1, 7, 8, 0);
    p.tex('uRmBase', 7, rh.base).tex('uRmFieldsA', 8, rh.fA).tex('uRmLineTex', 9, rh.lt).tex('uRmFieldsBC', 10, rh.fBC);
  }
  function rhBake(target, layer = 0) { core.fbo(target, layer); gl.viewport(0, 0, target.w, target.h); gl.disable(gl.BLEND); core.fullscreen(); }
  function rehearse(pr, view = null) {
    if (!P || !pr?.ready || !cfg) return false;
    const R = rh ?? rhTextures(), po = plotOffset(0, 0, RH_L), cx = (49 + po.dx + 0.5) / TILES, cy = (49 + po.dy + 0.5) / TILES;
    const probe = (x, y, w, vtx) => { gl.uniform4f(pr.u('uRhAt'), x, y, 1, w); if (vtx !== undefined) gl.uniform1i(pr.u('uMpVtx'), vtx); };
    const fade = on => { if (on) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND); };
    // once the realm's data is in, the same states again with the REAL textures at the real view centre (the box SHELL
    // placed there): a driver that keys its per-texture work on the texture object, not its kind, is covered too (SHELL's
    // open question on the W1 band-change tasks); the probe off, blend as the caller set it
    const real = draw => { pr.use(); gl.uniform4f(pr.u('uRhAt'), 0, 0, 0, 0); draw(); };
    const display = pr === prog.chart || pr === prog.map || pr === prog.true || pr === prog.mapW || pr === prog.trueW;
    const p = pr.use();
    try {
      if (pr === prog.raw) {                             // the classifier at a dry vertex outside the plot: every field it reads
        setClassifyUniforms(p); rhFields(p); gl.uniform4i(p.u('uRsOrigin'), 3, 3, 1, 0); rhBake(R.t8);
      } else if (pr === prog.dsp) { p.tex('uDsSrc', 0, R.u8); gl.uniform1i(p.u('uDsMode'), 12); rhBake(R.t8); }
      else if (pr === prog.leg) { if (mapT) setLegalise(mapT.lg, false, [1, 1]); else gl.uniform2i(p.u('uLgShift'), 1, 1); p.tex('uLgSrc', 0, R.u8); rhBake(R.t8); }
      else if (pr === prog.pure) { p.tex('uPuSrc', 0, R.u8); gl.uniform2i(p.u('uPuShift'), 1, 1); gl.uniform1iv(p.u('uPuSlot'), new Int32Array(14)); rhBake(R.t8a); }
      else if (pr === prog.rec) { p.tex('uTrV', 0, R.u8); gl.uniform2i(p.u('uTrDeed'), 0, 0); gl.uniform4i(p.u('uTrClaim'), 0, 0, 3, 3); rhBake(R.trec); }
      else if (pr === prog.chart) {                      // opaque, the bottom layer (draw()): chart8 and a resident chart16 page
        p.tex('uChart8', 0, T.chart8 ?? R.mipped).tex('uChart16', 1, c16?.arr ?? R.c16).tex('uDeeds', 2, R.deeds).tex('uFieldsA', 4, R.fA).tex('uFar', 5, R.far);
        gl.uniform4iv(p.u('uC16Page'), Int32Array.from({ length: 64 }, (_, i) => (i ? 0 : 1))); gl.uniform4i(p.u('uC16Geo'), 1, 1, C16_PAGE, 1);
        gl.uniform3fv(p.u('uSeaFar'), pal?.seaFar ?? [0.05, 0.13, 0.27]); gl.uniform1f(p.u('uAlpha'), 1);
        probe(0.5, 0.5, 0); fade(false); core.fullscreen();
        if (view) real(() => drawChart(view, 1));
      } else if (pr === prog.map || pr === prog.mapW) {
        rhMap(p, R);
        probe(cx, cy, 0, 1); fade(false); core.fullscreen();      // at rest: opaque, magnified, the plot's claim (yard), TRUE corners
        probe(0.02, 0.02, 1, 0); fade(true); core.fullscreen();   // the FAR→MAP fade: blended, minified, dry land (the tone grade)
        if (view && ready.map && lat && mapT) { fade(false); real(() => drawMap(view, 1, pr)); fade(true); real(() => drawMap(view, 0.5, pr)); }
      } else if (pr === prog.true || pr === prog.trueW) {
        rhTrue(p, R);
        probe(0.002, 0.002, 0); fade(false); core.fullscreen();   // at rest: opaque, magnified
        probe(0.002, 0.002, 1); fade(true); core.fullscreen();    // the MAP→TRUE fade: blended, minified
        if (view && ready.true && trueSt) { fade(false); real(() => drawTrue(view, 1, pr)); fade(true); real(() => drawTrue(view, 0.5, pr)); }
      } else return false;
    } finally {
      if (display && pr.ready) { pr.use(); gl.uniform4f(pr.u('uRhAt'), 0, 0, 0, 0); } // the real draws never set it
      gl.disable(gl.BLEND);
    }
    return true;
  }
  function rhMap(p, R) { // drawMap's state over the rehearsal textures (units as drawMap binds them)
    setFieldUniforms(p); setClassifyUniforms(p); gl.uniform4i(p.u('uRmGrid'), 1, 1, 0, 1); gl.uniform4i(p.u('uRmLinesGeo'), 1, 7, 8, 0);
    p.tex('uMpKit', 0, T.mapkit ?? R.kitLin).tex('uMpMask', 1, T.mapmask ?? R.kitNear).tex('uMpLattice', 2, R.lat).tex('uRmFieldsA', 3, R.fA).tex('uRmFieldsBC', 4, R.fBC)
      .tex('uRmLineTex', 5, R.lt).tex('uMpTone', 7, T.tone ?? R.lin).tex('uRmBase', 8, R.base).tex('uMpPlots', 9, T.plots ?? R.lin)
      .tex('uMpRec', 10, R.rec).tex('uMpPage', 11, R.page).tex('uMpFar', 12, R.far);
    gl.uniform3fv(p.u('uMpSeaFar'), [0.05, 0.13, 0.27]); gl.uniform4iv(p.u('uMpNz'), T.nz);
    const yard = new Float32Array(84), yardT = new Float32Array(84); yard.set([0, 0, 1, 1], RH_L * 4); yardT.set([-1000, -1000, 5000, 1], RH_L * 4);
    gl.uniform4fv(p.u('uMpYard'), yard); gl.uniform4fv(p.u('uMpYardT'), yardT); gl.uniform1f(p.u('uMpYardW'), 1);
    gl.uniform4i(p.u('uMpLat'), 16, 1, 16, 16);
    const terr = new Int32Array(16); terr[CLASS.FOREST] = 1; gl.uniform4iv(p.u('uMpTerr4'), terr);
    const fam = new Int32Array(24); fam.set([4, 1, 0, 0], 4); gl.uniform4iv(p.u('uMpFam'), fam);
    gl.uniform1i(p.u('uMpObst'), 0); gl.uniform1i(p.u('uMpClr'), 0); gl.uniform4iv(p.u('uMpWang'), new Int32Array(24));
    gl.uniform4i(p.u('uMpOrder'), 1, 0, 0, 0); gl.uniform1i(p.u('uMpOrder5'), 0); gl.uniform2i(p.u('uMpWild'), 0, 4); gl.uniform2i(p.u('uMpField'), 0, 0);
    gl.uniform4f(p.u('uMpGrade'), 1, 1, 1, meta?.id === 'cinderfall' ? 1 : 0); gl.uniform2f(p.u('uMpToneK'), 1, TONE_CHROMA);
    gl.uniform3fv(p.u('uMpFamK'), new Float32Array(18).fill(1)); gl.uniform1f(p.u('uMpFamW'), 1);
    gl.uniform3fv(p.u('uMpPal'), new Float32Array(42).fill(0.5)); gl.uniform4fv(p.u('uMpWall'), new Float32Array(24)); gl.uniform4f(p.u('uMpDeedLine'), 0.045, 1, 0, 0);
  }
  function rhTrue(p, R) { // drawTrue's state over the rehearsal textures: gB and the decals of the kinds this realm binds
    const t = meta?.true ?? {}, bigB = (t.atlas?.layers ?? 0) + (t.atlas?.reserved0 ? 0 : 1) > 256;
    setFieldUniforms(p); setClassifyUniforms(p); gl.uniform4i(p.u('uRmGrid'), 1, 1, 0, 1); gl.uniform4i(p.u('uRmLinesGeo'), 1, 7, 8, 0);
    p.tex('uTgA', 0, T.gA ?? R.kitLin).tex('uTgB', 1, T.gB ?? (bigB ? R.kitLin : dummy('fA'))).tex('uTgDecal', 2, T.gDecal ?? (t.decals?.file ? R.near1 : dummy('fA')))
      .tex('uTgMask', 3, T.gMask ?? R.near1).tex('uTgRec', 4, R.rec).tex('uTgDecalBox', 5, t.decals?.file ? R.box : dummy('f2'))
      .tex('uTgPage', 6, R.page).tex('uRmBase', 7, R.base).tex('uRmFieldsA', 8, R.fA).tex('uRmLineTex', 9, R.lt).tex('uRmFieldsBC', 10, R.fBC);
    gl.uniform4i(p.u('uTgWater'), 1, 1, 200, 0); gl.uniform4i(p.u('uTgWater2'), 1, 1, 200, 0);
    gl.uniform3fv(p.u('uTgPal'), new Float32Array(12).fill(0.5)); gl.uniform4f(p.u('uTgOpt'), 1, 0, 10, 0);
  }

  const api = {
    ready, load, setBaseState, setBases, setOccupancy, update, draw, bindClasses, rehearse, mapReady,
    passes: view => { const p = passes(view); return { chart: p.chart, map: p.map, true: p.true }; },
    /** contracts.GROUND_API classState() (fix iteration 2, QA GA2 #10; missing until W1): GROUND's CPU class inputs for
     *  classify.classAt(fields, lines, state, [x, y], cfg) once the rivers are bent and the bridges built, else null. */
    classState: () => (ready.map && T.cpuFields && !reQ.running ? { fields: T.cpuFields, lines: T.lines, cfg, cols, rows, rivers: T.rivers, bridges: T.bridges } : null),
    stats: () => ({ ...st, pages: trueSt ? trueSt.lru.size : 0, latticePages: lat ? `${st.latticeResolved}/${lat.sx * lat.sy} sub-tiles` : null,
      latticeMissingInView: lastMissing, pagesMissingInView: lastPagesMissing, chart16Pages: c16 ? c16.lru.size : 0, geomVersion, mapAtlas: st.mapAtlas ?? null,
      // GA2-16: what QA's settle() reads — lattice sub-tiles + TRUE pages still to resolve in view, chart16 pages loading
      missing: lastMissing + lastPagesMissing + (c16 ? c16.pending.size : 0),
      // P0 (d, e): the analytic worst case of the last frame (groundcost.js): texel fetches and loop iterations, per canvas
      // px, display passes (at SHELL's ground scale k, core.lowres) vs resolve slices. QA-only (stats() is never per frame).
      cost: (() => { const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, k = core.stats?.()?.gpu?.groundScale ?? 1;
        const c = frameCost({ w, h, k, drawn: st.drawn ?? {}, subs: st.lastSubs ?? 0, pages: st.lastPages ?? 0, despecklePasses: DESPECKLE_PASSES });
        return { groundScale: +k.toFixed(3), fetchesM: +(c.fetches / 1e6).toFixed(1), perPx: +c.perPx.toFixed(1), itersPerPx: +c.itersPerPx.toFixed(1),
          passesPerPx: +c.passesPerPx.toFixed(1), resolvePerPx: +c.resolvePerPx.toFixed(1), budget: { perPx: FRAME_BUDGET, itersPerPx: FRAME_ITER_BUDGET } }; })(),
      trueReady: ready.true, mapReady: ready.map, work: workLog() }),
    dispose() { disposed = true; clearTimeout(preT); for (const [k, v] of Object.entries(T)) if (v && v.t !== undefined && !SHARED_T.has(k)) core.tex.free(v); if (T.lt?.tex) core.tex.free(T.lt.tex); if (lat) { core.tex.free(lat.arr); for (const t of lat.steps) core.tex.free(t); } if (c16) core.tex.free(c16.arr); if (trueSt) { core.tex.free(trueSt.rec); for (const t of trueSt.steps) core.tex.free(t); } for (const v of Object.values(dummies)) core.tex.free(v); if (rh) for (const v of Object.values(rh)) core.tex.free(v); if (probeT) core.tex.free(probeT); },
    /** QA: the JS reference over the same inputs (parity tests in the browser). */
    debug: () => ({ cfg, cols, rows, fields: T.cpuFields, lines: T.lines, base: baseCpu, state: { cols, rows, data: baseCpu, bridges: T.bridges, rivers: T.rivers }, bridges: T.bridges, rivers: T.rivers, mapTables: mapT, trueTable: trueT?.table, lat, readLattice, readPage, readRecords, resolveRegion,
      residentPages: () => (trueSt ? [...trueSt.lru.keys()].map(k => [k % cols, Math.floor(k / cols)]) : []),
      probeWater: (opts = {}) => new Promise(res => { probeReq = { resolve: res, opts }; core.invalidate(); }) }),
  };
  if (q.has('gqa')) globalThis.__realmGround = api; // QA probes (dev only): __realmGround.debug().probeWater() …
  return api;

  function readLattice(sub) { // read back one resolved sub-tile (QA parity)
    const sx = sub % lat.sx, sy = Math.floor(sub / lat.sx), lx = sx * SUB, ly = sy * SUB, pgx = Math.floor(lx / LAT_PAGE), pgy = Math.floor(ly / LAT_PAGE);
    core.fbo(lat.arr, pgy * lat.px + pgx);
    const out = new Uint8Array(SUB * SUB);
    const u32 = new Uint32Array(SUB * SUB * 4);
    gl.readPixels(lx - pgx * LAT_PAGE, ly - pgy * LAT_PAGE, SUB, SUB, gl.RGBA_INTEGER, gl.UNSIGNED_INT, u32);
    for (let i = 0; i < SUB * SUB; i++) out[i] = u32[i * 4];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { lx, ly, size: SUB, data: out };
  }
}
