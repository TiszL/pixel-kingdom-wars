import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fantasyTiles, FANTASY_WORLD_ID } from '@shardkeep/shared/fantasyWorld';
import { getFantasyGlobe, getFantasyParcel, getFantasyViewport, searchFantasyPlayers } from '../src/game/fantasyGlobe';
import { getEffectiveShieldStatus } from '../src/game/baseShields';
import { buildDeedMetadataForAsset } from '../src/game/deedMetadata';
import { getFantasyClaim } from '../src/game/fantasyLocation';
import { fantasyPublishingScope } from '../src/game/fantasyPublishing';
import { getGameConfig, setShieldlessMode } from '../src/game/gameConfig';
import { bases, baseSlots, fantasyLandClaims, players, shields } from '../src/db/schema';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';

const conn = isolatedFantasyTestDb(); const db = conn.db;
beforeAll(async () => { await conn.prepare(); vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('FANTASY_WORLD_ENABLED', 'true'); });
afterAll(async () => { vi.unstubAllEnvs(); await conn.dispose(); });
const rectangle = (tileId: number) => { const x = tileId % 720, y = Math.floor(tileId / 720); return { x0: x, x1: x, y0: y, y1: y }; };

describe('persisted fantasy globe', () => {
  it('pauses sales without reopening publication for held or unmigrated legacy deeds', async () => {
    const assigned = await fantasyBaseFixture(db, { installClaim: true });
    const held = await fantasyBaseFixture(db, { installClaim: true, inactive: true });
    const legacy = await fantasyBaseFixture(db);
    vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
    try {
      const published = (await db.select({ id: bases.id }).from(bases).where(fantasyPublishingScope())).map(b => b.id);
      expect(published).toContain(assigned.baseId);
      expect(published).not.toContain(held.baseId);
      expect(published).not.toContain(legacy.baseId);
    } finally { vi.stubEnv('FANTASY_WORLD_ENABLED', 'true'); }
  });
  it('searches only real visible locations and exposes no historical address fields', async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true });
    const name = `Fantasy-${randomUUID()}`;
    await db.update(players).set({ name }).where(eq(players.wallet, f.wallet));
    const results = (await searchFantasyPlayers(db, name)).results;
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]!).sort()).toEqual(['avatarUrl', 'keepLevel', 'name', 'realmId', 'seeker', 'tileId', 'trophies']);
    await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId));
    expect((await searchFantasyPlayers(db, name)).results).toEqual([]);
  });
  it('reports frozen supply and only real owner locations, never sample owners', async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true });
    const overview = await getFantasyGlobe(db, f.wallet, f.baseId);
    expect(overview.realms).toHaveLength(8);
    expect(overview.realms.reduce((n, r) => n + r.total, 0)).toBe(85_414);
    expect(overview.realms.find(r => r.realmId === 'seeker-reach')).toMatchObject({ total: 5582, available: 0, occupied: 0 });
    expect(overview.me.ownedTiles).toHaveLength(1);
    expect(overview.me.ownedTiles[0]).toMatchObject({ baseId: f.baseId, realmId: 'crownlands', selected: true });
    await expect(getFantasyGlobe(db, f.wallet, randomUUID())).rejects.toThrow();
  });

  it('never discloses wallet, balances, inactive or held owners through bulk markers', async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true });
    const claim = (await getFantasyClaim(db, f.baseId))!;
    const shown = await getFantasyViewport(db, rectangle(claim.tileId));
    expect(shown.markers).toHaveLength(1);
    // D-NEXT (owner 2026-09-26) added exactly one public field, the effective
    // `shielded` boolean; this explicit list still refuses every other key.
    expect(Object.keys(shown.markers[0]!).sort()).toEqual(['avatarUrl', 'keepLevel', 'name', 'shielded', 'tileId']);
    await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    expect((await getFantasyViewport(db, rectangle(claim.tileId))).markers).toEqual([]);
    const held = await fantasyBaseFixture(db, { inactive: true, installClaim: true });
    const heldClaim = (await getFantasyClaim(db, held.baseId))!;
    expect((await getFantasyViewport(db, rectangle(heldClaim.tileId))).markers).toEqual([]);
    expect(await getFantasyParcel(db, f.wallet, heldClaim.tileId)).toMatchObject({ availability: 'held', detail: null });
  });

  it('shows reserved Solana land and ordinary availability without issuing or claiming it', async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true });
    const solana = fantasyTiles('seeker-reach').next().value!;
    expect(await getFantasyParcel(db, f.wallet, solana.tileId)).toMatchObject({ availability: 'reserved', detail: null });
    const ordinary = fantasyTiles('frostveil').next().value!;
    expect(await getFantasyParcel(db, f.wallet, ordinary.tileId)).toMatchObject({ availability: 'available', detail: null });
    await expect(getFantasyParcel(db, f.wallet, 0)).rejects.toThrow('not deeded terrain');
    expect(await db.select().from(fantasyLandClaims).where(and(eq(fantasyLandClaims.worldId, FANTASY_WORLD_ID), eq(fantasyLandClaims.tileId, solana.tileId)))).toEqual([]);
  });

  it('inspects an owned deed and creates metadata from its frozen fantasy identity without an Earth plot', async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true });
    const claim = (await getFantasyClaim(db, f.baseId))!;
    const parcel = await getFantasyParcel(db, f.wallet, claim.tileId, f.now, f.baseId);
    expect(parcel.availability).toBe('occupied');
    expect(parcel.detail?.base.id).toBe(f.baseId);
    expect(parcel.detail?.actions.scout.blockedBy).toBe('self');
    expect(parcel.detail).not.toHaveProperty('parcel');
    const metadata = (await buildDeedMetadataForAsset(db, f.mintId))!;
    const attrs = Object.fromEntries(metadata.attributes.map(a => [a.trait_type, a.value]));
    expect(attrs).toMatchObject({ Realm: 'Crownlands', Tile: `fantasy-v1 · ${claim.tileId}` });
    expect(attrs).not.toHaveProperty('Country');
    expect(JSON.stringify(metadata)).not.toContain('Earth');
  });
});

// D-NEXT (owner 2026-09-26: shielded state on the public realm feed). The owner
// wants a dome on EVERY shielded kingdom while browsing the realm map (native and
// web) plus a SHIELDED filter, so attackers and owners can see protection before
// they open a card. The flag must be the raid gate's own answer — a dome on a
// kingdom the server would let you raid, or none on one it refuses, is a lie —
// and it must be the ONLY new thing: no clock, loot, presence, wallet or raid state.
describe('effective shield state on the public realm feed', () => {
  const HOUR = 3_600_000;
  const MARKER_KEYS = ['avatarUrl', 'keepLevel', 'name', 'shielded', 'tileId'];
  const kingdom = async () => {
    const f = await fantasyBaseFixture(db, { installClaim: true });
    return { ...f, tileId: (await getFantasyClaim(db, f.baseId))!.tileId };
  };
  type Kingdom = Awaited<ReturnType<typeof kingdom>>;
  const shieldFor = (k: Kingdom, source: 'loss' | 'purchase' | 'warzone', expiresAt: Date) =>
    db.insert(shields).values({ playerWallet: k.wallet, baseId: k.baseId, source, expiresAt });
  /** The smallest feed window holding every kingdom (the Crownlands fill is a tight spiral). */
  const windowOf = (ks: Kingdom[]) => {
    const xs = ks.map(k => k.tileId % 720), ys = ks.map(k => Math.floor(k.tileId / 720));
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const feedOf = async (ks: Kingdom[], now: Date) => {
    const feed = await getFantasyViewport(db, windowOf(ks), undefined, now);
    return { feed, marker: (k: Kingdom) => feed.markers.find(m => m.tileId === k.tileId)! };
  };

  it('is true only for a live shield, false for none or an expired one, on every marker and with no clock', async () => {
    const now = new Date();
    const bare = await kingdom(), guarded = await kingdom(), lapsed = await kingdom();
    const expiry = new Date(now.getTime() + 12 * HOUR);
    await shieldFor(guarded, 'purchase', expiry);
    await shieldFor(lapsed, 'loss', new Date(now.getTime() - 1));
    const { feed, marker } = await feedOf([bare, guarded, lapsed], now);
    expect(marker(guarded).shielded).toBe(true);
    expect(marker(bare).shielded).toBe(false);
    expect(marker(lapsed).shielded).toBe(false);
    // Always present (a decoder may rely on it) and nothing else was added.
    expect(feed.markers.length).toBeGreaterThanOrEqual(3);
    for (const m of feed.markers) {
      expect(Object.keys(m).sort()).toEqual(MARKER_KEYS);
      expect(typeof m.shielded).toBe('boolean');
    }
    // The feed publishes that protection exists, never when it ends.
    const wire = JSON.stringify(feed);
    expect(wire).not.toContain(expiry.toISOString());
    expect(wire).not.toContain(guarded.wallet);
    // Parity with the raid gate's resolver for the same deed at the same instant.
    for (const k of [bare, guarded, lapsed]) {
      expect(marker(k).shielded).toBe((await getEffectiveShieldStatus(db, k.wallet, now, false, k.baseId)).active);
    }
  });

  it('drops an ordinary shield while a warzone suppresses it, keeps a paid warzone shield, and restores it after', async () => {
    const now = new Date();
    const ordinary = await kingdom(), paidWarzone = await kingdom();
    await shieldFor(ordinary, 'purchase', new Date(now.getTime() + 12 * HOUR));
    await shieldFor(paidWarzone, 'warzone', new Date(now.getTime() + 12 * HOUR));
    const before = await getGameConfig(db);
    await setShieldlessMode(db, 'purge', { purgeStartAt: new Date(now.getTime() - 1), purgeEndAt: new Date(now.getTime() + HOUR) });
    try {
      const { marker } = await feedOf([ordinary, paidWarzone], now);
      // The raid gate lets attackers through a suppressed ordinary shield, so no dome.
      expect(marker(ordinary).shielded).toBe(false);
      expect(marker(paidWarzone).shielded).toBe(true);
      for (const k of [ordinary, paidWarzone]) {
        expect(marker(k).shielded).toBe((await getEffectiveShieldStatus(db, k.wallet, now, true, k.baseId)).active);
      }
    } finally {
      await setShieldlessMode(db, before.shieldlessMode, before.purgeStartAt && before.purgeEndAt
        ? { purgeStartAt: before.purgeStartAt, purgeEndAt: before.purgeEndAt } : undefined);
    }
    // The ordinary clock kept running through the window and protects again after it.
    expect((await feedOf([ordinary], now)).marker(ordinary).shielded).toBe(true);
  });

  it('reads shields in one batched query however many kingdoms the window shows', async () => {
    // The feed is polled every WORLD.mapPollSec for up to 1,024 kingdoms per
    // window; a per-marker shield read would multiply that cost by the window size.
    const now = new Date();
    const ks = [await kingdom(), await kingdom(), await kingdom(), await kingdom()];
    await shieldFor(ks[0]!, 'purchase', new Date(now.getTime() + HOUR));
    await shieldFor(ks[2]!, 'loss', new Date(now.getTime() + HOUR));
    const measure = async (rect: { x0: number; x1: number; y0: number; y1: number }) => {
      const select = vi.spyOn(db, 'select'), execute = vi.spyOn(db, 'execute');
      try {
        const feed = await getFantasyViewport(db, rect, undefined, now);
        return { markers: feed.markers.length, queries: select.mock.calls.length + execute.mock.calls.length };
      } finally { select.mockRestore(); execute.mockRestore(); }
    };
    const one = await measure(rectangle(ks[0]!.tileId));
    const many = await measure(windowOf(ks));
    expect(one.markers).toBe(1);
    expect(many.markers).toBeGreaterThanOrEqual(ks.length);
    expect(many.queries).toBe(one.queries);
    // Catalog guard + kingdoms + warzone config (in parallel) + ONE shields batch.
    expect(one.queries).toBe(4);
  });
});
