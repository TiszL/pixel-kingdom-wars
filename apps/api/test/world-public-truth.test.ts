import { requiredFixture } from './helpers';
/**
 * Public-world admission is deed truth, not "has a plots row". Production kept
 * historical unpaid and inactive fixtures for rollback, so every read boundary
 * must independently refuse to turn those rows into globe/map/search targets.
 */
import { BuildingType } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots, builderJobs, buildings, players, plots, raids } from '../src/db/schema';
import { globeContext } from '../src/game/globe';
import {
  ensureBasePlotAssigned, getMapChunk, getParcelDetail, searchPlayers,
} from '../src/game/world';
import type { MapPlayerMarker } from '../src/game/world';
import { breakBaseShieldOnAttack } from '../src/game/baseShields';
import { grantWarzoneShield } from '../src/game/warzoneShield';
import { clearPlayerAvatar, uploadPlayerAvatar } from '../src/game/playerAvatar';
import { setUsername } from '../src/game/username';
import { resetGlobeCache } from '../src/lib/globeCache';
import { mapCacheLoads, resetMapCache } from '../src/lib/mapCache';
import {
  connectTestDb, createTestPlayer, createTestValley, seedPlot,
} from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];

interface SeededBase {
  wallet: string;
  baseId: string;
  earthCell: number;
}

async function stableBase(
  valleyId: string,
  x: number,
  opts: { paid: boolean; status?: 'active' | 'inactive'; slotted?: boolean; slotActive?: boolean },
): Promise<SeededBase> {
  const player = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({
    ownerWallet: player.wallet,
    status: opts.status ?? 'active',
    landPaidAt: opts.paid ? new Date('2026-01-01T00:00:00Z') : null,
  }).returning({ id: bases.id });
  if (opts.slotted !== false) {
    await db.insert(baseSlots).values({
      wallet: player.wallet, slot: 1, baseId: base!.id,
      active: opts.slotActive ?? true,
    });
  }
  await seedPlot(db, {
    valleyId, x, y: 7, playerWallet: player.wallet, baseId: base!.id,
  });
  const [plot] = await db.select({ earthCell: plots.earthCell }).from(plots)
    .where(eq(plots.baseId, base!.id));
  return { wallet: player.wallet, baseId: base!.id, earthCell: requiredFixture(plot!.earthCell) };
}

beforeAll(() => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
});

afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  resetGlobeCache();
  resetMapCache();
  await conn.sql.end();
});

describe('paid active slotted public world', () => {
  it('publishes username/avatar changes through an already-warm valley cache', async () => {
    const valley = await createTestValley(db, { name: `IDENTITY VALE ${Date.now()}` });
    const viewer = await stableBase(valley.id, 14, { paid: true });
    const target = await stableBase(valley.id, 15, { paid: true });
    const map = async () => getMapChunk(db, viewer.wallet, {
      baseId: viewer.baseId, valleyId: valley.id, x0: 0, y0: 0, x1: 24, y1: 19,
    });
    const targetMarker = (chunk: Awaited<ReturnType<typeof map>>) => chunk.markers
      .find((marker): marker is MapPlayerMarker => (
        marker.kind === 'player' && marker.baseId === target.baseId
      ));

    resetMapCache();
    expect(targetMarker(await map())).toBeDefined();
    const initialLoads = mapCacheLoads();

    const name = `Id_${Date.now().toString(36)}`;
    await setUsername(db, target.wallet, name);
    expect(targetMarker(await map())).toMatchObject({ name, avatarUrl: null });
    expect(mapCacheLoads()).toBe(initialLoads + 1);

    const put = vi.fn(async () => undefined);
    await uploadPlayerAvatar(db, {
      publicBaseUrl: 'https://avatar.test', put, delete: async () => undefined,
    }, target.wallet, await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#123456' },
    }).jpeg().toBuffer(), 'image/jpeg');
    const withAvatar = targetMarker(await map());
    expect(withAvatar?.avatarUrl).toMatch(/^\/api\/avatars\/[0-9a-f-]{36}\.webp$/);
    expect(withAvatar?.avatarUrl).not.toContain(target.wallet);
    expect(withAvatar?.avatarUrl).not.toContain('https://avatar.test');
    expect(put).toHaveBeenCalledTimes(1);

    await clearPlayerAvatar(db, 'https://avatar.test', target.wallet);
    expect(targetMarker(await map())).toMatchObject({ name, avatarUrl: null });
  });

  it('publishes only the real active deed while retaining a paid inactive deed privately', async () => {
    const valley = await createTestValley(db, { name: `TRUTH VALE ${Date.now()}` });
    const owner = await createTestPlayer(db);
    await db.update(players).set({ name: 'TRUTH_ACTIVE_OWNER' })
      .where(eq(players.wallet, owner.wallet));
    const [active] = await db.insert(bases).values({
      ownerWallet: owner.wallet, landPaidAt: new Date('2026-01-01T00:00:00Z'),
    }).returning({ id: bases.id });
    const [inactive] = await db.insert(bases).values({
      ownerWallet: owner.wallet, status: 'inactive',
      landPaidAt: new Date('2026-01-01T00:00:00Z'),
    }).returning({ id: bases.id });
    await db.insert(baseSlots).values([
      { wallet: owner.wallet, slot: 1, baseId: active!.id, active: true },
      { wallet: owner.wallet, slot: 2, baseId: inactive!.id, active: false },
    ]);
    await seedPlot(db, {
      valleyId: valley.id, x: 1, y: 7, playerWallet: owner.wallet, baseId: active!.id,
    });
    await seedPlot(db, {
      valleyId: valley.id, x: 2, y: 7, playerWallet: owner.wallet, baseId: inactive!.id,
    });

    const unpaid = await stableBase(valley.id, 3, { paid: false });
    const unslotted = await stableBase(valley.id, 4, { paid: true, slotted: false });
    const inactiveOther = await stableBase(valley.id, 5, {
      paid: true, status: 'inactive', slotActive: false,
    });
    await db.update(players).set({ name: 'TRUTH_UNPAID_FAKE' })
      .where(eq(players.wallet, unpaid.wallet));
    await db.update(players).set({ name: 'TRUTH_UNSLOTTED_FAKE' })
      .where(eq(players.wallet, unslotted.wallet));
    await db.update(players).set({ name: 'TRUTH_INACTIVE_FAKE' })
      .where(eq(players.wallet, inactiveOther.wallet));

    resetGlobeCache();
    resetMapCache();
    const ctx = await globeContext(db, owner.wallet, new Date(), active!.id);
    expect(ctx.snap.byValleyId.get(valley.id)?.players).toBe(1);
    expect(ctx.me.ownedParcels.map((row) => row.baseId).sort())
      .toEqual([active!.id, inactive!.id].sort());
    expect(ctx.me.ownedParcels.find((row) => row.baseId === inactive!.id)?.active).toBe(false);

    const map = await getMapChunk(db, owner.wallet, {
      baseId: active!.id, valleyId: valley.id, x0: 0, y0: 0, x1: 24, y1: 19,
    });
    expect(map.markers.filter((marker) => marker.kind !== 'pve')).toHaveLength(1);
    expect(map.markers[0]).toMatchObject({ kind: 'player', baseId: active!.id, isMe: true });

    // WHY: shield state lives in the shared valley cache. A grant/break that
    // does not evict it leaves the globe drill-down lying until the TTL lapses.
    const now = new Date();
    await grantWarzoneShield(db, owner.wallet, now, active!.id);
    const shieldedMap = await getMapChunk(db, owner.wallet, {
      baseId: active!.id, valleyId: valley.id, x0: 0, y0: 0, x1: 24, y1: 19,
    }, now);
    expect(shieldedMap.markers[0]).toMatchObject({ baseId: active!.id, shielded: true });
    await breakBaseShieldOnAttack(db, owner.wallet, active!.id);
    const unshieldedMap = await getMapChunk(db, owner.wallet, {
      baseId: active!.id, valleyId: valley.id, x0: 0, y0: 0, x1: 24, y1: 19,
    }, now);
    expect(unshieldedMap.markers[0]).toMatchObject({ baseId: active!.id, shielded: false });

    expect((await searchPlayers(db, 'TRUTH_ACTIVE_OWNER')).results)
      .toContainEqual(expect.objectContaining({ baseId: active!.id }));
    for (const fakeName of ['TRUTH_UNPAID_FAKE', 'TRUTH_UNSLOTTED_FAKE', 'TRUTH_INACTIVE_FAKE']) {
      expect((await searchPlayers(db, fakeName)).results).toEqual([]);
    }

    for (const hidden of [unpaid, unslotted, inactiveOther]) {
      await expect(getParcelDetail(db, owner.wallet, hidden.earthCell, new Date(), active!.id))
        .rejects.toMatchObject({ statusCode: 404 });
    }

    const [activePlot] = await db.select({ earthCell: plots.earthCell }).from(plots)
      .where(and(eq(plots.baseId, active!.id), eq(plots.valleyId, valley.id)));
    await expect(getParcelDetail(db, owner.wallet, requiredFixture(activePlot!.earthCell), new Date(), active!.id))
      .resolves.toMatchObject({ base: { id: active!.id } });
  });

  it('keeps legacy unpaid plots out of globe, valley, search and parcel detail', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'false';
    try {
      const valley = await createTestValley(db, { name: `LEGACY TRUTH ${Date.now()}` });
      const viewer = await createTestPlayer(db);
      const paid = await createTestPlayer(db);
      const unpaid = await createTestPlayer(db);
      await db.update(players).set({
        name: 'LEGACY_TRUTH_VIEWER', entryPaidAt: new Date('2026-01-01T00:00:00Z'),
      }).where(eq(players.wallet, viewer.wallet));
      await db.update(players).set({
        name: 'LEGACY_TRUTH_PAID', entryPaidAt: new Date('2026-01-01T00:00:00Z'),
      }).where(eq(players.wallet, paid.wallet));
      await db.update(players).set({ name: 'LEGACY_TRUTH_UNPAID' })
        .where(eq(players.wallet, unpaid.wallet));
      await seedPlot(db, { valleyId: valley.id, x: 6, y: 7, playerWallet: viewer.wallet });
      await seedPlot(db, { valleyId: valley.id, x: 7, y: 7, playerWallet: paid.wallet });
      await seedPlot(db, { valleyId: valley.id, x: 8, y: 7, playerWallet: unpaid.wallet });
      const [unpaidPlot] = await db.select({ earthCell: plots.earthCell }).from(plots)
        .where(eq(plots.playerWallet, unpaid.wallet));

      resetGlobeCache();
      resetMapCache();
      const ctx = await globeContext(db, viewer.wallet);
      expect(ctx.snap.byValleyId.get(valley.id)?.players).toBe(2);
      const map = await getMapChunk(db, viewer.wallet, {
        valleyId: valley.id, x0: 0, y0: 0, x1: 24, y1: 19,
      });
      expect(map.markers.some((marker) => marker.kind === 'player'
        && marker.wallet === paid.wallet)).toBe(true);
      expect(JSON.stringify(map)).not.toContain(unpaid.wallet);
      expect((await searchPlayers(db, 'LEGACY_TRUTH_UNPAID')).results).toEqual([]);
      await expect(getParcelDetail(db, viewer.wallet, requiredFixture(unpaidPlot!.earthCell)))
        .rejects.toMatchObject({ statusCode: 404 });
    } finally {
      process.env['MULTI_BASE_ENABLED'] = 'true';
    }
  });

  it('previews elapsed Mine builds and refuses targets busy in an outgoing raid', async () => {
    const now = new Date('2026-08-13T12:00:00.000Z');
    const valley = await createTestValley(db, { name: `TRUTH PREVIEW ${Date.now()}` });
    const viewer = await stableBase(valley.id, 9, { paid: true });
    const target = await stableBase(valley.id, 12, { paid: true });
    const [mine] = await db.insert(buildings).values({
      playerWallet: target.wallet,
      baseId: target.baseId,
      type: BuildingType.Mine,
      level: 1,
      tx: 10,
      ty: 10,
    }).returning({ id: buildings.id });
    await db.insert(builderJobs).values({
      playerWallet: target.wallet,
      baseId: target.baseId,
      kind: 'build',
      buildingId: mine!.id,
      startedAt: new Date(now.getTime() - 3 * 86_400_000),
      finishesAt: new Date(now.getTime() - 2 * 86_400_000),
    });

    const elapsed = await getParcelDetail(db, viewer.wallet, target.earthCell, now, viewer.baseId);
    expect(elapsed.base.completedStructures).toBe(1);
    expect(BigInt(elapsed.availableLootRanges.threeStars.max)).toBeGreaterThan(0n);

    await db.insert(raids).values({
      attackerWallet: target.wallet,
      attackerBaseId: target.baseId,
      defenderWallet: viewer.wallet,
      defenderBaseId: viewer.baseId,
      seed: 1n,
      snapshot: {},
      armySnapshot: {},
      ordersDeadlineAt: new Date(now.getTime() + 60_000),
      status: 'pending_orders',
    });
    const busy = await getParcelDetail(db, viewer.wallet, target.earthCell, now, viewer.baseId);
    // D-099: every attack preview also carries the Keep-reach figures the client
    // prints ("L{d} vs your L{a}"), even when the block has another cause.
    expect(busy.actions.attack).toEqual({
      allowed: false,
      blockedBy: 'temporarily_unavailable',
      keepReach: {
        attackerKeep: expect.any(Number), defenderKeep: expect.any(Number), minDefenderKeep: expect.any(Number),
      },
    });
  });

  it('publishes a newly assigned paid base through the already-warm globe cache', async () => {
    const valley = await createTestValley(db, { name: `TRUTH ASSIGN ${Date.now()}` });
    const viewer = await stableBase(valley.id, 1, { paid: true });
    const owner = await createTestPlayer(db);
    const [base] = await db.insert(bases).values({
      ownerWallet: owner.wallet,
      landPaidAt: new Date('2026-01-01T00:00:00Z'),
    }).returning({ id: bases.id });
    await db.insert(baseSlots).values({
      wallet: owner.wallet,
      slot: 1,
      baseId: base!.id,
      active: true,
    });

    resetGlobeCache();
    const before = await globeContext(db, viewer.wallet, new Date(), viewer.baseId);

    const assigned = await ensureBasePlotAssigned(db, owner.wallet, base!.id);
    const beforePopulation = before.snap.byValleyId.get(requiredFixture(assigned.valleyId))?.players ?? 0;

    const after = await globeContext(db, viewer.wallet, new Date(), viewer.baseId);
    expect(after.snap.byValleyId.get(requiredFixture(assigned.valleyId))?.players).toBe(beforePopulation + 1);
  });
});
