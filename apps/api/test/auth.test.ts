/**
 * SIWS auth-flow tests (ARCHITECTURE §5).
 *
 * WHY: the wallet IS the identity (GDD §4.9) — a forged signature or a
 * replayed nonce is full account takeover, so both must hard-fail.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { ECONOMY, TWOFA } from '@shardkeep/shared';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { accounts, authNonces, players, sessions } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger/accounts';
import { lockWithdrawalWalletTx } from '../src/money/withdrawalLock';
import {
  RECENT_AUTH_HEADER, SESSION_COOKIE, assertRecentAuth, type RecentAuthPurpose,
  type RecentAuthIntent, type WithdrawalRecentAuthIntent, verifyActiveSession,
} from '../src/auth/session';
import { TEST_CONFIG, connectTestDb } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;

beforeAll(async () => {
  conn = connectTestDb();
  app = await buildApp(TEST_CONFIG, conn.db);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

async function makeKeypair() {
  const secretKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(secretKey);
  return { secretKey, wallet: bs58.encode(publicKey) };
}

async function getChallenge(wallet: string) {
  const res = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  expect(res.statusCode).toBe(200);
  return res.json() as { nonce: string; message: string };
}

async function signMessage(message: string, secretKey: Uint8Array) {
  const sig = await signAsync(new TextEncoder().encode(message), secretKey);
  return bs58.encode(sig);
}

async function recentGrant(input: {
  wallet: string;
  secretKey: Uint8Array;
  cookie: string;
  purpose: RecentAuthPurpose;
  intent?: RecentAuthIntent;
}): Promise<string> {
  const challenge = await app.inject({
    method: 'POST', url: '/auth/reauth/challenge',
    cookies: { [SESSION_COOKIE]: input.cookie },
    payload: { purpose: input.purpose, ...(input.intent ? { intent: input.intent } : {}) },
  });
  expect(challenge.statusCode).toBe(200);
  const c = challenge.json() as { challengeToken: string; message: string };
  const verified = await app.inject({
    method: 'POST', url: '/auth/reauth/verify',
    cookies: { [SESSION_COOKIE]: input.cookie },
    payload: {
      challengeToken: c.challengeToken,
      signature: await signMessage(c.message, input.secretKey),
    },
  });
  expect(verified.statusCode).toBe(200);
  return (verified.json() as { grant: string }).grant;
}

describe('auth flow', () => {
  it('challenge → verify → authed request succeeds and upserts the player', async () => {
    const { secretKey, wallet } = await makeKeypair();
    const { message } = await getChallenge(wallet);

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { wallet, signature: await signMessage(message, secretKey) },
    });
    expect(verify.statusCode).toBe(200);
    // entryPaid: false — auth is identity only; the base arrives with the
    // on-chain entry payment (R9), never at login.
    expect(verify.json()).toEqual({ wallet, entryPaid: false });

    const cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);

    // players row created on first verify
    const rows = await conn.db.select().from(players).where(eq(players.wallet, wallet));
    expect(rows).toHaveLength(1);

    // the cookie authenticates requests
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie!.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json().wallet).toBe(wallet);

    // A flag-off server must advertise the same legacy-only surface it serves;
    // the web uses these bits to hide activation and exact-cell purchase UI.
    const directory = await app.inject({
      url: '/bases', cookies: { [SESSION_COOKIE]: cookie!.value },
    });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toMatchObject({
      enabled: false,
      nextLandPurchaseKind: 'entry',
      capabilities: {
        baseScopedReads: false,
        baseScopedMutations: false,
        cellReservations: false,
      },
    });

    // second login for the same wallet must not duplicate the player
    const again = await getChallenge(wallet);
    const verify2 = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { wallet, signature: await signMessage(again.message, secretKey) },
    });
    expect(verify2.statusCode).toBe(200);
    expect(await conn.db.select().from(players).where(eq(players.wallet, wallet))).toHaveLength(1);
  });

  it('creates the session without putting a third-party Seeker RPC on the sign-in path', async () => {
    const seekerFetch = vi.fn(async () => {
      throw new Error('sign-in must not call mainnet');
    }) as unknown as typeof fetch;
    const isolated = await buildApp(TEST_CONFIG, conn.db, { seekerFetch });
    await isolated.ready();
    try {
      const { secretKey, wallet } = await makeKeypair();
      const challenge = await isolated.inject({
        method: 'GET', url: '/auth/challenge', query: { wallet },
      });
      const verify = await isolated.inject({
        method: 'POST', url: '/auth/verify',
        payload: {
          wallet,
          signature: await signMessage(
            (challenge.json() as { message: string }).message,
            secretKey,
          ),
        },
      });

      expect(verify.statusCode).toBe(200);
      expect(verify.cookies.find((c) => c.name === SESSION_COOKIE)).toBeDefined();
      expect(seekerFetch).not.toHaveBeenCalled();
    } finally {
      await isolated.close();
    }
  });

  async function login(): Promise<{ wallet: string; cookie: string; secretKey: Uint8Array }> {
    const { secretKey, wallet } = await makeKeypair();
    const { message } = await getChallenge(wallet);
    const verify = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, signature: await signMessage(message, secretKey) },
    });
    return { wallet, secretKey, cookie: verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  }

  it('PATCH /me sets a validated username; rejects empty/long/illegal names', async () => {
    const { wallet, cookie } = await login();
    // CHARSET NARROWED 2026-07-29 (was `[A-Za-z0-9 ._-]{1,20}`): spaces and dots
    // are now banned so a self-chosen name can never be confused with a verified
    // `x.skr` domain name, and names are unique case-insensitively. See
    // USERNAMES in @shardkeep/shared + test/seeker.test.ts for the full rules.
    const name = `Sir_Reginald_${Date.now().toString(36).slice(-3)}`.slice(0, 16);
    const ok = await app.inject({
      method: 'PATCH', url: '/me', cookies: { [SESSION_COOKIE]: cookie }, payload: { name },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe(name);
    // Persisted + reflected by GET /me.
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.json().name).toBe(name);
    const [row] = await conn.db.select().from(players).where(eq(players.wallet, wallet));
    expect(row!.name).toBe(name);
    // Post-trim empty, too short, over-length, illegal charset, and the newly
    // banned space/dot forms all hard-fail.
    for (const bad of ['', '   ', 'ab', 'x'.repeat(17), 'bad<script>', 'Sir Reginald', 'some.name']) {
      const res = await app.inject({
        method: 'PATCH', url: '/me', cookies: { [SESSION_COOKIE]: cookie }, payload: { name: bad },
      });
      expect(res.statusCode, `name=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('POST /auth/logout clears the cookie and revokes the wallet session', async () => {
    const { wallet, cookie } = await login();
    const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { [SESSION_COOKIE]: cookie } });
    expect(out.statusCode).toBe(200);
    // The Set-Cookie in the response clears the session (empty value).
    const cleared = out.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe('');
    // The session row is revoked (audit trail).
    const [s] = await conn.db.select().from(sessions).where(eq(sessions.wallet, wallet));
    expect(s!.revokedAt).not.toBeNull();
    // The browser cleared its copy, but an attacker may have retained the exact
    // cookie. DB revocation must reject that stolen token immediately rather
    // than trusting its still-valid seven-day JWT expiry.
    const stolen = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(stolen.statusCode).toBe(401);
    // Pre-alpha routes deliberately bypass the alpha gate, not session
    // revocation. They must reject the same stolen cookie too.
    const redeem = await app.inject({
      method: 'POST', url: '/alpha/redeem',
      cookies: { [SESSION_COOKIE]: cookie }, payload: { code: 'not-a-real-code' },
    });
    expect(redeem.statusCode).toBe(401);
    const seekerLink = await app.inject({
      method: 'POST', url: '/seeker/link/challenge',
      cookies: { [SESSION_COOKIE]: cookie }, payload: { seekerWallet: wallet },
    });
    expect(seekerLink.statusCode).toBe(401);
  });

  it('rejects a DB-expired session even while its signed JWT is still live', async () => {
    const { wallet, cookie } = await login();
    await conn.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(sessions.wallet, wallet));
    expect((await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(401);
  });

  it('rejects a bad signature', async () => {
    const { secretKey, wallet } = await makeKeypair();
    await getChallenge(wallet);

    // valid 64-byte signature — but over the WRONG message
    const forged = await signMessage('SHARDKEEP login? sure, trust me', secretKey);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { wallet, signature: forged },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects a signature from a different wallet's key", async () => {
    const victim = await makeKeypair();
    const attacker = await makeKeypair();
    const { message } = await getChallenge(victim.wallet);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { wallet: victim.wallet, signature: await signMessage(message, attacker.secretKey) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('reuses one active challenge so anonymous requests cannot preempt a signed login', async () => {
    const { secretKey, wallet } = await makeKeypair();
    const responses = await Promise.all(Array.from({ length: 12 }, () => app.inject({
      method: 'GET', url: '/auth/challenge', query: { wallet },
    })));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[0]!.headers['cache-control']).toBe('no-store');

    const challenges = responses.map((response) => response.json() as {
      nonce: string; message: string; expiresAt: string;
    });
    expect(new Set(challenges.map((challenge) => challenge.nonce)).size).toBe(1);
    expect(new Set(challenges.map((challenge) => challenge.message)).size).toBe(1);
    expect(new Set(challenges.map((challenge) => challenge.expiresAt)).size).toBe(1);
    expect(await conn.db.select().from(authNonces).where(eq(authNonces.wallet, wallet)))
      .toHaveLength(1);

    const challenge = challenges[0]!;
    const verify = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: {
        wallet,
        nonce: challenge.nonce,
        signature: await signMessage(challenge.message, secretKey),
      },
    });
    expect(verify.statusCode).toBe(200);
  });

  it('binds verification to the supplied nonce without consuming another challenge', async () => {
    const { secretKey, wallet } = await makeKeypair();
    const challenge = await getChallenge(wallet);
    const signature = await signMessage(challenge.message, secretKey);

    const unknown = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, nonce: '0'.repeat(48), signature },
    });
    expect(unknown.statusCode).toBe(401);

    const exact = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, nonce: challenge.nonce, signature },
    });
    expect(exact.statusCode).toBe(200);
  });

  it('rotates only after the active challenge expires', async () => {
    const { wallet } = await makeKeypair();
    const first = await getChallenge(wallet);
    await conn.db.update(authNonces)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(authNonces.nonce, first.nonce));

    const second = await getChallenge(wallet);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.message).not.toBe(first.message);
  });

  it('atomically grants exactly one session for concurrent verifies', async () => {
    const { secretKey, wallet } = await makeKeypair();
    const challenge = await getChallenge(wallet);
    const payload = {
      wallet,
      nonce: challenge.nonce,
      signature: await signMessage(challenge.message, secretKey),
    };

    const responses = await Promise.all(Array.from({ length: 2 }, () => app.inject({
      method: 'POST', url: '/auth/verify', payload,
    })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  });

  it('serializes the nonce consume and session insert behind the recovery wallet lock', async () => {
    const { secretKey, wallet } = await makeKeypair();
    const challenge = await getChallenge(wallet);
    const signature = await signMessage(challenge.message, secretKey);
    let ownsLock!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { ownsLock = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = conn.db.transaction(async (tx) => {
      await lockWithdrawalWalletTx(tx, wallet);
      ownsLock();
      await release;
    });
    await locked;

    const verifying = app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, nonce: challenge.nonce, signature },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await conn.db.select().from(sessions).where(eq(sessions.wallet, wallet)))
      .toHaveLength(0);

    releaseLock();
    await holder;
    expect((await verifying).statusCode).toBe(200);
    expect(await conn.db.select().from(sessions).where(eq(sessions.wallet, wallet)))
      .toHaveLength(1);
  });

  it('nonces are single-use: replaying a successful verify fails', async () => {
    const { secretKey, wallet } = await makeKeypair();
    const { message } = await getChallenge(wallet);
    const signature = await signMessage(message, secretKey);

    const first = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    expect(first.statusCode).toBe(200);

    // exact replay — nonce already consumed
    const replay = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects unauthenticated and garbage-cookie requests', async () => {
    expect((await app.inject({ url: '/me' })).statusCode).toBe(401);
    const garbage = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: 'not-a-jwt' } });
    expect(garbage.statusCode).toBe(401);
  });

  it('rejects malformed wallets on challenge', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/challenge',
      query: { wallet: 'IlO0-not-base58-at-all-IlO0-not-base58-h' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('export gate (/auth/export/challenge): unenrolled passes through, enrolled requires a LIVE code — and a miss is 422, never 401', async () => {
    // WHY three pins in one flow (ONRAMP-WALLETS-PLAN Flow B):
    //  1. gated:false for an unenrolled player is a DOCUMENTED trade-off
    //     (routes.ts) — inverting it would silently lock users out of their key.
    //  2. enrolled + missing/wrong code must DENY — inverting it would disable
    //     the export gate entirely (audit B5: this branch had zero coverage).
    //  3. the deny must be 422, not 401 — the client force-logs-out on any
    //     authed 401, so a mistyped code read as "session expired" (audit A7).
    const { secretKey, wallet } = await makeKeypair();
    const { message } = await getChallenge(wallet);
    const verify = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, signature: await signMessage(message, secretKey) },
    });
    const cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const grant = await recentGrant({ wallet, secretKey, cookie, purpose: 'key_export' });

    // (1) nothing enrolled → pass-through, gated:false
    const open = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ exportOk: true, gated: false });

    // enroll TOTP (same primitive the withdrawal gate uses)
    const { enrollTotp, verifyTotpEnroll } = await import('../src/auth/twofa');
    const { Secret, TOTP } = await import('otpauth');
    const { secret } = await enrollTotp(conn.db, wallet);
    const totp = new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
    // Enrollment proofs are themselves single-use. Enroll with the adjacent
    // accepted step so the current live step below is a distinct proof.
    await verifyTotpEnroll(conn.db, wallet, totp.generate({ timestamp: Date.now() - 30_000 }));

    // (2)+(3) enrolled: no code → 422; wrong code → 422; NEVER 401
    const noCode = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    expect(noCode.statusCode).toBe(422);
    const badCode = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: { method: 'totp', code: '000000' },
    });
    expect(badCode.statusCode).toBe(422);

    // valid live code → gated:true
    const liveCode = totp.generate();
    const good = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: { method: 'totp', code: liveCode },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ exportOk: true, gated: true });

    // REPLAY of the exact accepted code → 422. This pins that the route is
    // wired to the SINGLE-USE verifier (verifyWithdrawal2fa, totpLastUsedStep) —
    // a refactor onto the stateless checkTotp would keep every assertion above
    // green while turning the gate into an infinitely-replayable TOTP oracle
    // (security review B5 #1).
    const replay = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: { method: 'totp', code: liveCode },
    });
    expect(replay.statusCode).toBe(422);

    // email method through the SAME route: a withdraw-purpose code is accepted
    // once and consumed (twofa.test.ts pins the primitive; this pins the wiring).
    const { sendWithdrawEmailCode, withdrawalEmailChallengeContext } = await import('../src/auth/twofa');
    await conn.db.update(players)
      .set({ email: 'export-gate@test.local', emailVerified: true })
      .where(eq(players.wallet, wallet));
    const identity = await verifyActiveSession(TEST_CONFIG, conn.db, cookie);
    const { devCode } = await sendWithdrawEmailCode(
      conn.db, wallet, async () => {}, undefined,
      JSON.stringify(['key-export:v1', identity.sessionId]), 'private_key_export',
    );
    const viaEmail = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: { method: 'email', code: devCode! },
    });
    expect(viaEmail.statusCode).toBe(200);
    const emailReplay = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: { method: 'email', code: devCode! },
    });
    expect(emailReplay.statusCode).toBe(422); // consumed — single-use holds via the route

    // A code issued for the withdrawal surface is not an export code, even for
    // the same wallet/session. Context separation survives sharing one table.
    const { devCode: withdrawalCode } = await sendWithdrawEmailCode(
      conn.db, wallet, async () => {}, new Date(Date.now() + 61_000),
      withdrawalEmailChallengeContext({
        amount: '1000', destination: wallet, idempotencyKey: 'export-cross-purpose',
        sessionId: identity.sessionId,
      }), 'account_security_change',
    );
    const crossPurpose = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: grant },
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { method: 'email', code: withdrawalCode! },
    });
    expect(crossPurpose.statusCode).toBe(422);
  });

  it('sends private-key export copy that cannot be mistaken for withdrawal authorization', async () => {
    const owner = await login();
    await conn.db.update(players).set({
      email: 'export-copy@example.com', emailVerified: true,
    }).where(eq(players.wallet, owner.wallet));
    const deliveries: Array<{ to: string; subject: string; body: string }> = [];
    const isolated = await buildApp(TEST_CONFIG, conn.db, {
      emailSender: async (to, subject, body) => { deliveries.push({ to, subject, body }); },
    });
    try {
      await isolated.ready();
      const sent = await isolated.inject({
        method: 'POST', url: '/auth/export/send-code',
        cookies: { [SESSION_COOKIE]: owner.cookie }, payload: {},
      });
      expect(sent.statusCode).toBe(200);
      const message = deliveries.at(-1)!;
      const code = message.body.match(/\b(\d{6})\b/)![1]!;
      const mins = Math.round(TWOFA.emailCodeTtlSec / 60);
      expect(message).toEqual({
        to: 'export-copy@example.com',
        subject: 'Confirm your Pixel Kingdom Wars private key export',
        body: `Your Pixel Kingdom Wars private key export code is ${code}. It expires in ${mins} minutes. Only enter it when exporting your private key. This code cannot authorize a withdrawal.`,
      });
    } finally {
      await isolated.close();
    }
  });

  it('maps an email-provider timeout to a logged, sanitized 503', async () => {
    const owner = await login();
    await conn.db.update(players).set({
      email: 'export-timeout@example.com', emailVerified: true,
    }).where(eq(players.wallet, owner.wallet));
    const providerDetail = 'Resend timeout upstream-token=must-not-reach-client';
    const failure = Object.assign(new Error(providerDetail), { name: 'AbortError' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const isolated = await buildApp(TEST_CONFIG, conn.db, {
      emailSender: async () => { throw failure; },
    });
    try {
      await isolated.ready();
      const sent = await isolated.inject({
        method: 'POST', url: '/auth/export/send-code',
        cookies: { [SESSION_COOKIE]: owner.cookie }, payload: {},
      });
      expect(sent.statusCode).toBe(503);
      expect(sent.json()).toEqual({
        error: {
          code: 'EMAIL_DELIVERY_UNAVAILABLE',
          message: 'email delivery is unavailable — try again shortly',
        },
      });
      expect(sent.body).not.toContain(providerDetail);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(providerDetail));
    } finally {
      log.mockRestore();
      await isolated.close();
    }
  });

  it('recent auth is required, purpose-bound, session-bound and tamper-evident', async () => {
    const { wallet, secretKey, cookie } = await login();

    const missing = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json().error.code).toBe('RECENT_AUTH_REQUIRED');

    const wrongPurpose = await recentGrant({
      wallet, secretKey, cookie, purpose: 'factor_change',
    });
    const purposeDenied = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: wrongPurpose },
      cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    expect(purposeDenied.statusCode).toBe(428);

    const exportGrant = await recentGrant({ wallet, secretKey, cookie, purpose: 'key_export' });
    // Token classes are not interchangeable even though both use the server's
    // HS256 key. In particular a recent-auth jti is not a DB session UUID.
    const grantAsCookie = await app.inject({
      url: '/me', cookies: { [SESSION_COOKIE]: exportGrant },
    });
    expect(grantAsCookie.statusCode).toBe(401);
    // Change a signature character with full payload bits behind it. The final
    // base64url character can carry unused low bits, so changing only that char
    // is not reliably a byte-level tamper for every signature length.
    const [grantHeader, grantPayload, grantSignature] = exportGrant.split('.') as [string, string, string];
    const tamperAt = Math.floor(grantSignature.length / 2);
    const changedSignature = `${grantSignature.slice(0, tamperAt)}${grantSignature[tamperAt] === 'A' ? 'B' : 'A'}${grantSignature.slice(tamperAt + 1)}`;
    const tampered = `${grantHeader}.${grantPayload}.${changedSignature}`;
    const tamperDenied = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: tampered },
      cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    expect(tamperDenied.statusCode).toBe(428);

    // A second login for the SAME wallet is a distinct DB session. A capability
    // from the first browser must not authorize the second one.
    const secondChallenge = await getChallenge(wallet);
    const secondLogin = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, signature: await signMessage(secondChallenge.message, secretKey) },
    });
    const secondCookie = secondLogin.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const sessionDenied = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: exportGrant },
      cookies: { [SESSION_COOKIE]: secondCookie }, payload: {},
    });
    expect(sessionDenied.statusCode).toBe(428);

    // The grant remains valid for the exact session + purpose it names.
    const exact = await app.inject({
      method: 'POST', url: '/auth/export/challenge',
      headers: { [RECENT_AUTH_HEADER]: exportGrant },
      cookies: { [SESSION_COOKIE]: cookie }, payload: {},
    });
    expect(exact.statusCode).toBe(200);
  });

  it('instant-withdraw recent auth is bound to amount, destination and idempotency key', async () => {
    const { wallet, secretKey, cookie } = await login();
    const intent: WithdrawalRecentAuthIntent = {
      version: 1,
      grossAmount: '2500',
      feeBurned: '50',
      netAmount: '2450',
      cluster: TEST_CONFIG.SOLANA_CLUSTER,
      keepMint: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC',
      destination: wallet,
      idempotencyKey: `withdraw-${Date.now()}-bound`,
      mode: 'instant',
      unbondingHours: 0,
    };
    const grant = await recentGrant({
      wallet, secretKey, cookie, purpose: 'withdrawal', intent,
    });
    const identity = await verifyActiveSession(TEST_CONFIG, conn.db, cookie);
    const req = {
      headers: { [RECENT_AUTH_HEADER]: grant },
      wallet,
      sessionId: identity.sessionId,
    } as unknown as FastifyRequest;

    await expect(assertRecentAuth(TEST_CONFIG, req, 'withdrawal', intent)).resolves.toBeUndefined();
    await expect(assertRecentAuth(TEST_CONFIG, req, 'withdrawal', {
      ...intent, grossAmount: '2501', netAmount: '2451',
    })).rejects.toMatchObject({ statusCode: 428, code: 'RECENT_AUTH_REQUIRED' });
    await expect(assertRecentAuth(TEST_CONFIG, req, 'withdrawal', {
      ...intent, destination: (await makeKeypair()).wallet,
    })).rejects.toMatchObject({ statusCode: 428, code: 'RECENT_AUTH_REQUIRED' });
    await expect(assertRecentAuth(TEST_CONFIG, req, 'withdrawal', {
      ...intent, idempotencyKey: `${intent.idempotencyKey}-retry`,
    })).rejects.toMatchObject({ statusCode: 428, code: 'RECENT_AUTH_REQUIRED' });
  });

  it('binds authenticator recovery proof to the exact UUID, action, and session', async () => {
    const owner = await login();
    const recoveryId = crypto.randomUUID();
    const intent = { recoveryId, action: 'start' as const };
    const grant = await recentGrant({
      wallet: owner.wallet, secretKey: owner.secretKey, cookie: owner.cookie,
      purpose: 'totp_recovery', intent,
    });
    const identity = await verifyActiveSession(TEST_CONFIG, conn.db, owner.cookie);
    const req = {
      headers: { [RECENT_AUTH_HEADER]: grant },
      wallet: owner.wallet,
      sessionId: identity.sessionId,
    } as unknown as FastifyRequest;
    await expect(assertRecentAuth(TEST_CONFIG, req, 'totp_recovery', intent))
      .resolves.toBeUndefined();
    await expect(assertRecentAuth(TEST_CONFIG, req, 'totp_recovery', {
      recoveryId, action: 'complete',
    })).rejects.toMatchObject({ statusCode: 428, code: 'RECENT_AUTH_REQUIRED' });
    await expect(assertRecentAuth(TEST_CONFIG, req, 'totp_recovery', {
      recoveryId: crypto.randomUUID(), action: 'start',
    })).rejects.toMatchObject({ statusCode: 428, code: 'RECENT_AUTH_REQUIRED' });

    const secondChallenge = await getChallenge(owner.wallet);
    const second = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: {
        wallet: owner.wallet,
        signature: await signMessage(secondChallenge.message, owner.secretKey),
      },
    });
    const secondCookie = second.cookies.find((cookie) => cookie.name === SESSION_COOKIE)!.value;
    const secondIdentity = await verifyActiveSession(TEST_CONFIG, conn.db, secondCookie);
    const wrongSessionReq = {
      headers: { [RECENT_AUTH_HEADER]: grant },
      wallet: owner.wallet,
      sessionId: secondIdentity.sessionId,
    } as unknown as FastifyRequest;
    await expect(assertRecentAuth(TEST_CONFIG, wrongSessionReq, 'totp_recovery', intent))
      .rejects.toMatchObject({ statusCode: 428, code: 'RECENT_AUTH_REQUIRED' });
  });

  it('refuses withdrawal challenges for a different cluster or KEEP mint', async () => {
    const { wallet, cookie } = await login();
    const intent: WithdrawalRecentAuthIntent = {
      version: 1, grossAmount: '1000', feeBurned: '20', netAmount: '980',
      cluster: 'devnet', keepMint: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC',
      destination: wallet, idempotencyKey: `withdraw-${Date.now()}-network`,
      mode: 'standard', unbondingHours: ECONOMY.unbondingHours,
    };
    for (const changed of [
      { ...intent, cluster: 'mainnet-beta' as const },
      { ...intent, keepMint: '11111111111111111111111111111111' },
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/auth/reauth/challenge',
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { purpose: 'withdrawal', intent: changed },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toMatch(/network does not match/);
    }
  });

  it('recent-auth proof rejects the wrong wallet signer and expires from challenge issue time', async () => {
    const owner = await login();
    const attacker = await makeKeypair();
    const challenge = await app.inject({
      method: 'POST', url: '/auth/reauth/challenge',
      cookies: { [SESSION_COOKIE]: owner.cookie }, payload: { purpose: 'key_export' },
    });
    const body = challenge.json() as { challengeToken: string; message: string };
    const forged = await app.inject({
      method: 'POST', url: '/auth/reauth/verify',
      cookies: { [SESSION_COOKIE]: owner.cookie },
      payload: {
        challengeToken: body.challengeToken,
        signature: await signMessage(body.message, attacker.secretKey),
      },
    });
    expect(forged.statusCode).toBe(422); // valid session; never force-logout

    const grant = await recentGrant({
      wallet: owner.wallet, secretKey: owner.secretKey, cookie: owner.cookie, purpose: 'key_export',
    });
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now + 6 * 60 * 1000);
      const expired = await app.inject({
        method: 'POST', url: '/auth/export/challenge',
        headers: { [RECENT_AUTH_HEADER]: grant },
        cookies: { [SESSION_COOKIE]: owner.cookie }, payload: {},
      });
      expect(expired.statusCode).toBe(428);
      expect(expired.json().error.code).toBe('RECENT_AUTH_REQUIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('health route answers', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    // `ok` is the contract every uptime check reads; both deed loops ride along
    // so a frozen sync is visible from outside (the R2 leg silently stopped for
    // five days on 2026-07-30; the chain leg has the same failure shape). In a
    // test process neither loop starts, which must read as healthy-with-a-reason
    // rather than red — see deedR2.test.ts / deedChainSync.test.ts.
    const body = res.json() as {
      ok: boolean;
      deedSync: { running: boolean; ok: boolean };
      deedChainSync: { running: boolean; ok: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.deedSync.running).toBe(false);
    expect(body.deedSync.ok).toBe(true);
    expect(body.deedChainSync.running).toBe(false);
    expect(body.deedChainSync.ok).toBe(true);
  });
});

describe('closed-alpha gate (ALPHA_WALLETS)', () => {
  /**
   * The domain is public knowledge, so the gate has to survive being found — not
   * merely not-advertised. These pin the two properties that matter and the one
   * subtle way a plausible implementation fails.
   */
  const OTHER = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';

  const gatedApp = async (allowed: string[]): Promise<FastifyInstance> => {
    const a = await buildApp({ ...TEST_CONFIG, ALPHA_WALLETS: allowed }, conn.db);
    await a.ready();
    return a;
  };

  const loginOn = async (a: FastifyInstance, wallet: string, secretKey: Uint8Array) => {
    const ch = await a.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    return a.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, signature: await signMessage((ch.json() as { message: string }).message, secretKey) },
    });
  };

  it('lets an unlisted wallet SIGN IN (to redeem an invite) but 403s it with ALPHA_GATED everywhere else', async () => {
    // ACCESS MODEL v2 (invite codes, 2026-08-05): sign-in is deliberately OPEN —
    // a code holder must be able to mint the session POST /alpha/redeem
    // requires, so gating /auth/verify was a chicken-and-egg lockout. The gate
    // moved wholly into makeAuthenticate: a stranger's session can reach the
    // redeem endpoint and NOTHING else, and the 403 carries the machine-readable
    // code the client branches on to show the redeem UI (see alpha.test.ts for
    // the full redeem flow).
    const gated = await gatedApp([OTHER]);
    const { secretKey, wallet } = await makeKeypair();
    const res = await loginOn(gated, wallet, secretKey);

    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();

    const me = await gated.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie!.value } });
    expect(me.statusCode).toBe(403);
    expect(me.json().error.message).toMatch(/playtest access needed/i);
    expect(me.json().error.code).toBe('ALPHA_GATED');
    await gated.close();
  });

  it('REVOKES a cookie that was already issued before the gate existed', async () => {
    // THE ONE THAT MATTERS. Session JWTs verify statelessly and nothing enforces
    // sessions.revokedAt, so gating only /auth/verify would let anyone who signed
    // in earlier keep playing for the full 7-day TTL, with no way to evict them
    // short of rotating JWT_SECRET — which logs the owner out too. This fails if
    // someone later "simplifies" the check out of makeAuthenticate.
    const { secretKey, wallet } = await makeKeypair();
    const open = await loginOn(app, wallet, secretKey);
    expect(open.statusCode).toBe(200);
    const cookie = open.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    // The cookie genuinely works while the gate is off — otherwise this is vacuous.
    expect((await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);

    const gated = await gatedApp([OTHER]);
    const after = await gated.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(after.statusCode).toBe(403);
    await gated.close();
  });

  it('never answers 401 for a gate rejection', async () => {
    // 401 makes the client force-logout and claim "SESSION EXPIRED", which hides
    // the real reason and loops the player back to the connect screen forever.
    const { secretKey, wallet } = await makeKeypair();
    const open = await loginOn(app, wallet, secretKey);
    const cookie = open.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

    const gated = await gatedApp([OTHER]);
    const res = await gated.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(403);
    await gated.close();
  });

  it('a LISTED wallet is completely unaffected', async () => {
    const { secretKey, wallet } = await makeKeypair();
    const gated = await gatedApp([wallet, OTHER]);
    const res = await loginOn(gated, wallet, secretKey);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    expect((await gated.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);
    await gated.close();
  });
});

describe('dev-login seeds a base ONCE', () => {
  /**
   * THE BUG THIS PINS. The seed used to be a bare insert with
   * .onConflictDoNothing(), which reads like a dedupe and is a no-op: the only
   * unique index on `buildings` is the primary key and `id` is a fresh uuid
   * every call, so nothing ever conflicts. Every dev-login stacked another
   * mine/barracks/camp on the SAME fixed tiles, invisibly — one sprite drawn
   * over another. The owner's base ended up with six camps on tile (12,8) and
   * mines past the Keep cap, because this path bypasses geometryCheck and every
   * cap. Dev-login is gated off in production, so this only ever hurt dev bases
   * — but it hurt one, silently, for weeks.
   */
  const devApp = async (): Promise<FastifyInstance> => {
    const prev = process.env['DEV_LOGIN'];
    process.env['DEV_LOGIN'] = 'true';
    const a = await buildApp({ ...TEST_CONFIG, NODE_ENV: 'development' }, conn.db);
    await a.ready();
    if (prev === undefined) delete process.env['DEV_LOGIN']; else process.env['DEV_LOGIN'] = prev;
    return a;
  };

  it('a second dev-login adds NO further buildings', async () => {
    const app2 = await devApp();
    const wallet = (await makeKeypair()).wallet;
    const call = () => app2.inject({ method: 'POST', url: '/auth/dev-login', payload: { wallet } });
    const sys = await bootstrapSystemAccounts(conn.db);
    const emissionBefore = (await conn.db.select().from(accounts)
      .where(eq(accounts.id, sys.emission_pool)))[0]!.balance;

    expect((await call()).statusCode).toBe(200);
    const after1 = await conn.db.select().from(players).where(eq(players.wallet, wallet));
    expect(after1).toHaveLength(1); // sanity: the player exists

    const { buildings } = await import('../src/db/schema');
    const count = async (): Promise<number> =>
      (await conn.db.select().from(buildings).where(eq(buildings.playerWallet, wallet))).length;
    const first = await count();
    expect(first).toBeGreaterThan(0); // never vacuous — the seed did run
    expect((await getOrCreatePlayerAccount(conn.db, wallet, 'player_keep')).balance).toBe(50_000n);
    expect((await conn.db.select().from(accounts).where(eq(accounts.id, sys.emission_pool)))[0]!.balance)
      .toBe(emissionBefore - 50_000n);

    await call();
    await call();
    // Before the fix this grew by 3 every call, stacking on identical tiles.
    expect(await count()).toBe(first);
    expect((await getOrCreatePlayerAccount(conn.db, wallet, 'player_keep')).balance).toBe(50_000n);
    expect((await conn.db.select().from(accounts).where(eq(accounts.id, sys.emission_pool)))[0]!.balance)
      .toBe(emissionBefore - 50_000n);
    await app2.close();
  });

  it('never stacks two buildings on one tile', async () => {
    // The observable symptom the owner actually saw: sprites hidden under each
    // other, and counts past the Keep cap.
    const app2 = await devApp();
    const wallet = (await makeKeypair()).wallet;
    for (let i = 0; i < 3; i++) {
      await app2.inject({ method: 'POST', url: '/auth/dev-login', payload: { wallet } });
    }
    const { buildings } = await import('../src/db/schema');
    const rows = await conn.db.select().from(buildings).where(eq(buildings.playerWallet, wallet));
    const tiles = rows.map((b) => `${b.type}@${b.tx},${b.ty}`);
    expect(new Set(tiles).size).toBe(tiles.length);
    await app2.close();
  });


});
