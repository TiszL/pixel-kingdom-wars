/** Original-minter qualification uses durable game proof, while internal
 * exclusion applies consistently without deleting lifetime progress. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { PLAYTEST_COMPETITIONS as RULES, TESTER_PROGRAM } from '@shardkeep/shared';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';
import { accounts, bases, players, sessions, testerBoardHidden, testerMilestones } from '../src/db/schema';
import { playtestInternalWallets as internal, playtestMintEvidence as mints, playtestCampaignScores as scores, playtestMintInventory as inventory } from '../src/db/playtestCampaignSchema';
import { playerActivityDays, playerActionEvents } from '../src/db/playtestActivitySchema';
import { foundingMintCandidates } from '../src/game/playtestEligibility';
import { computeFoundingCampaignStats, computePlaytestStats } from '../src/game/playtestStats';
import { campaignState, ensurePlaytestCampaigns, mintVerificationStatus, participateInCampaign } from '../src/game/playtestCampaigns';
import { shortWallet, testerLeaderboard, testerProgress } from '../src/game/tester';

const conn = connectTestDb(); const db = conn.db;
const now = new Date('2040-01-01T12:00:00Z');
const old = new Date('2026-01-01T00:00:00Z');
const owned: string[] = [];
const coveredFixtureAssets: string[] = [];
let previousInventory: typeof inventory.$inferSelect | undefined;
beforeAll(async () => {
  [previousInventory] = await db.select().from(inventory).where(eq(inventory.id, 'land-deeds'));
  await db.insert(inventory).values({ id: 'land-deeds', throughSlot: '123', assetCount: 0, completedAt: old })
    .onConflictDoUpdate({ target: inventory.id, set: { throughSlot: '123' } });
});
afterAll(async () => {
  if (owned.length) {
    await db.delete(scores).where(inArray(scores.wallet, owned));
    await db.delete(mints).where(inArray(mints.originalWallet, owned));
    if (coveredFixtureAssets.length) await db.delete(mints).where(inArray(mints.assetId, coveredFixtureAssets));
    await db.delete(internal).where(inArray(internal.wallet, owned));
    await db.delete(testerBoardHidden).where(inArray(testerBoardHidden.wallet, owned));
    await db.delete(testerMilestones).where(inArray(testerMilestones.wallet, owned));
    await db.delete(sessions).where(inArray(sessions.wallet, owned));
    // Base deletion emits immutable eligibility evidence; delete captured fixture
    // events afterwards so no player FK or synthetic activity survives the suite.
    await db.delete(bases).where(inArray(bases.ownerWallet, owned));
    await db.delete(playerActionEvents).where(inArray(playerActionEvents.wallet, owned));
    await db.delete(playerActivityDays).where(inArray(playerActivityDays.wallet, owned));
    await db.delete(accounts).where(inArray(accounts.ownerWallet, owned));
    await db.delete(players).where(inArray(players.wallet, owned));
  }
  await db.delete(inventory).where(eq(inventory.id, 'land-deeds'));
  if (previousInventory) await db.insert(inventory).values(previousInventory);
  await conn.sql.end();
});
// Other sequential suites may leave deed fixtures. A completed inventory must
// cover those too; unrelated proof-only owners cannot become game candidates.
async function completeInventory(throughSlot: string) {
  const added = await db.execute(sql`insert into playtest_mint_evidence(asset_id,original_wallet,confirmed_at,slot,transaction_index,signature,verified_at)
    select asset,'eligibility-unrelated-fixture','2026-01-01','2',0,'fixture-proof','2026-01-01' from (
      select deed_asset_id as asset from bases union select deed_asset_id from players union select deed_asset_id from base_transfers
    ) known where asset is not null and not exists(select 1 from playtest_mint_evidence m where m.asset_id=known.asset)
    returning asset_id`);
  coveredFixtureAssets.push(...added.map(row => String(row['asset_id'])));
  await db.execute(sql`insert into playtest_mint_inventory(id,through_slot,asset_count,completed_at)
    values('land-deeds',${throughSlot},(select count(*) from playtest_mint_evidence where verified_at is not null and slot::numeric<=${throughSlot}::numeric),${now.toISOString()}::timestamptz)
    on conflict(id) do update set through_slot=excluded.through_slot,asset_count=excluded.asset_count,completed_at=excluded.completed_at`);
}
async function player() { const p = await createTestPlayer(db); owned.push(p.wallet); return p.wallet; }
async function proof(wallet: string, gameLinked = true, fullSession = true, owner = wallet) {
  const assetId = randomUUID();
  if (fullSession) await db.insert(sessions).values({ wallet, scope: 'full', expiresAt: old, revokedAt: old });
  if (gameLinked) await db.insert(bases).values({ ownerWallet: owner, deedAssetId: assetId, landPaidAt: old });
  await db.insert(mints).values({ assetId, originalWallet: wallet, confirmedAt: old,
    slot: '123', transactionIndex: owned.indexOf(wallet), signature: randomUUID(), verifiedAt: old });
  return assetId;
}

it('keeps sold and legacy-paid authentic originals, excluding unregistered/unsigned/collection-only/internal wallets', async () => {
  await ensurePlaytestCampaigns(db);
  const [legacy, seller, buyer, hidden, unsigned, pending, collectionOnly, team, configured] = await Promise.all(Array.from({ length: 9 }, player));
  await db.update(players).set({ entryPaidAt: old }).where(eq(players.wallet, legacy!));
  await proof(legacy!); // No credited deposit row: genuine pre-ledger history.
  await proof(seller!, true, true, buyer!); // Sale must retain ORIGINAL minter rights.
  await proof(hidden!);
  await db.insert(testerBoardHidden).values({ wallet: hidden!, hiddenBy: 'display-only-fixture' });
  await proof(unsigned!, true, false);
  await proof(pending!, true, false);
  await db.insert(sessions).values({ wallet: pending!, scope: 'login_pending', expiresAt: now });
  await proof(collectionOnly!, false);
  await proof(team!); await proof(configured!);
  await db.insert(internal).values({ wallet: team!, reason: 'owner-confirmed team', recordedBy: 'test', evidence: {} });
  const absentWallet = randomUUID(); owned.push(absentWallet);
  await db.insert(mints).values({ assetId: randomUUID(), originalWallet: absentWallet,
    slot: '1', transactionIndex: 0, signature: 'collection-only', confirmedAt: old, verifiedAt: old });

  await completeInventory('123');
  const eligible = await foundingMintCandidates(db, [configured!]);
  const ours = eligible.filter(m => owned.includes(m.originalWallet!)).map(m => m.originalWallet).sort();
  expect(ours).toEqual([legacy, seller, hidden].sort());
  // The checkpoint, admin verification and public provisional list use the
  // same predicate. Display hiding must not quietly revoke a founder's right.
  const verification = await mintVerificationStatus(db, [configured!], now);
  const stats = await computeFoundingCampaignStats(db, now, [configured!]);
  const state = await campaignState(db, RULES.foundingId, undefined, now, false, [configured!]);
  expect(stats.checkpointCount).toBe(Math.min(RULES.founderSpots, eligible.length));
  expect(verification).toMatchObject({ complete: true, verifiedUniqueWallets: eligible.length });
  expect(stats.checkpointAvailable).toBe(true);
  expect(state.checkpoint).toMatchObject({ count: stats.checkpointCount, frozen: false });
  expect(state.founders.map(f => f.wallet)).toEqual(expect.arrayContaining([shortWallet(legacy!), shortWallet(seller!)]));
  expect(state.founders.map(f => f.wallet)).not.toContain(shortWallet(hidden!));
  expect(state.founders.map(f => f.wallet)).not.toContain(shortWallet(team!));
  await db.update(players).set({ name: 'Renamed team member' }).where(eq(players.wallet, team!));
  expect((await foundingMintCandidates(db, [configured!])).some(m => m.originalWallet === team)).toBe(false);
});

it('removes durable team identities from lifetime ranks, statistics and cached campaign ranks while preserving points', async () => {
  await ensurePlaytestCampaigns(db);
  const team = await player(); const real = await player();
  for (const wallet of [team, real]) {
    await db.insert(sessions).values({ wallet, expiresAt: now });
    await db.insert(testerMilestones).values(['base_founded', 'item_used'].map(key => ({ wallet, key,
      points: TESTER_PROGRAM.milestones.find(m => m.key === key)!.points, source: 'hook' as const, achievedAt: old })));
    await db.insert(playerActivityDays).values({ wallet, day: '2040-01-01', firstAt: old, lastAt: now, fought: true });
    await db.insert(scores).values({ campaignId: RULES.rewardedId, wallet, username: wallet === team ? 'Team' : 'Real',
      points: 100, activeDays: 1, longestStreak: 1, revenge: 0, stages: 0, achievedAt: old, eligible: true, evidence: {} });
  }
  const before = await computePlaytestStats(db, TEST_CONFIG, now);
  const points = (await testerProgress(db, team))!.points;
  await db.insert(internal).values({ wallet: team, reason: 'owner-confirmed team', recordedBy: 'test', evidence: {} });
  const board = await testerLeaderboard(db, { limit: 1000 });
  expect(board.entries.some(e => e.wallet === shortWallet(team))).toBe(false);
  expect(board.entries.some(e => e.wallet === shortWallet(real))).toBe(true);
  expect(await testerProgress(db, team, { timestamps: true })).toMatchObject({ points, listed: false, rank: null, listedReason: 'internal' });
  const after = await computePlaytestStats(db, TEST_CONFIG, now);
  expect(after.cohorts.total.players).toBe(before.cohorts.total.players - 1);
  expect(after.engagement.dau).toBe(before.engagement.dau - 1);
  expect(after.engagement.foughtToday).toBe(before.engagement.foughtToday - 1);
  const state = await campaignState(db, RULES.rewardedId, undefined, now);
  expect(state.standings.some(s => s.wallet === shortWallet(team))).toBe(false);
  expect(state.standings.some(s => s.wallet === shortWallet(real))).toBe(true);
  expect(await db.select().from(scores).where(eq(scores.wallet, team))).toHaveLength(1); // Evidence preserved.
  await expect(participateInCampaign(db, RULES.rewardedId, team, now)).rejects.toThrow('internal wallets');
});


it('withholds provisional places until a completed inventory covers their exact mint slot', async () => {
  const real = await player();
  const asset = await proof(real);
  await db.update(mints).set({ slot: '124' }).where(eq(mints.assetId, asset));
  const check = async (included: boolean, available = true) => {
    const candidates = await foundingMintCandidates(db, []);
    expect(candidates.some(m => m.originalWallet === real)).toBe(included);
    const status = await mintVerificationStatus(db, [], now);
    const stats = await computeFoundingCampaignStats(db, now);
    const state = await campaignState(db, RULES.foundingId, undefined, now);
    expect(status.verifiedUniqueWallets).toBe(candidates.length);
    expect(stats.checkpointCount).toBe(available ? Math.min(RULES.founderSpots, candidates.length) : null);
    expect(stats.checkpointAvailable).toBe(available);
    expect(state.checkpoint).toMatchObject({ count: stats.checkpointCount, frozen: false, available });
    expect(state.founders.some(f => f.wallet === shortWallet(real))).toBe(included);
  };
  // A verified proof beyond an otherwise completed inventory must not prematurely
  // fill the checkpoint while earlier original mints could still be missing.
  await completeInventory('123');
  await check(false);
  await db.delete(inventory).where(eq(inventory.id, 'land-deeds'));
  await check(false, false);
  expect(await foundingMintCandidates(db, [])).toHaveLength(0);
  await completeInventory('124');
  await check(true); // Inclusive completed slot is eligible, with no new mint proof.
});


it('distinguishes a complete zero-candidate inventory from incomplete proof coverage', async () => {
  await completeInventory('124');
  // Exclude only this suite's candidate identities to establish a genuine zero.
  const excluded = (await foundingMintCandidates(db, [])).map(m => m.originalWallet!);
  expect(await campaignState(db, RULES.foundingId, undefined, now, false, excluded))
    .toMatchObject({ checkpoint: { count: 0, available: true }, founders: [] });
  expect(await computeFoundingCampaignStats(db, now, excluded))
    .toMatchObject({ checkpointCount: 0, checkpointAvailable: true });
  const unknownAsset = randomUUID(); coveredFixtureAssets.push(unknownAsset);
  await db.insert(mints).values({ assetId: unknownAsset, error: 'fixture unresolved mint' });
  expect(await mintVerificationStatus(db, [], now)).toMatchObject({ complete: false });
  const unavailable = await campaignState(db, RULES.foundingId, undefined, now);
  expect(unavailable).toMatchObject({ checkpoint: { count: null, available: false }, founders: [] });
  expect(JSON.parse(JSON.stringify(unavailable)).checkpoint.count).toBeNull();
  // Cancelling before launch cannot convert unavailable verification into a
  // claimed zero or switch the first checkpoint to the postlaunch target.
  await db.transaction(async tx => {
    await tx.execute(sql`update playtest_campaigns set cancelled_at=${now.toISOString()}::timestamptz where id=${RULES.foundingId}`);
    expect(await computeFoundingCampaignStats(tx, now))
      .toMatchObject({ checkpointCount: null, checkpointAvailable: false });
    // The public reader requires its own read transaction, so the committed
    // state is exercised below and restored in the finally block.
  });
  try {
    expect(await campaignState(db, RULES.foundingId, undefined, now))
      .toMatchObject({ phase: 'cancelled', checkpoint: { count: null, target: RULES.founderSpots, available: false } });
  } finally {
    await db.execute(sql`update playtest_campaigns set cancelled_at=null where id=${RULES.foundingId}`);
  }
  expect(await computeFoundingCampaignStats(db, now))
    .toMatchObject({ checkpointCount: null, checkpointAvailable: false });
});
