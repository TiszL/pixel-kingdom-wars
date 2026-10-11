import { trainTroop } from './training-consent';
/**
 * Stable facilities and deed-native progression travel with the deed.
 *
 * These regressions deliberately leave buildings.player_wallet on the seller,
 * because that compatibility column is the exploit shape. Every new action must
 * lock and scope the selected base_id. Army, queue, research and SHARDS are
 * base-owned; the remaining hero assertions cover that module's own cutover.
 */
import { randomUUID } from 'node:crypto';
import { BuildingType } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  army, baseArmy, bases, baseSlots, baseTrainingQueue, buildings, players,
} from '../src/db/schema';
import {
  getArmyState, researchTroop,
} from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import {
  ensureWalletBaseIdentity, transferStableBase,
} from '../src/game/baseOwnership';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { listHeroes, upgradeHero } from '../src/game/heroes';
import {
  createCampaignRaid, submitOrders,
} from '../src/game/raids';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const previousMultiBase = process.env['MULTI_BASE_ENABLED'];
let seq = 0;
const key = () => `stable-progression-${++seq}-${randomUUID()}`;
const authority = async () => {};
const context = (baseId: string): StableBaseMutationContext => ({
  baseId,
  assertAuthority: authority,
});

async function stablePlayer(keepLevel = 1) {
  process.env['MULTI_BASE_ENABLED'] = 'false';
  const player = await createTestPlayer(db);
  await ensureStartingBase(db, player.wallet);
  const baseId = await ensureWalletBaseIdentity(db, player.wallet);
  await db.update(players).set({ keepLevel }).where(eq(players.wallet, player.wallet));
  await db.update(bases).set({ keepLevel }).where(eq(bases.id, baseId!));
  process.env['MULTI_BASE_ENABLED'] = 'true';
  return { ...player, baseId: baseId! };
}

async function addFacilityBase(wallet: string, slot: number, keepLevel = 8) {
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    status: 'active',
    keepLevel,
    landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  await db.insert(buildings).values([
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Keep, level: keepLevel, tx: 14, ty: 14 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Barracks, level: 3, tx: 9, ty: 9 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Camp, level: 3, tx: 18, ty: 9 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Forge, level: 3, tx: 9, ty: 18 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.HeroAltar, level: 1, tx: 18, ty: 18 },
  ]);
  return base!;
}

async function fund(wallet: string, ...baseIds: string[]) {
  await fundTestKeep(db, wallet, 1_000_000n, 'test.stable-progression', key());
  await rewardShards(db, wallet, 1_000_000n, 'test.stable-progression', key());
  for (const baseId of baseIds) {
    await rewardBaseShards(db, baseId, 1_000_000n, 'test.stable-progression', key());
  }
}

beforeAll(async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
});
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (previousMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = previousMultiBase;
  await conn.sql.end();
});

describe.sequential('stable-base progression authority', () => {
  it('isolates Barracks, Camp, Forge, altar and Keep prerequisites between two bases of one wallet', async () => {
    const owner = await stablePlayer(1);
    const facilities = await addFacilityBase(owner.wallet, 2, 8);
    await fund(owner.wallet, facilities.id);

    const [lowArmy, highArmy, lowHeroes, highHeroes] = await Promise.all([
      getArmyState(db, owner.wallet, new Date(), owner.baseId),
      getArmyState(db, owner.wallet, new Date(), facilities.id),
      listHeroes(db, owner.wallet, new Date(), owner.baseId),
      listHeroes(db, owner.wallet, new Date(), facilities.id),
    ]);
    expect(lowArmy).toMatchObject({ campCapacityPts: 0, barracksQueuePts: 0 });
    expect(highArmy.campCapacityPts).toBeGreaterThan(0);
    expect(highArmy.barracksQueuePts).toBeGreaterThan(0);
    expect(lowHeroes).toMatchObject({ keepLevel: 1 });
    expect(lowHeroes.heroes.find((hero) => hero.hero === 'vex')?.recruited).toBe(false);
    expect(highHeroes).toMatchObject({ keepLevel: 8 });
    expect(highHeroes.heroes.find((hero) => hero.hero === 'vex')?.recruited).toBe(true);

    await expect(trainTroop(
      db, owner.wallet, 'highlander', key(), new Date(), context(owner.baseId),
    )).rejects.toThrow(/Barracks/);
    await expect(researchTroop(
      db, owner.wallet, 'highlander', key(), new Date(), context(owner.baseId),
    )).rejects.toThrow(/Forge/);
    await expect(upgradeHero(
      db, owner.wallet, 'vex', key(), new Date(), context(owner.baseId),
    )).rejects.toThrow(/recruit/);

    await expect(trainTroop(
      db, owner.wallet, 'highlander', key(), new Date(), context(facilities.id),
    )).resolves.toMatchObject({ id: expect.any(String) });
    await expect(researchTroop(
      db, owner.wallet, 'highlander', key(), new Date(), context(facilities.id),
    )).resolves.toMatchObject({ troop: 'highlander', toLevel: 2 });
    await expect(upgradeHero(
      db, owner.wallet, 'vex', key(), new Date(), context(facilities.id),
    )).resolves.toMatchObject({ hero: 'vex', level: 2 });
  });

  it('removes every sold facility privilege from the seller and grants it to the buyer', async () => {
    const seller = await stablePlayer(1);
    const sold = await addFacilityBase(seller.wallet, 2, 8);
    const buyer = await stablePlayer(1);
    await fund(seller.wallet, sold.id);
    await fund(buyer.wallet);
    const deed = `progression-deed-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: deed }).where(eq(bases.id, sold.id));
    await transferStableBase(db, sold.id, seller.wallet, buyer.wallet, deed);

    // Recreate the dangerous compatibility shadow explicitly: stable authority
    // must remain correct even while a rolling-upgrade scalar is stale/high.
    await db.update(players).set({ keepLevel: 20 }).where(eq(players.wallet, seller.wallet));
    await db.insert(army).values({
      playerWallet: seller.wallet, troop: 'highlander', count: 1,
    }).onConflictDoUpdate({
      target: [army.playerWallet, army.troop], set: { count: 1 },
    });
    await db.insert(baseArmy).values({
      baseId: seller.baseId, troop: 'highlander', count: 1,
    }).onConflictDoUpdate({
      target: [baseArmy.baseId, baseArmy.troop], set: { count: 1 },
    });

    await expect(getArmyState(db, seller.wallet, new Date(), sold.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(listHeroes(db, seller.wallet, new Date(), sold.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });

    await expect(trainTroop(
      db, seller.wallet, 'highlander', key(), new Date(), context(sold.id),
    )).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(researchTroop(
      db, seller.wallet, 'highlander', key(), new Date(), context(seller.baseId),
    )).rejects.toThrow(/Forge/);
    await expect(upgradeHero(
      db, seller.wallet, 'vex', key(), new Date(), context(seller.baseId),
    )).rejects.toThrow(/recruit/);

    await expect(trainTroop(
      db, buyer.wallet, 'highlander', key(), new Date(), context(sold.id),
    )).resolves.toMatchObject({ id: expect.any(String) });
    await expect(researchTroop(
      db, buyer.wallet, 'highlander', key(), new Date(), context(sold.id),
    )).resolves.toMatchObject({ troop: 'highlander', toLevel: 2 });
    await expect(upgradeHero(
      db, buyer.wallet, 'vex', key(), new Date(), context(sold.id),
    )).resolves.toMatchObject({ hero: 'vex', level: 2 });

    const sellerRaid = await createCampaignRaid(
      db, seller.wallet, 1, key(), new Date(), {
        attackerBaseId: seller.baseId, authorizeAttackerBase: authority,
      },
    );
    const buyerRaid = await createCampaignRaid(
      db, buyer.wallet, 1, key(), new Date(), {
        attackerBaseId: sold.id, authorizeAttackerBase: authority,
      },
    );
    expect((sellerRaid.armySnapshot as { heroes?: string[] }).heroes).not.toContain('vex');
    expect((buyerRaid.armySnapshot as { heroes?: string[] }).heroes).toContain('vex');
    await expect(submitOrders(db, seller.wallet, sellerRaid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      heroDeploys: [{ hero: 'vex', tx: 6, ty: 15, tMs: 0 }],
      idempotencyKey: key(),
    })).rejects.toThrow(/have not recruited vex/);
    await expect(submitOrders(db, seller.wallet, sellerRaid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      rally: { tx: 6, ty: 14, tMs: 0 },
      idempotencyKey: key(),
    })).rejects.toThrow(/Rally unlocks at Keep level 3/);
  });

  it('rechecks ownership under the mutation lock after an earlier route precheck', async () => {
    const seller = await stablePlayer(1);
    const sold = await addFacilityBase(seller.wallet, 2, 8);
    const buyer = await stablePlayer(1);
    await fund(seller.wallet, sold.id);
    const deed = `progression-race-${randomUUID()}`;
    await db.update(bases).set({ deedAssetId: deed }).where(eq(bases.id, sold.id));

    // Model the route's successful finalized precheck, then convey the deed
    // before the service transaction begins. The in-transaction slot/base lock,
    // not that stale precheck, must decide whether a debit/queue may commit.
    await authority();
    await transferStableBase(db, sold.id, seller.wallet, buyer.wallet, deed);
    const before = await getBaseShardBalance(db, sold.id);
    await expect(trainTroop(
      db, seller.wallet, 'highlander', key(), new Date(), context(sold.id),
    )).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    expect(await getBaseShardBalance(db, sold.id)).toBe(before);
    expect(await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, sold.id)))
      .toHaveLength(0);
  });
});
