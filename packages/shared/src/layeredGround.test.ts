import { describe, expect, it } from 'vitest';
import { assertLayeredGroundManifest, layeredDrawPlan, layeredFloorPlan, layeredCleanGroundCrop, layeredIntersects, renderLayeredGroundPixels, type LayeredGroundManifest } from './layeredGround';
import { baseGroundArt, currentBaseVisualForRealm, isBaseVisualContext, isLayeredBaseVisualContext, REALM_IDS, CURRENT_LAYERED_REVISION_BY_REALM } from './baseVisual';

export function layeredFixture(): LayeredGroundManifest {
  const asset = (id: string, hash: string, frameCount: number) => ({ id, path: `atlas/fantasy/layered-ground/assets/${hash}.png`, sha256: hash,
    size: 100, width: frameCount * 2, height: 2, frameWidth: 2, frameHeight: 2, frameCount, frameDurationMs: 100,
    anchor: { x: 1, y: 2 }, reducedMotionFrame: 0 as const });
  return { schemaVersion: 1, groundRevision: 3, realmId: 'thornwake', status: 'preview-only', tilePixels: 32,
    field: { x: -1088, y: -1088, width: 3136, height: 3136 }, protectedFrame: { x: -256, y: -256, width: 1472, height: 1472 },
    ground: { asset: 'ground', sampling: 'repeat' }, assets: [asset('ground', 'a'.repeat(64), 1), asset('water', 'b'.repeat(64), 2)],
    placements: [{ id: 'waterfall', asset: 'water', x: -298, y: -296, width: 4, height: 4, layer: 1, phaseFrame: 1, animated: true, interactive: false }] };
}
describe('layered ground preview contract', () => {
  it('selects approved r3 for every current realm while legacy raster readers stay separate', () => {
    expect(isBaseVisualContext({ version: 1, realmId: 'thornwake', artVersion: 2, groundRevision: 3 })).toBe(true);
    expect(isBaseVisualContext({ version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 3 })).toBe(true);
    // Revision 5 is the realm kit's context (D-173): admissible, but never one of the r3/r4 painting readers.
    expect(isBaseVisualContext({ version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 5 })).toBe(true);
    expect(isLayeredBaseVisualContext({ version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 5 })).toBe(false);
    expect(isBaseVisualContext({ version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 6 as never })).toBe(false);
    // Every realm still presents an immutable layered revision: 3 unless it is a pinned revision 4 pilot realm.
    for (const realm of REALM_IDS) expect(currentBaseVisualForRealm(realm)).toEqual({ version: 1, realmId: realm, artVersion: 2, groundRevision: CURRENT_LAYERED_REVISION_BY_REALM[realm] ?? 3 });
    expect(() => baseGroundArt({ version: 1, realmId: 'thornwake', artVersion: 2, groundRevision: 3 })).toThrow('versioned manifest');
    expect(() => assertLayeredGroundManifest(layeredFixture())).not.toThrow();
  });
  it('accepts a larger centered clean frame but rejects shrinking or moving its guarantee', () => {
    const m = layeredFixture(); m.protectedFrame = { x: -576, y: -576, width: 2112, height: 2112 };
    m.placements[0]!.x = -800; m.placements[0]!.y = -800;
    expect(() => assertLayeredGroundManifest(m)).not.toThrow();
    m.placements[0]!.x = -300; m.placements[0]!.y = -300;
    expect(() => assertLayeredGroundManifest(m)).toThrow();
    m.placements = []; m.protectedFrame.x++;
    expect(() => assertLayeredGroundManifest(m)).toThrow();
    m.protectedFrame = { x: 0, y: 0, width: 960, height: 960 };
    expect(() => assertLayeredGroundManifest(m)).toThrow();
  });
  it('scales anchors with actual renderer tile pixels and culls before returning draw work', () => {
    const m = layeredFixture();
    const p = layeredDrawPlan(m, 64, { x: -610, y: -610, width: 30, height: 30 }, 0, false)[0]!;
    expect(p.destination).toEqual({ x: -600, y: -600, width: 8, height: 8 });
    expect(p.frame).toBe(1); expect(p.source.x).toBe(2);
    expect(layeredDrawPlan(m, 32, { x: 0, y: 0, width: 960, height: 960 }, 0, false)).toEqual([]);
    expect(layeredDrawPlan(m, 64, p.destination, 500, false, true)).toEqual([]);
    expect(layeredDrawPlan(m, 64, p.destination, 999, true)[0]?.frame).toBe(0);
    m.placements[0]!.animated = false;
    expect(layeredDrawPlan(m, 64, p.destination, 999, false)[0]?.frame).toBe(0);
  });
  it('rejects protected-frame intrusions, path substitution, unbounded allocations and malformed frame grids', () => {
    const mutations = [
      (m: LayeredGroundManifest) => { m.placements[0]!.x = 0; m.placements[0]!.y = 0; },
      (m: LayeredGroundManifest) => { m.assets[0]!.path = '../escape.png'; },
      (m: LayeredGroundManifest) => { m.assets[0]!.size = 2 ** 32 + 100; },
      (m: LayeredGroundManifest) => { m.assets[1]!.frameCount = 1; },
      (m: LayeredGroundManifest) => { m.placements[0]!.x = -2000; },
      (m: LayeredGroundManifest) => { m.assets[0]!.sha256 = 'wrong'; },
      (m: LayeredGroundManifest) => { m.placements[0]!.interactive = true as false; },
    ];
    for (const mutate of mutations) { const m = layeredFixture(); mutate(m); expect(() => assertLayeredGroundManifest(m)).toThrow(); }
  });
  it('uses only clean 2D material outside and never changes or overlaps the central painting', () => {
    const m = layeredFixture(); m.ground.sampling = 'world'; m.placements = [];
    const a = m.assets[0]!; a.width = a.frameWidth = 98; a.height = a.frameHeight = 98;
    m.protectedFrame = { x: -320, y: -320, width: 1600, height: 1600 };
    expect(layeredCleanGroundCrop(m)).toEqual({ x: 24, y: 24, width: 50, height: 50 });
    const view = { x: -2600, y: -2600, width: 8000, height: 8000 };
    const draws = layeredFloorPlan(m, 64, view), center = draws.find(d => d.id === 'floor-c-c')!;
    expect(center.source).toEqual({ x: 0, y: 0, width: 98, height: 98 });
    expect(center.destination).toEqual({ x: -2176, y: -2176, width: 6272, height: 6272 });
    for (const d of draws.filter(d => d !== center)) {
      expect(layeredIntersects(d.destination, center.destination)).toBe(false);
      expect(d.source.x).toBeGreaterThanOrEqual(24); expect(d.source.y).toBeGreaterThanOrEqual(24);
      expect(d.source.x + d.source.width).toBeLessThanOrEqual(74); expect(d.source.y + d.source.height).toBeLessThanOrEqual(74);
      expect(Object.values(d.source).every(Number.isInteger)).toBe(true);
      expect(d.flipX || d.flipY).toBeFalsy();
      const moved = layeredFloorPlan(m, 64, { ...view, x: view.x + 1 }).find(p => p.id === d.id);
      expect(moved).toEqual(d); // Camera motion never changes UVs or creates arbitrary texture frames.
    }
    for (const wide of [{ x: -11000, y: -2176, width: 24000, height: 6272 },
      { x: -2176, y: -11000, width: 6272, height: 24000 }]) {
      const coverage = layeredFloorPlan(m, 64, wide);
      expect(coverage.length).toBeLessThan(100);
      for (let y = wide.y + 1; y < wide.y + wide.height; y += 379) for (let x = wide.x + 1; x < wide.x + wide.width; x += 379)
        expect(coverage.filter(d => layeredIntersects(d.destination, { x, y, width: .01, height: .01 }))).toHaveLength(1);
    }
    expect(() => layeredFloorPlan(m, 64, { ...view, width: 1e12 })).toThrow();
    expect(() => layeredFloorPlan(m, 64, { ...view, x: Infinity })).toThrow();
    expect(() => layeredFloorPlan(m, 64, { x: -100000, y: -100000, width: 200000, height: 200000 })).toThrow();
  });
  it('server and client samples agree at every edge and corner without repeating scenery on either axis', () => {
    const m = layeredFixture(); m.ground.sampling = 'world'; m.placements = [];
    const a = m.assets[0]!; a.width = a.frameWidth = 98; a.height = a.frameHeight = 98;
    m.protectedFrame = { x: -320, y: -320, width: 1600, height: 1600 };
    const data = new Uint8Array(98 * 98 * 4);
    for (let y = 0; y < 98; y++) for (let x = 0; x < 98; x++) data.set([x, y, 0, 255], (y * 98 + x) * 4);
    const pixels = new Map([['ground', { width: 98, height: 98, data }], ['water', { width: 4, height: 2, data: new Uint8Array(32) }]]);
    const clean = (i: number) => 24 + ((i - 24) % 50 + 50) % 50;
    // Includes one-axis overflow alongside scenic source rows/columns (0 and97),
    // negative periods, all four edges/corners, and every in-field source seat.
    for (let ix = -180; ix < 280; ix++) for (const iy of [0, 23, 49, 74, 97, 279 - ix]) {
      const x = -1088 + (ix + .5) * 32, y = -1088 + (iy + .5) * 32;
      const outside = ix < 0 || iy < 0 || ix >= 98 || iy >= 98;
      const expected = [outside ? clean(ix) : ix, outside ? clean(iy) : iy, 0, 255];
      expect([...renderLayeredGroundPixels(m, pixels, 1, 1, x, y)]).toEqual(expected);
      const draws = layeredFloorPlan(m, 64, { x: x * 2, y: y * 2, width: .01, height: .01 });
      expect(draws).toHaveLength(1); // No overlap or empty band, including original field edges.
      const d = draws[0]!;
      expect(Math.floor(d.source.x + (x * 2 - d.destination.x) * d.source.width / d.destination.width)).toBe(expected[0]);
      expect(Math.floor(d.source.y + (y * 2 - d.destination.y) * d.source.height / d.destination.height)).toBe(expected[1]);
    }
    a.width = a.frameWidth = 1254; a.height = a.frameHeight = 1254;
    expect(layeredCleanGroundCrop(m)).toEqual({ x: 308, y: 308, width: 638, height: 638 });
    for (const index of [-1900, -615, -614, -308, -307, -2, -1, 0, 500, 1253, 1254, 1560, 1561, 1867, 2500]) {
      const world = -1088 + (index + .5) * 3136 / 1254;
      const d = layeredFloorPlan(m, 64, { x: world * 2, y: world * 2, width: .01, height: .01 })[0]!;
      const expected = index >= 0 && index < 1254 ? index : 308 + ((index - 308) % 638 + 638) % 638;
      expect(Math.floor(d.source.x + (world * 2 - d.destination.x) * d.source.width / d.destination.width)).toBe(expected);
    }
  });
  it('uses frame zero and exact shared anchor geometry in server crops; negative material coordinates repeat', () => {
    const m = layeredFixture();
    const ground = new Uint8Array([10, 20, 30, 255, 30, 40, 50, 255, 50, 60, 70, 255, 70, 80, 90, 255]);
    const water = new Uint8Array(32); for (let i = 0; i < 8; i++) water.set(i % 4 < 2 ? [200, 100, 0, 255] : [0, 0, 200, 255], i * 4);
    const pixels = new Map([['ground', { width: 2, height: 2, data: ground }], ['water', { width: 4, height: 2, data: water }]]);
    expect([...renderLayeredGroundPixels(m, pixels, 1, 1, -1, -1)]).toEqual([70, 80, 90, 255]);
    expect([...renderLayeredGroundPixels(m, pixels, 1, 1, -300, -300)]).toEqual([200, 100, 0, 255]);
    m.ground.sampling = 'world';
    // A two-texel painting cannot provide a complete texel inside this clean frame.
    expect(() => renderLayeredGroundPixels(m, pixels, 1, 1, -1200, -1200)).toThrow('Invalid layered ground');
  });
});
