/**
 * THE GLOBE'S PARCEL BAND — the data contract, and its privacy floor
 * (P6, docs/LAND-DEED-ONBOARDING-PLAN.md · locked owner decisions 2026-08-09).
 *
 * Below GLOBE.localZoom the globe stops drawing valley pins and draws ONE PIN PER
 * OCCUPIED PARCEL: "each land parcel is one player's base", which is the sentence
 * the whole track exists to make visually true. The server side of that is a
 * decision, not a feature — the decision being that `GET /map` ALREADY carries it:
 * the rect defaults to the whole 25×20 valley and every occupied plot in the rect
 * produces exactly one marker.
 *
 * So these tests exist to keep that claim true, because it is now load-bearing for
 * a band nothing else feeds:
 *  1. COVERAGE — one entry per occupied parcel, and camps are not parcels.
 *  2. SPATIAL AUTHORITY — every player/silhouette carries the exact frozen
 *     `plots.earth_cell`; camps never do. The client must not reconstruct it.
 *  3. THE FLOOR — a FOREIGN valley entry carries only public name + opaque
 *     avatar identity. Wallet and game-state fields remain per-cell detail.
 *
 * (3) is the rule a "parcel view" is most likely to break by accident. A flatter
 * per-parcel array is the obvious way to serve a band that draws dots, and the
 * obvious way to write it is one loop over the roster — which is how a wallet gets
 * out. There is deliberately no such array; the markers ARE the parcels.
 */
import { randomUUID } from 'node:crypto';
import { PVE, pvpAttackAllowed, WORLD } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { players, plots, pveCamps } from '../src/db/schema';
import { ensurePlotAssigned, getMapChunk, makeCampSnapshot } from '../src/game/world';
import { resetMapCache } from '../src/lib/mapCache';
import { connectTestDb, createTestPlayer, createTestValley, randomWallet, seedPlot } from './helpers';

const conn = connectTestDb();
const db = conn.db;

afterAll(async () => { await conn.sql.end(); });

/** The band's request: the whole valley, which is also `GET /map`'s DEFAULT rect
 *  (MapQuery in game/routes.ts). If that default ever narrows, the parcel band
 *  loses parcels — which is why the constant is spelled out from WORLD here. */
const WHOLE_VALLEY = {
  x0: 0, y0: 0, x1: WORLD.gridCols - 1, y1: WORLD.gridRows - 1,
  parcelBand: true,
};

interface Occupant {
  wallet: string; name: string; x: number; y: number; trophies: number;
  avatarGeneration: string;
}

/**
 * A valley with three occupied parcels and one camp. Trophies are chosen against
 * the raid window so BOTH marker kinds appear on the owner's own read: two
 * neighbours inside it (promotable to full markers) and one far outside it
 * (silhouette). A test that only produced one kind would not notice the band
 * losing the other.
 */
async function seededValley(label: string): Promise<{ valleyId: string; occupants: Occupant[]; campId: string }> {
  const v = await createTestValley(db, {
    name: `${label} PARCEL VALE`,
    // Backdated: real signups go to the NEWEST valley, and a fresh one here would
    // hijack every ensurePlotAssigned in the run.
    createdAt: new Date('2000-01-06T00:00:00Z'),
  });
  const occupants: Occupant[] = [
    { wallet: randomWallet(), name: `${label}_NEIGHBOUR_A`, x: 3, y: 4, trophies: 300, avatarGeneration: randomUUID() },
    { wallet: randomWallet(), name: `${label}_NEIGHBOUR_B`, x: 11, y: 9, trophies: 300, avatarGeneration: randomUUID() },
    { wallet: randomWallet(), name: `${label}_STRANGER_C`, x: 20, y: 17, trophies: 9_000, avatarGeneration: randomUUID() },
  ];
  for (const o of occupants) {
    await db.insert(players).values({
      wallet: o.wallet, name: o.name, trophies: o.trophies,
      keepLevel: 4, entryPaidAt: new Date(),
      avatarHash: 'a'.repeat(64), avatarGeneration: o.avatarGeneration,
    });
    await seedPlot(db, { valleyId: v.id, x: o.x, y: o.y, playerWallet: o.wallet });
  }
  const [camp] = await db.insert(pveCamps).values({
    valleyId: v.id, x: 6, y: 6, tier: 1,
    snapshot: makeCampSnapshot(1), lootKeep: BigInt(PVE.bountyByTier[0]!),
  }).returning();
  return { valleyId: v.id, occupants, campId: camp!.id };
}

const parcelKeys = (markers: readonly { kind: string; x: number; y: number }[]): string[] =>
  markers.filter((m) => m.kind !== 'pve').map((m) => `${m.x},${m.y}`).sort();

describe('parcel band coverage', () => {
  it('YOUR valley: one minimal entry per occupied parcel, and no camp payload', async () => {
    // WHY: the band draws one dot per parcel, so a missing entry is a base that
    // does not exist as far as the world is concerned — and an extra one (a camp
    // treated as a parcel) is a dot the player can never own or visit.
    const seeded = await seededValley('OWN');
    const me = await createTestPlayer(db);
    await db.update(players).set({ trophies: 300, entryPaidAt: new Date() })
      .where(eq(players.wallet, me.wallet));
    await seedPlot(db, { valleyId: seeded.valleyId, x: 0, y: 0, playerWallet: me.wallet });

    resetMapCache();
    const res = await getMapChunk(db, me.wallet, { ...WHOLE_VALLEY, valleyId: seeded.valleyId });

    expect(res.visiting).toBe(false);
    // The occupied set from the DB — the parcel band's own definition of truth.
    const occupied = await db.select({ x: plots.x, y: plots.y, earthCell: plots.earthCell }).from(plots)
      .where(eq(plots.valleyId, seeded.valleyId));
    expect(parcelKeys(res.markers)).toEqual(occupied.map((p) => `${p.x},${p.y}`).sort());
    for (const p of occupied) {
      const marker = res.markers.find((m) => m.kind !== 'pve' && m.x === p.x && m.y === p.y);
      expect(marker, 'every stored plot must produce a marker').toBeDefined();
      expect(marker).toHaveProperty('earthCell', p.earthCell);
    }
    // The explicit globe projection omits camps entirely: their ids and PvE
    // state belong to the tactical map, not the deed parcel directory.
    const camps = res.markers.filter((m) => m.kind === 'pve');
    expect(camps).toEqual([]);

    for (const marker of res.markers) {
      const allowed = [
        'avatarUrl', 'earthCell', 'keepLevel', 'kind', 'name', 'trophies', 'x', 'y',
        ...(marker.kind === 'silhouette' && marker.isMe ? ['isMe'] : []),
      ].sort();
      expect(Object.keys(marker).sort()).toEqual(allowed);
      const loose = marker as unknown as Record<string, unknown>;
      for (const forbidden of [
        'wallet', 'avatarHash', 'avatarGeneration', 'shielded', 'surplusTease',
        'clanTag', 'seeker', 'online', 'burning', 'inWindow', 'revenge',
      ]) expect(loose[forbidden]).toBeUndefined();
    }
  });

  it('a FOREIGN valley: every parcel carries only minimal public profile identity', async () => {
    // WHY: the band is reachable for any valley on the globe — that is the payoff
    // of building a globe — so its foreign form is the scrapeable surface. It must
    // cover the parcels (or a visited valley renders empty) without widening the
    // marker into wallet, presence, shield or loot state.
    const visitor = await createTestPlayer(db);
    await db.update(players).set({ trophies: 300 }).where(eq(players.wallet, visitor.wallet));
    await ensurePlotAssigned(db, visitor.wallet); // the visitor lives somewhere else
    const seeded = await seededValley('FOREIGN');

    // Every occupant shares the visitor's Keep (K1), so all of them clear the
    // D-099 raid gate — exactly the rows the OWN-valley path would promote to
    // full markers with wallet + name.
    expect(pvpAttackAllowed(1, 1)).toBe(true);

    resetMapCache();
    const res = await getMapChunk(db, visitor.wallet, { ...WHOLE_VALLEY, valleyId: seeded.valleyId });

    expect(res.visiting).toBe(true);
    expect(parcelKeys(res.markers)).toEqual(seeded.occupants.map((o) => `${o.x},${o.y}`).sort());
    const stored = await db.select({ x: plots.x, y: plots.y, earthCell: plots.earthCell }).from(plots)
      .where(eq(plots.valleyId, seeded.valleyId));
    for (const p of stored) {
      const marker = res.markers.find((m) => m.kind === 'silhouette' && m.x === p.x && m.y === p.y);
      expect(marker).toHaveProperty('earthCell', p.earthCell);
    }
  });

  it('publishes name + opaque avatar, never wallet or internal roster fields', async () => {
    const visitor = await createTestPlayer(db);
    await db.update(players).set({ trophies: 300 }).where(eq(players.wallet, visitor.wallet));
    await ensurePlotAssigned(db, visitor.wallet);
    const seeded = await seededValley('EXTRACT');

    resetMapCache();
    const res = await getMapChunk(db, visitor.wallet, { ...WHOLE_VALLEY, valleyId: seeded.valleyId });

    for (const o of seeded.occupants) {
      // The identity EXISTS for this parcel — the test would be vacuous otherwise.
      const [row] = await db.select({ wallet: plots.playerWallet }).from(plots)
        .where(eq(plots.playerWallet, o.wallet));
      expect(row?.wallet).toBe(o.wallet);

      const entry = res.markers.find((m) => m.kind !== 'pve' && m.x === o.x && m.y === o.y);
      expect(entry, 'the parcel must still be on the band').toBeDefined();
      // The EXACT key set: RosterRow also holds seeker, shield, loot tease,
      // presence and wallet. None may ride along through an object spread.
      expect(Object.keys(entry!).sort()).toEqual([
        'avatarUrl', 'earthCell', 'keepLevel', 'kind', 'name', 'trophies', 'x', 'y',
      ]);
      const loose = entry as unknown as Record<string, unknown>;
      expect(loose['wallet']).toBeUndefined();
      expect(loose['name']).toBe(o.name);
      expect(loose['avatarUrl']).toBe(`/api/avatars/${o.avatarGeneration}.webp`);
      expect(loose['avatarHash']).toBeUndefined();
      expect(loose['avatarGeneration']).toBeUndefined();
      for (const forbidden of ['shielded', 'surplusTease', 'clanTag', 'seeker', 'online', 'burning']) {
        expect(loose[forbidden]).toBeUndefined();
      }
    }

    // Nothing anywhere else in the body either — not in `recommended` (the WAR
    // ROOM shortlist is a wallet list, and a visitor gets none of it), not in a
    // camp id, not in a field a future refactor adds.
    const body = JSON.stringify(res);
    for (const o of seeded.occupants) {
      expect(body).not.toContain(o.wallet);
      expect(body).toContain(o.name);
      expect(body).not.toContain('a'.repeat(64));
    }
    expect(res.recommended).toEqual([]);
    // The selected-cell detail route may subsequently disclose one wallet; that
    // deliberate, metered action does not widen this bulk response.
  });
});
