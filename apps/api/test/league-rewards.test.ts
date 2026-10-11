/**
 * Cumulative ranked-league rewards. SHARDS can flow through the Gold Forge and
 * items can be sold, so retries, eligibility, and wallet selection are money
 * invariants rather than presentation details.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { LEAGUES } from '@shardkeep/shared';
import bs58 from 'bs58';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  accounts, baseItems, baseLeagueEntitlements, baseProfiles, bases, baseSlots,
  deedOwnershipObservations, leagueItemGrants, leagueWeekBaseSnapshots,
  leagueWeekBaseExclusions, leagueWeekClosures, ledgerEntries, ledgerTransactions, players, raids,
} from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity, type FinalizedDeedReader } from '../src/game/baseOwnership';
import {
  closeLeagueWeek, ensureLeagueRewardActivation, firstCompleteLeagueWeek,
  getLeagueOverview, leagueForTrophies, leagueWeeklyRewards,
  reconcilePendingLeagueRewards, runWeeklyLeagueReset,
  type LeagueRewardPolicy,
} from '../src/game/leagues';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const DAY_MS = 86_400_000;
const POLICY: LeagueRewardPolicy = { enabled: true, startWeek: LEAGUES.rewardStartWeek };
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
const TEST_DEED_COLLECTION = 'league-test-collection';
let sequence = 0;

function dateKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function closedWindow(settlementAt: Date): { startsAt: Date; closesAt: Date } {
  const midnight = Date.UTC(
    settlementAt.getUTCFullYear(), settlementAt.getUTCMonth(), settlementAt.getUTCDate(),
  );
  const dayFromMonday = (settlementAt.getUTCDay() + 6) % 7;
  const closesAt = new Date(midnight - dayFromMonday * DAY_MS);
  return { startsAt: new Date(closesAt.getTime() - 7 * DAY_MS), closesAt };
}

/** Allocate a Monday 00:15 whose closed week no other shared-DB fixture froze. */
async function unusedSettlement(): Promise<Date> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const year = 2200 + sequence++;
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const daysUntilMonday = (8 - jan1.getUTCDay()) % 7;
    const closesAt = new Date(jan1.getTime() + (daysUntilMonday + 7) * DAY_MS);
    const settlementAt = new Date(closesAt.getTime() + 15 * 60_000);
    const week = dateKey(closedWindow(settlementAt).startsAt);
    const existing = await db.select({ baseId: baseLeagueEntitlements.baseId })
      .from(baseLeagueEntitlements).where(eq(baseLeagueEntitlements.week, week)).limit(1);
    if (existing.length === 0) return settlementAt;
  }
  throw new Error('could not allocate a league settlement week');
}

interface RankedBase {
  wallet: string;
  baseId: string;
}

async function newRankedBase(opts: {
  trophies: number;
  keepLevel?: number;
  wallet?: string;
  slot?: number;
  name?: string;
}): Promise<RankedBase> {
  let wallet = opts.wallet;
  if (!wallet) {
    wallet = bs58.encode(await getPublicKeyAsync(utils.randomSecretKey()));
    await db.insert(players).values({ wallet });
    await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  }
  let baseId: string;
  if (opts.wallet) {
    const [base] = await db.insert(bases).values({
      ownerWallet: wallet,
      status: 'active',
      keepLevel: opts.keepLevel ?? 1,
      landPaidAt: new Date(),
    }).returning({ id: bases.id });
    baseId = base!.id;
    await db.insert(baseSlots).values({
      wallet, slot: opts.slot ?? 2, baseId, active: true, selectedAt: new Date(),
    });
  } else {
    await ensureStartingBase(db, wallet);
    const identity = await ensureWalletBaseIdentity(db, wallet);
    if (!identity) throw new Error('fixture base identity missing');
    baseId = identity;
  }
  const deed = `league-fixture-${baseId}`;
  await db.update(bases).set({
    deedAssetId: deed,
    deedMintAssetId: deed,
    landPaidAt: new Date(),
    status: 'active',
    keepLevel: opts.keepLevel ?? 1,
  }).where(eq(bases.id, baseId));
  await db.insert(baseProfiles).values({ baseId, trophies: opts.trophies })
    .onConflictDoUpdate({ target: baseProfiles.baseId, set: { trophies: opts.trophies } });
  if (opts.name) await db.update(players).set({ name: opts.name }).where(eq(players.wallet, wallet));
  return { wallet, baseId };
}

async function victimBase(): Promise<RankedBase> {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  const baseId = await ensureWalletBaseIdentity(db, p.wallet);
  if (!baseId) throw new Error('victim base identity missing');
  return { wallet: p.wallet, baseId };
}

async function insertRaid(values: {
  attacker: RankedBase;
  defender?: RankedBase;
  status?: 'resolved' | 'pending_orders';
  resolvedAt?: Date | null;
  campaignStage?: number;
}): Promise<void> {
  await db.insert(raids).values({
    attackerWallet: values.attacker.wallet,
    attackerBaseId: values.attacker.baseId,
    ...(values.defender ? {
      defenderWallet: values.defender.wallet,
      defenderBaseId: values.defender.baseId,
    } : {}),
    ...(values.campaignStage ? { campaignStage: values.campaignStage } : {}),
    seed: BigInt(++sequence),
    snapshot: {},
    armySnapshot: {},
    ordersDeadlineAt: values.resolvedAt ?? new Date(),
    status: values.status ?? 'resolved',
    resolvedAt: values.resolvedAt === undefined ? new Date() : values.resolvedAt,
  });
}

async function seedRatedAttacks(
  attacker: RankedBase, settlementAt: Date,
  count: number = LEAGUES.rewardMinAttackerRaids,
): Promise<void> {
  const defender = await victimBase();
  const { startsAt } = closedWindow(settlementAt);
  for (let i = 0; i < count; i += 1) {
    await insertRaid({
      attacker,
      defender,
      resolvedAt: new Date(startsAt.getTime() + (i + 1) * 60_000),
    });
  }
}

async function shardBalance(baseId: string): Promise<bigint> {
  const [row] = await db.select().from(accounts).where(and(
    eq(accounts.baseId, baseId), eq(accounts.kind, 'base_shards'),
  ));
  return row?.balance ?? 0n;
}

async function itemQty(baseId: string, itemId: string): Promise<number> {
  const [row] = await db.select().from(baseItems).where(and(
    eq(baseItems.baseId, baseId), eq(baseItems.itemId, itemId),
  ));
  return row?.qty ?? 0;
}

async function receipt(week: string, baseId: string) {
  const [row] = await db.select().from(baseLeagueEntitlements).where(and(
    eq(baseLeagueEntitlements.week, week), eq(baseLeagueEntitlements.baseId, baseId),
  ));
  return row;
}

async function seedFinalizedAuthorities(at: Date): Promise<void> {
  const active = await db.select({
    baseId: bases.id,
    assetId: bases.deedAssetId,
    owner: bases.ownerWallet,
  }).from(bases).where(and(
    eq(bases.status, 'active'),
    sql`${bases.landPaidAt} IS NOT NULL`,
    sql`${bases.deedAssetId} IS NOT NULL`,
  ));
  for (const [index, base] of active.entries()) {
    const evidence = {
      assetId: base.assetId!, owner: base.owner, slot: BigInt(index + 1), checkedAt: at,
      source: 'league-test-close', status: 'owned' as const,
      auditHash: `${base.baseId.replaceAll('-', '')}${index}`.padEnd(64, '0').slice(0, 64),
    };
    const [existing] = await db.select({ id: deedOwnershipObservations.id })
      .from(deedOwnershipObservations)
      .where(eq(deedOwnershipObservations.baseId, base.baseId));
    if (existing) {
      await db.update(deedOwnershipObservations).set(evidence)
        .where(eq(deedOwnershipObservations.id, existing.id));
    } else {
      await db.insert(deedOwnershipObservations).values({ baseId: base.baseId, ...evidence });
    }
  }
}

function closeAuthority(ownerOverrides: ReadonlyMap<string, string> = new Map()) {
  const read = async (assetId: string, fixedSlot?: number) => {
    const [base] = await db.select({ owner: bases.ownerWallet }).from(bases)
      .where(eq(bases.deedAssetId, assetId));
    if (!base) return null;
    return {
      owner: ownerOverrides.get(assetId) ?? base.owner,
      frozen: false,
      delegate: null,
      collection: TEST_DEED_COLLECTION,
      slot: fixedSlot ?? 1_000_000 + sequence++,
    };
  };
  const reader: FinalizedDeedReader = read;
  reader.readMany = async (requests) => new Map(await Promise.all(requests.map(async ({ assetId }) => (
    [assetId, await read(assetId)] as const
  ))));
  reader.readBatch = async (requests) => {
    const contextSlot = 2_000_000;
    return {
      owners: new Map(await Promise.all(requests.map(async ({ assetId }) => (
        [assetId, await read(assetId, contextSlot)] as const
      )))),
      contextSlot,
      transportSucceeded: true,
    };
  };
  return { reader, expectedCollection: TEST_DEED_COLLECTION };
}

function unavailableCloseAuthority() {
  const reader = (async () => null) as FinalizedDeedReader;
  reader.readBatch = async (requests) => ({
    owners: new Map(requests.map(({ assetId }) => [assetId, null])),
    contextSlot: null,
    transportSucceeded: false,
  });
  return { reader, expectedCollection: TEST_DEED_COLLECTION };
}

async function closeWeek(
  settlementAt: Date,
  policy: LeagueRewardPolicy = POLICY,
) {
  const { startsAt, closesAt } = closedWindow(settlementAt);
  await seedFinalizedAuthorities(startsAt);
  await closeLeagueWeek(db, startsAt, policy.enabled ? {
    ...policy,
    startWeek: [policy.startWeek, dateKey(startsAt)].sort().at(-1)!,
  } : policy);
  await seedFinalizedAuthorities(closesAt);
  return closeLeagueWeek(db, closesAt, policy, closeAuthority());
}

beforeAll(async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
  await ensureLeagueRewardActivation(db, new Date('2026-09-07T00:00:00.000Z'), POLICY);
});
afterEach(() => { vi.unstubAllEnvs(); process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});

describe('league reward rules', () => {
  it('pins cumulative thresholds and the exact conservative cache/item ladder', () => {
    expect([0, 9, 10, 49, 50, 149, 150].map(leagueForTrophies))
      .toEqual(['bronze', 'bronze', 'silver', 'silver', 'gold', 'gold', 'sol']);
    expect(leagueWeeklyRewards('bronze', 1)).toEqual({
      cacheShards: 150n, items: [{ itemId: 'keg_of_haste', qty: 1 }],
    });
    expect(leagueWeeklyRewards('sol', 20)).toEqual({
      cacheShards: 102_000n,
      items: [{ itemId: 'finishers_seal', qty: 1 }, { itemId: 'keg_of_haste', qty: 2 }],
    });
    expect(LEAGUES).not.toHaveProperty('lootTitheBps');
    expect(LEAGUES).not.toHaveProperty('energy');
    expect(LEAGUES).not.toHaveProperty('poolSplitBps');
  });

  it('moves a mid-week activation to the next complete Monday', () => {
    expect(firstCompleteLeagueWeek(
      new Date('2026-09-07T00:00:00.000Z'), '2026-09-07',
    )).toBe('2026-09-07');
    expect(firstCompleteLeagueWeek(
      new Date('2026-09-07T00:00:00.001Z'), '2026-09-07',
    )).toBe('2026-09-14');
    expect(firstCompleteLeagueWeek(
      new Date('2026-09-10T12:00:00.000Z'), '2026-09-07',
    )).toBe('2026-09-14');
  });

  it('grants the full untaxed SHARD cache + items with mining enabled, once under retries', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const at = await unusedSettlement();
    const week = dateKey(closedWindow(at).startsAt);
    const ranked = await newRankedBase({ trophies: 180, keepLevel: 10 });
    await seedRatedAttacks(ranked, at);
    const expected = leagueWeeklyRewards('sol', 10);
    const playerKeep = await getOrCreatePlayerAccount(db, ranked.wallet, 'player_keep');
    const keepBefore = playerKeep.balance;
    const [profileBefore] = await db.select().from(baseProfiles)
      .where(eq(baseProfiles.baseId, ranked.baseId));

    await closeWeek(at);
    const results = await Promise.all([
      runWeeklyLeagueReset(db, at, POLICY),
      runWeeklyLeagueReset(db, at, POLICY),
    ]);
    expect(results.every((result) => result.failed === 0)).toBe(true);
    expect(await shardBalance(ranked.baseId)).toBe(expected.cacheShards);
    expect(await itemQty(ranked.baseId, 'finishers_seal')).toBe(1);
    expect(await itemQty(ranked.baseId, 'keg_of_haste')).toBe(2);
    expect((await getOrCreatePlayerAccount(db, ranked.wallet, 'player_keep')).balance)
      .toBe(keepBefore);
    const [profileAfter] = await db.select().from(baseProfiles)
      .where(eq(baseProfiles.baseId, ranked.baseId));
    expect(profileAfter!.purchasedEnergy).toBe(profileBefore!.purchasedEnergy);

    const frozen = await receipt(week, ranked.baseId);
    expect(frozen).toMatchObject({
      tier: 'sol', trophies: 180, keepAmount: 0n, keepLevelGranted: 10,
      cacheShardsGranted: expected.cacheShards, itemsGranted: expected.items,
    });
    expect(frozen!.paidAt).not.toBeNull();
    expect(await db.select().from(leagueItemGrants).where(and(
      eq(leagueItemGrants.week, week), eq(leagueItemGrants.baseId, ranked.baseId),
    ))).toHaveLength(2);
    const txns = await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `league-cache:${week}:${ranked.baseId}`,
    ));
    expect(txns).toHaveLength(1);
    const entries = await db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.txnId, txns[0]!.id));
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);

    // Reward facts are immutable after freeze; only attempt/paid markers move.
    await expect(db.update(baseLeagueEntitlements).set({ trophies: 181 }).where(and(
      eq(baseLeagueEntitlements.week, week),
      eq(baseLeagueEntitlements.baseId, ranked.baseId),
    ))).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(db.update(baseLeagueEntitlements).set({ paidAt: null }).where(and(
      eq(baseLeagueEntitlements.week, week),
      eq(baseLeagueEntitlements.baseId, ranked.baseId),
    ))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('settles only the 00:00 snapshot when trophies and ownership change in the gap', async () => {
    const at = await unusedSettlement();
    const { closesAt } = closedWindow(at);
    const week = dateKey(closedWindow(at).startsAt);
    const ranked = await newRankedBase({ trophies: 49, keepLevel: 5 });
    await seedRatedAttacks(ranked, at);
    await closeWeek(at);

    const buyer = await createTestPlayer(db);
    await db.update(baseProfiles).set({ trophies: 160 }).where(eq(baseProfiles.baseId, ranked.baseId));
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, ranked.baseId));
    await db.update(deedOwnershipObservations).set({
      owner: buyer.wallet, checkedAt: new Date(closesAt.getTime() + 5 * 60_000),
      auditHash: 'gap-transfer'.padEnd(64, '0'),
    }).where(eq(deedOwnershipObservations.baseId, ranked.baseId));

    await runWeeklyLeagueReset(db, at, POLICY);
    expect(await receipt(week, ranked.baseId)).toMatchObject({
      tier: 'silver', trophies: 49,
      cacheShardsGranted: leagueWeeklyRewards('silver', 5).cacheShards,
    });
    const [snapshot] = await db.select().from(leagueWeekBaseSnapshots).where(and(
      eq(leagueWeekBaseSnapshots.week, week),
      eq(leagueWeekBaseSnapshots.baseId, ranked.baseId),
    ));
    expect(snapshot).toMatchObject({
      ownerWalletAtClose: ranked.wallet, trophies: 49, deedObservedAt: closesAt,
    });
  });

  it('does not let the recovery scheduler drain frozen value before 00:15', async () => {
    const at = await unusedSettlement();
    const { closesAt } = closedWindow(at);
    const ranked = await newRankedBase({ trophies: 80, keepLevel: 4 });
    await seedRatedAttacks(ranked, at);
    await closeWeek(at);

    const early = await reconcilePendingLeagueRewards(
      db, new Date(closesAt.getTime() + 10 * 60_000), POLICY,
    );
    expect(early.settled).toBe(0);
    expect(await shardBalance(ranked.baseId)).toBe(0n);
    await runWeeklyLeagueReset(db, at, POLICY);
    expect(await shardBalance(ranked.baseId)).toBe(
      leagueWeeklyRewards('gold', 4).cacheShards,
    );
  });

  it('fails settlement closed when the 00:00 snapshot is absent', async () => {
    const at = await unusedSettlement();
    const ranked = await newRankedBase({ trophies: 80, keepLevel: 4 });
    await seedRatedAttacks(ranked, at);
    await expect(runWeeklyLeagueReset(db, at, POLICY))
      .rejects.toThrow(/no complete 00:00 close snapshot/);
  });

  it('records an unpaid recovery boundary when the prior opening marker is missing', async () => {
    const at = await unusedSettlement();
    const { closesAt } = closedWindow(at);
    const recovered = await closeLeagueWeek(db, closesAt, POLICY);
    expect(recovered.rewardsEnabled).toBe(false);

    const nextAt = new Date(at.getTime() + 7 * DAY_MS);
    const ranked = await newRankedBase({ trophies: 80, keepLevel: 4 });
    await seedRatedAttacks(ranked, nextAt);
    const next = await closeLeagueWeek(
      db, closedWindow(nextAt).closesAt, POLICY, closeAuthority(),
    );
    expect(next.rewardsEnabled).toBe(true);
    expect(next.participants).toBeGreaterThan(0);
  });

  it('recovers automatically before 00:15, then terminally closes unpaid without backfill', async () => {
    const at = await unusedSettlement();
    const { startsAt, closesAt } = closedWindow(at);
    const week = dateKey(startsAt);
    const ranked = await newRankedBase({ trophies: 80, keepLevel: 4 });
    await seedRatedAttacks(ranked, at);
    await closeLeagueWeek(db, startsAt, { ...POLICY, startWeek: week });

    await expect(closeLeagueWeek(
      db, new Date(closesAt.getTime() + 5 * 60_000), POLICY, unavailableCloseAuthority(),
    )).rejects.toThrow(/coherent finalized ownership slot/);
    expect(await db.select().from(leagueWeekClosures)
      .where(eq(leagueWeekClosures.week, week))).toHaveLength(0);

    const recovered = await closeLeagueWeek(
      db, new Date(closesAt.getTime() + 6 * 60_000), POLICY, closeAuthority(),
    );
    expect(recovered.rewardsEnabled).toBe(true);

    const terminalAt = await unusedSettlement();
    const terminalWindow = closedWindow(terminalAt);
    const terminalWeek = dateKey(terminalWindow.startsAt);
    const terminalBase = await newRankedBase({ trophies: 160, keepLevel: 5 });
    await seedRatedAttacks(terminalBase, terminalAt);
    await closeLeagueWeek(
      db, terminalWindow.startsAt, { ...POLICY, startWeek: terminalWeek },
    );
    const terminal = await closeLeagueWeek(
      db,
      new Date(terminalWindow.closesAt.getTime() + LEAGUES.settlementDelayMs),
      POLICY,
      unavailableCloseAuthority(),
    );
    expect(terminal.rewardsEnabled).toBe(false);
    const [closure] = await db.select().from(leagueWeekClosures)
      .where(eq(leagueWeekClosures.week, terminalWeek));
    expect(closure).toMatchObject({
      featureEnabledAtClose: true,
      rewardsEnabled: false,
      failureReason: 'authority_snapshot_unavailable',
      participantCount: 0,
      rewardedCount: 0,
    });
    expect(await db.select().from(leagueWeekBaseSnapshots)
      .where(eq(leagueWeekBaseSnapshots.week, terminalWeek))).toHaveLength(0);
    expect(await db.select().from(baseLeagueEntitlements)
      .where(eq(baseLeagueEntitlements.week, terminalWeek))).toHaveLength(0);

    const replay = await closeLeagueWeek(
      db, new Date(terminalWindow.closesAt.getTime() + DAY_MS), POLICY, closeAuthority(),
    );
    expect(replay).toMatchObject({ replayed: true, rewardsEnabled: false });
    expect(await receipt(terminalWeek, terminalBase.baseId)).toBeUndefined();

    const nextAt = new Date(terminalAt.getTime() + 7 * DAY_MS);
    await seedRatedAttacks(terminalBase, nextAt);
    const next = await closeLeagueWeek(db, closedWindow(nextAt).closesAt, POLICY, closeAuthority());
    expect(next.rewardsEnabled).toBe(true);
  });

  it('excludes a finalized owner mismatch without guessing or halting valid bases', async () => {
    const at = await unusedSettlement();
    const { startsAt, closesAt } = closedWindow(at);
    const ranked = await newRankedBase({ trophies: 80, keepLevel: 4 });
    await seedRatedAttacks(ranked, at);
    await seedFinalizedAuthorities(startsAt);
    await closeLeagueWeek(db, startsAt, { ...POLICY, startWeek: dateKey(startsAt) });
    await seedFinalizedAuthorities(closesAt);
    const buyer = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, ranked.baseId));
    const [changed] = await db.select({ assetId: bases.deedAssetId }).from(bases)
      .where(eq(bases.id, ranked.baseId));
    await closeLeagueWeek(db, closesAt, POLICY, closeAuthority(new Map([
      [changed!.assetId!, ranked.wallet],
    ])));
    expect(await receipt(dateKey(startsAt), ranked.baseId)).toBeUndefined();
    const [excluded] = await db.select().from(leagueWeekBaseExclusions).where(and(
      eq(leagueWeekBaseExclusions.week, dateKey(startsAt)),
      eq(leagueWeekBaseExclusions.baseId, ranked.baseId),
    ));
    expect(excluded?.reason).toBe('deed_owner_mismatch');
  });

  it('quarantines a legacy active deed without a profile while valid bases still freeze', async () => {
    const at = await unusedSettlement();
    const week = dateKey(closedWindow(at).startsAt);
    const valid = await newRankedBase({ trophies: 80, keepLevel: 4 });
    await seedRatedAttacks(valid, at);
    const corruptOwner = await createTestPlayer(db);
    const [corrupt] = await db.insert(bases).values({
      ownerWallet: corruptOwner.wallet,
      deedAssetId: `corrupt-league-${sequence++}`,
      deedMintAssetId: null,
      status: 'active', landPaidAt: new Date(), keepLevel: 20,
    }).returning({ id: bases.id });

    await closeWeek(at);

    expect(await receipt(week, valid.baseId)).toMatchObject({ trophies: 80, tier: 'gold' });
    expect(await receipt(week, corrupt!.id)).toBeUndefined();
    const [excluded] = await db.select().from(leagueWeekBaseExclusions).where(and(
      eq(leagueWeekBaseExclusions.week, week),
      eq(leagueWeekBaseExclusions.baseId, corrupt!.id),
    ));
    expect(excluded?.reason).toBe('missing_profile');
  });

  it('rejects every positive KEEP receipt at the database boundary', async () => {
    const ranked = await newRankedBase({ trophies: 10 });
    await expect(db.insert(baseLeagueEntitlements).values({
      week: '2199-01-05', baseId: ranked.baseId, tier: 'silver', trophies: 10,
      keepAmount: 1n,
    })).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('requires three resolved attacker deed-PvP raids and positive trophies inside the exact week', async () => {
    const at = await unusedSettlement();
    const week = dateKey(closedWindow(at).startsAt);
    const { startsAt, closesAt } = closedWindow(at);
    const short = await newRankedBase({ trophies: 149, keepLevel: 5 });
    const eligible = await newRankedBase({ trophies: 49, keepLevel: 5 });
    const zero = await newRankedBase({ trophies: 0, keepLevel: 5 });
    await seedRatedAttacks(short, at, 2);
    await seedRatedAttacks(eligible, at, 3);
    await seedRatedAttacks(zero, at, 3);

    // These must not turn the two valid attacks into three.
    const defender = await victimBase();
    await insertRaid({ attacker: short, defender, status: 'pending_orders', resolvedAt: null });
    await insertRaid({ attacker: short, campaignStage: 1, resolvedAt: new Date(startsAt.getTime() + 10_000) });
    await insertRaid({ attacker: short, defender, resolvedAt: new Date(closesAt.getTime() + 1_000) });
    await insertRaid({ attacker: defender, defender: short, resolvedAt: new Date(startsAt.getTime() + 20_000) });

    await closeWeek(at);
    await runWeeklyLeagueReset(db, at, POLICY);
    expect((await receipt(week, short.baseId))!.cacheShardsGranted).toBe(0n);
    expect((await receipt(week, zero.baseId))!.cacheShardsGranted).toBe(0n);
    expect((await receipt(week, eligible.baseId))!.cacheShardsGranted)
      .toBe(leagueWeeklyRewards('silver', 5).cacheShards);
  });

  it('rewards one base per wallet by tier, trophies, then lexical base id', async () => {
    const at = await unusedSettlement();
    const week = dateKey(closedWindow(at).startsAt);
    const first = await newRankedBase({ trophies: 149, keepLevel: 6 });
    const peerA = await newRankedBase({
      wallet: first.wallet, slot: 2, trophies: 160, keepLevel: 6,
    });
    const peerB = await newRankedBase({
      wallet: first.wallet, slot: 3, trophies: 160, keepLevel: 6,
    });
    await Promise.all([
      seedRatedAttacks(first, at), seedRatedAttacks(peerA, at), seedRatedAttacks(peerB, at),
    ]);
    await closeWeek(at);
    await runWeeklyLeagueReset(db, at, POLICY);

    const winner = [peerA.baseId, peerB.baseId].sort()[0]!;
    for (const base of [first, peerA, peerB]) {
      const frozen = await receipt(week, base.baseId);
      expect(frozen!.cacheShardsGranted > 0n).toBe(base.baseId === winner);
    }
  });

  it('isolates one failed base, then drains its frozen receipt exactly once', async () => {
    const at = await unusedSettlement();
    const week = dateKey(closedWindow(at).startsAt);
    const blocked = await newRankedBase({ trophies: 151, keepLevel: 7 });
    const healthy = await newRankedBase({ trophies: 80, keepLevel: 7 });
    await seedRatedAttacks(blocked, at);
    await seedRatedAttacks(healthy, at);
    await closeWeek(at);
    let failOnce = true;
    const first = await runWeeklyLeagueReset(db, at, POLICY, {
      beforeGrant: async (baseId) => {
        if (baseId === blocked.baseId && failOnce) {
          failOnce = false;
          throw new Error('deterministic worker interruption');
        }
      },
    });
    expect(first.failed).toBe(1);
    expect((await receipt(week, blocked.baseId))).toMatchObject({
      paidAt: null, lastAttemptAt: at,
    });
    expect((await receipt(week, healthy.baseId))!.paidAt).not.toBeNull();
    expect(await shardBalance(blocked.baseId)).toBe(0n);

    const recovered = await reconcilePendingLeagueRewards(db, at, POLICY);
    expect(recovered).toMatchObject({ settled: 1, failed: 0 });
    const after = await shardBalance(blocked.baseId);
    expect(after).toBe(leagueWeeklyRewards('sol', 7).cacheShards);
    await reconcilePendingLeagueRewards(db, at, POLICY);
    expect(await shardBalance(blocked.baseId)).toBe(after);
  });

  it('never backfills when activation moves to the next complete Monday window', async () => {
    // Three consecutive Mondays in this fixture's own far-future year (unusedSettlement), never real calendar weeks:
    // enforce_league_boundary_fence() reads clock_timestamp() and rejects every base insert and trophy update while the
    // real previous week has no closure but the week before it closed enabled. The fixed weeks 2026-09-07/14/21 this
    // case used became exactly that state once the real clock crossed Monday 2026-09-28 00:00Z, so CI went red and the
    // half-seeded closures it left behind failed the next case too. The shape is unchanged: a disabled close of the
    // first week, activation moving to the next complete Monday window, no backfill for the two weeks before it.
    const monday0 = await unusedSettlement();
    const monday1 = new Date(monday0.getTime() + 7 * DAY_MS);
    const monday2 = new Date(monday1.getTime() + 7 * DAY_MS);
    const week0 = dateKey(closedWindow(monday0).startsAt);
    const week1 = dateKey(closedWindow(monday1).startsAt);
    const week2 = dateKey(closedWindow(monday2).startsAt);
    const ranked = await newRankedBase({ trophies: 150, keepLevel: 4 });
    await seedRatedAttacks(ranked, monday0);
    await closeWeek(monday0, {
      enabled: false, startWeek: week0,
    });
    await runWeeklyLeagueReset(db, monday0, {
      enabled: false, startWeek: week0,
    });
    await runWeeklyLeagueReset(db, monday0, {
      enabled: true, startWeek: week1,
    });
    expect(await receipt(week0, ranked.baseId)).toBeUndefined();

    await seedRatedAttacks(ranked, monday1);
    await closeWeek(monday1, {
      enabled: true, startWeek: week1,
    });
    await runWeeklyLeagueReset(db, monday1, {
      enabled: true, startWeek: week1,
    });
    expect(await receipt(week1, ranked.baseId)).toBeUndefined();

    await seedRatedAttacks(ranked, monday2);
    await closeWeek(monday2, {
      enabled: true, startWeek: week1,
    });
    await runWeeklyLeagueReset(db, monday2, {
      enabled: true, startWeek: week1,
    });
    expect((await receipt(week2, ranked.baseId))!.paidAt).not.toBeNull();
  });

  it('returns cumulative participation/candidate state and no KEEP or pool fields', async () => {
    const at = await unusedSettlement();
    const ranked = await newRankedBase({ trophies: 55, keepLevel: 8, name: 'Ranked fixture' });
    await seedRatedAttacks(ranked, at);
    await closeWeek(at);
    await runWeeklyLeagueReset(db, at, POLICY);
    // The overview is for the following earning week; seed its three attacks.
    const currentStart = new Date(at.getTime() + 7 * DAY_MS - 15 * 60_000);
    const defender = await victimBase();
    for (let i = 0; i < 3; i += 1) {
      await insertRaid({
        attacker: ranked, defender,
        resolvedAt: new Date(currentStart.getTime() + (i + 1) * 60_000),
      });
    }
    const now = new Date(at.getTime() + 7 * DAY_MS + 60 * 60_000);
    await closeLeagueWeek(
      db, closedWindow(new Date(at.getTime() + 7 * DAY_MS)).closesAt,
      POLICY, closeAuthority(),
    );
    const overview = await getLeagueOverview(db, ranked.wallet, ranked.baseId, POLICY, now);
    expect(overview).toMatchObject({
      trophyModel: 'cumulative',
      rewards: { status: 'active', minRatedAttacks: 3, maxRewardedBasesPerWallet: 1 },
      you: {
        baseId: ranked.baseId, trophies: 55, tier: 'gold',
        currentWeekRatedAttacks: 3, participationMet: true, rewardCandidate: true,
      },
      lastSettlement: { tier: 'gold', trophies: 55, keepLevel: 8 },
    });
    const dto = overview as unknown as Record<string, unknown>;
    expect(dto).not.toHaveProperty('pool');
    expect(dto).not.toHaveProperty('keepAmount');
    expect(overview.rewards).not.toHaveProperty('pool');
    expect(overview.lastSettlement).not.toHaveProperty('keepAmount');

    process.env['MULTI_BASE_ENABLED'] = 'false';
    const dark = await getLeagueOverview(db, ranked.wallet, ranked.baseId, POLICY, now);
    expect(dark.rewards.status).toBe('disabled');
    process.env['MULTI_BASE_ENABLED'] = 'true';
  });
});

describe('GET /leagues route', () => {
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    // Route authentication is independent of the observer startup audit. The
    // service tests above cover deed eligibility; do not fabricate chain
    // observations merely to mount Fastify here.
    process.env['MULTI_BASE_ENABLED'] = 'false';
    app = await buildApp({
      ...TEST_CONFIG,
      LEAGUE_REWARDS_ENABLED: 'true',
      LEAGUE_REWARD_START_WEEK: LEAGUES.rewardStartWeek,
    }, db);
  });
  afterAll(async () => {
    await app?.close();
    process.env['MULTI_BASE_ENABLED'] = 'true';
  });

  it('is authenticated and returns the shared DTO contract', async () => {
    expect((await app!.inject({ method: 'GET', url: '/leagues' })).statusCode).toBe(401);
    const secretKey = utils.randomSecretKey();
    const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
    const challenge = await app!.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    const message = (challenge.json() as { message: string }).message;
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
    const verified = await app!.inject({
      method: 'POST', url: '/auth/verify', payload: { wallet, signature },
    });
    const cookie = verified.cookies.find(({ name }) => name === SESSION_COOKIE)!.value;
    const response = await app!.inject({
      method: 'GET', url: '/leagues', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ trophyModel: 'cumulative' });
  });
});
