/**
 * Public playtest statistics (D-103, M35 lane B): every number is SQL over
 * the authoritative tables under ONE exclusion predicate (internal wallets,
 * admin-hidden wallets, zero-session players), split Solana Mobile vs browser,
 * snapshotted by the worker and served to the landing origin uncredentialed.
 *
 * The suite shares one database with every other file in the run, so the
 * fixture assertions are DELTAS between a compute before and after seeding —
 * absolute counts would depend on which suites ran first.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYTEST_CAMPAIGN, PLAYTEST_STATS } from '@shardkeep/shared';
import { buildApp, LANDING_READ_PATHS } from '../src/app';
import {
  bases, builderJobs, buildings, deposits, devnetFaucetGrants, itemListings, players, playtestStatsSnapshots,
  raids, sessions, testerBoardHidden, testerDailyPoints, testerFeedback, testerMilestones, tutorialProgress,
  withdrawals,
} from '../src/db/schema';
import {
  campaignWindow, computeFoundingCampaignStats, computePlaytestStats, lamportsToSol, latestPlaytestStats, writePlaytestStatsSnapshot,
  type PlaytestCohort, type PlaytestStats,
} from '../src/game/playtestStats';
import { PLAYTEST_PUBLIC_PATHS } from '../src/routes-stats';
import { CAMPAIGN_PUBLIC_PATHS } from '../src/routes-playtest-campaigns';
import { TESTER_PUBLIC_PATHS } from '../src/routes-tester';
import { TEST_CONFIG, connectTestDb, fundTestKeep, randomWallet } from './helpers';

/** Fixed clock: every fixture timestamp is relative to it, so windows are exact. */
const NOW = new Date('2026-09-10T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000);
const CAMPAIGN_START = '2026-09-08T00:00:00Z';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;
let config: typeof TEST_CONFIG;
let before: PlaytestStats;
let after: PlaytestStats;

// Cohort fixtures. Names say which bucket the predicate must put them in.
const mobileA = randomWallet();   // seeker_verified, the busiest tester
const mobileB = randomWallet();   // first_client = 'solana-mobile', legacy entry_paid_at land
const browserC = randomWallet();  // first_client = 'browser', forge + mine upgrade + market sale
const browserD = randomWallet();  // first_client null, no base
const internalE = randomWallet(); // ADMIN_WALLETS — excluded everywhere
const hiddenF = randomWallet();   // tester_board_hidden — excluded everywhere
const ghostG = randomWallet();    // zero sessions — excluded everywhere

const cents = (sol: string | undefined): number => Math.round(Number(sol ?? '0') * 100);
const cohortDelta = (key: keyof PlaytestStats['cohorts']): PlaytestCohort => {
  const out = {} as PlaytestCohort;
  for (const k of Object.keys(after.cohorts[key]) as Array<keyof PlaytestCohort>) {
    out[k] = after.cohorts[key][k] - before.cohorts[key][k];
  }
  return out;
};

beforeAll(async () => {
  conn = connectTestDb();
  config = { ...TEST_CONFIG, ADMIN_WALLETS: [internalE], CAMPAIGN_START_AT: CAMPAIGN_START };
  app = await buildApp(config, conn.db);
  const db = conn.db;
  before = await computePlaytestStats(db, config, NOW);

  await db.insert(players).values([
    { wallet: mobileA, seekerVerified: true, createdAt: ago(20), lastSeenAt: ago(0, 1) },
    { wallet: mobileB, firstClient: 'solana-mobile', createdAt: ago(1), lastSeenAt: null, entryPaidAt: ago(1) },
    { wallet: browserC, firstClient: 'browser', createdAt: ago(20), lastSeenAt: ago(10), keepLevel: 1 },
    { wallet: browserD, createdAt: ago(2), lastSeenAt: ago(1), keepLevel: 3 },
    { wallet: internalE, createdAt: ago(30), lastSeenAt: ago(0, 1) },
    { wallet: hiddenF, createdAt: ago(30), lastSeenAt: ago(0, 1) },
    { wallet: ghostG, createdAt: ago(30), lastSeenAt: ago(0, 1) },
  ]);
  await db.insert(sessions).values([mobileA, mobileB, browserC, browserD, internalE, hiddenF]
    .map((wallet) => ({ wallet, expiresAt: ago(-1) })));
  await db.insert(testerBoardHidden).values({ wallet: hiddenF, hiddenBy: internalE, reason: 'fixture' });

  const baseA = randomUUID();
  const baseC = randomUUID();
  const baseE = randomUUID();
  await db.insert(bases).values([
    { id: baseA, ownerWallet: mobileA, status: 'active', keepLevel: 5, landPaidAt: ago(15), deedAssetId: `deed-${baseA}` },
    { id: baseC, ownerWallet: browserC, status: 'active', keepLevel: 1 },
    { id: baseE, ownerWallet: internalE, status: 'active', keepLevel: 10, landPaidAt: ago(15), deedAssetId: `deed-${baseE}` },
    { id: randomUUID(), ownerWallet: hiddenF, status: 'active', keepLevel: 7 },
    { id: randomUUID(), ownerWallet: ghostG, status: 'active', keepLevel: 20 },
  ]);
  await db.insert(tutorialProgress).values({ playerWallet: mobileA, step: 9, completedAt: ago(19) });

  const mineC = randomUUID();
  const mineC2 = randomUUID();
  const barracksA = randomUUID();
  const mineE = randomUUID();
  await db.insert(buildings).values([
    { id: mineC, playerWallet: browserC, baseId: baseC, type: 'mine', level: 2, tx: 6, ty: 8 },
    { id: mineC2, playerWallet: browserC, baseId: baseC, type: 'mine', level: 1, tx: 7, ty: 8 },
    { playerWallet: browserC, baseId: baseC, type: 'goldforge', level: 1, tx: 9, ty: 9 },
    { id: barracksA, playerWallet: mobileA, baseId: baseA, type: 'barracks', level: 2, tx: 11, ty: 12 },
    { id: mineE, playerWallet: internalE, baseId: baseE, type: 'mine', level: 2, tx: 6, ty: 8 },
  ]);
  await db.insert(builderJobs).values([
    { playerWallet: browserC, baseId: baseC, kind: 'upgrade', buildingId: mineC, finishesAt: ago(5), completedAt: ago(5) },
    { playerWallet: browserC, baseId: baseC, kind: 'upgrade', buildingId: mineC2, finishesAt: ago(-1) },
    { playerWallet: mobileA, baseId: baseA, kind: 'upgrade', buildingId: barracksA, finishesAt: ago(5), completedAt: ago(5) },
    { playerWallet: internalE, baseId: baseE, kind: 'upgrade', buildingId: mineE, finishesAt: ago(5), completedAt: ago(5) },
  ]);

  const raid = (attacker: string, defender: string | null, status: 'resolved' | 'pending_orders', resolvedAt: Date | null) => ({
    attackerWallet: attacker, defenderWallet: defender, status, resolvedAt,
    seed: 1n, snapshot: {}, armySnapshot: {}, ordersDeadlineAt: ago(-1),
  });
  await db.insert(raids).values([
    raid(mobileA, browserC, 'resolved', ago(1)),
    raid(mobileA, null, 'resolved', ago(20)),
    raid(internalE, browserC, 'resolved', ago(0, 1)),
    raid(mobileA, browserC, 'pending_orders', null),
    raid(ghostG, browserC, 'resolved', ago(0, 1)),
  ]);

  await db.insert(deposits).values([
    { playerWallet: mobileA, kind: 'entry', reference: `ref-${randomUUID()}`, status: 'credited', amount: 200_000_000n },
    { playerWallet: mobileA, kind: 'deed', reference: `ref-${randomUUID()}`, status: 'credited', amount: 200_000_000n },
    { playerWallet: browserC, kind: 'mine_build', reference: `ref-${randomUUID()}`, status: 'credited', amount: 50_000_000n },
    { playerWallet: mobileB, kind: 'keep_deposit', reference: `ref-${randomUUID()}`, status: 'credited', amount: 5_000_000_000n },
    { playerWallet: mobileA, kind: 'shield', reference: `ref-${randomUUID()}`, status: 'pending', amount: 30_000_000n },
    { playerWallet: internalE, kind: 'entry', reference: `ref-${randomUUID()}`, status: 'credited', amount: 200_000_000n },
  ]);
  await db.insert(devnetFaucetGrants).values([
    { wallet: mobileA, lamports: 500_000_000n, status: 'sent', sentAt: ago(15) },
    { wallet: browserC, lamports: 500_000_000n, status: 'requested' },
    { wallet: internalE, lamports: 500_000_000n, status: 'sent', sentAt: ago(15) },
  ]);
  await db.insert(withdrawals).values([
    { playerWallet: mobileA, currency: 'KEEP', amount: 100n, destination: mobileA, status: 'sent', unbondsAt: ago(3), completedAt: ago(2) },
    { playerWallet: browserC, currency: 'KEEP', amount: 100n, destination: browserC, status: 'unbonding', unbondsAt: ago(-3) },
  ]);
  await db.insert(itemListings).values([
    { sellerWallet: browserC, idempotencyKey: randomUUID(), itemId: 'shield_1d', priceLamports: 10_000_000n, status: 'sold', buyerWallet: mobileA, settledAt: ago(2) },
    { sellerWallet: mobileA, idempotencyKey: randomUUID(), itemId: 'shield_1d', priceLamports: 10_000_000n, status: 'active' },
  ]);

  await db.insert(testerFeedback).values([
    { wallet: mobileA, category: 'bug', title: 'a', body: 'a'.repeat(30), status: 'new', points: 5 },
    { wallet: browserC, category: 'bug', title: 'b', body: 'b'.repeat(30), status: 'accepted', points: 10 },
    { wallet: mobileB, category: 'bug', title: 'c', body: 'c'.repeat(30), status: 'fixed', points: 10, fixedAt: ago(1), fixedRef: 'abc1234' },
    { wallet: internalE, category: 'bug', title: 'd', body: 'd'.repeat(30), status: 'fixed', points: 10, fixedAt: ago(1) },
  ]);
  await db.insert(testerMilestones).values([
    { wallet: mobileA, key: 'base_founded', points: 10, source: 'derived' },
    { wallet: mobileA, key: 'tutorial_done', points: 5, source: 'derived' },
    { wallet: browserC, key: 'base_founded', points: 10, source: 'derived' },
    { wallet: browserC, key: 'mine_upgraded', points: 10, source: 'derived' },
    { wallet: hiddenF, key: 'base_founded', points: 10, source: 'derived' },
    { wallet: hiddenF, key: 'tutorial_done', points: 5, source: 'derived' },
    { wallet: internalE, key: 'base_founded', points: 10, source: 'derived' },
    { wallet: internalE, key: 'tutorial_done', points: 5, source: 'derived' },
  ]);
  await db.insert(testerDailyPoints).values([
    { wallet: mobileA, day: '2026-09-10', key: 'played', count: 1, points: 2 },
    { wallet: browserC, day: '2026-09-09', key: 'played', count: 1, points: 2 },
    { wallet: ghostG, day: '2026-09-10', key: 'played', count: 1, points: 2 },
  ]);

  // Mining / Gold Forge participation: mobileA collects twice and deploys once,
  // browserC collects once, the internal wallet collects (excluded). A wallet
  // counts once per bucket however many rows it has.
  await fundTestKeep(db, mobileA, 1n, 'mine.collect', `stats:mine:${randomUUID()}`);
  await fundTestKeep(db, mobileA, 1n, 'mine.collect', `stats:mine:${randomUUID()}`);
  await fundTestKeep(db, mobileA, 1n, 'forge.contribute', `stats:forge:${randomUUID()}`);
  await fundTestKeep(db, browserC, 1n, 'mine.collect', `stats:mine:${randomUUID()}`);
  await fundTestKeep(db, internalE, 1n, 'mine.collect', `stats:mine:${randomUUID()}`);
  after = await computePlaytestStats(db, config, NOW);
});
afterAll(async () => {
  await app.close();
  try {
    // The faucet worker intentionally sweeps ALL requested grants. Leaving our
    // synthetic pending row behind makes a later faucet suite send two grants
    // and changes its treasury/cooldown assertions according to file order.
    await conn.db.delete(devnetFaucetGrants)
      .where(inArray(devnetFaucetGrants.wallet, [mobileA, browserC, internalE]));
  } finally { await conn.sql.end(); }
});

describe.sequential('playtest statistics', () => {
  it('splits cohorts by seeker_verified OR first_client and sums them into total', () => {
    // WHY: the owner reads Solana Mobile onboarding against browser onboarding;
    // a Seeker-verified player and one whose first sign-in came from the
    // installed shell must land in the same bucket, everyone else in browser.
    const mobile = cohortDelta('solanaMobile');
    const browser = cohortDelta('browser');
    const total = cohortDelta('total');
    expect(mobile).toEqual({
      players: 2, onboarded: 1, tutorialDone: 1, landOwners: 2, forgeBuilt: 0, firstRaid: 1, firstPvp: 1,
      active7d: 1, active30d: 1, returnedAfter7d: 1, activeToday: 1,
    });
    expect(browser).toEqual({
      players: 2, onboarded: 1, tutorialDone: 0, landOwners: 0, forgeBuilt: 1, firstRaid: 0, firstPvp: 0,
      active7d: 1, active30d: 2, returnedAfter7d: 1, activeToday: 0,
    });
    for (const k of Object.keys(total) as Array<keyof PlaytestCohort>) {
      expect(total[k]).toBe(mobile[k] + browser[k]);
    }
  });

  it('excludes internal, admin-hidden and zero-session players from every number', () => {
    // WHY: the page is public and the numbers must be about real testers —
    // the owner's own wallets, a hidden abuser and the scripted cohort that
    // never signed in would otherwise inflate every funnel step.
    // internalE and hiddenF are level 10/7 land owners with deeds and raids;
    // ghostG is a level-20 Keep with a raid and a daily row. None appear.
    expect(cohortDelta('total').players).toBe(4);
    expect(after.activity.deedsMinted - before.activity.deedsMinted).toBe(1);
    expect(after.activity.battlesResolved - before.activity.battlesResolved).toBe(2);
    expect(after.activity.keepLevels[9]).toBe(before.activity.keepLevels[9]);   // L10 internal
    expect(after.activity.keepLevels[6]).toBe(before.activity.keepLevels[6]);   // L7 hidden
    expect(after.activity.keepLevels[19]).toBe(before.activity.keepLevels[19]); // L20 ghost
    expect(after.points.awardedToday - before.points.awardedToday).toBe(2);       // ghost's row ignored
  });

  it('counts money from every wallet, the internal one included', () => {
    // WHY: owner 2026-09-04, "I want real metrics" — a credited deposit is SOL
    // the treasuries received, verified on-chain by signature, whoever sent it.
    // The funnels above exclude the team; the money figures must not, or the
    // page under-reports what actually moved (internalE's entry is real SOL).
    expect(cents(after.money.solSpentByKind['land']) - cents(before.money.solSpentByKind['land'])).toBe(60);
    expect((after.money.solSpentCountByKind['land'] ?? 0) - (before.money.solSpentCountByKind['land'] ?? 0)).toBe(3);
    expect(cents(after.money.faucetSolGranted) - cents(before.money.faucetSolGranted)).toBe(100);
  });

  it('counts activity over resolved raids, completed mine upgrades and settled ledgers', () => {
    // WHY: pending raids, unfinished builds, unbonding withdrawals and open
    // listings are intent, not activity; only settled rows are public facts.
    const d = (k: keyof PlaytestStats['activity']) =>
      (after.activity[k] as number) - (before.activity[k] as number);
    expect(d('battlesResolved')).toBe(2);
    expect(d('pvpBattles')).toBe(1);
    expect(d('pveBattles')).toBe(1);
    expect(d('battlesLast7d')).toBe(1);
    expect(d('mineUpgrades')).toBe(1);
    expect(d('depositsCredited')).toBe(4); // entry + deed + mine_build + keep_deposit; the pending shield is intent
    expect(d('withdrawalsSent')).toBe(1);
    expect(d('marketTrades')).toBe(1);
  });

  it('counts miners and Forge workers by distinct eligible wallet, and their rows over the whole playtest', () => {
    // WHY: the owner asked the numbers page to show "how much people build gold
    // forge and participating in mining" — a person, not a mine: a wallet with
    // two collections is one miner; the internal wallet's collection is not
    // a player's.
    const d = (k: keyof PlaytestStats['mining']) => after.mining[k] - before.mining[k];
    expect(d('miners7d')).toBe(2);
    expect(d('minersTotal')).toBe(2);
    expect(d('forgeWorkers7d')).toBe(1);
    expect(d('forgeWorkersTotal')).toBe(1);
    expect(d('mineCollections')).toBe(3);
    expect(d('forgeDeployments')).toBe(1);
    expect(after.mining.forgesBuilt).toBe(after.cohorts.total.forgeBuilt);
  });

  it('builds a 20-bucket Keep-level histogram over onboarded eligible players', () => {
    // WHY: the landing's keep-goal rail reads this; one bucket per founded
    // Keep at its current level, so the buckets always sum to `onboarded`.
    expect(after.activity.keepLevels).toHaveLength(PLAYTEST_STATS.keepLevels);
    expect(after.activity.keepLevels[0]! - before.activity.keepLevels[0]!).toBe(1); // browserC L1
    expect(after.activity.keepLevels[4]! - before.activity.keepLevels[4]!).toBe(1); // mobileA L5
    expect(after.activity.keepLevels.reduce((s, n) => s + n, 0)).toBe(after.cohorts.total.onboarded);
  });

  it('sums SOL by deposit kind as two-decimal strings and never mixes KEEP deposits in', () => {
    // WHY: `deposits.amount` is lamports for SOL kinds but KEEP base units for
    // keep_deposit — adding them would print a 5-SOL purchase that never was.
    // WHY `land`: mobileA's first deed is an `entry` row and the second a `deed`
    // row; published apart, the owner read "Deed 1.80 SOL" as almost nobody
    // buying land (2026-09-04). One line, with the purchase count behind it.
    expect(cents(after.money.solSpentByKind['land']) - cents(before.money.solSpentByKind['land'])).toBe(60);
    expect((after.money.solSpentCountByKind['land'] ?? 0) - (before.money.solSpentCountByKind['land'] ?? 0)).toBe(3);
    expect(after.money.solSpentByKind).not.toHaveProperty('entry');
    expect(after.money.solSpentByKind).not.toHaveProperty('deed');
    expect(cents(after.money.solSpentByKind['mine_build']) - cents(before.money.solSpentByKind['mine_build'])).toBe(5);
    expect((after.money.solSpentCountByKind['mine_build'] ?? 0) - (before.money.solSpentCountByKind['mine_build'] ?? 0)).toBe(1);
    expect(cents(after.money.solSpentTotal) - cents(before.money.solSpentTotal)).toBe(65);
    expect(after.money.solSpentByKind).not.toHaveProperty('keep_deposit');
    expect(after.money.solSpentCountByKind).not.toHaveProperty('keep_deposit');
    expect(after.money.solSpentByKind['land']).toMatch(/^\d+\.\d{2}$/);
    expect(lamportsToSol(0n)).toBe('0.00');
    expect(lamportsToSol(200_000_000n)).toBe('0.20');
    expect(lamportsToSol(1_005_000_000n)).toBe('1.01');
    expect(lamportsToSol(1_004_999_999n)).toBe('1.00');
    expect(lamportsToSol(123_456_789_012n)).toBe('123.46');
  });

  it('derives feedback received / accepted / fixed from the status column', () => {
    // WHY: "issues fixed from tester feedback" is a public promise; it must be
    // the admin's `fixed` status, and an accepted report stays counted once fixed.
    expect(after.feedback.received - before.feedback.received).toBe(3);
    expect(after.feedback.accepted - before.feedback.accepted).toBe(2);
    expect(after.feedback.fixed - before.feedback.fixed).toBe(1);
  });

  it('sums all three point ledgers and counts board-listed testers by the board rule', () => {
    // WHY: the public total must match what the board pays out (milestones +
    // feedback + daily), and "testers listed" must follow TESTER_PROGRAM.board
    // so the number equals the rows a visitor can actually see.
    expect(after.points.total - before.points.total).toBe(15 + 20 + 25 + 4);
    expect(after.points.awardedToday - before.points.awardedToday).toBe(2);
    expect(after.points.testersListed - before.points.testersListed).toBe(2);
  });

  it('uses the campaign definition and ignores the retired presentation-only start env', () => {
    // D-118: an old environment variable must never launch a prize campaign.
    expect(after.campaign).toEqual(before.campaign);
    expect(campaignWindow(undefined, NOW)).toEqual({ startAt: null, endAt: null, dayIndex: null });
    expect(campaignWindow(CAMPAIGN_START, new Date('2026-09-07T23:59:59Z')).dayIndex).toBeNull();
    expect(campaignWindow(CAMPAIGN_START, new Date('2026-09-08T00:00:00Z')).dayIndex).toBe(1);
    expect(campaignWindow(CAMPAIGN_START, new Date('2026-09-21T23:59:59Z')).dayIndex).toBe(14);
    expect(campaignWindow(CAMPAIGN_START, new Date('2026-09-22T00:00:00Z')).dayIndex).toBeNull();
    expect(campaignWindow('not-a-date', NOW)).toEqual({ startAt: null, endAt: null, dayIndex: null });
  });

  it('pauses the verified original-minter checkpoint at 50 until the admin schedule starts', async () => {
    const rollback = new Error('rollback campaign fixture');
    await expect(conn.db.transaction(async tx => {
      await tx.execute(sql`insert into playtest_campaigns(id,kind) values('founding-kingdoms','founding')
        on conflict(id) do update set start_at=null,end_at=null,snapshot_at=null`);
      for (let i=0;i<51;i++) {
        const wallet = randomWallet(); const asset = randomUUID();
        await tx.insert(players).values({wallet});
        await tx.insert(sessions).values({wallet,expiresAt:NOW});
        await tx.insert(bases).values({ownerWallet:wallet,deedAssetId:asset,landPaidAt:NOW});
        await tx.execute(sql`insert into playtest_mint_evidence(asset_id,original_wallet,confirmed_at,slot,transaction_index,signature,verified_at)
          values(${asset},${wallet},'2030-01-01','1',${i},${randomUUID()},'2030-01-01')`);
      }
      // Cover unrelated synthetic deeds before asserting a complete checkpoint.
      await tx.execute(sql`insert into playtest_mint_evidence(asset_id,original_wallet,confirmed_at,slot,transaction_index,signature,verified_at)
        select asset,'stats-unrelated-fixture','2030-01-01','1',100,'known-proof','2030-01-01' from (
          select deed_asset_id as asset from bases union select deed_asset_id from players union select deed_asset_id from base_transfers
        ) known where asset is not null and not exists(select 1 from playtest_mint_evidence m where m.asset_id=known.asset)`);
      // Only a completed inventory can publish provisional original-minter places.
      await tx.execute(sql`insert into playtest_mint_inventory(id,through_slot,asset_count,completed_at)
        values('land-deeds','1',(select count(*) from playtest_mint_evidence where verified_at is not null and slot::numeric<=1),${NOW.toISOString()}::timestamptz)
        on conflict(id) do update set through_slot=excluded.through_slot,asset_count=excluded.asset_count,completed_at=excluded.completed_at`);
      const waiting=await computeFoundingCampaignStats(tx,NOW);
      expect(waiting).toMatchObject({startAt:null,checkpointCount:50,checkpointAvailable:true,founderSpots:50,rankedSpots:250,snapshotComplete:false});
      await tx.execute(sql`update playtest_campaigns set start_at='2026-09-09T12:00:00Z',end_at='2026-09-23T12:00:00Z',cancelled_at=null where id='founding-kingdoms'`);
      const launched=await computeFoundingCampaignStats(tx,NOW);
      expect(launched).toMatchObject({startAt:'2026-09-09T12:00:00.000Z',endAt:'2026-09-23T12:00:00.000Z',dayIndex:2});
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it('answers 503 no_snapshot before the first snapshot, then serves the latest with a public cache', async () => {
    // WHY: the API must never compute this on request (a full-table pass), so
    // before the worker's first run the page shows "not yet" rather than a
    // stale or invented number; a 503 must not be cached past the first run.
    await conn.db.delete(playtestStatsSnapshots);
    const none = await app.inject({ method: 'GET', url: '/playtest/stats' });
    expect(none.statusCode).toBe(503);
    expect(none.json()).toEqual({ error: 'no_snapshot' });
    expect(none.headers['cache-control']).toBe('no-store');
    expect(await latestPlaytestStats(conn.db)).toBeNull();

    // A stale row past retention is trimmed by the next write.
    const stale = new Date(NOW.getTime() - (PLAYTEST_STATS.retentionDays + 1) * DAY);
    await conn.db.insert(playtestStatsSnapshots).values({ computedAt: stale, payload: { stale: true } });
    const written = await writePlaytestStatsSnapshot(conn.db, config, NOW);
    const rows = await conn.db.select({ computedAt: playtestStatsSnapshots.computedAt }).from(playtestStatsSnapshots);
    expect(rows.map((r) => r.computedAt.toISOString())).toEqual([NOW.toISOString()]);
    // Same instant again: idempotent, no primary-key crash.
    await writePlaytestStatsSnapshot(conn.db, config, NOW);

    const res = await app.inject({ method: 'GET', url: '/playtest/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(`public, max-age=${PLAYTEST_STATS.publicCacheSec}`);
    const body = res.json() as PlaytestStats;
    expect(body.computedAt).toBe(NOW.toISOString());
    expect(body.cohorts.total.players).toBe(written.cohorts.total.players);
    expect(body.money.solSpentByKind).toEqual(written.money.solSpentByKind);
    expect(Object.keys(body).sort()).toEqual(['activity', 'campaign', 'cohorts', 'computedAt', 'definitions', 'engagement', 'feedback', 'freshness', 'mining', 'money', 'points', 'stale']);
  });

  it('opens exactly /playtest/stats to the landing origin, uncredentialed, next to the tester GETs', async () => {
    // WHY: the landing site is never in WEB_ORIGIN (a compromised Pages deploy
    // must not make cookie-authed calls); the allowlist is pinned so a future
    // route cannot be opened by accident.
    expect([...LANDING_READ_PATHS]).toEqual([...TESTER_PUBLIC_PATHS, ...PLAYTEST_PUBLIC_PATHS, ...CAMPAIGN_PUBLIC_PATHS, '/playtest/access']);
    expect([...PLAYTEST_PUBLIC_PATHS]).toEqual(['/playtest/stats']);
    const origin = TEST_CONFIG.LANDING_ORIGINS[0]!;
    const res = await app.inject({ method: 'GET', url: '/playtest/stats', headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(String(res.headers['access-control-allow-credentials'] ?? '')).not.toBe('true');
    const preflight = await app.inject({ method: 'OPTIONS', url: '/playtest/stats', headers: { origin, 'access-control-request-method': 'GET' } });
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(String(preflight.headers['access-control-allow-credentials'] ?? '')).not.toBe('true');
    // Any other route stays closed to the landing origin.
    const other = await app.inject({ method: 'GET', url: '/version', headers: { origin } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    // The game origin keeps its normal credentialed access to this route too.
    const web = await app.inject({ method: 'GET', url: '/playtest/stats', headers: { origin: TEST_CONFIG.WEB_ORIGIN[0]! } });
    expect(web.headers['access-control-allow-origin']).toBe(TEST_CONFIG.WEB_ORIGIN[0]);
  });

  it('never reads a wallet-level fact from a client claim: first_client is a tag, not verification', () => {
    // WHY: `first_client = 'solana-mobile'` only moves a player between two
    // public buckets; it must not be mistaken for Seeker verification anywhere.
    return conn.db.select({ v: players.seekerVerified }).from(players).where(eq(players.wallet, mobileB))
      .then(([row]) => expect(row?.v).toBe(false));
  });
});
