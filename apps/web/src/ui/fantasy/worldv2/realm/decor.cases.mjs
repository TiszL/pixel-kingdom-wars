// decor.test — why it matters: every claimed deed on a realm map shows an ILLUSTRATED kingdom of its
// level (plan §6.3). The owner's bar is that bases "display beautifully and naturally fitting in the map
// world", and "Enter base" must feel like the same world. These tests pin the rules that make a kingdom
// read as a kingdom and not a diagram or a glitch, for all 20 levels × 4 formations × every dressed realm (8 since Stage B):
//   - everything stands on its own land (claim / plot), nothing overlaps, gates line up;
//   - the Keep is the biggest thing on the base (the owner's sky law, constants BUILDING_FIT);
//   - the keep's courtyard stays clear and the enlarged keep (kFit, §6.7) never leaves it or hides
//     behind a wall, while its on-screen size only ever grows as you zoom in;
//   - walls are formation-invariant, so ONE offline yard layer (plots.webp) serves every formation and
//     the MAP impostor dissolves into the TRUE decor in place (same seats);
//   - it is deterministic (no runtime randomness: the same base looks the same for everyone, always).
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  composeBaseDecor, edgeSprites, edgeAutotileSprites, EDGE_ARMS, wallSprites, miniSprites, kFit, keepScale, keepInkRect, keepExtents, inkRect,
  plotGeometry, decorCountCap, rule, seedOf, DECOR_LAYOUT, KIT_DRESSING, basePaths, basePathsJob, PATHS, laneMeander, settlePath, bridgeSeats, bridgePiece, PATH_TERRAIN,
} from './decor.mjs';
import { demoBases, ladderBases, withAttackable, DEMO } from './demo-bases.fixture.mjs';
import { REALMS_WITH_MAPS, KEEP_FIT, BANDS, decorCap, wallCapForKeepLevel, PLOT_CENTRE, TILES, plotRule, plotOffset } from './contracts.mjs';
import { CAMPAIGN, CAMPAIGN_LAYOUT, WARE_WORLD_PRESENTATION } from '@shardkeep/shared';

const LEVELS = Array.from({ length: 20 }, (_, i) => i + 1), FORMS = [0, 1, 2, 3];
const ALL = [];
// Stage B: every realm BASES dresses, and every realm SHELL lists (an undressed listed realm throws in composeBaseDecor, so
// it fails here instead of silently drawing no kingdoms): the three catch-up realms are tested before SHELL lists them
const REALMS = [...new Set([...REALMS_WITH_MAPS, ...Object.keys(KIT_DRESSING)])];
for (const realmId of REALMS) for (const level of LEVELS) for (const f of FORMS) ALL.push({ realmId, level, f });
const decorOf = new Map();
// the sides a path to a neighbour leaves by (bases.mjs passes them as `gates`): all four, one, two, none — so the
// suite covers every lane and a kingdom with no link (fix iteration 2: no lane without a path)
const GATES_BY_F = [['N', 'S', 'W', 'E'], ['E'], ['N', 'W'], []];
const get = (realmId, level, f) => {
  const k = `${realmId}|${level}|${f}`;
  if (!decorOf.has(k)) decorOf.set(k, composeBaseDecor({ level, realmId, seed: f, gates: GATES_BY_F[f] }));
  return decorOf.get(k);
};
const tilesOf = (fx, fy, fw, fh) => { const o = []; for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) o.push([x, y]); return o; };
const inRect = (x, y, r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
const overlaps = (a, b, eps = 1e-9) => a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.y0 < b.y1 - eps && b.y0 < a.y1 - eps;

test('every level × formation × realm composes — no building is ever silently dropped', () => {
  for (const { realmId, level, f } of ALL) assert.doesNotThrow(() => get(realmId, level, f), `${realmId} L${level} f${f}`);
});

test('the claim and plot follow the PvE level→claim table (C2) and the plot never leaves its deed', () => {
  for (const L of LEVELS) {
    const g = plotGeometry(L);
    assert.equal(g.S, CAMPAIGN.claimTilesByKeep[L - 1], `claim L${L}`);
    assert.equal(g.B - g.A, g.S);
    assert.equal(g.A + g.B, 2 * PLOT_CENTRE, 'the claim is centred on the plot centre (the in-game claimRect)');
    assert.equal(rule(L).wallRings, CAMPAIGN_LAYOUT.wallRingsByKeep[L - 1], 'wall rings come from CAMPAIGN_LAYOUT');
    assert.ok(g.P0 >= 0 && g.P1 <= TILES, `plot inside the deed at L${L}`);
  }
});

test('everything stands on its own land: buildings and walls in the claim, dressing in the plot, hedges in the ring off the roads', () => {
  for (const { realmId, level, f } of ALL) {
    const d = get(realmId, level, f), g = d.geometry, claim = d.claim, inner = { x0: g.P0, y0: g.P0, x1: g.P1, y1: g.P1 };
    const tag = `${realmId} L${level} f${f}`;
    for (const s of d.sprites) {
      if (s.kind === 'fx') continue;
      const box = s.kind === 'building' ? claim : inner;
      for (const [x, y] of tilesOf(s.fx, s.fy, s.fp[0], s.fp[1])) assert.ok(inRect(x, y, box), `${tag} ${s.key} at ${s.fx},${s.fy}`);
      const r = inkRect(s);
      assert.ok(r.x0 >= 0 && r.y0 >= 0 && r.x1 <= TILES && r.y1 <= TILES, `${tag} ${s.key} ink inside the deed`);
    }
    for (const w of d.walls) assert.ok(inRect(w.x, w.y, claim), `${tag} wall ${w.x},${w.y}`);
    // round 2: hedges and fences follow the tended patches in the ring; the roads (every laned side's lane and its
    // shoulders, fix iteration 1: lanes wander and only laned sides keep a corridor) stay open
    const road = new Set();
    for (const [side, cells] of Object.entries(d.lanes)) for (const [x, y] of cells) for (const k of [-1, 0, 1]) road.add(side === 'N' || side === 'S' ? `${x + k},${y}` : `${x},${y + k}`);
    for (const e of d.edges) {
      assert.ok(inRect(e.x, e.y, inner) && !inRect(e.x, e.y, claim), `${tag} hedge ${e.x},${e.y} outside the ring`);
      assert.ok(!road.has(`${e.x},${e.y}`), `${tag} hedge ${e.x},${e.y} on a road`);
    }
    // fix iteration 2 (QA 3: "stubs end in open grass", "roads jog at the gate"): a kingdom lanes exactly the sides a path
    // to a neighbour takes (no link → no lane: a lane that ends in open land reads as a mistake), each lane straight on
    // the gate axis (the keep's columns 48–49) from the wall gate to the plot edge, so the road meets its path in one piece
    assert.deepEqual(Object.keys(d.lanes).sort(), [...GATES_BY_F[f]].sort(), `${tag}: laned sides = linked sides`);
    for (const [side, cells] of Object.entries(d.lanes)) {
      assert.ok(cells.every(([x, y]) => [48, 49].includes(side === 'N' || side === 'S' ? x : y)), `${tag} ${side}: the lane runs straight on the gate axis`);
      assert.equal(d.laneEnds[side], 0, `${tag} ${side}: no jog where the lane meets the plot edge`);
    }
  }
});

test('no two footprints overlap (keep, walls, plot edge, buildings, dressing, livestock)', () => {
  for (const { realmId, level, f } of ALL) {
    const d = get(realmId, level, f), seen = new Map(), tag = `${realmId} L${level} f${f}`;
    const claim = (x, y, who) => { const k = x + ',' + y; assert.ok(!seen.has(k), `${tag}: ${who} overlaps ${seen.get(k)} at ${k}`); seen.set(k, who); };
    for (const [x, y] of tilesOf(d.keep.fx, d.keep.fy, d.keep.fp[0], d.keep.fp[1])) claim(x, y, 'keep');
    for (const w of d.walls) claim(w.x, w.y, `wall/${w.ring}`);
    for (const s of edgeSprites(d)) for (const [x, y] of tilesOf(s.fx, s.fy, s.fp[0], s.fp[1])) claim(x, y, `edge ${s.key}`);
    for (const s of d.sprites) if (s.kind !== 'fx' && s.role !== 'pen' && s.role !== 'livestock') for (const [x, y] of tilesOf(s.fx, s.fy, s.fp[0], s.fp[1])) claim(x, y, s.key);
    // a pen is one item: its rails, posts and beasts share its footprint but never each other's tiles
    const pen = new Set();
    for (const s of d.sprites) if (s.role === 'pen' || s.role === 'livestock') for (const [x, y] of tilesOf(s.fx, s.fy, s.fp[0], s.fp[1])) {
      const k = x + ',' + y; assert.ok(!pen.has(k), `${tag}: pen piece overlap at ${k}`); pen.add(k); assert.ok(!seen.has(k), `${tag}: pen on ${seen.get(k)}`);
    }
  }
});

test('the Keep is the biggest thing on the base (owner: "nothing reaches it"; BUILDING_FIT sky law)', () => {
  for (const { realmId, level, f } of ALL) {
    const d = get(realmId, level, f), k = keepInkRect(level), kh = k.y1 - k.y0, ka = kh * (k.x1 - k.x0);
    for (const s of d.sprites) {
      if (s.kind === 'fx' || s.kind === 'flat') continue;                   // torch flames sit on walls; crop beds are flat
      if (s.kind === 'tree') {                                               // wild trees belong to the world, not the kingdom:
        const g = d.geometry, out = Math.max(g.A - 1 - s.fx, s.fx - g.B, g.A - 1 - s.fy, s.fy - g.B);   // only in the ring's outer rows
        assert.ok(s.role === 'wildTree' && out >= 1 + (g.ring - 2) / 2 - 1e-9, `${realmId} L${level} ${s.key}: a tall tree ${out} t from the claim`);
        continue;
      }
      const r = inkRect(s), h = r.y1 - r.y0, a = h * (r.x1 - r.x0), tag = `${realmId} L${level} ${s.key}`;
      if (s.kind === 'pole') { assert.ok(h <= kh * DECOR_LAYOUT.poleSky + 1e-9, `${tag}: pole ${h.toFixed(2)} t vs keep ${kh.toFixed(2)} t`); continue; }
      if (s.kind === 'fence') { assert.ok(h - (s.fp[1] - 1) < kh, `${tag}: fence elevation`); continue; } // a 1×2 N–S rail's ink is depth
      assert.ok(h < kh, `${tag}: ${h.toFixed(2)} t reaches the keep's ${kh.toFixed(2)} t`);
      assert.ok(a < ka, `${tag}: ink area ${a.toFixed(2)} out-masses the keep's ${ka.toFixed(2)}`);
    }
  }
});

test('building counts follow the game caps and the decor caps exactly (the level is legible from the decor)', () => {
  const fams = ['archer', 'cannon', 'mortar', 'airdefence', 'electrictower', 'magetower', 'lasertower', 'dragonnest', 'vault', 'camp', 'barracks', 'mine', 'goldforge', 'clanhall', 'heroaltar', 'siegestool', 'alchemylab'];
  for (const realmId of REALMS) for (const L of LEVELS) {
    const d = get(realmId, L, 0), n = {};
    for (const s of d.sprites) if (s.kind === 'building') n[s.fam] = (n[s.fam] ?? 0) + 1;
    for (const fam of fams) {
      const want = Math.min(decorCountCap(fam, L), decorCap(fam, L));
      assert.equal(n[fam] ?? 0, want, `${realmId} L${L} ${fam}`);
      assert.ok((n[fam] ?? 0) <= decorCap(fam, L));
    }
  }
  // the plan's §6.3 unlock rows, spot-checked against the composed decor
  const has = (L, fam) => get('sunscar', L, 0).sprites.some(s => s.fam === fam);
  assert.ok(!has(1, 'alchemylab') && has(2, 'alchemylab'), 'alchemy lab from L2');
  assert.ok(!has(2, 'goldforge') && has(3, 'goldforge') && has(3, 'heroaltar') && has(3, 'mortar'), 'L3 holdfast');
  assert.ok(!has(3, 'siegestool') && has(4, 'siegestool'), 'siege stool from L4');
  assert.ok(!has(6, 'airdefence') && has(7, 'airdefence') && has(8, 'electrictower') && has(10, 'magetower') && has(12, 'lasertower') && has(14, 'dragonnest'));
});

test('walls: none at L1 (a 4-piece palisade stub), a ring from L2, citadel from L9, doubled from L17, never over the wall cap', () => {
  for (const L of LEVELS) {
    const d = get('frostveil', L, 0), rings = CAMPAIGN_LAYOUT.wallRingsByKeep[L - 1], by = r => d.walls.filter(w => w.ring === r).length;
    assert.ok(d.walls.length <= wallCapForKeepLevel(L), `L${L}: ${d.walls.length} walls`);
    assert.equal(by('stub'), rings === 0 ? 4 : 0, `stub L${L}`);
    assert.ok(rings >= 1 ? by('outer') > 0 : by('outer') === 0, `outer L${L}`);
    assert.ok(rings >= 2 ? by('citadel') === 18 : by('citadel') === 0, `citadel L${L}: a 6×6 ring less its 2-tile south gate`);
    assert.ok(rings >= 3 ? by('inner') > 0 : by('inner') === 0, `doubled L${L}`);
    assert.ok(d.walls.every(w => w.tier === Math.ceil(L / 4)), `wall5 tier = ceil(L/4) at L${L}`);
  }
});

test('walls, gates and wall fixtures are identical in every formation (one offline yard layer serves all); slot-placed decor moves', () => {
  const fixed = d => d.sprites.filter(s => ['banner', 'light', 'brazier', 'torch'].includes(s.role)).map(s => [s.key, s.fx, s.fy]);
  for (const realmId of REALMS) for (const L of LEVELS) {
    const d0 = get(realmId, L, 0);
    for (const f of [1, 2, 3]) {
      const d = get(realmId, L, f);
      assert.deepEqual(d.walls, d0.walls, `${realmId} L${L} f${f} walls`);
      assert.deepEqual(fixed(d), fixed(d0), `${realmId} L${L} f${f} fixtures`);
    }
    const seats = d => d.sprites.filter(s => s.kind === 'building').map(s => s.fx + ',' + s.fy).sort().join(' ');
    assert.notEqual(seats(get(realmId, L, 1)), seats(d0), `${realmId} L${L}: formation 1 must look different from 0`);
  }
});

test('gates line up: the wall gates, the citadel south gate and the plot-edge gates all sit on the keep lanes', () => {
  for (const L of LEVELS) {
    const d = get('stormcairn', L, 0), g = d.geometry, lanes = g.lanes, at = (list, x, y) => list.some(w => w.x === x && w.y === y);
    const [cl, cr] = [lanes[0] - 1, lanes[lanes.length - 1] + 1];
    const sides = (a, b) => [[x => [x, a]], [x => [x, b]], [y => [a, y]], [y => [b, y]]].map(([fn]) => fn);
    const rings = [['outer', g.o0, g.o1], ['inner', g.o0 + 1, g.o1 - 1]].filter(([r]) => d.walls.some(w => w.ring === r));
    for (const [r, a, b] of rings) {
      const ring = d.walls.filter(w => w.ring === r);
      for (const side of sides(a, b)) {
        for (const v of lanes) assert.ok(!at(ring, ...side(v)), `L${L} ${r}: gate lane ${side(v)} must be open`);
        for (const v of [cl, cr]) assert.ok(at(ring, ...side(v)), `L${L} ${r}: gate cheek ${side(v)} must be walled`);
        assert.ok(ring.filter(w => [cl, cr].some(v => { const [x, y] = side(v); return w.x === x && w.y === y; })).every(w => w.piece.startsWith('end_')), `L${L} ${r}: cheeks are end pieces`);
      }
    }
    // every laned side leaves the plot open where its (meandering) lane meets the plot edge, on the shift basePaths uses
    for (const [side, cells] of Object.entries(d.lanes)) {
      const edgeCells = cells.filter(([x, y]) => (side === 'N' ? y === g.P0 : side === 'S' ? y === g.P1 - 1 : side === 'W' ? x === g.P0 : x === g.P1 - 1));
      assert.equal(edgeCells.length, 2, `L${L} ${side}: the lane reaches the plot edge`);
      for (const [x, y] of edgeCells) assert.ok(!at(d.edges, x, y), `L${L} plot edge gate ${x},${y}`);
      const across = edgeCells.map(([x, y]) => (side === 'N' || side === 'S' ? x : y));
      assert.equal(Math.min(...across) + 1, lanes[1] + d.laneEnds[side], `L${L} ${side}: the lane end shift matches laneEnds`);
    }
    if (g.citadel) {
      const cit = d.walls.filter(w => w.ring === 'citadel'), [a, b] = g.citadel;
      for (const v of lanes) { assert.ok(!at(cit, v, b), 'citadel south gate open'); assert.ok(at(cit, v, a) && at(cit, a, v) && at(cit, b, v), 'citadel sealed N/W/E'); }
    }
  }
});

test('the keep courtyard stays free of decor', () => {
  for (const { realmId, level, f } of ALL) {
    const d = get(realmId, level, f), g = d.geometry, [c0, c1] = g.court, court = { x0: c0, y0: c0, x1: c1, y1: c1 };
    for (const s of d.sprites) if (s.kind !== 'fx') for (const [x, y] of tilesOf(s.fx, s.fy, s.fp[0], s.fp[1])) assert.ok(!inRect(x, y, court), `${realmId} L${level} f${f}: ${s.key} in the courtyard`);
    for (const w of d.walls) assert.ok(!inRect(w.x, w.y, court), `L${level}: wall in the courtyard`);
  }
});

const DS = [200, 220, 250, 279.9, 280, 300, 350, 448, 600, 700, 800, 950, 1099, 1100, 1400, 2000, 3136, 6272];
test('kFit: the enlarged keep (d ≥ 200) stays inside its courtyard and nothing in front of it covers it', () => {
  for (const L of LEVELS) {
    const g = plotGeometry(L), half = (g.citadel ? KEEP_FIT.clearTiles.citadel : KEEP_FIT.clearTiles.below9) / 2;
    assert.ok(kFit(L) <= KEEP_FIT.maxScale && kFit(L) >= 1, `kFit L${L}`);
    for (const d of DS) {
      const r = keepInkRect(L, keepScale(L, d));
      assert.ok(r.x0 >= PLOT_CENTRE - half - 1e-9 && r.x1 <= PLOT_CENTRE + half + 1e-9, `L${L} d${d}: keep ink ${r.x0.toFixed(2)}…${r.x1.toFixed(2)} leaves the clear span`);
      if (!g.citadel) assert.ok(r.y0 >= g.court[0] - 1e-9 && r.y1 <= g.court[1], `L${L} d${d}: keep ink leaves the courtyard vertically`);
      for (const realmId of REALMS) {
        const dec = get(realmId, L, 0), front = [...dec.sprites, ...wallSprites(dec)].filter(s => s.z > dec.keep.z);
        for (const s of front) assert.ok(!overlaps(inkRect(s), r), `${realmId} L${L} d${d}: ${s.key} in front covers the keep`);
      }
    }
  }
  // what the plan states for kFit (§6.7): 2 below L9, 1.63–2 in the citadel (measured ink)
  for (const L of LEVELS.filter(L => L < 9)) assert.equal(kFit(L), 2);
  assert.ok(Math.abs(kFit(20) - 1.63) < 0.01, `kFit(20) = ${kFit(20)}`);
});

test('the keep reaches true size at d 1100 and its on-screen width only ever grows while zooming in', () => {
  for (const L of LEVELS) {
    assert.equal(keepScale(L, BANDS.trueFull), 1);
    assert.equal(keepScale(L, BANDS.impostor[1]), kFit(L));
    let prev = 0;
    for (let d = BANDS.impostor[0]; d <= 8000; d *= 1.01) {
      const r = keepInkRect(L, keepScale(L, d)), w = (r.x1 - r.x0) * d / TILES;
      assert.ok(w > prev, `L${L} d${d.toFixed(1)}: on-screen width ${w.toFixed(3)} ≤ ${prev.toFixed(3)}`);
      prev = w;
    }
  }
});

test('sprites are seated like the base scene: anchor column on the footprint centre, cell bottom on its south edge', () => {
  const d = get('crownlands', 12, 0);
  for (const s of d.sprites.filter(s => s.kind === 'building')) {
    const off = s.fam === 'mine' ? WARE_WORLD_PRESENTATION.mine.offsetGamePx[0] / 32 : 0;
    assert.equal(s.tx, s.fx + s.fp[0] / 2 + off, `${s.key} x seat`);
    assert.equal(s.ty, s.fy + s.fp[1], `${s.key} cell bottom`);
    assert.equal(s.anchor[1], s.cell[1], `${s.key}: the anchor row is the cell bottom`);
    assert.equal(s.z, s.ty, 'depth = the footprint south edge');
  }
  assert.deepEqual([d.keep.tx, d.keep.ty, d.keep.fx, d.keep.fy], [49, 50, 48, 48], 'keep v1 [48,50)² seated on y 50');
  const e = keepExtents(1);
  assert.ok(Math.abs(e.w - 1.58) < 0.01 && Math.abs(e.h - 1.68) < 0.01, 'L1 keep ink 1.58×1.68 t at sourceScale 0.625');
});

test('every MAP mini-sprite sits at exactly its TRUE instance\'s seat (the impostor dissolves in place)', () => {
  for (const realmId of REALMS) for (const L of [1, 5, 9, 13, 17, 20]) for (const f of FORMS) {
    const d = get(realmId, L, f), m = miniSprites(d), t = d.sprites.filter(s => s.kind !== 'fx');
    assert.equal(m.length, t.length);
    m.forEach((s, i) => assert.deepEqual([s.key, s.tx, s.ty, s.z], [t[i].key, t[i].tx, t[i].ty, t[i].z]));
  }
});

test('deterministic: the same base always composes the same kingdom; the formation moves buildings, the seed farms the ring', () => {
  const a = composeBaseDecor({ level: 13, realmId: 'cinderfall', seed: 12345 }), b = composeBaseDecor({ level: 13, realmId: 'cinderfall', seed: 12345 });
  assert.deepEqual(a, b);
  const c = composeBaseDecor({ level: 13, realmId: 'cinderfall', seed: 12345 + 4 });
  const kingdom = d => d.sprites.filter(s => s.kind === 'building' || ['banner', 'light', 'brazier', 'torch'].includes(s.role)).map(({ phase, ...s }) => s);
  assert.deepEqual(kingdom(c), kingdom(a), 'seeds of one formation share the kingdom (buildings, fixtures)');
  assert.deepEqual(c.walls, a.walls);
  const ringOf = d => JSON.stringify(d.sprites.filter(s => !kingdom(d).some(k => k.key === s.key && k.fx === s.fx && k.fy === s.fy)).map(s => [s.key, s.fx, s.fy]));
  assert.notEqual(ringOf(c), ringOf(a), 'but two neighbours of one formation never farm alike (the ring is laid out per seed)');
  assert.equal(seedOf('abc'), seedOf('abc'));
  assert.equal(seedOf(42), seedOf(42));
  assert.notEqual(seedOf(42), seedOf(43));
});

test('every realm dresses its kingdoms from its own kit (C9), with fields and camp life at every level', () => {
  for (const realmId of REALMS) for (const L of LEVELS) {
    const d = get(realmId, L, 0), roles = new Set(d.sprites.map(s => s.role));
    for (const r of ['banner', 'crops', 'campfire', 'hay']) assert.ok(roles.has(r), `${realmId} L${L} has ${r}`);
    if (L >= 6) assert.ok(d.patches.some(p => p.kind === 'pen') && roles.has('livestock') && d.edges.some(e => e.style === 'pen'), `${realmId} L${L} a fenced pen with livestock`);
    if (L >= 10) assert.ok(roles.has('orchard'), `${realmId} L${L} orchard`);
    if (L >= 13) assert.ok(roles.has('torch'), `${realmId} L${L} torches`);
    const ids = new Set(Object.values(KIT_DRESSING[realmId]).flatMap(v => (Array.isArray(v) ? v : Object.values(v))));
    for (const s of d.sprites.filter(s => s.atlas === 'kit' || s.atlas === 'creature')) assert.ok(ids.has(s.key.slice(4)), `${realmId}: ${s.key} is not in its dressing table`);
    const edge = edgeSprites(d), seen = new Set();
    for (const s of edge) for (const [x, y] of tilesOf(s.fx, s.fy, s.fp[0], s.fp[1])) { assert.ok(!seen.has(x + ',' + y), `${realmId} L${L} edge tile twice`); seen.add(x + ',' + y); }
  }
});

// Fix iteration 1 (QA: "the farmland is stamped — four fields at the four corners and the same cross-path template,
// notched rectangles, Frostveil fields carry pumpkins and hay bales"): the rule was "2 fields at L1, 3+ from L2, one
// per ring quarter"; it is now "a per-seed count whose range grows with the level, in per-seed slots, so each kingdom
// leaves different land wild; patches are ellipse unions (never a box, never a notched box); crops are the realm's own".
test('the ring is farmland laid out per base: organic patches of varied crops, never a pasted box of rows (T3)', () => {
  for (const realmId of REALMS) for (const L of LEVELS) for (const seed of [1, 77, 4242]) {
    const d = composeBaseDecor({ level: L, realmId, seed }), tag = `${realmId} L${L} s${seed}`, fields = d.patches.filter(p => p.kind === 'field');
    const [lo, hi] = L <= 1 ? [1, 2] : L <= 5 ? [1, 3] : L <= 11 ? [2, 3] : L <= 16 ? [2, 4] : [3, 4];
    assert.ok(fields.length >= lo && fields.length <= hi, `${tag}: ${fields.length} fields (the ladder: ${lo}–${hi} at L${L})`);
    if (fields.length >= 2) assert.equal(new Set(fields.map(f => f.crop)).size, fields.length, `${tag}: every field of a base grows its own crop`);
    for (const f of fields) assert.ok(KIT_DRESSING[realmId].crops.includes(f.crop), `${tag}: ${f.crop} is not a ${realmId} crop`);
    const byPatch = new Map(); for (const c of d.ground) if (c.k === 0) byPatch.set(c.p, [...(byPatch.get(c.p) ?? []), c]);
    for (const [p, cells] of byPatch) {                    // organic: never a filled or notched rectangle (≤ 90 % of its box)
      const xs = cells.map(c => c.x), ys = cells.map(c => c.y), area = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
      assert.ok(cells.length <= area * 0.9, `${tag}: field ${p} fills ${(cells.length / area * 100).toFixed(0)} % of its box — a notched rectangle`);
    }
    assert.ok(d.sprites.some(s => s.role === 'crops'), `${tag}: crops planted`);
  }
  // not stamped: across kingdoms of one level the number of fields, the sides they lie on and the laned sides differ
  for (const realmId of REALMS) for (const L of [2, 8, 14, 20]) {
    const sig = new Set(), wildSide = [];
    for (let seed = 0; seed < 16; seed++) {
      const gates = [['S'], ['E', 'N'], ['W'], ['S', 'E'], ['N'], ['W', 'S', 'E'], [], ['N', 'W']][seed % 8];   // as the links fall
      const d = composeBaseDecor({ level: L, realmId, seed: seed * 7919 + 13, gates }), sides = new Set(d.patches.filter(p => p.kind === 'field').map(p => p.seg[0]));
      sig.add([d.patches.filter(p => p.kind === 'field').length, [...sides].sort().join(''), Object.keys(d.lanes).sort().join('')].join('|'));
      wildSide.push(['N', 'S', 'W', 'E'].some(sd => !d.patches.some(p => p.kind === 'field' && p.seg[0] === sd)));
    }
    assert.ok(sig.size >= 8, `${realmId} L${L}: only ${sig.size} farm layouts in 16 kingdoms — stamped`);
    assert.ok(wildSide.filter(Boolean).length >= 4, `${realmId} L${L}: kingdoms leave some side without fields`);
  }
  // realm-true crops: Frostveil never plants pumpkins or hay bales in its fields
  for (const L of LEVELS) for (const seed of [0, 5, 9]) for (const s of composeBaseDecor({ level: L, realmId: 'frostveil', seed }).sprites)
    if (s.role === 'crops' || s.role === 'fieldFill') assert.ok(!/pumpkin|hay_bale|turnip_clamp/.test(s.key), `frostveil L${L}: ${s.key} in a field`);
  const a = composeBaseDecor({ level: 9, realmId: 'sunscar', seed: 8 }), b = composeBaseDecor({ level: 9, realmId: 'sunscar', seed: 12 });
  assert.notDeepEqual(a.ground, b.ground, 'two neighbours of one formation farm different shapes');
});

test('hedges and fences follow the patches (one loop each, from L8 for fields), never a fence box round the plot', () => {
  for (const realmId of REALMS) for (const L of LEVELS) for (const seed of [3, 99]) {
    const d = composeBaseDecor({ level: L, realmId, seed }), g = d.geometry, tag = `${realmId} L${L} s${seed}`;
    const hedgeLoops = new Set(d.edges.filter(e => e.style === 'hedge').map(e => e.loop)), penLoops = new Set(d.edges.filter(e => e.style === 'pen').map(e => e.loop));
    if (L < DECOR_LAYOUT.hedgeFrom) assert.equal(hedgeLoops.size, 0, `${tag}: open fields below L${DECOR_LAYOUT.hedgeFrom}`);
    if (L >= DECOR_LAYOUT.hedgeAllFrom) assert.equal(hedgeLoops.size, d.patches.filter(p => p.kind === 'field').length, `${tag}: every field hedged`);
    assert.equal(penLoops.size, d.patches.filter(p => p.kind === 'pen').length, `${tag}: every pen fenced`);
    const perim = 4 * (g.P1 - g.P0 - 1), onRim = d.edges.filter(e => e.x === g.P0 || e.y === g.P0 || e.x === g.P1 - 1 || e.y === g.P1 - 1).length;
    assert.ok(onRim < perim * 0.5, `${tag}: ${onRim}/${perim} plot-rim tiles fenced — reads as a box`);
  }
});

test('wild scatter thickens toward the plot edge so the kingdom melts into the wilderness', () => {
  let inner = 0, outer = 0;
  for (const realmId of REALMS) for (const L of [3, 8, 12, 20]) for (let seed = 0; seed < 6; seed++) {
    const d = composeBaseDecor({ level: L, realmId, seed }), g = d.geometry;
    for (const s of d.sprites) if (s.role?.startsWith('wild')) {
      const out = Math.max(g.A - 1 - s.fx, s.fx - g.B, g.A - 1 - s.fy, s.fy - g.B);
      if (out >= g.ring / 2) outer++; else inner++;
    }
  }
  assert.ok(outer > inner * 1.5, `outer ${outer} vs inner ${inner}`);
  assert.ok(inner + outer > 600, 'the ring carries real scatter, not a few polka dots');
});

test('paths join neighbouring kingdoms gate to gate and never cut through a kingdom (T3: bases join the world)', () => {
  const bases = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 7; i++) if ((i * 3 + j * 5) % 4) bases.push({ id: j * 7 + i, x: 3 + i * 2 - (j % 2), y: 4 + j * 2, level: 1 + ((i * 7 + j * 3) % 20) });
  const a = basePaths(bases), b = basePaths(bases);
  assert.deepEqual(a.segments, b.segments, 'deterministic');
  assert.ok(a.segments.length > bases.length, `${a.segments.length} path segments for ${bases.length} kingdoms`);
  const box = q => { const o = plotOffset(q.x, q.y, q.level), h = plotRule(q.level).plotTiles / 2 / TILES;
    return { cx: q.x + (PLOT_CENTRE + o.dx) / TILES, cy: q.y + (PLOT_CENTRE + o.dy) / TILES, h, seed: seedOf(q.id), ring: plotRule(q.level).ring }; };
  const boxes = bases.map(box), eps = 1e-9;
  for (const sg of a.segments) for (const p of [sg.a, sg.b]) for (const q of boxes) {
    const inside = Math.abs(p[0] - q.cx) < q.h - eps && Math.abs(p[1] - q.cy) < q.h - eps;
    assert.ok(!inside, `path point ${p} inside the kingdom at ${q.cx.toFixed(3)},${q.cy.toFixed(3)}`);
  }
  // every path starts on a gate: on a plot edge, on its (meandering) lane's centre line where it leaves the plot
  const ends = new Map(); for (const sg of a.segments) for (const p of [sg.a, sg.b]) { const k = p.join(); ends.set(k, (ends.get(k) ?? 0) + 1); }
  const tips = [...ends].filter(([, n]) => n === 1).map(([k]) => k.split(',').map(Number));
  const sh = (q, sd) => laneMeander(q.seed, sd, q.ring).end / TILES;
  for (const [x, y] of tips) assert.ok(boxes.some(q => (Math.abs(Math.abs(x - q.cx) - q.h) < 1e-9 && ['W', 'E'].some(sd => Math.abs(y - q.cy - sh(q, sd)) < 1e-9)) || (Math.abs(Math.abs(y - q.cy) - q.h) < 1e-9 && ['N', 'S'].some(sd => Math.abs(x - q.cx - sh(q, sd)) < 1e-9))), `path end ${x},${y} is not a gate`);
  // nobody within the path range is left without a road
  for (const q of bases) {
    const c = box(q), nearest = Math.min(...bases.filter(o => o !== q).map(o => { const d = box(o); return Math.hypot(d.cx - c.cx, d.cy - c.cy); }));
    if (nearest <= PATHS.secondDeeds) assert.ok(a.sides.get(String(q.id))?.size, `kingdom ${q.id} (nearest neighbour ${nearest.toFixed(2)} deeds) has no road`);
  }
});

// Fix iteration 1 (QA: "paths run straight into the sea and across lava, ending at the shoreline without a ford or
// bridge"): wet tiles are impassable except on a designed crossing, so no road ever reads as walking into the water.
test('paths over terrain: bridged where a short run of water or lava crosses, forded without a bridge piece, dropped over open water', () => {
  const river = (x, y) => (x >= 200 && x < 204 ? 2 : 4), sea = (x, y) => (x >= 200 && x < 240 ? 1 : 4);   // a 4-tile river / a 40-tile strait
  const pts = [[1.7, 3.1], [2.3, 3.05], [2.9, 3.2]];                                                   // deed units: x 166.6 → 284.2 tiles
  const wetOn = (sg, cls) => { const n = 24; for (let i = 0; i <= n; i++) { const x = (sg.a[0] + (sg.b[0] - sg.a[0]) * i / n) * TILES, y = (sg.a[1] + (sg.b[1] - sg.a[1]) * i / n) * TILES; if (cls(Math.floor(x), Math.floor(y)) <= 2) return true; } return false; };
  const br = settlePath(pts, river, { bridge: true });
  assert.ok(br && br.crossings.length === 1 && br.crossings[0].axis === 'ew' && br.crossings[0].kind === 'bridge', 'one bridge over the river');
  const wetSegs = br.segments.filter(sg => wetOn(sg, river));
  assert.equal(wetSegs.length, 1, 'only the bridge span stands over the water');
  assert.ok(Math.abs(wetSegs[0].a[1] - wetSegs[0].b[1]) < 1e-9, 'the span runs straight along its axis (the bridge pieces lie on it)');
  const piece = bridgePiece('sunscar', 'ew'), seats = bridgeSeats(br.crossings[0], piece);
  const cover = [Math.min(...seats.map(s => s.tx - piece.fp[0] / 2)), Math.max(...seats.map(s => s.tx + piece.fp[0] / 2))];
  assert.ok(cover[0] <= 200 && cover[1] >= 204, `the bridge pieces span the river bank to bank (${cover})`);
  const fd = settlePath(pts, river, { bridge: false });
  assert.ok(fd && fd.crossings[0].kind === 'ford' && fd.segments.filter(sg => sg.ford).length === 1, 'a realm without a bridge piece fords a shallow run');
  assert.equal(settlePath(pts, sea, { bridge: true }), null, 'open water is never crossed: the link is dropped');
  assert.equal(settlePath(pts, (x, y) => (x >= 200 && x < 208 ? 2 : 4), { bridge: false }), null, 'too wide to ford');
  const dry = settlePath(pts, () => 4);
  assert.equal(dry.crossings.length, 0);
  assert.deepEqual(dry.segments.map(sg => [sg.a, sg.b]), [[pts[0], pts[1]], [pts[1], pts[2]]].map(([a, b]) => [a.map(v => v * TILES / TILES), b.map(v => v * TILES / TILES)]), 'dry land keeps the curve');
  for (const realmId of ['sunscar', 'frostveil', 'cinderfall', 'crownlands']) assert.ok(bridgePiece(realmId, 'ew') && bridgePiece(realmId, 'ns'), `${realmId} has kit bridge pieces`);
  assert.equal(bridgePiece('stormcairn', 'ew'), null, 'Stormcairn fords');
  assert.ok(PATH_TERRAIN.maxFord < PATH_TERRAIN.maxBridge);
});

// ---- demo population ------------------------------------------------------------------------------------
function synthRealm(cols = 140, rows = 100) {            // an irregular island of own deeds + a neighbour realm
  const px = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const u = (x - 70) / 60, v = (y - 50) / 40, wob = 0.12 * Math.sin(x * 0.21) + 0.1 * Math.cos(y * 0.33);
    if (u * u + v * v < 1 + wob) px[y * cols + x] = 255; else if (x > 125) px[y * cols + x] = 96;
  }
  return { meta: { grid: { cols, rows } }, px };
}
test('demo population: ~24 % of own deeds, clustered, levels skewed low, some shielded, exactly one base is yours', () => {
  const { meta, px } = synthRealm(), bases = demoBases(meta, px), own = px.filter(v => v === 255).length;
  assert.equal(bases.length, Math.round(own * DEMO.occupancy));
  const keys = new Set(bases.map(b => b.y * 140 + b.x));
  assert.equal(keys.size, bases.length, 'one base per deed');
  assert.ok(bases.every(b => px[b.y * 140 + b.x] === 255), 'bases stand only on this realm\'s deeds');
  assert.ok(bases.every(b => Number.isInteger(b.level) && b.level >= 1 && b.level <= 20));
  const lv = bases.map(b => b.level).sort((a, b) => a - b), median = lv[lv.length >> 1];
  assert.ok(median <= 7 && lv.at(-1) >= 17, `levels skew low with a few citadels (median ${median})`);
  const sh = bases.filter(b => b.shield === true).length / bases.length;
  assert.ok(sh > 0.1 && sh < 0.35, `shield share ${sh}`);
  const mine = bases.filter(b => b.mine);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].level, DEMO.myLevel);
  const nb = bases.filter(b => !b.mine).sort((a, b) => ((a.x - mine[0].x) ** 2 + (a.y - mine[0].y) ** 2) - ((b.x - mine[0].x) ** 2 + (b.y - mine[0].y) ** 2))[0];
  assert.equal(nb.shield, true, 'your nearest neighbour is shielded (V4 shows a dome)');
  assert.ok(bases.some(b => b.clan && b.clan === mine[0].clan && !b.mine), 'you have clan-mates for the Clan filter');
  // clustered: the mean nearest-neighbour distance is well below a uniform scatter's
  const nn = bases.slice(0, 300).map(a => Math.min(...bases.filter(b => b !== a).map(b => Math.hypot(a.x - b.x, a.y - b.y))));
  assert.ok(nn.reduce((s, v) => s + v, 0) / nn.length < 1.6, 'bases cluster into settlements');
  assert.deepEqual(demoBases(meta, px), bases, 'deterministic');
});

test('demo settlements are never a solid block: dense zones stay ≈ 35–45 % claimed with hashed fallow deeds; V8 has a river base', () => {
  // QA critical 1 (fix iteration 2): the hub walk filled every deed of a settlement, so the MAP band showed a lattice
  const { meta, px } = synthRealm(), bases = demoBases(meta, px), cols = 140, at = new Set(bases.map(b => b.y * cols + b.x));
  const share = bases.map(b => { let n = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) n += at.has((b.y + dy) * cols + b.x + dx) ? 1 : 0; return n / 25; }).sort((a, c) => a - c);
  assert.ok(share[share.length >> 1] <= 0.45, `median 5×5 share ${share[share.length >> 1]}`);
  assert.ok(share.at(-1) <= (DEMO.localCap + 9) / 25, `densest 5×5 window ${share.at(-1)}`);
  for (const b of bases) { let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += at.has((b.y + dy) * cols + b.x + dx) ? 1 : 0; assert.ok(n < 9, `a full 3×3 block at ${b.x},${b.y}`); }
  // a lane is laid only toward a path (no stub into open land), so the thinner settlements must still be joined:
  // a kingdom with no pair within maxDeeds walks on to a neighbour up to loneDeeds — ≤ 1 % are left roadless, never yours
  const pth = basePaths(bases), lone = bases.filter(b => !pth.sides.get(String(b.id))?.size);
  assert.ok(lone.length <= bases.length * 0.01, `${lone.length} of ${bases.length} kingdoms have no road`);
  assert.ok(!lone.some(b => b.mine), 'your own kingdom always has a road');
  // V8 (a base whose plot sits in a river) needs a target on every realm: Crownlands' river deed is always claimed
  const cr = demoBases({ ...meta, id: 'crownlands' }, px), mo = DEMO.moat.crownlands;
  assert.ok(cr.some(b => b.x === mo.x && b.y === mo.y), 'Crownlands claims its river deed (a base stands on it)');
  assert.equal(new Set(cr.map(b => b.y * cols + b.x)).size, cr.length, 'still one base per deed');
});

test('attackable: not yours, not shielded, within ±3 levels of yours', () => {
  const b = withAttackable([{ mine: true, level: 9, shield: true }, { level: 12, shield: false }, { level: 13, shield: false }, { level: 6, shield: true }, { level: 6, shield: null }]);
  assert.deepEqual(b.map(x => x.attackable), [false, true, false, false, true]);
});

test('the QA ladder puts L1, L3, L5, L9, L13, L17, L20 on seven consecutive own deeds near your base', () => {
  const { meta, px } = synthRealm(), bases = ladderBases(demoBases(meta, px), meta, px);
  const row = bases.filter(b => b.name.startsWith('Ladder')).sort((a, b) => a.x - b.x);
  assert.deepEqual(row.map(b => b.level), DEMO.ladder);
  assert.ok(row.every((b, i) => b.y === row[0].y && b.x === row[0].x + i));
  assert.equal(new Set(bases.map(b => b.y * 140 + b.x)).size, bases.length);
});

// ---- bases.mjs pure parts: band switching, picking, shield caps, the pixel-art reducer ------------------------
import { baseMode, pickBase, capShields, reduceMode, BASES_LIMITS, iconLook, frameWork } from './bases.mjs';

test('marker icons read as growth and neighbours differ: size grows with the level, towers and banners from L12 vary per seed', () => {
  // QA critical 1 (fix iteration 2): at d 49–150 a dense settlement was "210 identical keep icons in rows" — a diagram
  for (let seed = 0; seed < 40; seed++) {
    let prev = 0;
    for (let L = 1; L <= 20; L++) {
      const k = iconLook(L, seed);
      assert.ok(k.css >= BANDS.keepMinCss, `L${L}: never under the ${BANDS.keepMinCss}-px tap floor`);
      assert.ok(k.css >= prev - 1e-9, `seed ${seed}: the icon never shrinks as the level rises (L${L})`); prev = k.css;
      assert.equal(k.towers === 0, L < 12, `L${L}: companion towers exactly from L12`);
      assert.ok(k.tips.length >= 1 && k.tips.every(t => t >= 0 && t < 4), 'a banner on a real spire');
    }
  }
  assert.ok(iconLook(20, 7).css > iconLook(1, 7).css * 1.25, 'a citadel icon is clearly bigger than a founding camp');
  for (const L of [12, 15, 18, 20]) {
    const looks = new Set(Array.from({ length: 16 }, (_, seed) => { const k = iconLook(L, seed * 7919 + 13); return `${k.towers}|${k.tower}|${k.first}|${Math.round(k.css)}`; }));
    assert.ok(looks.size >= 8, `L${L}: only ${looks.size} icon silhouettes in 16 kingdoms — identical rows`);
  }
});

test('each base switches dot → icon → live keep by its own hash, whole, and never switches back while zooming in', () => {
  assert.equal(baseMode(10, 20, 0.5, 0.5), 'dot');                 // FAR
  assert.equal(baseMode(60, 120, 0.99, 0.99), 'icon');             // marker mode (s ≥ 48, d < 200)
  assert.equal(baseMode(150, 300, 0, 0), 'keep');                  // d ≥ 280: live keep for everyone
  const hs = Array.from({ length: 2000 }, (_, i) => [(i * 0.6180339887) % 1, (i * 0.7548776662) % 1]);
  for (const dpr of [1, 2]) {
    let prev = hs.map(() => 0);
    for (let s = 5; s <= 400; s *= 1.03) {
      const d = s * dpr, rank = { dot: 0, icon: 1, keep: 2 };
      const now = hs.map(([a, b]) => rank[baseMode(s, d, a, b)]);
      now.forEach((m, i) => assert.ok(m >= prev[i], `base ${i} went back from ${prev[i]} to ${m} at s ${s.toFixed(1)} dpr ${dpr}`));
      prev = now;
      if (d > 200 && d < 280 && s >= 48) { const f = now.filter(m => m === 2).length / hs.length, w = (d - 200) / 80; assert.ok(Math.abs(f - w) < 0.05, `icon→keep ramp ${f} vs ${w}`); }
    }
  }
});

test('picking: the nearest keep under the finger wins, then a dome ground ellipse, else the deed cell (null)', () => {
  const A = { id: 'a' }, B = { id: 'b' }, C = { id: 'c' };
  const rects = [{ b: A, x0: 0, x1: 40, y0: 0, y1: 40, depth: 10.5 }, { b: B, x0: 20, x1: 60, y0: 10, y1: 50, depth: 10.6 }];
  const domes = [{ b: C, sx: 200, sy: 200, rx: 50, ry: 27.5 }];
  assert.equal(pickBase(rects, domes, 10, 10), A);
  assert.equal(pickBase(rects, domes, 30, 30), B, 'overlap: the keep seated further south is drawn in front and wins');
  assert.equal(pickBase(rects, domes, 240, 210), C, 'inside the dome ground ellipse');
  assert.equal(pickBase(rects, domes, 200, 170), null, 'above the ellipse but outside every keep: falls through to the deed cell');
  assert.equal(pickBase([], [], 5, 5), null);
});

test('shield domes are capped (≤ 40 at MAP, ≤ 8 at TRUE), your own always kept, then the nearest', () => {
  const list = Array.from({ length: 60 }, (_, i) => ({ b: { mine: i === 59 }, dist: i }));
  const map = capShields(list, 1), tru = capShields(list, 2);
  assert.equal(map.length, BASES_LIMITS.shield.mapCap); assert.equal(tru.length, BASES_LIMITS.shield.trueCap);
  assert.ok(tru[0].b.mine && map[0].b.mine, 'yours first');
  assert.deepEqual(tru.slice(1).map(x => x.dist), [0, 1, 2, 3, 4, 5, 6]);
});

test('the pixel-art reducer keeps the palette, the silhouette rule and no dark bias', () => {
  const px = (w, h, f) => { const a = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set(f(x, y), (y * w + x) * 4); return a; };
  const red = [200, 40, 40, 255], blue = [40, 40, 200, 255], clear = [0, 0, 0, 0], ink = [10, 10, 10, 255];
  // 3 red + 1 clear → opaque red; 1 red + 3 clear → transparent
  let r = reduceMode(px(2, 2, (x, y) => (x === 1 && y === 1 ? clear : red)), 2, 2, 2);
  assert.deepEqual([...r.px], red);
  r = reduceMode(px(2, 2, (x, y) => (x === 0 && y === 0 ? red : clear)), 2, 2, 2);
  assert.equal(r.px[3], 0);
  // four different colours: the first in scan order wins, not the darkest (dark bias turned sprites into blobs)
  r = reduceMode(px(2, 2, (x, y) => [red, blue, ink, [220, 200, 60, 255]][y * 2 + x]), 2, 2, 2);
  assert.deepEqual([...r.px.slice(0, 3)], red.slice(0, 3));
  // palette-preserving at a non-integer ratio (7× map-art reduction of a 64-px prop)
  const src = px(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 3 === 0 ? red : ((x >> 2) % 2 ? blue : clear));
  r = reduceMode(src, 64, 64, 7);
  assert.deepEqual([r.w, r.h], [10, 10]);
  const pal = new Set([red, blue].map(c => c.slice(0, 3).join()));
  for (let i = 0; i < r.px.length; i += 4) if (r.px[i + 3]) assert.ok(pal.has([r.px[i], r.px[i + 1], r.px[i + 2]].join()), 'only source colours');
});

test('ART plot-edge autotile: one piece per edge tile whose arms are exactly its edge neighbours, gates as end pieces', () => {
  for (const realmId of REALMS) for (const L of [1, 6, 12, 20]) {
    const d = get(realmId, L, 0), on = new Set(d.edges.map(e => e.x + ',' + e.y)), sp = edgeAutotileSprites(d);
    assert.equal(sp.length, d.edges.length);
    sp.forEach((s, i) => {
      const { x, y } = d.edges[i], arms = s.key.slice(5);
      const want = (on.has(`${x},${y - 1}`) ? 'N' : '') + (on.has(`${x + 1},${y}`) ? 'E' : '') + (on.has(`${x},${y + 1}`) ? 'S' : '') + (on.has(`${x - 1},${y}`) ? 'W' : '');
      assert.equal(arms, want || 'post', `${realmId} L${L} ${x},${y}`);
      assert.ok(EDGE_ARMS.includes(arms));
      assert.deepEqual([s.tx, s.ty, s.anchor[1], s.cell[1]], [x + 0.5, y + 1, 48, 48], 'top-left at (tx·32, ty·32 − 16)');
    });
    // every hedge / fence is one loop with exactly one gate: two end pieces, never a lone post
    const loops = new Map(); for (const e of d.edges) loops.set(e.loop, [...(loops.get(e.loop) ?? []), e]);
    for (const [id, l] of loops) {
      const arms = l.map(e => EDGE_ARMS[e.mask]);
      assert.equal(arms.filter(a => a.length === 1).length, 2, `${realmId} L${L} loop ${id}: one gate (two end pieces)`);
      assert.ok(!arms.includes('post'), `${realmId} L${L} loop ${id}: no lone post`);
    }
  }
});

// P0 (RM-GPU-1, 2026-09-24: a realm-map shader hung the owner's whole Mac GPU): a fragment shader runs for every
// covered pixel (~4 M at dpr 2), so a loop whose trip count comes from data (a base list, a segment count, a
// uniform) can stall the GPU until the OS kills it. BASES' and the shield's shaders may only loop a small
// literal number of times, never `while` / `do`, and never over a base list (instancing draws one base per quad).
test('P0: bases + shield shaders loop only a small literal number of times (no data-driven or while loops)', async () => {
  const mods = [await import('./glsl/bases.glsl.mjs'), await import('./glsl/shield.glsl.mjs')];
  let n = 0, loops = 0;
  for (const m of mods) for (const [name, src] of Object.entries(m)) {
    if (typeof src !== 'string') continue;
    n++;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bwhile\b|\bdo\s*\{/.test(code), `${name}: while / do loop`);
    for (const hdr of code.match(/\bfor\s*\([^)]*\)/g) || []) {
      loops++;
      const mm = hdr.match(/^for\s*\(\s*int\s+(\w+)\s*=\s*\d+\s*;\s*(\w+)\s*(<=?)\s*(\d+)\s*;\s*(\w+)\s*\+\+\s*\)$/);
      assert.ok(mm && mm[2] === mm[1] && mm[5] === mm[1], `${name}: loop header is not 'for (int i = 0; i < LITERAL; i++)': ${hdr}`);
      assert.ok(+mm[4] <= 16, `${name}: loop bound ${mm[4]} > 16 per pixel`);
    }
  }
  assert.ok(n >= 10, `found ${n} shader sources`);        // SPRITE/DOT/FX/FIELD VS+FS, SHIELD VS+FS
  assert.ok(loops <= 2, `${loops} loops across the bases + shield shaders`);
});

// P0 rerun (owner 2026-09-24 "it's freezing again"): a literal loop bound is not enough when a shader pulls in
// GROUND's classifier — `#include "classes"` + classAtTile ran the whole §3.2 class resolve (3×3 neighbour loops,
// page samples, noise) for every path pixel near a shore, the most expensive call in the engine made per pixel.
// BASES decides where a path meets water once, on the CPU (settlePath), and the shader only reads the flag.
test('P0: no bases / shield shader reads GROUND terrain per pixel; path crossings arrive flagged from the CPU', async () => {
  const mods = [await import('./glsl/bases.glsl.mjs'), await import('./glsl/shield.glsl.mjs')];
  for (const m of mods) for (const [name, src] of Object.entries(m)) {
    if (typeof src !== 'string') continue;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/#include\s+"(classes|rm-classify|rm-fields)"/.test(code), `${name}: includes GROUND's classifier`);
    assert.ok(!/\b(classAtTile|rmClassAt\w*|mapClassAt|tileRecord|plotSdf|rmPlotSdf\w*|rmLine\w*|walkable)\s*\(/.test(code), `${name}: per-pixel terrain read`);
  }
  // the flags the shader relies on: the ONLY span over water is the flagged crossing, and a ford's water lies inside
  // [0.5, len − 0.5] of its span (the shader draws stones exactly there, path on the banks)
  const river = (x, y) => (x >= 200 && x < 204 ? 2 : 4), pts = [[1.7, 3.1], [2.3, 3.05], [2.9, 3.2]];
  for (const bridge of [true, false]) for (const shift of [0, 0.3, 0.55, 0.8]) {
    const r = settlePath(pts.map(p => [p[0] + shift / TILES, p[1]]), river, { bridge });
    assert.ok(r, `settled (bridge ${bridge}, shift ${shift})`);
    for (const sg of r.segments) {
      const len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) * TILES, n = Math.ceil(len * 20);
      const wetAl = [];
      for (let i = 0; i <= n; i++) { const al = (len * i) / n, x = (sg.a[0] + (sg.b[0] - sg.a[0]) * i / n) * TILES, y = (sg.a[1] + (sg.b[1] - sg.a[1]) * i / n) * TILES; if (river(Math.floor(x), Math.floor(y)) <= 2) wetAl.push(al); }
      if (!wetAl.length) { assert.ok(!sg.ford && !sg.bridge, 'a dry span is not flagged'); continue; }
      assert.ok(bridge ? sg.bridge && !sg.ford : sg.ford && !sg.bridge, `the span over water is the flagged ${bridge ? 'bridge' : 'ford'}`);
      if (!bridge) assert.ok(Math.min(...wetAl) >= 0.5 && Math.max(...wetAl) <= len - 0.5, `ford water inside its stone interval (${Math.min(...wetAl).toFixed(2)}..${Math.max(...wetAl).toFixed(2)} of ${len.toFixed(2)})`);
    }
  }
});

// P0 fix pass (RM-GPU-1 gate, D-167 "no main-thread stall > 50 ms"): the JS frame p95 was 57–66 ms at MAP d 400 and
// TRUE. BASES did its band-change work in lumps — the whole kingdom path network in ONE frame the first time the camera
// reached d 150 (65–250 ms: 3.1–3.7k kingdoms, ~3k links, measured on the real deeds), then 6 per-base decor builds a
// frame (up to ~14 ms each on efficiency cores) plus 5 ms of link settling on top. It now runs as small units under ONE
// per-frame budget (BASES_LIMITS.workMs), so a frame stops between any two units and the work spreads over frames.
test('P0: band-change work runs under one per-frame budget, one unit over at most, and always finishes', () => {
  assert.ok(BASES_LIMITS.workMs >= 4 && BASES_LIMITS.workMs <= 8, `per-frame work budget ${BASES_LIMITS.workMs} ms (task: 4–8 ms)`);
  let t = 0; const w = frameWork(BASES_LIMITS.workMs, () => t);
  // a mixed queue like a band change: many tiny path steps, a few 3–14 ms decor builds, some 2-ms link settles
  const units = [...Array(400).fill(0.02), 14, 3, 3, 9, ...Array(30).fill(2), 14, 14, 3];
  const total = units.reduce((a, c) => a + c, 0), maxUnit = Math.max(...units);
  let i = 0, frames = 0, worst = 0;
  while (i < units.length) {
    assert.ok(frames++ < 500, 'the queue drains');
    w.begin(); const t0 = t;
    while (i < units.length && w.more()) { w.spend(); t += units[i++]; }
    assert.ok(t > t0, 'every frame makes progress, even when its first unit alone is over budget');
    worst = Math.max(worst, t - t0);
  }
  assert.ok(worst <= BASES_LIMITS.workMs + maxUnit, `a frame spends at most the budget plus one unit (${worst.toFixed(2)} ms)`);
  assert.ok(frames <= Math.ceil(total / BASES_LIMITS.workMs) + units.filter(u => u > BASES_LIMITS.workMs).length + 1, `${frames} frames for ${total.toFixed(1)} ms of work`);
  // the budget is per frame: a spent budget does not carry into the next frame's first unit, and time outside the frame is free
  w.begin(); w.spend(); t += 100; assert.equal(w.more(), false, 'over budget: the frame stops'); w.begin(); assert.equal(w.more(), true, 'a new frame starts fresh');
  // the frame's other work (list building) may already have used the budget: one unit still runs, so the queue never stalls
  w.begin(); t += 50; assert.equal(w.more(), true, 'progress guarantee'); w.spend(); t += 1; assert.equal(w.more(), false, 'then the frame stops');
});
test('P0: the path network builds in small steps a frame can stop between, and is the same network however it is sliced', () => {
  const { meta, px } = synthRealm(), bases = demoBases(meta, px), whole = basePaths(bases);
  assert.ok(whole.links.length > 200, `${whole.links.length} links (a realistic network)`);
  const job = basePathsJob(bases); let steps = 0, r;
  while (!(r = job.next()).done) steps++;
  assert.deepEqual(r.value.segments, whole.segments, 'sliced = whole: segments');
  assert.deepEqual(r.value.links, whole.links, 'sliced = whole: links');
  assert.deepEqual([...r.value.sides].map(([k, v]) => [k, [...v]]), [...whole.sides].map(([k, v]) => [k, [...v]]), 'sliced = whole: laned sides');
  // it yields after every kingdom's neighbour search AND every link attempt (≥ one per link made): no step walks a whole realm
  assert.ok(steps >= bases.length + whole.links.length, `${steps} steps for ${bases.length} kingdoms + ${whole.links.length} links`);
  // bases.mjs never builds the network in one go (the 65–250 ms frame this fix removes)
  const src = readFileSync(new URL('./bases.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bbasePaths\s*\(/.test(src), 'bases.mjs calls the one-shot basePaths()');
  assert.ok(/\bbasePathsJob\s*\(/.test(src), 'bases.mjs runs basePathsJob');
});

// ---- W1 B1 (RM-GPU-1 follow-up): the band rehearsal builds every BASES pipeline at FAR, art or not ----------------
// Why: a GPU pipeline is built at a program's FIRST DRAW, not at link. SHELL's band rehearsal pre-draws each program
// at FAR, so a band change never blocks on the build (P0 gate 2 on SwiftShader: 14.6–18.7 s at MAP d 150). Two BASES
// defects kept the work at the band change:
//   (1) in the product, the art loads during the dive, and BASES' hook returned false until the art was in. SHELL gave
//       up after 4 tries, so bases-sprite, -shield and -fx first drew at MAP d 150 (long tasks of 10.7 + 6.6 s);
//   (2) each rehearsal draw was a zeroed, degenerate instance that shaded no fragment. Work the driver defers to the
//       first shaded fragment was still done at the band change: SwiftShader's sampling routines, and possibly
//       tile-based mobile drivers' deferred work.
// So the hook needs no art: it binds placeholders of the real samplers' type. Each draw covers the whole bound
// viewport, whatever small target SHELL binds, at a depth that passes. It draws every GL state its real draws use,
// and it uploads nothing.
import { createBases, BASES_GL, REHEARSAL } from './bases.mjs';
import { UBO_VIEW } from './contracts.mjs';
import * as BASES_GLSL from './glsl/bases.glsl.mjs';
import * as SHIELD_GLSL from './glsl/shield.glsl.mjs';
import { COMMON } from './glsl/common.glsl.mjs';

function fakeBasesCore() {
  const C = { DEPTH_TEST: 0xb71, BLEND: 0xbe2, LEQUAL: 0x203, ONE: 1, ONE_MINUS_SRC_ALPHA: 0x303, TRIANGLES: 4, ARRAY_BUFFER: 0x8892, UNIFORM_BUFFER: 0x8a11,
    FLOAT: 0x1406, DYNAMIC_DRAW: 0x88e8, STATIC_DRAW: 0x88e4, TEXTURE0: 0x84c0 };
  const S = { depth: false, func: 0, mask: true, blend: false, bf: null, vao: null, ubo: null, unit: 0, units: {} };
  const draws = [], uploads = [], made = [], bound = {};
  let nid = 0, cur = null;
  const gl = { ...C,
    enable(c) { if (c === C.DEPTH_TEST) S.depth = true; if (c === C.BLEND) S.blend = true; },
    disable(c) { if (c === C.DEPTH_TEST) S.depth = false; if (c === C.BLEND) S.blend = false; },
    depthFunc(f) { S.func = f; }, depthMask(m) { S.mask = !!m; }, blendFunc(a, b) { S.bf = [a, b]; },
    createVertexArray: () => ({ id: ++nid, attribs: {} }), bindVertexArray(v) { S.vao = v; }, deleteVertexArray() {},
    createBuffer: () => ({ id: ++nid, data: null }), bindBuffer(t, b) { bound[t] = b; }, deleteBuffer() {},
    bufferData(t, d) { uploads.push('bufferData'); if (bound[t]) bound[t].data = Float32Array.from(new Float32Array(d.buffer, d.byteOffset, d.byteLength / 4)); },
    bufferSubData() { uploads.push('bufferSubData'); },
    bindBufferBase(t, i, b) { if (t === C.UNIFORM_BUFFER && i === UBO_VIEW) S.ubo = b; },
    enableVertexAttribArray() {}, vertexAttribDivisor() {},
    vertexAttribPointer(i, size, type, norm, stride, off) { S.vao.attribs[i] = { buf: bound[C.ARRAY_BUFFER], size, stride, off }; },
    activeTexture(u) { S.unit = u - C.TEXTURE0; }, bindTexture(t, x) { S.units[S.unit] = x; },
    useProgram() {}, uniform1i() {}, uniform1f() {}, uniform2f() {}, uniform3fv() {},
    drawArraysInstanced(mode, first, count, inst) {
      if (cur && !cur.drawn) cur.drawn = true;
      draws.push({ prog: cur?.name, depth: S.depth ? S.func : null, mask: S.mask, blend: !S.blend ? null : S.bf[1] === C.ONE ? 'add' : 'over',
        ubo: S.ubo, vao: S.vao, count, inst, samplers: { ...cur.samplers } });
    },
  };
  const frameUbo = { id: 'frame' };
  const program = (name) => {
    const p = { name, state: 'ready', drawn: false, samplers: {}, get ready() { return p.state === 'ready'; },
      use() { cur = p; return p; }, bindView() { gl.bindBufferBase(C.UNIFORM_BUFFER, UBO_VIEW, frameUbo); return p; },
      u: n => ({ n }), tex(n, unit, t) { gl.activeTexture(C.TEXTURE0 + unit); gl.bindTexture(t?.target, t); p.samplers[n] = t; return p; } };
    made.push(p); return p;
  };
  const tex = {
    array: (w, h, layers, format, o = {}) => ({ target: 'TEXTURE_2D_ARRAY', w, h, layers, format, levels: o.levels ?? 1, filter: o.filter ?? 'linear', texels: [] }),
    layer(o, i, src, rect, level = 0) { uploads.push('layer'); o.texels.push({ i, level, w: src.w, h: src.h, data: src.data }); },
    data: (w, h, format) => ({ target: 'TEXTURE_2D', w, h, format }), update() { uploads.push('update'); }, free(o) { if (o) o.freed = true; },
  };
  const core = { gl, program, tex, quadBuffer: { id: 'quad' }, invalidate() {}, animating() {}, dpr: 1 };
  return { core, gl, S, draws, uploads, made, frameUbo };
}
/** A pack whose art never arrives: load() waits on it forever, as in the product while the dive runs. */
const artlessPack = id => ({ id, meta: { id, grid: { cols: 8, rows: 8 }, sprites: { atlas: 's.png', rects: {} } }, first: { deeds: new Uint8Array(64) }, pixels: () => new Promise(() => {}) });

test('W1 B1: the band rehearsal draws every BASES program at FAR before its art is in, in each real GL state, on type-correct placeholders', async () => {
  const { core, S, draws, uploads, made, frameUbo } = fakeBasesCore();
  const bases = createBases(core, null);
  assert.equal(bases.rehearse({ name: 'bases-sprite', ready: true }), false, 'nothing to rehearse before load');
  void bases.load(artlessPack('frostveil'), null);
  await new Promise(r => setImmediate(r));
  assert.equal(bases.ready, false, 'the art is still loading');
  const progOf = Object.fromEntries(made.map(p => [p.name.replace('bases-', ''), p]));
  assert.deepEqual(Object.keys(progOf).sort(), ['dot', 'field', 'fx', 'shield', 'sprite']);
  // every BASES draw kind names a real program, and every program draws in at least one kind
  assert.deepEqual([...new Set(Object.values(BASES_GL).map(s => s[0]))].sort(), Object.keys(progOf).sort());
  // draw() sets GL state ONLY through BASES_GL (glState) and uses every kind, so the kinds the rehearsal draws are
  // exactly the states the real passes draw with
  const src = readFileSync(new URL('./bases.mjs', import.meta.url), 'utf8');
  const body = f => { const i = src.indexOf(`  function ${f}(`); return src.slice(i, src.indexOf('\n  }\n', i)); };
  const passes = body('draw') + body('drawShield') + body('drawList') + body('drawInst');
  assert.ok(!/gl\.(enable|disable)\(gl\.(BLEND|DEPTH_TEST)\)|gl\.blendFunc|gl\.depthMask|gl\.depthFunc/.test(passes), 'draw() sets blend/depth state outside glState()');
  const used = new Set([...passes.matchAll(/glState\(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1])));
  assert.deepEqual([...used].sort(), Object.keys(BASES_GL).sort(), 'draw() uses every BASES_GL kind and no other');
  // the samplers' real arrays (sprite atlases, minis, icons, road tiles): every core.tex.array in bases.mjs
  const real = [...src.matchAll(/core\.tex\.array\(([^;]*?)\{ (levels(?::[^}]*?)?), filter: '(\w+)' \}\)/g)].filter(m => !/\bT\.w\b/.test(m[1]));
  assert.ok(real.length >= 3, `${real.length} real sampler arrays found in bases.mjs`);
  for (const m of real) {
    assert.match(m[1], /'RGBA8'/, `a real array is not RGBA8: ${m[0]}`);
    assert.equal(m[3], REHEARSAL.tex.filter, `filter of ${m[0]}`);
    assert.match(m[2], /mipsOf|\blv\b|\blevels\b/, `a real array has a mip chain: ${m[0]}`);
  }
  const u0 = uploads.length;
  for (const [name, p] of Object.entries(progOf)) {
    const n0 = draws.length;
    // Stage B: every program DRAWS with the art still loading (its pipelines build at FAR, W1 B1); the two that sample
    // an array (sprite uTex, field uRoad) answer false so SHELL comes back once the real arrays are in (real-texture pass)
    assert.equal(bases.rehearse(p), name !== 'sprite' && name !== 'field', `${name}: rehearsed with the art still loading`);
    assert.ok(draws.length > n0, `${name}: drew on the placeholders while loading`);
    const mine = draws.slice(n0), want = Object.values(BASES_GL).filter(s => s[0] === name);
    assert.ok(mine.every(w => w.prog === p.name), `${name}: draws only itself`);
    const key = (depth, mask, blend) => `${depth ? 'LEQUAL' : 'off'}/${mask ? 'write' : 'nowrite'}/${blend}`;
    assert.deepEqual(mine.map(w => key(w.depth, w.mask, w.blend)).sort(), want.map(s => key(s[1], s[2], s[3])).sort(), `${name}: every GL state of its real draws, once`);
    assert.ok(mine.every(w => w.depth === null || w.depth === core.gl.LEQUAL), `${name}: depth func LEQUAL`);
    // its own view (the whole-viewport mapping), then the frame's view back for every later pass
    for (const w of mine) assert.deepEqual([...w.ubo.data], [...Float32Array.from(REHEARSAL.view), 0, 0, 0, 0], `${name}: drawn with the rehearsal view (uClock 0)`);
    assert.ok(mine.every(w => w.ubo !== frameUbo), `${name}: not the frame's view`);
    assert.equal(S.ubo, frameUbo, `${name}: the frame's RealmView is bound back`);
    // the instances: REHEARSAL's, in the vertex layout the shader declares (one per location 1..n), ≤ 2 per draw
    const A = REHEARSAL.attribs[name], vs = (name === 'shield' ? SHIELD_GLSL.SHIELD_VS : BASES_GLSL[`${name.toUpperCase()}_VS`]);
    assert.equal((vs.match(/layout\(location = [1-9]\) in vec4/g) || []).length, A, `${name}: ${A} vec4 instance attributes`);
    for (const w of mine) {
      assert.equal(w.count, 6, `${name}: one quad`);
      assert.ok(w.inst >= 1 && w.inst <= 2 && w.inst === REHEARSAL.inst[name].length / (A * 4), `${name}: ${w.inst} instances`);
      assert.equal(w.vao.attribs[1].stride, A * 16, `${name}: instance stride`);
      assert.deepEqual([...w.vao.attribs[1].buf.data], [...Float32Array.from(REHEARSAL.inst[name])], `${name}: the rehearsal instances`);
      assert.equal(w.vao.attribs[0].buf, core.quadBuffer, `${name}: the core quad corners`);
    }
    // every sampler the fragment shader declares is bound, to a placeholder of the real arrays' type
    const fs = (name === 'shield' ? SHIELD_GLSL.SHIELD_FS : BASES_GLSL[`${name.toUpperCase()}_FS`]);
    const samplers = [...fs.matchAll(/uniform\s+highp\s+(\w+)\s+(\w+);/g)].filter(m => /sampler/.test(m[1]));
    for (const w of mine) for (const [, type, n] of samplers) {
      const t = w.samplers[n];
      assert.ok(t, `${name}: sampler ${n} bound`);
      assert.equal(type, 'sampler2DArray'); assert.equal(t.target, 'TEXTURE_2D_ARRAY', `${name}: ${n} is a 2D array`);
      assert.equal(t.format, 'RGBA8'); assert.equal(t.filter, 'linear'); assert.ok(t.levels > 1, `${name}: ${n} has a mip chain (${t.levels})`);
      assert.equal(t.texels.length, t.layers * t.levels, `${name}: ${n} every layer and level filled`);
      assert.ok(t.texels.every(x => x.w === Math.max(1, t.w >> x.level) && x.data.every(v => v === 255)), `${name}: ${n} opaque white texels at each level's size`);
    }
  }
  assert.equal(uploads.length, u0, 'the rehearsal hook uploads nothing');
  assert.deepEqual(bases.stats().rehearsed, { sprite: 2, fx: 2, dot: 1, shield: 2, field: 1 });
  assert.deepEqual(bases.stats().rehearsedReal, { sprite: false, fx: false, dot: false, shield: false, field: false }, 'placeholders only while loading');
  // a program still linking, or not a BASES one, is not drawn
  progOf.dot.state = 'pending'; assert.equal(bases.rehearse(progOf.dot), false, 'still linking'); progOf.dot.state = 'ready';
  assert.equal(bases.rehearse({ name: 'rm-map', ready: true }), false, 'not a BASES program');
  // a realm switch frees the placeholders; the next load makes new ones before its art
  const t0 = draws.at(-1).samplers.uRoad ?? draws.find(w => w.samplers.uTex).samplers.uTex;
  bases.dispose(); assert.ok(t0.freed, 'dispose frees the placeholder arrays');
  assert.equal(bases.rehearse(progOf.sprite), false, 'nothing to rehearse after dispose');
});

test('W1 B1: every rehearsal draw shades the bound viewport: it covers all of it, passes the depth test and keeps its fragments', () => {
  // The models below mirror the vertex shaders' position maths and each fragment shader's early discard. The source
  // pins make any shader edit that invalidates them fail here.
  const code = s => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ');
  const pin = (src, frag, what) => assert.ok(code(src).includes(code(frag)), `${what}: the model below mirrors "${frag}"`);
  pin(COMMON, 'vec2 deedToCss(vec2 deed) { return (deed - uCam.xy) * uCam.z + uViewport.xy * 0.5; }', 'common');
  pin(COMMON, 'vec4 cssToClip(vec2 css, float depth) { return vec4(css.x / uViewport.x * 2.0 - 1.0, 1.0 - css.y / uViewport.y * 2.0, depth, 1.0); }', 'common');
  pin(COMMON, 'float t = clamp((footScreenY + uViewport.y) / (3.0 * uViewport.y), 0.0, 1.0); return (1.0 - t) * 1.96 - 0.98;', 'common spriteDepth');
  const { SPRITE_VS, SPRITE_FS, FX_VS, FX_FS, DOT_VS, DOT_FS, FIELD_VS, FIELD_FS } = BASES_GLSL, { SHIELD_VS, SHIELD_FS } = SHIELD_GLSL;
  pin(SPRITE_VS, 'if (kind < 0.5) on = dissolve(h, uTrueW); else if (kind < 1.5) on = !dissolve(h, uTrueW);', 'sprite VS');
  pin(SPRITE_VS, 'if (kind > 3.5 && kind < 4.5) {', 'sprite VS');
  pin(SPRITE_VS, 'vec2 sc = deedToCss(seat); vec2 p0 = sc + iQ.xy * k, p1 = sc + iQ.zw * k;', 'sprite VS');
  pin(SPRITE_VS, 'bool grow = kind > 0.5 && kind < 1.5', 'sprite VS'); pin(SPRITE_VS, '} else if (kind < 1.5 && hDev < uMinPx && !wallMini) {', 'sprite VS');
  pin(SPRITE_VS, 'float foot = deedToCss(vec2(iA.x, iA.z)).y; gl_Position = on ? cssToClip(mix(p0, p1, aCorner), spriteDepth(foot))', 'sprite VS');
  pin(SPRITE_VS, 'vUV = aCorner * iU.xy;', 'sprite VS');
  pin(SPRITE_FS, 'vec2 px = vUV * uLayerSize; vec2 fw = fwidth(px);', 'sprite FS'); pin(SPRITE_FS, 'max(fw.x, fw.y) < 1.0 ? textureLod(', 'sprite FS');
  pin(SPRITE_FS, 'c.a *= vFade * 0.85; if (c.a < 0.02) discard;', 'sprite FS'); pin(SPRITE_FS, 'if (c.a < 0.5) discard;', 'sprite FS');
  pin(FX_VS, 'vec2 half_ = iB.xy * 0.5 * k; vec2 css = iB.z < 0.5 ? c + (aCorner - 0.5) * 2.0 * half_', 'fx VS');
  pin(FX_VS, 'float foot = deedToCss(vec2(iA.x, iA.z)).y; gl_Position = cssToClip(css, spriteDepth(foot));', 'fx VS');
  pin(FX_FS, 'float r = length(vP); if (r > 1.0) discard;', 'fx FS');
  pin(DOT_VS, 'float pad = iB.w > 0.5 ? iA.z * 1.6 + 3.0 : iA.z * 0.5 + 1.0; vec2 c = floor(deedToCss(iA.xy) * uCam.w + 0.5) / uCam.w; vP = (aCorner - 0.5) * 2.0 * pad; gl_Position = cssToClip(c + vP, 0.0);', 'dot VS');
  pin(DOT_FS, 'if (max(q.x, q.y) <= half_) { a = vX.y;', 'dot FS'); pin(DOT_VS, 'vX = vec4(iA.z, iC.x, iC.y, 0.0);', 'dot VS');
  pin(SHIELD_VS, 'vec2 lo = uMode > 0.5 ? vec2(-rx * 1.25, -rx * 0.75) : vec2(-rx - 1.5, -0.55 * rx - 1.5); vec2 hi = uMode > 0.5 ? vec2(rx * 1.25, rx * 0.75) : vec2(rx + 1.5, 0.8 * rx + 1.5);', 'shield VS');
  pin(SHIELD_VS, 'vec2 css = deedToCss(iA.xy) + vec2(vP.x, -vP.y) * k; float foot = deedToCss(vec2(iA.x, iB.y)).y; gl_Position = cssToClip(css, spriteDepth(foot));', 'shield VS');
  pin(SHIELD_FS, 'vec2 e = vec2(p.x / rx, p.y >= 0.0 ? p.y / hC : p.y / ryG); float r2 = dot(e, e);', 'shield FS');
  pin(SHIELD_FS, 'if (inside > 0.5) { a = max(a, 0.08);', 'shield FS back');
  pin(FIELD_VS, 'if (kind < 2.5) deed = mix(iA.xy, iA.zw, aCorner);', 'field VS'); pin(FIELD_VS, 'gl_Position = cssToClip(deedToCss(deed), 0.0);', 'field VS');
  pin(FIELD_FS, 'if (kind < 2.5 && m >= 16) {', 'field FS'); pin(FIELD_FS, 'bool kitRoad = kind > 1.5 && !stone && uRoadN > 0.5;', 'field FS');
  pin(FIELD_FS, 'if (!oN) edge = min(edge, l.y - iN);', 'field FS');
  // the rehearsal view
  const V = REHEARSAL.view, cam = V.slice(0, 4), vp = V.slice(4, 8), k = cam[2] / 98;
  const deedToCss = ([x, y]) => [(x - cam[0]) * cam[2] + vp[0] * 0.5, (y - cam[1]) * cam[2] + vp[1] * 0.5];
  const clip = ([x, y]) => [x / vp[0] * 2 - 1, 1 - y / vp[1] * 2];
  const spriteDepth = foot => (1 - Math.min(1, Math.max(0, (foot + vp[1]) / (3 * vp[1])))) * 1.96 - 0.98;
  const mix = (a, b, t) => a + (b - a) * t;
  // the css points of the bound viewport (cssToClip maps css [0, 1]² onto it): corners, edges, centre
  const P = []; for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) P.push([vp[0] * i / 4, vp[1] * j / 4]);
  const byName = (name, per) => { const f = REHEARSAL.inst[name], out = []; for (let i = 0; i < f.length; i += per) out.push(f.slice(i, i + per)); return out; };
  const covers = (name, quad, depth, tested) => {
    const c = [[0, 0], [1, 0], [0, 1], [1, 1]].map(quad).map(clip);
    const x0 = Math.min(...c.map(p => p[0])), x1 = Math.max(...c.map(p => p[0])), y0 = Math.min(...c.map(p => p[1])), y1 = Math.max(...c.map(p => p[1]));
    assert.ok(x0 <= -1.5 && x1 >= 1.5 && y0 <= -1.5 && y1 >= 1.5, `${name}: covers the whole viewport with margin (clip x ${x0}..${x1}, y ${y0}..${y1})`);
    assert.ok(Math.max(x1 - x0, y1 - y0) <= 64, `${name}: a small quad (no far-off clip coordinates)`);
    if (tested) assert.ok(depth <= -0.9, `${name}: nearest sprite depth (${depth}) passes LEQUAL against any stored depth`);
  };
  const tested = name => Object.values(BASES_GL).some(s => s[0] === name && s[1]);
  // sprite: always on (kind ≥ 4.5 is never dissolved, ramped or smoke), the placeholder is opaque, and the two
  // instances take the two texture paths on every viewport width 1..65536 device px
  const T = REHEARSAL.tex, LW = T.w, LH = T.h, sprites = byName('sprite', 16);
  assert.equal(sprites.length, 2);
  for (const [si, s] of sprites.entries()) {
    const [ax, ay, afoot, , qx0, qy0, qx1, qy1, , , , , uM, vM, kind] = s;
    assert.ok(kind > 4.5, 'sprite: kind 5 is always on (no dissolve, no speckle ramp, no smoke drift)');
    const sc = deedToCss([ax, ay]), p0 = [sc[0] + qx0 * k, sc[1] + qy0 * k], p1 = [sc[0] + qx1 * k, sc[1] + qy1 * k];
    covers(`sprite #${si}`, a => [mix(p0[0], p1[0], a[0]), mix(p0[1], p1[1], a[1])], spriteDepth(deedToCss([ax, afoot])[1]), true);
    const fw = W => Math.max(LW * uM / ((p1[0] - p0[0]) / vp[0] * W), LH * vM / ((p1[1] - p0[1]) / vp[1] * W));
    if (si === 0) assert.ok(fw(1) < 1, `sprite #0 magnified on a 1-px viewport (fw ${fw(1)}): the textureLod path`);
    else assert.ok(fw(65536) >= 1, `sprite #1 minified on a 65536-px viewport (fw ${fw(65536)}): the texture() path`);
  }
  // fx: a glow disc; every viewport point lies inside r ≤ 1
  for (const [ax, ay, afoot, , bw, bh, kind] of byName('fx', 12)) {
    assert.ok(kind < 0.5, 'fx: the glow disc');
    const c = deedToCss([ax, ay]), half = [bw * 0.5 * k, bh * 0.5 * k];
    covers('fx', a => [c[0] + (a[0] - 0.5) * 2 * half[0], c[1] + (a[1] - 0.5) * 2 * half[1]], spriteDepth(deedToCss([ax, afoot])[1]), tested('fx'));
    for (const q of P) assert.ok(Math.hypot((q[0] - c[0]) / half[0], (q[1] - c[1]) / half[1]) <= 1, `fx: fragment kept at css ${q}`);
  }
  // dot: the square dot itself covers every viewport point (a = alpha, no discard)
  for (const [ax, ay, size, , , , , halo, alpha] of byName('dot', 12)) {
    const pad = halo > 0.5 ? size * 1.6 + 3 : size * 0.5 + 1, c = deedToCss([ax, ay]).map(v => Math.floor(v * cam[3] + 0.5) / cam[3]);
    covers('dot', a => [c[0] + (a[0] - 0.5) * 2 * pad, c[1] + (a[1] - 0.5) * 2 * pad], 0, tested('dot'));
    for (const q of P) assert.ok(Math.max(Math.abs(q[0] - c[0]), Math.abs(q[1] - c[1])) <= size * 0.5 && alpha >= 0.01, `dot: fragment kept at css ${q}`);
  }
  // shield: a dome (uMode 0); every viewport point is inside the bubble (the back shell keeps a ≥ 0.08, the front keeps inside)
  for (const [ax, ay, rx, , , footY] of byName('shield', 8)) {
    const c = deedToCss([ax, ay]), lo = [-rx - 1.5, -0.55 * rx - 1.5], hi = [rx + 1.5, 0.8 * rx + 1.5];
    covers('shield', a => { const v = [mix(lo[0], hi[0], a[0]), mix(lo[1], hi[1], a[1])]; return [c[0] + v[0] * k, c[1] - v[1] * k]; }, spriteDepth(deedToCss([ax, footY])[1]), tested('shield'));
    for (const q of P) { const p = [(q[0] - c[0]) / k, -(q[1] - c[1]) / k], e = [p[0] / rx, p[1] >= 0 ? p[1] / (0.8 * rx) : p[1] / (0.55 * rx)];
      assert.ok(e[0] * e[0] + e[1] * e[1] <= 1, `shield: inside the dome at css ${q}`); }
  }
  // field: a lane cell (kind 2) open on all four sides (no edge, no fillet), painted from the kit road array
  for (const [x0, y0, x1, y1, kb, m, , alpha] of byName('field', 8)) {
    const kind = kb % 4, mi = Math.round(m);
    assert.ok(kind > 1.5 && kind < 2.5 && mi < 16 && (mi & 15) === 15 && alpha > 0, 'field: an open lane cell, kept everywhere, sampling uRoad');
    covers('field', a => deedToCss([mix(x0, x1, a[0]), mix(y0, y1, a[1])]), 0, tested('field'));
  }
});

// ---- Stage B (2026-09-25): the sliced atlas build, the real-texture rehearsal, and the three catch-up realms ----------
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DECOR_ART, FLAT_CROPS } from './decor.mjs';
const sharp = createRequire(new URL('../../../../../../../scripts/package.json', import.meta.url).pathname)('sharp');
const PACKS = PACK_ROOT + 'realm/';
const decodedRaw = new Map();
const decodeRaw = f => {
  if (!decodedRaw.has(f)) decodedRaw.set(f, sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => ({ width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) })));
  return decodedRaw.get(f);
};
/** A real realm pack (and the shared pack) read from disk; `read` is called once per image data read (a crop). */
const packOf = (id, read = () => {}) => {
  const dir = PACKS + id + '/', meta = JSON.parse(readFileSync(dir + 'realm.json', 'utf8'));
  const img = async f => { const im = await decodeRaw(f); return { width: im.width, height: im.height, get data() { read(); return im.data; } }; };
  return { id, meta, first: { deeds: new Uint8Array(meta.grid.cols * meta.grid.rows) }, pixels: f => img(dir + f), json: async f => JSON.parse(readFileSync(dir + f, 'utf8')),
    shared: { pixels: f => img(PACKS + 'shared/' + f), json: async f => JSON.parse(readFileSync(PACKS + 'shared/' + f, 'utf8')) } };
};
/** Run one BASES load with a virtual clock: each image read costs 0.1 ms and each layer upload 0.3 ms, nothing else.
 *  → { bases, fake, hash (every array made and every layer uploaded, in order), worst stretch, yields, modelled ms }. */
async function clockedLoad(id, { frozen = false, onUpload } = {}) {
  const fake = fakeBasesCore(), H = createHash('sha256');
  let vt = 0, last = 0, worst = 0, yields = 0, uploads = 0;
  const arr = fake.core.tex.array, up = fake.core.tex.layer;
  fake.core.tex.array = (w, h, n, f, o) => { H.update(`A${w}x${h}x${n}${f}${o?.levels}${o?.filter}|`); return arr(w, h, n, f, o); };
  fake.core.tex.layer = (o, i, src, rect, level = 0) => { vt += 0.3; uploads++; H.update(`L${o.w}x${o.h}x${o.layers}:${i}:${level}:${src.w}x${src.h}|`); H.update(src.data); onUpload?.(uploads); return up(o, i, src, rect, level); };
  const pack = packOf(id, () => { vt += 0.1; });
  const MC = globalThis.MessageChannel, now = performance.now;
  globalThis.MessageChannel = class extends MC { constructor() { super(); const post = this.port2.postMessage.bind(this.port2); this.port2.postMessage = m => { yields++; worst = Math.max(worst, vt - last); last = vt; post(m); }; } };
  performance.now = () => (frozen ? 0 : vt);
  const bases = createBases(fake.core, null);
  try { await bases.load(pack, pack.shared); } finally { globalThis.MessageChannel = MC; performance.now = now; }
  worst = Math.max(worst, vt - last);
  return { bases, fake, pack, hash: H.digest('hex'), worst, yields, vt, uploads };
}

// Why (RM-GPU-1 W1 lift step #4, D-167 "no main-thread stall > 50 ms"): buildAtlases was ONE task of 1.7–2.5 s on every
// realm entry and every context-loss rebuild (ink trims, mini reductions, bleed + mode mips, ~4.6k layer uploads). It now
// runs with the art reads and the road tiles as one generator in ≤ SLICE_MS (8 ms) slices, LIFE's and GROUND's pattern.
// Counted, not timed (G3's rule: GC and a loaded host only lengthen real stretches): a real pack (Frostveil + the shared
// keeps/decor), the virtual clock of clockedLoad. The costliest modelled step is one icon's whole 7-level chain (2.1 ms).
// Teeth (scratch mutations): the one-task build is one 1.4 s stretch; yielding per array instead of per level, or per
// sprite strip instead of per upload, overshoots the bound; an unsliced read of the road tiles does too.
test('Stage B: the atlas build never blocks the main thread: trims, mips and uploads run in short slices, byte for byte the same', async () => {
  const SLICE = 8, STEP = 2.1; // bases.mjs SLICE_MS without a coarse pointer; the costliest modelled step
  const run = await clockedLoad('frostveil'), s = run.bases.stats();
  assert.equal(s.ready, true, `frostveil loads (${s.why})`);
  assert.ok(run.uploads > 4000 && run.vt > 1000, `a realistic load: ${run.uploads} uploads, ${run.vt.toFixed(0)} ms of modelled work`);
  assert.ok(run.worst <= SLICE + STEP + 1e-9, `a stretch held ${run.worst.toFixed(1)} ms of modelled work (the bound is ${SLICE} + ${STEP})`);
  assert.ok(run.yields >= (run.vt / (SLICE + STEP)) * 0.9, `the load yielded ${run.yields} times for ${run.vt.toFixed(0)} ms of modelled work`);
  assert.equal(s.slices, run.yields, 'stats().slices counts the yields');
  // the same texels whatever the slicing: a frozen clock never yields (the old one-task order) and uploads the same bytes
  const once = await clockedLoad('frostveil', { frozen: true });
  assert.equal(once.yields, 0, 'a frozen clock runs the load as one stretch');
  assert.equal(once.hash, run.hash, 'sliced and one-task loads make the same arrays and upload the same bytes in the same order');
  assert.equal(once.bases.stats().sprites, s.sprites); assert.deepEqual(once.bases.stats().missing, s.missing);

  // Real-texture rehearsal (the W1 B1 open item): once the art is in, each sampling program draws on EVERY real array its
  // passes sample, in every GL state, and is complete (true); no uploads in the hook.
  const { bases, fake } = run, progOf = Object.fromEntries(fake.made.map(p => [p.name.replace('bases-', ''), p]));
  const made = fake.uploads.length, realArrays = new Set();
  const n0 = fake.draws.length;
  assert.equal(bases.rehearse(progOf.sprite), true, 'sprite: complete once the art is in');
  const spr = fake.draws.slice(n0);
  for (const d of spr) realArrays.add(d.samplers.uTex);
  const want = s.arrays + 2;                             // every size-class atlas, the minis and the icons
  assert.equal(realArrays.size, want, `sprite: ${realArrays.size} arrays bound, want ${want}`);
  assert.ok([...realArrays].every(t => t.target === 'TEXTURE_2D_ARRAY' && t.texels.length > 0 && t.w !== REHEARSAL.tex.w), 'sprite: real, filled arrays (no placeholder)');
  assert.equal(spr.length, want * 2, 'sprite: each array in both sprite states (opaque, smoke)');
  const n1 = fake.draws.length;
  assert.equal(bases.rehearse(progOf.field), true, 'field: complete once the art is in');
  const road = fake.draws.slice(n1).map(d => d.samplers.uRoad);
  assert.ok(road.length === 1 && road[0].layers === 2 && road[0].w === 32 && road[0].texels.length > 0, 'field: the kit road tiles, not the placeholder');
  assert.equal(fake.uploads.length, made, 'the real-texture pass uploads nothing');
  assert.equal(bases.stats().rehearsedReal.sprite, true);
});

// Leaving the realm mid-load (SHELL disposes the lane, or a context loss rebuilds it) stops the sliced load at its next
// step: no further upload, every texture it made is freed, nothing turns ready. Otherwise a stale load keeps burning
// slices and GPU memory after the exit, and could fill the NEXT load's arrays.
test('Stage B: a dispose mid-load stops the sliced atlas build: no later upload, every texture freed, and it loads again', async () => {
  const f = fakeBasesCore(), live = new Set(); let n = 0, late = 0, gone = false;
  const arr = f.core.tex.array, dat = f.core.tex.data, up = f.core.tex.layer;
  Object.assign(f.core.tex, {
    array: (...a) => { const t = arr(...a); live.add(t); return t; }, data: (...a) => { const t = dat(...a); live.add(t); return t; },
    free: t => { live.delete(t); }, layer: (...a) => { n++; if (gone) late++; return up(...a); },
  });
  const pack = packOf('frostveil'), bases = createBases(f.core, null), p = bases.load(pack, pack.shared);
  for (let i = 0; i < 200000 && n < 600; i++) await new Promise(r => setImmediate(r));
  assert.ok(n >= 600, `the load reached its uploads (${n})`);
  bases.dispose(); gone = true; await p;
  assert.equal(late, 0, `${late} uploads after dispose`);
  assert.equal(live.size, 0, `${live.size} textures left allocated`);
  assert.equal(bases.stats().ready, false, 'a disposed load never turns ready');
  gone = false; await bases.load(pack, pack.shared);
  assert.equal(bases.stats().ready, true, 'the same instance loads again after a dispose');
});

// Every realm is dressed from its OWN kit, measured from the pack it draws from (the three catch-up realms of D-170 and the
// Crownlands 07b4bde7 / Stormcairn 6f581d63 re-syncs included). A re-sync that moves or drops a prop must fail here, not
// seat it wrong or leave a role empty on the map (the Crownlands final kit renamed its N–S bridge to the wide deck).
const STAGE_B = ['elderwood', 'thornwake', 'seeker-reach'];
test('Stage B realms: every dressing id is in its pack, and its measured geometry is the pack\'s (ink, footprint, frames)', async () => {
  for (const id of REALMS) {
    const meta = JSON.parse(readFileSync(PACKS + id + '/realm.json', 'utf8')), K = DECOR_ART.kit[id];
    const sheet = await decodeRaw(PACKS + id + '/' + meta.creatures.atlas);
    const ids = new Set(Object.entries(KIT_DRESSING[id]).filter(([r]) => r !== 'smoke').flatMap(([, v]) => (Array.isArray(v) ? v : Object.values(v))));
    for (const k of ids) {
      assert.ok(K[k], `${id}: '${k}' has no measured geometry`);
      if (k.startsWith('creature:')) {
        const c = meta.creatures.list.find(c => c.id === k.slice(9)); assert.ok(c, `${id}: creature ${k} is not in the pack`);
        let x0 = c.fw, y0 = c.fh, x1 = -1, y1 = -1;
        for (let y = 0; y < c.fh; y++) for (let x = 0; x < c.fw; x++) if (sheet.data[((c.y + y) * sheet.width + c.x + x) * 4 + 3] >= 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        assert.deepEqual(K[k], [c.fw, c.fh, x0, y0, x1 + 1, y1 + 1, 1, 1, c.frames, c.frameMs], `${id}: ${k} frame 0 'down'`);
      } else {
        const r = meta.sprites.rects[k]; assert.ok(r, `${id}: '${k}' is not in the pack's sprite atlas`);
        assert.deepEqual(K[k], [r.w, r.h, ...r.ink, ...r.footprint, r.frames, r.frames > 1 ? r.frameMs : 0], `${id}: ${k}`);
      }
    }
    const smoke = KIT_DRESSING[id].smoke?.[0] ?? 'smoke_drift';
    assert.ok(meta.sprites.rects[smoke]?.frames > 1, `${id}: its chimney smoke '${smoke}' is an animated sprite in the pack`);
    // the catch-up realms' crops are beds: they tile into continuous fields (flat), so a paddy, herb garden or crystal bed
    // never reads as a wall of objects (the older realms keep their few standing crops in spaced rows by design)
    if (STAGE_B.includes(id)) for (const c of KIT_DRESSING[id].crops) if (c !== 'mushroom_logs') assert.ok(FLAT_CROPS.has(c) || c.startsWith('crop_'), `${id}: crop ${c} is a flat bed`);
  }
});

// The kit butts a fence panel at its INK pitch (Solana Reach's lens fence, ink x 5..58 of 64: at the 2-tile pitch it
// leaves 11 px open at every joint and reads dashed, the kit's review r1 #5, fixed there at 54 px in 6aa5e72e). So a realm
// whose kit panel cannot butt at 2 tiles draws its plot edges and pens from the pack's 16-piece autotile, and every
// autotile arm reaches its cell edge on the rail, so neighbouring pieces meet. Teeth: dropping Solana's edges from the
// pack, or an autotile piece whose arm stops short, fails.
test('Stage B: fences never read dashed: a kit panel that cannot butt at 2 tiles comes with a gapless 16-piece autotile', async () => {
  const checked = new Set();
  for (const id of REALMS) {
    const meta = JSON.parse(readFileSync(PACKS + id + '/realm.json', 'utf8')), ew = KIT_DRESSING[id].edge.ew;
    const a = ew && DECOR_ART.kit[id][ew], gap = a ? a[2] + (a[0] - a[4]) : 0;   // open px at a joint of two 2-tile panels
    if (gap <= 2) continue;
    checked.add(id);
    assert.ok(meta.edges?.pieces, `${id}: its kit fence '${ew}' leaves ${gap} px at every joint, so the pack must ship the autotile`);
    const img = await decodeRaw(PACKS + id + '/' + (meta.edges.atlas ?? meta.sprites.atlas)), op = (r, x, y) => img.data[((r.y + y) * img.width + r.x + x) * 4 + 3] >= 128;
    for (const name of EDGE_ARMS) {
      const r = meta.edges.pieces[name], m = EDGE_ARMS.indexOf(name);
      assert.ok(r, `${id}: autotile piece ${name}`);
      for (const [bit, x] of [[2, r.w - 1], [8, 0]]) if (m & bit) {
        let hit = false; for (let y = 0; y < r.h && !hit; y++) hit = op(r, x, y);
        assert.ok(hit, `${id}: autotile ${name} does not reach its ${bit === 2 ? 'east' : 'west'} edge`);
      }
    }
  }
  assert.ok(checked.has('seeker-reach'), 'Solana Reach\'s lens fence (ink 5..58) is one of the realms this rule checks');
});

// Solana Reach's kit keeps obsidian for its main road and joins yards with crystaldust worn tracks (kit 165886cf), so its
// kingdoms' lanes and paths are crystaldust (DECOR_LAYOUT.track): the field program's road array holds the crystaldust
// pure tiles (4 layers, where the obsidian road has 2), byte for byte the TRUE ground atlas cells. Teeth: without the
// track override the array is the 2-layer road.
test('Stage B: Solana Reach paints its lanes and paths with the kit\'s crystaldust track, not the obsidian road', async () => {
  const run = await clockedLoad('seeker-reach', { frozen: true }), { bases, fake, pack } = run;
  assert.equal(bases.stats().ready, true, bases.stats().why);
  const progOf = Object.fromEntries(fake.made.map(p => [p.name.replace('bases-', ''), p])), n1 = fake.draws.length;
  bases.rehearse(progOf.field);
  const road = fake.draws.slice(n1)[0].samplers.uRoad, T = pack.meta.true, dust = T.terrains.find(t => t.id === DECOR_LAYOUT.track['seeker-reach']);
  assert.equal(dust.id, 'crystaldust');
  assert.equal(road.layers, dust.pureLayers.length, 'one layer per crystaldust pure tile');
  const atlas = await decodeRaw(PACKS + 'seeker-reach/' + T.atlas.file), cell = T.atlas.cell ?? 32, ac = T.atlas.cols ?? Math.floor(atlas.width / cell);
  dust.pureLayers.forEach((li, i) => {
    const got = road.texels.find(x => x.i === i && x.level === 0).data, want = new Uint8Array(cell * cell * 4);
    for (let y = 0; y < cell; y++) want.set(atlas.data.subarray((((Math.floor(li / ac) * cell) + y) * atlas.width + (li % ac) * cell) * 4, (((Math.floor(li / ac) * cell) + y) * atlas.width + (li % ac) * cell + cell) * 4), y * cell * 4);
    assert.ok(Buffer.from(got).equals(Buffer.from(want)), `layer ${i} is crystaldust tile ${li}`);
  });
});

// The QA level ladder (V4b: L1, L3, L5, L9, L13, L17, L20 on seven consecutive own deeds by your base) must stand on every
// catch-up realm's REAL deeds and compose at each level, with the shield dome in the realm's own accent.
test('Stage B realms: the L1–L20 ladder stands on their real deeds and composes, and each has its shield accent', async () => {
  const src = readFileSync(new URL('./bases.mjs', import.meta.url), 'utf8');
  for (const id of STAGE_B) {
    const meta = JSON.parse(readFileSync(PACKS + id + '/realm.json', 'utf8')), deeds = await decodeRaw(PACKS + id + '/' + (meta.files?.deeds ?? 'deeds.png'));
    const all = ladderBases(demoBases(meta, deeds.data), meta, deeds.data), ladder = all.filter(b => b.name?.startsWith('Ladder')).sort((a, b) => a.x - b.x);
    assert.deepEqual(ladder.map(b => b.level), DEMO.ladder, `${id}: the ladder`);
    assert.ok(all.filter(b => b.mine).length === 1, `${id}: exactly one base is yours`);
    for (const b of ladder) { const d = composeBaseDecor({ level: b.level, realmId: id, seed: seedOf(b.id), gates: ['N', 'S', 'W', 'E'] }); assert.equal(d.level, b.level); assert.ok(d.sprites.length > 0); }
    assert.match(src, new RegExp(`'?${id}'?: '#[0-9a-f]{6}'`), `${id}: a shield accent in ACCENT`);
  }
});

// ---- Fix pass (Stage B owner-bar critic #1, 2026-09-25): the marker icon stands in the middle of its plot ----------------
// Why: at MAP d 80–150 the icon stood with its foot on the keep seat (1 t below the plot centre), so the whole icon sat in
// the top half of its clearing — "the keep icon at the top edge of its pad", a pasted tile, not a kingdom on its land.
// GROUND's clearing, the claim tint and the shield ring look are all centred on the plot centre, so the icon is centred
// there too. It must still hand over to the live keep, which stands ON its seat inside its walls, without a jump: from the
// first per-base switch (d 200) the icon's foot is on the seat again, and between d 150 and 200 it eases without a step.
import { iconAnchorY, ICON_CENTRE_D } from './bases.mjs';
import { KEEP_FOOTPRINT } from './contracts.mjs';
const SEAT_Y = KEEP_FOOTPRINT[1] / 2 + PLOT_CENTRE;
test('fix pass: a marker icon is centred on its plot at MAP and back on the keep seat by the icon → keep switch', () => {
  assert.equal(ICON_CENTRE_D[1], BANDS.impostor[0], 'the icon is seated by the first icon → keep switch');
  for (const inkMid of [-6, -8.5, -13, -21]) {                      // real icons: 26–38 CSS px tall at d 80–150
    for (const d of [48, 80, 120, 150]) assert.ok(Math.abs(iconAnchorY(d, inkMid) + inkMid - PLOT_CENTRE) < 1e-9, `d ${d}: the ink middle is on the plot centre`);
    for (const d of [200, 240, 280, 1100]) assert.equal(iconAnchorY(d, inkMid), SEAT_Y, `d ${d}: the foot is on the keep seat`);
    let prev = iconAnchorY(150, inkMid);
    for (let d = 150; d <= 200; d = d < 200 ? Math.min(200, d * 1.01) : 201) {   // zooming in 1 % at a time, onto d 200: it slides, never jumps
      const y = iconAnchorY(d, inkMid);
      assert.ok(y <= prev + 1e-9, `d ${d.toFixed(1)}: the anchor moves one way only`);
      assert.ok(prev - y <= Math.abs(PLOT_CENTRE - inkMid - SEAT_Y) * 0.1, `d ${d.toFixed(1)}: a step of ${(prev - y).toFixed(2)} t`);
      prev = y;
    }
  }
});

// The same rule through the real module: an Elderwood pack (one of the two realms the critic captured), a fake GL, and the
// instance data bases.mjs uploads. The icon's ink middle lands on the plot centre at d 80 / 150 (desktop and phone), its
// anchor on the seat at d 200, and the selection pulse follows the drawn icon's foot (not the hidden seat).
test('fix pass: the drawn marker icon and its selection pulse stand where iconAnchorY puts them (real pack, every size)', async () => {
  const { bases, fake } = await clockedLoad('elderwood', { frozen: true });
  assert.equal(bases.stats().ready, true, bases.stats().why);
  const list = [[1, 11, 7], [9, 37, 21], [20, 64, 40]].map(([level, x, y], i) => ({ id: 1000 + i * 7919, x, y, level, shield: false, mine: false }));
  bases.setBases(list);
  /** The drawn icon of base b (its instance as uploaded): anchor and ink middle in plot-local tiles, ink height in tiles. */
  const iconOf = (b, view) => {
    bases.update(view); const n0 = fake.draws.length; bases.draw(view, 'sprite');
    const dr = fake.draws.slice(n0).find(q => q.samplers.uTex?.w === 72);
    assert.ok(dr, 'the icon array is drawn'); const f = dr.vao.attribs[1].buf.data;
    const o = plotOffset(b.x, b.y, b.level), cx = b.x + (PLOT_CENTRE + o.dx) / TILES;
    let r = null; for (let i = 0; i < dr.inst; i++) if (Math.abs(f[i * 16] - cx) < 1e-4) r = f.subarray(i * 16, i * 16 + 16);
    assert.ok(r, `L${b.level}: its icon is drawn`);
    const anchor = (r[1] - b.y) * TILES - o.dy;
    return { o, anchor, mid: anchor + (r[5] + r[7]) / 2, h: r[7] - r[5] };
  };
  const viewAt = (b, d, dpr) => ({ x: b.x + 0.5, y: b.y + 0.5, s: d / dpr, d, dpr, W: 1280, H: 800, reducedMotion: false,
    rect: { x0: b.x - 3, y0: b.y - 3, x1: b.x + 4, y1: b.y + 4 } });
  for (const b of list) {
    for (const [d, dpr] of [[80, 1], [150, 1], [150, 2]]) {
      const r = iconOf(b, viewAt(b, d, dpr));
      assert.ok(Math.abs(r.mid - PLOT_CENTRE) < 5e-3, `L${b.level} d ${d} dpr ${dpr}: the icon's ink middle is ${r.mid.toFixed(2)}, not the plot centre ${PLOT_CENTRE}`);
      assert.ok(r.h > 8, `L${b.level}: a real icon (${r.h.toFixed(1)} t tall)`);
    }
    const r = iconOf(b, viewAt(b, 200, 1));
    assert.ok(Math.abs(r.anchor - SEAT_Y) < 5e-3, `L${b.level} d 200: the icon's foot is on the seat (${r.anchor.toFixed(2)})`);
  }
  const b = list[1]; bases.select(b.id);
  const v = viewAt(b, 150, 1), r = iconOf(b, v), n0 = fake.draws.length;
  bases.draw(v, 'shieldBack');
  const sel = fake.draws.slice(n0).find(q => q.prog === 'bases-shield'), f = sel.vao.attribs[1].buf.data;
  assert.ok(Math.abs((f[1] - b.y) * TILES - r.o.dy - r.anchor) < 5e-3, 'the selection pulse sits at the drawn icon\'s foot');
});
