/**
 * Daily tester points (D-103, owner 2026-09-04): every TESTER_DAILY source is
 * derived from its authoritative table and paid at most once per UTC day
 * (capped sources up to their cap); 'played' fires on any action; streaks pay
 * on the exact day a run reaches N; referral days pay the referrer only for a
 * qualified, still-landed referee that acted; the recompute is idempotent and
 * insert-or-raise only; every sum (board, progress, me, export) includes the
 * daily ledger; feedback can be marked fixed without losing points; and the
 * purge path deletes the daily rows before the player.
 */
import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYTEST_CAMPAIGN, PLAYTEST_COMPETITIONS, TESTER_DAILY, TESTER_PROGRAM, type TesterDailyKey } from '@shardkeep/shared';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { purgeSyntheticAccount } from '../src/db/purgeSyntheticAccounts';
import {
  baseBattleRecords, baseQuestProgress, bases, baseTransfers, builderJobs, deposits, globalChatMessages, itemListings, itemUses,
  mailMessages, players, quests, raids, referrals, sessions, testerDailyPoints, testerFeedback, withdrawals,
} from '../src/db/schema';
import { PASSIVE_KEYS, shiftDay, utcDay, utcDaysEndingAt, type ActionSourceKey } from '../src/game/actionDay';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { recomputeTesterMilestones, shortWallet, testerProgress } from '../src/game/tester';
import { TEST_CONFIG, connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let db: ReturnType<typeof connectTestDb>['db'];
let app: FastifyInstance;

async function makeKeypair() {
  const secretKey = utils.randomSecretKey();
  return { secretKey, wallet: bs58.encode(await getPublicKeyAsync(secretKey)) };
}
async function login(kp: { secretKey: Uint8Array; wallet: string }): Promise<string> {
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), kp.secretKey));
  const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: kp.wallet, signature } });
  expect(res.statusCode).toBe(200);
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}
const cookies = (c: string) => ({ [SESSION_COOKIE]: c });

let admin: { secretKey: Uint8Array; wallet: string };
let adminCookie: string;

/** One instant for every fixture and recompute so the suite cannot straddle a UTC midnight. */
const NOW = new Date();
const TODAY = utcDay(NOW);
const at = (daysAgo: number, hour = 12): Date => new Date(`${shiftDay(TODAY, -daysAgo)}T${String(hour).padStart(2, '0')}:00:00.000Z`);
const SRC = (key: TesterDailyKey) => TESTER_DAILY.sources.find((s) => s.key === key)!;
const STREAK = (days: number) => TESTER_DAILY.streaks.find((s) => s.days === days)!;

beforeAll(async () => {
  conn = connectTestDb();
  db = conn.db;
  admin = await makeKeypair();
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin.wallet] }, db);
  adminCookie = await login(admin);
});
afterAll(async () => { await app.close(); await conn.sql.end(); });

// --- fixtures -----------------------------------------------------------------

type DailyRow = { count: number; points: number; meta: unknown };
async function rowsFor(wallet: string, day = TODAY): Promise<Map<string, DailyRow>> {
  const rows = await db.select().from(testerDailyPoints)
    .where(and(eq(testerDailyPoints.wallet, wallet), eq(testerDailyPoints.day, day)));
  return new Map(rows.map((r) => [r.key, { count: r.count, points: r.points, meta: r.meta }]));
}
const recompute = (wallet: string) => recomputeTesterMilestones(db, wallet, 'derived', NOW);
const dailyOf = (awards: Awaited<ReturnType<typeof recompute>>) =>
  awards.flatMap((a) => (a.kind === 'daily' ? [a] : []));

const ledger = (wallet: string, type: string) => fundTestKeep(db, wallet, 1n, type, `daily:${type}:${randomUUID()}`);
async function chat(wallet: string, createdAt = NOW): Promise<void> {
  await db.insert(globalChatMessages).values({
    authorWallet: wallet, clientMessageId: randomUUID(), text: 'gg', textHash: 'h',
    authorNameAtSend: '', authorSeekerVerifiedAtSend: false, createdAt,
  });
}
async function newBase(wallet: string, extra: Partial<typeof bases.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(bases).values({ id, ownerWallet: wallet, status: 'active', keepLevel: 1, ...extra });
  return id;
}
async function pvpRaid(attacker: string, defender: string, stars: number | null, resolvedAt = NOW): Promise<string> {
  const [r] = await db.insert(raids).values({
    attackerWallet: attacker, defenderWallet: defender, seed: 1n, snapshot: {}, armySnapshot: {}, orders: {},
    ordersDeadlineAt: resolvedAt, status: 'resolved', resolvedAt,
    result: stars === null ? null : { stars, destructionPct: stars * 30 },
  }).returning({ id: raids.id });
  return r!.id;
}
async function pveRaid(attacker: string, resolvedAt = NOW): Promise<void> {
  await db.insert(raids).values({
    attackerWallet: attacker, campaignStage: 1, seed: 1n, snapshot: {}, armySnapshot: {}, orders: {},
    ordersDeadlineAt: resolvedAt, status: 'resolved', resolvedAt, result: { stars: 3, destructionPct: 100 },
  });
}
async function questClaim(baseId: string, claimedAt = NOW): Promise<void> {
  const [q] = await db.insert(quests).values({
    scope: 'daily', templateCode: `t_${randomUUID()}`, target: 1, rewardKeep: 0n, activeOn: TODAY,
  }).returning({ id: quests.id });
  await db.insert(baseQuestProgress).values({ baseId, questId: q!.id, progress: 1, completedAt: claimedAt, claimedAt });
}
async function deposit(wallet: string, kind: typeof deposits.$inferInsert['kind'], status: typeof deposits.$inferInsert['status'] = 'credited'): Promise<void> {
  await db.insert(deposits).values({ playerWallet: wallet, kind, reference: randomUUID(), status, finalizedAt: NOW, createdAt: NOW });
}
async function withdrawal(wallet: string, status: typeof withdrawals.$inferInsert['status']): Promise<string> {
  const [row] = await db.insert(withdrawals).values({
    playerWallet: wallet, currency: 'KEEP', amount: 1n, destination: wallet, status, unbondsAt: NOW,
    completedAt: status === 'sent' ? NOW : null, createdAt: NOW,
  }).returning({ id: withdrawals.id });
  return row!.id;
}
async function feedback(wallet: string, createdAt = NOW): Promise<string> {
  const [f] = await db.insert(testerFeedback).values({
    wallet, category: 'bug', title: 'x', body: 'The vault stat chip shows SHIELDS twice after an upgrade.',
    rewardPolicyVersion: 1, basePoints: TESTER_PROGRAM.feedback.basePoints, points: TESTER_PROGRAM.feedback.basePoints, createdAt,
  }).returning({ id: testerFeedback.id });
  return f!.id;
}

// --- per-source derivation ----------------------------------------------------

const SOURCE_CASES: Array<{ key: ActionSourceKey; seed: (w: string) => Promise<unknown> }> = [
  { key: 'mine_collected', seed: (w) => ledger(w, 'mine.collect') },
  { key: 'cache_claimed', seed: (w) => ledger(w, 'cache.claim') },
  { key: 'build_started', seed: (w) => ledger(w, 'build.upgrade') },
  { key: 'troops_trained', seed: (w) => ledger(w, 'army.train') },
  { key: 'forge_deployed', seed: (w) => ledger(w, 'forge.contribute') },
  { key: 'forge_claimed', seed: (w) => ledger(w, 'forge.claim') },
  { key: 'shop_bought', seed: (w) => ledger(w, 'item.buy') },
  { key: 'quest_claimed', seed: async (w) => questClaim(await newBase(w)) },
  { key: 'pve_battle', seed: (w) => pveRaid(w) },
  { key: 'pvp_win', seed: async (w) => pvpRaid(w, (await createTestPlayer(db)).wallet, 1) },
  { key: 'defence_held', seed: async (w) => pvpRaid((await createTestPlayer(db)).wallet, w, 0) },
  { key: 'market_listed', seed: (w) => db.insert(itemListings).values({ sellerWallet: w, idempotencyKey: randomUUID(), itemId: 'potion', priceLamports: 1n, createdAt: NOW }) },
  { key: 'market_bought', seed: async (w) => db.insert(itemListings).values({
    sellerWallet: (await createTestPlayer(db)).wallet, buyerWallet: w, idempotencyKey: randomUUID(), itemId: 'potion',
    priceLamports: 1n, status: 'sold', settledAt: NOW, createdAt: NOW,
  }) },
  { key: 'item_used', seed: (w) => db.insert(itemUses).values({ playerWallet: w, itemId: 'potion', idempotencyKey: randomUUID(), usedAt: NOW }) },
  { key: 'sol_deposit', seed: (w) => deposit(w, 'builder') },
  { key: 'keep_deposit', seed: (w) => deposit(w, 'keep_deposit') },
  { key: 'withdrawal_sent', seed: (w) => withdrawal(w, 'sent') },
  { key: 'chat_sent', seed: (w) => chat(w) },
  { key: 'mail_claimed', seed: (w) => db.insert(mailMessages).values({
    recipientWallet: w, senderKind: 'system', kind: 'reward', rewardState: 'claimed', dedupeKey: randomUUID(),
    subject: 's', body: 'b', expiresAt: NOW, claimedAt: NOW,
  }) },
  { key: 'feedback_sent', seed: (w) => feedback(w) },
];

describe.sequential('daily points derive each source from its authoritative table', () => {
  it('covers every TESTER_DAILY source exactly once (played and referral_active are derived)', () => {
    // WHY: a source added to the shared catalog without a derivation would
    // silently never pay; this pins the catalog and the aggregator together.
    const derived = TESTER_DAILY.sources.map((s) => s.key).filter((k) => k !== 'played' && k !== 'referral_active');
    expect(SOURCE_CASES.map((c) => c.key).sort()).toEqual([...derived].sort());
  });

  it.each(SOURCE_CASES)('$key: one authoritative row pays its points once and marks the day played', async ({ key, seed }) => {
    const w = (await createTestPlayer(db)).wallet;
    await seed(w);
    const daily = dailyOf(await recompute(w));
    // A PASSIVE source (something done TO the wallet — a held defence) pays
    // its own points but is not the wallet's play; see actionDay.PASSIVE_KEYS.
    const expected = PASSIVE_KEYS.has(key) ? [key] : [key, 'played'].sort();
    expect(daily.map((a) => a.key).sort()).toEqual(expected);
    expect(daily.every((a) => a.day === TODAY)).toBe(true);
    const rows = await rowsFor(w);
    expect(rows.get(key)).toMatchObject({ count: 1, points: SRC(key).points });
    if (PASSIVE_KEYS.has(key)) expect(rows.has('played')).toBe(false);
    else expect(rows.get('played')).toMatchObject({ count: 1, points: SRC('played').points });
    expect([...rows.keys()].sort()).toEqual(expected);
  });

  it('ignores signals that are not actions: a pending deposit, an unbonding withdrawal, a sign-in', async () => {
    // WHY (owner): "login alone never counts" and deposits pay only once credited.
    const kp = await makeKeypair();
    await login(kp);
    await deposit(kp.wallet, 'builder', 'pending');
    const pending = await withdrawal(kp.wallet, 'unbonding');
    try {
      expect(dailyOf(await recompute(kp.wallet))).toEqual([]);
      expect((await rowsFor(kp.wallet)).size).toBe(0);
    } finally {
      // This raw, unfunded 1-KEEP signal is not a payout fixture. Leaving it
      // due would make every later shared-queue payout test hold an extra row.
      await db.delete(withdrawals).where(eq(withdrawals.id, pending));
    }
  });

  it('attributes base-keyed rows to the base owner and snapshots the base id in meta', async () => {
    const owner = (await createTestPlayer(db)).wallet;
    const other = (await createTestPlayer(db)).wallet;
    const mine = await newBase(owner);
    const theirs = await newBase(other);
    await questClaim(mine);
    await questClaim(theirs);
    await db.insert(builderJobs).values({ playerWallet: owner, baseId: mine, kind: 'upgrade', startedAt: NOW, finishesAt: NOW });
    const rows = await rowsFor(owner);
    expect(rows.size).toBe(0);
    await recompute(owner);
    const after = await rowsFor(owner);
    expect(after.get('quest_claimed')).toMatchObject({ count: 1, meta: { baseId: mine } });
    expect(after.get('build_started')).toMatchObject({ count: 1, meta: { baseId: mine } });
    // The other base's claim is the other owner's day, not this one's.
    await recompute(other);
    expect((await rowsFor(other)).get('quest_claimed')).toMatchObject({ count: 1, meta: { baseId: theirs } });
    expect((await rowsFor(other)).has('build_started')).toBe(false);
  });

  it('UTC day helpers: days end at midnight UTC and shift across month ends', () => {
    expect(utcDaysEndingAt(new Date('2026-09-04T23:59:59.999Z'), 3)).toEqual(['2026-09-02', '2026-09-03', '2026-09-04']);
    expect(utcDaysEndingAt(new Date('2026-09-05T00:00:00.000Z'), 1)).toEqual(['2026-09-05']);
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(TESTER_DAILY.lookbackDays).toBeGreaterThanOrEqual(1);
  });
});

// --- caps, once-per-day, idempotency ------------------------------------------

describe.sequential('caps and idempotency', () => {
  it('pays PvP wins up to the cap (21 wins → 20 paid), counts each raid once across both record shapes, and never counts a zero-star raid as a win', async () => {
    // WHY (owner): "Pvp points wins max 20 times a day".
    const p = (await createTestPlayer(db)).wallet;
    const d = (await createTestPlayer(db)).wallet;
    for (let i = 0; i < 21; i++) await pvpRaid(p, d, (i % 3) + 1);
    await pvpRaid(p, d, 0);
    const first = dailyOf(await recompute(p));
    const win = SRC('pvp_win');
    expect(first.find((a) => a.key === 'pvp_win')).toMatchObject({ count: 21, points: win.cap * win.points });
    expect((await rowsFor(p)).get('pvp_win')).toMatchObject({ count: 21, points: win.cap * win.points });
    // The defender held exactly the zero-star raid and won nothing.
    await recompute(d);
    const dRows = await rowsFor(d);
    expect(dRows.get('defence_held')).toMatchObject({ count: 1, points: SRC('defence_held').points });
    expect(dRows.has('pvp_win')).toBe(false);
    // A raid known only through its battle record still counts — once. A PvP
    // record names the opponent's base; that is what makes it a PvP win.
    const pBase = await newBase(p);
    const dBase = await newBase(d);
    const raidId = await pvpRaid(p, d, null);
    await db.insert(baseBattleRecords).values({
      baseId: pBase, raidId, role: 'attacker', ownerWalletAtBattle: p, counterpartyBaseId: dBase,
      stars: 2, destructionPct: 60, createdAt: NOW,
    });
    const second = dailyOf(await recompute(p));
    expect(second).toEqual([expect.objectContaining({ key: 'pvp_win', count: 22, points: 0 })]);
    expect((await rowsFor(p)).get('pvp_win')).toMatchObject({ count: 22, points: win.cap * win.points });
  });

  it('pays a once-a-day source once however many times it fires, and a repeated recompute is a byte-identical no-op', async () => {
    const w = (await createTestPlayer(db)).wallet;
    await chat(w);
    await chat(w);
    await ledger(w, 'mine.collect');
    const awards = dailyOf(await recompute(w));
    expect(awards.find((a) => a.key === 'chat_sent')).toMatchObject({ count: 2, points: SRC('chat_sent').points });
    const snapshot = await db.select().from(testerDailyPoints).where(eq(testerDailyPoints.wallet, w));
    expect(snapshot.map((r) => r.key).sort()).toEqual(['chat_sent', 'mine_collected', 'played']);
    expect(await recompute(w)).toEqual([]);
    expect(await db.select().from(testerDailyPoints).where(eq(testerDailyPoints.wallet, w))).toEqual(snapshot);
  });

  it('never lowers a recorded count or points, even when the derivation now says less', async () => {
    // WHY: rows are a ledger — a later data change (a retired table, a
    // reattributed base) must not take points a player already saw.
    const w = (await createTestPlayer(db)).wallet;
    await db.insert(testerDailyPoints).values({ wallet: w, day: TODAY, key: 'chat_sent', count: 5, points: 1, meta: { legacy: true } });
    await chat(w);
    const awards = dailyOf(await recompute(w));
    expect(awards.map((a) => a.key)).toEqual(['played']);
    expect((await rowsFor(w)).get('chat_sent')).toMatchObject({ count: 5, points: 1, meta: { legacy: true } });
  });
});

// --- streaks ----------------------------------------------------------------------

describe.sequential('streaks', () => {
  it('pays streak_N on the day the run of consecutive action days reaches exactly N, once per run', async () => {
    const w = (await createTestPlayer(db)).wallet;
    for (const daysAgo of [2, 1, 0]) await chat(w, at(daysAgo));
    const awards = dailyOf(await recompute(w));
    const played = awards.filter((a) => a.key === 'played').map((a) => a.day).sort();
    expect(played).toEqual([shiftDay(TODAY, -2), shiftDay(TODAY, -1), TODAY]);
    const streaks = awards.filter((a) => a.key.startsWith('streak_'));
    expect(streaks).toEqual([expect.objectContaining({ key: 'streak_3', day: TODAY, points: STREAK(3).points })]);
    expect(await recompute(w)).toEqual([]);
    const me = await testerProgress(db, w, { timestamps: true, now: NOW });
    expect(me!.daily.streakDays).toBe(3);
  });

  it('counts played days written by earlier passes, so a run reaching 7 pays streak_7 and not streak_3 again', async () => {
    const w = (await createTestPlayer(db)).wallet;
    // Days -6..-3 were derived by earlier sweeps (their streak_3 was paid on day -4).
    for (const daysAgo of [6, 5, 4, 3]) {
      await db.insert(testerDailyPoints).values({ wallet: w, day: shiftDay(TODAY, -daysAgo), key: 'played', count: 1, points: SRC('played').points });
    }
    await db.insert(testerDailyPoints).values({ wallet: w, day: shiftDay(TODAY, -4), key: 'streak_3', count: 1, points: STREAK(3).points });
    for (const daysAgo of [2, 1, 0]) await chat(w, at(daysAgo));
    const streaks = dailyOf(await recompute(w)).filter((a) => a.key.startsWith('streak_'));
    expect(streaks).toEqual([expect.objectContaining({ key: 'streak_7', day: TODAY, points: STREAK(7).points })]);
    expect((await testerProgress(db, w, { timestamps: true, now: NOW }))!.daily.streakDays).toBe(7);
  });

  it('a gap restarts the run: after a missed day a new three-day run earns streak_3 again on its own day', async () => {
    const w = (await createTestPlayer(db)).wallet;
    for (const daysAgo of [6, 5, 4]) {
      await db.insert(testerDailyPoints).values({ wallet: w, day: shiftDay(TODAY, -daysAgo), key: 'played', count: 1, points: SRC('played').points });
    }
    for (const daysAgo of [2, 1, 0]) await chat(w, at(daysAgo));
    const streaks = dailyOf(await recompute(w)).filter((a) => a.key.startsWith('streak_'));
    expect(streaks).toEqual([expect.objectContaining({ key: 'streak_3', day: TODAY })]);
  });

  it('shows yesterday\'s run as the live streak until today is played', async () => {
    const w = (await createTestPlayer(db)).wallet;
    for (const daysAgo of [2, 1]) await chat(w, at(daysAgo));
    await recompute(w);
    expect((await testerProgress(db, w, { timestamps: true, now: NOW }))!.daily.streakDays).toBe(2);
    expect((await testerProgress(db, w, { timestamps: true, now: NOW }))!.daily.todayPoints).toBe(0);
  });
});

// --- referrals ---------------------------------------------------------------------

describe.sequential('referral days', () => {
  it('pays the referrer per qualified, still-landed referee that acted today; nothing for the unqualified, the landless or the idle; nothing to the referee', async () => {
    // WHY (owner): referral daily points only for a "Qualified referee deed
    // plus keep lvl 3", only on days the referee acted.
    const referrer = await makeKeypair();
    const cookie = await login(referrer);
    const mk = async (opts: { qualified: boolean; land: 'base' | 'inactive' | 'legacy' | 'none'; acts: boolean }) => {
      const w = (await createTestPlayer(db)).wallet;
      if (opts.land === 'base') await newBase(w, { landPaidAt: NOW, keepLevel: 3 });
      if (opts.land === 'inactive') await newBase(w, { landPaidAt: NOW, keepLevel: 3, status: 'inactive' });
      if (opts.land === 'legacy') await db.update(players).set({ entryPaidAt: NOW, keepLevel: 3 }).where(eq(players.wallet, w));
      await db.insert(referrals).values({ referrerWallet: referrer.wallet, refereeWallet: w, qualifiedAt: opts.qualified ? NOW : null });
      if (opts.acts) await chat(w);
      return w;
    };
    const active = await mk({ qualified: true, land: 'base', acts: true });
    await mk({ qualified: true, land: 'base', acts: false });
    await mk({ qualified: false, land: 'base', acts: true });
    await mk({ qualified: true, land: 'inactive', acts: true });
    const legacy = await mk({ qualified: true, land: 'legacy', acts: true });

    const awards = dailyOf(await recompute(referrer.wallet));
    const ref = SRC('referral_active');
    expect(awards).toEqual([expect.objectContaining({ key: 'referral_active', day: TODAY, count: 2, points: 2 * ref.points })]);
    // A referral day is not the referrer's own action: no 'played' for them.
    expect([...(await rowsFor(referrer.wallet)).keys()]).toEqual(['referral_active']);
    // The referees earn their own day and no referral credit.
    for (const w of [active, legacy]) {
      await recompute(w);
      const rows = await rowsFor(w);
      expect(rows.has('referral_active')).toBe(false);
      expect(rows.get('played')).toMatchObject({ count: 1 });
    }
    const me = await app.inject({ method: 'GET', url: '/tester/me', cookies: cookies(cookie) });
    expect(me.statusCode).toBe(200);
    const body = me.json() as {
      referrals: { invited: number; qualified: number; activeToday: number };
      dailyPoints: number; referralPoints: number; points: number; milestonePoints: number; feedbackPoints: number;
      daily: { todayPoints: number; byKey: Array<{ key: string; count: number; points: number; lastAt?: string }> };
    };
    expect(body.referrals).toEqual({ invited: 5, qualified: 4, activeToday: 2 });
    expect(body.referralPoints).toBe(2 * ref.points);
    expect(body.dailyPoints).toBe(0);
    expect(body.daily.todayPoints).toBe(2 * ref.points);
    expect(body.daily.byKey).toEqual([{ key: 'referral_active', count: 2, points: 2 * ref.points, lastAt: expect.any(String) }]);
    expect(body.points).toBe(body.milestonePoints + body.feedbackPoints + body.dailyPoints + body.referralPoints);
  });
});

// --- sums and shapes ---------------------------------------------------------------

describe.sequential('every sum includes the daily ledger', () => {
  it('board rows carry dailyPoints/referralPoints, progress and me agree with the board, the public read has no timestamps, export includes daily', async () => {
    const kp = await makeKeypair();
    const cookie = await login(kp);
    await newBase(kp.wallet);
    await db.update(players).set({ name: 'daily_sum', nameKey: 'daily_sum' }).where(eq(players.wallet, kp.wallet));
    await chat(kp.wallet);
    await recompute(kp.wallet);
    const expectDaily = SRC('chat_sent').points + SRC('played').points;

    const board = await app.inject({ method: 'GET', url: '/tester/leaderboard' });
    expect(board.statusCode).toBe(200);
    const b = board.json() as {
      entries: Array<{ wallet: string; points: number; dailyPoints: number; referralPoints: number; rank: number }>;
      catalog: { daily: { sources: unknown[]; streaks: unknown[]; categoryLabels: Record<string, string> } };
    };
    const row = b.entries.find((e) => e.wallet === shortWallet(kp.wallet));
    expect(row).toMatchObject({ dailyPoints: expectDaily, referralPoints: 0 });
    expect(b.catalog.daily.sources).toHaveLength(TESTER_DAILY.sources.length);
    expect(b.catalog.daily.streaks).toHaveLength(TESTER_DAILY.streaks.length);
    expect(b.catalog.daily.categoryLabels).toEqual(TESTER_DAILY.categoryLabels);

    const progress = await testerProgress(db, kp.wallet, { timestamps: false, now: NOW });
    expect(progress!.points).toBe(row!.points);
    expect(progress!.rank).toBe(row!.rank);
    expect(progress!.points).toBe(progress!.milestonePoints + progress!.feedbackPoints + expectDaily);

    // WHY: the public lookup is uncredentialed and CORS-open. It carries the
    // all-time daily/referral TOTALS (they are on the board anyway) but never
    // which sources fired today, the streak or the referral network — that
    // would tell anyone whether a given wallet withdrew, deposited or raided
    // today and how many friends it has (review 2026-09-04).
    const pub = await app.inject({ method: 'GET', url: '/tester/progress', query: { wallet: kp.wallet } });
    const p = pub.json() as { listedReason?: string; dailyPoints: number; referralPoints: number; daily: Record<string, unknown>; referrals?: unknown; campaign?: unknown };
    expect(p.dailyPoints).toBe(expectDaily);
    expect(p.referralPoints).toBe(0);
    expect(p.daily).toEqual({});
    expect('referrals' in p).toBe(false);
    expect('listedReason' in p).toBe(false);

    const me = await app.inject({ method: 'GET', url: '/tester/me', cookies: cookies(cookie) });
    const m = me.json() as {
      listed: boolean; listedReason: string;
      daily: { todayPoints: number; streakDays: number; byKey: Array<{ key: string; lastAt?: string }>; catalog: { sources: unknown[] } };
      referrals: unknown; campaign: Record<string, unknown>;
    };
    expect(m).toMatchObject({ listed: true, listedReason: 'listed' });
    expect(m.daily.catalog.sources).toHaveLength(TESTER_DAILY.sources.length);
    expect(m.daily).toMatchObject({ todayPoints: expectDaily, streakDays: 1 });
    expect(m.daily.byKey.map((k) => k.key).sort()).toEqual(['chat_sent', 'played']);
    expect(m.daily.byKey.every((k) => typeof k.lastAt === 'string')).toBe(true);
    expect(m.referrals).toEqual({ invited: 0, qualified: 0, activeToday: 0 });
    // Whitelist eligibility is the minted Land Deed (owner 2026-09-04): a
    // fresh wallet has none, and the public lookup says the same.
    expect((m as unknown as { landOwner: boolean }).landOwner).toBe(false);
    expect((p as unknown as { landOwner: boolean }).landOwner).toBe(false);
    // The in-game campaign card and the site banner read the same framing;
    // with no saved launch date the window is null and there is no day count.
    expect(m.campaign).toEqual({
      id: PLAYTEST_COMPETITIONS.foundingId, scoreType: 'founding',
      name: 'Founding Kingdoms', totalDays: 14, rewardCopy: PLAYTEST_CAMPAIGN.rewardCopy,
      whitelist: { requiresLandDeed: true, spots: 300 },
      startAt: null, endAt: null, dayIndex: null,
    });
    const publicBoard = (await app.inject({ method: 'GET', url: '/tester/leaderboard' })).json() as { campaign: unknown };
    expect(publicBoard.campaign).toEqual(m.campaign);

    const exported = await app.inject({ method: 'GET', url: '/admin/tester/export', cookies: cookies(adminCookie) });
    const t = (exported.json() as { testers: Array<{ wallet: string; points: number; dailyPoints: number; referralPoints: number }> }).testers
      .find((x) => x.wallet === kp.wallet);
    expect(t).toMatchObject({ points: row!.points, dailyPoints: expectDaily, referralPoints: 0 });
  });

  it('tells an unlisted wallet why (no base yet) and lists justEarned daily keys with their delta', async () => {
    const kp = await makeKeypair();
    const cookie = await login(kp);
    await chat(kp.wallet);
    const me = await app.inject({ method: 'GET', url: '/tester/me', cookies: cookies(cookie) });
    const m = me.json() as { listed: boolean; listedReason: string; justEarned: Array<{ kind: string; key: string; points: number; day?: string }> };
    expect(m).toMatchObject({ listed: false, listedReason: 'no_base' });
    expect(m.justEarned.filter((e) => e.kind === 'daily').map((e) => e.key).sort()).toEqual(['chat_sent', 'played']);
    expect(m.justEarned.filter((e) => e.kind === 'milestone').map((e) => e.key)).toContain('signed_in');
  });
});

// --- admin: fixed ------------------------------------------------------------------

describe.sequential('feedback FIXED flag (D-103, owner 2026-09-04)', () => {
  it('requires acceptance before Fixed and reopening restores Accepted without losing the fixed history', async () => {
    // Owner changed the lifecycle: Accepted and Fixed are exclusive filters;
    // legacy storage keeps its triage plus timestamp for compatibility.
    const kp = await makeKeypair();
    const cookie = await login(kp);
    const id = await feedback(kp.wallet);
    const rate = (payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: `/admin/tester/feedback/${id}/rate`, cookies: cookies(adminCookie), payload,
    });
    const base = TESTER_PROGRAM.feedback.basePoints;
    const bonus = TESTER_PROGRAM.feedback.importanceBonus;
    type Rated = { status: string; fixed: boolean; points: number; fixedAt: string | null; fixedRef: string | null; exportedAt: string | null };
    expect((await rate({ fixed: true })).statusCode).toBe(409);
    expect((await rate({ status: 'accepted', fixed: true })).statusCode).toBe(409);
    expect((await rate({ status: 'accepted', importance: 'high' })).statusCode).toBe(200);
    const fixed = (await rate({ fixed: true, fixedRef: 'abc1234 · 0.3.4' })).json() as Rated;
    expect(fixed).toMatchObject({ status: 'fixed', fixed: true, points: base + bonus.high, fixedRef: 'abc1234 · 0.3.4', exportedAt: null });
    expect(fixed.fixedAt).toBeTruthy();
    // A later re-rate keeps the original fixed_at and the reference.
    const again = (await rate({ importance: 'critical' })).json() as Rated;
    expect(again).toMatchObject({ status: 'fixed', fixed: true, points: base + bonus.critical, fixedAt: fixed.fixedAt, fixedRef: 'abc1234 · 0.3.4' });
    expect((await rate({ fixed: true, fixedRef: 'x'.repeat(121) })).statusCode).toBe(400);
    // Rejected or duplicate can never be fixed — and 'fixed' is not a status anyone can set.
    const conflict = await rate({ status: 'rejected' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'FEEDBACK_FIXED_CONFLICT' } });
    expect((await rate({ status: 'fixed' })).statusCode).toBe(400);
    // Clearing the flag keeps the triage status and drops the stamp.
    const cleared = (await rate({ fixed: false })).json() as Rated;
    expect(cleared).toMatchObject({ status: 'accepted', fixed: false, fixedAt: null, fixedRef: null });
    expect((await rate({ status: 'rejected' })).statusCode).toBe(200);
    expect((await rate({ fixed: true })).statusCode).toBe(409);
    await rate({ status: 'accepted' });
    await rate({ fixed: true, fixedRef: 'd1eda627' });

    const fixedList = await app.inject({ method: 'GET', url: '/admin/tester/feedback', query: { fixed: 'true' }, cookies: cookies(adminCookie) });
    const row = (fixedList.json() as { feedback: Array<{ id: string; fixed: boolean; status: string; fixedRef: string | null }> }).feedback.find((f) => f.id === id);
    expect(row).toMatchObject({ fixed: true, status: 'fixed', fixedRef: 'd1eda627' });
    // The legacy spelling of the filter still works for older clients.
    const legacy = await app.inject({ method: 'GET', url: '/admin/tester/feedback', query: { status: 'fixed' }, cookies: cookies(adminCookie) });
    expect((legacy.json() as { feedback: Array<{ id: string }> }).feedback.some((f) => f.id === id)).toBe(true);
    const mine = await app.inject({ method: 'GET', url: '/tester/feedback', cookies: cookies(cookie) });
    expect((mine.json() as { feedback: Array<{ id: string; status: string; fixedAt: string | null }> }).feedback.find((f) => f.id === id))
      .toMatchObject({ status: 'fixed' });
  });

  it('stamps reports as exported once, filters on it, and a re-export keeps the first stamp', async () => {
    // WHY: the owner exports feedback as text for people outside the game and
    // needs to see which reports already went out; the stamp lives on the
    // server so it holds across devices.
    const kp = await makeKeypair();
    await login(kp);
    const a = await feedback(kp.wallet);
    const b = await feedback(kp.wallet);
    const exported = (await app.inject({
      method: 'POST', url: '/admin/tester/feedback/exported', cookies: cookies(adminCookie), payload: { ids: [a] },
    })).json() as { stamped: number; rows: Array<{ id: string; exportedAt: string | null }> };
    expect(exported.stamped).toBe(1);
    const first = exported.rows.find((r) => r.id === a)!.exportedAt;
    expect(first).toBeTruthy();
    const again = (await app.inject({
      method: 'POST', url: '/admin/tester/feedback/exported', cookies: cookies(adminCookie), payload: { ids: [a, b] },
    })).json() as { stamped: number; rows: Array<{ id: string; exportedAt: string | null }> };
    expect(again.stamped).toBe(1);
    expect(again.rows.find((r) => r.id === a)!.exportedAt).toBe(first);
    const notExported = await app.inject({ method: 'GET', url: '/admin/tester/feedback', query: { exported: 'false' }, cookies: cookies(adminCookie) });
    const ids = (notExported.json() as { feedback: Array<{ id: string }> }).feedback.map((f) => f.id);
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(b);
    expect((await app.inject({ method: 'POST', url: '/admin/tester/feedback/exported', cookies: cookies(adminCookie), payload: { ids: [] } })).statusCode).toBe(400);
  });
});

// --- purge FK order ------------------------------------------------------------------

describe.sequential('purge scripts', () => {
  it('purgeSyntheticAccount deletes tester_daily_points with the other wallet state (the FK to players would otherwise abort it)', async () => {
    const prevMail = process.env['MAIL_DELIVERY_ENABLED'];
    process.env['MAIL_DELIVERY_ENABLED'] = 'false';
    const bot = await createTestPlayer(db);
    try {
      const baseId = await ensureWalletBaseIdentity(db, bot.wallet, { createEmpty: true });
      await ensureStartingBase(db, bot.wallet, baseId ?? undefined);
    } finally {
      if (prevMail === undefined) delete process.env['MAIL_DELIVERY_ENABLED']; else process.env['MAIL_DELIVERY_ENABLED'] = prevMail;
    }
    await db.insert(sessions).values({ wallet: bot.wallet, expiresAt: new Date(Date.now() + 3_600_000) });
    await chat(bot.wallet);
    await recompute(bot.wallet);
    expect((await rowsFor(bot.wallet)).size).toBeGreaterThan(0);
    await db.update(players).set({ createdAt: new Date('2026-06-12T10:00:00Z'), lastSeenAt: null }).where(eq(players.wallet, bot.wallet));
    const result = await purgeSyntheticAccount(db, bot.wallet);
    expect(result).not.toBeNull();
    expect(result!.rowsDeleted['tester_daily_points']).toBeGreaterThan(0);
    expect(await db.select().from(testerDailyPoints).where(eq(testerDailyPoints.wallet, bot.wallet))).toHaveLength(0);
    expect((await db.select().from(players).where(eq(players.wallet, bot.wallet)))[0]).toBeTruthy();
  });
});

// --- review 2026-09-04: the exploits the adversarial pass found -----------------

describe('daily points cannot be farmed without an opponent, a real action or ownership', () => {
  it('never pays the capped PvP source for camp or campaign wins, even through their battle records', async () => {
    // WHY: campaign stages are free and replayable. resolveRaid writes an
    // attacker battle record for EVERY raid, PvE included; if that record alone
    // counted, twenty campaign replays would pay the largest daily source
    // (20 wins × 2) with no other player involved.
    const p = (await createTestPlayer(db)).wallet;
    const pBase = await newBase(p);
    for (let i = 0; i < 20; i++) {
      const [r] = await db.insert(raids).values({
        attackerWallet: p, attackerBaseId: pBase, campaignStage: 1, seed: 1n, snapshot: {}, armySnapshot: {}, orders: {},
        ordersDeadlineAt: NOW, status: 'resolved', resolvedAt: NOW, result: { stars: 3, destructionPct: 100 },
      }).returning({ id: raids.id });
      await db.insert(baseBattleRecords).values({
        baseId: pBase, raidId: r!.id, role: 'attacker', ownerWalletAtBattle: p, counterpartyBaseId: null,
        stars: 3, destructionPct: 100, createdAt: NOW,
      });
    }
    await recompute(p);
    const rows = await rowsFor(p);
    expect(rows.has('pvp_win')).toBe(false);
    expect(rows.get('pve_battle')).toMatchObject({ count: 20, points: SRC('pve_battle').points });
  });

  it('a zero-star campaign attempt is not a battle day (the proof-of-play rule markRaidAction already applies)', async () => {
    const p = (await createTestPlayer(db)).wallet;
    await db.insert(raids).values({
      attackerWallet: p, campaignStage: 3, seed: 1n, snapshot: {}, armySnapshot: {}, orders: {},
      ordersDeadlineAt: NOW, status: 'resolved', resolvedAt: NOW, result: { stars: 0, destructionPct: 4 },
    });
    await recompute(p);
    expect((await rowsFor(p)).size).toBe(0);
  });

  it('a held defence pays its own points but never makes the day played, and an instant retreat pays nothing', async () => {
    // WHY: the defender did nothing. If a defence counted as play, an alt
    // could raid a dormant main every day and keep its streak — and its
    // referrer's referral days — alive while the main never signed in.
    const attacker = (await createTestPlayer(db)).wallet;
    const dormant = (await createTestPlayer(db)).wallet;
    await pvpRaid(attacker, dormant, 0);
    await recompute(dormant);
    const held = await rowsFor(dormant);
    expect(held.get('defence_held')).toMatchObject({ count: 1, points: SRC('defence_held').points });
    expect(held.has('played')).toBe(false);
    expect((await testerProgress(db, dormant, { timestamps: true, now: NOW }))!.daily.streakDays).toBe(0);

    const retreatedOn = (await createTestPlayer(db)).wallet;
    await db.insert(raids).values({
      attackerWallet: attacker, defenderWallet: retreatedOn, seed: 1n, snapshot: {}, armySnapshot: {}, orders: {},
      ordersDeadlineAt: NOW, status: 'resolved', resolvedAt: NOW, result: { stars: 0, destructionPct: 0, retreated: true },
    });
    await recompute(retreatedOn);
    expect((await rowsFor(retreatedOn)).size).toBe(0);
  });

  it('a buyer is never credited for the seller\'s actions on a base that changed hands', async () => {
    // WHY: bases.owner_wallet flips to the buyer at once while the base's
    // quest, job and ledger rows keep their timestamps; the three-day lookback
    // would otherwise re-derive the seller's days for the buyer.
    const seller = (await createTestPlayer(db)).wallet;
    const buyer = (await createTestPlayer(db)).wallet;
    const deed = `deed-${randomUUID()}`;
    const base = await newBase(seller, { deedAssetId: deed });
    await questClaim(base, at(0, 9));
    await db.insert(builderJobs).values({ playerWallet: seller, baseId: base, kind: 'upgrade', startedAt: at(0, 9), finishesAt: at(0, 10) });
    await recompute(seller);
    expect((await rowsFor(seller)).get('quest_claimed')).toMatchObject({ count: 1 });

    await db.update(bases).set({ ownerWallet: buyer }).where(eq(bases.id, base));
    await db.insert(baseTransfers).values({
      deedAssetId: deed, fromWallet: seller, toWallet: buyer, priorKeepLevel: 1, priorExpansions: 0,
      buildingsMoved: 0, jobsMoved: 1, shieldsMoved: 0, createdAt: at(0, 11),
    });
    await recompute(buyer);
    expect((await rowsFor(buyer)).size).toBe(0);

    // The buyer's OWN actions on the base from then on do count.
    await questClaim(base, at(0, 13));
    await recompute(buyer);
    expect((await rowsFor(buyer)).get('quest_claimed')).toMatchObject({ count: 1, meta: { baseId: base } });
    // The seller keeps the day it really played (rows are never lowered).
    expect((await rowsFor(seller)).get('quest_claimed')).toMatchObject({ count: 1 });
  });

  it('an upgrade that was started and then cancelled is not a build day (review 2026-09-04)', async () => {
    // WHY: D-104 refunds the exact debit, so start-then-cancel costs nothing.
    // Both signals a build day derives from — the debit ledger row and the
    // builder job — must ignore a cancelled job, or the daily point is free.
    const w = (await createTestPlayer(db)).wallet;
    const debit = await ledger(w, 'build.upgrade');
    const refund = await ledger(w, 'build.upgrade.cancel');
    await db.insert(builderJobs).values({
      playerWallet: w, kind: 'upgrade', startedAt: NOW, finishesAt: NOW, completedAt: NOW,
      paidShardCost: 1n, debitLedgerTxnId: debit.transaction.id, refundLedgerTxnId: refund.transaction.id,
      cancelledAt: NOW, cancelIdempotencyKey: `cancel-${randomUUID()}`,
    });
    await recompute(w);
    expect((await rowsFor(w)).size).toBe(0);
    // A job that is still running (or landed) on the same day counts once.
    await db.insert(builderJobs).values({ playerWallet: w, kind: 'upgrade', startedAt: NOW, finishesAt: NOW });
    await recompute(w);
    expect((await rowsFor(w)).get('build_started')).toMatchObject({ count: 1, points: SRC('build_started').points });
  });

  it('paying to speed up a running job is not a build start', async () => {
    const w = (await createTestPlayer(db)).wallet;
    await ledger(w, 'build.speedup');
    await recompute(w);
    expect((await rowsFor(w)).has('build_started')).toBe(false);
    await ledger(w, 'build.place');
    await recompute(w);
    expect((await rowsFor(w)).get('build_started')).toMatchObject({ count: 1, points: SRC('build_started').points });
  });
});
