// Globe picking against native's goldens (goldens/picking.json: the concept's tap rule on the frozen geography at 5,000
// seeded points, and every realm's framing geometry) and against the host's exploration ids (RG-1).
// Why: a tap must select the same realm on web and native, and an exploration island tap must hand the host the exact
// chain and island ids its EXPLORE panel and focusIsland already use, or the island panel opens on the wrong island.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeGeography, geoIndex, realmGeom, createPicking, islandAt, phaseEAt, ISLAND_FOOTPRINT } from './picking.mjs';
import { REALMS, PHASE_E, ISLE } from './pin.mjs';
import { ARCHIPELAGOS } from '../../runtime/world.mjs';
import { locateIsland } from '../../runtime/island-shapes.mjs';

const G = JSON.parse(readFileSync(new URL('./goldens/picking.json', import.meta.url), 'utf8'));
const ISL = JSON.parse(readFileSync(new URL('./goldens/islands.json', import.meta.url), 'utf8'));
const geo = decodeGeography();
const realmIds = REALMS.map(r => r.id);

test('the frozen geography is the 768×384 grid native pins, in the same realm order', () => {
  assert.deepEqual(G.geography, { width: geo.width, height: geo.height });
  assert.deepEqual(G.regionIds, realmIds);
});

test('the tap rule (land ? realm : -1) and the exploration code equal the goldens at 5,000 points', () => {
  assert.equal(G.picks.length, 5000);
  for (const [lon, lat, realm, explore] of G.picks) {
    const i = geoIndex(lon, lat);
    assert.equal(geo.land[i] ? geo.region[i] : -1, realm, `realm at ${lon},${lat}`);
    assert.equal(geo.explore[i], explore, `exploration code at ${lon},${lat}`);
  }
});

test('realm framing geometry (main landmass, outline, bbox centre) equals the goldens for all 8 realms', () => {
  for (const g of G.geoms) {
    const r = realmIds.indexOf(g.id), m = realmGeom(geo, r);
    m.c.forEach((v, k) => assert.ok(Math.abs(v - g.c[k]) < 1e-9, `${g.id} centre`));
    assert.equal(m.pts.length, g.pts, `${g.id} outline points`);
    g.ptsHead.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(m.pts[i][k] - v) < 1e-9, `${g.id} point ${i}`)));
    const sum = m.pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
    sum.forEach((v, k) => assert.ok(Math.abs(v - g.ptsSum[k]) < 1e-7, `${g.id} outline sum`));
  }
});

test('the host chains are the island model native draws (7 chains, 32 islands, same boxes)', () => {
  assert.deepEqual(ARCHIPELAGOS.map(c => c.id), ISL.chains.map(c => c.id));
  assert.equal(ARCHIPELAGOS.reduce((n, c) => n + c.islands.length, 0), ISLE.MAX);
  ARCHIPELAGOS.forEach((c, i) => c.islands.forEach((s, j) => assert.deepEqual({ lon: s.lon, lat: s.lat, rx: s.rx, ry: s.ry }, ISL.chains[i].islands[j])));
  assert.deepEqual({ cell: ISLE.CELL, atlas: ISLE.ATLAS, extent: ISLE.EXTENT }, ISL.shape);
});

test('island picking returns the host chain and island ids for all 32 islands (RG-1)', () => {
  // every chain's full-resolution land bits: land everywhere inside the boxes (the art decides nothing here)
  const lands = ARCHIPELAGOS.map(() => new Uint8Array(ISLE.ATLAS * ISLE.ATLAS).fill(1));
  const picking = createPicking({ geo, realmIds, chains: ARCHIPELAGOS }); picking.lands = lands;
  let n = 0;
  for (const chain of ARCHIPELAGOS) chain.islands.forEach((s, slot) => {
    // a point inside the island's box, off its centre texel edge (no knife-edge floor between the radian and degree rules)
    const lon = s.lon + 0.13 * s.rx, lat = s.lat - 0.17 * s.ry;
    const p = picking.pick(lon, lat, ISLAND_FOOTPRINT + 1);
    assert.deepEqual(p, { kind: 'explore', chainId: chain.id, islandId: `${chain.id}-${slot + 1}` });
    // the id and atlas texel are the ones the host's own locator (the legacy renderer and islandFocus) uses
    const RAD = Math.PI / 180, legacy = locateIsland(lon * RAD, lat * RAD, ARCHIPELAGOS), mine = islandAt(ARCHIPELAGOS, lon, lat);
    assert.equal(legacy.featureId ?? `${chain.id}-${legacy.index + 1}`, p.islandId);
    assert.deepEqual([mine.x, mine.y], [legacy.atlasX, legacy.atlasY]);
    n++;
  });
  assert.equal(n, 32);
});

test('an island tap on a sea texel of its art is the sea; far out the chain is picked by its cells', () => {
  const chain = ARCHIPELAGOS[0], s = chain.islands[0];
  const sea = ARCHIPELAGOS.map(() => new Uint8Array(ISLE.ATLAS * ISLE.ATLAS));
  const picking = createPicking({ geo, realmIds, chains: ARCHIPELAGOS }); picking.lands = sea;
  assert.deepEqual(picking.pick(s.lon, s.lat, ISLAND_FOOTPRINT + 1), { kind: 'sea' });
  // far out (footprint ≤ 1.5) or before the art is live: the coarse cell names the chain, never an island
  picking.lands = null;
  const cell = (() => { for (let i = 0; i < geo.explore.length; i++) if (geo.explore[i] === 1 && geo.land[i]) return i; })();
  const lon = (cell % geo.width + 0.5) / geo.width * 360 - 180, lat = 90 - (Math.floor(cell / geo.width) + 0.5) / geo.height * 180;
  assert.deepEqual(picking.pick(lon, lat, 1), { kind: 'explore', chainId: ARCHIPELAGOS[0].id, islandId: null });
});

test('Phase E islands are picked first by their tap ellipses, and never while the layer is off (RG-3)', () => {
  const picking = createPicking({ geo, realmIds, chains: ARCHIPELAGOS });
  for (const I of PHASE_E) {
    assert.equal(phaseEAt(I.lon, I.lat), I.id);
    picking.phaseE = false; assert.notEqual(picking.pick(I.lon, I.lat, 1).kind, 'phase-e');
    picking.phaseE = true; assert.deepEqual(picking.pick(I.lon, I.lat, 1), { kind: 'phase-e', id: I.id });
  }
});

test('a realm tap names the realm id and whether the cell is deed land', () => {
  const picking = createPicking({ geo, realmIds, chains: ARCHIPELAGOS });
  for (const R of REALMS) { const p = picking.pick(R.lon, R.lat, 1); if (p.kind === 'realm') assert.equal(p.id, R.id, R.id); }
  assert.equal(picking.pick(26, 23, 1).id, 'crownlands');
  const sea = geo.land.findIndex((l, i) => !l && !geo.explore[i]);
  assert.deepEqual(picking.pick((sea % geo.width + 0.5) / geo.width * 360 - 180, 90 - (Math.floor(sea / geo.width) + 0.5) / geo.height * 180, 1), { kind: 'sea' });
});
