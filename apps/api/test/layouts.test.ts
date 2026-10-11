/**
 * Saved-layout backend invariants: complete geometry, atomic swaps, optimistic
 * concurrency, raid/ownership fences and one-time deed-local FARM charging.
 */
import { BuildingType, ECONOMY, OBSTACLES } from '@shardkeep/shared';
import { and, asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbTx } from '../src/db/client';
import {
  baseRaidLocks, bases, baseSlots, buildings, builderJobs, layouts as layoutRows,
  ledgerEntries, ledgerTransactions, obstacles, players, raids,
} from '../src/db/schema';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import {
  getBaseLayouts, LAYOUT_GEOMETRY_VERSION, saveBaseLayout, unlockFarmLayout,
  type LayoutPosition,
} from '../src/game/layouts';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { bootstrapSystemAccounts } from '../src/ledger';
import { HttpError } from '../src/lib/errors';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let sequence = 0;
const key = (label: string): string => `layout-${label}-${++sequence}-${Math.random().toString(36).slice(2)}`;

interface Fixture {
  wallet: string;
  baseId: string;
  context: StableBaseMutationContext;
  buildingRows: Array<typeof buildings.$inferSelect>;
}

function authority(baseId: string): StableBaseMutationContext {
  return {
    baseId,
    assertAuthority: async (tx: DbTx, wallet: string, lockedBaseId: string) => {
      const [owned] = await tx.select({ id: bases.id }).from(bases).where(and(
        eq(bases.id, lockedBaseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      ));
      if (!owned) throw new HttpError(409, 'deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
    },
  };
}

async function fixture(opts: { shards?: bigint; expansions?: number } = {}): Promise<Fixture> {
  const owner = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({
    ownerWallet: owner.wallet,
    status: 'active',
    keepLevel: 4,
    expansions: opts.expansions ?? 0,
    landPaidAt: new Date('2026-08-01T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet: owner.wallet, slot: 1, baseId: base!.id, active: true });
  const buildingRows = await db.insert(buildings).values([
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Keep, level: 4, tx: 10, ty: 10 },
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Mine, level: 3, tx: 12, ty: 10 },
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Vault, level: 2, tx: 13, ty: 10 },
  ]).returning();
  if ((opts.shards ?? 0n) > 0n) {
    await rewardBaseShards(
      db, base!.id, opts.shards!, 'test.layout_fund', key('fund'), { testFixture: true },
    );
  }
  return { wallet: owner.wallet, baseId: base!.id, context: authority(base!.id), buildingRows };
}

const positions = (rows: readonly typeof buildings.$inferSelect[]): LayoutPosition[] => rows
  .map((row) => ({ buildingId: row.id, tx: row.tx, ty: row.ty }))
  .sort((a, b) => a.buildingId.localeCompare(b.buildingId));

function slotOf(view: Awaited<ReturnType<typeof getBaseLayouts>>, slot: 'HOME' | 'FARM') {
  return view.slots.find((candidate) => candidate.slot === slot)!;
}

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});

afterAll(async () => {
  await conn.sql.end();
});

describe('authoritative saved layouts', () => {
  it('rejects stale or unknown plot contracts before saving or moving the owned base', async () => {
    const f = await fixture();
    const view = await getBaseLayouts(db, f.wallet, f.baseId);
    const target = positions(f.buildingRows);
    for (const plotVersion of [2, 3, 0]) {
      await expect(saveBaseLayout(db, f.wallet, f.context, 'HOME', {
        geometryVersion: LAYOUT_GEOMETRY_VERSION, plotVersion, mode: 'save_apply',
        expectedSlotEtag: slotOf(view, 'HOME').etag, expectedActiveEtag: view.active.etag,
        positions: target,
      })).rejects.toMatchObject({ code: 'LAYOUT_PLOT_STALE' });
    }
    expect(await db.select().from(layoutRows).where(eq(layoutRows.baseId, f.baseId))).toEqual([]);
    expect(positions(await db.select().from(buildings).where(eq(buildings.baseId, f.baseId)))).toEqual(target);
    const saved = await saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION, plotVersion: 1, mode: 'save',
      expectedSlotEtag: slotOf(view, 'HOME').etag, positions: target,
    });
    expect(saved).not.toHaveProperty('plotVersion');
  });
  it('exposes HOME from the live 30x30 base, hides C, and derives real claim sizes', async () => {
    const fresh = await fixture();
    const view = await getBaseLayouts(db, fresh.wallet, fresh.baseId);
    expect(view).toMatchObject({
      baseId: fresh.baseId,
      geometryVersion: LAYOUT_GEOMETRY_VERSION,
      claim: { min: 8, max: 22, size: 14 },
      active: { slot: null },
      farmUnlock: { locked: true, costShards: ECONOMY.secondLayoutSlotShards },
    });
    expect(view.slots.map((slot) => slot.slot)).toEqual(['HOME', 'FARM']);
    expect(slotOf(view, 'HOME')).toMatchObject({ locked: false, compatibility: 'ready' });
    expect(slotOf(view, 'HOME').positions).toEqual(positions(fresh.buildingRows));

    const expanded = await fixture({ expansions: 6 });
    expect((await getBaseLayouts(db, expanded.wallet, expanded.baseId)).claim)
      .toEqual({ min: 2, max: 28, size: 26 });
  });

  it('applies an occupied-tile swap atomically without changing levels or active jobs', async () => {
    const f = await fixture();
    const mine = f.buildingRows.find((row) => row.type === BuildingType.Mine)!;
    const vault = f.buildingRows.find((row) => row.type === BuildingType.Vault)!;
    const [job] = await db.insert(builderJobs).values({
      playerWallet: f.wallet, baseId: f.baseId, kind: 'upgrade', buildingId: mine.id,
      startedAt: new Date('2026-08-30T10:00:00.000Z'),
      finishesAt: new Date('2026-08-30T11:00:00.000Z'),
    }).returning();
    const view = await getBaseLayouts(db, f.wallet, f.baseId);
    const target = positions(f.buildingRows).map((position) => (
      position.buildingId === mine.id ? { ...position, tx: vault.tx, ty: vault.ty }
        : position.buildingId === vault.id ? { ...position, tx: mine.tx, ty: mine.ty }
          : position
    ));
    const applied = await saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION,
      mode: 'save_apply',
      expectedSlotEtag: slotOf(view, 'HOME').etag,
      expectedActiveEtag: view.active.etag,
      positions: target,
    });
    expect(applied).toMatchObject({ activeSlot: 'HOME', moved: 2, unchanged: 1, replayed: false });
    const after = await db.select().from(buildings).where(eq(buildings.baseId, f.baseId))
      .orderBy(asc(buildings.id));
    expect(after.find((row) => row.id === mine.id)).toMatchObject({ tx: vault.tx, ty: vault.ty, level: 3 });
    expect(after.find((row) => row.id === vault.id)).toMatchObject({ tx: mine.tx, ty: mine.ty, level: 2 });
    expect(await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id))).toEqual([job]);
    expect((await db.select().from(layoutRows).where(and(
      eq(layoutRows.baseId, f.baseId), eq(layoutRows.slot, 'A'),
    )))[0]).toMatchObject({ isActive: true, positions: target });
  });

  it('rolls back missing, duplicate, overlapping, out-of-claim and obstacle-blocked targets', async () => {
    const f = await fixture();
    const view = await getBaseLayouts(db, f.wallet, f.baseId);
    const original = positions(f.buildingRows);
    const homeEtag = slotOf(view, 'HOME').etag;
    const request = (target: LayoutPosition[]) => saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION,
      mode: 'save_apply', expectedSlotEtag: homeEtag,
      expectedActiveEtag: view.active.etag, positions: target,
    });
    await expect(request(original.slice(0, -1))).rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
    await expect(request([...original, original[0]!])).rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
    await expect(request(original.map((p, i) => i < 2 ? { ...p, tx: 10, ty: 10 } : p)))
      .rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
    await expect(request(original.map((p, i) => i === 0 ? { ...p, tx: 0, ty: 0 } : p)))
      .rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
    const movable = original.find((position) => position.buildingId !== f.buildingRows[0]!.id)!;
    await db.insert(obstacles).values({
      playerWallet: f.wallet, baseId: f.baseId,
      spriteKey: OBSTACLES.tiers.small.kinds[0], tx: 15, ty: 15,
    });
    await expect(request(original.map((p) => p.buildingId === movable.buildingId
      ? { ...p, tx: 15, ty: 15 } : p))).rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
    expect(positions(await db.select().from(buildings).where(eq(buildings.baseId, f.baseId))))
      .toEqual(original);
    expect(await db.select().from(layoutRows).where(eq(layoutRows.baseId, f.baseId))).toEqual([]);
  });

  it('returns content replay before stale ETags but rejects a different stale edit', async () => {
    const f = await fixture();
    const view = await getBaseLayouts(db, f.wallet, f.baseId);
    const original = positions(f.buildingRows);
    const mine = f.buildingRows.find((row) => row.type === BuildingType.Mine)!;
    const first = original.map((position) => position.buildingId === mine.id
      ? { ...position, tx: 12, ty: 12 } : position);
    await saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION, mode: 'save',
      expectedSlotEtag: slotOf(view, 'HOME').etag, positions: first,
    });
    const replay = await saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION, mode: 'save',
      expectedSlotEtag: slotOf(view, 'HOME').etag, positions: first,
    });
    expect(replay.replayed).toBe(true);
    const different = first.map((position) => position.buildingId === mine.id
      ? { ...position, tx: 13, ty: 12 } : position);
    await expect(saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION, mode: 'save',
      expectedSlotEtag: slotOf(view, 'HOME').etag, positions: different,
    })).rejects.toMatchObject({ statusCode: 409, code: 'LAYOUT_STALE' });
  });

  it('repairs malformed persisted JSON instead of misclassifying it as a content replay', async () => {
    const f = await fixture();
    const target = positions(f.buildingRows);
    await db.insert(layoutRows).values({
      playerWallet: f.wallet, baseId: f.baseId, slot: 'A',
      positions: [...target, { bogus: true }],
    });
    const view = await getBaseLayouts(db, f.wallet, f.baseId);
    expect(slotOf(view, 'HOME').compatibility).toBe('needs_repair');
    const repaired = await saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION, mode: 'save',
      expectedSlotEtag: slotOf(view, 'HOME').etag, positions: target,
    });
    expect(repaired.replayed).toBe(false);
    const [row] = await db.select().from(layoutRows).where(and(
      eq(layoutRows.baseId, f.baseId), eq(layoutRows.slot, 'A'),
    ));
    expect(row!.positions).toEqual(target);
  });

  it('charges FARM exactly once under concurrent unlocks and refuses insufficient funds', async () => {
    const f = await fixture({ shards: 1_000n });
    const results = await Promise.all([
      unlockFarmLayout(db, f.wallet, f.context, key('unlock-a')),
      unlockFarmLayout(db, f.wallet, f.context, key('unlock-b')),
    ]);
    expect(results.map((result) => result.chargedShards).sort()).toEqual(['0', '500']);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(500n);
    expect(await db.select().from(layoutRows).where(and(
      eq(layoutRows.baseId, f.baseId), eq(layoutRows.slot, 'B'),
    ))).toHaveLength(1);
    const charged = await db.select().from(ledgerTransactions).where(like(
      ledgerTransactions.idempotencyKey, `layout-farm-unlock:${f.baseId}:%`,
    ));
    expect(charged).toHaveLength(1);
    expect((await db.select().from(ledgerEntries).where(eq(
      ledgerEntries.txnId, charged[0]!.id,
    ))).map((entry) => entry.delta).sort((a, b) => a < b ? -1 : 1))
      .toEqual([-500n, 500n]);
    expect((await getBaseLayouts(db, f.wallet, f.baseId)).farmUnlock.locked).toBe(false);
    const again = await unlockFarmLayout(db, f.wallet, f.context, key('unlock-c'));
    expect(again).toMatchObject({ chargedShards: '0', balanceShards: '500' });

    const poor = await fixture();
    await expect(unlockFarmLayout(db, poor.wallet, poor.context, key('poor')))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_SHARDS' });
    expect(await db.select().from(layoutRows).where(and(
      eq(layoutRows.baseId, poor.baseId), eq(layoutRows.slot, 'B'),
    ))).toEqual([]);
  });

  it('blocks apply while an incoming raid lock owns the base', async () => {
    const f = await fixture();
    const attacker = await createTestPlayer(db);
    const [raid] = await db.insert(raids).values({
      attackerWallet: attacker.wallet,
      defenderWallet: f.wallet,
      defenderBaseId: f.baseId,
      seed: 1n,
      snapshot: {},
      armySnapshot: {},
      ordersDeadlineAt: new Date(Date.now() + 60_000),
    }).returning();
    await db.insert(baseRaidLocks).values({
      baseId: f.baseId, raidId: raid!.id, expiresAt: new Date(Date.now() + 60_000),
    });
    const view = await getBaseLayouts(db, f.wallet, f.baseId);
    await expect(saveBaseLayout(db, f.wallet, f.context, 'HOME', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION, mode: 'save_apply',
      expectedSlotEtag: slotOf(view, 'HOME').etag,
      expectedActiveEtag: view.active.etag,
      positions: positions(f.buildingRows),
    })).rejects.toMatchObject({ statusCode: 423, code: 'BASE_BEING_RAIDED' });
  });

  it('keeps FARM entitlement and saved positions on the stable base after transfer', async () => {
    const f = await fixture({ shards: 500n });
    await unlockFarmLayout(db, f.wallet, f.context, key('transfer-unlock'));
    const before = await getBaseLayouts(db, f.wallet, f.baseId);
    await saveBaseLayout(db, f.wallet, f.context, 'FARM', {
      geometryVersion: LAYOUT_GEOMETRY_VERSION, mode: 'save',
      expectedSlotEtag: slotOf(before, 'FARM').etag,
      positions: positions(f.buildingRows),
    });
    const buyer = await createTestPlayer(db);
    await db.transaction(async (tx) => {
      await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, f.wallet)).for('update');
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
      await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
      await tx.insert(baseSlots).values({ wallet: buyer.wallet, slot: 1, baseId: f.baseId, active: true });
    });
    const conveyed = await getBaseLayouts(db, buyer.wallet, f.baseId);
    expect(conveyed.farmUnlock.locked).toBe(false);
    expect(slotOf(conveyed, 'FARM')).toMatchObject({
      compatibility: 'ready', positions: positions(f.buildingRows),
    });
  });
});
