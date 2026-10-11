/**
 * Referred-player admission (tester report df3b58bd, 2026-09-16: "the game
 * doesn't let them in after sign up"). What the tests pin and why:
 *  - OPEN playtest (production since 2026-09-08, PLAYTEST_OPEN=true): a
 *    referred friend is admitted by signing in — no code is required, and a
 *    referral code is optional attribution that can neither block nor be
 *    required for entry, on the first or the fifth friend alike;
 *  - CLOSED mode: a friend's KEEP code IS the invite for friend after friend
 *    (bounded per referrer), so "the second friend" is admitted exactly like
 *    the first, and a wrong code admits nobody;
 *  - every code path accepts the code as a human types it (lower-case,
 *    padded) — the legacy /referrals/use route alone compared the raw string
 *    against the stored upper-case code and answered "unknown".
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFERRALS } from '@shardkeep/shared';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { alphaAccess, referrals } from '../src/db/schema';
import { getOrCreateReferralCode } from '../src/game/social';
import { TEST_CONFIG, connectTestDb } from './helpers';

const conn = connectTestDb(); const db = conn.db;
type Kp = { secretKey: Uint8Array; wallet: string };
async function keypair(): Promise<Kp> { const secretKey = utils.randomSecretKey(); return { secretKey, wallet: bs58.encode(await getPublicKeyAsync(secretKey)) }; }
/** SIWS sign-in is open by design; it creates the players row ("sign up"). */
async function signIn(app: FastifyInstance, kp: Kp): Promise<Record<string, string>> {
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
  expect(ch.statusCode).toBe(200);
  const signature = bs58.encode(await signAsync(new TextEncoder().encode((ch.json() as { message: string }).message), kp.secretKey));
  const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: kp.wallet, signature } });
  expect(res.statusCode).toBe(200);
  return { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}
const me = (app: FastifyInstance, cookies: Record<string, string>) => app.inject({ method: 'GET', url: '/me', cookies });

let openApp: FastifyInstance; let gatedApp: FastifyInstance; let referrer: Kp; let code: string;
beforeAll(async () => {
  referrer = await keypair();
  openApp = await buildApp({ ...TEST_CONFIG, PLAYTEST_OPEN: 'true' }, db);
  gatedApp = await buildApp({ ...TEST_CONFIG, ALPHA_WALLETS: [referrer.wallet] }, db);
  await Promise.all([openApp.ready(), gatedApp.ready()]);
  await signIn(openApp, referrer);
  code = await getOrCreateReferralCode(db, referrer.wallet);
});
afterAll(async () => { await openApp.close(); await gatedApp.close(); await conn.sql.end(); });
const typed = (c: string) => `  ${c.toLowerCase()} `;

describe.sequential('referred friend admission', () => {
  it('OPEN playtest: friend after friend is admitted by signing in; the code is optional attribution and never a gate', async () => {
    const friends = [await keypair(), await keypair()];
    for (const [i, friend] of friends.entries()) {
      const cookies = await signIn(openApp, friend);
      // Admitted before any code is mentioned: nothing the friend still has to redeem.
      expect((await me(openApp, cookies)).statusCode).toBe(200);
      // Optional attribution as a human types it, on the current (v1) route …
      const used = await openApp.inject({ method: 'POST', url: '/referrals/v1/use', cookies, payload: { code: typed(code) } });
      expect(used.statusCode).toBe(200);
      expect(used.json()).toMatchObject({ outcome: 'applied', relationship: { referrerWallet: referrer.wallet, refereeWallet: friend.wallet } });
      // … and the second submission of the same code is reported, not refused.
      expect((await openApp.inject({ method: 'POST', url: '/referrals/v1/use', cookies, payload: { code } })).json().outcome).toBe('already_applied');
      expect((await me(openApp, cookies)).statusCode).toBe(200);
      expect(i).toBeLessThan(2);
    }
    const rows = await db.select().from(referrals).where(eq(referrals.referrerWallet, referrer.wallet));
    expect(rows.map((r) => r.refereeWallet).sort()).toEqual(friends.map((f) => f.wallet).sort());
    // Open admission is plain sign-in, so no alpha_access row is ever written for it.
    for (const friend of friends) expect(await db.select().from(alphaAccess).where(eq(alphaAccess.wallet, friend.wallet))).toEqual([]);
  });

  it('OPEN playtest: a wrong code, a used-up window or a stranger still enters — attribution failures cannot lock anyone out', async () => {
    const friend = await keypair(); const cookies = await signIn(openApp, friend);
    const bad = await openApp.inject({ method: 'POST', url: '/referrals/v1/use', cookies, payload: { code: 'KEEP-ZZZZ9' } });
    expect(bad.statusCode).toBe(404); expect(bad.json().error.code).toBe('REFERRAL_CODE_UNKNOWN');
    // The pre-gate route older clients still call: it records attribution under an open playtest
    // and reports the failure truthfully, but /me was never gated on it.
    expect((await openApp.inject({ method: 'POST', url: '/alpha/referral', cookies, payload: { code: 'KEEP-ZZZZ9' } })).statusCode).toBe(404);
    expect((await openApp.inject({ method: 'POST', url: '/alpha/referral', cookies, payload: { code: typed(code) } })).statusCode).toBe(200);
    expect((await me(openApp, cookies)).statusCode).toBe(200);
    expect((await db.select().from(referrals).where(eq(referrals.refereeWallet, friend.wallet)))[0]?.referrerWallet).toBe(referrer.wallet);
  });

  it('legacy /referrals/use accepts the code as typed instead of answering "unknown" for a lower-case paste', async () => {
    const friend = await keypair(); const cookies = await signIn(openApp, friend);
    const used = await openApp.inject({ method: 'POST', url: '/referrals/use', cookies, payload: { code: typed(code) } });
    expect(used.statusCode).toBe(200);
    expect(used.json()).toEqual({ referrer: referrer.wallet });
  });

  it('CLOSED mode: the same code admits the first AND the second friend, and a wrong code admits nobody', async () => {
    const first = await keypair(); const second = await keypair(); const stranger = await keypair();
    for (const friend of [first, second]) {
      const cookies = await signIn(gatedApp, friend);
      const gated = await me(gatedApp, cookies);
      expect(gated.statusCode).toBe(403); expect(gated.json().error.code).toBe('ALPHA_GATED');
      const admitted = await gatedApp.inject({ method: 'POST', url: '/alpha/referral', cookies, payload: { code: typed(code) } });
      expect(admitted.statusCode).toBe(200); expect(admitted.json()).toEqual({ ok: true, wallet: friend.wallet });
      expect((await me(gatedApp, cookies)).statusCode).toBe(200);
      expect((await db.select().from(alphaAccess).where(eq(alphaAccess.wallet, friend.wallet)))[0]).toMatchObject({ source: 'referral' });
      // Redeeming again is harmless (sticky, insert-once), and the friend stays in.
      expect((await gatedApp.inject({ method: 'POST', url: '/alpha/referral', cookies, payload: { code } })).statusCode).toBe(200);
      expect((await me(gatedApp, cookies)).statusCode).toBe(200);
    }
    expect(REFERRALS.maxAlphaAdmissionsPerReferrer).toBeGreaterThanOrEqual(2);
    const cookies = await signIn(gatedApp, stranger);
    const refused = await gatedApp.inject({ method: 'POST', url: '/alpha/referral', cookies, payload: { code: 'KEEP-ZZZZ9' } });
    expect(refused.statusCode).toBe(422); expect(refused.json().error.code).toBe('INVALID_REFERRAL_CODE');
    expect((await me(gatedApp, cookies)).statusCode).toBe(403);
  });
});
