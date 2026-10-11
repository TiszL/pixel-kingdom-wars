/** E-11 expansion obstacles (D-173, owner 2026-09-21): a baked kit prop the claim
 * reaches becomes a clearable server row of the tier this module names, drawn as
 * the prop's own still. WHY these pins: the species a player looked at must not
 * change because they bought the land under it; a row must never cover a tile the
 * visible prop does not stand on (so a 2×1 log or a 3×3 mill can never be cleared
 * as a bush, and a 2×2 tree straddling the claim edge never yields a row on unowned
 * land); and every surface (web, native, deed, API) must answer one rule. */
import { describe, expect, it } from 'vitest';
import { KIT_OBSTACLES, OBSTACLES } from './constants';
import type { LayeredAsset } from './layeredGround';
import { realmKitObstacleSprite, realmKitPlacementSeat, realmKitTileHash, type RealmKitManifest, type RealmKitPlacement } from './realmKit';
import { realmKitFixture } from './realmKit.fixture';
import { realmKitObstacleKindFor, realmKitObstacleRow, realmKitObstacleSeat, realmKitObstacleSize, realmKitObstacleSpriteAt,
  realmKitSeatIndex } from './realmKitObstacles';

const oakAt = (id: string, x: number, y: number, extra: Partial<RealmKitPlacement> = {}): RealmKitPlacement => ({
  id, asset: 'oak', x, y, width: 32, height: 48, layer: 1, phaseFrame: 0, animated: false, interactive: false, ...extra });
/** The fixture plus extra placements/assets; the rule never re-validates, so shapes stay minimal. */
function variant(placements: RealmKitPlacement[] = [], assets: LayeredAsset[] = [], obstacleSprites?: RealmKitManifest['obstacleSprites']): RealmKitManifest {
  const m = realmKitFixture();
  m.placements.push(...placements); m.assets.push(...assets);
  if (obstacleSprites) m.obstacleSprites = obstacleSprites;
  return m;
}
const CREATURE: LayeredAsset = { id: 'deer', path: 'atlas/fantasy/layered-ground/assets/' + 'f'.repeat(64) + '.png', sha256: 'f'.repeat(64), size: 100,
  width: 64, height: 32, frameWidth: 32, frameHeight: 32, frameCount: 2, frameDurationMs: 100, anchor: { x: 16, y: 32 }, reducedMotionFrame: 0 };

describe('realm kit obstacle kinds', () => {
  it('maps the fixture props by layer, footprint and seat parity, so the tier a felled tree pays is decided by the kit, not the client', () => {
    const m = realmKitFixture(), kinds = Object.fromEntries(m.placements.map(p => [p.id, realmKitObstacleKindFor(m, p)]));
    // Tall 1×1 oaks are parity pines: the ABSOLUTE seat hash picks the twin, so the
    // same tree is pine1 on every surface and never reshuffles with an expansion.
    for (const id of ['oak-east', 'oak-dead-west', 'oak-frame-east']) {
      const { tx, ty } = realmKitPlacementSeat(m.placements.find(p => p.id === id)!);
      expect(kinds[id]).toBe(KIT_OBSTACLES.tallByParity[realmKitTileHash(tx, ty) % 2]);
    }
    expect(kinds).toEqual({ 'oak-east': 'pine2', 'stump-north': 'stump', 'oak-dead-west': 'pine1', 'oak-frame-east': 'pine2' });
    // Every mapped key is one of the server's eight and its tier size is the prop's footprint.
    for (const key of Object.values(kinds)) expect(realmKitObstacleSize(key!)).toBe(1);
    expect(realmKitObstacleSize('tree_old')).toBe(OBSTACLES.tiers.large.sizeTiles);
    expect(() => realmKitObstacleSize('dragon')).toThrow();
  });
  it('prefers the builder-written `prop` over the id prefix and honours the byProp table only when the tier size equals the footprint', () => {
    const m = variant();
    expect(realmKitObstacleKindFor(m, oakAt('oak-9', 1500, 1600, { prop: 'rock-l' }))).toBe('rock_l');
    expect(realmKitObstacleKindFor(m, oakAt('rock-s-3', 1500, 1600, { layer: 0 }))).toBe('rock_s');
    expect(realmKitObstacleKindFor(m, oakAt('canopy-log-3', 1500, 1600, { layer: 0 }))).toBe('stump');
    // Crownlands' boulder_mossy is 2×1: a 2×2 boulder row would block a tile the rock does not cover.
    expect(realmKitObstacleKindFor(m, oakAt('boulder-mossy-1', 1500, 1600, { layer: 0, footprint: [2, 1] }))).toBeUndefined();
    expect(realmKitObstacleKindFor(m, oakAt('boulder-mossy-1', 1500, 1600, { layer: 0, footprint: [2, 2] }))).toBe('boulder');
    // A 2×2 stump cannot be the 1-tile stump tier either.
    expect(realmKitObstacleKindFor(m, oakAt('stump-9', 1500, 1600, { layer: 0, footprint: [2, 2] }))).toBeUndefined();
  });
  it('maps 1×1 low props to the bush, 2×2 tall props to the large tree, and nothing else — a log, a mill or a tent is never clearable', () => {
    const m = variant();
    expect(realmKitObstacleKindFor(m, oakAt('bush-1', 1500, 1600, { layer: 0 }))).toBe(KIT_OBSTACLES.low);
    expect(realmKitObstacleKindFor(m, oakAt('hero-oak-1', 1500, 1600, { footprint: [2, 2] }))).toBe(KIT_OBSTACLES.tallLarge);
    expect(realmKitObstacleKindFor(m, oakAt('tent-1', 1500, 1600, { layer: 0, footprint: [2, 2] }))).toBeUndefined();
    expect(realmKitObstacleKindFor(m, oakAt('log-1', 1500, 1600, { layer: 0, footprint: [2, 1] }))).toBeUndefined();
    expect(realmKitObstacleKindFor(m, oakAt('windmill-1', 1500, 1600, { footprint: [3, 3] }))).toBeUndefined();
    expect(realmKitObstacleKindFor(m, oakAt('spring-rock-1', 1500, 1600, { footprint: [4, 3] }))).toBeUndefined();
  });
  it('never maps a cell of the 32×32 creature sheet, whatever its layer, so the next lane can move deer and rabbits freely', () => {
    const m = variant([], [CREATURE]);
    expect(realmKitObstacleKindFor(m, { ...oakAt('deer-graze-1', 1500, 1600, { layer: 0 }), asset: 'deer', width: 32, height: 32 })).toBeUndefined();
    expect(realmKitObstacleKindFor(m, { ...oakAt('deer-graze-1', 1500, 1600, { layer: 1 }), asset: 'deer', width: 32, height: 32 })).toBeUndefined();
    // The fixture oak (32×48) and stump (16×16) are not square 32-px cells: the rule is the sheet, not the width alone.
    expect(realmKitObstacleKindFor(m, oakAt('oak-1', 1500, 1600))).toBeDefined();
    expect(() => realmKitObstacleKindFor(m, { ...oakAt('ghost-1', 1500, 1600), asset: 'missing' })).toThrow();
  });
});

describe('realm kit obstacle seats', () => {
  it('indexes placements by seat tile, first in manifest order when two share one, memoised per manifest object', () => {
    const m = variant([oakAt('oak-twin', 976, 512, { frame: 1 })]); // the same seat as oak-frame-east (30,15)
    const index = realmKitSeatIndex(m);
    expect([...index.keys()]).toEqual(['46,46', '12,-19', '-22,6', '30,15']);
    expect(index.get('30,15')?.id).toBe('oak-frame-east');
    expect(realmKitSeatIndex(m)).toBe(index);
    expect(realmKitSeatIndex(realmKitFixture())).not.toBe(index);
  });
  it('places a row so its tier twin\'s anchor is the placement anchor: 1×1 rows on the seat, 2×2 rows one tile up-left, and back again', () => {
    expect(realmKitObstacleSeat('bush', 7, 9)).toEqual({ tx: 7, ty: 9 });
    expect(realmKitObstacleRow('pine1', { tx: 7, ty: 9 })).toEqual({ tx: 7, ty: 9 });
    // The web/deed seat rule anchors a 2×2 tree_old row at (tx0,ty0) on ((tx0+1)·32, (ty0+2)·32);
    // the builder anchors a 2-wide, 2-tall prop on exactly that pixel, whose seat reads (tx0+1, ty0+1).
    const row = { tx: 10, ty: 10 }, anchor = { x: (row.tx + 1) * 32, y: (row.ty + 2) * 32 };
    const seat = realmKitPlacementSeat(oakAt('hero-oak-1', anchor.x, anchor.y, { footprint: [2, 2] }));
    expect(seat).toEqual({ tx: 11, ty: 11 });
    expect(realmKitObstacleSeat('tree_old', row.tx, row.ty)).toEqual(seat);
    expect(realmKitObstacleRow('tree_old', seat)).toEqual(row);
    // A 2×2 prop whose seat is the claim's first column stands half outside it: the row's
    // top-left lands one tile left of the claim, which the API's inside-claim check refuses.
    const claim = { min: 2, max: 28 };
    expect(realmKitObstacleRow('tree_old', { tx: claim.min, ty: 10 }).tx).toBeLessThan(claim.min);
    expect(realmKitObstacleRow('tree_old', { tx: claim.min + 1, ty: 10 }).tx).toBe(claim.min);
  });
});

describe('realm kit obstacle sprite at a row', () => {
  it('draws a standing row as the seated prop\'s own still (its frame, not the twin\'s frame 0), so buying land never changes the species', () => {
    const m = realmKitFixture();
    // oak-frame-east: sheet cell 3 seated on (30,15), a pine2 by parity.
    for (const state of ['intact', 'clearing'] as const) {
      const draw = realmKitObstacleSpriteAt(m, 30, 15, 'pine2', state);
      expect(draw?.asset.id).toBe('oak'); expect(draw?.frame).toBe(3);
    }
    // The fixture maps no pine2 twin, so the remnant (and any row without its prop) stays with the dec_ master.
    expect(realmKitObstacleSpriteAt(m, 30, 15, 'pine2', 'remnant')).toBeUndefined();
    const twinned = variant([], [], { ...m.obstacleSprites, pine2: { intact: 'oak', remnant: 'oak-stump' } });
    expect(realmKitObstacleSpriteAt(twinned, 30, 15, 'pine2', 'remnant')).toEqual({ asset: twinned.assets.find(a => a.id === 'oak-stump'), frame: 0 });
    expect(realmKitObstacleSpriteAt(twinned, 31, 15, 'pine2', 'intact')).toEqual({ asset: twinned.assets.find(a => a.id === 'oak'), frame: 0 });
  });
  it('lends a prop\'s sprite only to the row of its own kind, and answers every other row with the E-11 twin exactly as before', () => {
    const m = realmKitFixture();
    // A pine1 row on the pine2 oak's seat (a re-baked kit, a hand-edited row): the twin, never a stranger's canopy.
    expect(realmKitObstacleSpriteAt(m, 30, 15, 'pine1', 'intact')).toBeUndefined();
    // The plot's own generated rows have no seated prop: the tier twin at frame 0, byte-for-byte the r5 pin.
    for (const state of ['intact', 'clearing', 'remnant'] as const) {
      expect(realmKitObstacleSpriteAt(m, 10, 10, 'tree_old', state)).toEqual({ asset: realmKitObstacleSprite(m, 'tree_old', state), frame: 0 });
    }
    expect(realmKitObstacleSpriteAt(m, 12, 12, 'bush', 'intact')).toBeUndefined();
    // A 2×2 row is looked up by its SEAT, not its top-left: the dead-oak cell 2 seated on (11,11)
    // is the row at (10,10); a row at (11,11) looks for a prop on (12,12), finds none → twin frame 0.
    const big = variant([oakAt('hero-oak-1', 11 * 32, 12 * 32, { footprint: [2, 2], frame: 2 })]);
    expect(realmKitObstacleKindFor(big, big.placements.at(-1)!)).toBe('tree_old');
    expect(realmKitObstacleSpriteAt(big, 10, 10, 'tree_old', 'intact')).toEqual({ asset: big.assets.find(a => a.id === 'oak'), frame: 2 });
    expect(realmKitObstacleSpriteAt(big, 11, 11, 'tree_old', 'intact')).toEqual({ asset: big.assets.find(a => a.id === 'oak'), frame: 0 });
    expect(() => realmKitObstacleSpriteAt(m, 10, 10, 'dragon', 'intact')).toThrow();
    expect(() => realmKitObstacleSpriteAt(m, 10, 10, 'bush', 'gone' as never)).toThrow();
    expect(() => realmKitObstacleSpriteAt(m, 10.5, 10, 'bush', 'intact')).toThrow();
  });
});
