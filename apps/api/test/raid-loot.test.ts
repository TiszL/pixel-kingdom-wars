/**
 * A raid must never discover/debit wallet-global wealth. These tests pin the
 * private deed reservation, exact Formula-A payout, physical-Mine destruction,
 * Forge-position theft, and terminal restoration/unlock as one transaction.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  baseForgePositions,
  baseRaidLocks,
  buildings,
  mineAccrualStates,
  raidLootReservations,
  raids,
} from '../src/db/schema';
import { rewardBaseShards } from '../src/game/baseEconomy';
import {
  releaseDeedRaidLoot,
  reserveDeedRaidLoot,
  settleDeedRaidLoot,
} from '../src/game/raidLoot';
import { currentMineStorageCap } from '../src/game/baseMining';
import {
  bootstrapSystemAccounts,
  getOrCreateBaseAccount,
  postTransaction,
} from '../src/ledger';
import { connectTestDb, createTestPlayer, insertActiveTestBase } from './helpers';

const conn = connectTestDb();
const db = conn.db;

afterAll(async () => { await conn.sql.end(); });

async function fixture(now: Date) {
  const attacker = await createTestPlayer(db);
  const defender = await createTestPlayer(db);
  const attackerBase = await insertActiveTestBase(db, {
    ownerWallet: attacker.wallet,
    status: 'active',
    keepLevel: 5,
  });
  const defenderBase = await insertActiveTestBase(db, {
    ownerWallet: defender.wallet,
    status: 'active',
    keepLevel: 5,
  });
  const [mineA, mineB, vaultA, vaultB] = await db.insert(buildings).values([
    { playerWallet: defender.wallet, baseId: defenderBase!.id, type: 'mine', level: 1, tx: 1, ty: 1 },
    { playerWallet: defender.wallet, baseId: defenderBase!.id, type: 'mine', level: 1, tx: 2, ty: 2 },
    { playerWallet: defender.wallet, baseId: defenderBase!.id, type: 'vault', level: 1, tx: 3, ty: 3 },
    { playerWallet: defender.wallet, baseId: defenderBase!.id, type: 'vault', level: 1, tx: 4, ty: 4 },
  ]).returning();
  await db.insert(mineAccrualStates).values([
    { mineBuildingId: mineA!.id, accruedShards: 700n, lastAccrualAt: now },
    { mineBuildingId: mineB!.id, accruedShards: 300n, lastAccrualAt: now },
  ]);
  await rewardBaseShards(
    db, defenderBase!.id, 10_000n, 'test.raid_liquid', randomUUID(),
  );
  const systems = await bootstrapSystemAccounts(db);
  const defenderForge = await getOrCreateBaseAccount(
    db, defenderBase!.id, 'base_forge_escrow',
  );
  await postTransaction(db, {
    idempotencyKey: randomUUID(),
    type: 'test.raid_forge',
    entries: [
      { account: systems.shard_genesis, delta: -2_000n },
      { account: defenderForge.id, delta: 2_000n },
    ],
  });
  await db.insert(baseForgePositions).values({
    baseId: defenderBase!.id,
    day: '2026-08-12',
    contributedShards: 2_000n,
    updatedAt: now,
  });
  const [raid] = await db.insert(raids).values({
    idempotencyKey: randomUUID(),
    attackerWallet: attacker.wallet,
    attackerBaseId: attackerBase!.id,
    defenderWallet: defender.wallet,
    defenderBaseId: defenderBase!.id,
    seed: 1n,
    snapshot: {},
    armySnapshot: {},
    simVersion: 9,
    ordersDeadlineAt: new Date(now.getTime() + 120_000),
  }).returning();
  await db.insert(baseRaidLocks).values({
    baseId: defenderBase!.id,
    raidId: raid!.id,
    expiresAt: new Date(now.getTime() + 180_000),
  });
  return {
    attackerBase: attackerBase!,
    defenderBase: defenderBase!,
    raid: raid!,
    mineA: mineA!,
    mineB: mineB!,
    vaultA: vaultA!,
    vaultB: vaultB!,
  };
}

describe.sequential('deed raid-loot reservation', () => {
  it('settles a reservation frozen under formula v1 with the v1 destroyed-Vault split', async () => {
    // WHY: the formula version travels with the reservation, never with the code
    // that happens to run at settlement. A raid created before the D-065 cutover
    // must pay exactly what its attacker was promised (75% + 25% × destroyed
    // Vaults), even though new reservations use Vault-level protection.
    const now = new Date('2026-08-12T12:00:00.000Z');
    const f = await fixture(now);
    await db.transaction((tx) => reserveDeedRaidLoot(tx, {
      raidId: f.raid.id, attackerBaseId: f.attackerBase.id, defenderBaseId: f.defenderBase.id, now,
    }));
    await db.update(raidLootReservations).set({ formulaVersion: 1 })
      .where(eq(raidLootReservations.raidId, f.raid.id));
    const settled = await db.transaction((tx) => settleDeedRaidLoot(tx, f.raid.id, 2, [
      { id: f.mineA.id, type: 'mine', destroyed: true },
      { id: f.mineB.id, type: 'mine', destroyed: false },
      { id: f.vaultA.id, type: 'vault', destroyed: true, level: 20 },
      { id: f.vaultB.id, type: 'vault', destroyed: false, level: 20 },
    ], now));
    // 12,000 × 50% × 50% (2★) × 87.5% (one of two Vaults) = 2,625 under v1 —
    // the L20 levels are deliberately ignored by the v1 branch.
    expect(settled.balance).toBe(2_625n);
    expect(settled.total).toBe(3_325n);
  });

  it('pays the exact star/Vault amount plus only destroyed physical Mines', async () => {
    const now = new Date('2026-08-12T12:00:00.000Z');
    const f = await fixture(now);
    await db.update(mineAccrualStates).set({ fullNotificationBootstrapPending: true })
      .where(eq(mineAccrualStates.mineBuildingId, f.mineA.id));
    await db.update(mineAccrualStates).set({ fullNotificationBootstrapPending: true })
      .where(eq(mineAccrualStates.mineBuildingId, f.mineB.id));

    const frozen = await db.transaction((tx) => reserveDeedRaidLoot(tx, {
      raidId: f.raid.id,
      attackerBaseId: f.attackerBase.id,
      defenderBaseId: f.defenderBase.id,
      now,
    }));
    expect(frozen).toEqual({ balancePool: 6_000n, mines: 1_000n, maximum: 7_000n });
    const [reservation] = await db.select().from(raidLootReservations)
      .where(eq(raidLootReservations.raidId, f.raid.id));
    expect(reservation).toMatchObject({
      spendableReservedShards: 5_000n,
      forgeReservedShards: 1_000n,
      mineReservedShards: 1_000n,
      state: 'reserved',
    });

    const settled = await db.transaction((tx) => settleDeedRaidLoot(tx, f.raid.id, 2, [
      { id: f.mineA.id, type: 'mine', destroyed: true },
      { id: f.mineB.id, type: 'mine', destroyed: false },
      { id: f.vaultA.id, type: 'vault', destroyed: true, level: 1 },
      { id: f.vaultB.id, type: 'vault', destroyed: false, level: 1 },
    ], now));
    // D-065 (formula v2): 12,000 × 50% × 50% (2★) = 3,000, of which the
    // standing L1 Vault shields 1.5 of the 50 lootable points (exposure 97%)
    // = 2,910; plus the destroyed Mine's exact 700 buffer. The destroyed Vault
    // contributes no protection. No tithe or clan deduction.
    expect(settled).toEqual({
      total: 3_610n,
      balance: 2_910n,
      mines: 700n,
      fromLiquid: 2_425n,
      fromOpenForge: 485n,
    });
    expect((await getOrCreateBaseAccount(db, f.attackerBase.id, 'base_shards')).balance)
      .toBe(3_610n);
    expect((await getOrCreateBaseAccount(db, f.defenderBase.id, 'base_shards')).balance)
      .toBe(7_575n);
    expect((await getOrCreateBaseAccount(db, f.defenderBase.id, 'base_forge_escrow')).balance)
      .toBe(1_515n);
    const [position] = await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.baseId, f.defenderBase.id),
      eq(baseForgePositions.day, '2026-08-12'),
    ));
    expect(position!.raidDebitedShards).toBe(485n); // the Forge share of the 2,910 balance loot
    const mineStates = await db.select().from(mineAccrualStates);
    expect(mineStates.find((state) => state.mineBuildingId === f.mineA.id)!.accruedShards).toBe(0n);
    expect(mineStates.find((state) => state.mineBuildingId === f.mineB.id)!.accruedShards).toBe(300n);
    expect(mineStates.find((state) => state.mineBuildingId === f.mineA.id)!.fullNotificationCycle).toBe(1);
    expect(mineStates.find((state) => state.mineBuildingId === f.mineB.id)!.fullNotificationCycle).toBe(0);
    // Actual theft starts a new future fill; a restored reservation still needs
    // historical classification, even though both buffers were detached briefly.
    expect(mineStates.find((state) => state.mineBuildingId === f.mineA.id)!.fullNotificationBootstrapPending).toBe(false);
    expect(mineStates.find((state) => state.mineBuildingId === f.mineB.id)!.fullNotificationBootstrapPending).toBe(true);
    // Other test files exercise the global rollout classifier; do not leave
    // this synthetic legacy row pending in their shared integration database.
    await db.update(mineAccrualStates).set({ fullNotificationBootstrapPending: false })
      .where(eq(mineAccrualStates.mineBuildingId, f.mineB.id));
    expect(await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, f.raid.id))).toHaveLength(0);
  });

  it('restores every frozen source and token-fenced lock when combat never starts', async () => {
    const now = new Date('2026-08-12T13:00:00.000Z');
    const f = await fixture(now);
    await db.transaction((tx) => reserveDeedRaidLoot(tx, {
      raidId: f.raid.id,
      attackerBaseId: f.attackerBase.id,
      defenderBaseId: f.defenderBase.id,
      now,
    }));

    await expect(db.transaction((tx) => releaseDeedRaidLoot(tx, f.raid.id, now)))
      .resolves.toBe(true);
    expect((await getOrCreateBaseAccount(db, f.defenderBase.id, 'base_shards')).balance)
      .toBe(10_000n);
    expect((await getOrCreateBaseAccount(db, f.defenderBase.id, 'base_forge_escrow')).balance)
      .toBe(2_000n);
    const mineStates = await db.select().from(mineAccrualStates);
    expect(mineStates.find((state) => state.mineBuildingId === f.mineA.id)!.accruedShards).toBe(700n);
    expect(mineStates.find((state) => state.mineBuildingId === f.mineB.id)!.accruedShards).toBe(300n);
    expect(mineStates.filter((state) => state.mineBuildingId === f.mineA.id
      || state.mineBuildingId === f.mineB.id).map((state) => state.fullNotificationCycle)).toEqual([0, 0]);
    const [reservation] = await db.select().from(raidLootReservations)
      .where(eq(raidLootReservations.raidId, f.raid.id));
    expect(reservation!.state).toBe('released');
    expect(await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, f.raid.id))).toHaveLength(0);
  });

  it('never restores a frozen Mine buffer above its one-day physical capacity', async () => {
    const now = new Date('2026-08-12T14:00:00.000Z');
    const f = await fixture(now);
    await db.transaction((tx) => reserveDeedRaidLoot(tx, {
      raidId: f.raid.id,
      attackerBaseId: f.attackerBase.id,
      defenderBaseId: f.defenderBase.id,
      now,
    }));
    const cap = await currentMineStorageCap(db, f.mineA.id);
    // Models accrual/re-anchoring while the raid's original 700 SHARDS are
    // detached. Restoring them must saturate the Mine, never create >1 day.
    await db.update(mineAccrualStates).set({ accruedShards: cap - 1n })
      .where(eq(mineAccrualStates.mineBuildingId, f.mineA.id));

    await db.transaction((tx) => releaseDeedRaidLoot(tx, f.raid.id, now));
    const [state] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, f.mineA.id));
    expect(state!.accruedShards).toBe(cap);
  });
});
