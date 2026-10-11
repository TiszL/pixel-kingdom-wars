/**
 * D-035 deed-native Forge contract. These tests deliberately use two owners
 * and two bases: wallet-keyed assertions can pass while silently pooling the
 * exact state a deed sale and a raid must preserve.
 */
import { randomUUID } from 'node:crypto';
import { FORGE, FORGE_DROPS } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { DbTx } from '../src/db/client';
import {
  accounts, baseForgePositions, baseItems, baseRaidLocks, bases, baseSlots,
  buildings, raidLootReservations, raids,
} from '../src/db/schema';
import { rewardBaseShards } from '../src/game/baseEconomy';
import {
  assertBaseForgeEscrowReconciles, claimForgeDays, computeBaseForgeDrops,
  contributeToForge, convertKeepToShards, expireDueForgeAllocations, forgeDayOf, getForgeAllocations, getForgeGlobalDay,
  getForgeStatus,
  settleForgeDay, type ForgeStableBaseContext,
} from '../src/game/forge';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../src/ledger/accounts';
import { postTransaction } from '../src/ledger/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const key = (label: string): string => `forge-base:${label}:${randomUUID()}`;

afterAll(async () => { await conn.sql.end(); });

async function baseFixture(level = 20, wallet?: string) {
  const owner = wallet ? { wallet } : await createTestPlayer(db);
  const [base] = await db.insert(bases).values({
    ownerWallet: owner.wallet, status: 'active', landPaidAt: new Date(), keepLevel: 5,
  }).returning();
  const existing = await db.select({ slot: baseSlots.slot }).from(baseSlots)
    .where(eq(baseSlots.wallet, owner.wallet));
  await db.insert(baseSlots).values({ wallet: owner.wallet, slot: existing.length + 1, baseId: base!.id });
  await db.insert(buildings).values({
    playerWallet: owner.wallet, baseId: base!.id, type: 'goldforge', level, tx: 20, ty: 20,
  });
  return { wallet: owner.wallet, baseId: base!.id };
}

function authority(baseId: string): ForgeStableBaseContext {
  return {
    baseId,
    assertActiveAuthority: async (tx: DbTx, wallet: string) => {
      const [base] = await tx.select().from(bases).where(and(
        eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      )).for('update');
      if (!base) throw new Error('deed ownership changed');
      return [{ id: base.id, landPaidAt: base.landPaidAt }];
    },
  };
}

function mutationAuthority(baseId: string): StableBaseMutationContext {
  return {
    baseId,
    assertAuthority: async (tx, wallet, lockedBaseId) => {
      const [base] = await tx.select({ id: bases.id }).from(bases).where(and(
        eq(bases.id, lockedBaseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      )).for('update');
      if (!base || base.id !== baseId) throw new Error('deed ownership changed');
    },
  };
}

function past(index: number): { day: string; at: Date } {
  const at = new Date(Date.UTC(2024, 0, 2 + index, 12));
  return { day: forgeDayOf(at), at };
}

describe.sequential('deed-native Gold Forge', () => {
  it('advertises only truthful independent deed rolls, without retired eligibility limits', async () => {
    const selected = await baseFixture(1);
    const status = await getForgeStatus(
      db, selected.wallet, new Date(), selected.baseId, authority(selected.baseId),
    );
    expect(status.drops.independentDropBps).toBeDefined();
    expect(status.drops).not.toHaveProperty('minCountedShards');
    expect(status.drops).not.toHaveProperty('table');
  });

  it('converts wallet KEEP into only the selected unlocked deed balance', async () => {
    const owner = await createTestPlayer(db);
    const first = await baseFixture(1, owner.wallet);
    const second = await baseFixture(1, owner.wallet);
    await fundTestKeep(db, owner.wallet, 10n, 'test.forge.convert', key('convert-fund'));
    const idem = key('convert');

    await convertKeepToShards(
      db, owner.wallet, 3n, idem, first.baseId, mutationAuthority(first.baseId),
    );
    await convertKeepToShards(
      db, owner.wallet, 3n, idem, first.baseId, mutationAuthority(first.baseId),
    );
    await expect(convertKeepToShards(
      db, owner.wallet, 3n, idem, second.baseId, mutationAuthority(second.baseId),
    )).rejects.toThrow(/different conversion amount|idempotency/i);
    expect((await getOrCreateBaseAccount(db, first.baseId, 'base_shards')).balance).toBe(3n);
    expect((await getOrCreateBaseAccount(db, second.baseId, 'base_shards')).balance).toBe(0n);
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards')).balance).toBe(0n);

    const attacker = await baseFixture();
    const [raid] = await db.insert(raids).values({
      idempotencyKey: key('convert-lock-raid'),
      attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId,
      defenderWallet: owner.wallet,
      defenderBaseId: first.baseId,
      seed: 8n,
      snapshot: { keepLevel: 5, buildings: [], surplusShards: 0 },
      armySnapshot: { counts: {}, levels: {}, heroes: [] },
      ordersDeadlineAt: new Date(Date.now() + 60_000),
      simVersion: 9,
    }).returning();
    await db.insert(baseRaidLocks).values({
      baseId: first.baseId, raidId: raid!.id, expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(convertKeepToShards(
      db, owner.wallet, 1n, key('convert-locked'), first.baseId, mutationAuthority(first.baseId),
    )).rejects.toMatchObject({ statusCode: 423, code: 'BASE_BEING_RAIDED' });
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance).toBe(7n);
  });

  it('gives every deed its own level cap and permits unlimited calls within it', async () => {
    const owner = await createTestPlayer(db);
    const first = await baseFixture(1, owner.wallet);
    const second = await baseFixture(1, owner.wallet);
    const cap = BigInt(FORGE.contributionCapByLevel[1]!);
    await rewardBaseShards(db, first.baseId, cap, 'test.forge.base.seed', key('seed-1'));
    await rewardBaseShards(db, second.baseId, cap, 'test.forge.base.seed', key('seed-2'));

    for (let i = 0; i < 20; i++) {
      await contributeToForge(db, owner.wallet, cap / 20n, key(`split-${i}`), new Date(), first.baseId, authority(first.baseId));
    }
    await contributeToForge(db, owner.wallet, cap, key('second-full'), new Date(), second.baseId, authority(second.baseId));
    await expect(contributeToForge(
      db, owner.wallet, 1n, key('over'), new Date(), first.baseId, authority(first.baseId),
    )).rejects.toThrow(/daily cap/);

    const rows = await db.select().from(baseForgePositions).where(eq(baseForgePositions.day, forgeDayOf(new Date())));
    expect(rows.find((row) => row.baseId === first.baseId)?.contributedShards).toBe(cap);
    expect(rows.find((row) => row.baseId === second.baseId)?.contributedShards).toBe(cap);
  });

  it('binds a deed contribution idempotency key to amount, day, wallet and base', async () => {
    const owner = await baseFixture();
    await rewardBaseShards(db, owner.baseId, 1_000n, 'test.forge.base.seed', key('idem-seed'));
    const idem = key('idem');
    await contributeToForge(db, owner.wallet, 400n, idem, new Date(), owner.baseId, authority(owner.baseId));
    const retry = await contributeToForge(db, owner.wallet, 400n, idem, new Date(), owner.baseId, authority(owner.baseId));
    expect(retry.myShards).toBe('400');
    await expect(contributeToForge(
      db, owner.wallet, 401n, idem, new Date(), owner.baseId, authority(owner.baseId),
    )).rejects.toThrow(/different Forge contribution details/);
    expect((await getOrCreateBaseAccount(db, owner.baseId, 'base_shards')).balance).toBe(600n);
  });

  it('burns the full remaining deed stake, rolls each item independently, and lets the deed buyer claim', async () => {
    const seller = await baseFixture();
    const buyer = await createTestPlayer(db);
    const { day, at } = past(1);
    await rewardBaseShards(db, seller.baseId, 10_000n, 'test.forge.base.seed', key('settle-seed'));
    await contributeToForge(db, seller.wallet, 10_000n, key('settle'), at, seller.baseId, authority(seller.baseId));
    await settleForgeDay(db, day);

    const [settled] = await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, seller.baseId),
    ));
    const payout = (BigInt(FORGE.dailyEmissionKeep) * 10_000n) / BigInt(FORGE.softCapShards);
    expect(settled).toMatchObject({
      countedShards: 10_000n, shardsRefunded: 0n, keepPaid: payout,
      itemsDropped: computeBaseForgeDrops(day, seller.baseId),
    });
    expect(settled!.shardSettlementTxnId).not.toBeNull();
    expect(settled!.keepEscrowTxnId).not.toBeNull();
    expect((await getOrCreateBaseAccount(db, seller.baseId, 'base_forge_escrow')).balance).toBe(0n);
    const heldItems = await db.select({ itemId: baseItems.itemId }).from(baseItems)
      .where(eq(baseItems.baseId, seller.baseId));
    expect(heldItems.map((row) => row.itemId).sort()).toEqual(computeBaseForgeDrops(day, seller.baseId).sort());

    await db.transaction(async (tx) => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, seller.baseId));
      await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, seller.baseId));
      await tx.update(buildings).set({ playerWallet: buyer.wallet }).where(eq(buildings.baseId, seller.baseId));
      await tx.insert(baseSlots).values({ wallet: buyer.wallet, slot: 1, baseId: seller.baseId });
    });
    const claimed = await claimForgeDays(
      db, buyer.wallet, day, new Date(), seller.baseId, authority(seller.baseId),
    );
    expect(claimed.totalKeep).toBe(payout.toString());
    expect((await getOrCreatePlayerAccount(db, buyer.wallet, 'player_keep')).balance).toBe(payout);
    expect((await getOrCreatePlayerAccount(db, seller.wallet, 'player_keep')).balance).toBe(0n);
    const global = await getForgeGlobalDay(db, buyer.wallet, { day });
    expect(global).toMatchObject({ contributors: 1, totalShards: '10000', distributedKeep: payout.toString() });
    expect(global.me).toMatchObject({ rank: 1, keepPaid: payout.toString() });
    expect(JSON.stringify(global)).not.toContain(buyer.wallet);
    const history = await getForgeAllocations(
      db, buyer.wallet, {}, new Date(), seller.baseId, authority(seller.baseId),
    );
    expect(history.days[0]).toMatchObject({ day, status: 'claimed', counted: '10000' });
  });

  it('never exceeds the owner daily per-item cap, even across settle re-runs', async () => {
    // Owner 2026-08-16 (verbatim): "we should drop 1-2 per item daily not
    // more." Two halves of the guarantee:
    // 1. STRUCTURAL — one roll per item id per deed/day means the roll itself
    //    can never yield more than 1 ≤ dailyPerItemCap of any item.
    for (let i = 0; i < 200; i++) {
      const rolls = computeBaseForgeDrops(`2024-03-${String(1 + (i % 28)).padStart(2, '0')}`, `cap-probe-${i}`);
      const perItem = new Map<string, number>();
      for (const itemId of rolls) perItem.set(itemId, (perItem.get(itemId) ?? 0) + 1);
      for (const [itemId, count] of perItem) {
        expect(count, itemId).toBeLessThanOrEqual(FORGE_DROPS.dailyPerItemCap);
      }
    }
    // 2. IDEMPOTENT — a repeated settle of the same day grants nothing extra
    //    (the settledAt claim gate), so retries cannot stack drops past the cap.
    const owner = await baseFixture();
    const { day, at } = past(10); // a day no other test touches — settlement is global per day
    await rewardBaseShards(db, owner.baseId, 10_000n, 'test.forge.base.seed', key('cap-seed'));
    await contributeToForge(db, owner.wallet, 10_000n, key('cap'), at, owner.baseId, authority(owner.baseId));
    await settleForgeDay(db, day);
    await settleForgeDay(db, day); // re-run: must be a no-op for grants
    const held = await db.select({ itemId: baseItems.itemId, qty: baseItems.qty })
      .from(baseItems).where(eq(baseItems.baseId, owner.baseId));
    const rolled = computeBaseForgeDrops(day, owner.baseId);
    expect(held.map((row) => row.itemId).sort()).toEqual([...rolled].sort());
    for (const row of held) {
      expect(row.qty, row.itemId).toBeLessThanOrEqual(FORGE_DROPS.dailyPerItemCap);
    }
  });

  it('accepts only the exact raid-reserved Forge gap and defers settlement until release', async () => {
    const defender = await baseFixture();
    const attacker = await baseFixture();
    const { day, at } = past(2);
    await rewardBaseShards(db, defender.baseId, 2_000n, 'test.forge.base.seed', key('raid-seed'));
    await contributeToForge(db, defender.wallet, 2_000n, key('raid'), at, defender.baseId, authority(defender.baseId));
    const [raid] = await db.insert(raids).values({
      idempotencyKey: key('raid-row'), attackerWallet: attacker.wallet, attackerBaseId: attacker.baseId,
      defenderWallet: defender.wallet, defenderBaseId: defender.baseId, seed: 7n,
      snapshot: { keepLevel: 5, buildings: [], surplusShards: 0 },
      armySnapshot: { counts: {}, levels: {}, heroes: [] },
      ordersDeadlineAt: new Date(Date.now() + 60_000), simVersion: 9,
    }).returning();
    const escrow = await getOrCreateBaseAccount(db, defender.baseId, 'base_forge_escrow');
    const sys = await bootstrapSystemAccounts(db);
    await postTransaction(db, {
      idempotencyKey: key('reserve'), type: 'raid.loot.reserve',
      entries: [{ account: escrow.id, delta: -500n }, { account: sys.raid_loot_escrow, delta: 500n }],
    });
    await db.insert(raidLootReservations).values({
      raidId: raid!.id, formulaVersion: 1, attackerBaseId: attacker.baseId,
      defenderBaseId: defender.baseId, forgeReservedShards: 500n,
      privateSnapshotHash: 'test-private-hash',
    });
    await db.insert(baseRaidLocks).values({
      baseId: defender.baseId, raidId: raid!.id, expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(assertBaseForgeEscrowReconciles(db, defender.baseId)).resolves.toMatchObject({
      openShards: 2_000n, reservedShards: 500n, escrowShards: 1_500n,
    });
    await settleForgeDay(db, day);
    expect((await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, defender.baseId),
    )))[0]!.settledAt).toBeNull();

    const raidEscrow = (await db.select().from(accounts).where(eq(accounts.id, sys.raid_loot_escrow)))[0]!;
    await postTransaction(db, {
      idempotencyKey: key('release'), type: 'raid.loot.release',
      entries: [{ account: raidEscrow.id, delta: -500n }, { account: escrow.id, delta: 500n }],
    });
    await db.update(raidLootReservations).set({ state: 'released', releasedAt: new Date() })
      .where(eq(raidLootReservations.raidId, raid!.id));
    await db.delete(baseRaidLocks).where(eq(baseRaidLocks.raidId, raid!.id));
    await expect(assertBaseForgeEscrowReconciles(db, defender.baseId)).resolves.toMatchObject({ reservedShards: 0n });
    await settleForgeDay(db, day);
    expect((await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, defender.baseId),
    )))[0]!.settledAt).not.toBeNull();
  });

  it('restores same-day cap headroom when terminal raid theft debits the position', async () => {
    const defender = await baseFixture(1);
    const attacker = await baseFixture(1);
    const cap = BigInt(FORGE.contributionCapByLevel[1]!);
    await rewardBaseShards(db, defender.baseId, cap + 500n, 'test.forge.base.seed', key('headroom-seed'));
    const day = forgeDayOf(new Date());
    await contributeToForge(db, defender.wallet, cap, key('headroom-full'), new Date(), defender.baseId, authority(defender.baseId));
    const escrow = await getOrCreateBaseAccount(db, defender.baseId, 'base_forge_escrow');
    const attackerShards = await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards');
    await postTransaction(db, {
      idempotencyKey: key('headroom-theft'), type: 'raid.loot',
      entries: [{ account: escrow.id, delta: -500n }, { account: attackerShards.id, delta: 500n }],
    });
    await db.update(baseForgePositions).set({ raidDebitedShards: 500n })
      .where(and(eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, defender.baseId)));
    await assertBaseForgeEscrowReconciles(db, defender.baseId);
    const refilled = await contributeToForge(
      db, defender.wallet, 500n, key('headroom-refill'), new Date(), defender.baseId, authority(defender.baseId),
    );
    expect(refilled.myShards).toBe(cap.toString());
  });

  it('a fully raided position settles to no KEEP and no item rolls', async () => {
    const defender = await baseFixture();
    const attacker = await baseFixture();
    const { day, at } = past(4);
    await rewardBaseShards(db, defender.baseId, 1_000n, 'test.forge.base.seed', key('drained-seed'));
    await contributeToForge(db, defender.wallet, 1_000n, key('drained'), at, defender.baseId, authority(defender.baseId));
    const escrow = await getOrCreateBaseAccount(db, defender.baseId, 'base_forge_escrow');
    const attackerShards = await getOrCreateBaseAccount(db, attacker.baseId, 'base_shards');
    await postTransaction(db, {
      idempotencyKey: key('drained-theft'), type: 'raid.loot',
      entries: [{ account: escrow.id, delta: -1_000n }, { account: attackerShards.id, delta: 1_000n }],
    });
    await db.update(baseForgePositions).set({ raidDebitedShards: 1_000n })
      .where(and(eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, defender.baseId)));
    await settleForgeDay(db, day);
    const [row] = await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, defender.baseId),
    ));
    expect(row).toMatchObject({ countedShards: 0n, keepPaid: 0n, itemsDropped: [] });
    expect(row!.keepEscrowTxnId).toBeNull();
    expect(await db.select().from(baseItems).where(eq(baseItems.baseId, defender.baseId))).toHaveLength(0);
  });

  it('expires an unclaimed deed payout back to the lifetime emission pool', async () => {
    const owner = await baseFixture();
    const { day, at } = past(3);
    await rewardBaseShards(db, owner.baseId, 1_000n, 'test.forge.base.seed', key('expiry-seed'));
    await contributeToForge(db, owner.wallet, 1_000n, key('expiry'), at, owner.baseId, authority(owner.baseId));
    await settleForgeDay(db, day, new Date('2024-02-01T00:00:00.000Z'));
    const lapsed = new Date('2024-04-01T00:00:00.000Z');
    expect(await expireDueForgeAllocations(db, lapsed)).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(baseForgePositions).where(and(
      eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, owner.baseId),
    ));
    expect(row!.expiredAt).not.toBeNull();
    const claim = await claimForgeDays(db, owner.wallet, day, lapsed, owner.baseId, authority(owner.baseId));
    expect(claim.claimed).toEqual([]);
  });
});
