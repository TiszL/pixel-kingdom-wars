// GROUND's analytic GPU cost model (P0, KNOWN_ISSUES RM-GPU-1: the realm map hung the owner's whole Mac GPU).
// Frame cost is answered here, never by running on the GPU (SwiftShader timings mean nothing; the real GPU is off limits).
//
// Unit: texel fetches (texelFetch / texture / textureLod / textureGrad calls EXECUTED) per fragment on each pass's worst
// path (every optional branch taken). Since P0 no ground shader walks a data-driven list: every loop has a literal bound
// and the river / track / land-bridge fields are baked per deed page (classify.js BAKE) and only sampled, so these
// counts are true upper bounds. groundcost.test.mjs re-counts the fetch CALL SITES of every GLSL function from the
// source (SITES below), so a new fetch cannot land without this model — and its budget test — seeing it.
//
// Pure module (no GL): ground.js imports the resolve geometry and per-frame budgets from here, so the model and the
// code cannot drift apart.

/** Fetch call sites per GLSL function body, by shader file and export (what the test re-counts from the source). */
export const SITES = Object.freeze({
  'classes:RM_FIELDS': { rmPlotLevel: 1, rmBilin: 4, rmCoastLake: 4, rmHdr: 1, rmPageAt: 1 },
  'classes:RM_CLASSIFY': { rmBC3: 4 },
  'classes:CLASSES': { rmLatTexel: 1, pageResident: 1, tileRecord: 2 },
  'resolve:DESPECKLE_FS': { main: 5 },
  'resolve:LEGALISE_FS': { main: 2 },
  'resolve:RECORD_FS': { main: 5 },
  'resolve:PURE_FS': { main: 2 },
  'chart:CHART_FS': { coastAt: 1, rmKeep: 1, main: 2 },
  'mapground:MAP_FS': { latAt: 1, kitAt: 2, maskAt: 1, vtxCls: 2, main: 5 },
  'trueground:TRUE_FS': { layerAt: 4, maskAt: 1, main: 4 },
});

// Executed fetches per call, worst path (a ternary or if/else between two sites executes one):
const H = {};
H.rmPlotLevel = 1;
H.rmNb = 9 * H.rmPlotLevel;                           // the 3×3 deeds' plot levels, once per point (P0)
H.rmBilin = 4; H.rmCoastLake = 4; H.rmBC3 = 4; H.rmBC = H.rmBilin;
H.rmPageSample = 4 * 1;                                // rmPageAt ×4 (1 at an exact vertex)
H.rmRiverW = 1 + H.rmPageSample;                       // header + page (the old code: ≤ 50 segments × 2 texels, per call)
H.rmLand = 1 + H.rmPageSample;
H.rmBridgeN = 9 * 1;                                   // G15: one packed header word per plotted deed of the 3×3 (literal loop)
// rmClassCore: rmNb, coast + lake, river, track, bridges, forest/field/rock, the relief gradient (4 × rmBilin), then the worse of
// the SNOW/ROCK exit (rmBC3) and the FIELD/SPECIAL/GROUND2 tail (parcel rmBC + rmBC3)
H.rmClassCore = H.rmNb + H.rmCoastLake + H.rmRiverW + H.rmLand + H.rmBridgeN + H.rmBC3 + 4 * H.rmBilin + Math.max(H.rmBC3, H.rmBC + H.rmBC3);
H.pageResident = 1; H.tileRecord = H.pageResident + 2; H.mapFlagsAt = 1; H.mapClassAt = 1;
// P0 "classes-sampled": the lattice texel, and near water the coast/lake bilinear + the river page (no classifier)
H.mapClassFine = 1 + H.rmCoastLake + H.rmRiverW;
H.classAtTile = H.pageResident + Math.max(H.tileRecord, H.mapClassFine);
H.latAt = 1; H.kitAt = 1; H.vtxCls = 2; H.layerAt = 1; H.maskAt = 1;
H.pasteAt = 5 * H.maskAt;                              // the texel + its 4 neighbours
export const HELPER = Object.freeze({ ...H });

/** Worst-case fetches per fragment of each ground pass. */
export const PASS = Object.freeze({
  chart: 2 + 1 + 1,                                    // chart8 / chart16, coastAt, rmKeep's far field (deeds: gone with the veil, 2026-09-26)
  // the cell's 4 lattice corners + the warped cell's 4 (W1 G2: P0 read the whole 4×4 block, 16), WILD + winning layer, base
  // state + plots + far, rmNb, land, coast/lake, river, bridges, and the worse of two passes that never run together: the
  // tone grade (1: d < 200) and the 4 TRUE corner classes (8: d ≥ 600)
  map: 8 * H.latAt + 2 * H.kitAt + 3 + H.rmNb + H.rmLand + H.rmCoastLake + H.rmRiverW + H.rmBridgeN + Math.max(1, 4 * H.vtxCls),
  // page + record + decal box + decal, the coast bilinear, water / base / two overlay layers, two pasteAt
  true: 4 + H.rmBilin + 4 * H.layerAt + 2 * H.pasteAt,
  raw: H.rmClassCore,                                  // the §3.2 class of one vertex (lattice or page resolve)
  despeckle: 5, legalise: 1 + 9, record: 5,
  pure: 1 + 8,                                         // W1 G2: the lattice purity bit (the texel + its 8 neighbours)
});
/**
 * Worst-case loop iterations per fragment of each pass (P0 (e): "texel fetches + loop iterations"): every loop body
 * execution reachable from main(), a loop inside a loop or a call counted once per enclosing trip, BOTH arms of every
 * branch counted (a conservative upper bound: each loop has a literal trip count, groundcost.test proves it). The test
 * re-derives these from the GLSL by walking each program's call graph, so a new loop or call cannot land unseen.
 */
// (P0 fix pass #1: MAP 139 → 159, raw 45 → 51, TRUE 10 → 14, chart 0 → 4 — the SAME value-noise evaluations as before,
// now in literal loops so each group compiles one inlined copy: rmLakeWarp 4, rmForeignCut 4, the MAP class-edge warp 4,
// its boundary noise 2, the coast octaves 2, the foreign fade 2, the island's shape octaves 2. Per-pixel work is
// unchanged; only its bookkeeping moved here. MAP sits 1 under the budget: a new MAP loop needs a real saving first.)
// (W1 G2: MAP 159 → 87 — the 4×4 lattice block's two 16-trip loops, its four 3×3 corner-Wang loops and the 9-trip
// neighbourhood reset are gone (−89: the lattice purity bit and four texel fetches stand in for them); the shared noise bank
// adds 2 × 16 + 2 + 3 trips for the seven small noise loops it replaces (+17). Per pixel the noises it evaluates are P0's.)
export const ITERS = Object.freeze({ chart: 4, map: 87, true: 14, raw: 51, despeckle: 80, legalise: 12, record: 46, pure: 9 });
/** One ground pass never costs more than this per fragment (a full-screen pass of it is the unit of the frame budget). */
export const PASS_BUDGET = 64;
/** ... nor more loop iterations than this per fragment (set at ≈ 1.15 × the MAP pass when it was the heaviest, 139). */
export const ITER_BUDGET = 160;
/** A whole frame (every ground pass drawn + the resolve slices) stays within this many fetches per canvas px. */
export const FRAME_BUDGET = 96;
/** ... and within this many loop iterations per canvas px. */
export const FRAME_ITER_BUDGET = 256;
/** Display passes (chart + MAP + TRUE, all drawn in a fade) per CANVAS px at the owner's screens with SHELL's ground cap. */
export const DISPLAY_BUDGET = 64;
/** The resolve slices of one frame stay within this many fetches per canvas px (time slicing, P0 (c)). */
export const RESOLVE_BUDGET = 6;

/** Resolve geometry (ground.js reads these): lattice sub-tile edge, its apron, the TRUE page raw apron per despeckle pass. */
// (W1 G2: apron 4 → 5 — despeckle ×2, legalise ×2 and the purity pass each read a 1-vertex neighbourhood)
export const RESOLVE = Object.freeze({ sub: 256, apron: 5, maxSubsFar: 3, maxSubsMap: 2, maxPages: 4 });

/** The passes of one lattice sub-tile resolve after the raw one, each 2 vertices smaller than the one before (ground.js resolveSub). */
export const LATTICE_PASSES = Object.freeze(['despeckle', 'despeckle', 'legalise', 'legalise', 'pure']);
/** Fetches (or, with per = ITERS, loop iterations) of one lattice sub-tile resolve (raw over the apron, then LATTICE_PASSES). */
export function subTileFetches(per = PASS) {
  const S = RESOLVE.sub, A = RESOLVE.apron, sq = n => n * n;
  return sq(S + 2 * A) * per.raw + LATTICE_PASSES.reduce((f, k, i) => f + sq(S + 2 * A - 2 * (i + 1)) * per[k], 0);
}
/** Fetches (or loop iterations, per = ITERS) of one TRUE page resolve (raw 99 + 2·top, despeckle passes, legalise ×2, records). */
export function pageFetches(despecklePasses, per = PASS) {
  const top = 2 + despecklePasses, size = i => 99 + 2 * i, sq = n => n * n;
  let f = sq(size(top)) * per.raw, i = top;
  for (let p = 0; p < despecklePasses; p++, i--) f += sq(size(i - 1)) * per.despeckle;
  for (; i > 0; i--) f += sq(size(i - 1)) * per.legalise;
  return f + 98 * 98 * per.record;
}
/**
 * P0 (c) time slicing: how many lattice sub-tiles and TRUE pages one frame may resolve on a canvas of `canvasPx` device
 * px — the most that keeps the slices within RESOLVE_BUDGET fetches per canvas px (at least one of each, so a view always
 * completes), capped by the band's own maximum. A phone resolves less per frame than a retina desktop.
 */
export function resolveBudget(canvasPx, { far = false, despecklePasses = 6 } = {}) {
  const room = RESOLVE_BUDGET * canvasPx, sub = subTileFetches(), page = pageFetches(despecklePasses);
  const maxSubs = far ? RESOLVE.maxSubsFar : RESOLVE.maxSubsMap;
  const pages = Math.max(1, Math.min(RESOLVE.maxPages, Math.floor((room - sub) / page)));
  const subs = Math.max(1, Math.min(maxSubs, Math.floor((room - pages * page) / sub)));
  return { subs, pages };
}
/**
 * Worst-case work of one frame on a w × h canvas: the display passes drawn over the ground target — k × the canvas per
 * axis (SHELL's ground resolution cap: core.lowres(k), k = groundScale(dpr, GPU_SAFE.groundPx[level]); ceil like
 * core.lowres) — plus the resolve slices (always canvas-budgeted, resolveBudget). → { fetches, iters, perPx and
 * itersPerPx (per CANVAS px), passesPerPx, resolvePerPx, groundPx }.
 */
export function frameCost({ w, h, k = 1, canvasPx = w * h, drawn = { chart: true, map: true, true: true }, subs = 0, pages = 0, despecklePasses = 6 }) {
  const px = k >= 0.999 ? w * h : Math.max(1, Math.ceil(w * k)) * Math.max(1, Math.ceil(h * k)), n = Math.max(1, canvasPx);
  const sum = per => (drawn.chart ? per.chart : 0) + (drawn.map ? per.map : 0) + (drawn.true ? per.true : 0);
  const passes = sum(PASS) * px, resolve = subs * subTileFetches() + pages * pageFetches(despecklePasses);
  const iters = sum(ITERS) * px + subs * subTileFetches(ITERS) + pages * pageFetches(despecklePasses, ITERS);
  return { fetches: passes + resolve, iters, perPx: (passes + resolve) / n, itersPerPx: iters / n, passesPerPx: passes / n, resolvePerPx: resolve / n, groundPx: px };
}

// ---- P0 fix pass #6/#7: cache demand vs capacity (main-thread + upload work per frame) ------------------------------
/**
 * Which cached pages one frame keeps and which it asks for. want = [key, distance] of every page the view would use (any
 * order), cap = the cache's capacity, has(key) = resident (or already on its way). The nearest `cap` are KEPT — the
 * caller touches the resident ones farthest-first, so the LRU evicts only pages outside the keep set — and only their
 * missing ones are requested, nearest first, at most `budget`. The rest fall back (chart8 under FAR, MAP under TRUE) and
 * are NOT missing. Why: a view that wants more pages than the cache holds evicted a visible page to make room every
 * frame, never idled (missing > 0 invalidates) and shimmered between the two layers (the critic's 63–96 TRUE pages
 * against 48 on retina desktops; 20–32 chart16 pages against 16).
 * → { keep: [key …] nearest first, fetch: [key …], missing: kept pages not resident }
 */
export function planPages(want, cap, has, budget = Infinity) {
  const keep = want.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, Math.max(0, cap)).map(e => e[0]);
  const miss = keep.filter(k => !has(k));
  return { keep, fetch: miss.slice(0, Math.max(0, budget)), missing: miss.length };
}
/**
 * TRUE record pages a W × H device-px view can want (ground.js pageWork): the deeds its rect spans (≤ ceil(W / d) + 1 per
 * axis) plus the 1-deed margin ring, largest at the widest zoom that resolves pages (d = BANDS.pageResolve, device px per deed).
 */
export function pageDemand(wDev, hDev, d) { return (Math.ceil(wDev / d) + 3) * (Math.ceil(hDev / d) + 3); }
/** The TRUE record cache (98² RGBA16UI layers, 76.8 KB each): sized from the screen, never below 48, never above 160 (12 MB). */
export const REC_PAGES = Object.freeze({ min: 48, max: 160 });
export function recCapacity(wDev, hDev, d) { return Math.min(REC_PAGES.max, Math.max(REC_PAGES.min, pageDemand(wDev, hDev, d))); }
