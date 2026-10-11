// Realm maps — semantic classes (docs/REALM-MAP-PLAN.md §3.2). GROUND lane.
// The pure-JS reference of the GPU resolve passes (glsl/classes + glsl/resolve): the same maths in
// integer hashes and plain float, used by offline QC (PACK qc-pack), parity tests and classify.test.
// Coordinates are realm TILE VERTICES: tile = deed·98 + local, origin at the pack grid.
// Deviations from the plan text (each argued in docs/realm-map/lane-ground.md "Decisions"):
//   G1  inland forcing uses its own smooth-max width (cfg.inlandK = 2, plan says 6): with k = 6 the
//       smax lift (≤ k/4) dries the moat ring at the plot diagonals, where only ~4.2 t separate the
//       rounded plot corner from r = R. (The coast now forces over the island rim, G6.) smax ≥ max still
//       holds, so "plot < 3 ⇒ inland > 0" is unchanged.
//   G2, G3, G4, G6 (the radial lens, the explicit moat ring, the lens profile and the circular/squircle island rim) are
//       superseded by G16 (fix iteration 2): a plot in water no longer bends the water round itself.
//   G5  the RING edge wobbles outward only (superseded by G9/G13's organic clearing; cfg.ringNoise kept for overrides).
//   G7  despeckle at TRUE (resolveRegion step 1, the GPU page resolve): before legalise, DESPECKLE_PASSES (4)
//       Jacobi passes remove 1-vertex runs across the water line — fill: a dry vertex with water on both sides
//       along x or y (a 1-vertex spit, a diagonal row of land "beads") turns wet; erode: a water vertex with land
//       on both sides along x or y turns dry (majority neighbour class, fixed order L,R,U,D). Pass 0 only fills,
//       passes 1–5 do both (despeckleMode). Plot classes never flip. Six passes clear the staircase ends a pass
//       leaves behind. Each pass needs one more apron vertex. The MAP lattice (7-t) is not despeckled.
//   G8  (round 2, T3) plots sit at contracts.plotOffset (a hashed whole-tile offset inside the deed; visual only):
//       every plot centre is deed·98 + 49 + offset, and the island rim's deed bound becomes axisMax − max(|dx|,|dy|)
//       (plotGeom). A base may pin its offset (makeState `off: [dx, dy]`, tests); the product always hashes.
//   G9  (round 2, T3) the clearing is organic, not a rounded box with bumps (Gate A2 GA2-08 "pasted octagons"):
//       RING = clearingSdf < 0, a rounded box of half + extra with a large corner radius (it still contains the
//       plot box: corner ≤ extra·√2/(√2 − 1)) minus two octaves of outward value noise. Outside the plot box the
//       clearing never claims water (RING needs dry land there), so a big wobble cannot bead a moat or a coast.
//   G11 (fix round 1, "45° staircase class edges") the class LOOKUP is domain-warped (not the texture): rock, snow,
//       forest, special, ground2 and the field parcels are read at v + warp(v), three value-noise octaves (12 t over 44 t,
//       4 t over 14 t, 2 t over 6 t) plus a faint zig-zag (1.6 t, cell 5: it keeps value-noise flats from leaving long
//       straight runs; stronger it read as a regular sawtooth at TRUE), so class boundaries follow organic curves. The MAP lattice (7-t vertices)
//       takes the coarse octave only (the fine ones would alias into speckle there): cfg.warpFine.
//   G12 (fix round 1, "keep the realm's own ground under the yard") the plot ground no longer repaints the terrain. A
//       vertex in the clearing (always ⊇ the plot box + 1 t) is RING for everything that asks "may I put something here"
//       (classAt: LIFE, QC), but the TRUE and MAP ground draw its GROUND class (classDetail().ground): the class the rules
//       give without the plot. Only an organic apron of 1–2.5 t around the claim is RING ground (the kit ring the claim
//       turf pairs with, C8), and a 2-t feather beyond it keeps only ground classes (WILD, GROUND2, SHORE, ROAD), so the
//       claim never touches a terrain it has no kit transition with. resolveRegion carries the ring as a flag.
//   G13 (fix round 1, GA2-08 "octagons") the clearing is a round base (a rounded box of half + 4 with a 10-t corner:
//       it contains the plot box + 1 t on every ray) grown outward by per-deed 2θ/3θ lobes (0…4 t), value noise (0…2 t)
//       and zig-zag noise (±5 t, cell 4; the box + 1 t is RING whatever it does) — never a chamfered box.
//       classify.test fails on a straight run > 6 t.
//   G14 (fix round 1, "rivers are straight-edged bands") prepareLines meanders every river: its polyline is resampled
//       every 5 t and displaced by a smooth 2-D field (2.6 t over 26 t + 1 t over 9 t; the same field for every river,
//       so confluences stay joined), and half-widths vary ±30 % along the course (still clamped). Distances are taken
//       to the displaced polyline, so widths stay exact (a warped query point would thin a river where the warp
//       compresses). Lakes and the sea coast are read at a warped point (5 t over 29 t + 1.5 t over 9 t): lochs, sea
//       lochs and coasts lose their straight painted banks (the same warp for both, so a loch meets the sea cleanly).
//   G15 (fix round 1, T3 "natural islets and peninsulas") a plot with water in its lens gets a land bridge to the
//       nearest shore (or to a neighbouring plot's island, merging islets) when the gap is ≤ bridge.max: a tapered,
//       wobbling capsule that forces coast and inland dry (plotBridges, precomputed per plot; the GPU reads the same
//       force baked into the land pages, P0). A plot beside a river becomes a headland, not a ringed moat.
//   G16 (fix iteration 2, "plots in water get lens detours: rings, U-bays, oval islets, bulges") no lens, no moat. A plot's
//       ISLAND is its plot box grown by an organic margin (≥ force + 1 t: a per-deed corner radius, 2θ/3θ lobes and three
//       spatial noise octaves), forced dry over the sea, lakes and lava like the old coast headland (islandForce, evaluated
//       over the 3×3 deeds so it may spill past its deed); outside it the forcing falls at a noise-varied slope, so the
//       shallows round an islet vary in width. Rivers are not lensed and not forced by the island (only by the plot box):
//       bendRivers moves a river's meandered polyline ONE-SIDED away from each plot box (+ force + 1 t) it would cross (a plateau of the needed push around the plot, tapering off along the river;
//       one spatial field for every river so confluences stay joined). A river that clears every island is not moved at all.
//       A kingdom standing in a lake or the sea joins the nearer shore through G15's bridge (a broad headland when the shore
//       is close, a causeway further out, an islet beyond bridge.max).
import { TILES, CLASS, LINES, PLOT_CENTRE, FLAG, plotRule, plotOffset } from './contracts.mjs';
import { vnoise as commonNoise, pcg2d } from './glsl/common.glsl.mjs';

export const CLASS_COUNT = 14;
/** §3.2 step 5 rule order → legalise priority rank (0 = highest). SNOW rides with ROCK. */
const ORDER = ['TURF', 'RING', 'DEEP', 'SEA', 'WATER', 'SHORE', 'ROCK', 'SNOW', 'ROAD', 'FIELD', 'FOREST', 'SPECIAL', 'GROUND2', 'WILD'];
export const CLASS_RANK = Object.freeze(ORDER.reduce((a, n, i) => { a[CLASS[n]] = i; return a; }, new Array(CLASS_COUNT).fill(99)));
export const CLASS_NAME = Object.freeze(Object.fromEntries(Object.entries(CLASS).map(([k, v]) => [v, k])));

// ---- hashes -------------------------------------------------------------------------------------
/** The kit's realmKitTileHash (packages/shared/src/realmKit.ts), verbatim: 32-bit, unsigned result. */
export function kitHash(tx, ty) {
  let h = Math.imul(tx, 0x27d4eb2d) ^ Math.imul(ty, 0x165667b1) ^ 0x5bd1e995;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
/** Hash → [0,1) using the top 24 bits, exact in float32 (GLSL: float(h >> 8u) / 16777216.0). */
export const unit24 = h => (h >>> 8) / 16777216;

// ---- configuration (realm.json.classes overrides any key) ---------------------------------------
export const CLASS_CFG = Object.freeze({
  coastNoise: Object.freeze({ period: 20, amp: 3, seed: 0x1c0a }),
  // G10 (GA2-18): a second, finer coast octave so a straight painted shore never reads as a ruled 45° line at TRUE
  // fix iteration 2 #8/#12 ("TRUE lochs and coasts are straight polygon bands with long 45° runs"): 1.2 → 2.2 t on 7 t
  coastNoise2: Object.freeze({ period: 7, amp: 2.2, seed: 0x7c33 }),
  inlandNoise: Object.freeze({ period: 9, amp: 1, seed: 0x1a4e }),
  beachNoise: Object.freeze({ period: 8, amp: 1.6, seed: 0x2b17 }), // fix iteration 2 #12: no uniform sand rim (was 1 t on 11 t)
  coastK: 8, inlandK: 2, force: 3,           // coast: smax(·, islandForce, coastK) (G16); inland: smax(·, force − plot, inlandK) (G1)
  // contracts PLOT_OFFSET.rimGap budget: G16 islands are evaluated over the 3×3 deeds, so they need none of the deed's room
  rim: Object.freeze({ gap: 0 }),
  // G16 the island (global, not per realm: PLOT_GEOM and the GLSL uniforms are built from it): margin beyond the plot box =
  // base + (√2 − 1)(corner − 3) [so the rounder corner still clears box + force + 1] + lobe·(2θ/3θ harmonics) + amp·vnoise
  // + amp2·vnoise + zig·znoise (each term ≥ 0); corner ∈ [3, corner] per deed; outside, the forcing falls at slope·(1 ±
  // shallow·noise) (shallows of varying width); inland joins it with smooth-max k. Fix iteration 2 #13 ("identical egg /
  // squircle islets, uniform shallows" at d 120–500): lobes 3 → 9 t (each islet's own 2θ/3θ shape reads at map scale),
  // shallows ±80 % on a 17-t period (was ±55 % on 9 t). P0 fix pass #4 (islet shallows cut by straight lines at MAP): past
  // halo t outside the island the forcing plunges by haloDeep over haloFade t, so it is below any painted sea (+ coastK)
  // before the per-plot window (islandReach) and the lattice flag drop it — the shallows end on an organic contour
  island: Object.freeze({ base: 4, corner: 12, lobe: 9, amp: 3.5, period: 11, amp2: 2, period2: 5, zig: 1.2, zigCell: 3, slope: 2, shallow: 0.8, shallowPeriod: 17, k: 4, seed: 0x71c3,
    halo: 10, haloFade: 8, haloDeep: 300 }),
  // G16 one-sided river bends: clearance past the island (t), taper length (≥ taper t, ≥ taperK × the push), relaxation passes
  bend: Object.freeze({ clear: 1.5, taper: 26, taperK: 2, iters: 3, seed: 0x3b5d }),
  deepT: 12, beachW: 2, hasShore: false,
  rockT: 0.5, slopeT: Infinity, slopeStep: 6, snowT: 0.5,
  rockWaterGap: 2, rockPlotGap: 2, roadInland: 2, roadCoast: 3,
  fieldT: 0.5, forestT: 0.5, specialT: 0.5, g2T: 0.5,
  parcel: Object.freeze({ block: 28, min: 10, max: 18, salt: 0x9a3c }),
  plotMargin: 2, cornerRadius: 3,
  ringNoise: Object.freeze({ period: 9, amp: 3, seed: 0x5b1e }), // (G5, superseded by `clearing` since G9; kept for overrides)
  // (G13) the organic clearing: base = rounded box of half + extra with corner `corner` (contains the plot box + 1 t),
  // grown outward by per-deed 2θ/3θ lobes (0…lobe t) and two outward spatial value-noise octaves (t)
  // (the second octave is zig-zag noise, cell period2: the edge wiggles every ~4 t, never a straight run)
  clearing: Object.freeze({ extra: 4, corner: 10, lobe: 4, amp: 2, period: 9, amp2: 5, period2: 4, seed: 0x5b1e, seed2: 0x3c71 }),
  // (G12) the RING apron around the claim (t): min + amp·noise, then a feather band that keeps ground classes only
  apron: Object.freeze({ min: 1, amp: 1.5, period: 7, seed: 0x2e9d, feather: 2 }),
  // fix iteration 2 #13 ("every claim is a hard-edged pale rectangle pad" at TRUE): the claim turf frays outward on dry
  // land — a vertex within amp·max(0, noise) t of the claim box is TURF too — so the kit's own turf edge tiles draw a
  // ragged border like the game's softened claim, never a ruled rectangle. The claim box itself is unchanged.
  claimRag: Object.freeze({ amp: 2.2, period: 5, seed: 0x6e21 }),
  // (G11) domain warp of the class lookup (t); warpFine 0 drops the fine octave (MAP lattice)
  classWarp: Object.freeze({ amp: 12, period: 44, amp2: 4, period2: 14, amp3: 2, cell3: 6, zig: 1.6, zigCell: 5, seed: 0x3a91 }), warpFine: 1,
  // (G14) river meander: lines.json rivers resampled every `step` t and displaced by a smooth 2-D field (t), half-widths
  // ×(1 ± hw); lakes are read at a warped point (t)
  riverMeander: Object.freeze({ amp: 2.6, period: 26, amp2: 1.0, period2: 9, hw: 0.3, hwPeriod: 21, step: 5, seed: 0x6b2d }),
  lakeWarp: Object.freeze({ amp: 5, period: 29, amp2: 2.6, period2: 11, seed: 0x5e11 }), // fix iteration 2 #8: amp2 1.5 → 2.6 t
  // (G15) land bridges: max gap (t) from the island rim to the shore / a neighbour's rim, half-width + wobble, seed
  bridge: Object.freeze({ max: 30, w: 4, wAdd: 2, head: 1.6, wob: 1.2, wobPeriod: 5, taper: 0.35, dirs: 24, k: 3, seed: 0x4d3b }),
  riverNoiseReach: 2,                        // "within hw + 2 t of a river segment"
  far: 1e4,                                  // "+∞" for SDFs (finite so float32 GLSL matches)
});
export function classConfig(over = {}) {
  const o = { ...CLASS_CFG };
  for (const [k, v] of Object.entries(over ?? {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(CLASS_CFG[k] ?? {}), ...v } : v;
  if (o.slopeT === null) o.slopeT = Infinity;
  return o;
}

// ---- maths ----------------------------------------------------------------------------------------
/** Polynomial smooth min; smin(a,b,k) ≤ min(a,b), equal once |a−b| ≥ k. */
export function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
/** Polynomial smooth max; smax(a,b,k) ≥ max(a,b), equal once |a−b| ≥ k. */
export function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}
/** Value noise at integer vertex (x,y): common's pcg2d lattice noise (GLSL `vnoise(ivec2,int,uint)`), [−1, 1]. */
export const vnoise = (x, y, period, seed) => commonNoise(x, y, period, seed);
/**
 * Zig-zag noise (fix round 1): the mean of two value noises whose lattice values alternate in sign — one by lattice
 * column, one by lattice row (magnitude 0.5…1) — so along ANY line the field swings through zero every `cell` units and is
 * never flat for long (a checkerboard would cancel on its mid-lines; plain value noise can stay level for tens of tiles).
 * A boundary it moves wiggles every ~cell tiles: the "no straight run > 6 t" guarantee. [−1, 1]. GLSL twin: rmZNoise.
 */
export function znoise(x, y, cell, seed) {
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  let fx = (x - cx * cell) / cell, fy = (y - cy * cell) / cell;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const s0 = seed >>> 0, s1 = Math.imul(seed, 7) >>> 0;
  const mag = (i, j, k) => 0.5 + 0.5 * ((pcg2d((i ^ s0) >>> 0, (j ^ s1 ^ k) >>> 0)[0] >>> 8) / 16777216);
  const at = (i, j) => (i & 1 ? -mag(i, j, 0) : mag(i, j, 0)) + (j & 1 ? -mag(i, j, 0x55) : mag(i, j, 0x55));
  const a = at(cx, cy), b = at(cx + 1, cy), c = at(cx, cy + 1), d = at(cx + 1, cy + 1);
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
  return 0.5 * (ab + (cd - ab) * fy);
}

// ---- fields ---------------------------------------------------------------------------------------
/** Manual bilinear of one channel; texel i's centre sits at deed (i + 0.5)/ppd (the pack convention). */
export function bilinear(img, ppd, x, y, ch, x0 = 0, w = img.width) {
  const u = x * (ppd / TILES) - 0.5, v = y * (ppd / TILES) - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0;
  const n = img.channels ?? 3, H = img.height;
  const at = (i, j) => {
    const ii = i < 0 ? 0 : i >= w ? w - 1 : i, jj = j < 0 ? 0 : j >= H ? H - 1 : j;
    return img.data[(jj * img.width + x0 + ii) * n + ch];
  };
  const a = at(i0, j0), b = at(i0 + 1, j0), c = at(i0, j0 + 1), d = at(i0 + 1, j0 + 1);
  const top = a + (b - a) * fu, bot = c + (d - c) * fu;
  return top + (bot - top) * fv;
}
/**
 * Field samplers from the decoded pack images (plan §4.1): fieldsA RGB at 8 px/deed
 * (coast SDF · lake SDF · relief; SDFs encode 128 + d/2 in tiles, land > 0) and fieldsBC at 4 px/deed
 * in two halves side by side (left: forest, field, rock-paint · right: snow, ground2, special).
 * Images are { width, height, data, channels }. Returns tile-space samplers.
 */
export function makeFields({ fieldsA, fieldsBC, ppdA = 8, ppdBC = 4, bcHalves = 'x' }) {
  const half = bcHalves === 'x' ? fieldsBC.width / 2 : fieldsBC.width;
  const bcH = bcHalves === 'y' ? { ...fieldsBC, height: fieldsBC.height / 2 } : fieldsBC;
  const bc = (x, y, ch, second) => {
    if (bcHalves === 'y') return bilinear(second ? { ...bcH, data: fieldsBC.data.subarray(bcH.height * fieldsBC.width * (fieldsBC.channels ?? 3)) } : bcH, ppdBC, x, y, ch) / 255;
    return bilinear(fieldsBC, ppdBC, x, y, ch, second ? half : 0, half) / 255;
  };
  return {
    coast: (x, y) => (bilinear(fieldsA, ppdA, x, y, 0) - 128) * 2,
    lake: (x, y) => (bilinear(fieldsA, ppdA, x, y, 1) - 128) * 2,
    relief: (x, y) => bilinear(fieldsA, ppdA, x, y, 2) / 255,
    forest: (x, y) => bc(x, y, 0, false), field: (x, y) => bc(x, y, 1, false), rock: (x, y) => bc(x, y, 2, false),
    snow: (x, y) => bc(x, y, 0, true), ground2: (x, y) => bc(x, y, 1, true), special: (x, y) => bc(x, y, 2, true),
  };
}
/** Constant/function fields for tests and synthetic probes. */
export function synthFields(over = {}) {
  const k = v => typeof v === 'function' ? v : () => v;
  const d = { coast: 1000, lake: 1000, relief: 0, forest: 0, field: 0, rock: 0, snow: 0, ground2: 0, special: 0, ...over };
  return Object.fromEntries(Object.entries(d).map(([n, v]) => [n, k(v)]));
}

// ---- lines (lines.json) ------------------------------------------------------------------------------
/**
 * lines.json → per-deed segment lists. Accepted shape (tile coordinates, half-widths in tiles):
 *   { rivers: [{ pts: [[x,y],…] | [x0,y0,x1,y1,…], hw: [h…] | h }], tracks: [same] }
 * Half-widths are clamped here too (≥ riverHwMin / trackHwMin), so an unclamped file cannot bead.
 * P0 (RM-GPU-1, bounded work whatever the data): a point with a non-finite coordinate is dropped (the polyline is split
 * there), coordinates are clamped to the grid ± LINE_CAP.margin tiles, a non-finite or huge half-width becomes hwMin /
 * LINE_CAP.hwMax, and segSet caps every per-deed list (LINE_CAP.perDeed). → also { bad }: points dropped here.
 */
export function prepareLines(json, dims, cfg = CLASS_CFG) { return drain(prepareLinesSteps(json, dims, cfg)); }
/** Run a step generator (…Steps) to its end on this task → its return value (the synchronous JS reference). */
export function drain(job) { for (;;) { const r = job.next(); if (r.done) return r.value; } }
/**
 * Stage B (RM-GPU-1 W1 blocker 5: prepareLines 22–68 ms in one task on the QA host): prepareLines as a step generator —
 * one step per polyline meandered, then segSetSteps' steps — so ground.js runs it in ≤ SLICE_MS slices. The same code
 * path as prepareLines (which drains it), so the result is identical.
 */
export function* prepareLinesSteps(json, { cols, rows }, cfg = CLASS_CFG) {
  let bad = 0;
  const X1 = cols * TILES + LINE_CAP.margin, Y1 = rows * TILES + LINE_CAP.margin, lo = -LINE_CAP.margin;
  const polysOf = function* (list, hwMin, mea) {
    const out = [];
    for (const l of Array.isArray(list) ? list : []) {
      const raw = Array.isArray(l?.pts?.[0]) ? l.pts.flat() : (Array.isArray(l?.pts) ? l.pts : []);
      const hwRaw = i => { const h = Array.isArray(l.hw) ? (l.hw[i] ?? l.hw[l.hw.length - 1]) : l.hw; return Number.isFinite(h) ? Math.min(h, LINE_CAP.hwMax) : hwMin; };
      // runs of finite points (a non-finite one splits the polyline), clamped to the grid ± margin
      const runs = []; let cur = null;
      for (let i = 0; 2 * i + 1 < raw.length; i++) {
        const x = +raw[2 * i], y = +raw[2 * i + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) { bad++; cur = null; continue; }
        if (!cur) runs.push(cur = { P: [], hw: [] });
        cur.P.push(Math.min(X1, Math.max(lo, x)), Math.min(Y1, Math.max(lo, y))); cur.hw.push(hwRaw(i));
      }
      for (const r of runs) {
        if (r.P.length < 4) continue;
        let P = r.P, hwAt = i => Math.max(hwMin, r.hw[i]);
        if (mea) { const m = meander(P, hwAt, mea); P = m.P; hwAt = i => Math.max(hwMin, m.hw[i]); }
        const n = P.length / 2; out.push({ P: Float64Array.from(P), hw: Float64Array.from({ length: n }, (_, i) => hwAt(i)) });
        yield;
      }
    }
    return out;
  };
  const rivers = yield* polysOf(json?.rivers, LINES.riverHwMin, cfg?.riverMeander), tracks = yield* polysOf(json?.tracks, LINES.trackHwMin, null);
  if (bad) console.warn(`realm lines: ${bad} non-finite points dropped from lines.json`);
  // polys: the meandered river polylines, which G16 bends round the islands of a base state (riversOf)
  const rs = yield* segSetSteps(rivers, cols, rows, LINES.riverHwMin), ts = yield* segSetSteps(tracks, cols, rows, LINES.trackHwMin);
  return { rivers: rs, tracks: ts, cols, rows, polys: rivers, bad };
}
/**
 * P0 bounds on line data. perDeed: the most segments one deed's list keeps. The GPU no longer walks these lists (the
 * fields are baked, BAKE), but the CPU bake of a page, strokeSdf and the QC walk them: on the five packs the longest
 * list is 50 (Sunscar; a page bakes in ≤ 6 ms), so 128 never trims real data, yet a garbage or hostile lines.json
 * cannot make one page bake unbounded (a main-thread stall). Over the cap a deed keeps its nearest / widest segments
 * (distance from the deed centre minus half-width). margin: how far outside the grid a point may lie (tiles). hwMax:
 * the widest river / track half-width accepted (tiles; the widest in the packs is under 12).
 */
export const LINE_CAP = Object.freeze({ perDeed: 128, margin: 2 * TILES, hwMax: 49 });
/** Polylines [{ P (flat x,y…), hw (per vertex) }] → the per-deed segment set strokeSdf and the line bake read. */
export function segSet(polys, cols, rows, hwMin, cap = LINE_CAP.perDeed) { return drain(segSetSteps(polys, cols, rows, hwMin, cap)); }
/** segSet as a step generator (Stage B): a step every 256 segments indexed and every capped deed. */
export function* segSetSteps(polys, cols, rows, hwMin, cap = LINE_CAP.perDeed) {
  const segs = [];
  for (const { P, hw } of polys) { for (let i = 0; i + 1 < P.length / 2; i++) segs.push(P[2 * i], P[2 * i + 1], P[2 * i + 2], P[2 * i + 3], hw[i], hw[i + 1]); if (polys.length > 1) yield; }
  const S = new Float64Array(segs), count = S.length / 6, cells = new Map();
  const reach = 8; // hw + noise reach + ROCK/ROAD gaps (≤ 2 t beyond the edge) stay inside
  for (let s = 0; s < count; s++) {
    if ((s & 255) === 255) yield;
    const o = s * 6, pad = Math.max(S[o + 4], S[o + 5]) + reach;
    const dx0 = Math.max(0, Math.floor((Math.min(S[o], S[o + 2]) - pad) / TILES)), dx1 = Math.min(cols - 1, Math.floor((Math.max(S[o], S[o + 2]) + pad) / TILES));
    const dy0 = Math.max(0, Math.floor((Math.min(S[o + 1], S[o + 3]) - pad) / TILES)), dy1 = Math.min(rows - 1, Math.floor((Math.max(S[o + 1], S[o + 3]) + pad) / TILES));
    for (let dy = dy0; dy <= dy1; dy++) for (let dx = dx0; dx <= dx1; dx++) {
      const k = dy * cols + dx; let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(s);
    }
  }
  // P0: cap each deed's list, keeping the segments nearest its centre (minus half-width: wide rivers first)
  let dropped = 0, deeds = 0;
  for (const [k, a] of cells) {
    if (a.length <= cap) continue;
    const cx = (k % cols) * TILES + TILES / 2, cy = Math.floor(k / cols) * TILES + TILES / 2, key = new Map();
    for (const s of a) { segEval(S, s * 6, cx, cy, hwMin); key.set(s, SEG.dist - SEG.hw); }
    a.sort((p, q) => key.get(p) - key.get(q) || p - q);
    dropped += a.length - cap; deeds++; a.length = cap; a.sort((p, q) => p - q);
    yield;
  }
  if (dropped) console.warn(`realm lines: ${dropped} segments over the per-deed cap (${cap}) dropped on ${deeds} deeds (kept the nearest / widest)`);
  return { segs: S, count, cells, cols, rows, hwMin, dropped };
}
/**
 * G14: a river polyline P (flat x,y…) resampled every m.step t and displaced by a smooth 2-D field D(p) (the same field
 * for every river, so a tributary ending on the main river stays on it), half-width × (1 + m.hw·noise(p)).
 */
export function meander(P, hwAt, m) {
  const out = [], hw = [], n = P.length / 2, s = m.seed;
  const push = (x, y, h) => {
    out.push(x + m.amp * vnoise(x, y, m.period, s) + m.amp2 * vnoise(x, y, m.period2, s + 2), y + m.amp * vnoise(x, y, m.period, s + 1) + m.amp2 * vnoise(x, y, m.period2, s + 3));
    hw.push(h * (1 + m.hw * vnoise(x, y, m.hwPeriod, s + 4)));
  };
  for (let i = 0; i + 1 < n; i++) {
    const ax = P[2 * i], ay = P[2 * i + 1], bx = P[2 * i + 2], by = P[2 * i + 3], k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / m.step));
    for (let j = 0; j < k; j++) { const t = j / k; push(ax + (bx - ax) * t, ay + (by - ay) * t, hwAt(i) + (hwAt(i + 1) - hwAt(i)) * t); }
  }
  if (n) push(P[2 * n - 2], P[2 * n - 1], hwAt(n - 1));
  return { P: out, hw };
}
const NO_SEGS = [];
function segsNear(set, x, y) {
  const dx = Math.floor(x / TILES), dy = Math.floor(y / TILES);
  if (dx < 0 || dy < 0 || dx >= set.cols || dy >= set.rows) return NO_SEGS;
  return set.cells.get(dy * set.cols + dx) ?? NO_SEGS;
}
/** G14: the lake / coast lookup point of (qx, qy): q + two octaves of smooth warp. GLSL twin: rmLakeWarp. */
export function waterWarp(qx, qy, cfg = CLASS_CFG) {
  const w = cfg.lakeWarp; if (!w) return [qx, qy];
  const s = w.seed;
  return [qx + w.amp * vnoise(qx, qy, w.period, s) + w.amp2 * vnoise(qx, qy, w.period2, s + 2),
    qy + w.amp * vnoise(qx, qy, w.period, s + 1) + w.amp2 * vnoise(qx, qy, w.period2, s + 3)];
}
/**
 * Signed stroke distance at (qx, qy) in tiles (§3.2 step 4; G16: no lens — rivers are bent round the islands in their
 * polylines instead, riversOf). → { sdf, amp }: amp is the river noise cap (Infinity when no river is within hw + reach).
 */
export function strokeSdf(set, qx, qy, cfg, river) {
  let sdf = cfg.far, amp = Infinity;
  const list = segsNear(set, qx, qy), S = set.segs;
  for (let n = 0; n < list.length; n++) {
    segEval(S, list[n] * 6, qx, qy, set.hwMin); const s = SEG.dist - SEG.hw;
    if (s < sdf) sdf = s;
    if (river && SEG.dist <= SEG.hw + cfg.riverNoiseReach) amp = Math.min(amp, LINES.riverNoiseK * (SEG.hw - 0.5));
  }
  return { sdf, amp };
}
// one segment's distance and interpolated half-width at (qx, qy) → SEG (shared by strokeSdf and the P0 bake, so both give
// bit-identical values)
const SEG = { dist: 0, hw: 0 };
function segEval(S, o, qx, qy, hwMin) {
  const ax = S[o], ay = S[o + 1], bx = S[o + 2], by = S[o + 3];
  const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
  let t = L2 > 0 ? ((qx - ax) * ex + (qy - ay) * ey) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = qx - (ax + ex * t), py = qy - (ay + ey * t);
  SEG.dist = Math.sqrt(px * px + py * py); SEG.hw = Math.max(S[o + 4] + (S[o + 5] - S[o + 4]) * t, hwMin);
}

// ---- plots ------------------------------------------------------------------------------------------------
/** Distance from a rounded box's centre along the unit ray (ax, ay) (absolute components) to its boundary. */
export function rayBox(ax, ay, H, c) {
  const t = Math.min(ax > 1e-6 ? H / ax : 1e9, ay > 1e-6 ? H / ay : 1e9), C = H - c;
  if (t * ax <= C || t * ay <= C) return t;
  const s = (ax + ay) * C;
  return s + Math.sqrt(Math.max(0, s * s - 2 * C * C + c * c));
}
const TAU = 2 * Math.PI;
/** G16: the largest island margin past the plot box (t): every margin term at its maximum. */
export function islandMaxMargin(I = CLASS_CFG.island) { return I.base + (Math.SQRT2 - 1) * (I.corner - 3) + I.lobe + I.amp + I.amp2 + I.zig; }
/**
 * P0 fix pass #4: how far past the plot box (Chebyshev, t) a plot's island forcing is evaluated — the island plus its
 * shallows halo and the halo's fade. Beyond it the forcing is below every painted sea (haloDeep), so dropping the plot
 * there changes nothing (no straight cut). The MAP lattice flags the plot path up to reach + 5 t of a plot near water.
 */
export function islandReach(I = CLASS_CFG.island) { return islandMaxMargin(I) + (I.halo ?? 0) + (I.haloFade ?? 0); }
const PLOTS = [null];
for (let L = 1; L <= 20; L++) {
  const p = plotRule(L), half = p.claim / 2 + p.ring + CLASS_CFG.plotMargin;
  // R: the island's outer bound from the plot centre (the plot box corner + the largest margin, G16)
  const R = (half - CLASS_CFG.cornerRadius) * Math.SQRT2 + CLASS_CFG.cornerRadius + islandMaxMargin();
  PLOTS.push(Object.freeze({ level: L, claim: p.claim, ring: p.ring, half, R,
    min: PLOT_CENTRE - p.claim / 2, max: PLOT_CENTRE + p.claim / 2,
    ox: 0, oy: 0, cx: PLOT_CENTRE, cy: PLOT_CENTRE, minX: PLOT_CENTRE - p.claim / 2, maxX: PLOT_CENTRE + p.claim / 2, minY: PLOT_CENTRE - p.claim / 2, maxY: PLOT_CENTRE + p.claim / 2 }));
}
/** Plot geometry per keep level (index 1…20): claim, ring, SDF half-size, the island's outer bound R, closed claim rect. */
export const PLOT_GEOM = Object.freeze(PLOTS);
const OFF_GEOM = new Map();
/**
 * G8: the geometry of a level-L plot whose centre sits (ox, oy) whole tiles off its deed centre (contracts.plotOffset):
 * centre cx/cy (deed-local) and the closed claim rect minX…maxX × minY…maxY. (0, 0) is PLOT_GEOM[L] itself.
 */
export function plotGeom(L, ox = 0, oy = 0) {
  if (!ox && !oy) return PLOTS[L];
  const key = L * 65536 + (ox + 128) * 256 + (oy + 128);
  let g = OFF_GEOM.get(key); if (g) return g;
  const b = PLOTS[L];
  g = Object.freeze({ ...b, ox, oy, cx: PLOT_CENTRE + ox, cy: PLOT_CENTRE + oy, minX: b.min + ox, maxX: b.max + ox, minY: b.min + oy, maxY: b.max + oy });
  OFF_GEOM.set(key, g); return g;
}

/**
 * Base state (plan §6.1): { cols, rows, data: Uint8Array RGBA per deed } —
 * r kind, g flags (FLAG.occupied …), b claimTiles, a level. makeState builds one for tests/QC.
 */
export function makeState(cols, rows, bases = []) {
  const data = new Uint8Array(cols * rows * 4), off = new Map();
  for (let i = 0; i < cols * rows; i++) data[i * 4] = 1;
  for (const b of bases) {
    const i = (b.y * cols + b.x) * 4, L = Math.min(20, Math.max(1, b.level | 0));
    data[i + 1] = FLAG.occupied | (b.mine ? FLAG.mine : 0); data[i + 2] = PLOT_GEOM[L].claim; data[i + 3] = L;
    if (b.off) off.set(i >> 2, b.off); // G8: a pinned offset (tests); the product always hashes (contracts.plotOffset)
  }
  return { cols, rows, data, off };
}
/** Plot geometry of deed (dx,dy) at its G8 offset (plotGeom), or null (no base / out of grid). */
export function plotAt(state, dx, dy) {
  if (!state || dx < 0 || dy < 0 || dx >= state.cols || dy >= state.rows) return null;
  const k = dy * state.cols + dx, i = k * 4;
  if (!(state.data[i + 1] & FLAG.occupied) || !state.data[i + 3]) return null;
  const L = Math.min(20, state.data[i + 3]), pin = state.off?.get(k);
  if (pin) return plotGeom(L, pin[0], pin[1]);
  const o = plotOffset(dx, dy, L);
  return plotGeom(L, o.dx, o.dy);
}
function roundedBox(px, py, half, r) {
  const qx = Math.abs(px) - (half - r), qy = Math.abs(py) - (half - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}
/** Rounded-box SDF (tiles, < 0 inside) of every claimed plot in the 3×3 deed neighbourhood. */
export function plotSdf(state, x, y, cfg = CLASS_CFG) {
  const dx = Math.floor(x / TILES), dy = Math.floor(y / TILES);
  let d = cfg.far;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const g = plotAt(state, dx + i, dy + j); if (!g) continue;
    const s = roundedBox(x - ((dx + i) * TILES + g.cx), y - ((dy + j) * TILES + g.cy), g.half, cfg.cornerRadius);
    if (s < d) d = s;
  }
  return d;
}
/**
 * G9: the organic clearing SDF (tiles, < 0 inside) around every claimed plot in the 3×3 deed neighbourhood: a rounded
 * box of half + extra with corner radius `corner` (≤ extra·√2/(√2 − 1), so it contains the plot box), minus two
 * octaves of outward value noise. The noise is continuous (the MAP overlay evaluates the same function per pixel).
 */
export function clearingSdf(state, x, y, cfg = CLASS_CFG) {
  const dx = Math.floor(x / TILES), dy = Math.floor(y / TILES), c = cfg.clearing;
  let d = cfg.far;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const g = plotAt(state, dx + i, dy + j); if (!g) continue;
    const H = g.half + c.extra, ox = x - ((dx + i) * TILES + g.cx), oy = y - ((dy + j) * TILES + g.cy), r = Math.sqrt(ox * ox + oy * oy);
    if (r > H * Math.SQRT2 + c.lobe + c.amp + c.amp2) continue;       // beyond the largest possible clearing
    const s = r - clearingR(g, dx + i, dy + j, r > 1e-6 ? ox / r : 1, r > 1e-6 ? oy / r : 0, c);
    if (s < d) d = s;
  }
  if (d >= cfg.far) return d;
  return d - c.amp * (0.5 + 0.5 * vnoise(x, y, c.period, c.seed)) - c.amp2 * znoise(x, y, c.period2, c.seed2); // zig-zag: ±amp2
}
/** G13: the clearing's radius along unit ray (ux, uy) before the spatial noise: round base + per-deed 2θ/3θ lobes (≥ 0). */
export function clearingR(g, dx, dy, ux, uy, c = CLASS_CFG.clearing) {
  const H = g.half + c.extra, seed = (kitHash(dx, dy) & 0x7fffffff) ^ 0x3c1e;
  const a2 = 0.6 + 0.4 * unit24(kitHash(1, seed)), a3 = 0.3 + 0.4 * unit24(kitHash(2, seed));
  const q2 = TAU * unit24(kitHash(3, seed)), q3 = TAU * unit24(kitHash(4, seed));
  const c2 = ux * ux - uy * uy, s2 = 2 * ux * uy, c3 = 4 * ux * ux * ux - 3 * ux, s3 = 3 * uy - 4 * uy * uy * uy;
  const n = (a2 * (c2 * Math.cos(q2) + s2 * Math.sin(q2)) + a3 * (c3 * Math.cos(q3) + s3 * Math.sin(q3))) / (a2 + a3); // [−1, 1]
  return rayBox(Math.abs(ux), Math.abs(uy), H, Math.min(H, c.corner)) + c.lobe * (0.5 + 0.5 * n);
}
/** G12: distance (t) from deed-local point (lx, ly) to the closed claim rect of plot geometry g (0 inside). */
export function claimDist(g, lx, ly) {
  const ex = Math.max(g.minX - lx, 0, lx - g.maxX), ey = Math.max(g.minY - ly, 0, ly - g.maxY);
  return Math.sqrt(ex * ex + ey * ey);
}
/** G12: the RING apron's width at vertex (x, y): min + amp·(0.5 + 0.5·noise) tiles. */
export function apronW(x, y, cfg = CLASS_CFG) { const a = cfg.apron; return a.min + a.amp * (0.5 + 0.5 * vnoise(x, y, a.period, a.seed)); }
/** G11: the class lookup point of vertex (x, y): v + two octaves of smooth warp (the fine one × cfg.warpFine). */
export function classWarp(x, y, cfg = CLASS_CFG) {
  const w = cfg.classWarp; if (!w) return [x, y];
  const s = w.seed, f = cfg.warpFine ?? 1;
  return [x + w.amp * vnoise(x, y, w.period, s) + f * (w.amp2 * vnoise(x, y, w.period2, s + 2) + w.amp3 * vnoise(x, y, w.cell3, s + 5) + w.zig * znoise(x, y, w.zigCell, s + 7)),
    y + w.amp * vnoise(x, y, w.period, s + 1) + f * (w.amp2 * vnoise(x, y, w.period2, s + 3) + w.amp3 * vnoise(x, y, w.cell3, s + 6) + w.zig * znoise(x, y, w.zigCell, s + 8))];
}

// ---- G16: the island ------------------------------------------------------------------------------------------
/** G16: a plot's island shape constants from its deed: corner radius, base margin, 2θ/3θ harmonics. GLSL twin rmIsleP. */
export function islandShape(g, dx, dy, I = CLASS_CFG.island) {
  const seed = (kitHash(dx, dy) & 0x7fffffff) ^ I.seed;
  const c = Math.min(3 + (I.corner - 3) * unit24(kitHash(5, seed)), g.half);
  const a2 = 0.5 + 0.5 * unit24(kitHash(1, seed)), a3 = 0.2 + 0.4 * unit24(kitHash(2, seed));
  const q2 = TAU * unit24(kitHash(3, seed)), q3 = TAU * unit24(kitHash(4, seed)), nrm = 1 / (a2 + a3);
  return { c, base: I.base + (Math.SQRT2 - 1) * (c - 3), h: [a2 * Math.cos(q2) * nrm, a2 * Math.sin(q2) * nrm, a3 * Math.cos(q3) * nrm, a3 * Math.sin(q3) * nrm] };
}
/**
 * G16: the island SDF (tiles, < 0 on the island) at (x, y): over the 3×3 deeds' plots, the plot box as a rounded box of the
 * plot's own corner radius minus its margin (base + lobes), then minus the shared spatial noise (three octaves, each ≥ 0).
 * Always contains the plot box grown by force + 1 t. cfg.far without a plot in reach.
 */
export function islandSdf(state, x, y, cfg = CLASS_CFG) {
  const I = cfg.island, dx = Math.floor(x / TILES), dy = Math.floor(y / TILES), reach = islandReach(I);
  let s = cfg.far;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const g = plotAt(state, dx + i, dy + j); if (!g) continue;
    const ox = x - ((dx + i) * TILES + g.cx), oy = y - ((dy + j) * TILES + g.cy);
    if (Math.max(Math.abs(ox), Math.abs(oy)) - g.half > reach) continue;
    const P = islandShape(g, dx + i, dy + j, I), r = Math.sqrt(ox * ox + oy * oy), ux = r > 1e-6 ? ox / r : 1, uy = r > 1e-6 ? oy / r : 0;
    const n = P.h[0] * (ux * ux - uy * uy) + P.h[1] * 2 * ux * uy + P.h[2] * (4 * ux * ux * ux - 3 * ux) + P.h[3] * (3 * uy - 4 * uy * uy * uy);
    const v = roundedBox(ox, oy, g.half, P.c) - P.base - I.lobe * (0.5 + 0.5 * n);
    if (v < s) s = v;
  }
  if (s >= cfg.far) return s;
  return s - I.amp * (0.5 + 0.5 * vnoise(x, y, I.period, I.seed)) - I.amp2 * (0.5 + 0.5 * vnoise(x, y, I.period2, I.seed + 1)) - I.zig * (0.5 + 0.5 * znoise(x, y, I.zigCell, I.seed + 2));
}
/**
 * G16: the island's forcing at (x, y): −sdf on the island, falling at slope·(1 + shallow·noise) outside it, and (P0 fix
 * pass #4) plunging by haloDeep over haloFade t past halo t; −far without one.
 */
export function islandForce(state, x, y, cfg = CLASS_CFG) {
  const s = islandSdf(state, x, y, cfg); if (s >= cfg.far) return -cfg.far;
  const I = cfg.island, h = I.halo ?? cfg.far, f = I.haloFade ?? 1, u = Math.min(1, Math.max(0, (s - h) / f));
  return s <= 0 ? -s : -s * I.slope * (1 + I.shallow * vnoise(x, y, I.shallowPeriod, I.seed + 3)) - (I.haloDeep ?? 0) * u * u * (3 - 2 * u);
}

// ---- G16: one-sided river bends -------------------------------------------------------------------------------
/** Support of a rounded box (half h, corner c) along the unit direction (nx, ny). */
function boxSupport(h, c, nx, ny) { return (h - c) * (Math.abs(nx) + Math.abs(ny)) + c; }
/**
 * G16: the river segment set of `lines` bent round the plots of base state `state` (see the header). Every plot whose
 * box + force + 1 t (+ hw + bend.clear) a river enters gets ONE push direction n (from its centre to the nearest river point; a river
 * through the centre goes to a hashed side) and the push A that clears every river near it along n; each river vertex moves
 * by Σ A·n·w(|p − C|), w = 1 within the need radius, then a smoothstep taper over max(taper, taperK·A). Relaxed `iters`
 * times from the moved polylines. Rivers no island reaches do not move. → a segment set (segSet) with `.moved` (count of
 * vertices moved) and `.blocked` (plots whose river could not be cleared).
 */
export function bendRivers(lines, state, cfg = CLASS_CFG) { return drain(bendRiversSteps(lines, state, cfg)); }
/** Stage B (RM-GPU-1 W1 blocker 5: the first bend took 20–129 ms in one task on the QA host): bendRivers as a step
 *  generator — a step per polyline indexed or moved, per 32 deeds scanned for plots, and segSetSteps' steps. ground.js runs
 *  it in ≤ SLICE_MS slices; bendRivers drains it (the same code path, so the same result). */
export function* bendRiversSteps(lines, state, cfg = CLASS_CFG) {
  const polys = lines?.polys; if (!polys?.length || !state) return lines?.rivers ?? null;
  const B = cfg.bend, cols = lines.cols, rows = lines.rows, maxM = cfg.force + 1; // rivers clear the plot box + force + 1 t
  const cur = polys.map(p => Float64Array.from(p.P));
  const CW = cols + 8, ck = (x, y) => (y + 2) * CW + x + 2; // deed key with a 2-deed apron (bends reach 2 deeds)
  let moved = 0, blocked = 0;
  for (let it = 0; it < B.iters; it++) {
    const cell = new Map(); // deed → [poly, segment] of the current polylines
    for (let pi = 0; pi < cur.length; pi++) { const P = cur[pi]; for (let i = 0; i + 1 < P.length / 2; i++) { const dx = Math.floor((P[2 * i] + P[2 * i + 2]) / 2 / TILES), dy = Math.floor((P[2 * i + 1] + P[2 * i + 3]) / 2 / TILES);
      if (dx < -1 || dy < -1 || dx > cols || dy > rows) continue; const k = ck(dx, dy); let a = cell.get(k); if (!a) cell.set(k, a = []); a.push(pi, i); } yield; }
    const pushes = new Map(); blocked = 0;
    const seen = new Set(); let scanned = 0;
    for (const k of cell.keys()) { if ((++scanned & 31) === 0) yield; const cy0 = Math.floor(k / CW) - 2, cx0 = (k % CW) - 2;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const X = cx0 + i, Y = cy0 + j, key = Y * cols + X; if (X < 0 || Y < 0 || X >= cols || Y >= rows || seen.has(key)) continue; seen.add(key);
        const g = plotAt(state, X, Y); if (!g) continue;
        const Cx = X * TILES + g.cx, Cy = Y * TILES + g.cy, near = [];
        for (let jj = -1; jj <= 1; jj++) for (let ii = -1; ii <= 1; ii++) { const a = cell.get(ck(X + ii, Y + jj)); if (a) for (let q = 0; q < a.length; q += 2) near.push(a[q], a[q + 1]); }
        let worst = -Infinity, nx = 0, ny = 0; const cand = [];
        for (let q = 0; q < near.length; q += 2) {
          const P = cur[near[q]], hw = polys[near[q]].hw, s = near[q + 1];
          const ax = P[2 * s], ay = P[2 * s + 1], ex = P[2 * s + 2] - ax, ey = P[2 * s + 3] - ay, L2 = ex * ex + ey * ey;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((Cx - ax) * ex + (Cy - ay) * ey) / L2)) : 0, qx = ax + ex * t - Cx, qy = ay + ey * t - Cy, d = Math.hypot(qx, qy);
          const h = hw[s] + (hw[s + 1] - hw[s]) * t;
          let ux, uy; if (d > 1e-6) { ux = qx / d; uy = qy / d; } else { const Ln = Math.sqrt(L2) || 1, sg = kitHash(X ^ B.seed, Y) & 1 ? 1 : -1; ux = -ey / Ln * sg; uy = ex / Ln * sg; }
          const need = boxSupport(g.half, CLASS_CFG.cornerRadius, ux, uy) + maxM + h + B.clear;
          cand.push(qx, qy, h);
          if (need - d > worst) { worst = need - d; nx = ux; ny = uy; }
        }
        if (!(worst > 0.01)) continue;
        // the push along n that clears every river point near this island (points behind the plot cannot be cleared
        // by the same push: counted as blocked, the island forcing then wins there)
        let A = 0, need0 = 0;
        for (let q = 0; q < cand.length; q += 3) {
          const need = boxSupport(g.half, CLASS_CFG.cornerRadius, nx, ny) + maxM + cand[q + 2] + B.clear, along = cand[q] * nx + cand[q + 1] * ny;
          const across = Math.abs(cand[q] * ny - cand[q + 1] * nx);
          if (across > need) continue;                                  // passes beside the island along n: not in the way
          if (along < -need * 0.25) { blocked++; continue; }
          const a = Math.sqrt(Math.max(0, need * need - across * across)) - along; if (a > A) A = a;
          need0 = Math.max(need0, need);
        }
        if (A > 0.01) pushes.set(key, [Cx, Cy, nx, ny, A, need0, need0 + Math.max(B.taper, B.taperK * A)]);
      } }
    if (!pushes.size) break;
    const list = [...pushes.values()];
    const byDeed = new Map(); for (let q = 0; q < list.length; q++) { const v = list[q]; if ((q & 63) === 63) yield; const X = Math.floor(v[0] / TILES), Y = Math.floor(v[1] / TILES); for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const k = ck(X + i, Y + j); let a = byDeed.get(k); if (!a) byDeed.set(k, a = []); a.push(v); } }
    for (const P of cur) { for (let i = 0; i < P.length / 2; i++) {
      const x = P[2 * i], y = P[2 * i + 1], a = byDeed.get(ck(Math.floor(x / TILES), Math.floor(y / TILES))); if (!a) continue;
      let mx = 0, my = 0;
      for (const [Cx, Cy, nx, ny, A, r0, r1] of a) {
        const r = Math.hypot(x - Cx, y - Cy); if (r >= r1) continue;
        const f = r <= r0 ? 1 : 1 - ((r - r0) / (r1 - r0)) ** 2 * (3 - 2 * (r - r0) / (r1 - r0));
        mx += A * nx * f; my += A * ny * f;
      }
      if (mx || my) { P[2 * i] = x + mx; P[2 * i + 1] = y + my; if (it === 0) moved++; }
    } yield; }
  }
  const out = yield* segSetSteps(cur.map((P, i) => ({ P, hw: polys[i].hw })), cols, rows, LINES.riverHwMin);
  out.moved = moved; out.blocked = blocked; return out;
}
const BENT = new WeakMap();
/** G16: the river set drawn for base state `state`: state.rivers when the caller keeps it (ground.js), else bent once per
 *  (lines, state) pair. Without a state (or without polylines) the plain meandered rivers. */
export function riversOf(lines, state, cfg = CLASS_CFG) {
  if (!lines) return null;
  if (!state || !lines.polys) return lines.rivers;
  if (state.rivers) return state.rivers;
  let m = BENT.get(lines); if (!m) BENT.set(lines, m = new WeakMap());
  let r = m.get(state); if (!r) m.set(state, r = bendRivers(lines, state, cfg)); return r;
}

// ---- land bridges (G15, G16) ----------------------------------------------------------------------------------
/** Source wetness at (x, y) (no plot forcing): coast with its noise, warped lake, the (bent) river set; < 0 = wet. */
function srcWater(fields, rivers, x, y, cfg) {
  const cn = cfg.coastNoise, c2 = cfg.coastNoise2, ww = waterWarp(x, y, cfg);
  const coast = fields.coast(ww[0], ww[1]) + cn.amp * vnoise(x, y, cn.period, cn.seed) + c2.amp * vnoise(x, y, c2.period, c2.seed);
  const river = rivers ? strokeSdf(rivers, x, y, cfg, true).sdf : cfg.far;
  return { coast, lake: fields.lake(ww[0], ww[1]), river };
}
/**
 * G15/G16: the land bridge of the plot on deed (dx, dy), or null: [ux, uy, len, halfWidth] (tiles, from the plot centre).
 * Only a kingdom whose centre stands in a lake or the sea gets one (rivers are bent round every island, G16; a kingdom on
 * land already joins its shore through its island). Along `dirs` rays the source is marched outward for the first 3-t dry
 * run (the shore); a ray that crosses a river first is refused (a bridge never cuts a river). The nearest shore wins
 * (ties: the driest land beyond), or a neighbouring kingdom in the same water when it is nearer (merged islets). A shore
 * within 0.6 × the island's reach gets a broad headland (0.85 × that reach wide: a one-sided peninsula on the nearer bank),
 * a further one a causeway of 4–6 t, one beyond bridge.max none (an islet).
 */
export function bridgeOf(fields, lines, state, dx, dy, cfg = CLASS_CFG) {
  const g = plotAt(state, dx, dy); if (!g) return null;
  const B = cfg.bridge, I = cfg.island, cx = dx * TILES + g.cx, cy = dy * TILES + g.cy, rv = riversOf(lines, state, cfg);
  const inWater = s => s.coast < 0 || s.lake < 0;
  if (!inWater(srcWater(fields, rv, cx, cy, cfg))) return null;
  const mean = I.base + 0.5 * (I.lobe + I.amp + I.amp2 + I.zig);                                       // the island's mean margin
  const ext = (ux, uy) => rayBox(Math.abs(ux), Math.abs(uy), g.half, CLASS_CFG.cornerRadius) + mean;     // its mean reach
  let best = null;
  const rMax = Math.ceil(g.R + B.max + 3);
  for (let k = 0; k < B.dirs; k++) {
    const th = TAU * k / B.dirs, ux = Math.cos(th), uy = Math.sin(th);
    let start = -1, first = -1, refused = false;
    for (let r = 0; r <= rMax; r++) {
      const s = srcWater(fields, rv, cx + ux * r, cy + uy * r, cfg);
      if (s.river < 0 && !inWater(s)) { refused = true; break; }
      if (inWater(s) || s.river < 0) { start = -1; continue; }
      if (start < 0) start = r;
      if (r - start + 1 >= 3) { first = start; break; }
    }
    if (refused || first < 0) continue;
    const e = srcWater(fields, rv, cx + ux * (first + 12), cy + uy * (first + 12), cfg);
    const gap = first - ext(ux, uy), key = gap - 0.01 * Math.min(e.coast, e.lake, e.river, 60);
    if (!best || key < best.key) best = { key, gap, ux, uy, src: first, reach: ext(ux, uy) };
  }
  // a neighbouring kingdom standing in the same water (merged islets), unless a river runs between the two
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    if (!i && !j) continue;
    const h = plotAt(state, dx + i, dy + j); if (!h) continue;
    const hx = (dx + i) * TILES + h.cx - cx, hy = (dy + j) * TILES + h.cy - cy, D = Math.hypot(hx, hy);
    if (!inWater(srcWater(fields, rv, cx + hx, cy + hy, cfg))) continue;
    const gap = D - ext(hx / D, hy / D) - (rayBox(Math.abs(hx / D), Math.abs(hy / D), h.half, CLASS_CFG.cornerRadius) + mean);
    if (gap > B.max || (best && gap >= best.gap)) continue;
    let river = false;
    for (let t = 0; t < D; t += 1.5) if (srcWater(fields, rv, cx + hx / D * t, cy + hy / D * t, cfg).river < 0) { river = true; break; }
    if (!river) best = { key: gap, gap, ux: hx / D, uy: hy / D, len: D, reach: ext(hx / D, hy / D) };
  }
  if (!best || best.gap > B.max) return null;
  const len = best.len ?? Math.max(best.src + 3, best.reach + 4);
  const w = best.len === undefined && best.gap <= 0.6 * best.reach ? 0.85 * best.reach : B.w + B.wAdd * unit24(kitHash(dx ^ 0x2d, dy ^ B.seed));
  return unpackBridge(packBridge(best.ux, best.uy, Math.min(len, 80), w));
}
/**
 * P0 (RM-GPU-1): a bridge travels to the GPU as ONE uint32 header word per deed (no page, no list): direction angle in
 * 1/65536 turns (bits 0–15), length in ½ t (16–23), half-width in ¼ t (24–31); 0 = none. The JS reference keeps the
 * decoded values (unpackBridge), so bridgeForce here and rmBridgeN on the GPU read the same bridge.
 */
export function packBridge(ux, uy, len, hw) {
  if (!(len > 0)) return 0;
  const a = ((Math.round(Math.atan2(uy, ux) / TAU * 65536) % 65536) + 65536) % 65536;
  const l = Math.max(1, Math.min(255, Math.round(len * 2))), h = Math.max(1, Math.min(255, Math.round(hw * 4)));
  return (a | (l << 16) | (h << 24)) >>> 0;
}
export function unpackBridge(u) {
  if (!u) return [0, 0, 0, 0];
  const a = (u & 0xffff) / 65536 * TAU;
  return [Math.fround(Math.cos(a)), Math.fround(Math.sin(a)), ((u >>> 16) & 255) / 2, (u >>> 24) / 4];
}
/** G15: every plot's bridge, cols × rows × 4 float32 (len 0 = none). */
export function plotBridges(fields, lines, state, cfg = CLASS_CFG, into = null, deeds = null) {
  const out = into ?? new Float32Array(state.cols * state.rows * 4);
  const list = deeds ?? Array.from({ length: state.cols * state.rows }, (_, k) => k);
  for (const k of list) { const r = bridgeOf(fields, lines, state, k % state.cols, Math.floor(k / state.cols), cfg); out.set(r ?? [0, 0, 0, 0], k * 4); }
  return out;
}
const BRIDGES = new WeakMap();
/** The bridges of a base state: state.bridges when the caller keeps them (ground.js), else computed once per state. */
export function bridgesFor(fields, lines, state, cfg = CLASS_CFG) {
  if (!state) return null;
  if (state.bridges) return state.bridges;
  const e = BRIDGES.get(state); if (e && e.fields === fields && e.lines === lines) return e.b;
  const b = plotBridges(fields, lines, state, cfg); BRIDGES.set(state, { fields, lines, b }); return b;
}
/** G15: the bridges' forcing at (x, y): max over the 3×3 deeds of min(tapered half-width − capsule distance, distance past
 *  the plot centre along the bridge) + a wobble: a half-capsule from the plot centre toward its shore. */
export function bridgeForce(bridges, state, x, y, cfg = CLASS_CFG) {
  if (!bridges) return -cfg.far;
  const dx = Math.floor(x / TILES), dy = Math.floor(y / TILES), B = cfg.bridge;
  let f = -cfg.far;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const X = dx + i, Y = dy + j; if (X < 0 || Y < 0 || X >= state.cols || Y >= state.rows) continue;
    const k = (Y * state.cols + X) * 4, len = bridges[k + 2]; if (!(len > 0)) continue;
    const g = plotAt(state, X, Y); if (!g) continue;
    const ax = X * TILES + g.cx, ay = Y * TILES + g.cy, ux = bridges[k], uy = bridges[k + 1];
    const along = (x - ax) * ux + (y - ay) * uy; let t = along / len; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (ax + ux * t * len), py = y - (ay + uy * t * len);
    // flat just past the plot centre (a quarter of its width toward the shore): a broad headland never reaches round to
    // the far side's river, nor clips a river that passes just beside the centre
    const v = Math.min(bridges[k + 3] * (1 - B.taper * t) - Math.sqrt(px * px + py * py), along - 0.25 * bridges[k + 3]);
    if (v > f) f = v;
  }
  return f > -cfg.far ? f + B.wob * vnoise(x, y, B.wobPeriod, B.seed) : f;
}

// ---- field parcels ------------------------------------------------------------------------------------
/** Hashed-split parcel containing vertex (x,y): axis-aligned, 10–18 tiles a side. → [x0,y0,x1,y1). */
export function parcelAt(x, y, P = CLASS_CFG.parcel) {
  const B = P.block, span = P.max - P.min + 1;
  const bx = Math.floor(x / B), by = Math.floor(y / B), h = kitHash(bx ^ P.salt, by ^ (P.salt << 1));
  const s1 = P.min + (h >>> 1) % span, ox = bx * B, oy = by * B;
  let x0, x1, y0, y1;
  if (h & 1) { // split x first, then each column in y
    const left = x - ox < s1; x0 = left ? ox : ox + s1; x1 = left ? ox + s1 : ox + B;
    const s2 = P.min + kitHash((bx * 2 + (left ? 0 : 1)) ^ P.salt, by ^ 0x51) % span;
    const top = y - oy < s2; y0 = top ? oy : oy + s2; y1 = top ? oy + s2 : oy + B;
  } else { // split y first, then each row in x
    const top = y - oy < s1; y0 = top ? oy : oy + s1; y1 = top ? oy + s1 : oy + B;
    const s2 = P.min + kitHash(bx ^ 0x51, (by * 2 + (top ? 0 : 1)) ^ P.salt) % span;
    const left = x - ox < s2; x0 = left ? ox : ox + s2; x1 = left ? ox + s2 : ox + B;
  }
  return [x0, y0, x1, y1];
}

// ---- classAt -------------------------------------------------------------------------------------------
/** Every intermediate of §3.2 at vertex v = [x, y] (integer tile vertex). */
export function classDetail(fields, lines, state, v, cfg = CLASS_CFG) {
  const x = v[0], y = v[1];
  const plot = plotSdf(state, x, y, cfg);
  // 1–3: coast with the island forced dry (G16: the plot box grown by its organic margin; not lensed).
  const cn = cfg.coastNoise, c2 = cfg.coastNoise2, cw = waterWarp(x, y, cfg); // G14: shores (sea and lochs) read at the warped point
  const coast0 = fields.coast(cw[0], cw[1]) + cn.amp * vnoise(x, y, cn.period, cn.seed) + c2.amp * vnoise(x, y, c2.period, c2.seed);
  const isl = state ? islandForce(state, x, y, cfg) : -cfg.far;
  let coast = isl > -cfg.far ? smax(coast0, isl, cfg.coastK) : coast0;
  // 2, 4: inland water — lakes at the warped point (G14), rivers bent one-sided round the islands (G16) — forced dry over
  // the island like the coast, and the plot box + force margin always (G1)
  const lake = fields.lake(cw[0], cw[1]);
  const rv = lines ? strokeSdf(riversOf(lines, state, cfg), x, y, cfg, true) : { sdf: cfg.far, amp: Infinity };
  const river = rv.sdf, inn = cfg.inlandNoise;
  const nz = vnoise(x, y, inn.period, inn.seed);
  let wetL = lake + inn.amp * nz;                                   // the island dries lakes (and lava) like the sea …
  if (isl > -cfg.far) wetL = smax(wetL, isl, cfg.island.k);
  // … but not rivers: they are bent clear of the plot box + force + 1 t, so an island's organic margin never cuts one
  let inland = Math.min(wetL, river + Math.min(inn.amp, rv.amp) * nz);
  inland = smax(inland, cfg.force - plot, cfg.inlandK);
  // G15: land bridges (peninsulas, merged islets) force coast and inland dry along their capsule
  const bf = bridgeForce(bridgesFor(fields, lines, state, cfg), state, x, y, cfg);
  if (bf > -cfg.far) { coast = smax(coast, bf, cfg.bridge.k); inland = smax(inland, bf, cfg.bridge.k); }
  const track = lines ? strokeSdf(lines.tracks, x, y, cfg, false).sdf : cfg.far;
  const out = { plot, coast, inland, river, lake, track, bridge: bf, island: isl, cls: CLASS.WILD, ground: CLASS.WILD, ring: false };
  // 5: first matching rule wins; plot rules first.
  const dx = Math.floor(x / TILES), dy = Math.floor(y / TILES), g = plotAt(state, dx, dy), lx = x - dx * TILES, ly = y - dy * TILES;
  if (g && lx >= g.minX && lx <= g.maxX && ly >= g.minY && ly <= g.maxY) return (out.cls = out.ground = CLASS.TURF, out);
  const rag = cfg.claimRag; // the frayed claim border (dry land only)
  if (g && rag && coast >= 0 && inland >= 0 && claimDist(g, lx, ly) <= rag.amp * Math.max(0, vnoise(x, y, rag.period, rag.seed))) return (out.cls = out.ground = CLASS.TURF, out);
  // G12/G13: the plot's clearing (organic, ⊇ plot box + 1 t; dry land only outside the box) is RING for LIFE and QC,
  // but its ground stays the realm's: only the apron around the claim is RING ground, and the feather beyond it keeps
  // ground classes only (the claim turf has kit transitions with WILD, GROUND2, SHORE and ROAD)
  const ck = cfg.clearing;
  let feather = false;
  if (plot < ck.extra + ck.lobe + ck.amp + ck.amp2 + 1) {
    const cl = clearingSdf(state, x, y, cfg);
    out.ring = plot < 1 || (cl < 0 && coast >= 0 && inland >= 0);   // the box + 1 t always (the zig-zag may dip into it)
    if (out.ring && g) {
      const cd = claimDist(g, lx, ly), aw = apronW(x, y, cfg);
      if (cd < aw) return (out.cls = out.ground = CLASS.RING, out);
      feather = cd < aw + cfg.apron.feather;
    }
  }
  const done = c => { out.ground = plot < 1 && c <= CLASS.WATER ? CLASS.WILD : c; out.cls = out.ring ? CLASS.RING : out.ground; return out; };
  if (coast < -cfg.deepT) return done(CLASS.DEEP);
  if (coast < 0) return done(CLASS.SEA);
  if (inland < 0) return done(CLASS.WATER);
  if (cfg.hasShore) { const bn = cfg.beachNoise; if (coast < cfg.beachW + bn.amp * vnoise(x, y, bn.period, bn.seed)) return done(CLASS.SHORE); }
  // G11: the land classes are looked up at the warped point (organic class edges, no straight painted runs)
  const [wx, wy] = classWarp(x, y, cfg);
  let rock = fields.rock(wx, wy);
  if (cfg.slopeT < Infinity) {
    const h = cfg.slopeStep, gx = fields.relief(wx + h, wy) - fields.relief(wx - h, wy), gy = fields.relief(wx, wy + h) - fields.relief(wx, wy - h);
    if (Math.sqrt(gx * gx + gy * gy) / (2 * h) * TILES > cfg.slopeT) rock = 1;
  }
  out.rock = rock;
  if (rock >= cfg.rockT && inland > cfg.rockWaterGap && coast > cfg.rockWaterGap && !feather)
    return done(fields.snow(wx, wy) >= cfg.snowT ? CLASS.SNOW : CLASS.ROCK);
  if (track < 0 && inland > cfg.roadInland && coast > cfg.roadCoast) return done(CLASS.ROAD); // a track may lead up to the fence
  const p = parcelAt(Math.floor(wx + 0.5), Math.floor(wy + 0.5), cfg.parcel);
  if (fields.field((p[0] + p[2]) / 2, (p[1] + p[3]) / 2) >= cfg.fieldT) return done(feather ? CLASS.WILD : CLASS.FIELD);
  if (fields.forest(wx, wy) >= cfg.forestT) return done(feather ? CLASS.WILD : CLASS.FOREST);
  if (fields.special(wx, wy) >= cfg.specialT) return done(feather ? CLASS.WILD : CLASS.SPECIAL);
  if (fields.ground2(wx, wy) >= cfg.g2T) return done(CLASS.GROUND2);
  return done(CLASS.WILD);
}
/** §10.2: classAt(fields, lines, state, v:[x,y]) → CLASS. `cfg` = classConfig(realm.json.classes). */
export function classAt(fields, lines, state, v, cfg = CLASS_CFG) { return classDetail(fields, lines, state, v, cfg).cls; }
/**
 * P0 "classes-sampled" (GLSL twin: classes.glsl.js mapClassFine's wet test). The wet class of vertex v from the baked
 * fields only — the coast and lake at the warped point with the coast noise, the river field (the baked page) with the
 * inland noise — and none of the island / bridge / plot forcing, which only ever dries. So every vertex classAt calls
 * DEEP / SEA / WATER is wet here too (display shaders never seat a tree in water), at the price of a little land near a
 * plot's island reading wet. Returns 1 (sea), 2 (inland water) or 0 (dry).
 */
export function sampledWet(fields, lines, state, v, cfg = CLASS_CFG) {
  const [x, y] = v, cn = cfg.coastNoise, c2 = cfg.coastNoise2, cw = waterWarp(x, y, cfg);
  if (fields.coast(cw[0], cw[1]) + cn.amp * vnoise(x, y, cn.period, cn.seed) + c2.amp * vnoise(x, y, c2.period, c2.seed) < 0) return 1;
  const inn = cfg.inlandNoise, nz = vnoise(x, y, inn.period, inn.seed);
  const rv = lines ? strokeSdf(riversOf(lines, state, cfg), x, y, cfg, true) : { sdf: cfg.far, amp: Infinity };
  return Math.min(fields.lake(cw[0], cw[1]) + inn.amp * nz, rv.sdf + Math.min(inn.amp, rv.amp) * nz) < 0 ? 2 : 0;
}

// ---- legalise (§3.2 step 6) --------------------------------------------------------------------------------
/**
 * A band's drawability table from realm.json (map or true):
 *   { classToTerrain: { CLASSNAME: terrainId }, families: [{ lower, upper }], fallback: { CLASSNAME: CLASSNAME },
 *     sharedLower: [terrainId…] }   // terrains always drawn pure under the composite (MAP: the realm's WILD)
 * Two terrains are legal neighbours when equal, joined by a family, or both uppers of families whose lower
 * is a sharedLower terrain (the MAP layered composite draws WILD pure and overlays each upper, §3.4).
 */
export function bandTable(spec) {
  const terrainOf = new Array(CLASS_COUNT).fill(null);
  for (const [n, t] of Object.entries(spec.classToTerrain ?? {})) if (n in CLASS) terrainOf[CLASS[n]] = t;
  const pair = new Set(), lowerOf = new Map();
  for (const f of spec.families ?? []) {
    pair.add(`${f.lower}|${f.upper}`); pair.add(`${f.upper}|${f.lower}`);
    if (!lowerOf.has(f.upper)) lowerOf.set(f.upper, new Set()); lowerOf.get(f.upper).add(f.lower);
  }
  const shared = new Set(spec.sharedLower ?? []);
  const fallback = new Array(CLASS_COUNT).fill(-1);
  for (const [n, to] of Object.entries(spec.fallback ?? {})) if (n in CLASS && to in CLASS) fallback[CLASS[n]] = CLASS[to];
  const legal = (a, b) => {
    if (a === b || a === null || b === null) return true;
    if (pair.has(`${a}|${b}`)) return true;
    if (shared.has(a) && lowerOf.get(b)?.has(a)) return true;
    if (shared.has(b) && lowerOf.get(a)?.has(b)) return true;
    const la = lowerOf.get(a), lb = lowerOf.get(b);
    if (la && lb) for (const s of shared) if (la.has(s) && lb.has(s)) return true;
    return false;
  };
  return { terrainOf, legal, fallback, rank: CLASS_RANK };
}
/**
 * MAP band table from terrain-tables.json / realm.json `map` ({ wild, families: { M1: { lower, upper } … },
 * classToTerrain }). Terrains are the family keys (M1…M5) plus the wild id; "WILD" in classToTerrain means
 * "drawn as WILD ground under an overlay". A family whose lower is another family's upper (M4 on M3's rock)
 * pairs only with that family; its classes fall back to the class drawing that lower (ROCK). Every other
 * class falls back to WILD. `over` may replace fallback entries.
 */
export function mapBandTable(map, over = {}) {
  const wild = map.wild, keyOfUpper = {};
  for (const [k, f] of Object.entries(map.families)) keyOfUpper[f.upper] = k;
  const lowerKey = f => (f.lower === wild ? wild : keyOfUpper[f.lower] ?? f.lower);
  const families = Object.entries(map.families).map(([k, f]) => ({ lower: lowerKey(f), upper: k }));
  // "M4|M3" (Crownlands SNOW): the first when map.snowPeaks (SNOW share ≥ 0.5 %, PACK decides), else the second.
  const pick = v => (typeof v === 'string' && v.includes('|') ? v.split('|')[map.snowPeaks ? 0 : 1] : v);
  const cls2t = Object.fromEntries(Object.entries(map.classToTerrain).map(([c, v]) => [c, pick(v) === 'WILD' ? wild : pick(v)]));
  const classOf = t => ['ROCK', 'SNOW', 'GROUND2', 'FIELD', 'FOREST', 'SPECIAL', 'WILD'].find(c => cls2t[c] === t);
  const fallback = {};
  for (const [c, t] of Object.entries(cls2t)) {
    if (t === wild) continue;
    const f = families.find(x => x.upper === t);
    fallback[c] = f && f.lower !== wild ? (classOf(f.lower) ?? 'WILD') : 'WILD';
  }
  return bandTable({ classToTerrain: cls2t, families, fallback: { ...fallback, ...over }, sharedLower: [wild] });
}
/** Which vertex of an illegal pair collapses: the higher-priority one that has a fallback, else the other. */
export function victimOf(table, ca, cb) {
  const fa = table.fallback[ca], fb = table.fallback[cb], first = table.rank[ca] <= table.rank[cb];
  if (first && fa >= 0) return 0;
  if (!first && fb >= 0) return 1;
  if (fa >= 0) return 0;
  if (fb >= 0) return 1;
  return -1;
}
const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
/**
 * 8-neighbour legalise, Jacobi passes (each pass reads the previous grid, as the GPU pass does).
 * grid: Uint8Array w×h of CLASS ids (modified copy returned). Out-of-grid neighbours are ignored, so give
 * the region an apron of `passes` vertices when the result must match a tiled GPU resolve.
 * → { grid, collapsed (vertex collapses over all passes), illegal (pairs left unresolved) }.
 */
export function legalise(grid, w, h, table, { passes = 2 } = {}) {
  let cur = Uint8Array.from(grid), collapsed = 0;
  for (let p = 0; p < passes; p++) {
    const next = Uint8Array.from(cur); let changed = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = cur[y * w + x], t = table.terrainOf[c];
      for (const [ox, oy] of N8) {
        const nx = x + ox, ny = y + oy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = cur[ny * w + nx];
        if (n === c || table.legal(t, table.terrainOf[n])) continue;
        if (victimOf(table, c, n) === 0) { next[y * w + x] = table.fallback[c]; changed++; break; }
      }
    }
    collapsed += changed; cur = next;
    if (!changed) break;
  }
  let illegal = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = table.terrainOf[cur[y * w + x]];
    for (const [ox, oy] of N8.slice(4)) { // each unordered pair once
      const nx = x + ox, ny = y + oy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!table.legal(t, table.terrainOf[cur[ny * w + nx]])) illegal++;
    }
  }
  return { grid: cur, collapsed, illegal };
}
// ---- despeckle (G7, TRUE vertices) -------------------------------------------------------------------------
const isWet = c => c <= CLASS.WATER;                         // DEEP, SEA, WATER
const isPlotCls = c => c === CLASS.TURF || c === CLASS.RING;
/** Class to flip to: the most frequent neighbour class of the wanted wetness, first in the order L, R, U, D. */
function majority(n, wet) {
  let best = -1, bc = 0;
  for (let k = 0; k < 4; k++) {
    if (isWet(n[k]) !== wet) continue;
    let c = 0; for (let m = 0; m < 4; m++) if (n[m] === n[k]) c++;
    if (c > bc) { bc = c; best = n[k]; }
  }
  return best;
}
/**
 * One Jacobi pass over a vertex grid (w×h CLASS ids) that removes 1-vertex runs across the water line: a dry
 * vertex with water on both sides along x or along y turns wet (1-vertex spits, diagonal rows of land beads),
 * and a water vertex with land on both sides along x or along y turns dry (1-vertex notches and specks).
 * Rivers (≥ 3 t wide, LINES.riverHwMin) and moat rings (≥ 2.5 t radially) never have such runs, so nothing
 * real is cut. Plot classes (TURF, RING) never flip; ring-flagged vertices (G12: `ring`, a Uint8Array of 0/1: the plot's
 * clearing) only fill — a 1-vertex spit of clearing into water turns wet and loses its flag (returned as `ring`); TURF and
 * RING classes never make a neighbour flip dry (a ring-flagged neighbour is ordinary ground). Border vertices are left alone (give the region one apron vertex). → { grid, flipped }.
 * mode bits: 1 fill (dry → wet), 2 erode (wet → dry), 4 isolated dry vertex → dry majority, 8 (MAP lattice, fix round 1)
 * a 1-vertex-wide run of an upper terrain across x or y (not WILD, not ROAD) takes the class across it (the pair's class when they agree, else the
 * ground class of the two): the 1-wide upper-terrain runs PACK's QC counts, and the 45° chains they draw at MAP.
 */
export function despeckle(grid, w, h, mode = 3, ring = null) {
  const out = Uint8Array.from(grid), ringOut = ring ? Uint8Array.from(ring) : null; let flipped = 0; const n = [0, 0, 0, 0];
  const plotN = k => isPlotCls(n[k]);   // a ring-flagged neighbour is ordinary ground here: only TURF/RING classes block
  const NB = [0, 0, 0, 0];
  const okTo = (c, k) => !isWet(c) && !isPlotCls(c) && !(ring !== null && ring[NB[k]] === 1);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, c = grid[i];
    if (isPlotCls(c)) continue;
    const flagged = ring !== null && ring[i] === 1; // G12: the clearing's ground only ever fills (a spit into water)
    NB[0] = i - 1; NB[1] = i + 1; NB[2] = i - w; NB[3] = i + w;
    n[0] = grid[i - 1]; n[1] = grid[i + 1]; n[2] = grid[i - w]; n[3] = grid[i + w];
    const wx = isWet(n[0]), wx1 = isWet(n[1]), wy = isWet(n[2]), wy1 = isWet(n[3]);
    if (flagged) { if (!isWet(c) && (mode & 1) && ((wx && wx1) || (wy && wy1))) { out[i] = majority(n, true); ringOut[i] = 0; flipped++; } continue; }
    if (!isWet(c)) {
      if ((mode & 1) && ((wx && wx1) || (wy && wy1))) { out[i] = majority(n, true); flipped++; }
      else if ((mode & 8) && c !== CLASS.ROAD && c !== CLASS.WILD && ((n[0] !== c && n[1] !== c) || (n[2] !== c && n[3] !== c))) {
        const a = n[2] !== c && n[3] !== c ? 2 : 0, A = n[a], B = n[a + 1], oa = okTo(A, a), ob = okTo(B, a + 1);
        const to = oa && ob ? (A === B || A === CLASS.WILD || (A === CLASS.GROUND2 && B !== CLASS.WILD) ? A : B) : oa ? A : ob ? B : -1;
        if (to >= 0 && to !== c) { out[i] = to; flipped++; }
      }
      else if ((mode & 4) && n[0] !== c && n[1] !== c && n[2] !== c && n[3] !== c) { // isolated dry vertex (MAP lattice)
        const to = majority(n, false); if (to >= 0 && !isPlotCls(to)) { out[i] = to; flipped++; }
      }
    } else if ((mode & 2) && ((!wx && !wx1) || (!wy && !wy1)) && !plotN(0) && !plotN(1) && !plotN(2) && !plotN(3)) {
      const to = majority(n, false); if (to >= 0) { out[i] = to; flipped++; }
    }
  }
  return { grid: out, flipped, ring: ringOut };
}

/**
 * Despeckle passes at TRUE (G7): pass 0 only fills (dry → wet), passes 1–5 fill and erode. Filling first
 * removes the land beads and spits before any erosion can pair with them (a fill and an erode on neighbours in
 * one pass may toggle back and forth). Measured on 200 real lens deeds near water (40 per realm, demo bases,
 * docs/realm-map/lane-ground.md): 1-vertex runs left after 4 passes 11, 5 passes 5, 6 passes 4 (both×4 13,
 * alternating fill/erode 38); the rest are 2-vertex sandbars pinched to 1 in a single row.
 */
export const DESPECKLE_PASSES = 6;
export const despeckleMode = k => (k === 0 ? 1 : 3);
/** The MAP lattice (step 7) runs two passes: mode 12 (a 1-vertex-wide run of an upper terrain takes the class across it,
 *  mode 8; an isolated dry vertex its dry neighbours' majority, mode 4), then mode 4 again for the corners an L-shaped
 *  run leaves alone — PACK QC "MAP single cells / 1-wide runs": such vertices drew speckle blobs and 45° chains of mask
 *  art. Water, plots and ROAD never flip. */
export const MAP_DESPECKLE = 2, mapDespeckleMode = k => (k === 0 ? 12 : 4);
const LAT_CFG = new WeakMap();
/** The class config the MAP lattice resolves with: the class warp's fine octave off (G11; it would alias at 7 t). */
export function latticeCfg(cfg = CLASS_CFG) { let c = LAT_CFG.get(cfg); if (!c) { c = Object.freeze({ ...cfg, warpFine: 0 }); LAT_CFG.set(cfg, c); } return c; }
/**
 * Resolve + legalise a vertex region: vertices (x0 + i·step, y0 + j·step), i < w, j < h.
 * step 1 = a TRUE page (w = h = 99), step 7 = the MAP lattice. The raw pass runs on an apron of
 * `passes` vertices (+ 1 per despeckle pass, G7) so the cropped result equals a tiled resolve.
 * → { grid (classAt semantics: RING across the clearing), ground (the class the ground draws, G12), ring (0/1), … }
 */
export function resolveRegion(fields, lines, state, { x0, y0, w, h, step = 1 }, table, cfg = CLASS_CFG, { passes = 2, despeckle: dsp = step === 1 ? DESPECKLE_PASSES : MAP_DESPECKLE, slots = null } = {}) {
  const c = step > 1 ? latticeCfg(cfg) : cfg;
  const a = table ? passes + (dsp | 0) + (slots ? 1 : 0) : 0, W = w + 2 * a, H = h + 2 * a;
  let raw = new Uint8Array(W * H), ring = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const d = classDetail(fields, lines, state, [x0 + (i - a) * step, y0 + (j - a) * step], c); raw[j * W + i] = d.ground; ring[j * W + i] = d.ring ? 1 : 0; }
  const sem = (G, R, ww, hh, ox) => { const o = new Uint8Array(ww * hh); for (let j = 0; j < hh; j++) for (let i = 0; i < ww; i++) { const k = (j + ox) * W + i + ox; o[j * ww + i] = R[k] ? CLASS.RING : G[k]; } return o; };
  if (!table) return { grid: sem(raw, ring, W, H, 0), ground: raw, ring, collapsed: 0, illegal: 0, raw };
  let flipped = 0;
  for (let k = 0; k < (dsp | 0); k++) { const r = despeckle(raw, W, H, step === 1 ? despeckleMode(k) : mapDespeckleMode(k), ring); raw = r.grid; ring = r.ring; flipped += r.flipped; }
  const L = legalise(raw, W, H, table, { passes });
  const ground = new Uint8Array(w * h), rg = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) { ground.set(L.grid.subarray((j + a) * W + a, (j + a) * W + a + w), j * w); rg.set(ring.subarray((j + a) * W + a, (j + a) * W + a + w), j * w); }
  const grid = ground.map((g, i) => (rg[i] ? CLASS.RING : g));
  const pure = slots ? latticePure(L.grid, W, H, slots) : null;
  const pureOut = pure ? new Uint8Array(w * h) : null;
  if (pure) for (let j = 0; j < h; j++) pureOut.set(pure.subarray((j + a) * W + a, (j + a) * W + a + w), j * w);
  return { grid, ground, ring: rg, collapsed: L.collapsed, illegal: L.illegal, flipped, pure: pureOut };
}
/**
 * W1 G2 (RM-GPU-1 follow-up): the MAP lattice purity bit (resolve.glsl PURE_FS, texel bit 5): 1 where a vertex and its 8 neighbours all
 * draw the same MAP slot (slots: class → slot, ground.js mapTables().terr). rm-map reads it at a cell's four corners instead
 * of the 4×4 block it fetched per pixel: a corner's corner-Wang colour needs its 3×3 to be one slot, and four pure corners
 * of one slot mean a one-slot 4×4 block. Border vertices are 0 (give the region one apron vertex). → Uint8Array w×h of 0/1.
 */
export function latticePure(grid, w, h, slots) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const s = slots[grid[y * w + x]]; let one = true;
    for (let j = -1; j <= 1 && one; j++) for (let i = -1; i <= 1; i++) if (slots[grid[(y + j) * w + x + i]] !== s) { one = false; break; }
    out[y * w + x] = one ? 1 : 0;
  }
  return out;
}

// ---- P0 (RM-GPU-1): the line fields, baked per deed page ------------------------------------------------------------
/**
 * The real-GPU hang (KNOWN_ISSUES RM-GPU-1): the GPU walked a deed's river segment list (up to 50 segments after G14's
 * resampling) for every MAP pixel, every lattice / page vertex and every LIFE vertex near water. Now no shader walks a
 * list: GROUND bakes, once per base state, the stroke fields the classes read into 99² pages — tile vertices 0…98 of a
 * deed; row and column 98 are the neighbours' first vertices, evaluated with THEIR lists — and every shader samples them:
 * one texel at a tile vertex (this reference's value up to half-float rounding), a bilinear of four elsewhere.
 *   river page: (sdf, amp) of the (bent) rivers  = (min(strokeSdf, cap), min(amp, ampCap))
 *   land page:  (track sdf, -)                     = (min(strokeSdf(tracks), cap), 0)
 * A deed without a page reads (cap, ampCap) / (cap, -). The rasteriser visits every vertex within hw + cap of each
 * segment, so the min over the visited segments IS the reference's min wherever it is below cap. Every rule reads the
 * river and track fields below 14 t; a capped value keeps every class (lane-ground P0). G15 land bridges are not baked
 * (a page per bridged deed's 3×3 was 400+ pages on a populated realm): the GPU evaluates bridgeForce itself over the
 * 3×3 deeds from one packed header word each (packBridge), a literal-bound loop.
 */
export const BAKE = Object.freeze({ size: 99, cap: 20, ampCap: 64 });
const PAGE_N = BAKE.size * BAKE.size;
// the strokes of `set` over deed (dx, dy)'s page into out (and, for rivers, the noise cap into amp): min-rasterised per
// governing deed (a vertex's list is its own deed's, as strokeSdf's segsNear)
function rasterStrokes(set, dx, dy, cfg, out, amp) {
  const N = BAKE.size, cap = BAKE.cap, S = set.segs, reach = cfg.riverNoiseReach, ox = dx * TILES, oy = dy * TILES;
  out.fill(cap); if (amp) amp.fill(BAKE.ampCap);
  for (let gy = 0; gy <= 1; gy++) for (let gx = 0; gx <= 1; gx++) {
    const X = dx + gx, Y = dy + gy; if (X < 0 || Y < 0 || X >= set.cols || Y >= set.rows) continue;
    const list = set.cells.get(Y * set.cols + X); if (!list) continue;
    const i0 = gx ? 98 : 0, i1 = gx ? 98 : 97, j0 = gy ? 98 : 0, j1 = gy ? 98 : 97;
    for (const s of list) {
      const o = s * 6, pad = Math.max(S[o + 4], S[o + 5], set.hwMin) + cap;
      const a = Math.max(i0, Math.ceil(Math.min(S[o], S[o + 2]) - pad - ox)), b = Math.min(i1, Math.floor(Math.max(S[o], S[o + 2]) + pad - ox));
      const c = Math.max(j0, Math.ceil(Math.min(S[o + 1], S[o + 3]) - pad - oy)), e = Math.min(j1, Math.floor(Math.max(S[o + 1], S[o + 3]) + pad - oy));
      for (let j = c; j <= e; j++) for (let i = a; i <= b; i++) {
        segEval(S, o, ox + i, oy + j, set.hwMin); const v = SEG.dist - SEG.hw, k = j * N + i;
        if (v < out[k]) out[k] = v;
        if (amp && SEG.dist <= SEG.hw + reach) { const m = LINES.riverNoiseK * (SEG.hw - 0.5); if (m < amp[k]) amp[k] = m; }
      }
    }
  }
}
/** River page of deed (dx, dy): { sdf, amp } (Float64Array(99²) each, vertex (i, j) at j·99 + i). */
export function bakeRiverPage(rivers, dx, dy, cfg = CLASS_CFG) {
  const sdf = new Float64Array(PAGE_N), amp = new Float64Array(PAGE_N);
  rasterStrokes(rivers, dx, dy, cfg, sdf, amp); return { sdf, amp };
}
/** Land page of deed (dx, dy): { track } — the track field (G15 bridges are analytic: one header word per deed, packBridge). */
export function bakeLandPage(tracks, dx, dy, cfg = CLASS_CFG) {
  const track = new Float64Array(PAGE_N);
  if (tracks) rasterStrokes(tracks, dx, dy, cfg, track, null); else track.fill(BAKE.cap);
  return { track };
}
/** Deed k's downstream direction (lines.json point order): the normalised sum of its listed river segments → [x, y]. */
export function riverHint(rivers, k) {
  const list = rivers?.cells.get(k); if (!list) return [0, 0];
  let x = 0, y = 0; for (const s of list) { x += rivers.segs[s * 6 + 2] - rivers.segs[s * 6]; y += rivers.segs[s * 6 + 3] - rivers.segs[s * 6 + 1]; }
  const L = Math.hypot(x, y); return L > 1e-9 ? [x / L, y / L] : [0, 0];
}
// IEEE half floats (the pages are uploaded as packHalf2x16 words; GLSL unpackHalf2x16 reads them back exactly)
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
/** Nearest-even IEEE binary16 bits of v (through float32). */
export function toHalf(v) {
  F32[0] = v; const x = U32[0], sign = (x >>> 16) & 0x8000, e = (x >>> 23) & 0xff; let m = x & 0x7fffff;
  if (e === 255) return sign | 0x7c00 | (m ? 0x200 : 0);
  const E = e - 112;                                            // e − 127 + 15
  if (E >= 31) return sign | 0x7c00;
  if (E <= 0) {
    if (E < -10) return sign;
    m |= 0x800000; const sh = 14 - E, h = m >>> sh, rem = m & ((1 << sh) - 1), half = 1 << (sh - 1);
    return sign | (rem > half || (rem === half && (h & 1)) ? h + 1 : h);
  }
  const h = (E << 10) | (m >>> 13), rem = m & 0x1fff;
  return sign | (rem > 0x1000 || (rem === 0x1000 && (h & 1)) ? h + 1 : h);
}
/** The value of binary16 bits h. */
export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
/**
 * The GPU's sample of a baked page pair (GLSL rmPageSample) at tile point (x, y) of deed (dx, dy): the half-float values,
 * the vertex itself at integer points, else the bilinear of its four vertices. a, b = Float64Array(99²) (null page → fa, fb).
 */
export function samplePage(a, b, dx, dy, x, y, fa = BAKE.cap, fb = BAKE.ampCap) {
  if (!a) return [fa, fb];
  const N = BAKE.size, lx = x - dx * TILES, ly = y - dy * TILES, i = Math.min(97, Math.floor(lx)), j = Math.min(97, Math.floor(ly)), fx = lx - i, fy = ly - j;
  const at = (A, ii, jj) => fromHalf(toHalf(A[jj * N + ii]));
  const one = A => { const v = at(A, i, j); if (fx === 0 && fy === 0) return v;
    const t = v + (at(A, i + 1, j) - v) * fx, u = at(A, i, j + 1) + (at(A, i + 1, j + 1) - at(A, i, j + 1)) * fx; return t + (u - t) * fy; };
  return [one(a), one(b)];
}

// ---- fix iteration 2 #3: painted shadows are not tarns ---------------------------------------------------------------
/**
 * PACK's lake channel marks some painted mountain shadows as lakes (Stormcairn's central peaks, slate rgb ≈ (56, 69, 93)),
 * which the MAP band then draws as saturated blue blobs under grey peaks (owner-r2b 10). GROUND clips them on load, on the
 * same fieldsA bytes the GPU and this reference read (so classes stay in parity). Each texel's painted colour is placed on
 * the realm's own land → water axis (land = mean painted colour of dry land, water = mean of the largest lake component):
 * t = projection, 0 at the land mean, 1 at the water. A 4-connected lake component (lake < 0 on land) with no texel past
 * `wetT` holds no painted water at all — a shadow — and becomes dry by `dry` tiles. Thin rivers and real tarns always
 * hold water-coloured texels and stay. A realm whose water and land paint alike (axis < `minAxis`, e.g. Frostveil's ice
 * lakes on snow) is left alone. Mutates fieldsA (RGBA, lake in G); chart = chart8 pixels on the same 8 px/deed grid.
 */
export function clipTarns(fieldsA, chart, opts) { const g = clipTarnsSteps(fieldsA, chart, opts); let r; while (!(r = g.next()).done); return r.value; }
/**
 * clipTarns as a generator (P0 fix pass #5, D-167 no main-thread stall > 50 ms): it yields after every TARN_STEP units of
 * work (a texel scanned, labelled, summed or clipped), so ground.js runs it in ≤ 8 ms slices; returns clipTarns' result.
 */
export const TARN_STEP = 32768;
export function* clipTarnsSteps(fieldsA, chart, { dry = 12, wetT = 0.45, minAxis = 60 } = {}) {
  const W = fieldsA.width, H = fieldsA.height, A = fieldsA.data, C = chart.data, cs = chart.channels ?? Math.round(C.length / (chart.width * chart.height));
  if (chart.width !== W || chart.height !== H) return { components: 0, clipped: 0, texels: 0, skipped: 'grid mismatch' };
  const wet = i => A[i * 4 + 1] < 128 && A[i * 4] > 128;           // lake < 0, coast > 0
  const lab = new Int32Array(W * H).fill(-1), comps = [], land = [0, 0, 0, 0];
  let work = 0;
  for (let i = 0; i < W * H; i++) { if (A[i * 4] > 128 && A[i * 4 + 1] > 128) { land[0] += C[i * cs]; land[1] += C[i * cs + 1]; land[2] += C[i * cs + 2]; land[3]++; } if (++work % TARN_STEP === 0) yield; }
  for (let s = 0; s < W * H; s++) {
    if (++work % TARN_STEP === 0) yield;
    if (lab[s] >= 0 || !wet(s)) continue;
    const id = comps.length, px = [s]; lab[s] = id;
    for (let q = 0; q < px.length; q++) {
      if (++work % TARN_STEP === 0) yield;
      const i = px[q], x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < W * H && lab[j] < 0 && wet(j)) { lab[j] = id; px.push(j); }
    }
    comps.push(px);
  }
  if (!comps.length || !land[3]) return { components: comps.length, clipped: 0, texels: 0 };
  const big = comps.reduce((a, c) => (c.length > a.length ? c : a)), L = land.slice(0, 3).map(v => v / land[3]), Wc = [0, 0, 0];
  for (const i of big) for (let k = 0; k < 3; k++) Wc[k] += C[i * cs + k] / big.length;
  const ax = Wc.map((v, k) => v - L[k]), n2 = ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2];
  if (Math.sqrt(n2) < minAxis) return { components: comps.length, clipped: 0, texels: 0, skipped: 'water paints like land' };
  let clipped = 0, texels = 0;
  for (const px of comps) {
    work += px.length; if (work >= TARN_STEP) { work = 0; yield; }
    let t = -Infinity;
    for (const i of px) { const v = ((C[i * cs] - L[0]) * ax[0] + (C[i * cs + 1] - L[1]) * ax[1] + (C[i * cs + 2] - L[2]) * ax[2]) / n2; if (v > t) t = v; if (t > wetT) break; }
    if (t > wetT) continue;
    clipped++; texels += px.length;
    for (const i of px) A[i * 4 + 1] = Math.min(255, 128 + Math.ceil(dry / 2));
  }
  return { components: comps.length, clipped, texels };
}

/**
 * GA2-04 at MAP and TRUE (ground.js load): the coast SDF of fieldsA (R = 128 + d/2 tiles) is capped at (cut − distance
 * from the realm) deeds, so painted neighbour land beyond ~3.5 deeds becomes open sea with a natural coast; the cut wanders
 * 1.5…6.5 deeds (water.glsl rmForeignCut, the same noise). farD = the realm distance field (deeds, cols × rows, texel
 * centres at i + 0.5). Mutates img. P0 fix pass #5 (it ran over every fieldsA px in one main-thread task: ~1 s on the
 * efficiency cores for Frostveil): a generator that yields after every row, so ground.js runs it in ≤ 8 ms slices, and
 * two EXACT early-outs skip the noise — a texel already below the least cap keeps its value, and a texel whose greatest
 * cap is ≤ −256 t becomes 0 (what the full formula writes there). Returns { rows, noised, zeroed, kept }.
 */
export function* foreignSeaRows(img, farD, cols, rows) {
  const W = img.width, H = img.height, ppd = W / cols, d = img.data, CUT_MIN = 1.5, CUT_MAX = 6.5;
  const farAt = (x, y) => {
    const u = Math.min(cols - 1, Math.max(0, x - 0.5)), v = Math.min(rows - 1, Math.max(0, y - 0.5)), x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1), fx = u - x0, fy = v - y0;
    return (farD[y0 * cols + x0] * (1 - fx) + farD[y0 * cols + x1] * fx) * (1 - fy) + (farD[y1 * cols + x0] * (1 - fx) + farD[y1 * cols + x1] * fx) * fy;
  };
  const cutAt = (px, py) => { const qx = px * 4, qy = py * 4;
    return Math.min(CUT_MAX, Math.max(CUT_MIN, 3.5 - (1.5 * vnoise(qx, qy, 48, 0x6f13) + 0.8 * vnoise(qx, qy, 20, 0x1d27) + 0.9 * vnoise(qx, qy, 7, 0x4f1d) + 0.35 * vnoise(qx, qy, 3, 0x2a77)))); };
  let noised = 0, zeroed = 0, kept = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) / ppd, py = (y + 0.5) / ppd, fd = farAt(px, py); if (fd <= 0.5) continue;
      const o = (y * W + x) * 4, c = (d[o] - 128) * 2;
      if (c <= (CUT_MIN - fd) * TILES) { kept++; continue; }         // every cap ≥ c: unchanged
      if ((CUT_MAX - fd) * TILES <= -256) { d[o] = 0; zeroed++; continue; } // every cap ≤ −256 t: the formula writes 0
      const cap = (cutAt(px, py) - fd) * TILES; noised++;
      if (cap < c) d[o] = Math.min(255, Math.max(0, Math.round(128 + cap / 2)));
    }
    yield;
  }
  return { rows: H, noised, zeroed, kept };
}
