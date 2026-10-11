import { trainTroop } from './training-consent';
/**
 * Quests + referrals (PLAN.md 4f — GDD §5): deterministic daily rotation,
 * event-driven progress, claim + all-three bonus, and one-level referrals.
 */
import { BuildingType, QUESTS, REFERRALS, TROOPS } from '@shardkeep/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  alphaAccess, buildings, mineState, players, questProgress, quests, referrals,
} from '../src/db/schema';
import { completeDueTraining} from '../src/game/army';
import { completeDueJobs, ensureStartingBase, placeBuilding, upgradeBuilding } from '../src/game/base';
import { collectMine, DAY_MS, ensureMineState, utcDay } from '../src/game/emission';
import {
  claimQuest, dailyQuestPicksFor, ensureQuests, progressQuest, weeklyQuestTemplateFor,
  weekStart,
} from '../src/game/quests';
import {
  activeReferralBonusBps,
  getOrCreateReferralCode,
  qualifyReferrals,
  redeemReferralAdmission,
  useReferralCode,
} from '../src/game/social';
import { spendGameCurrency, spendShards, rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
let key = 0;
const k = (): string => `soc-${++key}-${Math.random().toString(36).slice(2)}`;

async function basePlayer(keep = 100_000n) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
  await rewardShards(db, p.wallet, keep, 'test.fund.shards', k());
  return p;
}

/**
 * Buy the 0.2 SOL parcel — `players.entryPaidAt` IS the land-ownership column
 * (docs/LAND-DEED-ONBOARDING-PLAN.md, LOCKED OWNER DECISIONS 2026-08-09).
 *
 * WHY THIS APPEARS IN THIS FILE AT ALL (security review 2026-08-09 F4/F7):
 * referrals once paid a THIRD PARTY for another account's existence, with no
 * land filter. Free onboarding makes an account cost one signature, creating a
 * sybil faucet crossing the
 * deedless/landowner partition into shards a landowner can push through the Gold
 * Forge into withdrawable KEEP. Every test below that expects a PAYOUT now has to
 * say out loud that the account paid for its land; the ones that expect ZERO
 * deliberately do not.
 */
const buyLand = (wallet: string): Promise<unknown> =>
  db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, wallet));

const balance = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_shards')).balance; // split: mining + referral match are shards
const keepBalance = async (w: string) =>
  (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;

/** Give a player a Mine, seed an accrual buffer, and COLLECT it — returns the
 * credited amount (used to exercise the collect-time referral match). */
async function minerCollect(wallet: string, buffer: bigint, at = new Date()): Promise<bigint> {
  await placeBuilding(db, wallet, 'mine' as never, 11, 8, k());
  await completeDueJobs(db, wallet, new Date(at.getTime() + 120_000));
  await ensureMineState(db, wallet, at);
  await db.update(mineState).set({ lastAccrualAt: at, accruedShards: buffer })
    .where(eq(mineState.playerWallet, wallet));
  return (await collectMine(db, wallet, at)).amount;
}

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = priorMultiBase ?? 'false'; });

/** Force templates live on a PRIVATE quest day (the established fixture from
 * world.test.ts): API suites share one Postgres DB, and today's rotating board
 * belongs to no single test. liveQuests reads ALL rows for the day, not just
 * the rotation picks, so an inserted row is a live quest. Returns the rows. */
async function forceQuestDay(day: string, templateCodes: string[]) {
  await ensureQuests(db, day);
  await db.insert(quests).values(templateCodes.map((templateCode) => ({
    scope: 'daily' as const,
    templateCode,
    target: QUESTS.progressTargets[templateCode] ?? 1,
    rewardKeep: BigInt(QUESTS.dailyTemplates.find((t) => t.id === templateCode)?.rewardShards ?? 10),
    activeOn: day,
  }))).onConflictDoNothing();
  const rows = await db.select().from(quests).where(and(
    eq(quests.scope, 'daily'), eq(quests.activeOn, day),
    inArray(quests.templateCode, templateCodes),
  ));
  expect(rows).toHaveLength(templateCodes.length);
  return rows;
}

const progressOf = async (questId: string, wallet: string): Promise<number> => {
  const [prog] = await db.select().from(questProgress).where(and(
    eq(questProgress.questId, questId), eq(questProgress.playerWallet, wallet)));
  return prog?.progress ?? 0;
};

describe('quest board (GDD §5)', () => {
  it('makes the WHOLE daily pool live each day + one weekly, idempotently (owner 2026-08-16)', async () => {
    // The 3-slot rotation is GONE: the owner rejected it twice ("at least 50
    // working quests", then "only 3 visible still. Needs fix"). Every daily
    // template must be a claimable row every day, and re-running must not
    // duplicate (per-template upsert on the (scope, day, template) unique key).
    const day = '2099-02-01';
    await ensureQuests(db, day);
    await ensureQuests(db, day); // no duplicates
    const daily = await db.select().from(quests)
      .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, day)));
    expect(daily.length).toBe(QUESTS.dailyTemplates.length);
    expect(daily.map((q) => q.templateCode).sort())
      .toEqual(QUESTS.dailyTemplates.map((t) => t.id).sort());
    const weekly = await db.select().from(quests)
      .where(and(eq(quests.scope, 'weekly'), eq(quests.activeOn, weekStart(day))));
    expect(weekly.length).toBe(1);
    expect(weekly[0]!.templateCode).toBe(weeklyQuestTemplateFor(weekStart(day)).id);
  });

  it('BACKFILLS a day that was created under the old 3-slot rotation', async () => {
    // Production days created before this rollout have exactly 3 rows. The
    // per-template upsert must append the missing templates for the CURRENT
    // day without disturbing the existing rows (their ids carry player
    // progress) — otherwise players stay stuck at 3 until the next UTC day.
    const day = '2099-03-01';
    const legacy = QUESTS.dailyTemplates.slice(0, 3);
    await db.insert(quests).values(legacy.map((t) => ({
      scope: 'daily' as const,
      templateCode: t.id as string,
      target: QUESTS.progressTargets[t.id] ?? 1,
      rewardKeep: BigInt(t.rewardShards),
      activeOn: day,
    })));
    const before = await db.select().from(quests)
      .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, day)));
    await ensureQuests(db, day);
    const after = await db.select().from(quests)
      .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, day)));
    expect(after.length).toBe(QUESTS.dailyTemplates.length);
    // legacy rows kept their ids (progress attached to them survives)
    const afterIds = new Set(after.map((q) => q.id));
    for (const row of before) expect(afterIds.has(row.id)).toBe(true);
  });

  it('weekly rotation stays deterministic and covers all templates within 12 weeks', () => {
    const weekOf = (i: number): string =>
      new Date(Date.UTC(2030, 0, 7) + i * 7 * 86_400_000).toISOString().slice(0, 10);
    const weeklies = Array.from({ length: 12 }, (_, i) => weeklyQuestTemplateFor(weekOf(i)).id);
    expect([...new Set(weeklies)].sort())
      .toEqual(QUESTS.weeklyTemplates.map((t) => t.id).sort());
    expect(weeklyQuestTemplateFor(weekOf(3)).id).toBe(weeklies[3]);
  });

  it('upgrade_any + the M23 a15 upgrade quests progress via REAL upgrades and pay on claim', async () => {
    const at = new Date('2099-06-07T12:00:00.000Z');
    const day = utcDay(at);
    const rows = await forceQuestDay(day, ['upgrade_any', 'upgrade_2_buildings', 'upgrade_to_level_3']);
    const q = (code: string) => rows.find((r) => r.templateCode === code)!;
    const p = await basePlayer();
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, p.wallet)); // strict Keep-tallest
    // Walls upgrade INSTANTLY (no builder job), so two sequential upgrades reach
    // tier 3 inside one test without faking job completion times.
    const wall = await placeBuilding(db, p.wallet, 'wall' as never, 11, 8, k(), at);
    await upgradeBuilding(db, p.wallet, wall.id, k(), at); // T1 → T2
    expect(await progressOf(q('upgrade_any').id, p.wallet)).toBe(1);
    expect(await progressOf(q('upgrade_2_buildings').id, p.wallet)).toBe(1);
    expect(await progressOf(q('upgrade_to_level_3').id, p.wallet)).toBe(0); // tier 2 is not 3+
    await upgradeBuilding(db, p.wallet, wall.id, k(), at); // T2 → T3
    expect(await progressOf(q('upgrade_2_buildings').id, p.wallet)).toBe(2);
    expect(await progressOf(q('upgrade_to_level_3').id, p.wallet)).toBe(1);

    const before = await balance(p.wallet);
    const { reward } = await claimQuest(db, p.wallet, q('upgrade_any').id, at);
    expect(await balance(p.wallet)).toBe(before + BigInt(reward));
    await expect(claimQuest(db, p.wallet, q('upgrade_any').id, at)).rejects.toThrow(/already claimed/);
  });

  it('training and SHARD-spend quests credit only when paid v2 troops reach camp', async () => {
    const at = new Date('2099-04-05T12:00:00.000Z');
    const day = utcDay(at);
    const rows = await forceQuestDay(day, ['train_5_troops', 'train_20_points', 'spend_200', 'spend_500']);
    const q = (code: string) => rows.find((r) => r.templateCode === code)!;
    const p = await basePlayer();
    // Completed Barracks + Camp so trainTroop admission passes (army.test.ts
    // fixture: a building inserted with no build job counts as completed).
    await db.insert(buildings).values([
      { playerWallet: p.wallet, type: BuildingType.Barracks, level: 5, tx: 14, ty: 8 },
      { playerWallet: p.wallet, type: BuildingType.Camp, level: 3, tx: 17, ty: 8 },
    ]);
    await trainTroop(db, p.wallet, 'highlander' as never, k(), at);
    await trainTroop(db, p.wallet, 'bowman' as never, k(), at);
    // WHY: refundable training cannot advance either family of quests at
    // enqueue, or train→cancel loops manufacture free completion/rewards.
    expect(await progressOf(q('train_5_troops').id, p.wallet)).toBe(0);
    expect(await progressOf(q('train_20_points').id, p.wallet)).toBe(0);
    expect(await progressOf(q('spend_500').id, p.wallet)).toBe(0);

    // One lane credits both units only after their combined training duration.
    const finished = new Date(at.getTime() + (
      TROOPS.highlander.trainSec + TROOPS.bowman.trainSec
    ) * 1_000 + 1);
    await completeDueTraining(db, p.wallet, finished);
    expect(await progressOf(q('train_5_troops').id, p.wallet)).toBe(2);
    expect(await progressOf(q('train_20_points').id, p.wallet))
      .toBe(TROOPS.highlander.pts + TROOPS.bowman.pts);
    const totalCost = TROOPS.highlander.costKeep + TROOPS.bowman.costKeep;
    expect(await progressOf(q('spend_200').id, p.wallet)).toBe(Math.min(200, totalCost));
    expect(await progressOf(q('spend_500').id, p.wallet)).toBe(totalCost);
  });

  it('collect_mines / collect_1000_mined progress through the REAL mine-collect path (M23 a15)', async () => {
    const at = new Date('2099-05-06T12:00:00.000Z');
    const day = utcDay(at);
    const rows = await forceQuestDay(day, ['collect_mines', 'collect_1000_mined']);
    const q = (code: string) => rows.find((r) => r.templateCode === code)!;
    const p = await basePlayer();
    const amount = await minerCollect(p.wallet, 600n, at);
    expect(amount).toBe(600n);
    expect(await progressOf(q('collect_mines').id, p.wallet)).toBe(1); // single-shot, completed
    expect(await progressOf(q('collect_1000_mined').id, p.wallet)).toBe(600); // counted toward 1000
  });

  it('a claim credits player_shards and NEVER player_keep', async () => {
    // WHY THIS IS THE MOST IMPORTANT QUEST TEST (locked owner decision 2026-08-09):
    // quests are the ONE earner that stays free under free onboarding, and only
    // player_keep is withdrawable. Until 2026-08-09 the constants said
    // `rewardShards` while claimQuest posted withdrawable KEEP — so a deedless
    // account could earn a real-value asset from a free quest board. A bounded
    // source would cap that leak, not make the asset swap valid.
    // If the shards path is ever swapped back to rewardKeep, this test fails.
    // Uses the WEEKLY quest so the assertion does not depend on which three
    // dailies today's deterministic rotation happens to pick. M23 a15 rewrite:
    // the weekly itself now ROTATES, so progress whichever pool template this
    // week hashed to — the shards-not-KEEP rule applies to every one of them.
    const day = utcDay(new Date());
    await ensureQuests(db, day);
    const [weekly] = await db.select().from(quests)
      .where(and(eq(quests.scope, 'weekly'), eq(quests.activeOn, weekStart(day))));
    const template = QUESTS.weeklyTemplates.find((t) => t.id === weekly!.templateCode);
    expect(template).toBeDefined(); // the live weekly always comes from the pool
    const p = await basePlayer();
    await progressQuest(db, p.wallet, weekly!.templateCode, weekly!.target);

    const shardsBefore = await balance(p.wallet);
    const keepBefore = await keepBalance(p.wallet);
    const { reward } = await claimQuest(db, p.wallet, weekly!.id);

    expect(reward).toBe(template!.rewardShards);
    expect(await balance(p.wallet)).toBe(shardsBefore + BigInt(reward));
    expect(await keepBalance(p.wallet)).toBe(keepBefore); // not one base unit of KEEP
  });

  it('spend quests count SHARD sinks only — a KEEP sink moves NO progress (K-023 FIXED)', async () => {
    // WHY (K-023, resolved by owner assignment 2026-08-15 / M23 §16 a15): the
    // player-facing templates say "Spend 200/500 SHARDS", but the shared KEEP
    // spender (hero upgrades, recovery speed-ups, …) also advanced spend_200.
    // Least surprise: a quest labelled Shards counts Shards. If spendKeep ever
    // regains a quest tick, this test fails.
    const at = new Date('2099-03-03T12:00:00.000Z');
    const day = utcDay(at);
    const rows = await forceQuestDay(day, ['spend_200', 'spend_500']);
    const q = (code: string) => rows.find((r) => r.templateCode === code)!;
    const p = await basePlayer();
    // Fake ONLY Date (not timers — the postgres driver needs real timers):
    // spendKeep/spendShards stamp quest progress at `new Date()` internally.
    vi.useFakeTimers({ now: at, toFake: ['Date'] });
    try {
      await spendGameCurrency(db, p.wallet, 250n, 'test.sink', k());
      expect(await progressOf(q('spend_200').id, p.wallet)).toBe(0); // KEEP is not Shards
      expect(await progressOf(q('spend_500').id, p.wallet)).toBe(0);

      await spendShards(db, p.wallet, 250n, 'test.sink.shards', k());
      expect(await progressOf(q('spend_200').id, p.wallet)).toBe(200); // clamped to target
      expect(await progressOf(q('spend_500').id, p.wallet)).toBe(250); // counted toward 500
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('referrals (D-052 — v2 mining-bonus model, strictly one level)', () => {
  it('code generation is stable; referee registers once, inside the window', async () => {
    const referrer = await basePlayer();
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    expect(code).toMatch(/^KEEP-[A-Z2-9]{5}$/);
    expect(await getOrCreateReferralCode(db, referrer.wallet)).toBe(code);

    const referee = await basePlayer();
    await useReferralCode(db, referee.wallet, code);
    await expect(useReferralCode(db, referee.wallet, code)).rejects.toThrow(/already referred/);
    const self = await getOrCreateReferralCode(db, referee.wallet);
    await expect(useReferralCode(db, referee.wallet, self)).rejects.toThrow(/yourself/);
  });

  it('qualifies at deed + Keep L3 with NO waiting period — the deed IS the referral', async () => {
    const referrer = await basePlayer();
    const referee = await basePlayer();
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    await useReferralCode(db, referee.wallet, code);

    // Keep L3 alone (free under free onboarding) must NOT qualify — the land
    // condition is the anti-sybil brake (F4) and it survives the v2 redesign.
    await db.update(players).set({ keepLevel: REFERRALS.qualifyKeepLevel })
      .where(eq(players.wallet, referee.wallet));
    expect(await qualifyReferrals(db)).toBe(0);

    // Land below Keep L3 must not qualify either (owner: "got to 3 level KEEP").
    await db.update(players).set({ keepLevel: REFERRALS.qualifyKeepLevel - 1 })
      .where(eq(players.wallet, referee.wallet));
    await buyLand(referee.wallet);
    expect(await qualifyReferrals(db)).toBe(0);

    // Deed + Keep L3 qualifies IMMEDIATELY — v2 dropped the 7-day age wait;
    // a brand-new account that paid 0.2 SOL is exactly the referral the owner
    // wants counted.
    await db.update(players).set({ keepLevel: REFERRALS.qualifyKeepLevel })
      .where(eq(players.wallet, referee.wallet));
    expect(await qualifyReferrals(db)).toBe(1);
    const [row] = await db.select().from(referrals).where(eq(referrals.refereeWallet, referee.wallet));
    expect(row!.qualifiedAt).not.toBeNull();
  });

  it('pays +50 bps per ACTIVE referral and lapses on inactivity or a sold deed', async () => {
    const referrer = await basePlayer();
    const a = await basePlayer();
    const b = await basePlayer();
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    for (const referee of [a, b]) {
      await useReferralCode(db, referee.wallet, code);
      await db.update(players).set({
        keepLevel: REFERRALS.qualifyKeepLevel, lastSeenAt: new Date(),
      }).where(eq(players.wallet, referee.wallet));
      await buyLand(referee.wallet);
    }
    expect(await qualifyReferrals(db)).toBe(2);
    expect(await activeReferralBonusBps(db, referrer.wallet))
      .toBe(2 * REFERRALS.miningBonusBpsPerReferral);

    // Referee A goes quiet past the lapse window — their point disappears...
    await db.update(players).set({
      lastSeenAt: new Date(Date.now() - (REFERRALS.inactivityLapseDays + 1) * DAY_MS),
    }).where(eq(players.wallet, a.wallet));
    expect(await activeReferralBonusBps(db, referrer.wallet))
      .toBe(REFERRALS.miningBonusBpsPerReferral);

    // ...and comes back when they return. Qualification itself never re-runs.
    await db.update(players).set({ lastSeenAt: new Date() })
      .where(eq(players.wallet, a.wallet));
    expect(await activeReferralBonusBps(db, referrer.wallet))
      .toBe(2 * REFERRALS.miningBonusBpsPerReferral);

    // Referee B sells the deed ("if its on market not active player then no
    // reward for it") — qualified row stays, the point does not.
    await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, b.wallet));
    expect(await activeReferralBonusBps(db, referrer.wallet))
      .toBe(REFERRALS.miningBonusBpsPerReferral);
    const [rowB] = await db.select().from(referrals).where(eq(referrals.refereeWallet, b.wallet));
    expect(rowB!.qualifiedAt).not.toBeNull();
  });

  it('an unqualified referral contributes zero bonus even while its player is active', async () => {
    const referrer = await basePlayer();
    const referee = await basePlayer();
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    await useReferralCode(db, referee.wallet, code);
    // Active and landed, but Keep below the gate → never qualified → no bonus.
    await db.update(players).set({
      keepLevel: REFERRALS.qualifyKeepLevel - 1, lastSeenAt: new Date(),
    }).where(eq(players.wallet, referee.wallet));
    await buyLand(referee.wallet);
    expect(await qualifyReferrals(db)).toBe(0);
    expect(await activeReferralBonusBps(db, referrer.wallet)).toBe(0);
  });

  it('a referee who never signed in (null last_seen_at) counts as inactive', async () => {
    const referrer = await basePlayer();
    const referee = await basePlayer();
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    await useReferralCode(db, referee.wallet, code);
    await db.update(players).set({
      keepLevel: REFERRALS.qualifyKeepLevel, lastSeenAt: null,
    }).where(eq(players.wallet, referee.wallet));
    await buyLand(referee.wallet);
    expect(await qualifyReferrals(db)).toBe(1); // qualification is activity-independent
    expect(await activeReferralBonusBps(db, referrer.wallet)).toBe(0); // payout is not
  });

  it("a referee's collect NEVER mints anything for the referrer any more", async () => {
    // The v2 model is a QUOTA factor on the referrer's own mines — the old 5%
    // match crossing accounts at the referee's collect is gone. This is the
    // regression pin that the crossing path stays dead.
    const referrer = await basePlayer();
    const referee = await basePlayer();
    const code = await getOrCreateReferralCode(db, referrer.wallet);
    await useReferralCode(db, referee.wallet, code);
    await db.update(players).set({
      keepLevel: REFERRALS.qualifyKeepLevel, lastSeenAt: new Date(),
    }).where(eq(players.wallet, referee.wallet));
    await buyLand(referee.wallet);
    await qualifyReferrals(db);

    const before = await balance(referrer.wallet);
    const collected = await minerCollect(referee.wallet, 20_000n);
    expect(collected).toBeGreaterThan(0n);
    expect(await balance(referrer.wallet)).toBe(before);
    const [row] = await db.select().from(referrals).where(eq(referrals.refereeWallet, referee.wallet));
    expect(row!.totalMatchedKeep).toBe(0n); // historical column stays untouched
  });

  it("a friend's referral code admits a wallet to the closed alpha, insert-once", async () => {
    const referrer = await basePlayer();
    const friend = await createTestPlayer(db);
    const code = await getOrCreateReferralCode(db, referrer.wallet);

    await redeemReferralAdmission(db, friend.wallet, code.toLowerCase());
    const [grant] = await db.select().from(alphaAccess).where(eq(alphaAccess.wallet, friend.wallet));
    expect(grant).toMatchObject({ source: 'referral' });
    const [rel] = await db.select().from(referrals).where(eq(referrals.refereeWallet, friend.wallet));
    expect(rel?.referrerWallet).toBe(referrer.wallet);

    // Re-redeeming (same or another code) keeps the FIRST sticky grant and
    // the first referral relationship — admission never errors on the edges.
    const other = await basePlayer();
    const otherCode = await getOrCreateReferralCode(db, other.wallet);
    await redeemReferralAdmission(db, friend.wallet, otherCode);
    const grants = await db.select().from(alphaAccess).where(eq(alphaAccess.wallet, friend.wallet));
    expect(grants).toHaveLength(1);
    const rels = await db.select().from(referrals).where(eq(referrals.refereeWallet, friend.wallet));
    expect(rels).toHaveLength(1);
    expect(rels[0]!.referrerWallet).toBe(referrer.wallet);

    // REVOCATION MUST WIN (security review 2026-08-15 F1): deleting the
    // access row is the moderation mechanism, and a kicked tester holding any
    // public referral link must NOT get a self-service re-admission.
    await db.delete(alphaAccess).where(eq(alphaAccess.wallet, friend.wallet));
    await expect(redeemReferralAdmission(db, friend.wallet, code))
      .rejects.toThrow(/invalid referral code/);
    expect(await db.select().from(alphaAccess).where(eq(alphaAccess.wallet, friend.wallet)))
      .toHaveLength(0);

    // Unknown code and self-referral fail with ONE uniform error
    // (enumeration posture) and grant nothing.
    const stranger = await createTestPlayer(db);
    await expect(redeemReferralAdmission(db, stranger.wallet, 'KEEP-ZZZZ9'))
      .rejects.toThrow(/invalid referral code/);
    const strangerCode = await getOrCreateReferralCode(db, stranger.wallet);
    await expect(redeemReferralAdmission(db, stranger.wallet, strangerCode))
      .rejects.toThrow(/invalid referral code/);
    expect(await db.select().from(alphaAccess).where(eq(alphaAccess.wallet, stranger.wallet)))
      .toHaveLength(0);
  });
});
