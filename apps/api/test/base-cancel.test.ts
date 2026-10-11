/**
 * Deed-native upgrade and research cancellation.
 *
 * WHY: a deed's SHARDS belong to the deed. A cancelled upgrade or research
 * must compensate the BASE account the debit came from — never the seller's
 * or the buyer's wallet — and the fixed UTC-day refund budgets must travel
 * with the deed so selling a cancellation-heavy base cannot reset them, while
 * the wallet budget is shared across every deed one wallet holds.
 */
import { randomUUID } from 'node:crypto';
import {
  BuildingType, RESEARCH_CANCELLATION, TROOP_LEVELING, UPGRADE_CANCELLATION, UPGRADE_COSTS,
} from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, baseTroopResearch, builderJobs, buildings, players } from '../src/db/schema';
import { cancelResearch, getArmyState, researchTroop } from '../src/game/army';
import { cancelUpgrade, getBaseState, upgradeBuilding } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { transferStableBase } from '../src/game/baseOwnership';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const previousMultiBase = process.env['MULTI_BASE_ENABLED'];
let sequence = 0;
const key = () => `base-cancel-${++sequence}-${randomUUID()}`;
// Untyped on purpose: base.ts and army.ts each declare their own
// StableBaseMutationContext (DbOrTx vs DbTx authority callback) and this
// no-op authority satisfies both structurally.
const context = (baseId: string) => ({
  baseId,
  assertAuthority: async (): Promise<void> => {},
});
const VAULT_COST = BigInt(UPGRADE_COSTS.vault[2]!); // the L3→L4 step
const RESEARCH_COST = BigInt(TROOP_LEVELING.researchCostKeep[0]!);
// Real clock, not a fixed past date: transferStableBase settles the deed's
// due jobs at the REAL now, and a past-dated job would land during the sale
// instead of surviving it as the running upgrade these cases cancel.
const AT = new Date();
const DAY = AT.toISOString().slice(0, 10);

async function addPlayableBase(wallet: string, slot: number) {
  const deedAssetId = `base-cancel-deed-${randomUUID()}`;
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet, deedAssetId, deedMintAssetId: deedAssetId, status: 'active',
    keepLevel: 8, builders: 2, landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  const rows = await db.insert(buildings).values([
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Keep, level: 8, tx: 14, ty: 14 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Forge, level: 3, tx: 8, ty: 18 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Vault, level: 3, tx: 8, ty: 8 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Vault, level: 3, tx: 10, ty: 8 },
  ]).returning();
  await rewardBaseShards(db, base!.id, 100_000n, 'test.base-cancel', key());
  return { ...base!, vaults: rows.filter((r) => r.type === BuildingType.Vault) };
}

const walletShards = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;
const startUpgrade = (wallet: string, baseId: string, buildingId: string) =>
  upgradeBuilding(db, wallet, buildingId, key(), AT, {}, baseId, context(baseId));

beforeAll(async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
});

afterAll(async () => {
  if (previousMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = previousMultiBase;
  await conn.sql.end();
});

describe.sequential('deed-native upgrade and research cancellation', () => {
  it('refunds a cancelled upgrade to the deed after transfer, never either wallet', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addPlayableBase(seller.wallet, 1);
    const before = await getBaseShardBalance(db, base.id);
    const { job } = await startUpgrade(seller.wallet, base.id, base.vaults[0]!.id);
    expect(await getBaseShardBalance(db, base.id)).toBe(before - VAULT_COST);
    expect((await getBaseState(db, seller.wallet, AT, base.id)).jobs).toEqual([expect.objectContaining({
      id: job!.id, canCancel: true, refundShards: String(VAULT_COST),
    })]);
    await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);

    await expect(cancelUpgrade(db, seller.wallet, job!.id, key(), AT, base.id, context(base.id)))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const result = await cancelUpgrade(db, buyer.wallet, job!.id, key(), AT, base.id, context(base.id));
    expect(result).toMatchObject({ id: job!.id, refundShards: String(VAULT_COST), replayed: false });
    expect(await getBaseShardBalance(db, base.id)).toBe(before);
    expect(await walletShards(seller.wallet)).toBe(0n);
    expect(await walletShards(buyer.wallet)).toBe(0n);
    const conveyed = await getBaseState(db, buyer.wallet, AT, base.id);
    expect(conveyed.jobs).toEqual([]);
    expect(conveyed.freeBuilders).toBe(2);
    expect(conveyed.buildings.find((b) => b.id === base.vaults[0]!.id)?.level).toBe(3);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0])
      .toMatchObject({ completedAt: AT, cancelledAt: AT });
  });

  it('refunds a cancelled research to the deed after transfer, never either wallet', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addPlayableBase(seller.wallet, 1);
    const before = await getBaseShardBalance(db, base.id);
    await researchTroop(db, seller.wallet, 'giant', key(), AT, context(base.id));
    expect(await getBaseShardBalance(db, base.id)).toBe(before - RESEARCH_COST);
    expect((await getArmyState(db, seller.wallet, AT, base.id)).research).toEqual([expect.objectContaining({
      troop: 'giant', toLevel: 2, canCancel: true, refundShards: String(RESEARCH_COST),
    })]);
    await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);

    await expect(cancelResearch(db, seller.wallet, 'giant', key(), AT, context(base.id)))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const result = await cancelResearch(db, buyer.wallet, 'giant', key(), AT, context(base.id));
    expect(result).toMatchObject({ troop: 'giant', toLevel: 2, refundShards: String(RESEARCH_COST), replayed: false });
    expect(await getBaseShardBalance(db, base.id)).toBe(before);
    expect(await walletShards(seller.wallet)).toBe(0n);
    expect(await walletShards(buyer.wallet)).toBe(0n);
    const conveyed = await getArmyState(db, buyer.wallet, AT, base.id);
    expect(conveyed.research).toEqual([]);
    expect(conveyed.levels.giant).toBe(1);
    expect((await db.select().from(baseTroopResearch).where(eq(baseTroopResearch.baseId, base.id)))[0])
      .toMatchObject({ troop: 'giant', level: 1, researchingToLevel: null, cancelledAt: AT });
  });

  it('keeps both base refund budgets through deed transfer', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addPlayableBase(seller.wallet, 1);
    const first = (await startUpgrade(seller.wallet, base.id, base.vaults[0]!.id)).job!;
    const second = (await startUpgrade(seller.wallet, base.id, base.vaults[1]!.id)).job!;
    await researchTroop(db, seller.wallet, 'giant', key(), AT, context(base.id));
    const afterDebits = await getBaseShardBalance(db, base.id);
    await db.update(bases).set({
      upgradeCancelDay: DAY, upgradeCancelCount: UPGRADE_CANCELLATION.maxRefundsPerBaseUtcDay - 1,
      researchCancelDay: DAY, researchCancelCount: RESEARCH_CANCELLATION.maxRefundsPerBaseUtcDay - 1,
    }).where(eq(bases.id, base.id));
    await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);

    await cancelUpgrade(db, buyer.wallet, first.id, key(), AT, base.id, context(base.id));
    await expect(cancelUpgrade(db, buyer.wallet, second.id, key(), AT, base.id, context(base.id)))
      .rejects.toMatchObject({ statusCode: 429, code: 'UPGRADE_CANCEL_RATE_LIMITED' });
    await cancelResearch(db, buyer.wallet, 'giant', key(), AT, context(base.id));
    await researchTroop(db, buyer.wallet, 'bowman', key(), AT, context(base.id));
    await expect(cancelResearch(db, buyer.wallet, 'bowman', key(), AT, context(base.id)))
      .rejects.toMatchObject({ statusCode: 429, code: 'RESEARCH_CANCEL_RATE_LIMITED' });
    // Exactly one upgrade refund and one research refund landed; the second
    // research's debit stays spent.
    expect(await getBaseShardBalance(db, base.id)).toBe(afterDebits + VAULT_COST);
    expect((await db.select().from(bases).where(eq(bases.id, base.id)))[0]).toMatchObject({
      upgradeCancelDay: DAY, upgradeCancelCount: UPGRADE_CANCELLATION.maxRefundsPerBaseUtcDay,
      researchCancelDay: DAY, researchCancelCount: RESEARCH_CANCELLATION.maxRefundsPerBaseUtcDay,
    });
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, second.id)))[0]!.completedAt).toBeNull();
  });

  it('shares the wallet refund budgets across sibling deeds', async () => {
    const owner = await createTestPlayer(db);
    const firstBase = await addPlayableBase(owner.wallet, 1);
    const secondBase = await addPlayableBase(owner.wallet, 2);
    const first = (await startUpgrade(owner.wallet, firstBase.id, firstBase.vaults[0]!.id)).job!;
    const second = (await startUpgrade(owner.wallet, secondBase.id, secondBase.vaults[0]!.id)).job!;
    await researchTroop(db, owner.wallet, 'giant', key(), AT, context(firstBase.id));
    await researchTroop(db, owner.wallet, 'giant', key(), AT, context(secondBase.id));
    await db.update(players).set({
      upgradeCancelDay: DAY, upgradeCancelCount: UPGRADE_CANCELLATION.maxRefundsPerWalletUtcDay - 1,
      researchCancelDay: DAY, researchCancelCount: RESEARCH_CANCELLATION.maxRefundsPerWalletUtcDay - 1,
    }).where(eq(players.wallet, owner.wallet));

    await cancelUpgrade(db, owner.wallet, first.id, key(), AT, firstBase.id, context(firstBase.id));
    await cancelResearch(db, owner.wallet, 'giant', key(), AT, context(firstBase.id));
    const secondBalance = await getBaseShardBalance(db, secondBase.id);
    await expect(cancelUpgrade(db, owner.wallet, second.id, key(), AT, secondBase.id, context(secondBase.id)))
      .rejects.toMatchObject({ statusCode: 429, code: 'UPGRADE_CANCEL_RATE_LIMITED' });
    await expect(cancelResearch(db, owner.wallet, 'giant', key(), AT, context(secondBase.id)))
      .rejects.toMatchObject({ statusCode: 429, code: 'RESEARCH_CANCEL_RATE_LIMITED' });
    expect(await getBaseShardBalance(db, secondBase.id)).toBe(secondBalance);
    expect((await db.select().from(players).where(eq(players.wallet, owner.wallet)))[0]).toMatchObject({
      upgradeCancelCount: UPGRADE_CANCELLATION.maxRefundsPerWalletUtcDay,
      researchCancelCount: RESEARCH_CANCELLATION.maxRefundsPerWalletUtcDay,
    });
    expect((await db.select().from(bases).where(eq(bases.id, secondBase.id)))[0]).toMatchObject({
      upgradeCancelDay: null, upgradeCancelCount: 0, researchCancelDay: null, researchCancelCount: 0,
    });
  });
});
