// classify.test — the §3.2 class rules that keep plots dry and water continuous (GROUND lane).
// Why these matter: a base must never stand in water (the owner's "bases fit naturally" bar), rivers must
// never be cut or bead into single-vertex dots at true scale, and the kit hash must be bit-identical so the
// realm map's turf equals the in-game base at "Enter base". Run:
//   scripts/node_modules/.bin/tsx --test concepts/globe3d-2026-09-23/src/realm/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASS, TILES, PLOT_CENTRE, plotOffset, plotRoom } from './contracts.mjs';
import {
  kitHash, classAt, classDetail, synthFields, prepareLines, makeState, plotSdf, PLOT_GEOM, parcelAt,
  legalise, bandTable, mapBandTable, resolveRegion, CLASS_CFG, smax, vnoise, makeFields,
  rayBox, despeckle, DESPECKLE_PASSES, plotAt, plotGeom, clearingSdf, islandSdf, riversOf,
  classWarp, bridgeOf, bridgesFor, plotBridges, meander, claimDist, islandForce, islandReach,
  BAKE, bakeRiverPage, bakeLandPage, samplePage, toHalf, fromHalf, strokeSdf, bridgeForce, clipTarns, packBridge, unpackBridge, sampledWet, segSet, LINE_CAP, clipTarnsSteps, TARN_STEP, foreignSeaRows,
  latticePure, prepareLinesSteps, bendRiversSteps, bendRivers, drain,
} from './classify.mjs';
import { RESOLVE, LATTICE_PASSES } from './groundcost.mjs';
import { LINES } from './contracts.mjs';
import { readFileSync } from 'node:fs';
const TABLES = JSON.parse(readFileSync(new URL('./fixtures/terrain-tables.json', import.meta.url), 'utf8'));

const W = CLASS.WATER;
// G8: the tests that measure invariants of one plot's geometry pin it at its deed centre (offset 0 is one of the
// product's offsets); the offset tests below use the hashed offsets and the extreme corners of plotRoom.
const C0 = [0, 0];
/** Classes of every vertex of deed (dx,dy) (0…98 inclusive) → { g, at(x,y) } in absolute vertices. */
function deedGrid(fields, lines, state, dx, dy, cfg = CLASS_CFG) {
  const n = TILES + 1, g = new Uint8Array(n * n), x0 = dx * TILES, y0 = dy * TILES;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) g[j * n + i] = classAt(fields, lines, state, [x0 + i, y0 + j], cfg);
  return { g, n, x0, y0, at: (x, y) => g[(y - y0) * n + (x - x0)] };
}
function components(set, n, conn8 = false) { // set: Uint8Array n×n of 0/1 → labels
  const lab = new Int32Array(n * n).fill(-1); let k = 0;
  const N = conn8 ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let s = 0; s < n * n; s++) {
    if (!set[s] || lab[s] >= 0) continue;
    const st = [s]; lab[s] = k;
    while (st.length) { const c = st.pop(), x = c % n, y = (c / n) | 0;
      for (const [ox, oy] of N) { const X = x + ox, Y = y + oy; if (X < 0 || Y < 0 || X >= n || Y >= n) continue; const q = Y * n + X; if (set[q] && lab[q] < 0) { lab[q] = k; st.push(q); } } }
    k++;
  }
  return { lab, count: k };
}
const riverH = (y, hw = 1.5, x0 = -50, x1 = 400) => ({ pts: [[x0, y], [x1, y]], hw: [hw, hw] });
// A TRUE-like band table (water↔wild, wild↔turf families; RING draws as wild): what the TRUE page draws is
// resolveRegion's output (G7 despeckle + legalise), so the bead tests measure that grid.
const TRUE_T = bandTable({ classToTerrain: { WATER: 'w', SEA: 'w', DEEP: 'w', WILD: 'x', RING: 'x', TURF: 't' }, families: [{ lower: 'x', upper: 't' }, { lower: 'w', upper: 'x' }] });
function trueGrid(fields, lines, state, dx, dy) {
  const n = TILES + 1, x0 = dx * TILES, y0 = dy * TILES, r = resolveRegion(fields, lines, state, { x0, y0, w: n, h: n, step: 1 }, TRUE_T);
  return { g: r.grid, n, x0, y0, flipped: r.flipped };
}

test('kitHash is bit-identical to realmKitTileHash (pinned vectors from the kit test), so turf variants match the in-game base', () => {
  for (const [tx, ty, pinned] of [[0, 0, 851924796], [-34, -34, 4209988391], [63, 63, 2185463103], [15, 15, 1044870719], [-10, 40, 2091324121], [1, -1, 2225299044]])
    assert.equal(kitHash(tx, ty), pinned, `${tx},${ty}`);
});

// G16 (fix iteration 2): the island that keeps a kingdom dry in a lake or the sea is its plot box grown by an organic margin.
// Why it matters: an island that did not contain the plot box + forcing margin would let water touch the kingdom, and one
// that reached past its bound R would escape the 3×3 deeds every lookup scans (a seam), at any level and plot offset.
test('G16: the island contains the plot box + force + 1 t on every ray and stays inside its bound R, at every level L1–L20 and every offset corner', () => {
  for (let L = 1; L <= 20; L++) {
    const m = plotRoom(L);
    for (const [ox, oy] of [[0, 0], [m, m], [-m, m], [m, -m], [-m, -m], [m, 0], [0, -m]]) for (const [dx, dy] of [[1, 1], [8, 3], [129, 47]]) {
      const state = makeState(dx + 2, dy + 2, [{ x: dx, y: dy, level: L, off: [ox, oy] }]), g = plotAt(state, dx, dy), cx = dx * TILES + g.cx, cy = dy * TILES + g.cy;
      for (let k = 0; k < 360; k += 3) {
        const ux = Math.cos(k * Math.PI / 180), uy = Math.sin(k * Math.PI / 180);
        const need = rayBox(Math.abs(ux), Math.abs(uy), g.half + CLASS_CFG.force + 1, CLASS_CFG.cornerRadius + CLASS_CFG.force + 1);
        assert.ok(islandSdf(state, cx + ux * need, cy + uy * need) <= 1e-9, `L${L} off ${ox},${oy} θ${k}: the island misses the plot box + 4 t`);
        assert.ok(islandSdf(state, cx + ux * (g.R + 0.5), cy + uy * (g.R + 0.5)) > 0, `L${L} θ${k}: the island reaches past R`);
      }
    }
  }
});

test('G16: the island is organic — its reach varies ≥ 4 t around the plot beyond the box, differs per deed, and is deterministic', () => {
  const reach = (dx, dy, L) => { const state = makeState(dx + 2, dy + 2, [{ x: dx, y: dy, level: L, off: C0 }]), g = plotAt(state, dx, dy), out = [];
    for (let k = 0; k < 96; k++) { const ux = Math.cos(k * Math.PI / 48), uy = Math.sin(k * Math.PI / 48); let r = 0;
      while (islandSdf(state, dx * TILES + g.cx + ux * r, dy * TILES + g.cy + uy * r) < 0 && r < 90) r += 0.25;
      out.push(r - rayBox(Math.abs(ux), Math.abs(uy), g.half, CLASS_CFG.cornerRadius)); }
    return out; };
  for (const L of [1, 9, 20]) {
    const a = reach(12, 5, L), b = reach(13, 5, L);
    assert.ok(Math.max(...a) - Math.min(...a) >= 4, `L${L}: the margin past the box varies (${(Math.max(...a) - Math.min(...a)).toFixed(1)} t): not a grown box`);
    assert.ok(a.some((r, k) => Math.abs(r - b[k]) > 1), `L${L}: neighbouring kingdoms get different shores`);
    assert.deepEqual(reach(12, 5, L), a, 'deterministic');
  }
});

// P0 fix pass #4 (Sunscar MAP d 150: an open-sea islet's shallows ring cut by straight vertical and horizontal lines, with a
// stair step at one corner). Why it matters: a plot's island forcing is evaluated only inside a Chebyshev window past its
// box (islandReach: the straight lines) and, at MAP, only in lattice cells flagged near a plot (the stair step). Wherever
// the forcing still lifts the painted sea at the window's edge, the ring ends in a ruled line. So the forcing must be
// below every painted sea (+ the coast smooth-max k) before the window ends, and every point where it still lifts the
// sea must lie within the lattice flag's plot reach (resolve.glsl RAW_FS: plot < reach + 5 t at a vertex ≤ 4.95 t away).
test('G16 halo: an islet\'s shallows end on an organic contour inside its window, never at the window or the lattice-flag edge', () => {
  const I = CLASS_CFG.island, reach = islandReach(I);
  const seaMin = -256 - CLASS_CFG.coastNoise.amp - CLASS_CFG.coastNoise2.amp, noLift = seaMin - CLASS_CFG.coastK; // fieldsA R: 128 + d/2
  for (const L of [1, 7, 14, 20]) for (const [dx, dy] of [[3, 3], [11, 6]]) {
    const state = makeState(dx + 3, dy + 3, [{ x: dx, y: dy, level: L, off: C0 }]), g = plotAt(state, dx, dy), cx = dx * TILES + g.cx, cy = dy * TILES + g.cy;
    // the window's edge, just inside: the forcing lifts no sea there (smax(coast0, f, k) === coast0 for any painted sea)
    const e = g.half + reach - 0.01;
    for (let k = 0; k < 200; k++) {
      const t = -e + (2 * e * k) / 199;
      for (const [x, y] of [[cx + t, cy - e], [cx + t, cy + e], [cx - e, cy + t], [cx + e, cy + t]]) {
        const f = islandForce(state, x, y);
        assert.ok(f <= noLift, `L${L} (${dx},${dy}): forcing ${f.toFixed(1)} at the window edge lifts the sea (a straight cut)`);
        for (const c0 of [seaMin, -40, -6]) assert.equal(smax(c0, f, CLASS_CFG.coastK), c0, `L${L}: the coast changes at the window edge`);
      }
    }
    // rays: the shallows exist (a sea lift past the shore), and wherever the forcing lifts the sea the plot is within the flag reach
    let lifted = 0;
    for (let a = 0; a < 72; a++) {
      const ux = Math.cos(a * Math.PI / 36), uy = Math.sin(a * Math.PI / 36);
      for (let r = 0; r < g.half * Math.SQRT2 + reach + 4; r += 0.5) {
        const x = cx + ux * r, y = cy + uy * r, f = islandForce(state, x, y);
        if (f <= noLift || f >= 0) continue;
        lifted++;
        assert.ok(plotSdf(state, x, y) < reach, `L${L} θ${a * 5}: the forcing lifts the sea ${plotSdf(state, x, y).toFixed(1)} t from the plot, past the flag reach ${reach.toFixed(1)}`);
      }
    }
    assert.ok(lifted > 72 * 10, `L${L}: the islet has shallows (${lifted} lifted samples)`);
  }
});

test('priority order: plot rules beat water, water beats rock, rock beats road, fields beat forest, forest beats special beats ground2', () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: 5, off: C0 }]), c = TILES + PLOT_CENTRE, g = PLOT_GEOM[5];
  const everything = synthFields({ forest: 1, field: 0, special: 1, ground2: 1, rock: 0 });
  // Claim rect is TURF even with a lake painted under it (the lens + forcing keep it dry, the rule order wins anyway).
  assert.equal(classAt(synthFields({ lake: -30 }), null, state, [c, c]), CLASS.TURF);
  assert.equal(classAt(synthFields({ lake: -30 }), null, state, [TILES + g.min, TILES + g.max]), CLASS.TURF, 'closed rect corner');
  // Just outside the claim but inside the plot SDF: RING.
  assert.equal(classAt(everything, null, state, [TILES + g.max + 1, c]), CLASS.RING);
  // Far from the plot, the land rules in order.
  const far = [5, 5];
  assert.equal(classAt(synthFields({ coast: -20 }), null, state, far), CLASS.DEEP);
  assert.equal(classAt(synthFields({ coast: -5 }), null, state, far), CLASS.SEA);
  assert.equal(classAt(synthFields({ lake: -5, rock: 1 }), null, state, far), CLASS.WATER);
  assert.equal(classAt(synthFields({ lake: 1.2, rock: 1 }), null, state, far), CLASS.WILD, 'rock needs water ≥ 2 t away');
  assert.equal(classAt(synthFields({ rock: 1, forest: 1 }), null, state, far), CLASS.ROCK);
  assert.equal(classAt(synthFields({ rock: 1, snow: 1 }), null, state, far), CLASS.SNOW);
  const track = prepareLines({ tracks: [{ pts: [[-50, 5], [400, 5]], hw: 1 }] }, { cols: 3, rows: 3 });
  assert.equal(classAt(synthFields({ field: 1, forest: 1 }), track, state, far), CLASS.ROAD);
  assert.equal(classAt(synthFields({ field: 1, forest: 1, lake: 1.5 }), track, state, far), CLASS.FIELD, 'a road stops 2 t short of water');
  assert.equal(classAt(synthFields({ field: 1, forest: 1 }), null, state, far), CLASS.FIELD);
  assert.equal(classAt(everything, null, state, far), CLASS.FOREST);
  assert.equal(classAt(synthFields({ special: 1, ground2: 1 }), null, state, far), CLASS.SPECIAL);
  assert.equal(classAt(synthFields({ ground2: 1 }), null, state, far), CLASS.GROUND2);
  assert.equal(classAt(synthFields({}), null, state, far), CLASS.WILD);
  // SHORE only in realms that have one.
  const calm = { ...CLASS_CFG, coastNoise: { period: 20, amp: 0, seed: 1 }, coastNoise2: { period: 6, amp: 0, seed: 1 } }, shoreCfg = { ...calm, hasShore: true, beachNoise: { period: 11, amp: 0, seed: 1 } };
  assert.equal(classAt(synthFields({ coast: 1 }), null, state, far, shoreCfg), CLASS.SHORE);
  assert.equal(classAt(synthFields({ coast: 1 }), null, state, far, calm), CLASS.WILD);
});

test('headland: a plot drawn over open sea is forced onto land — no deep, sea or water where plotSdf < 3 (a beach may fringe it)', () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: 12, off: C0 }]);
  const cfg = { ...CLASS_CFG, hasShore: true };
  const { g, n, x0, y0 } = deedGrid(synthFields({ coast: -40 }), null, state, 1, 1, cfg);
  let checked = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p = plotSdf(state, x0 + i, y0 + j); if (p >= 3) continue; checked++;
    assert.ok(![CLASS.DEEP, CLASS.SEA, CLASS.WATER].includes(g[j * n + i]), `${i},${j} p=${p.toFixed(2)} → ${g[j * n + i]}`);
    if (p < 0) assert.ok([CLASS.TURF, CLASS.RING].includes(g[j * n + i]), 'the plot box is the claim or its ring (C8)');
  }
  assert.ok(checked > 1000);
  assert.equal(g[0], CLASS.DEEP, 'the deed corner stays deep sea: the headland is local');
});

// G16 (fix iteration 2, T3 "never a 360° or U loop, the river centreline moves at most 1 tile"): a river through a kingdom
// used to fork round a lensed island (a moat, then a U round a headland). Now the river keeps one channel and passes the
// kingdom on ONE side only, the kingdom standing on the other bank. Why: the owner read the rings and U-bays as diagrams,
// not land; and a cut river (dammed by a plot) or a 1-vertex water run is a visible break at TRUE.
function assertOneSided(g, n, state, x0, y0, gx, gy, geo, arms, h = n) { // g: n wide × h tall
  for (let j = 0; j < h; j++) for (let i = 0; i < n; i++) if (plotSdf(state, x0 + i, y0 + j) < 3) assert.notEqual(g[j * n + i], W, `wet plot vertex ${i},${j}`);
  const wet = new Uint8Array(n * h), dry = new Uint8Array(n * h);
  for (let q = 0; q < n * h; q++) { wet[q] = g[q] === W ? 1 : 0; dry[q] = 1 - wet[q]; }
  const run = (get, len) => { let k = 0; while (k < len) { const v = get(k); let q = k; while (q < len && get(q) === v) q++; if (v && q - k < 2 && k > 0 && q < len) return k; k = q; } return -1; };
  for (let j = 0; j < h; j++) assert.equal(run(i => wet[j * n + i], n), -1, `row ${j}: 1-vertex water run`);
  for (let i = 0; i < n; i++) assert.equal(run(j => wet[j * n + i], h), -1, `col ${i}: 1-vertex water run`);
  const w4 = componentsR(wet, n, h, false), a = w4.lab[arms[0]], b = w4.lab[arms[1]];
  assert.ok(a >= 0 && b >= 0, 'both river arms are water');
  assert.equal(a, b, 'the river is one channel from arm to arm (never cut, never dammed)');
  // one side: over the kingdom's columns every wet vertex lies on the same side of its centre (no fork, no loop)
  let north = 0, south = 0;
  for (let j = 0; j < h; j++) for (let i = Math.max(0, Math.floor(gx - geo.half)); i <= Math.min(n - 1, Math.ceil(gx + geo.half)); i++) if (wet[j * n + i]) { if (j < gy) north++; else south++; }
  assert.ok(north === 0 || south === 0, `the river passes the kingdom on both sides (north ${north}, south ${south})`);
  // the kingdom stands on the other bank: its dry land reaches the window edge away from the river
  const d8 = componentsR(dry, n, h, true), core = d8.lab[gy * n + gx], edge = north ? h - 1 : 0;
  let onEdge = 0; for (let i = 0; i < n; i++) if (d8.lab[edge * n + i] === core) onEdge++;
  assert.ok(onEdge > n / 2, `the kingdom is on a bank, not an island in the river (${onEdge} edge vertices of its land)`);
}
function componentsR(set, w, h, conn8 = false) { // components() on a w×h grid
  const lab = new Int32Array(w * h).fill(-1); let k = 0;
  const N = conn8 ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let s = 0; s < w * h; s++) {
    if (!set[s] || lab[s] >= 0) continue;
    const st = [s]; lab[s] = k;
    while (st.length) { const c = st.pop(), x = c % w, y = (c / w) | 0;
      for (const [ox, oy] of N) { const X = x + ox, Y = y + oy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const q = Y * w + X; if (set[q] && lab[q] < 0) { lab[q] = k; st.push(q); } } }
    k++;
  }
  return { lab, count: k };
}
for (const L of [1, 4, 5, 8, 9, 12, 13, 16, 17, 20]) test(`L${L}: a river through the plot centre passes it on one side — dry plot, one channel, no bead, no loop, the kingdom on a bank (G16)`, () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: L, off: C0 }]), c = TILES + PLOT_CENTRE, geo = PLOT_GEOM[L];
  const lines = prepareLines({ rivers: [riverH(c)] }, { cols: 3, rows: 3 });
  const { g, n, x0, y0 } = trueGrid(synthFields(), lines, state, 1, 1);
  const ci = PLOT_CENTRE, rowOf = x => { for (let dy = -49; dy <= 49; dy++) if (g[(ci + dy) * n + x] === W) return (ci + dy) * n + x; return ci * n + x; };
  assertOneSided(g, n, state, x0, y0, ci, ci, geo, [rowOf(1), rowOf(n - 2)]);
});

for (const L of [1, 20]) test(`L${L}: a lake under the plot leaves 0 water vertices where plotSdf < 3 (the plot becomes an island)`, () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: L, off: C0 }]), c = TILES + PLOT_CENTRE;
  const fields = synthFields({ lake: (x, y) => Math.hypot(x - c, y - c) - 44 });
  const { g, n, x0, y0 } = deedGrid(fields, null, state, 1, 1);
  let wet = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (g[j * n + i] === W) wet++;
    if (plotSdf(state, x0 + i, y0 + j) < 3) assert.notEqual(g[j * n + i], W, `${i},${j}`);
  }
  assert.ok(wet > 500, 'the lake survives around the plot');
});

// G16: "the river centreline moves at most 1 tile" wherever a river does not cross a kingdom's plot box + force + 1 t. Why:
// the lens pushed every nearby river and loch into bulges round kingdoms (Frostveil), which the owner read as diagrams.
for (const L of [1, 5, 9, 13, 17, 20]) test(`L${L}: a river passing just clear of the plot is not moved, keeps ≥ 2 vertices across and stays one piece`, () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: L, off: C0 }]), c = TILES + PLOT_CENTRE, geo = PLOT_GEOM[L];
  const y = c - Math.ceil(geo.half + CLASS_CFG.force + 1 + 1.5 * 1.3 + CLASS_CFG.bend.clear + CLASS_CFG.riverMeander.amp + CLASS_CFG.riverMeander.amp2 + 1);
  const lines = prepareLines({ rivers: [riverH(y)] }, { cols: 3, rows: 3 }), bent = riversOf(lines, state);
  assert.equal(bent.moved, 0, 'no vertex of the river moved');
  const { g, n } = trueGrid(synthFields(), lines, state, 1, 1); // what TRUE draws (G7)
  const half = PLOT_CENTRE; // rows 0…48: the northern half of the deed holds the whole river
  for (let i = 0; i < n; i++) {
    let runs = 0, yy = 0;
    while (yy < half) { if (g[yy * n + i] === W) { let k = 0; while (yy < half && g[yy * n + i] === W) { k++; yy++; } runs++; assert.ok(k >= 2, `column ${i}: run ${k}`); } else yy++; }
    assert.ok(runs >= 1, `column ${i} lost the river`);
  }
  const wet = new Uint8Array(n * n); for (let s = 0; s < half * n; s++) wet[s] = g[s] === W ? 1 : 0;
  assert.equal(components(wet, n).count, 1, 'one connected river');
});

test('rivers and tracks never thin below their clamps outside plots (M4): hw 0.4 in the file is drawn at ≥ 1.5 / 1.0 t', () => {
  const state = makeState(3, 3, []);
  const lines = prepareLines({ rivers: [riverH(40.5, 0.4)], tracks: [{ pts: [[-50, 150.5], [400, 150.5]], hw: 0.2 }] }, { cols: 3, rows: 3 });
  const f = synthFields();
  for (let x = 0; x < 294; x += 7) {
    let rw = 0, tw = 0;
    for (let y = 30; y < 52; y++) if (classAt(f, lines, state, [x, y]) === W) rw++;
    for (let y = 140; y < 162; y++) if (classAt(f, lines, state, [x, y]) === CLASS.ROAD) tw++;
    assert.ok(rw >= 2, `river column ${x}: ${rw}`); assert.ok(tw >= 2, `track column ${x}: ${tw}`);
  }
});

test('field parcels are 10–18 tile rectangles, each one wholly field or not (evaluated at its centre)', () => {
  const seen = new Set();
  for (let y = 0; y < 300; y += 3) for (let x = 0; x < 300; x += 3) {
    const [x0, y0, x1, y1] = parcelAt(x, y);
    assert.ok(x >= x0 && x < x1 && y >= y0 && y < y1);
    assert.ok(x1 - x0 >= 10 && x1 - x0 <= 18 && y1 - y0 >= 10 && y1 - y0 <= 18, `${x0},${y0},${x1},${y1}`);
    seen.add(`${x0},${y0}`);
  }
  assert.ok(seen.size > 200);
  // A field density edge at x = 150 never splits a parcel (G11: parcels live in the warped lookup space, so in the world they
  // are organic patches — every vertex that looks up the same parcel gets the same class) …
  const state = makeState(4, 4, []), f = synthFields({ field: x => (x < 150 ? 1 : 0) }), byParcel = new Map(), edge = [];
  for (let y = 0; y < 200; y++) { let first = -1;
    for (let x = 100; x < 200; x++) {
      const [wx, wy] = classWarp(x, y), key = parcelAt(Math.floor(wx + 0.5), Math.floor(wy + 0.5)).join(), c = classAt(f, null, state, [x, y]);
      if (byParcel.has(key)) assert.equal(c, byParcel.get(key), `parcel ${key} split at ${x},${y}`); else byParcel.set(key, c);
      if (first < 0 && c !== CLASS.FIELD) first = x;
    }
    edge.push(first);
  }
  // … and the painted straight edge is no longer a ruled line in the world: it wanders ≥ 8 t across the rows
  assert.ok(Math.max(...edge) - Math.min(...edge) >= 8, `the field edge wanders (${Math.min(...edge)}…${Math.max(...edge)})`);
});

// A MAP-like table: WILD sand pure under M1 forest, M2 field, M3 rock; M4 dunes sit on ROCK (a Frostveil-style
// glacier case), so SPECIAL may only touch ROCK — its fallback is ROCK.
const mapTable = () => bandTable({
  classToTerrain: { DEEP: 'w', SEA: 'w', WATER: 'w', SHORE: 'w', ROAD: 'w', TURF: 'w', RING: 'w', WILD: 'w', GROUND2: 'm5', FIELD: 'm2', ROCK: 'm3', SNOW: 'm3', SPECIAL: 'm4', FOREST: 'm1' },
  families: [{ lower: 'w', upper: 'm1' }, { lower: 'w', upper: 'm2' }, { lower: 'w', upper: 'm3' }, { lower: 'w', upper: 'm5' }, { lower: 'm3', upper: 'm4' }],
  fallback: { SPECIAL: 'ROCK', FOREST: 'WILD', FIELD: 'WILD', GROUND2: 'WILD', ROCK: 'WILD' },
  sharedLower: ['w'],
});

test('legalise: uppers over the shared WILD lower always compose, M4 may only touch its ROCK lower (8-neighbour, incl. diagonals)', () => {
  const T = mapTable(), S = CLASS.SPECIAL, R = CLASS.ROCK, Wd = CLASS.WILD, F = CLASS.FOREST, Fi = CLASS.FIELD;
  // Forest next to field next to rock: all compose over WILD → no collapse.
  let r = legalise(Uint8Array.from([F, Fi, R, F, Fi, R, F, Fi, R]), 3, 3, T);
  assert.equal(r.collapsed, 0); assert.equal(r.illegal, 0);
  // SPECIAL inside rock: legal.
  r = legalise(Uint8Array.from([R, R, R, R, S, R, R, R, R]), 3, 3, T);
  assert.equal(r.collapsed, 0);
  // SPECIAL touching WILD only diagonally still collapses to ROCK (8-neighbourhood).
  r = legalise(Uint8Array.from([Wd, R, R, R, S, R, R, R, R]), 3, 3, T);
  assert.equal(r.grid[4], R); assert.equal(r.collapsed, 1); assert.equal(r.illegal, 0);
  // SPECIAL touching forest: the higher-priority… SPECIAL ranks below FOREST, but FOREST falls back to WILD,
  // which SPECIAL still cannot touch, so the second pass collapses SPECIAL too: 0 illegal pairs left.
  r = legalise(Uint8Array.from([F, S, R, F, S, R, F, S, R]), 3, 3, T);
  assert.equal(r.illegal, 0);
  assert.ok(r.grid.every((c, i) => c !== S || [1, 4, 7].includes(i)));
  // Deterministic and symmetric: mirrored input → mirrored output.
  const a = Uint8Array.from([Wd, S, R, R, S, Wd, R, S, R]), m = Uint8Array.from([R, S, Wd, Wd, S, R, R, S, R]);
  const ra = legalise(a, 3, 3, T).grid, rm = legalise(m, 3, 3, T).grid;
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) assert.equal(ra[y * 3 + x], rm[y * 3 + 2 - x]);
});

test('legalise leaves TURF alone (no fallback) and reports an unresolvable pair instead of hiding it', () => {
  const T = bandTable({ classToTerrain: { TURF: 't', WILD: 'w', WATER: 'water' }, families: [{ lower: 'w', upper: 't' }, { lower: 'water', upper: 'w' }] });
  const r = legalise(Uint8Array.from([CLASS.TURF, CLASS.WATER]), 2, 1, T);
  assert.deepEqual([...r.grid], [CLASS.TURF, CLASS.WATER]);
  assert.equal(r.collapsed, 0); assert.equal(r.illegal, 1);
});

test('resolveRegion on a tiled lattice equals one big resolve (the apron makes page seams invisible)', () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: 7, off: C0 }]), c = TILES + PLOT_CENTRE;
  // A rock massif, and a separate SPECIAL (M4-on-rock) field that touches WILD, so its rim must collapse.
  const f = synthFields({ rock: (x, y) => (Math.hypot(x - 60, y - 230) < 40 ? 1 : 0), special: (x, y) => (Math.hypot(x - 230, y - 60) < 25 ? 1 : 0), forest: x => (x > 250 ? 1 : 0) });
  const lines = prepareLines({ rivers: [riverH(c)] }, { cols: 3, rows: 3 });
  const T = mapTable();
  const big = resolveRegion(f, lines, state, { x0: 0, y0: 0, w: 42, h: 42, step: 7 }, T);
  for (const [px, py] of [[0, 0], [21, 0], [0, 21], [21, 21]]) {
    const part = resolveRegion(f, lines, state, { x0: px * 7, y0: py * 7, w: 21, h: 21, step: 7 }, T);
    for (let j = 0; j < 21; j++) for (let i = 0; i < 21; i++) assert.equal(part.grid[j * 21 + i], big.grid[(py + j) * 42 + px + i], `${px + i},${py + j}`);
  }
  assert.equal(big.illegal, 0);
  assert.ok(big.collapsed > 0, 'the SPECIAL disc touching WILD collapsed at its rim');
});

// W1 G2 (RM-GPU-1 follow-up): rm-map reads a lattice corner's purity bit (its 3×3 is one map slot) instead of fetching the
// 4×4 block per pixel (61 → 53 fetches, so SHELL can draw MAP at full resolution at rest). The bit decides where the
// corner-Wang pure variants and the class-edge warp apply, so a sub-tile seam must not change it: the GPU resolves one
// more apron vertex for it (groundcost RESOLVE.apron = LATTICE_PASSES.length), and the JS twin with the same apron tiles
// exactly. Teeth: the purity of a tile resolved WITHOUT the extra apron vertex differs at its border.
test('lattice purity: a vertex is pure iff its 3×3 is one map slot, and a tiled resolve equals one big resolve', () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: 7, off: C0 }]), c = TILES + PLOT_CENTRE;
  const f = synthFields({ rock: (x, y) => (Math.hypot(x - 60, y - 230) < 40 ? 1 : 0), special: (x, y) => (Math.hypot(x - 230, y - 60) < 25 ? 1 : 0), forest: x => (x > 250 ? 1 : 0) });
  const lines = prepareLines({ rivers: [riverH(c)] }, { cols: 3, rows: 3 });
  const T = mapTable(), ids = [...new Set(T.terrainOf)], slots = T.terrainOf.map(t => ids.indexOf(t));
  const big = resolveRegion(f, lines, state, { x0: 0, y0: 0, w: 42, h: 42, step: 7 }, T, undefined, { slots });
  // the rule itself, on the big region's own classes
  let pure = 0, mixed = 0;
  for (let j = 1; j < 41; j++) for (let i = 1; i < 41; i++) {
    let one = true; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if (slots[big.ground[(j + b) * 42 + i + a]] !== slots[big.ground[j * 42 + i]]) one = false;
    assert.equal(big.pure[j * 42 + i], one ? 1 : 0, `${i},${j}`); if (one) pure++; else mixed++;
  }
  assert.ok(pure > 200 && mixed > 100, `the fixture has pure (${pure}) and mixed (${mixed}) vertices`);
  for (const [px, py] of [[0, 0], [21, 0], [0, 21], [21, 21]]) {
    const part = resolveRegion(f, lines, state, { x0: px * 7, y0: py * 7, w: 21, h: 21, step: 7 }, T, undefined, { slots });
    for (let j = 0; j < 21; j++) for (let i = 0; i < 21; i++) assert.equal(part.pure[j * 21 + i], big.pure[(py + j) * 42 + px + i], `${px + i},${py + j}`);
  }
  // teeth: without the purity apron vertex the tile border reads 0 where the big resolve says pure
  const short = resolveRegion(f, lines, state, { x0: 21 * 7, y0: 21 * 7, w: 21, h: 21, step: 7 }, T, undefined, { slots: null });
  const edge = latticePure(short.ground, 21, 21, slots); let differ = 0;
  for (let k = 0; k < 21; k++) if (edge[k] !== big.pure[21 * 42 + 21 + k]) differ++;
  assert.ok(differ > 0, 'a tile without the extra apron vertex agrees at its border: the test lost its teeth');
  // the GPU resolve: raw over the apron, then one vertex per pass (despeckle ×2, legalise ×2, purity)
  assert.equal(RESOLVE.apron, LATTICE_PASSES.length); assert.equal(LATTICE_PASSES.at(-1), 'pure');
});

test('fields decode the pack encoding: SDF 128 + d/2 tiles with manual bilinear at texel centres', () => {
  const w = 4, h = 4, A = new Uint8Array(w * h * 3), BC = new Uint8Array(w * 2 * 2 * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = (j * w + i) * 3; A[o] = 128 + i * 10; A[o + 1] = 100; A[o + 2] = 255; }
  BC.fill(0); BC[(0 * 4 + 2) * 3 + 1] = 255; // right half, texel (0,0): ground2 = 1
  const f = makeFields({ fieldsA: { width: w, height: h, data: A, channels: 3 }, fieldsBC: { width: 4, height: 2, data: BC, channels: 3 } });
  // Texel 1 centre (x = 1.5/8 deed): coast = (138 − 128)·2 = 20 t; halfway to texel 2 → 30 t.
  assert.equal(f.coast(1.5 * TILES / 8, 10), 20);
  assert.equal(f.coast(2 * TILES / 8, 10), 30);
  assert.equal(f.lake(0, 0), -56);
  assert.equal(f.relief(50, 50), 1);
  assert.equal(f.ground2(0, 0), 1);
  assert.equal(f.forest(0, 0), 0);
});

test('smax never undercuts max (so forcing always wins) and the noise stays in [−1, 1]', () => {
  for (let a = -8; a <= 8; a += 0.5) for (let b = -8; b <= 8; b += 0.5) assert.ok(smax(a, b, 6) >= Math.max(a, b));
  let lo = 1, hi = -1;
  for (let i = 0; i < 4000; i++) { const v = vnoise(i * 3, i * 7 - 9000, 9, 7); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(lo >= -1 && hi <= 1 && hi - lo > 1.2);
});

// G16: the bend is local and one-sided. Why: the river must read as the same river (its course unchanged away from the
// kingdom), bend only as far as the plot needs, never double back, and a tributary joining it near a kingdom stays joined.
test('G16 bendRivers: a crossing river moves one-sided and only near the plot, never folds back, and confluences stay joined', () => {
  const state = makeState(5, 3, [{ x: 2, y: 1, level: 12, off: C0 }]), c = 2 * TILES + PLOT_CENTRE, cy = TILES + PLOT_CENTRE, g = PLOT_GEOM[12];
  const main = { pts: [[-30, cy], [5 * TILES + 30, cy]], hw: 2 }, trib = { pts: [[c + 40, -20], [c + 40, cy]], hw: 1.5 };
  const lines = prepareLines({ rivers: [main, trib] }, { cols: 5, rows: 3 }), plain = lines.rivers, bent = riversOf(lines, state);
  assert.ok(bent.moved > 0, 'the river through the kingdom moved');
  const P0 = lines.polys[0].P, S = bent.segs, n0 = P0.length / 2 - 1; let side = 0, far = 0, maxPush = 0; // segment i of the main river starts at its vertex i
  for (let i = 0; i < n0; i++) {
    const x = P0[2 * i], dy = S[i * 6 + 1] - P0[2 * i + 1];            // segment i starts at vertex i of the main river
    if (Math.abs(x - c) > 150) far = Math.max(far, Math.abs(dy));
    if (Math.abs(dy) > 0.5) { const sg = Math.sign(dy); assert.ok(!side || sg === side, 'every vertex moves to the same side'); side = sg; }
    maxPush = Math.max(maxPush, Math.abs(dy));
  }
  assert.ok(far <= 1, `the course away from the kingdom is unchanged (${far.toFixed(2)} t)`);
  assert.ok(maxPush <= g.half + CLASS_CFG.force + 1 + 2 * 1.3 + CLASS_CFG.bend.clear + 4, `the push is only what the plot needs (${maxPush.toFixed(1)} t)`);
  for (let i = 0; i + 1 < n0; i++) assert.ok(S[(i + 1) * 6] > S[i * 6], 'the bent river never folds back on itself');
  assert.equal(plain.count, bent.count, 'the same vertices, moved');
  const { g: G, n } = trueGrid(synthFields(), lines, state, 2, 1);
  assert.equal(components(Uint8Array.from(G, q => (q === W ? 1 : 0)), n).count, 1, 'the tributary still meets the bent main river');
});

// Stage B (RM-GPU-1 W1 blocker 5, D-167 no main-thread task > 50 ms): on the W1 QA host prepareLines took 22–68 ms and the
// first bendRivers 20–129 ms, each ONE task, at every realm entry and (the bend) every base-state change. Both are step
// generators now, run by ground.mjs in ≤ SLICE_MS slices. Why it matters: the result must be exactly the synchronous one
// (the GPU bakes the same river pages, LIFE and QA read the same classes), and no step may hold a big share of the work.
// Measured in process CPU time (a preempted step on a loaded test host does not count against it). Teeth: a generator that
// does the work in one step (the pre-Stage-B shape) holds 100 % of it in one step; one that yields only per iteration or
// only at the end fails the share bound.
test('Stage B: prepareLines and bendRivers run as step generators with the synchronous result and no step holding the work', () => {
  const cols = 24, rows = 16, rivers = [];
  for (let r = 0; r < 60; r++) { const pts = []; for (let i = 0; i <= 40; i++) pts.push([i * cols * TILES / 40 + (r % 7) * 3, (r + 0.5) * rows * TILES / 60 + 30 * Math.sin(i * 0.4 + r)]); rivers.push({ pts, hw: 1.5 + (r % 3) }); }
  const bases = []; for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if ((kitHash(x, y) & 3) !== 0) bases.push({ x, y, level: 1 + kitHash(y, x) % 20 });
  const json = { rivers, tracks: [{ pts: [[0, 40], [cols * TILES, 900]], hw: 1 }] }, state = makeState(cols, rows, bases);
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const run = job => { let worst = 0, total = 0, steps = 0, r; do { const t = cpu(); r = job.next(); const d = cpu() - t; worst = Math.max(worst, d); total += d; steps++; } while (!r.done); return { value: r.value, worst, total, steps }; };
  const P = run(prepareLinesSteps(json, { cols, rows })), sync = prepareLines(json, { cols, rows });
  const segsEq = (a, b) => a.count === b.count && a.segs.every((v, i) => Object.is(v, b.segs[i])) && [...a.cells].every(([k, v]) => b.cells.get(k)?.join() === v.join());
  assert.ok(segsEq(P.value.rivers, sync.rivers) && segsEq(P.value.tracks, sync.tracks), 'the sliced lines equal prepareLines');
  assert.ok(P.steps >= rivers.length, `one step per polyline at least (${P.steps})`);
  const B = run(bendRiversSteps(sync, state)), bs = bendRivers(sync, state);
  assert.ok(bs.moved > 0, 'the synthetic plots bend the rivers'); assert.ok(segsEq(B.value, bs) && B.value.moved === bs.moved, 'the sliced bend equals bendRivers');
  assert.ok(B.steps >= rivers.length * 2, `the bend steps per polyline (${B.steps})`);
  for (const [n, x] of [['prepareLines', P], ['bendRivers', B]]) assert.ok(x.worst <= Math.max(2, x.total * 0.2), `${n}: one step held ${x.worst.toFixed(1)} of ${x.total.toFixed(1)} ms CPU`);
  assert.deepEqual(drain((function* () { yield; yield; return 7; })()), 7, 'drain runs a step generator to its value');
});

test('MAP tables of all five realms (PACK terrain-tables.json): uppers over WILD compose freely, an M4 on rock collapses to ROCK where it meets anything else', () => {
  for (const [id, r] of Object.entries(TABLES.realms)) {
    const T = mapBandTable(r.map), onRock = r.map.families.M4.lower !== r.map.wild;
    // The class drawn by M4 differs per realm (Frostveil/Cinderfall SPECIAL, Stormcairn SNOW; Crownlands only
    // when its SNOW share passes 0.5 %).
    const m4 = Object.keys(r.map.classToTerrain).find(c => r.map.classToTerrain[c] === 'M4');
    if (!m4) continue;
    const S = CLASS[m4], Rk = CLASS.ROCK, Wd = CLASS.WILD, F = CLASS.FOREST, Wt = CLASS.WATER, G = CLASS.GROUND2;
    // Forest | ground2 | water | wild mixes never collapse (all draw over the WILD base).
    assert.equal(legalise(Uint8Array.from([F, G, Wt, Wd, F, G, Wt, Wd, F]), 3, 3, T).collapsed, 0, id);
    const g = legalise(Uint8Array.from([Rk, Rk, Rk, Rk, S, Wd, Rk, Rk, Rk]), 3, 3, T);
    assert.equal(g.illegal, 0, id);
    if (onRock) {
      assert.equal(g.grid[4], Rk, `${id}: the M4 vertex touching WILD falls back to ROCK`);
    } else assert.equal(g.collapsed, 0, `${id}: M4 sits on WILD (Sunscar dunes)`);
  }
});

// G16 (was G3): a river at ANY offset from the plot centre must give clean water: no bead (single-vertex water run, the
// plan's QC) and no one-vertex dry spit along any row or column (the bend moves it clear; G7 fills what is left); the plot
// stays dry.
for (const L of [1, 9, 20]) for (const D of [2, 4, 8, 14, 20, 28, 36]) test(`L${L}: a river ${D} t from the plot centre draws no beads at TRUE (no 1-vertex water run, no 1-vertex dry spit)`, () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: L, off: C0 }]), c = TILES + PLOT_CENTRE;
  const lines = prepareLines({ rivers: [riverH(c + D)] }, { cols: 3, rows: 3 });
  const { g, n, x0, y0 } = trueGrid(synthFields(), lines, state, 1, 1);
  const wetAt = (i, j) => g[j * n + i] === W;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (plotSdf(state, x0 + i, y0 + j) < 3) assert.ok(!wetAt(i, j), `wet plot ${i},${j}`);
  const spits = new Set();
  const scan = (get, len, label, key) => { // runs along one line: water runs ≥ 2; count dry runs of 1 between water
    const runs = []; let k = 0;
    while (k < len) { const v = get(k); let m = k; while (m < len && get(m) === v) m++; runs.push([v, m - k, k]); k = m; }
    runs.forEach(([v, l, at], r) => { // a run cut by the deed border is not a bead (the bent river crosses rows obliquely)
      if (v && l < 2 && r > 0 && r < runs.length - 1) assert.fail(`${label}: 1-vertex water run at ${at}`);
      if (!v && l < 2 && r > 0 && r < runs.length - 1) spits.add(key(at));
    });
  };
  for (let j = 0; j < n; j++) scan(i => wetAt(i, j), n, `row ${j}`, i => `${i},${j}`);
  for (let i = 0; i < n; i++) scan(j => wetAt(i, j), n, `col ${i}`, j => `${i},${j}`);
  assert.equal(spits.size, 0, `one-vertex dry spits: ${[...spits].join(" ")}`); // G7 despeckle turns them to water
});

// G16 (was G3) for lakes: a lake shore passing D t from the plot centre meets the island's organic margin (a headland);
// the smooth union must leave no bead and keep the plot dry.
for (const L of [1, 12, 20]) for (const D of [3, 8, 16, 26, 36]) test(`L${L}: a lake shore ${D} t from the plot centre draws no beads at TRUE`, () => {
  const state = makeState(3, 3, [{ x: 1, y: 1, level: L, off: C0 }]), c = TILES + PLOT_CENTRE;
  const { g, n, x0, y0 } = trueGrid(synthFields({ lake: (x, y) => (c + D) - y }), null, state, 1, 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (plotSdf(state, x0 + i, y0 + j) < 3) assert.notEqual(g[j * n + i], W, `wet plot ${i},${j}`);
  // 1-vertex runs of either kind between two opposite runs (the deed's border rows are cut by the grid)
  const line = get => { let k = 0; while (k < n) { const v = get(k); let m = k; while (m < n && get(m) === v) m++; if (m - k < 2 && k > 0 && m < n) return k; k = m; } return -1; };
  for (let j = 0; j < n; j++) assert.equal(line(i => g[j * n + i] === W), -1, `row ${j}: 1-vertex run`);
  for (let i = 0; i < n; i++) assert.equal(line(j => g[j * n + i] === W), -1, `col ${i}: 1-vertex run`);
});

// G7 despeckle: the Gate A bead — a diagonal row of single land vertices in the water beside a 1-vertex spit —
// must vanish at TRUE, while rivers at their clamp width and plots stay exactly as classified.
test('despeckle removes land beads, 1-vertex spits and water specks, and never touches plots or clamped rivers', () => {
  const Wt = CLASS.WATER, Wd = CLASS.WILD, n = 16, g = new Uint8Array(n * n).fill(Wt);
  for (let k = 2; k < 9; k++) g[k * n + k] = Wd;                   // diagonal row of land beads
  for (let y = 2; y < 12; y++) g[y * n + 12] = CLASS.FIELD;         // a 1-vertex-wide spit (column 12)
  let r = despeckle(g, n, n);
  assert.ok(r.grid.every((c, i) => { const x = i % n, y = (i / n) | 0; return x === 0 || y === 0 || x === n - 1 || y === n - 1 || c === Wt; }), 'all land beads and the spit became water');
  // a water speck in land, and a plot next to it that must not move
  const h = new Uint8Array(n * n).fill(Wd); h[5 * n + 5] = Wt; h[5 * n + 7] = CLASS.RING; h[6 * n + 7] = CLASS.TURF;
  r = despeckle(h, n, n);
  assert.equal(r.grid[5 * n + 5], Wd); assert.equal(r.grid[5 * n + 7], CLASS.RING); assert.equal(r.grid[6 * n + 7], CLASS.TURF);
  // a clamped river (hw 1.5 → ≥ 3 vertices across) keeps every vertex through all passes
  const state = makeState(3, 3, []), lines = prepareLines({ rivers: [{ pts: [[-50, 120.3], [400, 190.7]], hw: [0.4, 0.4] }] }, { cols: 3, rows: 3 });
  // (G14: the river now meanders, and its bank noise may leave a lone dry hole inside it: despeckle only fills those)
  const f = synthFields(), raw = deedGrid(f, lines, state, 1, 1).g, t = trueGrid(f, lines, state, 1, 1);
  assert.ok(t.flipped <= 4, `almost nothing to despeckle along a clamped river (${t.flipped})`);
  raw.forEach((c, i) => { if (c === Wt) assert.equal(t.g[i], Wt, `river vertex ${i % 99},${(i / 99) | 0} kept`); });
  const wet = Uint8Array.from(t.g, c => (c === Wt ? 1 : 0)); assert.equal(components(wet, 99).count, 1, 'one river');
  assert.equal(DESPECKLE_PASSES, 6);
});

// G5 → G9: the clearing keeps every obstacle out of the plot box (the fence and fields never meet rock, forest, crops
// or water), but a kingdom stands on the realm's own ground (WILD/GROUND2), and the cleared edge is organic.
test('G9/G12: nothing may be put in the plot box (RING for LIFE), the clearance edge wobbles past the plain box', () => {
  for (const L of [1, 9, 20]) for (const f of [{ rock: 1 }, { forest: 1 }, { field: 1 }, { rock: 1, snow: 1 }]) {
    const state = makeState(3, 3, [{ x: 1, y: 1, level: L }]);
    const { g, n, x0, y0 } = deedGrid(synthFields(f), null, state, 1, 1);
    let outside = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const p = plotSdf(state, x0 + i, y0 + j), c = g[j * n + i];
      if (p < 1) assert.ok([CLASS.TURF, CLASS.RING].includes(c), `L${L} ${JSON.stringify(f)} ${i},${j}: ${c} (C8: box + 1 t is RING)`);
      if (p >= 0 && [CLASS.RING, CLASS.WILD].includes(c)) outside++;
    }
    assert.ok(outside > 20, `L${L} ${JSON.stringify(f)}: the cleared edge wobbles past the plain box (${outside} vertices)`);
  }
  // the realm's ground stays (G12): GROUND2 in the clearing is not repainted — LIFE sees RING there, the ground draws GROUND2
  const state = makeState(3, 3, [{ x: 1, y: 1, level: 9 }]), g = plotAt(state, 1, 1), v = [TILES + g.cx + g.half + 2, TILES + g.cy];
  assert.ok(clearingSdf(state, v[0], v[1]) < 0, 'the probe point is in the clearing');
  const d = classDetail(synthFields({ ground2: 1 }), null, state, v);
  assert.equal(d.cls, CLASS.RING); assert.equal(d.ground, CLASS.GROUND2);
});

// G8 (round 2, T3 "bases fit naturally, not a rigid lattice"): every plot sits at contracts.plotOffset. GROUND's JS
// reference must use exactly the hashed offset the GPU and BASES use, or the clearing, the island and the kingdom
// sprites would disagree about where the kingdom is.
test('G8: plots sit at the hashed contracts.plotOffset (the product path), claim and plot box inside the deed', () => {
  const bases = []; for (let k = 0; k < 60; k++) bases.push({ x: (k % 10) * 2, y: Math.floor(k / 10) * 3, level: 1 + ((k * 7) % 20) });
  const seen = new Set(bases.map(b => b.y * 20 + b.x)), uniq = bases.filter((b, i) => bases.findIndex(c => c.x === b.x && c.y === b.y) === i);
  const state = makeState(20, 20, uniq); let moved = 0;
  for (const b of uniq) {
    const g = plotAt(state, b.x, b.y), o = plotOffset(b.x, b.y, b.level);
    assert.equal(g.cx, PLOT_CENTRE + o.dx); assert.equal(g.cy, PLOT_CENTRE + o.dy);
    if (o.dx || o.dy) moved++;
    assert.ok(g.cx - g.half >= 0 && g.cx + g.half <= TILES && g.cy - g.half >= 0 && g.cy + g.half <= TILES, 'plot box inside the deed');
    // the claim (TURF) follows the offset centre
    assert.equal(classAt(synthFields({ rock: 1 }), null, state, [b.x * TILES + g.cx, b.y * TILES + g.cy]), CLASS.TURF);
    assert.equal(classAt(synthFields({ rock: 1 }), null, state, [b.x * TILES + g.maxX, b.y * TILES + g.minY]), CLASS.TURF, 'closed claim corner');
  }
  assert.ok(seen.size > 30 && moved > uniq.length * 0.8, `most plots are off-centre (${moved}/${uniq.length}): no rigid lattice`);
});

// G8 + G7 + G16: an offset plot on a river still stays dry, draws no beads at TRUE and stands on one bank (the plot now sits
// off the deed centre, up to plotRoom from it, so its bend reaches into the neighbour deeds).
for (const L of [1, 9, 20]) for (const s of [1, -1]) test(`G8: L${L} plot at offset (${s > 0 ? '+' : '−'}room, ${s > 0 ? '−' : '+'}room) with a river through its centre: dry plot, one river channel, no 1-vertex water run, one side only`, () => {
  const m = plotRoom(L), off = [s * m, -s * m], state = makeState(3, 3, [{ x: 1, y: 1, level: L, off }]);
  const cy = TILES + PLOT_CENTRE + off[1];
  const lines = prepareLines({ rivers: [riverH(cy)] }, { cols: 3, rows: 3 });
  // the whole column of deeds: at the largest offset the bend reaches into the neighbour deed
  const n = TILES + 1, h = 3 * TILES + 1, x0 = TILES, y0 = 0, g = resolveRegion(synthFields(), lines, state, { x0, y0, w: n, h, step: 1 }, TRUE_T).grid;
  const gx = PLOT_CENTRE + off[0], gy = TILES + PLOT_CENTRE + off[1], rowOf = x => { for (let j = 0; j < h; j++) if (g[j * n + x] === W) return j * n + x; return gy * n + x; };
  assertOneSided(g, n, state, x0, y0, gx, gy, plotAt(state, 1, 1), [rowOf(1), rowOf(n - 2)], h);
});

// G9 (Gate A2 GA2-08 "clearings are straight-edged octagons or squircles pasted into rock"): the clearing around a
// kingdom must read as a natural clearing — its edge distance varies a lot around the plot and between plots — yet it
// always contains the plot box (BASES' fence and fields) and never claims water outside it.
test('G9: the clearing is organic — contains the plot box, its edge wanders ≥ 4 t around the plot, differs per deed, never wet outside the box', () => {
  const edgeProfile = (state, dx, dy) => { // clearing edge distance from the plot centre along 64 rays
    const g = plotAt(state, dx, dy), out = [];
    for (let k = 0; k < 64; k++) { const ux = Math.cos(k * Math.PI / 32), uy = Math.sin(k * Math.PI / 32); let r = 0;
      while (clearingSdf(state, dx * TILES + g.cx + ux * r, dy * TILES + g.cy + uy * r) < 0 && r < 49) r += 0.25; out.push(r); }
    return out;
  };
  for (const L of [1, 9, 20]) {
    const state = makeState(5, 3, [{ x: 1, y: 1, level: L }, { x: 3, y: 1, level: L }]);
    const a = edgeProfile(state, 1, 1), b = edgeProfile(state, 3, 1), g = plotAt(state, 1, 1);
    // relative to its own base shape (the rounded box of half + extra), the wobble spans ≥ 4 t
    const base = Array.from({ length: 64 }, (_, k) => rayBox(Math.abs(Math.cos(k * Math.PI / 32)), Math.abs(Math.sin(k * Math.PI / 32)), g.half + CLASS_CFG.clearing.extra, CLASS_CFG.clearing.corner));
    const dev = a.map((r, k) => r - base[k]);
    assert.ok(Math.max(...dev) - Math.min(...dev) >= 4, `L${L}: the edge wanders (${(Math.max(...dev) - Math.min(...dev)).toFixed(1)} t)`);
    assert.ok(a.some((r, k) => Math.abs(r - b[k]) > 1), `L${L}: neighbouring kingdoms get different clearings`);
    // contains the plot box (the fence square) on every ray, with the corner arc outside the box corner
    for (let k = 0; k < 64; k++) { const ux = Math.abs(Math.cos(k * Math.PI / 32)), uy = Math.abs(Math.sin(k * Math.PI / 32)); assert.ok(a[k] >= rayBox(ux, uy, g.half, CLASS_CFG.cornerRadius) - 0.25, `L${L} ray ${k}`); }
  }
  // in open water the clearing claims nothing beyond the headland's dry island
  const state = makeState(3, 3, [{ x: 1, y: 1, level: 9 }]), { g, n, x0, y0 } = deedGrid(synthFields({ coast: -40 }), null, state, 1, 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (g[j * n + i] === CLASS.RING && plotSdf(state, x0 + i, y0 + j) >= 0) {
    const d = classDetail(synthFields({ coast: -40 }), null, state, [x0 + i, y0 + j]);
    assert.ok(d.coast >= 0 && d.inland >= 0, `RING on water at ${i},${j}`);
  }
});

// PACK QC "MAP single cells" (T2 no speckle): a lone vertex of a class in the 7-t MAP lattice draws an isolated blob of
// mask art. The MAP resolve's mode-4 pass gives an isolated dry vertex its dry neighbours' majority; water, plots and
// anything with a same-class neighbour are never touched, so real features (rivers, strips ≥ 2 vertices) survive.
test('MAP despeckle (mode 4): isolated dry vertices take the dry majority; water, plots and 2-vertex features stay', () => {
  const n = 7, g = new Uint8Array(n * n).fill(CLASS.WILD), F = CLASS.FOREST;
  g[2 * n + 2] = F;                                   // a lone forest vertex in wild → wild
  g[4 * n + 4] = F; g[4 * n + 5] = F;                 // a 2-vertex strip survives
  g[1 * n + 5] = CLASS.WATER;                         // a lone water vertex is water's business (mode 1/2), not this pass
  g[5 * n + 1] = CLASS.RING;                          // plots never flip
  const r = despeckle(g, n, n, 4);
  assert.equal(r.grid[2 * n + 2], CLASS.WILD);
  assert.equal(r.grid[4 * n + 4], F); assert.equal(r.grid[4 * n + 5], F);
  assert.equal(r.grid[1 * n + 5], CLASS.WATER); assert.equal(r.grid[5 * n + 1], CLASS.RING);
  // a lone wild hole inside a forest fills with forest (holes speckle too)
  const h = new Uint8Array(n * n).fill(F); h[3 * n + 3] = CLASS.WILD;
  assert.equal(despeckle(h, n, n, 4).grid[3 * n + 3], F);
  // the MAP resolve runs it: a whole lattice region has no isolated dry vertex left
  const state = makeState(4, 4, []), f = synthFields({ forest: (x, y) => (kitHash(Math.floor(x / 7), Math.floor(y / 7)) & 3) === 0 ? 1 : 0 });
  const T = mapBandTable(TABLES.realms.sunscar.map), box = { x0: 0, y0: 0, w: 40, h: 40, step: 7 };
  const lone = G => { let k = 0; for (let y = 1; y < 39; y++) for (let x = 1; x < 39; x++) { const c = G[y * 40 + x]; if (c <= CLASS.WATER) continue;
    if (G[y * 40 + x - 1] !== c && G[y * 40 + x + 1] !== c && G[(y - 1) * 40 + x] !== c && G[(y + 1) * 40 + x] !== c) k++; } return k; };
  const cfg0 = { ...CLASS_CFG, classWarp: null }; // the synthetic field is white noise per lattice cell: keep it on the cells
  const before = lone(resolveRegion(f, null, state, box, T, cfg0, { despeckle: 0 }).grid), after = lone(resolveRegion(f, null, state, box, T, cfg0).grid);
  assert.ok(before > 20 && after <= Math.max(2, before * 0.05), `isolated dry lattice vertices ${before} → ${after}`);
});

// ---- fix round 1 (organic class edges, the plot's own ground, natural islets) ------------------------------------
/** Longest straight run (vertices) of the boundary of a 0/1 region: axis-parallel, or a 45° staircase. */
function straightRun(F, n) {
  let best = 0;
  for (let y = 0; y + 1 < n; y++) { let run = 0, prev = 0; for (let x = 0; x < n; x++) { const o = F[y * n + x] - F[(y + 1) * n + x]; run = o && o === prev ? run + 1 : o ? 1 : 0; prev = o; if (run > best) best = run; } }
  for (let x = 0; x + 1 < n; x++) { let run = 0, prev = 0; for (let y = 0; y < n; y++) { const o = F[y * n + x] - F[y * n + x + 1]; run = o && o === prev ? run + 1 : o ? 1 : 0; prev = o; if (run > best) best = run; } }
  for (const [sx, sy] of [[1, 1], [1, -1]]) for (const side of [1, -1]) for (let y0 = 0; y0 < n; y0++) for (let x0 = 0; x0 < n; x0++) {
    let k = 0; // a 45° run: in-region vertices along the diagonal, each with its side neighbour outside
    for (;;) { const x = x0 + k * sx, y = y0 + k * sy, xo = x + side; if (x < 0 || y < 0 || x >= n || y >= n || xo < 0 || xo >= n || !F[y * n + x] || F[y * n + xo]) break; k++; }
    if (k > best) best = k;
  }
  return best;
}
// GA2-08 / fix round 1 #14 ("the clearing is a pasted, straight-edged octagon"): the clearing edge must never run straight
// for more than ~6 tiles, at any keep level, on any deed. The old chamfered-box clearing had 20–40-t flat sides. A run of
// k boundary vertices spans k − 1 tiles; the bound is 8 vertices (7 t).
test('G13: the clearing boundary has no straight run longer than ~7 t (axis or 45°) — at every tested level and deed', () => {
  let worst = 0;
  for (const L of [1, 5, 9, 13, 17, 20]) for (const [x, y] of [[1, 1], [2, 3], [5, 2], [7, 7]]) {
    const state = makeState(9, 9, [{ x, y, level: L }]), n = TILES + 1, F = new Uint8Array(n * n), f = synthFields({ rock: 1 });
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const d = classDetail(f, null, state, [x * TILES + i, y * TILES + j]); F[j * n + i] = d.ring || d.cls === CLASS.TURF ? 1 : 0; }
    const r = straightRun(F, n); worst = Math.max(worst, r);
    assert.ok(r <= 8, `L${L} deed ${x},${y}: a straight clearing edge of ${r} vertices`);
  }
  assert.ok(worst >= 3, 'the probe sees edges at all');
});

// fix round 1 #8 ("keep the realm's own ground class under the yard; never a different class colour"): the rock a plot
// stands in stays rock ground around it (LIFE still keeps the clearing free); only the claim's apron is the kit's ring
// ground, and the claim turf only ever meets ground it has kit transitions with (WILD, GROUND2, ROAD, SHORE, RING).
test('G12: the plot keeps its own ground (rock stays rock around it), the claim meets only ring-compatible ground', () => {
  for (const L of [1, 9, 20]) {
    const state = makeState(3, 3, [{ x: 1, y: 1, level: L, off: C0 }]), g = PLOT_GEOM[L], f = synthFields({ rock: 1, forest: 1 });
    let rockInRing = 0, ringCls = 0;
    for (let j = 0; j <= TILES; j++) for (let i = 0; i <= TILES; i++) {
      const d = classDetail(f, null, state, [TILES + i, TILES + j]);
      if (d.ring) { ringCls += d.cls === CLASS.RING ? 1 : 0; if (d.ground === CLASS.ROCK) rockInRing++; }
      const cd = claimDist(g, i, j);
      if (d.ground === CLASS.TURF) continue;
      if (cd <= 1) assert.equal(d.ground, CLASS.RING, `L${L} ${i},${j}: the claim's apron is ring ground`);
      if (cd <= 1.5) assert.ok([CLASS.RING, CLASS.WILD, CLASS.GROUND2, CLASS.ROAD, CLASS.SHORE].includes(d.ground), `L${L} ${i},${j}: ground ${d.ground} touches the claim`);
    }
    assert.ok(rockInRing > 400, `L${L}: rock ground stays inside the clearing (${rockInRing} vertices)`);
    assert.ok(ringCls > 800, `L${L}: LIFE still sees the clearing as RING`);
  }
});

// fix round 1 #1/#6 ("45° staircase class edges at MAP and TRUE"): a painted straight or 45° class edge must come out as an
// organic line — wandering ≥ 8 t and never straight for more than 8 vertices at TRUE resolution.
test('G11: straight painted class edges (forest x < 150, rock on a 45° line) become organic boundaries', () => {
  const state = makeState(4, 4, []), n = TILES + 1;
  for (const [name, f, cls] of [['forest', synthFields({ forest: x => (x < 150 ? 1 : 0) }), CLASS.FOREST], ['rock', synthFields({ rock: (x, y) => (x + y < 300 ? 1 : 0) }), CLASS.ROCK]]) {
    const F = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) F[j * n + i] = classAt(f, null, state, [TILES + i, TILES + j]) === cls ? 1 : 0;
    const r = straightRun(F, n); assert.ok(r <= 8, `${name}: straight edge run ${r}`);
    let lo = 1e9, hi = -1e9; for (let j = 0; j < n; j++) { let k = 0; while (k < n && F[j * n + k]) k++; const e = name === 'rock' ? k + j : k; if (k > 0 && k < n) { lo = Math.min(lo, e); hi = Math.max(hi, e); } }
    assert.ok(hi - lo >= 8, `${name}: the edge wanders (${hi - lo} t)`);
  }
  // the MAP lattice uses the coarse octave only (the fine one would alias at 7 t)
  const [ax, ay] = classWarp(500, 500, { ...CLASS_CFG, warpFine: 0 }), [bx, by] = classWarp(500, 500);
  assert.ok(Math.hypot(ax - bx, ay - by) <= CLASS_CFG.classWarp.amp2 * Math.SQRT2 + 1e-9);
});

// fix round 1 #4 ("TRUE rivers are straight-edged bands with parallel banks"): prepareLines meanders rivers with one smooth
// 2-D field and varies their width; a tributary that ends on the main river stays joined (the same field moves both).
test('G14: rivers meander and vary in width, confluences stay joined, widths never fall below the clamp', () => {
  const L = prepareLines({ rivers: [{ pts: [[-20, 150], [320, 150]], hw: 2 }, { pts: [[150, 10], [150, 150]], hw: 1.5 }] }, { cols: 3, rows: 3 });
  const S = L.rivers.segs; let dev = 0, hwLo = 1e9, hwHi = 0;
  for (let s = 0; s < L.rivers.count; s++) { const o = s * 6; if (Math.abs(S[o + 1] - 150) < 6 && Math.abs(S[o] - 150) > 12) dev = Math.max(dev, Math.abs(S[o + 1] - 150)); hwLo = Math.min(hwLo, S[o + 4]); hwHi = Math.max(hwHi, S[o + 4]); }
  assert.ok(dev >= 1.2 && dev <= 3.7, `the main river meanders (${dev.toFixed(2)} t off its straight line)`);
  assert.ok(hwLo >= LINES.riverHwMin && hwHi / hwLo >= 1.2, `half-widths vary ${hwLo.toFixed(2)}…${hwHi.toFixed(2)}`);
  const state = makeState(3, 3, []), { g, n } = trueGrid(synthFields(), L, state, 1, 1);
  const wet = Uint8Array.from(g, c => (c === W ? 1 : 0)); assert.equal(components(wet, n).count, 1, 'the tributary still meets the main river');
});

// fix round 1 #2/#7 (T3 "plots in water become natural islets and peninsulas, never perfect rings"): a kingdom out in a
// lake near its shore is joined to the shore; one far from every shore stays an islet; two neighbours in the same lake
// merge; a bridge never crosses a river that does not flow around its own plot.
test('G15: land bridges — near-shore plots become peninsulas, far ones islets, neighbours merge, rivers are never cut', () => {
  const lakeFar = synthFields({ lake: -200 });
  const lone = makeState(3, 3, [{ x: 1, y: 1, level: 9, off: C0 }]);
  assert.equal(bridgeOf(lakeFar, null, lone, 1, 1), null, 'deep in a lake: an islet');
  // a shore 44 t south of the plot centre (the lake is north of y = c + 44)
  const c = TILES + PLOT_CENTRE, shore = synthFields({ lake: (x, y) => y - (c + 44) });
  const b = bridgeOf(shore, null, lone, 1, 1);
  assert.ok(b && b[1] > 0.9, `bridge heads for the shore (${b && b.map(v => v.toFixed(2))})`);
  const { g, n } = trueGrid(shore, null, lone, 1, 1), dry = Uint8Array.from(g, q => (q === W ? 0 : 1)), d8 = components(dry, n, true);
  assert.equal(d8.lab[PLOT_CENTRE * n + PLOT_CENTRE], d8.lab[(n - 1) * n + PLOT_CENTRE], 'the kingdom is joined to the shore');
  // two kingdoms in one lake, deeds side by side: merged islets
  const pair = makeState(4, 3, [{ x: 1, y: 1, level: 5, off: [12, 0] }, { x: 2, y: 1, level: 5, off: [-12, 0] }]);
  const bb = plotBridges(lakeFar, null, pair);
  assert.ok(bb[(1 * 4 + 1) * 4 + 2] > 0 || bb[(1 * 4 + 2) * 4 + 2] > 0, 'neighbouring islets are joined');
  // two kingdoms on dry land either side of a river 35 t from each: their bridges (if any) point away from the river,
  // never across it, and the river stays one channel through both deeds
  const rv = prepareLines({ rivers: [{ pts: [[TILES * 2, -20], [TILES * 2, 320]], hw: 3 }] }, { cols: 4, rows: 3 });
  const banks = makeState(4, 3, [{ x: 1, y: 1, level: 5, off: [14, 0] }, { x: 2, y: 1, level: 5, off: [-14, 0] }]);
  const bx = plotBridges(synthFields(), rv, banks);
  if (bx[(1 * 4 + 1) * 4 + 2] > 0) assert.ok(bx[(1 * 4 + 1) * 4] < 0.5, 'the west kingdom does not bridge east over the river');
  if (bx[(1 * 4 + 2) * 4 + 2] > 0) assert.ok(bx[(1 * 4 + 2) * 4] > -0.5, 'the east kingdom does not bridge west over the river');
  const n2 = 2 * TILES + 1, r2 = resolveRegion(synthFields(), rv, banks, { x0: TILES, y0: TILES, w: n2, h: TILES + 1, step: 1 }, TRUE_T);
  assert.equal(components(Uint8Array.from(r2.grid, q => (q === W ? 1 : 0)), n2).count, 1, 'the river is one channel');
});

// PACK QC "1-wide runs" (fix round 1 #13): at MAP a 1-vertex-wide run of an upper terrain draws a thin chain of mask art
// (the 45° staircases). Mode 8 gives it the class across it; WILD holes, ROAD and anything 2 wide are left alone.
test('MAP despeckle (mode 8): 1-wide upper-terrain runs go, ROAD and 2-wide strips stay', () => {
  const n = 9, F = CLASS.FOREST, g = new Uint8Array(n * n).fill(CLASS.WILD);
  for (let x = 1; x < 8; x++) g[2 * n + x] = F;                                     // 1-wide forest row
  for (let x = 1; x < 8; x++) { g[5 * n + x] = F; g[6 * n + x] = F; }               // 2-wide strip
  for (let y = 1; y < 8; y++) g[y * n + 7] = CLASS.ROAD;                            // a 1-wide road column
  const r = despeckle(g, n, n, 12);
  for (let x = 1; x < 7; x++) assert.equal(r.grid[2 * n + x], CLASS.WILD, `row 2 col ${x}`);
  for (let x = 2; x < 7; x++) { assert.equal(r.grid[5 * n + x], F); assert.equal(r.grid[6 * n + x], F); }
  for (let y = 1; y < 8; y++) assert.equal(r.grid[y * n + 7], CLASS.ROAD);
});

// ---- P0 (RM-GPU-1): the baked line fields ------------------------------------------------------------------------
// Why it matters: the realm map hung the owner's whole Mac GPU. One cause was per-pixel shader loops over a deed's river
// segment list (≤ 50 segments, ~200 texel reads a pixel). The GPU now SAMPLES stroke fields GROUND bakes once per deed
// page. These pin that the bake is the JS reference's own field (so MAP, TRUE, LIFE and QC keep agreeing), that the
// cap it stores changes no class, and that the half floats the GPU reads are what the CPU wrote.
const bakeLines = () => prepareLines({ rivers: [{ pts: [[-30, 150], [120, 170], [210, 120], [330, 190], [420, 160]], hw: [2, 3, 1.5, 4, 2.5] }],
  tracks: [{ pts: [[20, 60], [380, 90]], hw: 1 }] }, { cols: 4, rows: 3 });
test('P0 bake: every baked vertex is the exact stroke field (capped), row/column 98 from the next deeds\' lists', () => {
  const lines = bakeLines(), N = BAKE.size;
  for (const [dx, dy] of [[0, 1], [1, 1], [2, 1], [1, 0], [3, 2]]) {
    const r = bakeRiverPage(lines.rivers, dx, dy), l = bakeLandPage(lines.tracks, dx, dy);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = dx * TILES + i, y = dy * TILES + j, e = strokeSdf(lines.rivers, x, y, CLASS_CFG, true), t = strokeSdf(lines.tracks, x, y, CLASS_CFG, false);
      assert.equal(r.sdf[j * N + i], Math.min(e.sdf, BAKE.cap), `river sdf deed ${dx},${dy} vertex ${i},${j}`);
      assert.equal(r.amp[j * N + i], Math.min(e.amp, BAKE.ampCap), `river noise cap deed ${dx},${dy} vertex ${i},${j}`);
      assert.equal(l.track[j * N + i], Math.min(t.sdf, BAKE.cap), `track sdf deed ${dx},${dy} vertex ${i},${j}`);
    }
  }
});
test('P0 bake: the GPU sample is the vertex\'s half float at a vertex and the bilinear of four between', () => {
  const lines = bakeLines(), r = bakeRiverPage(lines.rivers, 1, 1);
  for (const [x, y] of [[98, 98], [150, 170], [195, 195], [140.25, 166.5], [120.9, 150.1]]) {
    const [s, a] = samplePage(r.sdf, r.amp, 1, 1, x, y), e = strokeSdf(lines.rivers, x, y, CLASS_CFG, true);
    if (Number.isInteger(x) && Number.isInteger(y)) assert.equal(s, fromHalf(toHalf(Math.min(e.sdf, BAKE.cap))), `vertex ${x},${y}`);
    // between vertices the distance field is bilinear: within √2/2 t of the exact distance (≤ 1 t at a centre-line kink)
    else assert.ok(Math.abs(s - Math.min(e.sdf, BAKE.cap)) <= 1.0, `between vertices ${x},${y}: ${s} vs ${e.sdf}`);
    assert.ok(a > 0, 'noise cap sampled');
  }
  // binary16 as GLSL unpackHalf2x16 reads it: exact small integers, nearest-even rounding, the caps representable
  for (const v of [0, 1, -1, 0.5, 20, -60, 64, 65504]) assert.equal(fromHalf(toHalf(v)), v, `half ${v}`);
  assert.equal(toHalf(1), 0x3c00); assert.equal(fromHalf(toHalf(1 + 2 ** -11)), 1, 'ties to even');
  assert.ok(Math.abs(fromHalf(toHalf(13.37)) - 13.37) <= 2 ** -7, 'half precision at the 14-t flag threshold ≤ 1/128 t');
});
test('P0 cap: a river more than BAKE.cap away changes no class, and every threshold that reads it sits well inside the cap', () => {
  // varied land (rock, forest and field stripes, a lake, relief) so every rule that reads the river field is exercised
  const f = synthFields({ lake: (x, y) => Math.hypot(x - 330, y - 60) - 18, rock: (x, y) => ((Math.floor(x / 23) + Math.floor(y / 31)) % 5 === 0 ? 1 : 0),
    forest: (x, y) => ((Math.floor(x / 17) * 3 + Math.floor(y / 13)) % 4 === 0 ? 1 : 0), field: (x, y) => (Math.floor(y / 41) % 3 === 0 ? 1 : 0) });
  const withR = bakeLines(), noR = prepareLines({ tracks: [{ pts: [[20, 60], [380, 90]], hw: 1 }] }, { cols: 4, rows: 3 });
  const s = makeState(4, 3); let far = 0;
  for (let y = 0; y <= 3 * TILES; y += 3) for (let x = 0; x <= 4 * TILES; x += 3) {
    if (strokeSdf(withR.rivers, x, y, CLASS_CFG, true).sdf < BAKE.cap) continue;
    far++; assert.equal(classAt(f, withR, s, [x, y]), classAt(f, noR, s, [x, y]), `vertex ${x},${y}`);
  }
  assert.ok(far > 2000, `probed ${far} vertices beyond the cap`);
  // the rules read the river field below 14 t (the lattice 'near water' flag) with ±inland noise
  assert.ok(BAKE.cap - CLASS_CFG.inlandNoise.amp > 14, 'cap too close to the near-water flag threshold');
});
// P0: a land bridge reaches the GPU as one packed header word per deed (a page per bridged 3×3 was 400+ pages, 31 MB and a
// multi-second synchronous rebuild on a populated realm). Why this matters: the word must decode to exactly the bridge the
// JS reference keeps, or MAP/TRUE and QC would disagree on which plots stand on a peninsula.
test('P0 bridges: bridgeOf keeps the packed word\'s own values, so the GPU word and the JS reference are one bridge', () => {
  const lake = synthFields({ lake: (x, y) => y - (TILES + PLOT_CENTRE + 44) }), st = makeState(3, 3, [{ x: 1, y: 1, level: 5, off: C0 }]);
  const b = plotBridges(lake, null, st); const k = (1 * 3 + 1) * 4; assert.ok(b[k + 2] > 0, 'the lake plot has a bridge');
  const w = packBridge(b[k], b[k + 1], b[k + 2], b[k + 3]);
  assert.deepEqual(unpackBridge(w), [b[k], b[k + 1], b[k + 2], b[k + 3]], 'repacking the kept bridge gives the same word');
  assert.ok(Math.abs(Math.hypot(b[k], b[k + 1]) - 1) < 1e-6 && b[k + 1] > 0.9, 'a unit direction toward the shore');
  // the GPU decode (rmBridgeN): angle = (w & 0xffff)·2π/65536, len = ((w >> 16) & 255)/2, hw = (w >> 24)/4
  const an = (w & 0xffff) * 2 * Math.PI / 65536;
  assert.ok(Math.abs(Math.cos(an) - b[k]) < 1e-6 && Math.abs(Math.sin(an) - b[k + 1]) < 1e-6);
  assert.equal(((w >>> 16) & 255) / 2, b[k + 2]); assert.equal((w >>> 24) / 4, b[k + 3]);
  // quantisation keeps the peninsula: the kingdom still joins the shore (G15), and no bridge is a zero word
  const { g, n } = trueGrid(lake, null, st, 1, 1), dry = Uint8Array.from(g, q => (q === W ? 0 : 1)), d8 = components(dry, n, true);
  assert.equal(d8.lab[PLOT_CENTRE * n + PLOT_CENTRE], d8.lab[(n - 1) * n + PLOT_CENTRE], 'the kingdom is joined to the shore');
  assert.equal(packBridge(0, 0, 0, 0), 0); assert.notEqual(packBridge(1, 0, 0.1, 0.1), 0, 'a tiny bridge is still a bridge');
  assert.ok(bridgeForce(b, st, TILES + PLOT_CENTRE + 20 * b[k], TILES + PLOT_CENTRE + 20 * b[k + 1]) > 0, 'the bridge forces land along its axis');
});

// Fix iteration 2 #3 (owner-r2b 10: Stormcairn's grey peaks became saturated blue blobs at d 36–80): PACK's lake channel
// holds painted mountain shadows. Why this matters: a shadow drawn as a lake is a false tarn the FAR painting never shows;
// but a real lake, a one-texel painted river and a realm whose ice lakes paint like its snow must never lose water.
test('clipTarns: a painted shadow is not a tarn; real lakes, thin rivers and ice-on-snow realms keep their water', () => {
  const W = 40, H = 20, land = [120, 140, 70], water = [60, 170, 210], shadow = [70, 80, 100];
  const make = (paint) => {
    const fa = { width: W, height: H, data: new Uint8Array(W * H * 4) }, ch = { width: W, height: H, data: new Uint8Array(W * H * 3), channels: 3 };
    for (let i = 0; i < W * H; i++) { fa.data.set([200, 200, 128, 255], i * 4); ch.data.set(paint.land, i * 3); }
    const lake = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { fa.data[(y * W + x) * 4 + 1] = 100; ch.data.set(c, (y * W + x) * 3); } };
    lake(2, 2, 12, 12, paint.water);                 // the realm's big lake (its painted water reference)
    lake(20, 3, 23, 5, paint.shadow);                // a mountain shadow in the lake channel
    lake(15, 15, 38, 15, paint.water);               // a one-texel painted river
    lake(30, 3, 32, 5, paint.water);                 // a small real tarn
    return { fa, ch };
  };
  const { fa, ch } = make({ land, water, shadow }), wetAt = (f, x, y) => f.data[(y * W + x) * 4 + 1] < 128;
  const r = clipTarns(fa, ch);
  assert.equal(r.clipped, 1, `only the shadow is clipped (${JSON.stringify(r)})`);
  assert.ok(!wetAt(fa, 21, 4), 'the shadow is dry'); assert.ok(wetAt(fa, 5, 5) && wetAt(fa, 31, 4) && wetAt(fa, 25, 15), 'lake, tarn and river keep their water');
  // Frostveil-like: ice lakes painted close to the snow around them — the colour axis is too short to judge, nothing clipped
  const ice = make({ land: [225, 232, 240], water: [200, 240, 250], shadow: [210, 220, 235] });
  assert.equal(clipTarns(ice.fa, ice.ch).clipped, 0);
});

// P0 fix pass #5 (D-167: no main-thread stall over 50 ms, fast entry): the foreign-sea cap ran over every fieldsA px beyond
// the realm in one task at every realm load (~0.5 s on the efficiency cores for Frostveil, several on a mid-range phone),
// clipTarns in the same step. Why this test: the sliced forms must write exactly what the one-task forms wrote (classes,
// lattice, TRUE pages and LIFE all read these bytes; a drift is a different coast), and must hand control back often —
// foreignSeaRows after every row, clipTarnsSteps after every TARN_STEP units of work.
test('load passes are sliced and exact: foreignSeaRows = the one-task foreign-sea cap byte for byte, clipTarnsSteps = clipTarns', () => {
  const cols = 12, rows = 6, ppd = 8, W = cols * ppd, H = rows * ppd, far = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) far[y * cols + x] = Math.max(0, x - 3) * 1.1 + (y === 5 ? 3 : 0); // the realm at x ≤ 3
  const img = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  for (let i = 0; i < W * H; i++) img.data.set([(i * 37) % 256, (i * 11) % 256, 128, 255], i * 4); // every coast value, land and sea
  // the reference: ground.mjs's one-task loop before the fix pass, verbatim
  const ref = { ...img, data: img.data.slice() }, clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const farAt = (x, y) => { const u = Math.min(cols - 1, Math.max(0, x - 0.5)), v = Math.min(rows - 1, Math.max(0, y - 0.5)), x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1), fx = u - x0, fy = v - y0;
    return (far[y0 * cols + x0] * (1 - fx) + far[y0 * cols + x1] * fx) * (1 - fy) + (far[y1 * cols + x0] * (1 - fx) + far[y1 * cols + x1] * fx) * fy; };
  const cutAt = (px, py) => { const qx = px * 4, qy = py * 4; return clampN(3.5 - (1.5 * vnoise(qx, qy, 48, 0x6f13) + 0.8 * vnoise(qx, qy, 20, 0x1d27) + 0.9 * vnoise(qx, qy, 7, 0x4f1d) + 0.35 * vnoise(qx, qy, 3, 0x2a77)), 1.5, 6.5); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const px = (x + 0.5) / ppd, py = (y + 0.5) / ppd, fd = farAt(px, py); if (fd <= 0.5) continue;
    const o = (y * W + x) * 4, cap = (cutAt(px, py) - fd) * TILES, c = (ref.data[o] - 128) * 2; if (cap < c) ref.data[o] = clampN(Math.round(128 + cap / 2), 0, 255); }
  const out = { ...img, data: img.data.slice() }, g = foreignSeaRows(out, far, cols, rows);
  let steps = 0, r; while (!(r = g.next()).done) steps++;
  assert.equal(steps, H, 'one step per row');
  assert.deepEqual(out.data, ref.data, 'the sliced cap writes what the one-task cap wrote');
  assert.ok(r.value.zeroed > 0 && r.value.kept > 0 && r.value.noised > 0, `both early-outs taken and the noise path too (${JSON.stringify(r.value)})`);
  assert.notDeepEqual(out.data, img.data, 'the fixture exercises the cap');
  // clipTarns: sliced = whole, and it yields at least every TARN_STEP units of work
  const tw = 400, th = 200, fa = { width: tw, height: th, data: new Uint8Array(tw * th * 4) }, ch = { width: tw, height: th, data: new Uint8Array(tw * th * 3), channels: 3 };
  for (let i = 0; i < tw * th; i++) { const x = i % tw, y = Math.floor(i / tw), lake = (x > 20 && x < 120 && y > 20 && y < 120) || (x > 200 && x < 204 && y > 50 && y < 54);
    fa.data.set([200, lake ? 100 : 200, 128, 255], i * 4); ch.data.set(lake ? (x > 200 ? [70, 80, 100] : [60, 170, 210]) : [120, 140, 70], i * 3); }
  const a = { ...fa, data: fa.data.slice() }, b = { ...fa, data: fa.data.slice() }, whole = clipTarns(a, ch), gen = clipTarnsSteps(b, ch);
  let ys = 0, rr; while (!(rr = gen.next()).done) ys++;
  assert.deepEqual(rr.value, whole); assert.deepEqual(b.data, a.data); assert.equal(whole.clipped, 1);
  assert.ok(ys >= Math.floor(2 * tw * th / TARN_STEP), `clipTarns yields ${ys} times over ${2 * tw * th} texel visits`);
});

// Fix iteration 2 #13 (critic: "at TRUE every claim is a hard-edged pale rectangle pad"). Why: in game the claim border is
// ragged (the kit's turf edge tiles over the realm's ground), and a ruled rectangle is what makes plots read as pasted pads.
// The claim box itself must stay whole (BASES builds on it) and the fray never reaches water or past claimRag.amp.
test('claim border frays: TURF reaches irregularly past the claim box on dry land, never beyond claimRag.amp nor into water', () => {
  const st = makeState(3, 3, [{ x: 1, y: 1, level: 9, off: C0 }]), g = plotAt(st, 1, 1), x0 = TILES, y0 = TILES;
  const turfAt = (f, x, y) => classDetail(f, null, st, [x0 + x, y0 + y]).ground === CLASS.TURF;
  const dry = synthFields(), frayed = new Set();
  for (let y = g.minY - 4; y <= g.maxY + 4; y++) for (let x = g.minX - 4; x <= g.maxX + 4; x++) {
    const inBox = x >= g.minX && x <= g.maxX && y >= g.minY && y <= g.maxY, cd = claimDist(g, x, y);
    if (inBox) { assert.ok(turfAt(dry, x, y), `box vertex ${x},${y}`); continue; }
    if (turfAt(dry, x, y)) { assert.ok(cd <= CLASS_CFG.claimRag.amp + 1e-9, `fray at ${cd.toFixed(2)} t`); frayed.add(`${x},${y}`); }
  }
  const ring = 4 * (g.maxX - g.minX + 3); // vertices at distance 1 around the box
  assert.ok(frayed.size > ring * 0.15 && frayed.size < ring * 1.2, `frayed ${frayed.size} of ~${ring} border vertices: neither a ruled edge nor a grown pad`);
  // along each side the fray changes from one vertex to the next somewhere: not a uniform band
  let changes = 0; for (let x = g.minX; x < g.maxX; x++) if (frayed.has(`${x},${g.minY - 1}`) !== frayed.has(`${x + 1},${g.minY - 1}`)) changes++;
  assert.ok(changes >= 2, `north side fray changes ${changes}×`);
  // in water nothing frays (a lake right up to the plot): the island keeps its own shore
  const wet = synthFields({ lake: -50 });
  for (let x = g.minX - 3; x <= g.maxX + 3; x++) { const y = g.minY - 2; if (claimDist(g, x, y) > 0 && turfAt(wet, x, y)) { const d = classDetail(wet, null, st, [x0 + x, y0 + y]); assert.ok(d.coast >= 0 && d.inland >= 0, 'fray only on dry land'); } }
});

// P0 (orchestrator decision after RM-GPU-1): display shaders only SAMPLE classes; the §3.2 classifier runs in resolve passes.
// Why this matters: LIFE seats trees and herds by the sampled class at MAP. The 7-t lattice misses rivers narrower than a
// cell and shores between vertices, so the sampled class must be wet wherever the classifier is wet (no trees in water) —
// and it must stay close to it elsewhere, or banks go bare. And the "classes" include must not pull the classifier in.
test('classes-sampled: wet wherever classAt is wet (narrow river, lake, sea, plots), close to it elsewhere; no classifier inlined', async () => {
  const st = makeState(3, 3, [{ x: 1, y: 1, level: 9, off: C0 }, { x: 2, y: 0, level: 3, off: C0 }]);
  const lines = prepareLines({ rivers: [{ pts: [[-20, 60.3], [120, 140.6], [300, 170.2]], hw: 1.1 }] }, { cols: 3, rows: 3 });
  const f = synthFields({ coast: (x, y) => 250 - x - 0.3 * y, lake: (x, y) => Math.hypot(x - 60, y - 230) - 18 });
  let wet = 0, missed = 0, extra = 0, dry = 0, narrow = 0, farX = -Infinity;
  for (let y = 0; y < 294; y += 1) for (let x = 0; x < 294; x += 1) {
    const c = classAt(f, lines, st, [x, y]), w = sampledWet(f, lines, st, [x, y]);
    if (c <= CLASS.WATER) { wet++; if (!w) missed++; } else { dry++; if (w) { extra++; farX = Math.max(farX, plotSdf(st, x, y)); } }
    if (c === CLASS.WATER && x % 7 && y % 7 && Math.abs(y - (60.3 + (x + 20) * 80.3 / 140)) < 3 && x < 120) narrow++;
  }
  assert.ok(wet > 3000 && narrow > 50, `the fixture has water (${wet}) and a river between lattice vertices (${narrow})`);
  assert.equal(missed, 0, 'every vertex classAt calls water is sampled wet');
  // the only land read wet is what a plot's island (or its bridge) forces dry: all of it lies within the island's reach
  assert.ok(extra / dry < 0.05 && farX < 36, `sampled-wet dry land ${(100 * extra / dry).toFixed(2)} %, farthest ${farX.toFixed(1)} t from a plot`);
  const G = await import('./glsl/classes.glsl.mjs');
  assert.ok(!/#include\s+"rm-classify"/.test(G.CLASSES), '"classes" does not include the classifier');
  assert.ok(!/\b(rmClassCore|rmClassAt\w*|rmStroke|rmIsle\w*|rmBridge\w*|rmClearing\w*)\s*\(/.test(G.CLASSES + G.RM_FIELDS), 'no classifier call in the sampled include');
  assert.ok(!/\b(for|while)\s*\(/.test(G.CLASSES), 'mapClassFine / classAtTile have no loops (rm-fields keeps its 3×3 literal loops)');
});

// P0 (RM-GPU-1, "bounded work whatever the data"). Why this matters: every per-deed segment list is walked by the CPU bake
// of a line page (on the main thread, in slices), by strokeSdf and by QC. A garbage or hostile lines.json (NaN, Infinity,
// a point a billion tiles away, thousands of segments through one deed) must neither hang nor crash the page — and the
// cap must never touch a real pack (the longest real list is 50) nor drop the segment that matters (nearest / widest).
test('line data is bounded: non-finite points split the polyline, far points clamp, each deed keeps its nearest 128', () => {
  const cols = 3, rows = 3, X1 = cols * TILES + LINE_CAP.margin;
  const t0 = performance.now();
  const g = prepareLines({ rivers: [{ pts: [[10, 10], [NaN, 5], [50, 50], [1e9, 60], [Infinity, 3], [100, 100], [120, 130]], hw: [2, 2, 2, 2, 2, 2, NaN] }],
    tracks: [{ pts: [5, 5], hw: 1 }, { pts: null }, null, { pts: [[0, 0], [60, 60]], hw: 1e9 }] }, { cols, rows });
  assert.ok(performance.now() - t0 < 2000, 'a point at 1e9 does not resample a billion tiles');
  assert.equal(g.bad, 2, 'NaN and Infinity points dropped');
  assert.ok(g.rivers.count > 0 && g.rivers.segs.every(v => Number.isFinite(v) && v >= -LINE_CAP.margin - 10 && v <= X1 + 10), 'every river segment finite, within the grid ± margin');
  assert.ok(g.tracks.count === 1 && g.tracks.segs[4] <= LINE_CAP.hwMax, 'a one-point track is no segment; a huge half-width is clamped');
  // 300 horizontal tracks through deed (1, 1) at offsets −60…+60 t from its centre line, and one wide (hw 30) far one
  const cy = TILES + TILES / 2, polys = [];
  for (let i = 0; i < 300; i++) { const off = -60 + (120 * i) / 299; polys.push({ P: Float64Array.from([TILES - 5, cy + off, 2 * TILES + 5, cy + off]), hw: Float64Array.from([1, 1]) }); }
  polys.push({ P: Float64Array.from([TILES - 5, cy + 45, 2 * TILES + 5, cy + 45]), hw: Float64Array.from([30, 30]) });
  const set = segSet(polys, cols, rows, LINES.trackHwMin), list = set.cells.get(1 * cols + 1);
  assert.equal(list.length, LINE_CAP.perDeed, 'the deed keeps exactly the cap');
  assert.ok(set.dropped > 0 && list.every((v, i) => i === 0 || list[i - 1] < v), 'dropped counted, list kept in segment order');
  const off = s => Math.abs(set.segs[s * 6 + 1] - cy) - set.segs[s * 6 + 4], kept = new Set(list);
  const worstKept = Math.max(...list.map(off)), bestDropped = Math.min(...[...Array(set.count).keys()].filter(s => !kept.has(s)).map(off)); // every segment crosses deed (1, 1)
  assert.ok(worstKept <= bestDropped + 1e-9, `kept the nearest (worst kept ${worstKept.toFixed(1)} t, best dropped ${bestDropped.toFixed(1)} t)`);
  assert.ok(kept.has(300), 'the wide far river (45 t off, half-width 30) outranks narrow nearer ones');
  // a real-sized list (≤ 50 segments) is never trimmed
  assert.equal(segSet(polys.slice(0, 50), cols, rows, LINES.trackHwMin).dropped, 0);
});
