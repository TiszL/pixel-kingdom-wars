/**
 * Tester program (owner 2026-08-21): milestones are DERIVED idempotently from
 * authoritative tables and latched; feedback earns bounded base points plus an
 * admin importance bonus that replaces, never stacks; the public board and
 * per-wallet progress are readable by the landing origin without credentials.
 */
import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  globalChatMessages, referrals, testerFeedback, testerMilestones, troopUnlocks, tutorialProgress,
} from '../src/db/schema';
import { recomputeTesterMilestones, shortWallet } from '../src/game/tester';
import { TEST_CONFIG, connectTestDb } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;      // ADMIN_WALLETS=[admin]
let openApp: FastifyInstance;  // no ADMIN_WALLETS ⇒ admin surface does not exist

async function makeKeypair() {
  const secretKey = utils.randomSecretKey();
  return { secretKey, wallet: bs58.encode(await getPublicKeyAsync(secretKey)) };
}
async function login(target: FastifyInstance, kp: { secretKey: Uint8Array; wallet: string }): Promise<string> {
  const ch = await target.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), kp.secretKey));
  const res = await target.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: kp.wallet, signature } });
  expect(res.statusCode).toBe(200);
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}
const cookies = (c: string) => ({ [SESSION_COOKIE]: c });

let tester: { secretKey: Uint8Array; wallet: string };
let friend: { secretKey: Uint8Array; wallet: string };
let admin: { secretKey: Uint8Array; wallet: string };
let testerCookie: string;
let adminCookie: string;

beforeAll(async () => {
  conn = connectTestDb();
  tester = await makeKeypair();
  friend = await makeKeypair();
  admin = await makeKeypair();
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin.wallet] }, conn.db);
  openApp = await buildApp(TEST_CONFIG, conn.db);
  testerCookie = await login(app, tester);
  await login(app, friend);
  adminCookie = await login(app, admin);
});
afterAll(async () => { await app.close(); await openApp.close(); await conn.sql.end(); });

describe.sequential('tester milestones', () => {
  it('derives signed_in on first look, never double-awards, and latches regressed signals', async () => {
    // WHY: points are the reward for real actions; a recompute must be safe to
    // run any number of times (sweep + on-demand) and a milestone must survive
    // its signal going away (tutorial reset), or the board would flicker.
    const me = await app.inject({ method: 'GET', url: '/tester/me', cookies: cookies(testerCookie) });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { points: number; justEarned: Array<{ key: string; points: number }>; milestones: Array<{ key: string; achievedAt: string | null }> };
    expect(body.justEarned.map((e) => e.key)).toContain('signed_in');
    expect(body.points).toBeGreaterThanOrEqual(5);
    expect(body.milestones.find((m) => m.key === 'signed_in')?.achievedAt).toBeTruthy();

    expect(await recomputeTesterMilestones(conn.db, tester.wallet)).toEqual([]);

    await conn.db.insert(tutorialProgress).values({ playerWallet: tester.wallet, step: 9, completedAt: new Date('2026-08-20T10:00:00Z') })
      .onConflictDoUpdate({ target: tutorialProgress.playerWallet, set: { completedAt: new Date('2026-08-20T10:00:00Z') } });
    const earned = await recomputeTesterMilestones(conn.db, tester.wallet);
    expect(earned.map((e) => e.key)).toEqual(['tutorial_done']);
    expect(earned[0]!.points).toBe(TESTER_PROGRAM.milestones.find((m) => m.key === 'tutorial_done')!.points);
    expect(earned[0]!.achievedAt.toISOString()).toBe('2026-08-20T10:00:00.000Z');

    await conn.db.update(tutorialProgress).set({ completedAt: null }).where(eq(tutorialProgress.playerWallet, tester.wallet));
    expect(await recomputeTesterMilestones(conn.db, tester.wallet)).toEqual([]);
    const latched = await conn.db.select().from(testerMilestones)
      .where(eq(testerMilestones.wallet, tester.wallet));
    expect(latched.map((r) => r.key).sort()).toEqual(['signed_in', 'tutorial_done']);
  });

  it('detects social and unlock signals and ignores grandfathered unlocks', async () => {
    await conn.db.insert(globalChatMessages).values({
      authorWallet: tester.wallet, clientMessageId: randomUUID(), text: 'hello', textHash: 'h',
      authorNameAtSend: '', authorSeekerVerifiedAtSend: false,
    });
    await conn.db.insert(referrals).values({ referrerWallet: tester.wallet, refereeWallet: friend.wallet });
    await conn.db.insert(troopUnlocks).values({ playerWallet: tester.wallet, troop: 'mage', source: 'grandfather' });
    const awards = await recomputeTesterMilestones(conn.db, tester.wallet);
    expect(awards.filter((e) => e.kind === 'milestone').map((e) => e.key).sort()).toEqual(['chat_sent', 'friend_invited']);
    // D-103: the same chat message also marks today in the daily ledger — the
    // one-time milestone and the per-day source derive from one row and agree.
    expect(awards.filter((e) => e.kind === 'daily').map((e) => e.key).sort()).toEqual(['chat_sent', 'played']);
    await conn.db.insert(troopUnlocks).values({ playerWallet: tester.wallet, troop: 'dragon', source: 'item' });
    const earned = (await recomputeTesterMilestones(conn.db, tester.wallet)).map((e) => e.key);
    expect(earned).toEqual(['elite_unlocked']);
    // The referee earns referral_used from the same row.
    expect((await recomputeTesterMilestones(conn.db, friend.wallet)).map((e) => e.key).sort())
      .toEqual(['referral_used', 'signed_in']);
  });

  it('serves public progress by wallet with shortened identity, and rejects unknown/malformed', async () => {
    const res = await app.inject({ method: 'GET', url: '/tester/progress', query: { wallet: tester.wallet } });
    expect(res.statusCode).toBe(200);
    const p = res.json() as { wallet: string; points: number; milestones: Array<{ key: string; achieved: boolean; achievedAt?: string | null }> };
    expect(p.wallet).toBe(shortWallet(tester.wallet));
    expect(p.wallet).not.toBe(tester.wallet);
    expect(p.milestones).toHaveLength(TESTER_PROGRAM.milestones.length);
    expect(p.milestones.find((m) => m.key === 'elite_unlocked')?.achieved).toBe(true);
    expect(p.milestones.find((m) => m.key === 'withdrawal_sent')?.achieved).toBe(false);
    // WHY: anyone can type any wallet here; when it deposited, withdrew or
    // enabled 2FA is not public information. Only the authed /tester/me carries times.
    expect(p.milestones.every((m) => !('achievedAt' in m))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/tester/progress', query: { wallet: (await makeKeypair()).wallet } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/tester/progress', query: { wallet: 'not-a-wallet!' } })).statusCode).toBe(400);
  });
});

describe.sequential('tester feedback', () => {
  const ids: string[] = [];
  it('policy 2 submissions start unawarded and retain the daily spam cap', async () => {
    const cfg = TESTER_PROGRAM.feedback;
    for (let i = 0; i < cfg.dailyMaxSubmissions; i++) {
      const res = await app.inject({
        method: 'POST', url: '/tester/feedback', cookies: cookies(testerCookie),
        payload: { requestId: `submit-${i}`, category: 'bug', title: `Report ${i}`, body: 'The vault stat chip shows SHIELDS twice after an upgrade.', context: { screen: 'base' } },
      });
      expect(res.statusCode, `submission ${i}`).toBe(200);
      const body = res.json() as { id: string; basePoints: number; dailyRemaining: number };
      ids.push(body.id);
      expect(body.basePoints).toBe(0);
    }
    const refused = await app.inject({
      method: 'POST', url: '/tester/feedback', cookies: cookies(testerCookie),
      payload: { requestId: 'over-cap', category: 'idea', title: 'one more', body: 'Please add a night mode to the globe view.' },
    });
    expect(refused.statusCode).toBe(429);
    const invalid = await app.inject({
      method: 'POST', url: '/tester/feedback', cookies: cookies(testerCookie),
      payload: { category: 'bug', title: 'x', body: 'short' },
    });
    expect(invalid.statusCode).toBe(400);
    const mine = await app.inject({ method: 'GET', url: '/tester/feedback', cookies: cookies(testerCookie) });
    expect((mine.json() as { feedback: unknown[] }).feedback).toHaveLength(cfg.dailyMaxSubmissions);
  });

  it('admin rating replaces the bonus, a rejected report keeps only base points, export lists full wallets', async () => {
    const list = await app.inject({ method: 'GET', url: '/admin/tester/feedback', query: { status: 'new' }, cookies: cookies(adminCookie) });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { feedback: Array<{ id: string; wallet: string }> }).feedback;
    expect(rows.some((r) => r.id === ids[0] && r.wallet === tester.wallet)).toBe(true);

    const gated = await app.inject({method:'POST',url:`/admin/tester/feedback/${ids[0]}/rate`,cookies:cookies(adminCookie),payload:{importance:'critical'}});
    expect(gated.statusCode).toBe(409);
    expect(gated.json()).toHaveProperty('error.code','FEEDBACK_REVIEW_UPDATE_REQUIRED');
    // This fixture is historical policy 1: new submissions must never enter the old auto-award path.
    const [historical] = await conn.db.insert(testerFeedback).values({wallet:tester.wallet,category:'bug',title:'historical',body:'historical report',rewardPolicyVersion:1,basePoints:TESTER_PROGRAM.feedback.basePoints,points:TESTER_PROGRAM.feedback.basePoints}).returning();
    const rate = (payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: `/admin/tester/feedback/${historical!.id}/rate`, cookies: cookies(adminCookie), payload,
    });
    const bonus = TESTER_PROGRAM.feedback.importanceBonus;
    expect((await rate({ importance: 'critical', status: 'accepted' })).json()).toMatchObject({
      points: TESTER_PROGRAM.feedback.basePoints + bonus.critical, status: 'accepted', importance: 'critical',
    });
    expect((await rate({ importance: 'medium' })).json()).toMatchObject({
      points: TESTER_PROGRAM.feedback.basePoints + bonus.medium,
    });
    expect((await rate({ status: 'rejected', note: 'not reproducible' })).json()).toMatchObject({
      points: TESTER_PROGRAM.feedback.basePoints, status: 'rejected',
    });

    const denied = await app.inject({ method: 'GET', url: '/admin/tester/export', cookies: cookies(testerCookie) });
    expect(denied.statusCode).toBe(403);
    const absent = await openApp.inject({ method: 'GET', url: '/admin/tester/export', cookies: cookies(await login(openApp, admin)) });
    expect(absent.statusCode).toBe(404);
    const exported = await app.inject({ method: 'GET', url: '/admin/tester/export', cookies: cookies(adminCookie) });
    const testers = (exported.json() as { testers: Array<{ wallet: string; points: number; feedback: number }> }).testers;
    const row = testers.find((t) => t.wallet === tester.wallet);
    expect(row).toBeTruthy();
    expect(row!.feedback).toBe(TESTER_PROGRAM.feedback.dailyMaxSubmissions + 1);
    expect(row!.points).toBeGreaterThan(TESTER_PROGRAM.feedback.basePoints * TESTER_PROGRAM.feedback.dailyPaidSubmissions);
  });
});

describe.sequential('tester board hygiene (owner 2026-08-22)', () => {
  it('lists only wallets that founded a base, never internal or admin-hidden wallets, and ranks among the listed', async () => {
    // WHY: ghost sign-ins and the team's own accounts showed up as "KEEPER"
    // rows; the public board is for real players. Points/progress are
    // untouched — only visibility and rank change.
    const { testerBoardHidden, bases } = await import('../src/db/schema');
    const { randomUUID } = await import('node:crypto');
    const { recomputeTesterMilestones, testerLeaderboard, testerProgress } = await import('../src/game/tester');
    const ghost = await makeKeypair();
    const real = await makeKeypair();
    await login(app, ghost);
    await login(app, real);
    await conn.db.insert(bases).values({ id: randomUUID(), ownerWallet: real.wallet, status: 'active', keepLevel: 1 });
    // A wallet whose only milestones are signed_in + base_founded (a sign-in-once
    // auto-base) is NOT listed; one real action beyond founding (a name) is.
    const { players } = await import('../src/db/schema');
    await recomputeTesterMilestones(conn.db, ghost.wallet);
    await recomputeTesterMilestones(conn.db, real.wallet);
    expect((await testerLeaderboard(conn.db, { limit: 1000 })).entries.some((e) => e.wallet === shortWallet(real.wallet))).toBe(false);
    await conn.db.update(players).set({ name: 'hyg_real', nameKey: 'hyg_real' }).where(eq(players.wallet, real.wallet));
    await recomputeTesterMilestones(conn.db, real.wallet);
    const board = await testerLeaderboard(conn.db, { limit: 1000 });
    expect(board.entries.some((e) => e.wallet === shortWallet(real.wallet))).toBe(true);
    expect(board.entries.some((e) => e.wallet === shortWallet(ghost.wallet))).toBe(false);
    // Tied points rank exactly as the board orders them (points desc, earliest
    // last activity first, wallet asc) — progress and board must agree.
    const real2 = await makeKeypair();
    await login(app, real2);
    await conn.db.insert(bases).values({ id: randomUUID(), ownerWallet: real2.wallet, status: 'active', keepLevel: 1 });
    await conn.db.update(players).set({ name: 'hyg_real2', nameKey: 'hyg_real2' }).where(eq(players.wallet, real2.wallet));
    await recomputeTesterMilestones(conn.db, real2.wallet);
    const tied = await testerLeaderboard(conn.db, { limit: 1000 });
    for (const w of [real.wallet, real2.wallet]) {
      const onBoard = tied.entries.find((e) => e.wallet === shortWallet(w));
      const progress = await testerProgress(conn.db, w, { timestamps: false });
      expect(progress?.rank, w).toBe(onBoard?.rank);
    }
    // Internal wallets (team) are excluded even with a base.
    const internal = await testerLeaderboard(conn.db, { limit: 1000, internalWallets: [real.wallet] });
    expect(internal.entries.some((e) => e.wallet === shortWallet(real.wallet))).toBe(false);
    // Admin hide → gone from the board, rank null, listed false; unhide restores.
    const hide = await app.inject({ method: 'POST', url: '/admin/tester/board/hide', cookies: cookies(adminCookie), payload: { wallet: real.wallet, hidden: true, reason: 'test account' } });
    expect(hide.statusCode).toBe(200);
    expect((await testerLeaderboard(conn.db, { limit: 1000 })).entries.some((e) => e.wallet === shortWallet(real.wallet))).toBe(false);
    const hiddenProgress = await testerProgress(conn.db, real.wallet, { timestamps: false });
    expect(hiddenProgress).toMatchObject({ listed: false, rank: null });
    expect(hiddenProgress!.points).toBeGreaterThan(0);
    const listed = await app.inject({ method: 'GET', url: '/admin/tester/board/hidden', cookies: cookies(adminCookie) });
    expect((listed.json() as { hidden: Array<{ wallet: string }> }).hidden.some((h) => h.wallet === real.wallet)).toBe(true);
    await app.inject({ method: 'POST', url: '/admin/tester/board/hide', cookies: cookies(adminCookie), payload: { wallet: real.wallet, hidden: false } });
    expect((await testerProgress(conn.db, real.wallet, { timestamps: false }))?.listed).toBe(true);
    await conn.db.delete(testerBoardHidden).where(eq(testerBoardHidden.wallet, real.wallet));
  });
});

describe('tester leaderboard is public and CORS-open to the landing origin only where intended', () => {
  it('lists the tester with a shortened wallet, allows the landing origin on public reads, and never on authed routes', async () => {
    const origin = 'https://pixelkingdomwars.com';
    // The public board lists only base-founding wallets (hygiene test above):
    // give the tester a base and re-derive before reading the board.
    const { bases } = await import('../src/db/schema');
    const { randomUUID } = await import('node:crypto');
    await conn.db.insert(bases).values({ id: randomUUID(), ownerWallet: tester.wallet, status: 'active', keepLevel: 1 });
    // One action beyond founding (finishing the tutorial) makes the wallet
    // listable without giving it a name — the board must still show a null name.
    const { tutorialProgress } = await import('../src/db/schema');
    await conn.db.insert(tutorialProgress).values({ playerWallet: tester.wallet, step: 1, completedAt: new Date() })
      .onConflictDoUpdate({ target: tutorialProgress.playerWallet, set: { completedAt: new Date() } });
    await recomputeTesterMilestones(conn.db, tester.wallet);
    const board = await app.inject({ method: 'GET', url: '/tester/leaderboard', headers: { origin } });
    expect(board.statusCode).toBe(200);
    expect(board.headers['access-control-allow-origin']).toBe(origin);
    const body = board.json() as { entries: Array<{ wallet: string; points: number; name: string | null; rank: number }>; totals: { testers: number } };
    const mine = body.entries.find((e) => e.wallet === shortWallet(tester.wallet));
    expect(mine).toBeTruthy();
    expect(mine!.name).toBeNull();
    expect(body.entries.every((e) => !e.wallet.includes(tester.wallet))).toBe(true);
    expect(body.totals.testers).toBeGreaterThanOrEqual(1);
    // Sorted by points descending, ranks contiguous.
    body.entries.forEach((e, i) => { expect(e.rank).toBe(i + 1); if (i > 0) expect(e.points).toBeLessThanOrEqual(body.entries[i - 1]!.points); });

    const me = await app.inject({ method: 'GET', url: '/tester/me', headers: { origin }, cookies: cookies(testerCookie) });
    expect(me.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({ method: 'OPTIONS', url: '/tester/progress', headers: { origin, 'access-control-request-method': 'GET' } });
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(String(preflight.headers['access-control-allow-credentials'] ?? '')).not.toBe('true');
  });
});
