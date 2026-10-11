import { describe, expect, it } from 'vitest';
import { assertLayeredGroundManifest, assertLayeredGroundAssetPixels, layeredDrawPlan, layeredFloorPlan,
  renderLayeredGroundPixels, LAYERED_GROUND_LIMITS, type LayeredGroundManifestV4, type LayeredPixels } from './layeredGround';
import { CURRENT_LAYERED_REVISION_BY_REALM, REALM_IDS, currentBaseVisualForRealm, isBaseVisualContext, isLayeredBaseVisualContext, baseGroundArt } from './baseVisual';
import { BASE_LAYERED_GROUND_V4, BASE_LAYERED_GROUND_V5, layeredGroundDescriptor } from './layeredGroundCatalogue';

function fixture(): LayeredGroundManifestV4 {
  const asset = (id: string, hash: string, size: number) => ({ id, path: `atlas/fantasy/layered-ground/assets/${hash.repeat(64)}.webp`,
    sha256: hash.repeat(64), size: 100, width: size, height: size, frameWidth: size, frameHeight: size,
    frameCount: 1, frameDurationMs: 100, anchor: { x: 0, y: 0 }, reducedMotionFrame: 0 as const });
  return { schemaVersion: 2, groundRevision: 4, realmId: 'thornwake', status: 'preview-only', tilePixels: 32,
    field: { x: -1088, y: -1088, width: 3136, height: 3136 }, protectedFrame: { x: -320, y: -320, width: 1600, height: 1600 },
    ground: { asset: 'center', sampling: 'world', centerRect: { x: -1872, y: -1872, width: 4704, height: 4704 },
      exterior: { asset: 'outer', rect: { x: -4320, y: -4320, width: 9600, height: 9600 } },
      far: { asset: 'far', origin: { x: 17, y: -21 }, period: { width: 64, height: 64 } } },
    assets: [asset('center', 'a', 6), asset('outer', 'b', 8), asset('far', 'c', 2), asset('motion', 'd', 2)], placements: [] };
}
function pixels(m: LayeredGroundManifestV4): Map<string, LayeredPixels> {
  return new Map(m.assets.map(a => {
    const data = new Uint8Array(a.width * a.height * 4);
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const edge = x === 0 || y === 0 || x === a.width - 1 || y === a.height - 1;
      data.set(a.id === 'far' ? [20 + x * 40, 20 + y * 40, 30, 255]
        : a.id === 'center' ? [200, 10, 20, edge ? 0 : 255] : [10, 200, 20, edge ? 0 : 128], (y * a.width + x) * 4);
    }
    return [a.id, { width: a.width, height: a.height, data }];
  }));
}

describe('unactivated immutable revision4 layered contract', () => {
  it('keeps revision 4 published for every realm (the E-12 downgrade target and frozen contexts) while the activation table presents revision 5', () => {
    const context = { version: 1, realmId: 'thornwake', artVersion: 2, groundRevision: 4 } as const;
    expect(isBaseVisualContext(context)).toBe(true); expect(isLayeredBaseVisualContext(context)).toBe(true);
    // The activation table, the pinned V4 catalogue and the pinned V5 catalogue must name
    // exactly the same realms: a presented realm without V5 art fails every base load, and a
    // realm without V4 art has no published scenery to serve old native renderers (E-12).
    expect(Object.keys(CURRENT_LAYERED_REVISION_BY_REALM).sort()).toEqual(Object.keys(BASE_LAYERED_GROUND_V4).sort());
    expect(Object.keys(CURRENT_LAYERED_REVISION_BY_REALM).sort()).toEqual(Object.keys(BASE_LAYERED_GROUND_V5).sort());
    expect(Object.keys(CURRENT_LAYERED_REVISION_BY_REALM).sort()).toEqual([...REALM_IDS].sort());
    // Owner flip 2026-09-26 (D-175 accepted all eight kits): every realm presents revision 5.
    for (const realm of REALM_IDS) expect(CURRENT_LAYERED_REVISION_BY_REALM[realm]).toBe(5);
    for (const realm of REALM_IDS) {
      const current = currentBaseVisualForRealm(realm);
      expect(current.groundRevision).toBe(5);
      expect(() => layeredGroundDescriptor(current)).toThrow('explicit layered revision');
      // Revision 4 stays published for every realm: old native renderers are served it and frozen contexts keep it.
      expect(layeredGroundDescriptor({ ...current, groundRevision: 4 }).realmId).toBe(realm);
    }
    expect(layeredGroundDescriptor(context)).toEqual(BASE_LAYERED_GROUND_V4.thornwake);
    // Revision 3 descriptors stay published for frozen replay/archive contexts of every realm.
    for (const realm of REALM_IDS) expect(layeredGroundDescriptor({ ...context, realmId: realm, groundRevision: 3 }).realmId).toBe(realm);
    expect(() => layeredGroundDescriptor({ ...context, realmId: 'nowhere' as never })).toThrow('not published');
    expect(() => baseGroundArt(context)).toThrow('versioned manifest');
    expect(() => assertLayeredGroundManifest(fixture())).not.toThrow();
  });
  it('covers arbitrarily distant views with one repeat primitive; art bounds never become camera clipping', () => {
    const m = fixture(), view = { x: -20000, y: -18000, width: 50000, height: 41000 };
    const plan = layeredFloorPlan(m, 64, view);
    expect(plan.map(d => d.id)).toEqual(['floor-far', 'floor-exterior', 'floor-center']);
    expect(plan[0]!.destination).toEqual(view);
    expect(plan[0]!.repeat).toEqual({ origin: { x: 34, y: -42 }, period: { width: 128, height: 128 } });
    expect(layeredFloorPlan(m, 32, { x: -1e7, y: 1e7, width: 500, height: 800 }).map(d => d.id)).toEqual(['floor-far']);
    expect(() => layeredFloorPlan(m, 32, { ...view, x: Infinity })).toThrow();
    const moved = layeredFloorPlan(m, 64, { ...view, x: view.x + 1 });
    expect(moved[0]!.repeat).toEqual(plan[0]!.repeat);
    expect(moved.slice(1)).toEqual(plan.slice(1));
  });
  it('CPU sampling uses negative-safe fixed-phase UVs, centre opacity and outer alpha in the same order', () => {
    const m = fixture(), p = pixels(m);
    const sample = (x: number, y: number) => [...renderLayeredGroundPixels(m, p, 1, 1, x, y)];
    for (const [x, y] of [[-1088, -1088], [2047, -1088], [-1088, 2047], [2047, 2047], [0, 0]]) expect(sample(x!, y!)).toEqual([200, 10, 20, 255]);
    for (const [x, y] of [[-16000, -16000], [-16000, 0], [0, 16000], [16000, -16000]]) {
      const sx = ((Math.floor((x! - 17) / 32) % 2) + 2) % 2, sy = ((Math.floor((y! + 21) / 32) % 2) + 2) % 2;
      expect(sample(x!, y!)).toEqual([20 + sx * 40, 20 + sy * 40, 30, 255]);
      expect(sample(x! + 64, y! - 64)).toEqual(sample(x!, y!));
    }
    const far = [60, 20, 30]; // (-3000, -3000) -> far texel(1,0), translucent exterior interior.
    expect(sample(-3000, -3000)).toEqual([...far.map((v, i) => Math.floor(([10, 200, 20][i]! * 128 + v * 127 + 127) / 255)), 255]);
  });
  it('forbids animation or objects in the clean50 frame and keeps field motion at original coordinates', () => {
    const m = fixture();
    m.placements = [{ id: 'leaf', asset: 'motion', x: -400, y: -400, width: 64, height: 64, layer: 1, phaseFrame: 0, animated: true, interactive: false }];
    expect(() => assertLayeredGroundManifest(m)).not.toThrow();
    expect(layeredDrawPlan(m, 64, { x: -1000, y: -1000, width: 2000, height: 2000 }, 0, false)[0]!.destination).toEqual({ x: -800, y: -800, width: 128, height: 128 });
    m.placements[0]!.x = -321; m.placements[0]!.y = -321;
    expect(() => assertLayeredGroundManifest(m)).toThrow();
  });
  it('rejects unsupported schema pairs, non-POT repeats, moved protected ground and invalid bounds', () => {
    const mutations = [
      (m: LayeredGroundManifestV4) => Object.assign(m, { schemaVersion: 1 }),
      (m: LayeredGroundManifestV4) => { m.protectedFrame.width = 1472; },
      (m: LayeredGroundManifestV4) => { m.ground.centerRect.x = 0; },
      (m: LayeredGroundManifestV4) => { m.ground.exterior.rect.width = 1600; },
      (m: LayeredGroundManifestV4) => { m.ground.far.period.width = 0; },
      (m: LayeredGroundManifestV4) => { m.ground.far.origin.x = Infinity; },
      (m: LayeredGroundManifestV4) => { m.assets[2]!.width = m.assets[2]!.frameWidth = 3; },
      (m: LayeredGroundManifestV4) => { m.ground.far.asset = 'center'; },
    ];
    for (const mutate of mutations) { const m = fixture(); mutate(m); expect(() => assertLayeredGroundManifest(m)).toThrow(); }
  });
  it('budgets all assets plus manifest overhead, and rejects decoded memory beyond16MiB', () => {
    const m = fixture(); m.assets[0]!.size = LAYERED_GROUND_LIMITS.compressedBytes - 300;
    expect(() => assertLayeredGroundManifest(m)).toThrow();
    const large = fixture(); large.assets[0]!.width = large.assets[0]!.height = large.assets[0]!.frameWidth = large.assets[0]!.frameHeight = 2048;
    expect(() => assertLayeredGroundManifest(large)).toThrow();
  });
  it('requires opaque far ground, transparent complete collars and an opaque98field centre', () => {
    const m = fixture(), p = pixels(m);
    for (const a of m.assets) expect(() => assertLayeredGroundAssetPixels(m, a, p.get(a.id)!)).not.toThrow();
    for (const [id, at, alpha] of [['far', 3, 0], ['center', 3, 255], ['outer', 3, 255], ['center', (2 * 6 + 2) * 4 + 3, 0]] as const) {
      const changed = pixels(m).get(id)!; changed.data[at] = alpha;
      expect(() => assertLayeredGroundAssetPixels(m, m.assets.find(a => a.id === id)!, changed)).toThrow();
    }
  });
});
