/**
 * A Mine is a physical loot container owned by one deed. These regressions
 * prevent the previous wallet-wide/max-active-base model from returning: every
 * Mine fills independently, inactive sibling deeds do not combine income, and
 * a full one-day buffer pauses instead of silently producing more.
 */
import { MINING, getMiningQuota } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  baseEconomyBackfills, bases, baseSlots, builderJobs, buildings, mineAccrualStates,
  players, referrals,
} from '../src/db/schema';
import { completeDueJobs } from '../src/game/base';
import { refreshBaseOwnership, transferStableBase } from '../src/game/baseOwnership';
import {
  collectBaseMines, currentMineStorageCap, ensureBaseMineState, getBaseMineStatus, MINE_DAY_MS,
  projectMineFill, reanchorBaseMineAccrual, rescheduleBaseMineFullChecks,
} from '../src/game/baseMining';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import {
  activeReferralBonusBps, getOrCreateReferralCode, qualifyReferrals, useReferralCode,
} from '../src/game/social';
import {
  bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount,
} from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const oldMultiBase = process.env['MULTI_BASE_ENABLED'];

beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (oldMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = oldMultiBase;
  await conn.sql.end();
});

async function makeBase(slot: number, keepLevel = 1) {
  const owner = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({
    ownerWallet: owner.wallet, status: 'active', keepLevel,
  }).returning();
  await db.insert(baseSlots).values({ wallet: owner.wallet, slot, baseId: base!.id });
  return { ...owner, baseId: base!.id };
}

async function addBase(
  wallet: string, slot: number, keepLevel: number, paid: boolean,
) {
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet, status: 'active', keepLevel,
    landPaidAt: paid ? new Date('2026-08-01T00:00:00.000Z') : null,
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  return base!;
}

async function addMine(wallet: string, baseId: string, level: number, anchor: Date) {
  const [mine] = await db.insert(buildings).values({
    playerWallet: wallet, baseId, type: 'mine', level,
    tx: level, ty: level,
  }).returning();
  await db.insert(mineAccrualStates).values({
    mineBuildingId: mine!.id, lastAccrualAt: anchor,
  });
  return mine!;
}

const context = (baseId: string): StableBaseMutationContext => ({
  baseId, assertAuthority: async () => {},
});

describe.sequential('per-deed physical Mine accrual', () => {
  it('projects the exact bigint fill millisecond paired with accrual flooring', () => {
    const anchor = new Date('2030-01-01T00:00:00.000Z');
    const delta = (4n * BigInt(MINE_DAY_MS) + 7n - 1n) / 7n;
    const before = projectMineFill(3n, anchor, 7,
      new Date(anchor.getTime() + Number(delta - 1n)));
    const boundary = projectMineFill(3n, anchor, 7,
      new Date(anchor.getTime() + Number(delta)));
    expect(before).toMatchObject({ accrued: 6n, capacity: 7n });
    expect(boundary).toEqual({
      accrued: 7n, capacity: 7n,
      fullAtMs: BigInt(anchor.getTime()) + delta,
    });

    // No Number coercion may round a stored bigint buffer before cap handling.
    const huge = 9_007_199_254_740_993n;
    expect(projectMineFill(huge, anchor, 7, anchor).accrued).toBe(huge);
  });

  it('fills each Mine to its own one-day cap and credits only the deed account', async () => {
    const owner = await makeBase(1, 5);
    const t0 = new Date('2026-08-01T00:00:00.000Z');
    const mine1 = await addMine(owner.wallet, owner.baseId, 1, t0);
    const mine2 = await addMine(owner.wallet, owner.baseId, 5, t0);
    const q1 = getMiningQuota(5, [1], 0, MINING.EPOCH_RATE_BPS);
    const q2 = getMiningQuota(5, [5], 0, MINING.EPOCH_RATE_BPS);

    const full = await getBaseMineStatus(
      db, owner.wallet, owner.baseId, new Date(t0.getTime() + 5 * MINE_DAY_MS),
    );
    expect(full.mining.mines).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mine1.id, accrued: q1, storageCap: q1, full: true }),
      expect.objectContaining({ id: mine2.id, accrued: q2, storageCap: q2, full: true }),
    ]));

    const collected = await collectBaseMines(
      db, owner.wallet, context(owner.baseId), new Date(t0.getTime() + 7 * MINE_DAY_MS),
    );
    expect(collected.amount).toBe(BigInt(q1 + q2));
    expect((await getOrCreateBaseAccount(db, owner.baseId, 'base_shards')).balance)
      .toBe(BigInt(q1 + q2));
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards')).balance).toBe(0n);
  });

  it('does not combine two deed economies owned by the same wallet', async () => {
    const owner = await makeBase(1, 3);
    const [second] = await db.insert(bases).values({
      ownerWallet: owner.wallet, status: 'active', keepLevel: 8,
    }).returning();
    await db.insert(baseSlots).values({ wallet: owner.wallet, slot: 2, baseId: second!.id });
    const t0 = new Date('2026-08-02T00:00:00.000Z');
    await addMine(owner.wallet, owner.baseId, 2, t0);
    await addMine(owner.wallet, second!.id, 8, t0);
    const firstQuota = getMiningQuota(3, [2], 0, MINING.EPOCH_RATE_BPS);
    const secondQuota = getMiningQuota(8, [8], 0, MINING.EPOCH_RATE_BPS);

    await collectBaseMines(
      db, owner.wallet, context(owner.baseId), new Date(t0.getTime() + MINE_DAY_MS),
    );
    expect((await getOrCreateBaseAccount(db, owner.baseId, 'base_shards')).balance)
      .toBe(BigInt(firstQuota));
    expect((await getOrCreateBaseAccount(db, second!.id, 'base_shards')).balance).toBe(0n);
    const untouched = await getBaseMineStatus(
      db, owner.wallet, second!.id, new Date(t0.getTime() + 3 * MINE_DAY_MS),
    );
    expect(untouched.mining.accrued).toBe(secondQuota);
  });

  it('serializes concurrent collect taps so every Mine pays once', async () => {
    const owner = await makeBase(1, 2);
    const t0 = new Date('2026-08-03T00:00:00.000Z');
    await addMine(owner.wallet, owner.baseId, 2, t0);
    const at = new Date(t0.getTime() + MINE_DAY_MS);
    const results = await Promise.all([
      collectBaseMines(db, owner.wallet, context(owner.baseId), at),
      collectBaseMines(db, owner.wallet, context(owner.baseId), at),
    ]);
    const quota = BigInt(getMiningQuota(2, [2], 0, MINING.EPOCH_RATE_BPS));
    expect(results[0]!.amount + results[1]!.amount).toBe(quota);
    expect((await getOrCreateBaseAccount(db, owner.baseId, 'base_shards')).balance).toBe(quota);
  });

  it('collecting a faster Mine does not erase a slower Mine before its first whole SHARD', async () => {
    const owner = await makeBase(1);
    const t0 = new Date('2026-09-08T00:00:00.000Z');
    const faster = await addMine(owner.wallet, owner.baseId, 2, t0);
    const slower = await addMine(owner.wallet, owner.baseId, 1, t0);
    const fasterQuota = getMiningQuota(1, [2], 0, MINING.EPOCH_RATE_BPS);
    const slowerQuota = getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS);
    const interval = Math.ceil(MINE_DAY_MS / fasterQuota);
    expect(interval * slowerQuota).toBeLessThan(MINE_DAY_MS);
    const [before] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, slower.id));

    const first = await collectBaseMines(db, owner.wallet, context(owner.baseId), new Date(+t0 + interval));
    expect(first.mines).toContainEqual({ id: faster.id, amount: 1n });
    expect(first.mines).toContainEqual({ id: slower.id, amount: 0n });
    const [afterEmpty] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, slower.id));
    // An empty collect must preserve the elapsed fraction, idempotency version,
    // and notification deadline. Otherwise frequent collects starve this Mine.
    expect(afterEmpty).toEqual(before);

    const second = await collectBaseMines(db, owner.wallet, context(owner.baseId), new Date(+t0 + interval * 2));
    expect(second.mines).toContainEqual({ id: slower.id, amount: 1n });
    expect(second.amount).toBe(2n);
    expect((await collectBaseMines(db, owner.wallet, context(owner.baseId), new Date(+t0 + interval * 2))).amount).toBe(0n);
  });

  it('previews a completed new Mine from its build deadline before lazy state materialization', async () => {
    const owner = await makeBase(1);
    const finishesAt = new Date('2026-09-08T00:00:00.000Z');
    const [mine] = await db.insert(buildings).values({
      playerWallet: owner.wallet, baseId: owner.baseId, type: 'mine', level: 1, tx: 1, ty: 1,
    }).returning();
    await db.insert(builderJobs).values({
      playerWallet: owner.wallet, baseId: owner.baseId, buildingId: mine!.id,
      kind: 'build', startedAt: new Date(+finishesAt - 60_000), finishesAt,
    });
    const now = new Date(+finishesAt + MINE_DAY_MS / 2);
    const status = await getBaseMineStatus(db, owner.wallet, owner.baseId, now);
    const expected = BigInt(getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS)) / 2n;
    expect(status.mining.accrued).toBe(Number(expected));
    // Status remains read-only, and its preview agrees with authoritative collect.
    expect(await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine!.id))).toHaveLength(0);
    expect((await collectBaseMines(db, owner.wallet, context(owner.baseId), now)).amount).toBe(expected);
  });

  it('settles the seller rate before a deed transfer and applies the buyer referral rate only forward', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const referee = await createTestPlayer(db);
    const deed = `mine-transfer-${seller.wallet}`;
    const [sold] = await db.insert(bases).values({
      ownerWallet: seller.wallet, status: 'active', keepLevel: 2,
      landPaidAt: new Date(), deedAssetId: deed,
    }).returning();
    await db.insert(baseSlots).values({ wallet: seller.wallet, slot: 1, baseId: sold!.id });
    const refereeBase = await addBase(referee.wallet, 1, 3, true);
    await db.update(bases).set({ deedAssetId: `mine-referee-${referee.wallet}` })
      .where(eq(bases.id, refereeBase.id));
    await db.update(players).set({ lastSeenAt: new Date(Date.now() + MINE_DAY_MS) })
      .where(eq(players.wallet, referee.wallet));
    await db.insert(referrals).values({
      referrerWallet: buyer.wallet,
      refereeWallet: referee.wallet,
      qualifiedAt: new Date(),
    });
    expect(await activeReferralBonusBps(db, seller.wallet)).toBe(0);
    expect(await activeReferralBonusBps(db, buyer.wallet)).toBe(50);

    const transferStartedAt = new Date();
    const accrualStartedAt = new Date(transferStartedAt.getTime() - MINE_DAY_MS / 2);
    const mine = await addMine(seller.wallet, sold!.id, 2, accrualStartedAt);
    const sellerQuota = (await getBaseMineStatus(
      db, seller.wallet, sold!.id, transferStartedAt,
    )).mining.mines[0]!.quotaPerDay;

    await transferStableBase(db, sold!.id, seller.wallet, buyer.wallet, deed);

    const [boundary] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(boundary!.accruedShards).toBe(projectMineFill(
      0n, accrualStartedAt, sellerQuota, boundary!.lastAccrualAt,
    ).accrued);
    expect(boundary!.fullNotificationCycle).toBe(0);

    const buyerStatus = await getBaseMineStatus(
      db, buyer.wallet, sold!.id, boundary!.lastAccrualAt,
    );
    const buyerQuota = buyerStatus.mining.mines[0]!.quotaPerDay;
    expect(buyerQuota).toBeGreaterThan(sellerQuota);
    const collectAt = new Date(boundary!.lastAccrualAt.getTime() + MINE_DAY_MS / 2);
    const expected = projectMineFill(
      boundary!.accruedShards, boundary!.lastAccrualAt, buyerQuota, collectAt,
    ).accrued;
    const collected = await collectBaseMines(db, buyer.wallet, context(sold!.id), collectAt);
    expect(collected.amount).toBe(expected);
    // Applying the buyer's higher bonus retroactively to the whole day would
    // reach its full cap. The correctly piecewise amount remains below it.
    expect(collected.amount).toBeLessThan(BigInt(buyerQuota));
  });

  it('settles the seller rate when the finalized observer discovers an external deed transfer', async () => {
    // WHY: an owner can sell a deed directly on chain. That observer path is a
    // real transfer boundary too; using the buyer's referral rate for elapsed
    // seller time would overmint the deed's SHARDS and mis-time its Mine alert.
    const seller = await createTestPlayer(db);
    // Generic ledger fixtures use arbitrary 32-byte addresses, which may be
    // off-curve. A deed transfer requires an actually signable wallet.
    const buyer = { wallet: Keypair.generate().publicKey.toBase58() };
    await db.insert(players).values(buyer);
    const referee = await createTestPlayer(db);
    const deed = `mine-observed-transfer-${seller.wallet}`;
    const [sold] = await db.insert(bases).values({
      ownerWallet: seller.wallet, status: 'active', keepLevel: 2,
      landPaidAt: new Date('2026-08-01T00:00:00.000Z'), deedAssetId: deed,
    }).returning();
    await db.insert(baseSlots).values({ wallet: seller.wallet, slot: 1, baseId: sold!.id });
    const refereeBase = await addBase(referee.wallet, 1, 3, true);
    await db.update(bases).set({ deedAssetId: `mine-referee-${referee.wallet}` })
      .where(eq(bases.id, refereeBase.id));
    const observedAt = new Date('2032-04-05T12:00:00.000Z');
    await db.update(players).set({ lastSeenAt: observedAt })
      .where(eq(players.wallet, referee.wallet));
    await db.insert(referrals).values({
      referrerWallet: buyer.wallet, refereeWallet: referee.wallet, qualifiedAt: observedAt,
    });
    expect(await activeReferralBonusBps(db, seller.wallet, observedAt)).toBe(0);
    expect(await activeReferralBonusBps(db, buyer.wallet, observedAt)).toBe(50);

    const accrualStartedAt = new Date(observedAt.getTime() - MINE_DAY_MS / 2);
    const mine = await addMine(seller.wallet, sold!.id, 2, accrualStartedAt);
    await db.update(mineAccrualStates).set({ fullNotificationCycle: 9 })
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    const sellerQuota = (await getBaseMineStatus(
      db, seller.wallet, sold!.id, observedAt,
    )).mining.mines[0]!.quotaPerDay;

    expect(await refreshBaseOwnership(db, sold!.id, async () => ({
      owner: buyer.wallet, frozen: false, delegate: null, collection: 'collection', slot: 42,
    }), 'collection', observedAt, 'test-external-transfer', () => observedAt)).toBe('mismatch');

    const [boundary] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    const sellerProjection = projectMineFill(0n, accrualStartedAt, sellerQuota, observedAt);
    expect(boundary).toMatchObject({
      accruedShards: sellerProjection.accrued,
      lastAccrualAt: observedAt,
      fullNotificationCycle: 9,
    });
    // Observer-discovered sales deliberately quarantine the received deed as
    // inactive until the buyer chooses a slot. The physical Mine still gets
    // its future deadline under the buyer's live quota at the sale boundary.
    const buyerQuota = Number(
      await currentMineStorageCap(db, mine.id, observedAt)
      / BigInt(MINING.MINE_STORAGE_DAYS),
    );
    expect(buyerQuota).toBeGreaterThan(sellerQuota);
    const buyerProjection = projectMineFill(
      sellerProjection.accrued, observedAt, buyerQuota, observedAt,
    );
    expect(boundary!.fullNotificationCheckAt?.getTime())
      .toBe(Number(buyerProjection.fullAtMs));
  });

  it('advances the notification cycle only for a positive permanent collection', async () => {
    const owner = await makeBase(1, 1);
    const t0 = new Date('2026-08-03T00:00:00.000Z');
    const mine = await addMine(owner.wallet, owner.baseId, 1, t0);
    const collectedAt = new Date(t0.getTime() + MINE_DAY_MS / 2);
    // A rollout classifier may not have visited this Mine before collection.
    await db.update(mineAccrualStates).set({ fullNotificationBootstrapPending: true })
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    await collectBaseMines(db, owner.wallet, context(owner.baseId), t0);
    expect((await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id)))[0]!.fullNotificationBootstrapPending)
      .toBe(true); // an empty tap is not a drain and cannot bypass suppression
    await collectBaseMines(db, owner.wallet, context(owner.baseId), collectedAt);
    let [state] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(state).toMatchObject({
      fullNotificationCycle: 1,
      fullNotificationBootstrapPending: false,
      fullNotificationCheckAt: new Date(collectedAt.getTime() + MINE_DAY_MS),
    });

    await collectBaseMines(db, owner.wallet, context(owner.baseId), collectedAt);
    [state] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(state!.fullNotificationCycle).toBe(1);

    await reanchorBaseMineAccrual(db, owner.baseId, collectedAt);
    await rescheduleBaseMineFullChecks(db, owner.baseId, collectedAt);
    [state] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(state!.fullNotificationCycle).toBe(1);

    await db.insert(builderJobs).values({
      playerWallet: owner.wallet, baseId: owner.baseId, buildingId: mine.id,
      kind: 'upgrade', startedAt: collectedAt, finishesAt: collectedAt,
    });
    await completeDueJobs(db, owner.wallet, collectedAt, owner.baseId);
    [state] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(state!.fullNotificationCycle).toBe(1);
  });

  it('attaches a pending legacy buffer exactly once when the first Mine completes', async () => {
    const owner = await makeBase(1, 2);
    const shardAccount = await getOrCreateBaseAccount(db, owner.baseId, 'base_shards');
    const forgeAccount = await getOrCreateBaseAccount(db, owner.baseId, 'base_forge_escrow');
    const systems = await bootstrapSystemAccounts(db);
    await db.insert(baseEconomyBackfills).values({
      legacyWallet: owner.wallet,
      primaryBaseId: owner.baseId,
      destinationShardAccountId: shardAccount.id,
      sourceForgeEscrowAccountId: systems.forge_escrow,
      destinationForgeEscrowAccountId: forgeAccount.id,
      legacyMineBufferPending: 777n,
      ledgerStatus: 'complete',
      completedAt: new Date(),
    });
    const [mine] = await db.insert(buildings).values({
      playerWallet: owner.wallet,
      baseId: owner.baseId,
      type: 'mine',
      level: 1,
      tx: 3,
      ty: 3,
    }).returning();
    const anchor = new Date('2026-08-04T00:00:00.000Z');

    await db.transaction((tx) => ensureBaseMineState(tx, mine!.id, anchor));
    await db.transaction((tx) => ensureBaseMineState(tx, mine!.id, anchor));

    const [state] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine!.id));
    const [backfill] = await db.select().from(baseEconomyBackfills)
      .where(eq(baseEconomyBackfills.legacyWallet, owner.wallet));
    expect(state).toMatchObject({ accruedShards: 777n, version: 1 });
    expect(backfill).toMatchObject({ legacyMineBufferPending: 0n });
    expect(backfill!.mineBackfilledAt).not.toBeNull();
  });

  it('qualifies referrals from one complete paid deed, never wallet compatibility shadows', async () => {
    const referrer = await createTestPlayer(db);
    const referee = await createTestPlayer(db);
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    await useReferralCode(db, referee.wallet, code);
    await db.update(players).set({
      // These legacy shadows deliberately satisfy the old gate.
      keepLevel: 20,
      entryPaidAt: new Date('2026-08-01T00:00:00.000Z'),
    }).where(eq(players.wallet, referee.wallet));
    await addBase(referee.wallet, 1, 20, false);
    const paid = await addBase(referee.wallet, 2, 1, true);

    // An unpaid Keep-20 base and paid Keep-below-gate base both refuse (D-052:
    // the deed must be real AND at Keep L3).
    expect(await qualifyReferrals(db)).toBe(0);
    await db.update(bases).set({ keepLevel: 2 }).where(eq(bases.id, paid.id));
    expect(await qualifyReferrals(db)).toBe(0);
    await db.update(bases).set({ keepLevel: 3 }).where(eq(bases.id, paid.id));
    expect(await qualifyReferrals(db)).toBe(1);
  });

  it('an ACTIVE qualified referral raises the referrer quota 50 bps at status AND collect (D-052)', async () => {
    const referrer = await createTestPlayer(db);
    const referee = await createTestPlayer(db);
    const referrerBase = await addBase(referrer.wallet, 1, 2, true);
    await addBase(referee.wallet, 1, 3, true);
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    await useReferralCode(db, referee.wallet, code);
    await db.update(players).set({ lastSeenAt: new Date() })
      .where(eq(players.wallet, referee.wallet));
    expect(await qualifyReferrals(db)).toBe(1);
    expect(await activeReferralBonusBps(db, referrer.wallet)).toBe(50);

    const t0 = new Date('2026-08-05T00:00:00.000Z');
    const t1 = new Date(t0.getTime() + MINE_DAY_MS);
    await addMine(referrer.wallet, referrerBase.id, 2, t0);

    // One formula, both surfaces: what the status previews IS what the collect
    // settles — a mine can never display one rate and pay another.
    const boosted = getMiningQuota(2, [2], 0, MINING.EPOCH_RATE_BPS, 50);
    expect(boosted).toBeGreaterThan(getMiningQuota(2, [2], 0));
    const status = await getBaseMineStatus(db, referrer.wallet, referrerBase.id, t0);
    expect(status.mining.quotaPerDay).toBe(boosted);
    const collected = await collectBaseMines(db, referrer.wallet, context(referrerBase.id), t1);
    expect(collected.amount).toBe(BigInt(boosted));

    // The referee going quiet past the lapse window drops the rate back for
    // the NEXT interval — enforced at the money, not in a cron.
    await db.update(players).set({
      lastSeenAt: new Date(t1.getTime() - 9 * MINE_DAY_MS),
    }).where(eq(players.wallet, referee.wallet));
    const lapsed = await getBaseMineStatus(db, referrer.wallet, referrerBase.id, t1);
    expect(lapsed.mining.quotaPerDay).toBe(getMiningQuota(2, [2], 0));
  });
});
