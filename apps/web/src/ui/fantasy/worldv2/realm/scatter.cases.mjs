// LIFE lane tests (plan §10.4 LIFE row). Each test says WHY the rule matters for the realm map.
// Run: scripts/node_modules/.bin/tsx --test concepts/globe3d-2026-09-23/src/realm/*.test.mjs
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TILES, ART, DEED_ART, CLASS, BANDS, PLOT_CENTRE, plotRule, plotOffset } from './contracts.mjs';
import { makeState, plotSdf as groundPlotSdf } from './classify.mjs';
import { vnoise, pcg2d } from './glsl/common.glsl.mjs';
import {
  MIN_SPRITE_PX, LIFE_CAPS, LIFE_TABLES, HERD_MAX, LOOP_RADIUS_TILES, PLOT_CLEAR,
  pathPose, poseFrame, facingRow, isqrt, compileGroup, compileLife, scatterInstance, instanceLod,
  latticeWindow, viewRectArt, cellHash, devicePx, minVisibleD, bigEnough, herdSite, herdMember, memberPose, walkableFor,
  planDraws, submittedCap, THIN_MAX, THIN_ORDER, bandWeights, swayArt, particle, birdPose, flockSite, keepFraction, skyScale, lifeTable, ambienceInk,
  STAND, standSite, standMember, standLod, clusterPick, edgeWeight, mapObjectRole,
  mergedSite, mergedLod, mapKeep, withCanopy, MAX_SPECIES, trueClasses,
  RANK_B, RANK_SLOTS, RANK_STEP, rankHash, slotXY, xySlot, cellRank, slotCell, rankBound, rankSlots, rankBlocks, rankDraw, thinFactor, THIN_SPREAD,
  pickSpecies, GLOW, glowPulse,
} from './scatter.mjs';
import { reduceMap } from './life.mjs';
import * as SPRITES_GLSL from './glsl/sprites.glsl.mjs';
import * as AIR_GLSL from './glsl/air.glsl.mjs';

// ---- fixtures --------------------------------------------------------------------------------------------
// Kit pose vectors: realmKitPathPose / realmKitFacingRow from the realm-kit branch at fc5c6ad19ea6
// (packages/shared/src/realmKit.ts), run over real Sunscar layered-manifest paths plus a synthetic pingpong
// path with a zero-length segment. [elapsedMs, x, y, facing, dx, dy, dwelling, row].
const KIT_POSES = [
  {"id":"camel-1","path":{"points":[{"x":1776,"y":192},{"x":1776,"y":288},{"x":1776,"y":128},{"x":1712,"y":96},{"x":1744,"y":192},{"x":1776,"y":192}],"speed":18,"dwellMs":2000,"loop":"cycle","directions":4},"poses":[[0,1776,192,"down",0,96,1,0],[1,1776,192,"down",0,96,1,0],[999,1776,192,"down",0,96,1,0],[2000,1776,192,"down",0,96,0,0],[2001,1776,192,"down",0,96,0,0],[3517,1776,219,"down",0,96,0,0],[7777,1776,288,"up",0,-160,1,3],[12345,1776,233,"up",0,-160,0,3],[25000,1712,96,"down",32,96,1,0],[61234,1712,96,"down",32,96,1,0],[99999,1727,142,"down",32,96,0,0],[250001,1776,192,"down",0,96,1,0],[1234567,1712,96,"down",32,96,1,0]],"still":[1776,192,"down"]},
  {"id":"desert-goat-2","path":{"points":[{"x":-112,"y":-512},{"x":-144,"y":-544},{"x":-176,"y":-512},{"x":-176,"y":-576},{"x":-112,"y":-480},{"x":-112,"y":-512}],"speed":22,"dwellMs":1500,"loop":"cycle","directions":4},"poses":[[0,-112,-512,"left",-32,-32,1,1],[1,-112,-512,"left",-32,-32,1,1],[999,-112,-512,"left",-32,-32,1,1],[2000,-120,-520,"left",-32,-32,0,1],[2001,-120,-520,"left",-32,-32,0,1],[3517,-144,-544,"left",-32,-32,0,1],[7777,-176,-512,"up",0,-64,1,3],[12345,-176,-576,"down",64,96,1,0],[25000,-144,-544,"left",-32,32,1,1],[61234,-112,-480,"up",0,-32,1,3],[99999,-149,-535,"down",64,96,0,0],[250001,-127,-503,"down",64,96,0,0],[1234567,-161,-528,"left",-32,32,0,1]],"still":[-112,-512,"left"]},
  {"id":"fennec-1","path":{"points":[{"x":1744,"y":1568},{"x":1616,"y":1536},{"x":1680,"y":1632},{"x":1744,"y":1504},{"x":1680,"y":1664},{"x":1616,"y":1632},{"x":1744,"y":1568}],"speed":34,"dwellMs":700,"loop":"cycle","directions":4},"poses":[[0,1744,1568,"left",-128,-32,1,1],[1,1744,1568,"left",-128,-32,1,1],[999,1734,1565,"left",-128,-32,0,1],[2000,1700,1557,"left",-128,-32,0,1],[2001,1700,1557,"left",-128,-32,0,1],[3517,1650,1544,"left",-128,-32,0,1],[7777,1663,1607,"down",64,96,0,0],[12345,1725,1540,"up",64,-128,0,3],[25000,1683,1598,"right",128,-64,0,2],[61234,1653,1592,"down",64,96,0,0],[99999,1683,1655,"down",-64,160,0,0],[250001,1650,1588,"down",64,96,0,0],[1234567,1679,1663,"left",-64,-32,0,1]],"still":[1744,1568,"left"]},
  {"id":"jerboa-3","path":{"points":[{"x":624,"y":1920},{"x":624,"y":1824},{"x":528,"y":2016},{"x":592,"y":1952},{"x":688,"y":1952},{"x":528,"y":1952},{"x":624,"y":1920}],"speed":40,"dwellMs":1200,"loop":"cycle","directions":4},"poses":[[0,624,1920,"up",0,-96,1,3],[1,624,1920,"up",0,-96,1,3],[999,624,1920,"up",0,-96,1,3],[2000,624,1888,"up",0,-96,0,3],[2001,624,1887,"up",0,-96,0,3],[3517,624,1827,"up",0,-96,0,3],[7777,570,1930,"down",-96,192,0,0],[12345,556,1987,"right",64,-64,0,2],[25000,581,1934,"right",96,-32,0,2],[61234,548,1974,"down",-96,192,0,0],[99999,559,1952,"left",-160,0,0,1],[250001,595,1952,"right",96,0,0,2],[1234567,590,1891,"down",-96,192,0,0]],"still":[624,1920,"up"]},
  {"id":"tortoise-1","path":{"points":[{"x":1232,"y":-544},{"x":1200,"y":-544},{"x":1232,"y":-480},{"x":1168,"y":-480},{"x":1136,"y":-512},{"x":1232,"y":-544}],"speed":8,"dwellMs":2500,"loop":"cycle","directions":4},"poses":[[0,1232,-544,"left",-32,0,1,1],[1,1232,-544,"left",-32,0,1,1],[999,1232,-544,"left",-32,0,1,1],[2000,1232,-544,"left",-32,0,1,1],[2001,1232,-544,"left",-32,0,1,1],[3517,1223,-544,"left",-32,0,0,1],[7777,1200,-544,"down",32,64,1,0],[12345,1212,-520,"down",32,64,0,0],[25000,1195,-480,"left",-64,0,0,1],[61234,1202,-540,"down",32,64,0,0],[99999,1207,-536,"right",96,-32,0,2],[250001,1170,-524,"right",96,-32,0,2],[1234567,1198,-533,"right",96,-32,0,2]],"still":[1232,-544,"left"]},
  {"id":"ibis-2","path":{"points":[{"x":336,"y":-832},{"x":432,"y":-864},{"x":368,"y":-800},{"x":368,"y":-832},{"x":464,"y":-800},{"x":336,"y":-832}],"speed":14,"dwellMs":1500,"loop":"cycle","directions":4},"poses":[[0,336,-832,"right",96,-32,1,2],[1,336,-832,"right",96,-32,1,2],[999,336,-832,"right",96,-32,1,2],[2000,342,-835,"right",96,-32,0,2],[2001,342,-835,"right",96,-32,0,2],[3517,362,-841,"right",96,-32,0,2],[7777,419,-860,"right",96,-32,0,2],[12345,410,-843,"left",-64,64,0,1],[25000,408,-819,"right",96,32,0,2],[61234,368,-832,"right",96,32,1,2],[99999,368,-827,"up",0,-32,0,3],[250001,432,-864,"left",-64,64,1,1],[1234567,409,-814,"left",-128,-32,0,1]],"still":[336,-832,"right"]},
  {"id":"mesa-vultures","path":{"points":[{"x":400,"y":1488},{"x":720,"y":1424},{"x":976,"y":1616},{"x":784,"y":1872},{"x":400,"y":1840},{"x":240,"y":1616},{"x":400,"y":1488}],"speed":40,"dwellMs":0,"loop":"cycle","directions":1},"poses":[[0,400,1488,"right",320,-64,0,0],[1,400,1487,"right",320,-64,0,0],[999,439,1480,"right",320,-64,0,0],[2000,478,1472,"right",320,-64,0,0],[2001,478,1472,"right",320,-64,0,0],[3517,538,1460,"right",320,-64,0,0],[7777,705,1426,"right",320,-64,0,0],[12345,854,1524,"right",256,192,0,0],[25000,750,1869,"left",-384,-32,0,0],[61234,954,1600,"right",256,192,0,0],[99999,731,1432,"right",256,192,0,0],[250001,853,1779,"down",-192,256,0,0],[1234567,378,1505,"right",160,-128,0,0]],"still":[400,1488,"right"]},
  {"id":"kiln-smoke","path":{"points":[{"x":-896,"y":-653},{"x":-896,"y":-720},{"x":-883,"y":-800},{"x":-870,"y":-880}],"speed":12,"dwellMs":0,"loop":"cycle","directions":1},"poses":[[0,-896,-653,"up",0,-67,0,0],[1,-896,-654,"up",0,-67,0,0],[999,-896,-665,"up",0,-67,0,0],[2000,-896,-678,"up",0,-67,0,0],[2001,-896,-678,"up",0,-67,0,0],[3517,-896,-696,"up",0,-67,0,0],[7777,-892,-747,"up",13,-80,0,0],[12345,-883,-801,"up",13,-80,0,0],[25000,-896,-724,"up",13,-80,0,0],[61234,-896,-701,"up",0,-67,0,0],[99999,-896,-709,"up",0,-67,0,0],[250001,-896,-677,"up",0,-67,0,0],[1234567,-882,-811,"up",13,-80,0,0]],"still":[-896,-653,"up"]},
  {"id":"pp","path":{"points":[{"x":0,"y":0},{"x":64,"y":0},{"x":64,"y":96},{"x":64,"y":96},{"x":-32,"y":40}],"speed":23,"dwellMs":333,"loop":"pingpong","directions":4},"poses":[[0,0,0,"right",64,0,1,2],[1,0,0,"right",64,0,1,2],[999,15,0,"right",64,0,0,2],[2000,38,0,"right",64,0,0,2],[2001,38,0,"right",64,0,0,2],[3517,64,1,"down",0,96,0,0],[7777,64,96,"right",0,0,1,2],[12345,-17,48,"left",-96,-56,0,1],[25000,28,0,"left",-64,0,0,1],[61234,54,90,"left",-96,-56,0,1],[99999,64,41,"up",0,-96,0,3],[250001,-22,46,"right",96,56,0,2],[1234567,37,0,"right",64,0,0,2]],"still":[0,0,"right"]},
];

/** A synthetic, deterministic class field with every class the scatter tables use. */
function classField(seed = 3) {
  return (tx, ty) => {
    const n = vnoise(tx, ty, 40, seed), m = vnoise(tx, ty, 23, seed + 11), w = vnoise(tx, ty, 61, seed + 5);
    if (w < -0.62) return CLASS.SEA;
    if (w < -0.55) return CLASS.SHORE;
    if (Math.abs(m) < 0.05 && n < 0.3) return CLASS.WATER;
    if (n > 0.35) return CLASS.FOREST;
    if (n < -0.45) return CLASS.ROCK;
    if (m > 0.4) return CLASS.FIELD;
    if (m < -0.4) return CLASS.GROUND2;
    if (n > 0.2 && m < 0) return CLASS.SPECIAL;
    return CLASS.WILD;
  };
}
/** Base state (GROUND's makeState: RGBA per deed kind, flags, claimTiles, level) with claimed deeds [x, y, L]. */
const baseState = (cols, rows, claimed) => makeState(cols, rows, claimed.map(([x, y, level]) => ({ x, y, level })));
const plotSdfAt = (state, tx, ty) => groundPlotSdf(state, tx, ty);
/** Sprite sizes by kit naming: set pieces 96/160 px frames, the rest 64 px; ink ≈ 80 % of the frame. */
function spriteStub(id) {
  const big = /cliff|fissure|spring_cliff|sea_stack|cairn_circle|mesa$|sand_mesa|spire/.test(id), mid = /granary|boathouse|ruin|gate|barn|house|shed|tower|byre|mill|broch|kiln_house|smelter_gate|hot_spring$/.test(id);
  const w = big ? 160 : mid ? 96 : 64, h = big ? 128 : mid ? 96 : 64;
  return { inkH: Math.round(h * 0.8), w, h, ax: w / 2, ay: h, frames: 1, frameMs: 1000 };
}
const creatureStub = id => ({ inkH: 30, frames: 6, frameMs: 120, speed: 20, dwellMs: 1500, directions: 4, kind: /ibis|duck|seal|salamander|gannet/.test(id) ? 'water' : 'ground' });
const lookup = { sprite: spriteStub, creature: creatureStub };

// ---- 1. kit pose parity --------------------------------------------------------------------------------
test('creatures walk exactly like the kit: pathPose/facingRow equal realmKitPathPose vectors (speed, dwell, facing, pingpong)', () => {
  // Why: "Enter base" must be seamless (D-162) — a camel on the realm map at TRUE is the same animal, with
  // the same stride, pause and facing, as the camel the player sees in their base.
  const all = KIT_POSES;
  assert.ok(all.length >= 9, 'vectors cover 8 real Sunscar paths + 1 synthetic');
  for (const v of all) {
    for (const [t, x, y, facing, dx, dy, dwelling, row] of v.poses) {
      const p = pathPose(v.path, t, false);
      assert.deepEqual([p.x, p.y, p.facing, p.dx, p.dy, p.dwelling ? 1 : 0, facingRow(v.path.directions, p.facing, p.dx)],
        [x, y, facing, dx, dy, dwelling, row], `${v.id} @ ${t} ms`);
    }
    const s = pathPose(v.path, 5000, true);
    assert.deepEqual([s.x, s.y, s.facing], v.still, `${v.id} still pose (reduced motion)`);
  }
  for (const n of [0, 1, 2, 3, 4, 15, 16, 17, 36863, 36864, 73728]) assert.equal(isqrt(n), Math.floor(Math.sqrt(n)));
  // walk frame: 0 while dwelling, kit cadence otherwise
  const camel = all.find(v => v.id === 'camel-1');
  assert.equal(poseFrame(pathPose(camel.path, 999, false), 999, 6, 130), 0, 'dwelling shows frame 0 of the facing');
  assert.equal(poseFrame(pathPose(camel.path, 12345, false), 12345, 6, 130), 3 * 6 + (Math.floor(12345 / 130) % 6), 'walking up: row 3');
});

// ---- 2. world-anchored determinism ----------------------------------------------------------------------
test('scatter is world-anchored: an instance depends only on its lattice cell, never on the view window', () => {
  // Why: a tree that moved or re-rolled when the player pans would read as a broken world; the GPU walks
  // instance ids from a view-dependent origin, so placement must be a pure function of the cell.
  const env = { classAt: classField(), plotSdf: () => 1e9 };
  const L = compileLife('sunscar', LIFE_TABLES.sunscar, lookup);
  let compared = 0, placed = 0;
  for (const g of L.groups.filter(g => g.pitch <= 7)) {
    const A = latticeWindow(g.pitchArt, { x0: 0, y0: 0, x1: 40 * ART * 7, y1: 30 * ART * 7 }, g.maxExtent);
    const B = latticeWindow(g.pitchArt, { x0: 17 * ART * 7, y0: 11 * ART * 7, x1: 60 * ART * 7, y1: 50 * ART * 7 }, g.maxExtent);
    const at = (W, id) => scatterInstance(g, W.ix0 + id % W.nx, W.iy0 + Math.floor(id / W.nx), env);
    const mapA = new Map();
    for (let id = 0; id < A.nx * A.ny; id++) { const i = at(A, id); if (i) { mapA.set(`${i.ix},${i.iy}`, i); placed++; } }
    for (let id = 0; id < B.nx * B.ny; id++) {
      const ix = B.ix0 + id % B.nx, iy = B.iy0 + Math.floor(id / B.nx);
      if (ix < A.ix0 || iy < A.iy0 || ix >= A.ix0 + A.nx || iy >= A.iy0 + A.ny) continue;
      const i = at(B, id), a = mapA.get(`${ix},${iy}`) ?? null;
      assert.deepEqual(i, a, `${g.id} cell ${ix},${iy}`); compared++;
    }
  }
  assert.ok(placed > 500 && compared > 1000, `placed ${placed}, compared ${compared}`);
  // seats are integer art px inside their own cell
  const g = L.groups.find(g => g.id === 'grove');
  for (let iy = 0; iy < 20; iy++) for (let ix = 0; ix < 20; ix++) {
    const i = scatterInstance(g, ix, iy, { classAt: () => CLASS.FOREST, plotSdf: () => 1e9 });
    if (!i) continue;
    assert.ok(Number.isInteger(i.x) && Number.isInteger(i.y));
    assert.ok(i.x >= ix * g.pitchArt && i.x < (ix + 1) * g.pitchArt && i.y >= iy * g.pitchArt && i.y < (iy + 1) * g.pitchArt);
  }
});

// ---- 3. plot exclusion ------------------------------------------------------------------------------------
test('no tree, rock, crop or feature ever stands in a kingdom plot (plotSdf ≥ 2 + footprint)', () => {
  // Why: plots are the bases' ground (§6.2/§6.3 decor owns them); a palm growing through a wall or a keep
  // breaks "bases fit naturally in the world" (D-164.3/.4).
  const cols = 6, rows = 6, state = baseState(cols, rows, [[1, 1, 1], [3, 1, 20], [1, 3, 9], [4, 4, 13]]);
  const plotSdf = (tx, ty) => plotSdfAt(state, tx, ty);
  const cls = classField(9);
  const L = compileLife('crownlands', LIFE_TABLES.crownlands, lookup);
  let near = 0, removed = 0;
  for (const g of L.groups) {
    const W = latticeWindow(g.pitchArt, { x0: 0, y0: 0, x1: cols * DEED_ART, y1: rows * DEED_ART }, 0);
    for (let iy = W.iy0; iy < W.iy0 + W.ny; iy++) for (let ix = W.ix0; ix < W.ix0 + W.nx; ix++) {
      const free = scatterInstance(g, ix, iy, { classAt: cls, plotSdf: () => 1e9 });
      const i = scatterInstance(g, ix, iy, { classAt: cls, plotSdf });
      if (free && plotSdf(free.x / ART, free.y / ART) < 0) removed += i ? 0 : 1;
      if (!i) continue;
      const sdf = plotSdf(i.x / ART, i.y / ART);
      assert.ok(sdf >= PLOT_CLEAR + g.species[i.species].footR, `${g.id} ${i.id} at sdf ${sdf.toFixed(2)}`);
      if (sdf < PLOT_CLEAR + 4) near++;
    }
  }
  assert.ok(removed > 20, `the plots really removed scatter (${removed})`);
  assert.ok(near > 0, 'scatter still comes up to the plot edge (the rule is a clearance, not a void)');
  // the SDF is GROUND's plot box (half = claim/2 + ring + 2) at the plot's round-2 hashed offset inside its deed
  // (contracts.plotOffset, visual only): LIFE never places plots itself, so a moved plot moves its clearance too
  const half20 = plotRule(20).claim / 2 + plotRule(20).ring + 2, o20 = plotOffset(3, 1, 20);
  assert.ok(Math.abs(plotSdfAt(state, 3 * TILES + PLOT_CENTRE + o20.dx + half20, 1 * TILES + PLOT_CENTRE + o20.dy)) < 1e-9, 'sdf is 0 on the box edge');
});

// ---- 4. anti-speckle --------------------------------------------------------------------------------------
test('no sprite is drawn under 6 device px (the anti-speckle rule), at any d, for any species', () => {
  // Why: sub-6-px sprites are the "speckle/camo" the owner rejected (E2); the rubric item is a must-be-5.
  const L = compileLife('frostveil', LIFE_TABLES.frostveil, lookup);
  for (const g of L.groups) for (let d = 24; d <= 12544; d *= 1.09) {
    const w = bandWeights(d);
    for (let k = 0; k < 64; k++) {
      const s = k % g.species.length, inst = { species: s, h2: (k * 0x9e3779b9) >>> 0, rank: (k * 0x9e37) & 0xffff };
      const lod = instanceLod(g, inst, d, w.true, w.twins);
      if (lod !== 'none') assert.ok(devicePx(g.species[s].sp.inkH, d) >= MIN_SPRITE_PX - 1e-9, `${g.id} at d ${d.toFixed(0)}`);
    }
  }
  // the plan's worked example: an 8-map-px canopy twin (56 art px) first shows at d ≈ 336
  assert.ok(Math.abs(minVisibleD(8 * 7) - 336) < 1);
  assert.equal(bigEnough(56, 335), false); assert.equal(bigEnough(56, 337), true);
});

// ---- 5. twin ↔ true and herd ↔ creature share positions; fades are hashed, monotonic switches ----------
test('twins become kit sprites in place: same seat, per-instance hashed switch, monotonic in d', () => {
  // Why: MAP→TRUE must "resolve" a tree where it stands (§2.3); a moving or flickering tree is ghosting.
  const L = compileLife('sunscar', LIFE_TABLES.sunscar, lookup);
  const g = L.groups.find(g => g.id === 'lone'), env = { classAt: () => CLASS.WILD, plotSdf: () => 1e9 };
  const inst = [];
  for (let iy = 0; iy < 150; iy++) for (let ix = 0; ix < 150; ix++) { const i = scatterInstance(g, ix, iy, env); if (i) inst.push(i); }
  assert.ok(inst.length > 400); // round 2 thins lone trees outside stands: sample wider so the half-way share is not noise
  const lodAt = (i, d) => { const w = bandWeights(d); return instanceLod(g, i, d, w.true, w.twins); };
  let prevTrue = -1;
  for (let d = 700; d <= 1200; d += 25) {
    const n = inst.filter(i => lodAt(i, d) === 'true').length;
    assert.ok(n >= prevTrue, 'the set of resolved trees only grows while zooming in'); prevTrue = n;
  }
  const half = inst.filter(i => lodAt(i, 950) === 'true').length / inst.length;
  assert.ok(Math.abs(half - 0.5) < 0.08, `half-way through the fade about half are true (${half.toFixed(2)})`);
  for (const i of inst) { // an instance never changes seat with d: placement takes no zoom input
    const again = scatterInstance(g, i.ix, i.iy, env);
    assert.deepEqual(again, i);
    assert.ok(['none', 'twin'].includes(lodAt(i, 400)) && lodAt(i, 1100) === 'true');
  }
  // dense forest trees have no twin (the M1 ground draws them at MAP) and only appear in the TRUE fade
  const grove = L.groups.find(g => g.id === 'grove');
  const gi = scatterInstance(grove, 3, 3, { classAt: () => CLASS.FOREST, plotSdf: () => 1e9 }) ?? scatterInstance(grove, 4, 3, { classAt: () => CLASS.FOREST, plotSdf: () => 1e9 });
  assert.ok(gi);
  assert.equal(instanceLod(grove, gi, 700, bandWeights(700).true, bandWeights(700).twins), 'none');
});

test('herd members at MAP and kit creatures at TRUE are one record: identical positions across the hand-over', () => {
  // Why: §3.6 "at d ≥ 1100 they hand over to the true creature instances at the same positions".
  const L = compileLife('stormcairn', LIFE_TABLES.stormcairn, lookup), c = L.creatures, env = { classAt: classField(5), plotSdf: () => 1e9 };
  const v = { x: 3, y: 3, W: 1280, H: 800, dpr: 1 };
  const a = planDraws(L, { ...v, d: 1099 }).creatures, b = planDraws(L, { ...v, d: 1101 }).creatures;
  assert.ok(a && b, 'herds draw below 1100 and creatures above');
  let n = 0;
  for (let id = 0; id < Math.min(a.count, 4000); id++) {
    const ix = b.ix0 + Math.floor(id / HERD_MAX) % b.nx, iy = b.iy0 + Math.floor(Math.floor(id / HERD_MAX) / b.nx), m = id % HERD_MAX;
    const s = herdSite(c, ix, iy, env); if (!s) continue;
    const mem = herdMember(c, s, m, env); if (!mem) continue;
    for (const ms of [0, 777, 5000, 123456]) assert.deepEqual(memberPose(mem, ms, false), memberPose(herdMember(c, herdSite(c, ix, iy, env), m, env), ms, false));
    n++;
  }
  assert.ok(n > 10, `members compared: ${n}`);
});

// ---- 6. walkable waypoints, kit speed and dwell ------------------------------------------------------------
test('creatures never walk off their ground: waypoints and the walks between them are walkable, loops ≤ 6 tiles, kit speed/dwell', () => {
  // Why: a sheep walking on the sea or a seal crossing a meadow is the first thing a player notices; kit
  // speed/dwell keep the realm map's animals identical to the base's.
  const cls = classField(21), env = { classAt: cls, plotSdf: () => 1e9 };
  for (const realm of ['sunscar', 'frostveil', 'cinderfall', 'stormcairn', 'crownlands']) {
    const c = compileLife(realm, LIFE_TABLES[realm], lookup).creatures;
    let members = 0, water = 0, crossings = 0, samples = 0;
    for (let iy = 0; iy < 50; iy++) for (let ix = 0; ix < 50; ix++) {
      const s = herdSite(c, ix, iy, env); if (!s) continue;
      for (let m = 0; m < HERD_MAX; m++) {
        const mem = herdMember(c, s, m, env); if (!mem) continue;
        const sp = c.species[s.species].sh, pts = mem.path.points, home = pts[0];
        assert.equal(pts.length, 5); assert.deepEqual(pts[4], home, 'closed 4-waypoint loop');
        for (const p of pts) {
          assert.ok(walkableFor(sp.kind, cls(Math.floor(p.x / ART), Math.floor(p.y / ART))), `${mem.id} waypoint on ${p.x},${p.y}`);
          assert.ok(Math.abs(p.x - home.x) <= LOOP_RADIUS_TILES * ART + 8 && Math.abs(p.y - home.y) <= LOOP_RADIUS_TILES * ART + 8);
        }
        for (let i = 0; i < 4; i++) { // the walk itself, sampled every 8 art px independently of the rule's 16-px sampler
          const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
          for (let k = 0; k <= n; k++) {
            const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n;
            if (!walkableFor(sp.kind, cls(Math.floor(x / ART), Math.floor(y / ART)))) crossings++;
            samples++;
          }
        }
        assert.equal(mem.path.speed, sp.speed); assert.equal(mem.path.dwellMs, sp.dwellMs);
        members++; if (sp.kind === 'water') water++;
      }
    }
    assert.ok(members > 30, `${realm}: ${members} members`);
    // a diagonal may clip a tile corner between the rule's half-tile samples; never more than a sliver
    assert.ok(crossings / samples < 0.002, `${realm}: ${crossings}/${samples} walk samples off walkable ground`);
  }
  // plots: the whole loop disk clears every plot
  const state = baseState(3, 3, [[1, 1, 20]]), c = compileLife('crownlands', LIFE_TABLES.crownlands, lookup).creatures;
  const envP = { classAt: () => CLASS.WILD, plotSdf: (x, y) => plotSdfAt(state, x, y) };
  for (let iy = 0; iy < 22; iy++) for (let ix = 0; ix < 22; ix++) {
    const s = herdSite(c, ix, iy, envP); if (!s) continue;
    assert.ok(envP.plotSdf(s.x / ART, s.y / ART) >= PLOT_CLEAR + LOOP_RADIUS_TILES + 2);
  }
});

// ---- 7. caps and the instance budget ---------------------------------------------------------------------
test('instance budget and on-screen caps hold for every realm, phone and desktop, across the whole zoom', () => {
  // Why: §9 budgets (≤ 40k submitted on a phone) and §7 caps (≤ 120 creatures, 24 birds, 300 particles)
  // keep the Seeker at 60 fps; a cap that only holds "usually" is a frame-time cliff. RM-20 (P0 fix pass): the budget
  // is per device, whatever its dpr — a dpr-3 phone (50–52k) and dpr-2 desktops (69–71k at 1280×800, 136–140k at
  // 1920×1080) overran it by 25–130 % because LIFE's windows grow with the device canvas. Thinned lattices (stride s)
  // walk 1/s² of the sites, so the expected on-screen counts use that.
  const views = [{ W: 390, H: 844, dpr: 2, cap: LIFE_CAPS.submitted.phone }, { W: 844, H: 390, dpr: 2, cap: LIFE_CAPS.submitted.phone }, { W: 1280, H: 800, dpr: 1, cap: LIFE_CAPS.submitted.desktop },
    { W: 390, H: 844, dpr: 3, cap: LIFE_CAPS.submitted.phone }, { W: 932, H: 430, dpr: 3, cap: LIFE_CAPS.submitted.phone }, { W: 1280, H: 800, dpr: 2, cap: LIFE_CAPS.submitted.desktop },
    { W: 1920, H: 1080, dpr: 2, cap: LIFE_CAPS.submitted.desktop }, { W: 2560, H: 1440, dpr: 2, cap: LIFE_CAPS.submitted.desktop }];
  for (const realm of Object.keys(LIFE_TABLES)) {
    const L = compileLife(realm, LIFE_TABLES[realm], lookup);
    for (const v of views) for (let d = 24; d <= BANDS.sMax * v.dpr; d *= 1.07) {
      const p = planDraws(L, { x: 20, y: 20, d, ...v });
      assert.equal(submittedCap(v), v.cap, `${v.W}×${v.H}: the device's budget`);
      assert.ok(p.total <= v.cap, `${realm} ${v.W}×${v.H}@${v.dpr} d ${d.toFixed(0)}: ${p.total} submitted`);
      const vw = v.W * v.dpr / d * TILES, vh = v.H * v.dpr / d * TILES;
      if (p.creatures) {
        const c = L.creatures, maxP = Math.max(...c.density) / 65535, meanHerd = c.species.reduce((a, s) => a + (s.herdMin + s.herdMax) / 2, 0) / c.species.length;
        assert.ok(vw * vh / (c.pitch * (p.creatures.stride ?? 1)) ** 2 * maxP * meanHerd * p.creatures.keep <= p.creatures.cap + 1e-6);
      }
      const amb = p.ambience.reduce((a, e) => a + vw * vh / (e.a.pitchArt / ART * (e.stride ?? 1)) ** 2 * Math.max(...e.a.density) / 65535 * e.keep, 0);
      assert.ok(amb <= LIFE_CAPS.particles + 1e-6, `${realm} particles ${amb.toFixed(0)}`);
    }
  }
  assert.equal(keepFraction(24, 12), 1); assert.equal(keepFraction(24, 48), 0.5);
});
test('the FAR→MAP fade is the chart\'s: LIFE walks nothing below d 48, and low MAP leaves room for ground and bases', () => {
  // Why (GA2 fix iteration 1): at d 36 map objects were sub-pixel yet 17–46k of the 72–95k instances that broke the
  // 40k phone budget. Below MAP proper LIFE submits nothing; at low MAP (d < 170) the ground and the bases carry most
  // of the view, so LIFE keeps under 45 % of the frame budget there, whatever the realm or screen.
  const views = [{ W: 390, H: 844, dpr: 2, cap: LIFE_CAPS.submitted.phone }, { W: 844, H: 390, dpr: 2, cap: LIFE_CAPS.submitted.phone }, { W: 1280, H: 800, dpr: 1, cap: LIFE_CAPS.submitted.desktop }];
  for (const realm of Object.keys(LIFE_TABLES)) {
    const t = lifeTable(realm, { map: { objects: { map_peak_1: { w: 64, h: 64 }, map_hill_1: { w: 64, h: 40 }, map_clump_1: { w: 40, h: 30 } } } });
    const L = compileLife(realm, t, { sprite: id => (id.startsWith('map_') ? { inkH: 30 * 7, w: 64 * 7, h: 64 * 7 } : spriteStub(id)), creature: creatureStub });
    for (const v of views) for (let d = 20; d < 170; d *= 1.05) {
      const p = planDraws(L, { x: 60, y: 60, d, ...v });
      if (d < BANDS.mapStart) assert.equal(p.total, 0, `${realm} d ${d.toFixed(0)}: ${p.total} submitted inside the FAR fade`);
      assert.ok(p.total <= 0.45 * v.cap, `${realm} ${v.W}×${v.H} d ${d.toFixed(0)}: LIFE ${p.total} of ${v.cap}`);
      const mo = p.groups.find(pg => pg.g.id === 'mapobj'), mw = p.stands?.mergedWin;
      // W1: map objects keep the cells whose rank is under mapKeep (was a 1/2/4 stride): a draw walks ≤ LIFE_CAPS.mapobj
      assert.ok(mo.count <= LIFE_CAPS.mapobj, `${realm} d ${d.toFixed(0)}: map objects walk ${mo.count} cells`);
      if (mo.count) assert.equal(mo.kit.hi, rankBound(mo.keep), 'map objects draw the ranks under their keep');
      if (mw) assert.ok(mw.ix0 % mw.stride === 0 && mw.iy0 % mw.stride === 0 && p.stands.merged <= 1.2 * STAND.mergeCap, 'merged blocks thin world-aligned under their cap');
    }
  }
  // the map-object keep: all of them while few, then continuous (no ×4 step) and nested (it only rises as the view shrinks)
  assert.equal(mapKeep(1), 1); assert.equal(mapKeep(LIFE_CAPS.mapobj / (RANK_SLOTS + 1)), 1);
  for (let b = 100; b < 20000; b *= 1.01) {
    assert.ok(mapKeep(b) <= mapKeep(b / 1.01) && mapKeep(b / 1.01) - mapKeep(b) < 0.02, `mapKeep continuous and nested at ${b.toFixed(0)} blocks`);
    assert.ok(b * (RANK_SLOTS * mapKeep(b) + 1) <= LIFE_CAPS.mapobj + 1e-6 || mapKeep(b) === 0, 'a map-object draw walks at most LIFE_CAPS.mapobj cells');
  }
});

test('the §9 ceiling costs nothing where it already held, and where it binds it thins by rank, tier by tier, least defining first', () => {
  // Why (RM-20, P0 fix pass; rewritten for W1, D-171: the stride steps became rank thinning): enforcing the budget must not
  // buy performance with the owner's scene where it was never at risk. (1) Kit art that only the TRUE dissolve shows is
  // invisible at w.true = 0 (d = trueStart, a resting edge), so it submits nothing there — that alone took a resting retina
  // view from ~70k to ~8k with no pixel changed. (2) A dpr-2 phone or a dpr-1 desktop never thins (every tier's factor
  // stays 1). (3) Where the ceiling binds it goes tier by tier from the least visible — the keep-capped streams by
  // world-aligned, count-neutral strides (keep × stride²); then the TRUE-only groups; the stands only once those are gone;
  // the twin groups only once the stands are gone — and within a tier a later THIN_ORDER group is never thinner. (4) Every
  // thinned draw is a rank range: kit art [0, wTrue · keep) (twin groups [0, wTwin · keep)), twins [wTrue · keep, wTwin ·
  // keep), stand members [0, wTrue · keep), own clumps [wTrue · keep, keep) — the dissolve and the thinning keep the SAME
  // cells, so a draw submits about what it shows.
  const small = [{ W: 390, H: 844, dpr: 2 }, { W: 844, H: 390, dpr: 2 }, { W: 1280, H: 800, dpr: 1 }];
  const big = [{ W: 390, H: 844, dpr: 3 }, { W: 1280, H: 800, dpr: 2 }, { W: 1920, H: 1080, dpr: 2 }, { W: 2560, H: 1440, dpr: 2 }];
  let thinned = 0, tiers = [0, 0, 0, 0];
  for (const realm of Object.keys(LIFE_TABLES)) {
    const L = compileLife(realm, LIFE_TABLES[realm], lookup);
    for (const v of small) for (let d = 24; d <= BANDS.sMax * v.dpr; d *= 1.05) {
      const p = planDraws(L, { x: 20, y: 20, d, ...v });
      assert.ok(!p.thin || p.thin.tau.every(t => t === 1), `${realm} ${v.W}×${v.H}@${v.dpr} d ${d.toFixed(0)}: thinned under its budget (τ ${p.thin?.tau})`);
      for (const e of [p.creatures, p.birds, ...p.ambience]) assert.equal(e?.stride ?? 1, 1, `${realm} d ${d.toFixed(0)}: a stream thinned under its budget`);
    }
    for (const v of [...small, ...big]) {
      const at = planDraws(L, { x: 20, y: 20, d: BANDS.trueStart, ...v }), past = planDraws(L, { x: 20, y: 20, d: BANDS.trueStart * 1.01, ...v });
      assert.equal(bandWeights(BANDS.trueStart).true, 0);
      for (const pg of at.groups) if (!pg.g.twin && !pg.g.mapOnly) assert.equal(pg.count, 0, `${realm} ${pg.g.id}: submitted at w.true = 0`);
      assert.equal(at.stands?.members ?? 0, 0, `${realm}: stand members submitted at w.true = 0`);
      assert.ok(past.groups.some(pg => !pg.g.twin && pg.count > 0) && past.stands.members > 0, `${realm}: TRUE kit art is on as soon as w.true > 0`);
      assert.ok(at.groups.some(pg => pg.g.twin && pg.count > 0) && (at.stands?.clumps ?? 0) > 0, `${realm}: twins and stand clumps (the visible MAP art) keep drawing at d 800`);
    }
    for (const v of big) for (let d = 48; d <= 3000; d *= 1.03) {
      const p = planDraws(L, { x: 20, y: 20, d, ...v }), { true: wT, twins: wTw } = bandWeights(d), [, t1, t2, t3] = p.thin.tau;
      const tier = twin => p.groups.filter(pg => pg.count + (pg.tw?.count ?? 0) > 0 && !pg.g.mapOnly && !pg.g.twin === !twin);
      for (const e of [p.creatures, p.birds, ...p.ambience]) if (e?.count) {
        assert.ok(e.ix0 % e.stride === 0 && e.iy0 % e.stride === 0 && e.stride <= THIN_MAX, `${realm} d ${d.toFixed(0)}: a world-aligned stream stride ${e.stride}`);
        if (e.stride > 1) { tiers[0]++; assert.ok(e.keep <= 1 + 1e-9 && Math.abs(e.keep - e.keep0 * e.stride ** 2) < 1e-9, 'a thinned stream keeps its expected count'); }
      }
      if (t2 < 1) assert.ok(t1 === 0 || !tier(false).length, `${realm} d ${d.toFixed(0)}: stands thinned before the TRUE-only groups were gone`);
      if (t3 < 1) assert.ok((t2 === 0 || !(p.stands?.members || p.stands?.clumps)) && (t1 === 0 || !tier(false).length), `${realm} d ${d.toFixed(0)}: twins thinned before the stands were gone`);
      for (const t of [tier(false), tier(true)]) { // least defining first (THIN_ORDER): a later group never thinner than an earlier one
        const r = pg => (THIN_ORDER.indexOf(pg.g.id) + 1 || 99), o = t.slice().sort((x, y) => r(x) - r(y));
        for (let i = 1; i < o.length; i++) assert.ok(o[i].keep >= o[i - 1].keep - 1e-12, `${realm} d ${d.toFixed(0)}: ${o[i].g.id} ${o[i].keep} thinner than ${o[i - 1].g.id} ${o[i - 1].keep}`);
      }
      for (const pg of [...tier(false), ...tier(true)]) { // the draws are the rank ranges of the dissolve × the thinning
        assert.equal(pg.truHi, rankBound(wT * pg.keep)); assert.equal(pg.keepHi, rankBound(pg.keep));
        assert.deepEqual([pg.kit.lo, pg.kit.hi], pg.g.twin ? [0, rankBound(wTw * pg.keep)] : [0, pg.truHi], `${pg.g.id}: its kit range`);
        if (pg.tw) assert.deepEqual([pg.tw.lo, pg.tw.hi], [pg.truHi, rankBound(wTw * pg.keep)], `${pg.g.id}: its twin range`);
      }
      if (p.stands?.members) assert.deepEqual([p.stands.mem.lo, p.stands.mem.hi], [0, rankBound(wT * p.stands.keep)], 'stand members: [0, wTrue · keep)');
      if (p.stands?.clumps) assert.deepEqual([p.stands.clu.lo, p.stands.clu.hi], [rankBound(wT * p.stands.keep), rankBound(p.stands.keep)], 'own clumps: [wTrue · keep, keep)');
      if (t1 < 1) tiers[1]++; if (t2 < 1) tiers[2]++; if (t3 < 1) tiers[3]++;
      if (p.thin.tau.some(t => t < 1)) thinned++;
      assert.ok(p.total <= p.cap, `${realm} ${v.W}×${v.H}@${v.dpr} d ${d.toFixed(0)}: ${p.total} over ${p.cap}`);
    }
  }
  assert.ok(thinned > 100 && tiers[1] > 50, `${thinned} thinned views checked, per tier ${tiers} (the big screens do reach the ceiling)`);
});

test('the woods never thin in steps: every kept fraction is continuous in the zoom and independent of the pan (W1)', () => {
  // Why (W1, D-171 orchestrator call on RM-20's open question): over the ceiling the stride thinning dropped TRUE-only
  // groups to 1/4 and back in steps (/4 → /2 → full), so in the MAP→TRUE fade on a dpr-2 desktop the woods read sparse
  // then full. Now each thinning tier has ONE continuous factor fitted to pan-invariant cost bounds (continuous in d, with
  // phantoms that fade across a draw's start or end), so every visible density — TRUE-only kit art w.true · keep, twin
  // groups, stands, map objects — changes by at most a few % per 0.2 % of zoom, and never while panning (a density that
  // followed the pan would make instances at the rank threshold flicker).
  const views = [{ W: 1280, H: 800, dpr: 2 }, { W: 1920, H: 1080, dpr: 2 }, { W: 2560, H: 1440, dpr: 2 }, { W: 390, H: 844, dpr: 3 }];
  let worst = { dv: 0 }, active = 0;
  for (const realm of Object.keys(LIFE_TABLES)) {
    const L = compileLife(realm, LIFE_TABLES[realm], lookup);
    for (const v of views) {
      let prev = null;
      for (let d = 760; d <= 1600; d *= 1.002) {
        const p = planDraws(L, { x: 20, y: 20, d, ...v }), w = bandWeights(d).true, dens = {};
        for (const pg of p.groups) dens[pg.g.id] = pg.g.twin || pg.g.mapOnly ? pg.keep : w * pg.keep;
        if (p.stands) { dens.stands = p.stands.keep; dens.members = w * p.stands.keep; }
        if (prev) for (const [id, x] of Object.entries(dens)) if (id in prev) {
          const dv = Math.abs(x - prev[id]);
          if (dv > worst.dv) worst = { dv, realm, id, d: Math.round(d), from: prev[id], to: x, view: `${v.W}×${v.H}@${v.dpr}` };
        }
        prev = dens;
        if (p.thin.tau.some(t => t < 1)) active++;
        for (const [x, y] of [[20.37, 19.79], [23.13, 21.6]]) { // the same zoom panned: the same fit
          const q = planDraws(L, { x, y, d, ...v });
          assert.deepEqual(q.thin.tau, p.thin.tau, `${realm} ${v.W}×${v.H}@${v.dpr} d ${d.toFixed(0)}: the thinning followed the pan`);
          assert.deepEqual(q.groups.map(pg => pg.keep), p.groups.map(pg => pg.keep));
        }
      }
    }
  }
  assert.ok(active > 500, `${active} fade views where the ceiling binds (the test must see thinning to mean anything)`);
  assert.ok(worst.dv <= 0.05, `a density step of ${worst.dv.toFixed(3)} per 0.2 % of zoom: ${JSON.stringify(worst)}`);
});

test('rank windows submit exactly the kept cells: a rank range is one slot range of every world-aligned 4×4 block (W1)', () => {
  // Why (W1): the dissolve and the thinning keep the cells whose rank is in a range, and a draw submits only those (the
  // retina's d 820 fade frame was 107k instances for ~17k shown). The enumeration must yield exactly the kept cells — a
  // missing cell is a hole, a doubled or wrong one a tree that pops — and ranks must be spread (a prefix of the slots is a
  // coarser lattice, never a clump), world-anchored and nested (zooming in, a larger bound, only adds cells).
  assert.equal(RANK_B * RANK_B, RANK_SLOTS); assert.equal(RANK_STEP * RANK_SLOTS, 65536);
  const seen = new Set();
  for (let j = 0; j < RANK_SLOTS; j++) { const [x, y] = slotXY(j); assert.equal(xySlot(x, y), j); seen.add(`${x},${y}`); }
  assert.equal(seen.size, RANK_SLOTS, 'the slots are the 16 cells of a block');
  const par = j => slotXY(j).map(c => c & 1);
  for (let j = 1; j < 4; j++) assert.deepEqual(par(j), par(0), 'slots 0–3 are one stride-2 coset');
  for (let j = 4; j < 8; j++) assert.equal((slotXY(j)[0] + slotXY(j)[1]) & 1, (slotXY(0)[0] + slotXY(0)[1]) & 1, 'slots 0–7 are a checkerboard');
  for (const salt of [1, 777, 40961, 65535]) for (let by = -6; by < 6; by++) for (let bx = -6; bx < 6; bx++) {
    const cells = new Set();
    for (let j = 0; j < RANK_SLOTS; j++) {
      const [ix, iy, r] = slotCell(salt, bx, by, j);
      assert.ok(Math.floor(ix / RANK_B) === bx && Math.floor(iy / RANK_B) === by, 'a slot stays in its block');
      assert.equal(cellRank(salt, ix, iy), r, 'the rank a slot draws with is its cell\'s rank');
      assert.ok(r >= j * RANK_STEP && r < (j + 1) * RANK_STEP);
      cells.add(`${ix},${iy}`);
    }
    assert.equal(cells.size, RANK_SLOTS);
  }
  // a rank draw over a window = exactly the window's cells with rank in [lo, hi), and fewer instances when thinned
  const salt = 4242;
  for (const win of [{ ix0: -13, iy0: 7, nx: 37, ny: 22 }, { ix0: 100, iy0: -40, nx: 5, ny: 61 }, { ix0: 0, iy0: 0, nx: 1, ny: 1 }]) {
    for (const [lo, hi] of [[0, 65536], [0, 23000], [0, 2000], [9000, 40000], [30000, 30001], [0, 0], [65535, 65536]]) {
      const r = rankDraw(win, lo, hi), want = new Set(), got = new Set();
      for (let iy = win.iy0; iy < win.iy0 + win.ny; iy++) for (let ix = win.ix0; ix < win.ix0 + win.nx; ix++) { const k = cellRank(salt, ix, iy); if (k >= lo && k < hi) want.add(`${ix},${iy}`); }
      const inWin = (ix, iy) => ix >= win.ix0 && ix < win.ix0 + win.nx && iy >= win.iy0 && iy < win.iy0 + win.ny;
      for (let id = 0; id < r.count; id++) {
        let ix, iy, k;
        if (r.rl) { const b = Math.floor(id / r.rl.m); [ix, iy, k] = slotCell(salt, r.rl.bx0 + (b % r.rl.nbx), r.rl.by0 + Math.floor(b / r.rl.nbx), r.rl.j0 + (id % r.rl.m)); }
        else { ix = win.ix0 + (id % win.nx); iy = win.iy0 + Math.floor(id / win.nx); k = cellRank(salt, ix, iy); }
        if (k >= lo && k < hi && inWin(ix, iy)) { assert.ok(!got.has(`${ix},${iy}`), 'no cell twice'); got.add(`${ix},${iy}`); }
      }
      assert.deepEqual([...got].sort(), [...want].sort(), `window ${JSON.stringify(win)} ranks [${lo}, ${hi})`);
      assert.ok(r.count <= win.nx * win.ny, 'never more than the plain window');
      if (r.rl) assert.equal(r.count, r.rl.nbx * r.rl.nby * r.rl.m);
    }
  }
  assert.deepEqual(rankSlots(0, 65536), { j0: 0, m: 16 }); assert.deepEqual(rankSlots(4096, 8193), { j0: 1, m: 2 }); assert.deepEqual(rankSlots(5, 5), { j0: 0, m: 0 });
  assert.equal(rankBound(0), 0); assert.equal(rankBound(1), 65536); assert.equal(rankBound(2), 65536);
  // thinFactor: the tier moves together, earlier THIN_ORDER groups faster, all continuous in f and 1 at f = 1
  for (let f = 0; f <= 1; f += 0.01) for (let i = 1; i < 5; i++) assert.ok(thinFactor(i, 5, f) >= thinFactor(i - 1, 5, f));
  assert.equal(thinFactor(0, 5, 1), 1); assert.equal(thinFactor(0, 5, 0), 0); assert.ok(Math.abs(thinFactor(0, 5, 0.5) - 0.5 ** THIN_SPREAD) < 1e-12);
});

test('GLSL rank windows are scatter.mjs\'s: rankHash, slotXY, xySlot, cellRank and slotCell, bit for bit (W1)', () => {
  // Why: the GPU places every rank-window instance and decides every dissolve from these functions, and the plan, the
  // budget and the offline QC use scatter.mjs. A mismatch would draw other cells than the plan counted (a hole or a
  // pop) — so the shader source is pinned here and its exact integer semantics replayed against the JS reference.
  const L = SPRITES_GLSL.LIFE;
  const body = name => { const m = new RegExp(`\\n[\\w ]+ ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n?\\}\\n`).exec(L); return m && (m[1] + ' | ' + m[2]).replace(/\s+/g, ' ').trim(); };
  assert.match(L, /const int RANK_B = 4, RANK_STEP = 4096;/);
  assert.equal(body('rankHash'), 'int salt, ivec2 b | return pcg2d(uvec2(ivec2(b.x ^ salt ^ 0x5a17, b.y ^ (salt * 7) ^ 0x3c6e))).x;');
  assert.equal(body('rankScramble'), 'uint h | return ivec2(int(h & 3u), int((h >> 4u) & 3u));');
  assert.equal(body('slotXY'), 'int j | int a = j & 3, b = (j >> 2) & 3; return ivec2((((a ^ (a >> 1)) & 1) << 1) | ((b ^ (b >> 1)) & 1), ((a & 1) << 1) | (b & 1));');
  assert.equal(body('xySlot'), 'ivec2 l | int a = ((((l.x >> 1) ^ (l.y >> 1)) & 1) << 1) | ((l.y >> 1) & 1), b = (((l.x ^ l.y) & 1) << 1) | (l.y & 1); return a | (b << 2);');
  assert.equal(body('cellRank'), 'int salt, ivec2 c | ivec2 b = ivec2(floorDiv(c.x, RANK_B), floorDiv(c.y, RANK_B)); uint h = rankHash(salt, b); return xySlot((c - b * RANK_B) ^ rankScramble(h)) * RANK_STEP + int(h >> 20u);');
  assert.equal(body('slotCell'), 'int salt, ivec2 b, int j, out int rank | uint h = rankHash(salt, b); rank = j * RANK_STEP + int(h >> 20u); return b * RANK_B + (slotXY(j) ^ rankScramble(h));');
  // the pinned source, replayed with GLSL int/uint semantics (int32 wrap, uint from int = the same bits)
  const h32 = (salt, bx, by) => pcg2d((bx ^ salt ^ 0x5a17) >>> 0, (by ^ Math.imul(salt, 7) ^ 0x3c6e) >>> 0)[0];
  const gSlotXY = j => { const a = j & 3, b = (j >> 2) & 3; return [(((a ^ (a >> 1)) & 1) << 1) | ((b ^ (b >> 1)) & 1), ((a & 1) << 1) | (b & 1)]; };
  const gXySlot = (x, y) => { const a = ((((x >> 1) ^ (y >> 1)) & 1) << 1) | ((y >> 1) & 1), b = (((x ^ y) & 1) << 1) | (y & 1); return a | (b << 2); };
  const floorDivG = (a, b) => (a >= 0 ? Math.trunc(a / b) : -Math.trunc((-a + b - 1) / b));
  const gCellRank = (salt, cx, cy) => { const bx = floorDivG(cx, 4), by = floorDivG(cy, 4), h = h32(salt, bx, by); return gXySlot((cx - bx * 4) ^ (h & 3), (cy - by * 4) ^ ((h >>> 4) & 3)) * 4096 + (h >>> 20); };
  const gSlotCell = (salt, bx, by, j) => { const h = h32(salt, bx, by), [x, y] = gSlotXY(j); return [bx * 4 + (x ^ (h & 3)), by * 4 + (y ^ ((h >>> 4) & 3)), j * 4096 + (h >>> 20)]; };
  for (const salt of [0, 1, 999, 32767, 65535]) for (let y = -70; y < 70; y += 3) for (let x = -90; x < 90; x += 7) {
    assert.equal(gCellRank(salt, x, y), cellRank(salt, x, y), `cellRank(${salt}, ${x}, ${y})`);
    assert.deepEqual(gSlotCell(salt, x, y, (x ^ y) & 15), slotCell(salt, x, y, (x ^ y) & 15), `slotCell(${salt}, ${x}, ${y})`);
  }
  for (const [bx, by] of [[0, 0], [-1, -1], [123456, -98765]]) { const h = h32(7, bx, by); assert.deepEqual(rankHash(7, bx, by), { sx: h & 3, sy: (h >>> 4) & 3, u16: h >>> 16 }); }
});

test('GLSL pickSpecies is scatter.mjs\'s: a bounded lower-bound search picks the same species as the linear scan, up to MAX_SPECIES', () => {
  // Why (Stage B): Solana Reach ships 53 map objects, over the 32-species row whose linear GLSL scan was the table's limit.
  // MAX_SPECIES went to 64 and the GLSL pick became a lower-bound search (≤ 7 fetches, a literal loop bound, so the GPU-hang
  // rule holds). The plan, the budget and offline QC pick with scatter.mjs's linear scan: a different index on the GPU would
  // draw another species than every test and QC saw (a boat on a peak). The pinned source is replayed with GLSL semantics.
  const L = SPRITES_GLSL.LIFE, m = /\nint pickSpecies\(int row, int n, uint pick\) \{([\s\S]*?)\n\}\n/.exec(L);
  assert.ok(m, 'pickSpecies source found');
  const body = m[1].replace(/\s+/g, ' ').trim();
  assert.equal(body, 'int lo = 0, hi = n; for (int i = 0; i < 7; i++) { if (lo >= hi) break; int mid = (lo + hi) >> 1; if (pick <= lt(mid * SPT, row).y) hi = mid; else lo = mid + 1; } return lo < n ? lo : -1;');
  const trips = +/i < (\d+);/.exec(body)[1];
  assert.ok(2 ** trips > MAX_SPECIES, `${trips} halvings cover ${MAX_SPECIES} species`);
  const gPick = (cumM1, n, pick) => { let lo = 0, hi = n; for (let i = 0; i < trips; i++) { if (lo >= hi) break; const mid = (lo + hi) >> 1; if (pick <= cumM1[mid]) hi = mid; else lo = mid + 1; } return lo < n ? lo : -1; };
  let k = 0; const rnd = () => (pcg2d(k++, 0x51ab)[0] >>> 16) / 65536;
  for (let t = 0; t < 400; t++) {
    const n = t < 4 ? [0, 1, MAX_SPECIES, 53][t] : 1 + Math.floor(rnd() * MAX_SPECIES);
    const w = [...Array(n)].map(() => (rnd() < 0.15 ? 0 : rnd() * 5)), total = w.reduce((a, b) => a + b, 0) || 1; // zero weights: equal cum
    let acc = 0; const species = w.map(x => { acc += x; return { cum: Math.min(65536, Math.round(acc / total * 65536)) }; });
    if (n) species[n - 1].cum = 65536;
    const cumM1 = species.map(sp => sp.cum - 1); // life.mjs writes cum − 1 (u16)
    for (const pick of [0, 1, 32767, 65534, 65535, ...[...Array(40)].map(() => Math.floor(rnd() * 65536))])
      assert.equal(gPick(cumM1, n, pick), pickSpecies(species, pick), `n ${n} pick ${pick}`);
  }
});

test('LIFE reads TRUE tile records only where GROUND guarantees them: placement is a pure function of the view', () => {
  // Why (fix iteration 2, context loss): GROUND's classAtTile reads a TRUE record wherever a deed page is resident. Below
  // BANDS.pageResolve a resident page is a leftover of an earlier view (LRU), so Crownlands V4 (d 450) grew or lost tree
  // clumps after a context restore emptied the LRU (5.3k px over 32 levels). LIFE may read TRUE records only from
  // pageResolve, where GROUND resolves the view ±1 deed, and then every LIFE lattice window plus its farthest class
  // sample (set-piece footprint + coast, merged stand 2R, herd loop, spray) must lie inside that ring.
  for (const d of [24, 60, 300, 450, BANDS.pageResolve - 0.5]) assert.equal(trueClasses(d), false, `d ${d}: MAP classes only`);
  for (const d of [BANDS.pageResolve, BANDS.trueStart, BANDS.snap]) assert.equal(trueClasses(d), true, `d ${d}: TRUE records`);
  const views = [{ W: 390, H: 844, dpr: 2 }, { W: 844, H: 390, dpr: 2 }, { W: 1280, H: 800, dpr: 1 }];
  for (const realm of Object.keys(LIFE_TABLES)) {
    const t = lifeTable(realm, { map: { objects: { map_peak_1: { w: 64, h: 64 }, map_clump_1: { w: 40, h: 30 } } } });
    const L = compileLife(realm, t, { sprite: id => (id.startsWith('map_') ? { inkH: 30 * 7, w: 64 * 7, h: 64 * 7 } : spriteStub(id)), creature: creatureStub });
    const Rmax = L.stands ? Math.max(...L.stands.variants.map(V => (V.R4 + 3) >> 2)) : 0;
    for (const v of views) for (let d = 30; d <= BANDS.sMax * v.dpr; d *= 1.09) {
      const view = { x: 40.3, y: 40.7, d, ...v }, p = planDraws(L, view);
      assert.equal(p.trueClasses, trueClasses(d), 'the plan carries the rule the shaders get (uTrueCls)');
      if (!p.trueClasses) continue;
      // only a seat within its draw's sprite margin of the view can touch a pixel; its class samples reach `reach`
      // further (a merged clump's leader may be any stand of its 2×2 block: one more stand cell)
      const wins = [];
      for (const pg of p.groups) if (pg.count) wins.push([pg.g.id, pg, (Math.max(...pg.g.species.map(s => s.footR ?? 0)) + 3) * ART]);
      if (p.stands?.sites) wins.push(['stands', p.stands, Rmax * ART]);
      if (p.stands?.merged) wins.push(['merged', p.stands.mergedWin, L.stands.pitchArt + 2 * Rmax * ART]);
      if (p.creatures) wins.push(['herds', p.creatures, (LOOP_RADIUS_TILES + 2) * ART]);
      if (p.birds) wins.push(['birds', p.birds, 0]);
      for (const e of p.ambience) wins.push([e.a.id, e, 2 * ART]);
      for (const [id, w, reach] of wins) assert.ok(w.margin + reach <= DEED_ART,
        `${realm} ${v.W}×${v.H} d ${d.toFixed(0)} ${id}: margin ${w.margin} + reach ${reach} art px passes GROUND's resident ring (view ±1 deed)`);
    }
  }
});

// ---- 8. reduced motion freezes -----------------------------------------------------------------------------
test('reduced motion freezes life: creatures at home on frame 0, no sway, no birds, no particles', () => {
  // Why: prefers-reduced-motion is an accessibility promise (§8.2, §7 "Reduced motion" column).
  const L = compileLife('cinderfall', LIFE_TABLES.cinderfall, lookup);
  const p = planDraws(L, { x: 10, y: 10, d: 1500, W: 390, H: 844, dpr: 2, rm: true });
  assert.equal(p.birds, undefined); assert.equal(p.ambience.length, 0);
  const env = { classAt: () => CLASS.ROCK, plotSdf: () => 1e9 };
  let s = null, ix = 0; while (!s && ix < 400) s = herdSite(L.creatures, ix++, 0, env);
  const mem = herdMember(L.creatures, s, 0, env);
  for (const ms of [0, 999, 50000]) {
    const pose = memberPose(mem, ms, true);
    assert.deepEqual([pose.x, pose.y], [mem.path.points[0].x, mem.path.points[0].y]);
    assert.equal(poseFrame(pose, ms, 6, 120, 4, true) % 6, 0);
  }
  const tree = { h2: 0x9e3779b9, phase: 123 };
  assert.equal(swayArt(tree, 4567, 3000, true), 0);
  assert.equal(swayArt(tree, 4567, 1999, false), 0, 'no sway below d 2000');
  let moved = 0;
  for (let k = 0; k < 200; k++) {
    const t = { h2: (k * 0x9e3779b9) >>> 0, phase: (k * 7919) & 0x7fff };
    for (const ms of [0, 1234, 99999, 4294967295]) { const a = swayArt(t, ms, 3000, false); assert.ok(Math.abs(a) <= 1, 'sway never exceeds 1 art px'); if (a) moved++; }
  }
  assert.ok(moved > 100, 'trees do sway at d ≥ 2000');
});

// ---- 9. birds and particles are deterministic in (cell, ms) ------------------------------------------------
test('birds and ambience are pure functions of (cell, ms): identical on every device and every frame replay', () => {
  // Why: `freeze=<ms>` captures and the two-frame animation diff (§11.1) need bit-stable poses.
  const L = compileLife('frostveil', LIFE_TABLES.frostveil, lookup), env = { classAt: () => CLASS.WILD, plotSdf: () => 1e9 };
  let f = null, ix = 0; while (!f && ix < 200) f = flockSite(L.birds, ix++, 2, env);
  assert.ok(f, 'a flock exists');
  assert.deepEqual(birdPose(L.birds, f, 1, 4321), birdPose(L.birds, f, 1, 4321));
  assert.notDeepEqual(birdPose(L.birds, f, 1, 4321), birdPose(L.birds, f, 1, 5321), 'birds move');
  const a = L.ambience[0]; let q = null; ix = 0;
  while (!q && ix < 200) q = particle(a, ix++, 5, 1000, env, L.wind);
  assert.ok(q, 'a snowflake exists');
  assert.deepEqual(particle(a, ix - 1, 5, 1000, env, L.wind), q);
  assert.ok(q.fade >= 0 && q.fade <= 1);
  assert.equal(skyScale(300), 3); assert.equal(skyScale(1100), 1); assert.equal(skyScale(5000), 1);
});

// ---- 10. only kit.json assets (the reuse rule) ---------------------------------------------------------------
const KIT = join(homedir(), 'Desktop/SHARDKEEP-realm-kit'), KIT_PIN = 'fc5c6ad19ea6';
/** Stage B: the three new realms exist only at their own release SHAs (NIGHT-2026-09-25 02:30; GLOBE-3D-PLAN "Final release SHAs"). */
const KIT_PINS = { elderwood: '99147f20', thornwake: 'e02e40b8', 'seeker-reach': 'a65cede0' };
test('every LIFE table id is a prop, sprite or creature of that realm\'s kit.json at the pinned SHA', { skip: !existsSync(join(KIT, '.git')) && 'realm-kit worktree not on this machine' }, () => {
  // Why: the coordination block forbids scratch, audit, benched or rejected art — only kit.json-referenced
  // assets. A typo'd id would silently drop a species; an off-kit id would ship unapproved art. Stage B: each new realm is
  // checked at the kit SHA its pack was built from (the owner-approved release), not at the round-1 pin where it did not exist.
  for (const realm of Object.keys(LIFE_TABLES)) {
    const kit = JSON.parse(execFileSync('git', ['-C', KIT, 'show', `${KIT_PINS[realm] ?? KIT_PIN}:art/realm-kit-v1/${realm}/kit.json`], { encoding: 'utf8' }));
    const ids = new Set([...kit.props.map(p => p.id), ...kit.sprites.map(s => s.id), ...kit.creatures.map(c => c.id)]);
    const t = LIFE_TABLES[realm], used = [
      ...t.groups.flatMap(g => g.species.map(s => s[0])), ...t.groups.flatMap(g => g.species.map(s => s[2]?.emit?.fx).filter(Boolean)),
      ...t.creatures.species.map(s => s[0]), ...t.birds.species.map(s => s[0]), ...t.ambience.filter(a => !a.shared).map(a => a.id),
      ...(t.stands?.mixes ?? []).flatMap(m => m.species.map(s => s[0]))];
    const bad = used.filter(id => !ids.has(id));
    assert.deepEqual(bad, [], `${realm}: ids not in kit.json`);
  }
});

// ---- 11. fine-speck ambience waits for close zoom; pack landmarks join the table -------------------------
test('ember and spark specks appear only from their minimum zoom, never as mid-zoom speckle', () => {
  // Why: an ember sprite is a cloud of 1–2-art-px specks; its overall extent passes the 6-px rule long before
  // the specks themselves are visible, which would read as flicker noise (the rubric's "no speckle").
  const L = compileLife('cinderfall', LIFE_TABLES.cinderfall, { sprite: () => ({ inkH: 25, w: 32, h: 32, frames: 3, frameMs: 200 }), creature: creatureStub });
  const at = d => planDraws(L, { x: 20, y: 20, d, W: 1280, H: 800, dpr: 1 }).ambience.map(e => e.a.id);
  assert.ok(!at(1500).includes('ember_drift') && !at(1500).includes('spark_rise'), 'no specks at d 1500');
  assert.ok(at(1500).includes('ash_devil'), 'large ambience still shows');
  assert.ok(at(1900).includes('ember_drift') && at(1900).includes('spark_rise'), 'specks from d 1800 on');
  const e = L.ambience.find(a => a.id === 'ember_drift');
  assert.ok(ambienceInk(e) * 1799 < 6 * DEED_ART && ambienceInk(e) * 1900 >= 6 * DEED_ART, 'the shader test (inkH·d ≥ 6·3136) switches at the same zoom');
});
test('the shared fx pack\'s tiny specks show at the 1:1 zoom as in the game, never below it', () => {
  // Why: T6 wants realm ambience (heat sparkle, ice motes, pollen from the shared fx pack) present; those sprites are
  // 3–5 art px, under the 6-px anti-speckle rule at every zoom below 1:1. At the pixel-snapped 1:1 zoom (d ≥ 3136)
  // they are exactly the in-game base's own sparkles; below it they would be the speckle the owner rejected.
  const L = compileLife('sunscar', LIFE_TABLES.sunscar, { sprite: id => (id === 'heat_sparkle' ? { inkH: 5, w: 5, h: 5, frames: 8, frameMs: 110 } : spriteStub(id)), creature: creatureStub });
  const at = d => planDraws(L, { x: 20, y: 20, d, W: 1280, H: 800, dpr: 1 }).ambience.map(e => e.a.id);
  assert.ok(!at(3000).includes('heat_sparkle') && !at(1900).includes('heat_sparkle'), 'no sparkle below 1:1');
  assert.ok(at(BANDS.snap).includes('heat_sparkle') && at(2 * BANDS.snap).includes('heat_sparkle'), 'sparkles at 1:1 and closer');
  assert.ok(at(BANDS.snap).includes('dust_devil') && at(900).includes('dust_devil'), 'large ambience keeps the plain 6-px rule');
});
test('hero landmarks the pack marks kind "landmark" join the landmark group without a code change', () => {
  // Why: ART's landmarks (D-164.2 map-only extras) arrive through PACK; LIFE must place them as soon as they ship.
  const meta = { sprites: { rects: { frozen_giant_gate: { kind: 'landmark' }, canopy_spruce: { kind: 'prop' } } } };
  const t = lifeTable('frostveil', meta), lm = t.groups.find(g => g.id === 'landmarks');
  assert.ok(lm.species.some(s => s[0] === 'frozen_giant_gate'));
  assert.ok(!lm.species.some(s => s[0] === 'canopy_spruce'));
  assert.equal(lifeTable('frostveil', {}), LIFE_TABLES.frostveil, 'no pack extras: the defaults unchanged');
  assert.ok(lm.species.some(s => s[0] === 'glacier_cliff'), 'kit set-piece landmarks stay');
});
test('map objects stand wholly on their role\'s classes, show across the MAP band and give way to TRUE', () => {
  // Why: a peak is "as big as the rock region it sits on" (§3.3); half a mountain over sand, or a massif
  // lingering over true-scale rocks at TRUE, breaks "the deed stays the ruler".
  const meta = { map: { objects: { map_peak_1: { w: 64, h: 64 }, map_dune_crest_1: { w: 64, h: 40 } } } };
  const t = lifeTable('sunscar', meta), mo = t.groups.find(g => g.id === 'mapobj');
  assert.deepEqual(mo.species.map(s => [s[0], s[2].on]), [['map_peak_1', ['ROCK', 'SNOW']], ['map_dune_crest_1', ['SPECIAL']]]);
  const L = compileLife('sunscar', t, { sprite: id => (id.startsWith('map_') ? { inkH: 45 * 7, w: 64 * 7, h: 64 * 7 } : spriteStub(id)), creature: creatureStub });
  const g = L.groups.find(g => g.id === 'mapobj');
  assert.equal(g.species[0].footR, 7, 'a 64-map-px object spans 14 tiles (footprint radius 7)');
  // rock blobs of 24 tiles on a sand field: every placed peak has its four footprint corners on rock
  const cls = (tx, ty) => (Math.floor(tx / 24) + Math.floor(ty / 24)) % 2 === 0 ? CLASS.ROCK : CLASS.WILD;
  let placed = 0, rejected = 0;
  for (let iy = 0; iy < 60; iy++) for (let ix = 0; ix < 60; ix++) {
    const i = scatterInstance(g, ix, iy, { classAt: cls, plotSdf: () => 1e9 });
    const free = scatterInstance(g, ix, iy, { classAt: tx => CLASS.ROCK, plotSdf: () => 1e9 });
    if (free && !i) rejected++;
    if (!i) continue; placed++;
    const tx = Math.floor(i.x / ART), ty = Math.floor(i.y / ART);
    for (const [dx, dy] of [[-7, -7], [7, -7], [-7, 0], [7, 0]]) assert.notEqual(cls(tx + dx, ty + dy), CLASS.WILD, 'footprint corner on sand');
    // lifecycle: a twin from the start of MAP (no 250–350 switch-in), gone once TRUE is full
    const lod = d => { const w = bandWeights(d); return instanceLod(g, i, d, w.true, w.twins); };
    assert.equal(lod(60), 'twin'); assert.equal(lod(700), 'twin'); assert.equal(lod(1100), 'none');
  }
  assert.ok(placed > 20 && rejected > 20, `placed ${placed}, rejected at sand edges ${rejected}`);
  // fix iteration 1 (T2 flat open land): a cell whose first pick cannot grow on its ground tries two more hashed picks, so
  // the rarer roles of a class (an oasis among 20 rock and dune masters) are not diluted away
  const many = Object.fromEntries([...Array(18)].map((_, i) => [`map_peak_${i + 1}`, { w: 64, h: 64 }]).concat([['map_oasis_pool_1', { w: 30, h: 20 }], ['map_oasis_pool_2', { w: 30, h: 20 }]]));
  const L2 = compileLife('sunscar', lifeTable('sunscar', { map: { objects: many } }), { sprite: id => (id.startsWith('map_') ? { inkH: 20 * 7, w: 30 * 7, h: 20 * 7 } : spriteStub(id)), creature: creatureStub });
  const g2 = L2.groups.find(g => g.id === 'mapobj'), sand = { classAt: () => CLASS.WILD, plotSdf: () => 1e9 };
  let dense = 0, oases = 0;
  for (let iy = 0; iy < 120; iy++) for (let ix = 0; ix < 120; ix++) {
    if ((cellHash(g2.salt, ix, iy).h1 & 0xffff) < g2.density[CLASS.WILD]) dense++;
    const i = scatterInstance(g2, ix, iy, sand);
    if (i) { oases++; assert.match(i.id, /oasis/, 'only a role that grows on sand stands on sand'); }
  }
  assert.ok(oases >= 0.2 * dense, `oases on sand: ${oases} of ${dense} dense cells (one pick alone gives 10 %)`);
  assert.ok(planDraws(L, { x: 5, y: 5, d: 60, W: 1280, H: 800, dpr: 1 }).groups.find(p => p.g.id === 'mapobj').count > 0, 'drawn at d 60');
  assert.equal(planDraws(L, { x: 5, y: 5, d: 1200, W: 1280, H: 800, dpr: 1 }).groups.find(p => p.g.id === 'mapobj').count, 0, 'not walked at TRUE');
  // every role ART ships (art-prep masters) has its classes: a new object must never fall back to "rock" silently
  const MAPKIT_OBJECTS = JSON.parse(readFileSync(new URL('./fixtures/mapkit-objects.json', import.meta.url), 'utf8')).realms;
  assert.deepEqual(Object.keys(MAPKIT_OBJECTS).sort(), Object.keys(LIFE_TABLES).sort(), 'the mapkit fixture covers every realm');
  for (const realm of Object.keys(LIFE_TABLES)) {
    const objs = MAPKIT_OBJECTS[realm]; // the concept read art-prep/realm/mapkit/<realm>/masters.json (fixtures/mapkit-objects.json)
    if (!objs) continue;
    const bad = objs.filter(o => !mapObjectRole(o.id, o)).map(o => `${o.id}:${o.role}`);
    assert.deepEqual(bad, [], `${realm}: map-object roles without classes`);
  }
});

// ---- 11b. Stage B: the three new realms (Elderwood, Thornwake, Solana Reach) on their real packs --------------------------
const PACKS = PACK_ROOT + 'realm';
/** The lookup life.mjs builds, from a real pack's realm.json (+ the shared fx pack): ink heights from PACK's `ink` boxes. */
function packLookup(realm) {
  const meta = JSON.parse(readFileSync(join(PACKS, realm, 'realm.json'), 'utf8')), fx = JSON.parse(readFileSync(join(PACKS, 'shared/fx.json'), 'utf8')).sprites;
  const R = meta.sprites.rects, O = meta.map?.objects ?? {}, cre = Object.fromEntries(meta.creatures.list.map(c => [c.id, c]));
  const sprite = id => {
    const r = R[id], o = O[id], f = fx[id];
    if (r) { const [x0, y0, x1, y1] = r.ink ?? [0, 0, r.w, r.h]; return { inkH: r.kind === 'air' ? Math.max(y1 - y0, x1 - x0) : y1 - y0, w: r.w, h: r.h, ax: r.ax, ay: r.ay, frames: r.frames ?? 1, frameMs: r.frameMs ?? 120 }; }
    if (o) return { inkH: (o.ink?.[1] ?? o.h) * 7, w: o.w * 7, h: o.h * 7, ax: 0, ay: 0, frames: 1, frameMs: 1000 };
    return f ? { inkH: Math.max(f.w, f.h), w: f.w, h: f.h, frames: f.frames, frameMs: f.frameMs } : null;
  };
  const creature = id => { const c = cre[id]; return c ? { inkH: 40, frames: c.frames, frameMs: c.frameMs, speed: c.speed, dwellMs: c.dwellMs, directions: c.directions, kind: c.kind } : null; };
  return { meta, sprite, creature };
}
const STAGE_B = ['elderwood', 'thornwake', 'seeker-reach'];
test('Stage B realms draw everything their packs carry: every LIFE id is in the pack, every map object has a role and a table slot', () => {
  // Why (Stage B): Elderwood, Thornwake and Solana Reach arrived with packs but no LIFE table (lifeTable() was null: no
  // scatter, creatures or ambience at all), their new map-object roles (giant tree, great stump, fern brake, fallen log,
  // root arch, the beacons and the gem-shard water) fell back to "rock only" (a giant tree could stand only on a crag, a
  // gem shoal never on water), and Solana Reach's 53 map objects overran the 32-species table row (21 silently never drew).
  for (const realm of STAGE_B) {
    const lk = packLookup(realm), L = compileLife(realm, lifeTable(realm, lk.meta), lk);
    assert.deepEqual(L.missing, [], `${realm}: LIFE ids the pack does not carry, or a row over the table`);
    const objs = Object.entries(lk.meta.map.objects);
    assert.deepEqual(objs.filter(([id, r]) => !mapObjectRole(id, r)).map(([id, r]) => `${id}:${r.role}`), [], `${realm}: map objects without a role`);
    const mo = L.groups.find(g => g.id === 'mapobj');
    assert.equal(mo.species.length, objs.length, `${realm}: every map object is placeable`);
    // every object can seat on a class the realm has (its land classes, the sea around it) that the group gives density to
    const has = new Set([...Object.keys(lk.meta.classShares), 'SEA']);
    for (const sp of mo.species) {
      const seats = Object.keys(CLASS).filter(c => has.has(c) && mo.density[CLASS[c]] > 0 && ((sp.on >>> CLASS[c]) & 1));
      assert.ok(seats.length, `${realm} ${sp.id}: none of its classes exists here with map-object density`);
    }
    for (const g of L.groups) for (const sp of g.species) if (sp.emit) assert.ok(lk.sprite(sp.emit.fx), `${realm} ${sp.id}: emitter ${sp.emit.fx} not in the pack`);
    assert.ok(L.creatures.species.length === 8 && L.birds.species.length >= 1 && L.ambience.length >= 3, `${realm}: creatures, birds and ambience all live`);
  }
  assert.ok(packLookup('seeker-reach').meta.map.objects && Object.keys(packLookup('seeker-reach').meta.map.objects).length > 32, 'the case the 32-species row dropped');
});
test('the gem-shard water seats on the SEA band, never on deep water, and a footprint may overhang it; land objects stay dry', () => {
  // Why (Stage B, Solana Reach): 16 of its 53 map objects are water (boats, buoys, shoals, gem shards, reef, islets, arch,
  // lanterns, whirl, quays). The realm has no SHORE class and GROUND's SEA band is 12 tiles wide (classify deepT), while a
  // 64-map-px object's footprint corners sit ±7 tiles out: SEA-only corners would never fit, and a DEEP seat would scatter
  // boats across the open ocean. So the seat needs SEA density (DEEP has none) and the corners may reach DEEP.
  const lk = packLookup('seeker-reach'), L = compileLife('seeker-reach', lifeTable('seeker-reach', lk.meta), lk), g = L.groups.find(g => g.id === 'mapobj');
  assert.equal(g.density[CLASS.DEEP], 0, 'no map object seats on deep water');
  const cls = tx => (tx < 40 ? CLASS.WILD : tx < 52 ? CLASS.SEA : CLASS.DEEP); // land | a 12-tile SEA band | the deep
  const water = new Set(['quay', 'boats', 'buoys', 'gem_shoal', 'gem_shards', 'crystal_reef', 'islets', 'sea_arch', 'lanterns', 'whirl']);
  let wet = 0, over = 0, dry = 0; const roles = new Set();
  for (let iy = 0; iy < 6400; iy++) for (let ix = 0; ix < 7; ix++) { // 6,400 rows of the band: every water role seats (the rarest 9×)
    const i = scatterInstance(g, ix, iy, { classAt: cls, plotSdf: () => 1e9 }); if (!i) continue;
    const role = mapObjectRole(i.id, lk.meta.map.objects[i.id]), tx = Math.floor(i.x / ART), c = cls(tx);
    assert.notEqual(c, CLASS.DEEP, `${i.id} seated on deep water`);
    if (water.has(role)) { assert.equal(c, CLASS.SEA, `${i.id} (water) seated on land`); wet++; roles.add(role); if (cls(tx + 7) === CLASS.DEEP || cls(tx - 7) === CLASS.DEEP) over++; }
    else { assert.equal(c, CLASS.WILD, `${i.id} (${role}) seated in the sea`); dry++; }
  }
  assert.ok(wet >= 10 && over >= 5 && dry >= 10, `water objects ${wet} (overhanging the deep ${over}), land objects ${dry}`);
  const ship = new Set(Object.entries(lk.meta.map.objects).map(([id, r]) => mapObjectRole(id, r)).filter(r => water.has(r)));
  assert.deepEqual([...ship].filter(r => !roles.has(r)).sort(), [], 'every water role ART ships finds a seat on the SEA band');
});
// The map objects whose ART carries falling water (critic-b1 contact sheets: Thornwake's massif 1–3, range 1 and waterfall 1;
// Solana Reach's waterfall 1; its massifs are dry). Read off the art here, not off the table under test.
const FALL_ART = { thornwake: ['map_massif_1', 'map_massif_2', 'map_massif_3', 'map_range_1', 'map_waterfall_1'], 'seeker-reach': ['map_waterfall_1'] };
test('falling water is rare and only by open water: a fall stands beside a lake, and plain rock carries the hills (Stage B fix pass)', () => {
  // Why (critic B1 #1, S/sb/cap2/thornwake-c150.png): every map object weighed 1, so 5 of Thornwake's 13 rock objects
  // put a waterfall on 28 % of its map objects (11.6 per 16 deeds on the real pack: dozens per screen on the hills), where
  // its kit has one, Mossy Falls. A fall far from any water reads as a repeated stamp; beside a lake it is a landmark.
  // Relief: rock (45-tile noise) and lakes (an independent 61-tile noise), so rock meets water far more often than on
  // either real realm (Thornwake 1.2 % water, rock ≥ 2 tiles from it): a strict field for the "by water" and cap rules.
  const cls = (tx, ty) => {
    const w = vnoise(tx, ty, 61, 41), n = vnoise(tx, ty, 45, 17);
    return w < -0.45 ? CLASS.WATER : n < -0.15 && w > -0.4 ? CLASS.ROCK : n > 0.35 ? CLASS.FOREST : CLASS.WILD;
  };
  const env = { classAt: cls, plotSdf: () => 1e9 }, deeds = 40, cells = Math.ceil(deeds * TILES / 15);
  const wet = (tx, ty, q) => [[q, 0], [-q, 0], [0, q], [0, -q]].some(([dx, dy]) => cls(tx + dx, ty + dy) <= CLASS.WATER);
  let land = 0, rockV = 0;
  for (let ty = 0; ty < deeds * TILES; ty += 7) for (let tx = 0; tx < deeds * TILES; tx += 7) { const c = cls(tx, ty); if (c > CLASS.WATER) land++; if (c === CLASS.ROCK) rockV++; }
  const landDeeds = land * 49 / (TILES * TILES), rockCells = rockV / land * landDeeds * (TILES / 15) ** 2;
  for (const realm of ['thornwake', 'seeker-reach']) {
    const lk = packLookup(realm), L = compileLife(realm, lifeTable(realm, lk.meta), lk), g = L.groups.find(g => g.id === 'mapobj');
    const falls = new Set(FALL_ART[realm]), byRole = {};
    let nFall = 0, rock = 0;
    for (let iy = 0; iy < cells; iy++) for (let ix = 0; ix < cells; ix++) {
      const i = scatterInstance(g, ix, iy, env); if (!i) continue;
      const tx = Math.floor(i.x / ART), ty = Math.floor(i.y / ART), sp = g.species[i.species];
      if (i.cls === CLASS.ROCK) { rock++; const r = mapObjectRole(i.id, lk.meta.map.objects[i.id]); byRole[r] = (byRole[r] ?? 0) + 1; }
      if (!falls.has(i.id)) continue;
      nFall++;
      assert.ok(wet(tx, ty, sp.footR + 3), `${realm} ${i.id} at (${tx}, ${ty}): a fall with no open water within ${sp.footR + 3} tiles`);
    }
    const per16 = nFall / landDeeds * 16;
    assert.ok(per16 <= 1, `${realm}: ${nFall} falls = ${per16.toFixed(2)} per 16 land deeds (the cap is 1)`);
    assert.ok(nFall <= 0.02 * rock, `${realm}: falls are ${(100 * nFall / rock).toFixed(1)} % of the rock's map objects`);
    // a rare fall costs the rock almost nothing: a fall picked away from water leaves its cell empty (0.34 / 0.30 per rock cell)
    assert.ok(rock >= 0.28 * rockCells, `${realm}: the rock still carries map objects (${rock} on ${Math.round(rockCells)} rock cells)`);
    if (realm === 'thornwake') { // the bulk: peaks, hills, crags and the spire
      const plain = ['peak', 'hill', 'crag', 'spire'].reduce((a, r) => a + (byRole[r] ?? 0), 0);
      assert.ok(plain >= 0.9 * rock, `thornwake: peaks, hills, crags and spires are ${(100 * plain / rock).toFixed(0)} % of rock objects`);
    } else { // Solana Reach's terraced violet mesas (3–6) read on its rock (18 % of its rock objects when every object weighed 1)
      const terr = Object.entries(byRole).filter(([r]) => r === 'mesa').reduce((a, [, n]) => a + n, 0);
      assert.ok(terr >= 0.22 * rock, `seeker-reach: mesas are ${(100 * terr / rock).toFixed(0)} % of rock objects`);
    }
  }
});
test('Solana Reach\'s crystal woods stand in groves with open reachstone between at MAP, never an even speckle (Stage B fix pass)', () => {
  // Why (critic B1 #2, S/sb/cap2/seeker-reach-c80.png / c150.png): the kit's groves and shard fields are zones (blobs 3–16
  // tiles) with open reachstone between, but its stand ramp covered ~3/4 of the land and the rock-field mixes filled the
  // gaps: 54 % of MAP's merged 2×2 blocks (16 tiles, one clump each from d 60) drew a clump, spread MORE evenly than chance
  // (48-tile window variance/mean 0.89), a violet speckle over the whole realm. Crownlands' woods may be even: they are woods.
  const env = { classAt: () => CLASS.WILD, plotSdf: () => 1e9 }, N = 72;
  const blocks = realm => {
    const S = compileLife(realm, LIFE_TABLES[realm], lookup).stands, occ = new Uint8Array(N * N);
    for (let by = 0; by < N; by++) for (let bx = 0; bx < N; bx++) if (mergedSite(S, bx, by, env)) occ[by * N + bx] = 1;
    const win = [];
    for (let wy = 0; wy + 3 <= N; wy += 3) for (let wx = 0; wx + 3 <= N; wx += 3) { let c = 0; for (let j = 0; j < 9; j++) c += occ[(wy + Math.floor(j / 3)) * N + wx + (j % 3)]; win.push(c); }
    const mean = win.reduce((a, b) => a + b, 0) / win.length, v = win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length;
    return { occ: occ.reduce((a, b) => a + b, 0) / (N * N), vm: v / mean, empty: win.filter(c => c === 0).length / win.length };
  };
  const sr = blocks('seeker-reach'), cr = blocks('crownlands'), f = x => x.toFixed(3);
  assert.ok(sr.occ <= 0.45 && sr.occ <= 0.7 * cr.occ, `Solana Reach draws a merged clump in ${f(sr.occ)} of blocks (Crownlands ${f(cr.occ)})`);
  assert.ok(sr.vm >= 1.3, `Solana Reach's clumps come in groves: window variance/mean ${f(sr.vm)} (≤ 1 is an even sprinkle)`);
  assert.ok(sr.empty >= 0.06, `open reachstone between them: ${f(sr.empty)} of 48-tile windows hold no clump`);
});

// ---- 12. round 2: the in-game home view's composition (T1) and stands that resolve in place (T2) -----------
/** Every realm on an all-WILD field with claimed plots on a 2-deed checker: props per tile² by plot distance. */
function densityByPlotDistance(realm) {
  const cols = 12, rows = 12, bases = []; // 25 plots: an 8×8 fixture (9 plots) left 'open' to one noise cell's luck
  for (let y = 1; y < rows - 1; y += 2) for (let x = 1; x < cols - 1; x += 2) bases.push([x, y, 1 + ((x * 7 + y * 3) % 20)]);
  const state = baseState(cols, rows, bases), sdf = (x, y) => plotSdfAt(state, x, y);
  const env = { classAt: () => CLASS.WILD, plotSdf: sdf }, L = compileLife(realm, LIFE_TABLES[realm], lookup);
  const bin = s => (s < PLOT_CLEAR ? 'inside' : s < 12 ? 'edge' : s < 24 ? 'mid' : 'open'), n = { inside: 0, edge: 0, mid: 0, open: 0 }, a = { ...n };
  const add = (x, y) => n[bin(sdf(x / ART, y / ART))]++, all = { x0: 0, y0: 0, x1: cols * DEED_ART, y1: rows * DEED_ART };
  const S = L.stands, W = latticeWindow(S.pitchArt, all, 0);
  for (let iy = W.iy0; iy < W.iy0 + W.ny; iy++) for (let ix = W.ix0; ix < W.ix0 + W.nx; ix++) {
    const site = standSite(S, ix, iy, env);
    if (site) for (let m = 0; m < STAND.members; m++) { const mm = standMember(S, site, m, env); if (mm) add(mm.x, mm.y); }
  }
  for (const g of L.groups.filter(g => g.pitch <= 7)) {
    const W2 = latticeWindow(g.pitchArt, all, 0);
    for (let iy = W2.iy0; iy < W2.iy0 + W2.ny; iy++) for (let ix = W2.ix0; ix < W2.ix0 + W2.nx; ix++) { const i = scatterInstance(g, ix, iy, env); if (i) add(i.x, i.y); }
  }
  for (let ty = 0; ty < rows * TILES; ty += 2) for (let tx = 0; tx < cols * TILES; tx += 2) a[bin(sdf(tx + 1, ty + 1))] += 4;
  return Object.fromEntries(Object.keys(n).map(k => [k, n[k] / Math.max(1, a[k])]));
}
test('plots are framed like the in-game home view: dense edges, open land with gaps, nothing in the clearance', () => {
  // Why: the owner's bar is the in-game base screenshots — the clearing framed by dense trees and rocks, not an
  // even sprinkling of polka dots (round-2 T1: "sparse against the in-game view" failed Gate A2). The reference
  // home views measure ≈ 0.09–0.12 props per tile² around the frame; the plots stay the bases' ground.
  for (const realm of Object.keys(LIFE_TABLES)) {
    const d = densityByPlotDistance(realm);
    assert.equal(d.inside, 0, `${realm}: something grows inside a plot's clearance`);
    assert.ok(d.edge >= 0.075, `${realm}: clearing edge ${d.edge.toFixed(3)}/t² is sparser than the home view`);
    assert.ok(d.edge >= 1.25 * d.open, `${realm}: the edge (${d.edge.toFixed(3)}) is not thicker than the open land (${d.open.toFixed(3)})`);
    assert.ok(d.open >= 0.035, `${realm}: open land ${d.open.toFixed(3)}/t² reads empty`);
  }
  // the edge weight: −1 inside the clearance, full for edgeFlat tiles, then falling to 0
  assert.equal(edgeWeight(1.9, 2), -1); assert.equal(edgeWeight(2, 2), 255); assert.equal(edgeWeight(2 + STAND.edgeFlat - 0.01, 2), 255);
  assert.equal(edgeWeight(2 + STAND.edgeFlat + STAND.edgeTiles, 2), 0); assert.equal(edgeWeight(1e4, 2), 0);
});
test('the new realms keep their home views\' character: Elderwood and Thornwake framed thicker than Crownlands, Solana Reach more open', () => {
  // Why (Stage B, read against the realm-kit screenshots): Elderwood's glades and Thornwake's jungle clearing are
  // walled by denser woods than the Crownlands home view (kit groves at spacing 1.6, density 100), while Solana Reach's
  // crystal groves stand apart (kit grove spacing 3.2) with open reachstone between. A table that loses that character
  // (a thinned Elderwood, a Solana as full as a forest) would pass the generic framing test and still miss the owner's bar.
  const cr = densityByPlotDistance('crownlands'), ew = densityByPlotDistance('elderwood'), tw = densityByPlotDistance('thornwake'), sr = densityByPlotDistance('seeker-reach');
  assert.ok(ew.edge > 1.2 * cr.edge && tw.edge > 1.1 * cr.edge, `edges: Elderwood ${ew.edge.toFixed(3)}, Thornwake ${tw.edge.toFixed(3)} vs Crownlands ${cr.edge.toFixed(3)}`);
  assert.ok(ew.open > cr.open && tw.open > cr.open, 'their open land is wooded too (the glades between stands)');
  assert.ok(sr.open < 0.9 * cr.open && sr.edge < cr.edge, `Solana Reach open ${sr.open.toFixed(3)} / edge ${sr.edge.toFixed(3)} vs Crownlands ${cr.open.toFixed(3)} / ${cr.edge.toFixed(3)}`);
  const grovePitch = r => LIFE_TABLES[r].groups.find(g => g.id === 'grove').pitch;
  assert.ok(grovePitch('seeker-reach') >= 1.4 * grovePitch('crownlands'), 'Solana Reach\'s crystal woods are open woods');
});
test('vegetation comes in stands and gaps, never a lattice of dots: 16-tile block counts are over-dispersed', () => {
  // Why: T1/T2 "no lattice repetition, no speckle": evenly spaced props read as polka dots at every zoom. A clumped
  // field has a variance/mean of block counts well above 1 (a Poisson sprinkle is ≈ 1, a lattice < 1).
  const env = { classAt: () => CLASS.WILD, plotSdf: () => 1e9 };
  for (const realm of ['sunscar', 'frostveil', 'crownlands']) {
    const L = compileLife(realm, LIFE_TABLES[realm], lookup), S = L.stands, B = 16, NB = 24, cnt = new Array(NB * NB).fill(0);
    const add = (x, y) => { const bx = Math.floor(x / ART / B), by = Math.floor(y / ART / B); if (bx >= 0 && by >= 0 && bx < NB && by < NB) cnt[by * NB + bx]++; };
    const n = NB * B / STAND.pitch;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
      const site = standSite(S, ix, iy, env);
      if (site) for (let m = 0; m < STAND.members; m++) { const mm = standMember(S, site, m, env); if (mm) add(mm.x, mm.y); }
    }
    const mean = cnt.reduce((a, b) => a + b, 0) / cnt.length, v = cnt.reduce((a, b) => a + (b - mean) ** 2, 0) / cnt.length;
    assert.ok(mean > 2, `${realm}: stands exist (${mean.toFixed(2)} trees per block)`);
    assert.ok(v / mean > 2, `${realm}: stands clump (variance/mean ${(v / mean).toFixed(2)})`);
    assert.ok(cnt.filter(c => c === 0).length > cnt.length * 0.1, `${realm}: there are gaps`);
  }
});
test('stands resolve in place: the MAP clump and the TRUE members are one layout with one switch per stand', () => {
  // Why: T2 "world-anchored determinism so MAP↔TRUE instance positions agree": the clump is composed from the very
  // members TRUE draws (life.mjs composeStands), so members must be the variant's offsets from the stand seat
  // (mirrored with it), independent of d, and a stand is either a clump or its trees — never both, never moving.
  const L = compileLife('cinderfall', LIFE_TABLES.cinderfall, lookup), S = L.stands, env = { classAt: () => CLASS.WILD, plotSdf: () => 1e9 };
  const sites = [];
  for (let iy = 0; iy < 40; iy++) for (let ix = 0; ix < 40; ix++) { const s = standSite(S, ix, iy, env); if (s) sites.push(s); }
  assert.ok(sites.length > 150, `stands placed (${sites.length})`);
  for (const s of sites) {
    const V = S.variants[s.v];
    assert.ok(V.members.length >= 1 && V.members.length <= STAND.members);
    V.members.forEach((mv, m) => {
      const mm = standMember(S, s, m, env);
      assert.deepEqual([mm.x, mm.y], [s.x + (s.flip ? -mv.dx : mv.dx), s.y + mv.dy], 'a member stands where the clump drew it');
      assert.equal(mm.flip, s.flip ^ mv.flip);
    });
    let wasTrue = false;
    for (let d = 120; d <= 1400; d *= 1.05) {
      const lod = standLod(S, s, d, bandWeights(d).true);
      // fix iteration 1: own clumps from the merged hand-over on, at the 6-px rule (the merged LOD carries low MAP)
      if (lod === 'clump') assert.ok(V.inkH * d >= MIN_SPRITE_PX * DEED_ART && d >= STAND.splitFrom && d < BANDS.trueFull, 'a clump only at MAP and ≥ 6 px');
      if (wasTrue) assert.equal(lod, 'true', 'once resolved, a stand stays resolved while zooming in');
      wasTrue ||= lod === 'true';
    }
    assert.equal(standLod(S, s, 1100, 1), 'true');
  }
  const half = sites.filter(s => standLod(S, s, 950, bandWeights(950).true) === 'true').length / sites.length;
  assert.ok(half > 0.3 && half < 0.7, `about half the stands resolved half-way through the fade (${half.toFixed(2)})`);
});
test('woods, groves and outcrops read as objects from d 60: a merged clump per 2×2 block hands over to its own stands in place', () => {
  // Why (GA2 fix iteration 1, T2): at d 48–170 the MAP read as flat colour fields because stand clumps waited for 10 px
  // at d 170. A merged clump (the block's first stand, drawn 2×) shows from d 60. Its leader IS a lattice stand, so the
  // hand-over is in place: per block exactly one of merged / own clump once the own clump passes 6 px, never both,
  // never a blink; and the doubled clump still clears plots and stays on its mix's ground.
  const cols = 6, rows = 6, state = baseState(cols, rows, [[1, 1, 5], [4, 2, 12], [2, 4, 20]]), cls = classField(7);
  const env = { classAt: cls, plotSdf: (x, y) => plotSdfAt(state, x, y) };
  for (const realm of ['sunscar', 'stormcairn']) {
    const L = compileLife(realm, LIFE_TABLES[realm], lookup), S = L.stands, nb = cols * TILES / STAND.pitch / 2;
    let blocks = 0, merged = 0;
    for (let by = 0; by < nb; by++) for (let bx = 0; bx < nb; bx++) {
      blocks++;
      const m = mergedSite(S, bx, by, env);
      if (!m) continue; merged++;
      const own = standSite(S, m.ix, m.iy, env);
      assert.deepEqual([own.x, own.y, own.v], [m.x, m.y, m.v], 'the merged clump is its leader stand, where zooming in keeps it');
      assert.ok(m.ix >> 1 === bx && m.iy >> 1 === by);
      const V = S.variants[m.v], R2 = ((V.R4 + 3) >> 2) * STAND.merge;
      assert.ok(plotSdfAt(state, m.x / ART, m.y / ART) >= PLOT_CLEAR + R2, 'a doubled clump never reaches into a plot');
      for (let d = 40; d < 1400; d *= 1.04) {
        const a = mergedLod(S, m, d) === 'merged', b = standLod(S, m, d, bandWeights(d).true) === 'clump';
        assert.ok(!(a && b), `${realm} d ${d.toFixed(0)}: merged and own clump both drawn`);
        if (a) assert.ok(d >= STAND.mergeFrom && V.inkH * STAND.merge * d >= MIN_SPRITE_PX * DEED_ART, 'merged only from d 60 and ≥ 6 px');
        if (d >= STAND.mergeFrom && d < BANDS.trueStart && V.inkH * d >= MIN_SPRITE_PX * DEED_ART) assert.ok(a || b, `${realm} d ${d.toFixed(0)}: the leader blinked out`);
      }
    }
    assert.ok(merged > 0.25 * blocks, `${realm}: merged clumps in ${merged} of ${blocks} blocks`);
  }
});
test('forests read as woods across MAP: a map-only canopy of the grove\'s trees fills FOREST and gives way to them at TRUE', () => {
  // Why (GA2 fix iteration 1): FOREST was a flat saturated block from d 48 to 800. The canopy clumps are the grove's own
  // species, so MAP→TRUE keeps the same trees; at TRUE the canopy draws nothing, never doubling the grove.
  const env = { classAt: () => CLASS.FOREST, plotSdf: () => 1e9 };
  for (const realm of Object.keys(LIFE_TABLES)) {
    const mix = withCanopy(LIFE_TABLES[realm]).mixes.find(m => m.id === 'canopy');
    const grove = LIFE_TABLES[realm].groups.find(g => g.id === 'grove');
    assert.ok(mix?.mapOnly, `${realm}: FOREST has a map-only canopy`);
    assert.deepEqual(mix.species.map(s => s[0]), grove.species.map(s => s[0]), `${realm}: the canopy is the grove's own trees`);
    const L = compileLife(realm, LIFE_TABLES[realm], lookup), S = L.stands;
    let sites = 0, blocks = 0;
    for (let iy = 0; iy < 24; iy++) for (let ix = 0; ix < 24; ix++) {
      const s = standSite(S, ix, iy, env); if (!s) continue; sites++;
      assert.equal(standMember(S, s, 0, env), null, 'no TRUE members: the grove group draws the forest at TRUE');
      assert.equal(standLod(S, s, 1100, 1), 'none');
    }
    for (let by = 0; by < 12; by++) for (let bx = 0; bx < 12; bx++) if (mergedSite(S, bx, by, env)) blocks++;
    assert.ok(sites > 0.5 * 576, `${realm}: canopy stands in ${sites} of 576 forest cells`);
    assert.ok(blocks > 0.9 * 144, `${realm}: merged canopy in ${blocks} of 144 forest blocks`);
  }
});
test('every species of every realm reaches the GPU: no LIFE table row holds more species than the shader table', () => {
  // Why (found by the fix-iteration-1 GPU parity readback): the table held 16 species per row, but the stands union
  // 19–24 species and ART ships 20 map objects per realm, so the 17th+ (boulders, peaks, oases) read past the row on the
  // GPU and silently never drew. Every compiled row must fit MAX_SPECIES; an overflow is listed, never dropped quietly.
  const objs = Object.fromEntries([...Array(20)].map((_, i) => [`map_peak_${i + 1}`, { w: 64, h: 64 }]));
  for (const realm of Object.keys(LIFE_TABLES)) {
    const L = compileLife(realm, lifeTable(realm, { map: { objects: objs } }), { sprite: id => (id.startsWith('map_') ? { inkH: 400, w: 448, h: 448 } : spriteStub(id)), creature: creatureStub });
    for (const g of L.groups) assert.ok(g.species.length <= MAX_SPECIES, `${realm} ${g.id}: ${g.species.length} species`);
    assert.ok(L.stands.species.length <= MAX_SPECIES, `${realm} stands: ${L.stands.species.length} species`);
    assert.equal(L.groups.find(g => g.id === 'mapobj').species.length, 20, `${realm}: all 20 map objects are placeable`);
    assert.ok(!L.missing.some(m => /over \d+ (stand )?species/.test(m)), `${realm}: nothing over the table (${L.missing.join(', ')})`);
  }
  const g = compileGroup('sunscar', { id: 'x', pitch: 4, density: { WILD: 1 }, species: [...Array(MAX_SPECIES + 2)].map((_, i) => [`s${i}`, 1]) }, () => ({ inkH: 40, w: 64, h: 64 }));
  assert.equal(g.species.length, MAX_SPECIES); assert.equal(g.missing.length, 2, 'the overflow is listed, not silently read past the row');
});
test('no stand straddles water or a foreign class: every stand stands whole on its mix\'s ground', () => {
  // Why: "no half-wood in a lake" — a clump drawn over a river bank at MAP would become trees standing in water at TRUE.
  const L = compileLife('frostveil', LIFE_TABLES.frostveil, lookup), S = L.stands;
  const cls = (tx, ty) => ((Math.floor(tx / 13) * 7 + Math.floor(ty / 11) * 3) % 5 === 0 ? CLASS.WATER : CLASS.WILD);
  let placed = 0, cut = 0;
  for (let iy = 0; iy < 60; iy++) for (let ix = 0; ix < 60; ix++) {
    const s = standSite(S, ix, iy, { classAt: cls, plotSdf: () => 1e9 }), free = standSite(S, ix, iy, { classAt: () => CLASS.WILD, plotSdf: () => 1e9 });
    if (free && !s) cut++;
    if (!s) continue; placed++;
    const mix = S.mixes[S.variants[s.v].mix], R = (S.variants[s.v].R4 + 3) >> 2, tx = s.x >> 5, ty = s.y >> 5;
    for (const [dx, dy] of [[R, 0], [-R, 0], [0, R], [0, -R]]) assert.ok(mix.density[cls(tx + dx, ty + dy)] > 0, 'compass point in water');
    S.variants[s.v].members.forEach((_, m) => { const mm = standMember(S, s, m, { classAt: cls, plotSdf: () => 1e9 }); if (mm) assert.notEqual(cls(mm.x >> 5, mm.y >> 5), CLASS.WATER); });
  }
  assert.ok(placed > 100 && cut > 50, `placed ${placed}, cut at lake shores ${cut}`);
});
test('woods read as stands of one species: the dominant species of an 8-tile cluster cell holds most of its trees', () => {
  // Why: the kit's groves prefer one species per 8-tile cluster (clusterWeight 0.9) — "stands of oak and stands of
  // pine rather than salt-and-pepper"; a uniform species mix is the speckle the owner rejected.
  const L = compileLife('crownlands', LIFE_TABLES.crownlands, lookup), g = L.groups.find(g => g.id === 'grove'), env = { classAt: () => CLASS.FOREST, plotSdf: () => 1e9 };
  const cells = new Map();
  for (let iy = 0; iy < 96; iy++) for (let ix = 0; ix < 96; ix++) {
    const i = scatterInstance(g, ix, iy, env); if (!i) continue;
    const k = `${i.x >> 8},${i.y >> 8}`, c = cells.get(k) ?? new Map(); c.set(i.species, (c.get(i.species) ?? 0) + 1); cells.set(k, c);
  }
  let top = 0, all = 0;
  for (const c of cells.values()) { const v = [...c.values()]; top += Math.max(...v); all += v.reduce((a, b) => a + b, 0); }
  assert.ok(all > 1000 && top / all >= 0.6, `dominant share ${(top / all).toFixed(2)} of ${all}`);
  assert.equal(clusterPick(g.salt, 300, 300), clusterPick(g.salt, 511, 257), 'one pick per 8-tile cell');
});
test('a tree seen at map scale keeps its canopy colours, never its outline (the black-grove defect)', () => {
  // Why: Gate A2 GA2-02 — near-black groves pop against the painting. The clump art reduces kit sprites 7×; a block
  // must take an existing mid-tone of the sprite, not the 1-px dark outline and not an averaged mud colour.
  const w = 35, h = 35, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - 17, y - 17), q = (y * w + x) * 4; if (r > 16) continue;
    const edge = r > 14.5, c = edge ? [20, 18, 12] : (x + y) % 3 ? [60, 120, 50] : [90, 160, 70];
    data.set([...c, 255], q);
  }
  const m = reduceMap({ img: { data, width: w, height: h }, x: 0, y: 0, w, h, ax: 17.5, ay: 35 });
  const src = new Set(); for (let q = 0; q < data.length; q += 4) if (data[q + 3]) src.add(`${data[q]},${data[q + 1]},${data[q + 2]}`);
  let dark = 0, n = 0;
  for (let q = 0; q < m.img.data.length; q += 4) {
    if (!m.img.data[q + 3]) continue; n++;
    assert.ok(src.has(`${m.img.data[q]},${m.img.data[q + 1]},${m.img.data[q + 2]}`), 'only colours of the sprite');
    if (m.img.data[q + 1] < 40) dark++;
  }
  assert.ok(n >= 12 && dark === 0, `${n} opaque map px, ${dark} outline-dark`);
  assert.ok(Number.isInteger(m.ax) && Number.isInteger(m.ay), 'the anchor lands on a map pixel (members keep their seats)');
});

// ---- GPU-hang guard (fix iteration 2, P0) ----------------------------------------------------------------
const glslCode = src => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
/** The GLSL preprocessor's #ifdef / #ifndef / #else / #endif over `defines` (what the driver compiles). */
function ifdefs(src, defines) {
  const out = [], on = [true];
  for (const line of src.split('\n')) {
    const m = /^\s*#(ifdef|ifndef|else|endif)\b\s*(\w*)/.exec(line);
    if (!m) { if (on.every(Boolean)) out.push(line); continue; }
    if (m[1] === 'ifdef') on.push(m[2] in defines); else if (m[1] === 'ifndef') on.push(!(m[2] in defines));
    else if (m[1] === 'else') on.push(!on.pop()); else on.pop();
  }
  assert.equal(on.length, 1, 'balanced #ifdef / #endif');
  return out.join('\n');
}
/** Every LIFE program as life.mjs creates it: { name, vs, fs, defines } (a new program is walked without a test edit). */
function lifePrograms() {
  const src = readFileSync(new URL('./life.mjs', import.meta.url), 'utf8'), ids = { ...SPRITES_GLSL, ...AIR_GLSL }, out = [];
  for (const m of src.matchAll(/core\.program\('([\w-]+)',\s*\{\s*vs:\s*(\w+),\s*fs:\s*(\w+),\s*defines:\s*\{([^}]*)\}\s*\}\)/g)) {
    const defines = Object.fromEntries([...m[4].matchAll(/(\w+)\s*:\s*(\w+)/g)].map(d => [d[1], d[2]]));
    assert.ok(typeof ids[m[2]] === 'string' && typeof ids[m[3]] === 'string', `${m[1]}: shader ids ${m[2]} / ${m[3]} resolve`);
    out.push({ name: m[1], vs: ids[m[2]], fs: ids[m[3]], defines });
  }
  assert.equal(out.length, (src.match(/core\.program\(/g) ?? []).length, 'every core.program call in life.mjs parsed');
  return out;
}
test('LIFE shaders cannot spin the GPU: every loop has a literal bound ≤ 32, no while / do loops', () => {
  // Why: on 2026-09-24 the realm map froze the owner's whole Mac (every GPU process). A shader loop whose trip
  // count comes from data (a segment list, an overflowed uint) runs per vertex or pixel with no timeout on a real GPU.
  // Every LIFE loop must stop at a compile-time constant however garbled its inputs are; data may only break early.
  const srcs = { ...SPRITES_GLSL, ...AIR_GLSL };
  let loops = 0;
  for (const [name, src] of Object.entries(srcs)) {
    if (typeof src !== 'string') continue;
    const code = glslCode(src);
    assert.ok(!/\bwhile\b|\bdo\s*\{/.test(code), `${name}: a while / do loop (its trip count is data-driven)`);
    for (const m of code.matchAll(/\bfor\s*\(([^)]*)\)/g)) {
      const b = /^\s*int\s+(\w+)\s*=\s*-?\d+\s*;\s*(\w+)\s*(<|<=)\s*(\d+)\s*;\s*(\w+)\+\+\s*$/.exec(m[1]);
      assert.ok(b && b[1] === b[2] && b[1] === b[5], `${name}: loop "for (${m[1]})" has no literal bound`);
      assert.ok(+b[4] <= 32, `${name}: loop bound ${b[4]} > 32`);
      loops++;
    }
  }
  assert.ok(loops >= 11, `${loops} loops checked (the scan found the LIFE shaders' loops)`);
});

test('LIFE never inlines GROUND\'s classifier: every class read samples baked classes, on GROUND and on SHELL\'s stub', async () => {
  // Why: GROUND's §3.2 classifier is by far the heaviest code a LIFE shader could compile in. Measured on SwiftShader
  // (fix iteration 2): one copy in a trivial shader took ~4 s to compile and draw; the SCATTER program with 3 inlined
  // copies had not linked after 240 s, and every lane's capture paid that for 5 LIFE programs; a real GPU links them at
  // load. The orchestrator's P0 decision: the classifier runs only in GROUND's resolve / bake passes, and display
  // shaders only SAMPLE its results (the TRUE page record, the MAP lattice). And when GROUND is disabled, SHELL's
  // CLASSES_STUB replaces "classes"; every GROUND function LIFE reaches must exist there too, or trees, herds and birds
  // vanish with the ground (a lane failure must never take another lane down, plan §10).
  const G = await import('./glsl/classes.glsl.mjs'), Co = await import('./glsl/common.glsl.mjs');
  const inc = new Map([['common', Co.COMMON], ['rm-fields', G.RM_FIELDS], ['rm-classify', G.RM_CLASSIFY], ['classes', G.CLASSES], ['life', SPRITES_GLSL.LIFE]]);
  const resolve = (src, seen = new Set()) => src.replace(/^[ \t]*#include[ \t]+"([\w.-]+)"[ \t]*$/gm, (_, n) => {
    assert.ok(inc.has(n), `unknown include ${n}`); if (seen.has(n)) return ''; seen.add(n); return resolve(inc.get(n), seen); });
  // function name → body (top-level definitions only; GLSL has no nested functions)
  const bodies = code => {
    const out = new Map(), re = /^[ \t]*(?:highp |mediump |lowp )?[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm; let m;
    while ((m = re.exec(code))) {
      if (['if', 'for', 'while', 'switch', 'return', 'else'].includes(m[1])) continue;
      let i = re.lastIndex, depth = 1; while (depth && i < code.length) { if (code[i] === '{') depth++; else if (code[i] === '}') depth--; i++; }
      out.set(m[1], (out.get(m[1]) ?? '') + code.slice(re.lastIndex, i));
    }
    return out;
  };
  const calls = (s, f) => new RegExp(`\\b${f}\\s*\\(`).test(s);
  const reach = code => { // every function main() can reach
    const F = bodies(code), seen = new Set(), todo = ['main'];
    while (todo.length) { const f = todo.pop(); if (seen.has(f) || !F.has(f)) continue; seen.add(f); for (const g of F.keys()) if (g !== f && calls(F.get(f), g)) todo.push(g); }
    return seen;
  };
  const classifier = new Set([...bodies(glslCode(G.RM_CLASSIFY)).keys(), 'classAtTile', 'walkable']);
  assert.ok(['rmClassAt', 'rmClassCore', 'rmStroke', 'classAtTile'].every(f => classifier.has(f)), 'the forbidden set holds GROUND\'s classifier');
  const groundFns = new Set([...bodies(glslCode(G.RM_FIELDS)).keys(), ...bodies(glslCode(G.RM_CLASSIFY)).keys(), ...bodies(glslCode(G.CLASSES)).keys()]);
  const stub = /const CLASSES_STUB = `([\s\S]*?)`;/.exec(readFileSync(new URL('./map.mjs', import.meta.url), 'utf8'))?.[1];
  assert.ok(stub, 'SHELL\'s CLASSES_STUB found in map.mjs');
  const stubFns = new Set(bodies(glslCode(stub)).keys());
  // every stage of every program life.mjs creates, preprocessed with its defines (P0 fix pass: STAND is two programs)
  const progs = Object.fromEntries(lifePrograms().flatMap(P => [[`${P.name} VS`, [P.vs, { ...P.defines, REALM_VS: 1 }]], [`${P.name} FS`, [P.fs, { ...P.defines, REALM_FS: 1 }]]]));
  const stageCode = ([src, defs]) => glslCode(ifdefs(resolve(src.replace(/^\s*#version[^\n]*\n/, '')), defs));
  let classReads = 0, stubChecks = 0;
  for (const [name, stage] of Object.entries(progs)) {
    const src = stage[0], code = stageCode(stage);
    const r = reach(code);
    assert.ok(r.has('main'), `${name}: main found`);
    const bad = [...r].filter(f => classifier.has(f));
    assert.deepEqual(bad, [], `${name} reaches GROUND's classifier (${bad.join(', ')}): sample the record / lattice instead`);
    if (r.has('lifeClass')) classReads++;
    // LIFE's own code (the program and the "life" include, without GROUND's): every GROUND function it calls is in the stub
    const own = glslCode(src + (/#include "life"/.test(src) ? SPRITES_GLSL.LIFE : '')).replace(/#include[^\n]*/g, '');
    for (const f of groundFns) if (calls(own, f) && !bodies(own).has(f)) { assert.ok(stubFns.has(f), `${name} calls ${f}, which SHELL's stub lacks`); stubChecks++; }
  }
  assert.equal(classReads, 6, 'the 6 LIFE vertex programs read classes through lifeClass');
  assert.ok(stubChecks >= 15, `${stubChecks} stub-side calls checked`);
  // lifeClass itself: only the sampled lookups, which both GROUND and the stub define
  const lc = bodies(glslCode(SPRITES_GLSL.LIFE)).get('lifeClass');
  assert.ok(lc, 'lifeClass found in the "life" include');
  const used = [...groundFns, ...stubFns].filter(f => calls(lc, f));
  assert.deepEqual([...new Set(used)].sort(), ['mapClassAt', 'pageResident', 'tileRecord'], 'lifeClass samples only');
  for (const f of used) { assert.ok(stubFns.has(f), `the stub defines ${f}`); assert.ok(groundFns.has(f), `GROUND defines ${f}`); }
  assert.ok(!/#ifdef|#if\b/.test(lc), 'one rule for GROUND and the stub');
  assert.match(lc.replace(/\s+/g, ' '), /if \(uTrueCls != 0 && pageResident\(ivec2\(floorDiv\(t\.x, DEED_TILES\), floorDiv\(t\.y, DEED_TILES\)\)\)\) return tileRecord\(t\)\.w & 15u; return mapClassAt\(t\);/,
    'the TRUE record where GROUND guarantees it (uTrueCls), else the MAP lattice');
  // P0 finish: a placement's seat reads GROUND's sampled near-water class (mapClassFine), so a MAP tree, clump or herd is
  // never seated in a river narrower than the 7-t lattice (0.10–0.28 % of lattice-land tiles were exact water, 0 with
  // it). It is 10 fetches near water and ~0.4–1.2 s of SwiftShader pipeline JIT per inlined copy (every read fine took
  // LIFE from 11 s to 31 s of JIT, STAND alone 4 s → 14 s), so it is read once per placement: ≤ 2 inlined copies per
  // program, and the probes keep the 1-fetch lattice. Since the P0 fix pass each stand program inlines standSite once
  // (life-stand directly, life-stand-merged through mergedSite), so each has 1 seat read, not STAND's former 2.
  const ls = bodies(glslCode(SPRITES_GLSL.LIFE)).get('lifeClassSeat');
  assert.ok(ls, 'lifeClassSeat found in the "life" include');
  assert.deepEqual([...new Set([...groundFns, ...stubFns].filter(f => calls(ls, f)))].sort(), ['mapClassFine', 'pageResident', 'tileRecord'], 'lifeClassSeat samples only');
  assert.ok(stubFns.has('mapClassFine') && groundFns.has('mapClassFine'), 'GROUND and the stub both define mapClassFine');
  assert.match(ls.replace(/\s+/g, ' '), /if \(uTrueCls != 0 && pageResident\(ivec2\(floorDiv\(t\.x, DEED_TILES\), floorDiv\(t\.y, DEED_TILES\)\)\)\) return tileRecord\(t\)\.w & 15u; return mapClassFine\(t\);/,
    'the seat: the same TRUE rule, else the sampled near-water class');
  const sites = (s, f) => (s.match(new RegExp(`\\b${f}\\s*\\(`, 'g')) ?? []).length;
  const copies = (code, target) => { // inlined copies of target: call paths from main, each call site counted once
    const F = bodies(code), memo = new Map();
    const n = f => { if (f === 'main') return 1; if (memo.has(f)) return memo.get(f); let c = 0; for (const [g, b] of F) if (g !== f) c += sites(b, f) * (sites(b, f) ? n(g) : 0); memo.set(f, c); return c; };
    return n(target);
  };
  const want = { 'life-scatter VS': 1, 'life-stand VS': 1, 'life-stand-merged VS': 1, 'life-creature VS': 1, 'life-bird VS': 0, 'life-particle VS': 0 };
  assert.deepEqual(Object.keys(progs).filter(k => k.endsWith('VS')).sort(), Object.keys(want).sort(), 'the LIFE programs are the six above');
  for (const [name, stage] of Object.entries(progs)) {
    const code = stageCode(stage);
    const fine = copies(code, 'mapClassFine'), seat = copies(code, 'lifeClassSeat');
    assert.ok(fine <= 2, `${name}: ${fine} inlined copies of mapClassFine (budget 2: read it once per placement, probes keep the lattice)`);
    assert.equal(fine, seat, `${name}: mapClassFine is reached only through lifeClassSeat`);
    assert.equal(seat, want[name] ?? 0, `${name}: ${seat} seat reads (scatter instance, stand site, herd site each read their seat fine)`);
  }
  assert.equal(+/const int DEED_TILES = (\d+);/.exec(SPRITES_GLSL.LIFE)?.[1], TILES, 'the deed of a tile uses the contracts\' tiles per deed');
  // the resident branch is GROUND's own rule: if GROUND changes how a record carries its class, LIFE must follow
  assert.match(G.CLASSES.replace(/\s+/g, ' '), /uint classAtTile\(ivec2 t\) \{ ivec2 d = rmDeedOf\(t\); if \(pageResident\(d\)\) return tileRecord\(t\)\.w & 15u;/,
    'GROUND\'s classAtTile still reads the class as tileRecord(t).w & 15u');
});

test('the merged-block path is its own program: life-stand compiles one stand site, life-stand-merged only the merged blocks', () => {
  // Why (RM-GPU-1 P0 fix pass, gate round 1): STAND was LIFE's heaviest pipeline — 5.3 s of SwiftShader JIT at its first
  // draw — because one program carried the members, the own clumps AND the merged blocks, whose mergedSite runs standSite
  // in a 4-trip loop (5 stand-site copies once unrolled). Its first draw landed in the MAP and d 400 band-change spikes
  // (5.6–10.1 s long tasks). Split, each band builds only the path it draws, and SHELL's rehearsal pre-draws both.
  const P = Object.fromEntries(lifePrograms().map(p => [p.name, p]));
  assert.ok(P['life-stand'] && P['life-stand-merged'], 'both stand programs exist');
  assert.deepEqual(P['life-stand'].defines, {}, 'life-stand: no STAND_MERGED');
  assert.ok('STAND_MERGED' in P['life-stand-merged'].defines, 'life-stand-merged: STAND_MERGED');
  const src = defs => glslCode(ifdefs(SPRITES_GLSL.LIFE + '\n' + SPRITES_GLSL.STAND_VS, { ...defs, REALM_VS: 1 }));
  const main = code => { const i = code.indexOf('void main()'); return code.slice(i); };
  const calls = (s, f) => (s.match(new RegExp(`\\b${f}\\s*\\(`, 'g')) ?? []).length;
  const stand = src({}), merged = src({ STAND_MERGED: 1 });
  assert.equal(calls(stand, 'mergedSite'), 0, 'life-stand neither defines nor calls mergedSite');
  assert.equal(calls(main(stand), 'standSite'), 1, 'life-stand: one stand site per vertex');
  assert.match(main(stand), /uMode == 0/, 'life-stand keeps the members path');
  assert.equal(calls(main(merged), 'standSite'), 0, 'life-stand-merged: stand sites only through mergedSite');
  assert.equal(calls(main(merged), 'mergedSite'), 1, 'life-stand-merged: one merged site per vertex');
  assert.doesNotMatch(main(merged), /uMode == 0|lt\(2 \+ m/, 'life-stand-merged carries no members path');
  // the merged loop stays literal-bounded (4 trips: the 2×2 block), so the merged program's unrolled cost is fixed
  assert.match(merged, /bool mergedSite\([^)]*\) \{\s*float sdf;\s*for \(int i = 0; i < 4; i\+\+\)/, 'mergedSite walks the 2×2 block with a literal bound');
});

// A fake core + GL that records every LIFE draw with its program, instance count, uniforms and pass state.
function fakeLifeCore() {
  const S = { DEPTH_TEST: false, BLEND: false, mask: true, func: null, blend: null }, draws = [], made = [];
  let cur = null;
  const impl = {
    isEnabled: c => !!S[c], enable: c => { S[c] = true; }, disable: c => { S[c] = false; },
    depthMask: m => { S.mask = m; }, depthFunc: f => { S.func = f; }, blendFunc: (a, b) => { S.blend = `${a}/${b}`; },
    uniform1i: (loc, v) => { if (cur && loc) cur.uni[loc] = v; }, uniform4i: (loc, ...v) => { if (cur && loc) cur.uni[loc] = v; },
    uniform4iv: (loc, v) => { if (cur && loc) cur.uni[loc] = [...v]; },
    drawArraysInstanced: (mode, first, count, inst) => draws.push({ prog: cur?.name, inst, count, mode: cur?.uni.uMode, shadow: cur?.uni.uShadow, rh: cur?.uni.uRehearse,
      win: cur?.uni.uWin ?? cur?.uni.uGrp?.slice(0, 2),
      state: (S.DEPTH_TEST ? `depth ${S.func} write ${S.mask}` : 'no depth') + (S.BLEND ? ` blend ${S.blend}` : ' opaque') }),
  };
  const gl = new Proxy(impl, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return k; return () => {}; } });
  const tex = () => ({ t: {}, bytes: 0 });
  const core = { gl, quadVao: 'quad', include() {}, animating() {},
    program(name) { const p = { name, uni: {}, ready: true, use() { cur = p; return p; }, bindView() { return p; }, tex() { return p; }, u: n => n }; made.push(p); return p; },
    tex: { array: tex, data: tex, layer() {}, free() {} } };
  return { core, draws, made, state: S };
}
/** A synthetic pack for `realm`: every sprite and creature its LIFE table asks for, opaque art at the stub sizes. */
function fakeLifePack(realm) {
  const T = lifeTable(realm, {}), ids = new Set(), cids = new Set(), n = id => String(id).replace(/-/g, '_');
  compileLife(realm, T, { sprite: id => { ids.add(n(id)); return spriteStub(id); }, creature: id => { cids.add(n(id)); return creatureStub(id); } });
  const air = new Set([...(T.birds?.species ?? []).map(s => s[0]), ...(T.ambience ?? []).map(a => a.id), ...T.groups.flatMap(g => g.species.map(s => s[2]?.emit?.fx).filter(Boolean))].map(n));
  const rects = {};
  for (const id of new Set([...ids, ...air])) { const st = spriteStub(id), a = air.has(id); rects[id] = { x: 0, y: 0, w: a ? 24 : st.w, h: a ? 24 : st.h, frames: 1 }; }
  const img = { data: new Uint8ClampedArray(160 * 128 * 4).fill(255), width: 160, height: 128 };
  // PACK's map twins for every large sprite and every other 64-px one: twin groups then mix twinned and twin-less
  // species in one array, and hold arrays of twinned species only (whose kit draws are useless at w.true = 0)
  const twins = Object.fromEntries(Object.keys(rects).filter((id, i) => !air.has(id) && (rects[id].w > 64 || i % 2 === 0)).map(id => [id, { x: 0, y: 0, w: 10, h: 10 }]));
  return { id: realm, meta: { id: realm, grid: { cols: 10, rows: 10 }, map: { atlas: { file: 'm.png' }, twins }, sprites: { atlas: 's.png', rects },
    creatures: { atlas: 'c.png', list: [...cids].map(id => ({ id, x: 0, y: 0, fw: 32, fh: 32, directions: 4, frames: 2, kind: creatureStub(id).kind })) } },
    pixels: async () => img };
}
test('Solana Reach\'s beacon lenses pulse at their anchors: only those map objects glow, in the twin pass, still under reduced motion', async () => {
  // Why (Stage B; ART lane-art.md, cu/dehalo.mjs): the provider drew an opaque pale disc behind both beacon lenses; ART cut it
  // and handed the glow to LIFE ("a pulsing glow at lens anchors (32,20) and (31,18) of the 64-px canvas"). The glow must sit
  // on the lens texel (a flipped beacon too: the anchor is in layer texels, which vTex addresses unflipped), on those two
  // objects only, cost no extra instance (it is the twin's own fragments), and hold still under reduced motion.
  const t = lifeTable('seeker-reach', { map: { objects: { map_beacon_1: { w: 64, h: 64, role: 'beacon' }, map_beacon_2: { w: 64, h: 64, role: 'beacon' }, map_peak_1: { w: 64, h: 64 } } } });
  assert.deepEqual(t.groups.find(g => g.id === 'mapobj').species.map(s => [s[0], s[2].glow ?? null]), [['map_beacon_1', [32, 20]], ['map_beacon_2', [31, 18]], ['map_peak_1', null]]);
  // the table life.mjs uploads: flag 4 and T4 = (anchor in the twin layer, radius, period) on the beacons only
  const { createLife } = await import('./life.mjs');
  const { core, draws } = fakeLifeCore(), defs = {}, clocks = {};
  let data = null;
  const prog = core.program, texData = core.tex.data;
  core.program = (name, o) => { defs[name] = o?.defines ?? {}; return prog(name, o); };
  core.tex.data = (...a) => { data = a[5]; return texData(...a); };
  core.animating = (tag, ms) => { clocks[tag] = ms; };
  const pack = fakeLifePack('seeker-reach'), objs = { map_beacon_1: { x: 0, y: 0, w: 64, h: 64, role: 'beacon' }, map_peak_1: { x: 0, y: 0, w: 64, h: 64, role: 'peak' }, map_beacon_2: { x: 0, y: 0, w: 48, h: 64, role: 'beacon' } };
  pack.meta.map.objects = objs;
  const life = createLife(core, null);
  await life.load(pack);
  assert.equal(life.stats().ready, true, life.stats().why);
  const { L } = life.debug(), g = L.groups.find(g => g.id === 'mapobj'), W = MAX_SPECIES * 6;
  const texel = (row, x) => [0, 1, 2, 3].map(c => data[(row * W + x) * 4 + c]);
  for (const [i, sp] of g.species.entries()) {
    const t0 = texel(g.row, i * 6), t4 = texel(g.row, i * 6 + 4), glow = t0[2] >> 4 & 4, o = objs[sp.id], ox = (64 - o.w) >> 1, oy = 64 - o.h; // TWIN_CLASSES 64×64 layer
    if (sp.id === 'map_peak_1') { assert.equal(glow, 0, 'a peak does not glow'); assert.deepEqual(t4, [0, 0, 0, 0]); continue; }
    assert.equal(glow, 4, `${sp.id} carries the glow flag`);
    assert.deepEqual(t4, [...(sp.id === 'map_beacon_1' ? [32, 20] : [31, 18]).map((v, k) => v + [ox, oy][k]), GLOW.radiusMap, GLOW.periodMs], `${sp.id}: anchor in the layer`);
  }
  assert.ok(g.hasGlow && !L.groups.some(x => x !== g && x.hasGlow), 'only the map-object group glows');
  // only life-scatter reads the glow varying: the creature and stand programs link with no vGlow output
  assert.deepEqual(Object.entries(defs).filter(([, d]) => d.LIFE_GLOW).map(([n]) => n), ['life-scatter']);
  const vs = glslCode(SPRITES_GLSL.SCATTER_VS), fs = glslCode(SPRITES_GLSL.SPRITE_FS);
  assert.match(vs, /if \(uMode == 2 && \(flags & 4u\) != 0u\) \{[^}]*lt\(s \* SPT \+ 4, row\)/, 'the glow reads T4 in the twin pass only');
  assert.match(vs, new RegExp(`const float GLOW_LO = ${GLOW.lo}, GLOW_REST = ${GLOW.rest};`), 'the shader pulse uses scatter.mjs GLOW');
  assert.match(vs, /rm \? GLOW_REST : GLOW_LO \+ \(1\.0 - GLOW_LO\) \* tri \* tri \* \(3\.0 - 2\.0 \* tri\)/, 'glowPulse\'s curve');
  assert.match(fs, /#ifdef LIFE_GLOW\s+flat in vec4 vGlow;/, 'the fragment input exists only under LIFE_GLOW');
  assert.ok(!/vGlow/.test(glslCode(SPRITES_GLSL.CREATURE_VS) + glslCode(SPRITES_GLSL.STAND_VS)), 'no other LIFE vertex shader carries it');
  // the pulse: lo → 1 → lo over the period, smooth, per-instance phase, and still under reduced motion
  let lo = 1, hi = 0, step = 0;
  for (let ms = 0; ms < 2 * GLOW.periodMs; ms += 16) { const a = glowPulse(0x12345678, ms, false), b = glowPulse(0x12345678, ms + 16, false); lo = Math.min(lo, a); hi = Math.max(hi, a); step = Math.max(step, Math.abs(b - a)); }
  assert.ok(Math.abs(lo - GLOW.lo) < 0.01 && hi > 0.99 && step < 0.05, `pulse ${lo.toFixed(3)}…${hi.toFixed(3)}, largest 16-ms step ${step.toFixed(3)}`);
  assert.equal(glowPulse(0x12345678, 777, false), glowPulse(0x12345678, 777 + GLOW.periodMs, false), 'periodic');
  assert.notEqual(glowPulse(0x12345678, 500, false), glowPulse(0x9abc0000, 500, false), 'neighbouring beacons do not pulse in lockstep');
  assert.equal(glowPulse(0x12345678, 500, true), GLOW.rest); assert.equal(glowPulse(0x12345678, 1700, true), GLOW.rest);
  // its clock ticks while the map objects draw, never under reduced motion; and the glow costs no instance
  const v = { x: 5, y: 5, d: 400, W: 1280, H: 800, dpr: 1, reducedMotion: false };
  life.update(v); assert.equal(clocks['life-glow'], 100);
  const n0 = draws.length; for (const pass of ['shadow', 'sprite', 'air']) life.draw(v, pass);
  assert.equal(draws.slice(n0).reduce((a, w) => a + w.inst, 0), life.stats().submitted, 'the plan counts every instance: the glow adds none');
  life.update({ ...v, reducedMotion: true }); assert.ok(!clocks['life-glow'], 'no glow clock under reduced motion');
});

test('band rehearsal pre-draws every LIFE program in every pass state its real draws use, one instance, and nothing else', async () => {
  // Why (RM-GPU-1 P0 fix pass): a program's GPU pipeline is built at its FIRST DRAW, not at link. The gate measured
  // 19–36 s main-thread blocks at the first MAP frame on SwiftShader (+2 to +3 first draws at d 400), and on Metal the
  // same work lands at the band change. SHELL's band rehearsal calls lane.rehearse(prog, view) during idle frames so the
  // pipelines exist before the band needs them (contracts GPU_SAFE.rehearse). It only helps if the rehearsal builds the
  // SAME pipelines: the same program in every blend/depth state its real passes draw it with. And it must stay tiny
  // (one instance, 1×1-scissored by SHELL), never touch the frame's real plan, and draw nothing it was not asked for.
  const { createLife } = await import('./life.mjs');
  const { core, draws, made } = fakeLifeCore();
  const life = createLife(core, null);
  assert.equal(life.rehearse(made[0]), false, 'nothing to rehearse before a pack is loaded');
  await life.load(fakeLifePack('frostveil'));
  const byName = Object.fromEntries(made.map(p => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['life-bird', 'life-creature', 'life-particle', 'life-scatter', 'life-stand', 'life-stand-merged']);
  // the real passes over the zoom: which program draws in which state
  const real = new Map(), frame = d => { const v = { x: 5, y: 5, d, W: 1280, H: 800, dpr: 1, reducedMotion: false }; life.update(v); for (const pass of ['shadow', 'sprite', 'air']) life.draw(v, pass); };
  for (let d = 50; d < 7000; d *= 1.25) {
    const n0 = draws.length; frame(d);
    for (const w of draws.slice(n0)) { if (!real.has(w.prog)) real.set(w.prog, new Set()); real.get(w.prog).add(w.state); }
  }
  // the split: uMode 3 (merged blocks) only ever draws under life-stand-merged, and that program draws nothing else
  assert.ok(draws.some(w => w.prog === 'life-stand-merged'), 'merged blocks drew at low MAP');
  assert.ok(draws.filter(w => w.prog === 'life-stand-merged').every(w => w.mode === 3), 'life-stand-merged draws merged blocks only');
  assert.ok(draws.filter(w => w.prog === 'life-stand').every(w => w.mode !== 3) && draws.some(w => w.prog === 'life-stand'), 'life-stand never draws merged blocks');
  assert.deepEqual([...real.keys()].sort(), Object.keys(byName).sort(), 'every LIFE program drew somewhere in the zoom');
  // the rehearsal: per program, exactly its real states, one instance per draw, no other program; contract v2 (W1): the
  // instance is the cell under the camera and covers the view centre (uRehearse), and every real draw clears uRehearse
  frame(1500); const planned = draws.length; frame(1500); const steady = draws.slice(planned).map(w => JSON.stringify(w));
  assert.ok(draws.slice(0, planned).every(w => w.rh === 0), 'real draws never cover the screen');
  const cam = { x: 5.3, y: 4.7, d: 1500, W: 1280, H: 800, dpr: 1, reducedMotion: false }, L = life.debug().L;
  const cellOf = pitch => [Math.floor(cam.x * DEED_ART / pitch), Math.floor(cam.y * DEED_ART / pitch)];
  const camCell = { 'life-stand': cellOf(L.stands.pitchArt), 'life-stand-merged': cellOf(2 * L.stands.pitchArt), 'life-creature': cellOf(L.creatures.pitchArt), 'life-bird': cellOf(L.birds.pitchArt) };
  for (const [name, p] of Object.entries(byName)) {
    const n0 = draws.length;
    assert.ok(life.rehearse(p, cam), `${name}: rehearsed`);
    const mine = draws.slice(n0);
    assert.ok(mine.length > 0 && mine.every(w => w.prog === name), `${name}: draws only itself`);
    assert.ok(mine.every(w => w.inst === 1 && w.count === 6), `${name}: one instance of one quad per draw`);
    assert.ok(mine.every(w => w.rh === 1), `${name}: the rehearsal instance covers the view centre (uRehearse)`);
    if (camCell[name]) assert.ok(mine.every(w => w.win[0] === camCell[name][0] && w.win[1] === camCell[name][1]), `${name}: the cell under the camera, ${JSON.stringify(mine.map(w => w.win))}`);
    const pitches = name === 'life-scatter' ? L.groups.map(g => g.pitchArt) : name === 'life-particle' ? L.ambience.map(a => a.pitchArt) : [];
    if (pitches.length) assert.ok(mine.every(w => pitches.some(pa => cellOf(pa)[0] === w.win[0] && cellOf(pa)[1] === w.win[1])), `${name}: a stream's cell under the camera, ${JSON.stringify(mine.map(w => w.win))}`);
    assert.deepEqual([...new Set(mine.map(w => w.state))].sort(), [...real.get(name)].sort(), `${name}: the pass states its real draws use`);
  }
  // the shaders: every LIFE vertex shader ends with rehearsalCover(), and a culled vertex covers too (while rehearsing)
  for (const { name, vs } of lifePrograms()) assert.match(glslCode(vs), /rehearsalCover\(\);\s*\}\s*$/, `${name}: main() ends with rehearsalCover()`);
  assert.match(SPRITES_GLSL.LIFE, /void cullVertex\(\) \{ gl_Position = vec4\(2\.0, 2\.0, 2\.0, 1\.0\); rehearsalCover\(\); \}/);
  assert.match(SPRITES_GLSL.LIFE, /void rehearsalCover\(\) \{ if \(uRehearse != 0\) \{ int v = gl_VertexID % 3; gl_Position = vec4\(v == 1 \? 3\.0 : -1\.0, v == 2 \? 3\.0 : -1\.0, -1\.0, 1\.0\); \} \}/,
    'the cover is a viewport-filling triangle per 3 vertices at the near plane (it passes any LEQUAL depth)');
  // SHELL may rehearse between a frame's update and its draws: the frame must draw exactly as if it had not
  const v = { x: 5, y: 5, d: 1500, W: 1280, H: 800, dpr: 1, reducedMotion: false }; life.update(v);
  for (const q of made) life.rehearse(q, cam);
  const n1 = draws.length; for (const pass of ['shadow', 'sprite', 'air']) life.draw(v, pass);
  assert.deepEqual(draws.slice(n1).map(w => JSON.stringify(w)), steady, 'a rehearsal leaves the real frame untouched');
  assert.equal(life.rehearse({ name: 'rm-map', ready: true }), false, 'not a LIFE program');
  const p = byName['life-bird']; p.ready = false;
  assert.equal(life.rehearse(p), false, 'a program still linking is not drawn'); p.ready = true;
});

// W1 fix pass 2 (D-167: no main-thread stall > 50 ms). LIFE's load was ONE task after its last pack read: every sprite and
// creature crop, the twin reductions, the stand clumps, then RGB bleed + a mode-preserving mip chain + an upload for every
// layer of every frame (3.6–4.5k uploads a realm), the table and the programs. Real packs, desktop CPU: 520–744 ms, a phone
// several times that, right in the entry window. It now runs as one generator in ≤ SLICE_MS (8 ms) slices, GROUND's G3
// pattern. Counted, not timed (G3's rule; GC and a loaded host only lengthen real stretches): the test clock advances 0.5 ms
// per read of the sprite or creature atlas (one crop or one reduceMap each) and 0.3 ms per layer upload (G3's slow phone),
// and nothing else. No stretch between two message-channel yields, nor the first or the last, may exceed SLICE_MS plus one
// step (one crop, one reduction or ONE upload). Teeth (scratch mutations): the old load is one ~450 ms stretch; unsliced
// reads, stand members or twins, or one step per frame (8 levels) instead of per level, each overshoot the bound.
test('the load never blocks the main thread: crops, stand clumps, bleed, mips and uploads run in short slices (W1)', async () => {
  const { createLife } = await import('./life.mjs');
  const SLICE = 8, STEP = 0.5; // life.mjs SLICE_MS without a coarse pointer; the costliest modelled step
  const { core } = fakeLifeCore(), pack = fakeLifePack('crownlands');
  let vt = 0, last = 0, worst = 0, yields = 0, uploads = 0;
  const up = core.tex.layer; core.tex.layer = (...a) => { vt += 0.3; uploads++; return up(...a); };
  const plain = await pack.pixels('m.png'), D = plain.data;
  const atlas = { get data() { vt += 0.5; return D; }, width: plain.width, height: plain.height };
  pack.pixels = async f => (f === 'm.png' ? plain : atlas); // the map twins' mapkit reads stay free (meanLuma walks it per pixel)
  const MC = globalThis.MessageChannel, now = performance.now;
  globalThis.MessageChannel = class extends MC { constructor() { super(); const post = this.port2.postMessage.bind(this.port2); this.port2.postMessage = m => { yields++; worst = Math.max(worst, vt - last); last = vt; post(m); }; } };
  performance.now = () => vt;
  const life = createLife(core, null);
  try { await life.load(pack); } finally { globalThis.MessageChannel = MC; performance.now = now; }
  worst = Math.max(worst, vt - last);
  const s = life.stats();
  assert.equal(s.ready, true, `the synthetic realm loads (${s.why})`);
  assert.ok(uploads > 1000 && vt > 300, `a realistic load: ${uploads} uploads, ${vt.toFixed(0)} ms of modelled work`);
  assert.ok(worst <= SLICE + STEP + 1e-9, `a stretch held ${worst.toFixed(1)} ms of modelled work (the bound is ${SLICE} + ${STEP})`);
  assert.ok(yields >= (vt / (SLICE + STEP)) * 0.9, `the load yielded ${yields} times for ${vt.toFixed(0)} ms of modelled work`);
  assert.equal(s.load.slices, yields, 'stats().load.slices counts the yields');

  // Leaving the realm mid-load (SHELL disposes the lane) stops the load at its next step: no further upload, every texture
  // it made is freed, and nothing turns ready. Otherwise a stale load keeps burning slices and GPU memory after the exit.
  const f2 = fakeLifeCore(), live = new Set(); let n2 = 0, late = 0, gone = false;
  const mk = () => { const t = { t: {}, bytes: 0 }; live.add(t); return t; };
  Object.assign(f2.core.tex, { array: mk, data: mk, free: t => { live.delete(t); }, layer: () => { n2++; if (gone) late++; } });
  const life2 = createLife(f2.core, null), p2 = life2.load(fakeLifePack('crownlands'));
  for (let i = 0; i < 20000 && n2 < 300; i++) await new Promise(r => setImmediate(r));
  assert.ok(n2 >= 300, `the load reached its uploads (${n2})`);
  life2.dispose(); gone = true; await p2;
  assert.equal(late, 0, `${late} uploads after dispose`);
  assert.equal(live.size, 0, `${live.size} textures left allocated`);
  assert.equal(life2.stats().ready, false, 'a disposed load never turns ready');
  gone = false; await life2.load(fakeLifePack('crownlands'));
  assert.equal(life2.stats().ready, true, 'the same instance loads again after a dispose');
});

test('the §9 budget counts what the GPU gets: every frame submits exactly planDraws\' total, and it stays under the cap', async () => {
  // Why (RM-20, P0 fix pass): planDraws counted each lattice window once, but life.mjs submits a window once per sprite
  // array holding its species, per twin or clump array, 3× for emitter puffs and twice for birds — real packs submitted
  // 1.6–2.9× the planned total, so a cap enforced on the plan was not a cap (1280×800 dpr 2: 86–107k against 60k; the
  // cost model undercounted LIFE's vertex work the same way). Now the plan counts each draw, and this holds the two
  // equal on every frame of a zoom, on phone and desktop screens, so the ceiling bounds the real submission.
  const { createLife } = await import('./life.mjs');
  const { core, draws } = fakeLifeCore();
  const life = createLife(core, null);
  await life.load(fakeLifePack('stormcairn'));
  let frames = 0, multi = 0;
  for (const [W, H, dpr] of [[1280, 800, 1], [390, 844, 2], [390, 844, 3], [1280, 800, 2], [1920, 1080, 2]]) {
    const cap = submittedCap({ W, H });
    for (let d = 50; d < 7000; d *= 1.2) {
      const v = { x: 5, y: 5, d, W, H, dpr, reducedMotion: false }; life.update(v);
      const n0 = draws.length; for (const pass of ['shadow', 'sprite', 'air']) life.draw(v, pass);
      const gpu = draws.slice(n0).reduce((a, w) => a + w.inst, 0), planned = life.stats().submitted;
      assert.equal(gpu, planned, `${W}×${H}@${dpr} d ${d.toFixed(0)}: the GPU got ${gpu}, the plan counted ${planned}`);
      assert.ok(gpu <= cap, `${W}×${H}@${dpr} d ${d.toFixed(0)}: ${gpu} over ${cap}`);
      const perProg = draws.slice(n0).reduce((m, w) => (m[w.prog + w.mode] = (m[w.prog + w.mode] ?? 0) + 1, m), {});
      if (Object.values(perProg).some(n => n > 1)) multi++;
      frames++;
    }
  }
  assert.ok(multi > 10, `${multi} of ${frames} frames draw one program in one mode more than once (several arrays): the case the plan missed`);
});

test('GLSL isqrtU equals scatter.mjs isqrt: a bounded float sqrt and one correction each way, exact on every input', () => {
  // Why: creatures must walk exactly like the kit (travel time = isqrt of the step), and the old while-loop version
  // could spin ~2^32 times on an overflowed step. The replacement is loop-free; this proves it still returns ⌊√n⌋ —
  // on the whole clamped step range with the GPU's sqrt off by up to ±4 ULP, and on the whole uint range — so the
  // hang fix changed no creature's pose.
  const L = SPRITES_GLSL.LIFE, DV_MAX = +/const int DV_MAX = (\d+);/.exec(L)?.[1];
  assert.ok(DV_MAX > 0, 'DV_MAX is declared in the life include');
  const body = /uint isqrtU\(uint n\) \{([\s\S]*?)\n\}/.exec(L)?.[1].replace(/\s+/g, ' ').trim();
  assert.equal(body, 'if (n < 2u) return n; uint r = min(uint(sqrt(float(n))), 65535u); if (r * r > n) r--; ' +
    'if (r < 65535u && (r + 1u) * (r + 1u) <= n) r++; return r;', 'the emulation below mirrors the shader source');
  assert.match(L, /int travelMs\(ivec2 dv, int speed\) \{ ivec2 c = dvSane\(dv\);/, 'travelMs clamps the step first');
  assert.match(L, /ivec2 dv = dvSane\(p\[i \+ 1\] - p\[i\]\);/, 'pathPose5 interpolates the clamped step');
  // the shader's arithmetic: float(n) and sqrt rounded to f32, then ±k ULP; uint(x) truncates; uint maths wraps at 2^32
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  const ulps = (x, k) => { f[0] = x; u[0] += k; return f[0]; };
  const isqrtU = (n, k) => {
    if (n < 2) return n;
    let r = Math.min(Math.trunc(ulps(Math.fround(Math.sqrt(Math.fround(n))), k)), 65535);
    if ((Math.imul(r, r) >>> 0) > n) r--;
    if (r < 65535 && (Math.imul(r + 1, r + 1) >>> 0) <= n) r++;
    return r;
  };
  const N = 2 * DV_MAX * DV_MAX;
  for (let n = 0; n <= N; n++) {
    const want = isqrt(n);
    for (let k = -4; k <= 4; k++) if (isqrtU(n, k) !== want) assert.fail(`isqrtU(${n}) with sqrt ${k} ULP = ${isqrtU(n, k)}, isqrt ${want}`);
  }
  // the whole uint range (garbage in): around every square r² and at 2^32 − 1, the answer is still ⌊√n⌋ ≤ 65535
  for (let r = 1; r <= 65535; r += r < 4096 ? 1 : 7) for (const n of [r * r - 1, r * r, r * r + r, r * r + 2 * r]) {
    const want = isqrt(n);
    for (const k of [-4, 0, 4]) assert.equal(isqrtU(n, k), want, `isqrtU(${n}) ${k} ULP`);
  }
  for (const k of [-4, 0, 4]) assert.equal(isqrtU(2 ** 32 - 1, k), 65535);
  // the clamp never binds on real data (so kit parity holds) and keeps every int product in pathPose5 below 2^31
  const herdStep = 2 * LOOP_RADIUS_TILES * ART;            // waypoints stay within ±LOOP_R of home on each axis
  assert.ok(herdStep <= DV_MAX, `a herd step (${herdStep} art px) fits the clamp`);
  assert.ok(N < 2 ** 31, 'dv.x² + dv.y² fits an int');
  const Tmax = Math.floor(isqrt(N) * 1000 / 1);            // travelMs at speed 1 (the shader floors speed at 1)
  assert.ok(DV_MAX * Tmax < 2 ** 31, `dv · t < ${DV_MAX * Tmax}`);
  assert.ok(4 * (65535 + Tmax) < 2 ** 31, 'the loop period (4 × (dwell u16 + travel)) fits an int');
});
