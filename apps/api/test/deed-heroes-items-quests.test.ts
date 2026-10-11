/**
 * D-035 regressions: playable hero/inventory/quest/campaign state is isolated
 * by deed, follows base_id through transfer, and player mutations stop under a
 * live base raid lock.
 */
import { randomUUID } from 'node:crypto';
import { CAMPAIGN, HEROES, speedupCostKeep } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  baseCampaignProgress,
  baseHeroProgress,
  baseItems,
  baseQuestProgress,
  baseRaidLocks,
  bases,
  baseSlots,
  buildings,
  players,
  quests,
  raids,
} from '../src/db/schema';
import {
  baseHeroRaidState,
  listHeroes,
  recoveringBaseHeroes,
  speedupHeroRecovery,
  upgradeHero,
} from '../src/game/heroes';
import {
  baseItemQuantities,
  equipHeroItem,
  getItems,
  resolveBaseHeroLoadouts,
  useItem,
} from '../src/game/items';
import { getBaseState } from '../src/game/base';
import {
  getQuestBoard,
  claimQuest,
  ensureQuests,
  progressBaseQuest,
} from '../src/game/quests';
import {
  assertBaseCampaignStageUnlocked,
  getBaseCampaignBoard,
  recordBaseCampaignOutcome,
} from '../src/game/campaign';
import { transferStableBase } from '../src/game/baseOwnership';
import { getBaseShardBalance } from '../src/game/baseEconomy';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { bootstrapSystemAccounts, InsufficientFundsError } from '../src/ledger';
import { getOrCreatePlayerAccount } from '../src/ledger/accounts';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const previousMultiBase = process.env['MULTI_BASE_ENABLED'];
let sequence = 0;
const key = () => `deed-progression-${++sequence}-${randomUUID()}`;
const context = (baseId: string): StableBaseMutationContext => ({
  baseId,
  assertAuthority: async () => {},
});
const itemContext = (baseId: string) => ({
  baseId,
  authorizeBaseMutation: async () => {},
});

async function addBase(wallet: string, slot: number) {
  const deedAssetId = `deed-${randomUUID()}`;
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    deedAssetId,
    keepLevel: 8,
    landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  await db.insert(buildings).values({
    playerWallet: wallet,
    baseId: base!.id,
    type: HEROES.vex.altar,
    level: 1,
    tx: 12,
    ty: 12,
  });
  return { ...base!, deedAssetId };
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

describe.sequential('deed-native heroes and inventory', () => {
  it('returns the authoritative deed hero level and defaults a missing progress row to level 1', async () => {
    // WHY: portrait tier selection must follow base_hero_progress on deeded
    // bases, while a newly recruited altar has an authoritative level-1
    // fallback before its first progress row exists.
    const owner = await createTestPlayer(db);
    const base = await addBase(owner.wallet, 1);
    const now = new Date('2026-08-12T10:00:00.000Z');

    expect((await getBaseState(db, owner.wallet, now, base.id)).heroes)
      .toContainEqual({ hero: 'vex', level: 1, recoveryUntil: null, available: true });

    await db.insert(baseHeroProgress).values({ baseId: base.id, hero: 'vex', level: 16 });
    expect((await getBaseState(db, owner.wallet, now, base.id)).heroes)
      .toContainEqual({ hero: 'vex', level: 16, recoveryUntil: null, available: true });
  });

  it('prices and atomically finishes deed-scoped recovery exactly once', async () => {
    const owner = await createTestPlayer(db);
    const base = await addBase(owner.wallet, 1);
    const now = new Date('2026-08-12T10:00:00.000Z');
    const recoveryUntil = new Date(now.getTime() + 125_000);
    const cost = BigInt(speedupCostKeep(125));
    await db.insert(baseHeroProgress).values({
      baseId: base.id, hero: 'vex', level: 3, recoveryUntil,
    });
    await fundTestKeep(db, owner.wallet, cost * 2n, 'test.hero-recovery-speedup', key());
    const account = await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep');

    const before = (await listHeroes(db, owner.wallet, now, base.id)).heroes
      .find((hero) => hero.hero === 'vex')!;
    expect(before.recoveryFinishNow).toEqual({
      remainingSec: 125, costKeep: cost.toString(), affordable: true,
    });
    const balanceBefore = account.balance;
    const intent = key();
    const first = await speedupHeroRecovery(db, owner.wallet, 'vex', intent, now, context(base.id));
    const replay = await speedupHeroRecovery(db, owner.wallet, 'vex', intent, now, context(base.id));

    expect(first).toMatchObject({ spentKeep: cost.toString(), duplicate: false, recoveryUntil: null });
    expect(replay).toMatchObject({ spentKeep: '0', duplicate: true, recoveryUntil: null });
    const refreshed = await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep');
    expect(refreshed.balance).toBe(balanceBefore - cost);
    expect((await listHeroes(db, owner.wallet, now, base.id)).heroes
      .find((hero) => hero.hero === 'vex')?.recoveryFinishNow).toBeNull();
    await expect(speedupHeroRecovery(
      db, owner.wallet, 'vex', key(), now, context(base.id),
    )).rejects.toThrow(/not recovering/);

    const nextEpisode = new Date(now.getTime() + 300_000);
    await db.update(baseHeroProgress).set({ recoveryUntil: nextEpisode }).where(and(
      eq(baseHeroProgress.baseId, base.id), eq(baseHeroProgress.hero, 'vex'),
    ));
    await expect(speedupHeroRecovery(
      db, owner.wallet, 'vex', intent, now, context(base.id),
    )).rejects.toThrow(/idempotency key collision/);
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance)
      .toBe(balanceBefore - cost);
    expect((await listHeroes(db, owner.wallet, now, base.id)).heroes
      .find((hero) => hero.hero === 'vex')?.recoveryUntil).toBe(nextEpisode.toISOString());
  });

  it('serializes concurrent recovery purchases so one recovery can be charged only once', async () => {
    const owner = await createTestPlayer(db);
    const base = await addBase(owner.wallet, 1);
    const now = new Date('2026-08-12T10:00:00.000Z');
    const recoveryUntil = new Date(now.getTime() + 600_000);
    const cost = BigInt(speedupCostKeep(600));
    await db.insert(baseHeroProgress).values({ baseId: base.id, hero: 'vex', recoveryUntil });
    await fundTestKeep(db, owner.wallet, cost * 2n, 'test.hero-recovery-race', key());
    const balanceBefore = (await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance;

    const results = await Promise.allSettled([
      speedupHeroRecovery(db, owner.wallet, 'vex', key(), now, context(base.id)),
      speedupHeroRecovery(db, owner.wallet, 'vex', key(), now, context(base.id)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance)
      .toBe(balanceBefore - cost);
  });

  it('rejects an underfunded recovery finish cleanly and completes nothing', async () => {
    // WHY: the debit and the recovery release commit in ONE transaction — an
    // insufficient-KEEP rejection must therefore leave the hero still
    // recovering AND the priced offer honest (affordable:false). The ledger's
    // InsufficientFundsError is a LedgerError, which app.ts maps to a 422 for
    // the route, so a broke player gets a clean refusal, never a free finish.
    const owner = await createTestPlayer(db);
    const base = await addBase(owner.wallet, 1);
    const now = new Date('2026-08-12T10:00:00.000Z');
    const recoveryUntil = new Date(now.getTime() + 600_000);
    const cost = BigInt(speedupCostKeep(600));
    await db.insert(baseHeroProgress).values({ baseId: base.id, hero: 'vex', recoveryUntil });
    await fundTestKeep(db, owner.wallet, cost - 1n, 'test.hero-recovery-underfunded', key());

    const offer = (await listHeroes(db, owner.wallet, now, base.id)).heroes
      .find((hero) => hero.hero === 'vex')!.recoveryFinishNow;
    expect(offer).toEqual({ remainingSec: 600, costKeep: cost.toString(), affordable: false });

    await expect(speedupHeroRecovery(db, owner.wallet, 'vex', key(), now, context(base.id)))
      .rejects.toBeInstanceOf(InsufficientFundsError);

    const after = (await listHeroes(db, owner.wallet, now, base.id)).heroes
      .find((hero) => hero.hero === 'vex')!;
    expect(after.recoveryUntil).toBe(recoveryUntil.toISOString());
    expect(after.available).toBe(false);
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance)
      .toBe(cost - 1n);
  });

  it('re-prices after lock wait and never charges a hero who recovered naturally', async () => {
    const owner = await createTestPlayer(db);
    const base = await addBase(owner.wallet, 1);
    const [clock] = await db.select({ now: sql<Date>`clock_timestamp()` }).from(players)
      .where(eq(players.wallet, owner.wallet)).limit(1);
    const recoveryUntil = new Date(new Date(clock!.now).getTime() + 1_000);
    await db.insert(baseHeroProgress).values({ baseId: base.id, hero: 'vex', recoveryUntil });
    await fundTestKeep(db, owner.wallet, 1_000n, 'test.hero-recovery-lock-wait', key());
    const balanceBefore = (await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance;

    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, owner.wallet)).for('update');
      locked();
      await releaseLock;
    });
    await lockAcquired;

    let settled = false;
    const attempt = speedupHeroRecovery(
      db, owner.wallet, 'vex', key(), undefined, context(base.id),
    );
    void attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false); // it really is waiting behind the authority lock
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    release();
    await holder;

    await expect(attempt).rejects.toThrow(/not recovering/);
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_keep')).balance)
      .toBe(balanceBefore);
  });

  it('isolates two bases and conveys levels, recovery, gear and consumables to the buyer', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const first = await addBase(seller.wallet, 1);
    const second = await addBase(seller.wallet, 2);
    const recoveryUntil = new Date('2026-08-13T12:00:00.000Z');

    await db.insert(baseHeroProgress).values([
      { baseId: first.id, hero: 'vex', level: 7, recoveryUntil },
      { baseId: second.id, hero: 'vex', level: 2 },
    ]);
    await db.insert(baseItems).values([
      { baseId: first.id, itemId: 'wardens_helm', qty: 1 },
      { baseId: first.id, itemId: 'keg_of_haste', qty: 3 },
      { baseId: second.id, itemId: 'keg_of_haste', qty: 1 },
    ]);
    await equipHeroItem(
      db, seller.wallet, 'vex', 'helm', 'wardens_helm', 0,
      new Date('2026-08-12T01:00:00.000Z'), itemContext(first.id),
    );

    const home = await getBaseState(
      db, seller.wallet, new Date('2026-08-12T02:00:00.000Z'), first.id,
    );
    expect(home.heroes.find((hero) => hero.hero === 'vex')).toEqual({
      hero: 'vex', level: 7, recoveryUntil: recoveryUntil.toISOString(), available: false,
    });

    expect((await listHeroes(db, seller.wallet, new Date('2026-08-12T02:00:00.000Z'), first.id))
      .heroes.find((hero) => hero.hero === 'vex')).toMatchObject({ level: 7, available: false });
    expect((await listHeroes(db, seller.wallet, new Date(), second.id))
      .heroes.find((hero) => hero.hero === 'vex')).toMatchObject({ level: 2, available: true });
    expect(await baseItemQuantities(db, first.id)).toEqual(expect.arrayContaining([
      { itemId: 'keg_of_haste', qty: 3 }, { itemId: 'wardens_helm', qty: 1 },
    ]));
    expect(await baseItemQuantities(db, second.id)).toContainEqual({ itemId: 'keg_of_haste', qty: 1 });

    await transferStableBase(db, first.id, seller.wallet, buyer.wallet, first.deedAssetId);
    await expect(listHeroes(db, seller.wallet, new Date(), first.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const boughtHeroes = await listHeroes(db, buyer.wallet, new Date('2026-08-12T02:00:00.000Z'), first.id);
    expect(boughtHeroes.heroes.find((hero) => hero.hero === 'vex'))
      .toMatchObject({ level: 7, recoveryUntil: recoveryUntil.toISOString(), available: false });
    const boughtItems = await getItems(
      db, buyer.wallet, first.id, new Date('2026-08-12T02:00:00.000Z'),
    );
    expect(boughtItems.owned).toEqual(expect.arrayContaining([
      { itemId: 'keg_of_haste', qty: 3 }, { itemId: 'wardens_helm', qty: 1 },
    ]));
    expect((await resolveBaseHeroLoadouts(db, first.id)).vex.equipment)
      .toMatchObject({ helm: 'wardens_helm' });
    expect(boughtItems.heroLoadouts.find((hero) => hero.hero === 'vex')).toMatchObject({
      recoveryUntil: recoveryUntil.toISOString(), available: false,
    });
    expect(await recoveringBaseHeroes(db, first.id, ['vex'], new Date('2026-08-12T02:00:00.000Z')))
      .toEqual(['vex']);
    expect((await baseHeroRaidState(db, first.id, new Date('2026-08-14T00:00:00.000Z'))).heroes)
      .toContain('vex');
  });

  it('blocks hero, equipment and consumable mutations while that deed is being raided', async () => {
    const owner = await createTestPlayer(db);
    const base = await addBase(owner.wallet, 1);
    await fundTestKeep(db, owner.wallet, 100_000n, 'test.deed-hero-lock', key());
    await db.insert(baseItems).values([
      { baseId: base.id, itemId: 'powder_charge', qty: 1 },
      { baseId: base.id, itemId: 'wardens_helm', qty: 1 },
    ]);
    const [raid] = await db.insert(raids).values({
      attackerWallet: owner.wallet,
      attackerBaseId: base.id,
      campaignStage: 1,
      seed: 1n,
      snapshot: {},
      armySnapshot: {},
      ordersDeadlineAt: new Date('2099-01-01T00:00:00.000Z'),
    }).returning({ id: raids.id });
    await db.insert(baseRaidLocks).values({
      baseId: base.id,
      raidId: raid!.id,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });

    await expect(upgradeHero(db, owner.wallet, 'vex', key(), new Date(), context(base.id)))
      .rejects.toMatchObject({ statusCode: 423, code: 'BASE_BEING_RAIDED' });
    await expect(equipHeroItem(db, owner.wallet, 'vex', 'helm', 'wardens_helm', 0, new Date(), itemContext(base.id)))
      .rejects.toMatchObject({ statusCode: 423, code: 'BASE_BEING_RAIDED' });
    await expect(useItem(db, owner.wallet, 'powder_charge', key(), itemContext(base.id)))
      .rejects.toMatchObject({ statusCode: 423, code: 'BASE_BEING_RAIDED' });
    expect(await baseItemQuantities(db, base.id, ['powder_charge']))
      .toEqual([{ itemId: 'powder_charge', qty: 1 }]);
  });
});

describe.sequential('deed-native quest and campaign progress', () => {
  it('keeps quest completion/claim isolated and claimed after transfer', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const first = await addBase(seller.wallet, 1);
    const second = await addBase(seller.wallet, 2);
    const at = new Date('2026-08-12T12:00:00.000Z');
    await ensureQuests(db, '2026-08-12');
    const [quest] = await db.select().from(quests)
      .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, '2026-08-12')))
      .limit(1);
    expect(quest).toBeDefined();

    await progressBaseQuest(db, first.id, quest!.templateCode, quest!.target, at);
    expect((await getQuestBoard(db, seller.wallet, at, first.id)).quests
      .find((row) => row.id === quest!.id)).toMatchObject({ completed: true, claimed: false });
    expect((await getQuestBoard(db, seller.wallet, at, second.id)).quests
      .find((row) => row.id === quest!.id)).toMatchObject({ progress: 0, completed: false });

    const before = await getBaseShardBalance(db, first.id);
    await claimQuest(db, seller.wallet, quest!.id, at, context(first.id));
    expect(await getBaseShardBalance(db, first.id)).toBe(before + quest!.rewardKeep);
    await transferStableBase(db, first.id, seller.wallet, buyer.wallet, first.deedAssetId);
    expect((await getQuestBoard(db, buyer.wallet, at, first.id)).quests
      .find((row) => row.id === quest!.id)).toMatchObject({ completed: true, claimed: true });
    await expect(claimQuest(db, buyer.wallet, quest!.id, at, context(first.id)))
      .rejects.toThrow(/already claimed/);
    const [stored] = await db.select().from(baseQuestProgress)
      .where(and(eq(baseQuestProgress.baseId, first.id), eq(baseQuestProgress.questId, quest!.id)));
    expect(stored?.claimedAt).not.toBeNull();
  });

  it('ratchets and rewards campaign progress once per deed, then conveys it', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const first = await addBase(seller.wallet, 1);
    const second = await addBase(seller.wallet, 2);
    const before = await getBaseShardBalance(db, first.id);
    const firstResult = await recordBaseCampaignOutcome(db, first.id, seller.wallet, 1, 3);
    const duplicate = await recordBaseCampaignOutcome(db, first.id, seller.wallet, 1, 3);
    expect(firstResult).toMatchObject({ firstThreeStar: true });
    expect(duplicate).toEqual({ firstThreeStar: false, rewardShards: 0n });
    expect(await getBaseShardBalance(db, first.id)).toBe(before + firstResult.rewardShards);
    expect((await getBaseCampaignBoard(db, seller.wallet, first.id)).stages[0])
      .toMatchObject({ bestStars: 3, firstThreeStarClaimed: true });
    expect((await getBaseCampaignBoard(db, seller.wallet, second.id)).stages[0])
      .toMatchObject({ bestStars: 0, firstThreeStarClaimed: false });
    await assertBaseCampaignStageUnlocked(db, first.id, 2);
    await expect(assertBaseCampaignStageUnlocked(db, second.id, 2)).rejects.toThrow(/clear stage 1/);

    await transferStableBase(db, first.id, seller.wallet, buyer.wallet, first.deedAssetId);
    expect((await getBaseCampaignBoard(db, buyer.wallet, first.id)).stages[0])
      .toMatchObject({ bestStars: 3, firstThreeStarClaimed: true });
    const [stored] = await db.select().from(baseCampaignProgress)
      .where(and(eq(baseCampaignProgress.baseId, first.id), eq(baseCampaignProgress.stage, 1)));
    expect(stored?.bestStars).toBe(3);
    expect(firstResult.rewardShards).toBe(BigInt(CAMPAIGN.firstThreeStarShardsByKeep[0]!));
  });
});
