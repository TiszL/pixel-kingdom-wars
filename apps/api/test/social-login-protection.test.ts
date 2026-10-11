/** D-109: a provider token must prove exactly one embedded identity; a limited
 * login proof must never authorize gameplay or bypass the existing recovery. */
import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TOTP, Secret } from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { completeLogin, insertLoginSessionTx, setLoginProtection } from '../src/auth/loginProtection';
import { makeSocialTokenVerifier, type SocialTokenVerifier } from '../src/auth/social';
import { issueLoginJwt, issueSessionJwt, LOGIN_COOKIE, RECENT_AUTH_HEADER, SESSION_COOKIE, verifyActiveSession, verifyPendingLogin } from '../src/auth/session';
import { disableTotp, enrollTotp, verifyTotpEnroll, sendFactorStepUpEmailCode, factorChangeEmailChallengeContext } from '../src/auth/twofa';
import { players, privyIdentities, sessions, buildings } from '../src/db/schema';
import { TEST_CONFIG, connectTestDb, randomWallet } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: SocialTokenVerifier;
const config = { ...TEST_CONFIG, SOCIAL_TOKEN_LOGIN_ENABLED: 'true' as const, PRIVY_APP_ID: 'pkw-test-app' };
const seed = 'JBSWY3DPEHPK3PXP';
const code = () => new TOTP({ secret: Secret.fromBase32(seed), algorithm: 'SHA1', digits: 6, period: 30 }).generate();

beforeAll(async () => {
  conn = connectTestDb();
  keys = await generateKeyPair('ES256');
  const jwk = await exportJWK(keys.publicKey);
  verify = makeSocialTokenVerifier(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'test' }] }));
  app = await buildApp(config, conn.db, { socialTokenVerifier: verify });
  await app.ready();
});
afterAll(async () => { await app.close(); await conn.sql.end(); });

async function jwt(payload: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: 'privy.io', aud: config.PRIVY_APP_ID, iat: now, exp: now + 3600, ...payload })
    .setProtectedHeader({ alg: 'ES256', kid: 'test' }).sign(keys.privateKey);
}
function linked(wallet: string, extra: Record<string, unknown> = {}) {
  // Real Privy identity-token wallets omit connector_type; the provider's
  // signed wallet_client_type is the embedded discriminator.
  return { type: 'wallet', chain_type: 'solana', wallet_client_type: 'privy', address: wallet, ...extra };
}
async function tokens(wallet = randomWallet(), subject = `did:privy:${randomUUID()}`) {
  return {
    wallet, subject,
    accessToken: await jwt({ sub: subject, sid: 'provider-session' }),
    identityToken: await jwt({ sub: subject, linked_accounts: JSON.stringify([linked(wallet)]) }),
  };
}
async function social(t: Awaited<ReturnType<typeof tokens>>, extra = {}) {
  return app.inject({ method: 'POST', url: '/auth/social', payload: { accessToken: t.accessToken, identityToken: t.identityToken, ...extra } });
}
async function protectedPlayer(wallet = randomWallet()) {
  await conn.db.insert(players).values({
    wallet, loginTotpRequired: true, totpEnabled: true, totpSecret: seed,
    totpEnabledAt: new Date(), email: 'player@example.test', emailVerified: true,
  });
  return wallet;
}
async function pending(wallet: string) {
  return conn.db.transaction((tx) => insertLoginSessionTx(tx, wallet, 'browser'));
}
async function full(wallet: string) {
  const id = randomUUID();
  await conn.db.insert(sessions).values({ id, wallet, expiresAt: new Date(Date.now() + 60_000), scope: 'full', loginMfaAt: new Date() });
  return { wallet, sessionId: id };
}

describe('provider-token identity', () => {
  it('accepts verified embedded identity without any signature challenge, preserving the existing wallet', async () => {
    const t = await tokens();
    await conn.db.insert(players).values({ wallet: t.wallet, name: 'Existing Kingdom' });
    const res = await social(t);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wallet: t.wallet, entryPaid: false });
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE && c.value)).toBe(true);
    const [binding] = await conn.db.select().from(privyIdentities).where(eq(privyIdentities.subject, t.subject));
    expect(binding?.wallet).toBe(t.wallet);
    expect((await conn.db.select().from(players).where(eq(players.wallet, t.wallet)))[0]?.name).toBe('Existing Kingdom');
    expect(await conn.db.select().from(buildings).where(eq(buildings.playerWallet, t.wallet))).toHaveLength(0);
  });

  it('rejects forged, expired, wrong-app/issuer, mismatched subject/session and external/ambiguous wallet claims', async () => {
    const t = await tokens();
    const validAccess = t.accessToken;
    const invalidPairs = [
      [t.accessToken.slice(0, -8) + 'aaaaaaaa', t.identityToken],
      [await jwt({ sub: t.subject, sid: 'provider-session', exp: 1 }), t.identityToken],
      [await jwt({ sub: t.subject, sid: 'provider-session', aud: 'wrong-app' }), t.identityToken],
      [await jwt({ sub: t.subject, sid: 'provider-session', iss: 'attacker' }), t.identityToken],
      [await jwt({ sub: 'did:privy:other', sid: 'provider-session' }), t.identityToken],
      [validAccess, await jwt({ sub: t.subject, sid: 'another-session', linked_accounts: JSON.stringify([linked(t.wallet)]) })],
      [validAccess, await jwt({ sub: t.subject, linked_accounts: JSON.stringify([linked(t.wallet, { connector_type: 'injected' })]) })],
      [validAccess, await jwt({ sub: t.subject, linked_accounts: JSON.stringify([linked(t.wallet, { wallet_client_type: 'phantom' })]) })],
      [validAccess, await jwt({ sub: t.subject, linked_accounts: JSON.stringify([linked(t.wallet, { wallet_client_type: undefined })]) })],
      [validAccess, await jwt({ sub: t.subject, linked_accounts: JSON.stringify([linked(t.wallet, { wallet_client_type: 'privy-v2' })]) })],
      [validAccess, await jwt({ sub: t.subject, linked_accounts: JSON.stringify([linked(t.wallet), linked(randomWallet())]) })],
      [validAccess, await jwt({ sub: t.subject, linked_accounts: [linked(t.wallet)] })],
      [await jwt({ sub: t.subject, sid: 'provider-session', linked_accounts: JSON.stringify([linked(t.wallet)]) }), t.identityToken],
    ];
    for (const [accessToken, identityToken] of invalidPairs) {
      await expect(verify(accessToken!, identityToken!)).rejects.toMatchObject({ statusCode: 401 });
    }
    expect((await social(t, { wallet: randomWallet() })).statusCode).toBe(400);
  });

  it('keeps both DID and wallet unique across changing provider claims and concurrent requests', async () => {
    const t = await tokens();
    const initial = await Promise.all([social(t), social(t)]);
    expect(initial.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await social(await tokens(randomWallet(), t.subject))).statusCode).toBe(409);
    expect((await social(await tokens(t.wallet))).statusCode).toBe(409);
    expect(await conn.db.select().from(privyIdentities).where(eq(privyIdentities.subject, t.subject))).toHaveLength(1);
  });

  it('retains alpha gating and does not create a base for an unadmitted social account', async () => {
    const gated = await buildApp({ ...config, ALPHA_WALLETS: [] }, conn.db, { socialTokenVerifier: verify });
    try {
      const t = await tokens();
      const res = await gated.inject({ method: 'POST', url: '/auth/social', payload: { accessToken: t.accessToken, identityToken: t.identityToken } });
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
      const me = await gated.inject({ method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: cookie! } });
      expect(me.statusCode).toBe(403);
      expect(me.json().error.code).toBe('ALPHA_GATED');
      expect(await conn.db.select().from(buildings).where(eq(buildings.playerWallet, t.wallet))).toHaveLength(0);
    } finally { await gated.close(); }
  });
});

describe('optional PKW login protection', () => {
  it('defaults off and issues only a separate limited credential for protected social and SIWS sign-in', async () => {
    const secret = utils.randomSecretKey();
    const wallet = bs58.encode(await getPublicKeyAsync(secret));
    await protectedPlayer(wallet);
    const t = await tokens(wallet);
    const socialRes = await social(t);
    expect(socialRes.json().loginRequired).toBe(true);
    const login = socialRes.cookies.find((c) => c.name === LOGIN_COOKIE)?.value;
    expect(login).toBeTruthy();
    expect(socialRes.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect((await app.inject({ method: 'GET', url: '/base', cookies: { [LOGIN_COOKIE]: login! } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: login! } })).statusCode).toBe(401);
    const challenge = (await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } })).json();
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: {
      wallet, nonce: challenge.nonce, signature: bs58.encode(await signAsync(new TextEncoder().encode(challenge.message), secret)),
    } });
    expect(res.statusCode).toBe(200);
    expect(res.json().loginRequired).toBe(true);
    expect(res.cookies.find((c) => c.name === LOGIN_COOKIE)?.value).toBeTruthy();
  });

  it('commits failed-code counters, promotes once under concurrency, and rejects reuse of a consumed credential', async () => {
    const wallet = await protectedPlayer();
    const login = await pending(wallet);
    const wrongCode = code() === '000000' ? '000001' : '000000';
    await expect(completeLogin(conn.db, login, wrongCode)).rejects.toMatchObject({ statusCode: 422 });
    expect((await conn.db.select().from(players).where(eq(players.wallet, wallet)))[0]?.twofaFailedAttempts).toBe(1);
    const currentCode = code();
    const results = await Promise.allSettled([completeLogin(conn.db, login, currentCode), completeLogin(conn.db, login, currentCode)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const success = results.find((r) => r.status === 'fulfilled');
    if (success?.status !== 'fulfilled') throw new Error('missing login');
    const jwt = await issueSessionJwt(config, wallet, success.value.sessionId);
    expect((await verifyActiveSession(config, conn.db, jwt)).wallet).toBe(wallet);
    await expect(completeLogin(conn.db, await pending(wallet), currentCode)).rejects.toMatchObject({ statusCode: 422 });
    expect((await conn.db.select().from(sessions).where(eq(sessions.id, login.sessionId)))[0]?.revokedAt).not.toBeNull();
  });

  it('cannot use pending credentials for key export, factor replacement before recovery, or a withdrawal proof', async () => {
    const wallet = await protectedPlayer();
    const res = await social(await tokens(wallet));
    const cookies = { [LOGIN_COOKIE]: res.cookies.find((c) => c.name === LOGIN_COOKIE)!.value };
    for (const url of ['/auth/export/status', '/2fa/email/start', '/2fa/totp/enroll']) {
      const result = await app.inject({ method: url.endsWith('status') ? 'GET' : 'POST', url, cookies, ...(url.endsWith('status') ? {} : { payload: {} }) });
      expect(result.statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/auth/reauth/challenge', cookies, payload: { purpose: 'key_export' } })).statusCode).toBe(403);
    const recovery = await app.inject({ method: 'POST', url: '/auth/reauth/challenge', cookies, payload: { purpose: 'totp_recovery', intent: { recoveryId: randomUUID(), action: 'start' } } });
    expect(recovery.statusCode).toBe(200);
    await conn.db.update(players).set({ totpReenrollmentRequired: true }).where(eq(players.wallet, wallet));
    expect((await app.inject({ method: 'POST', url: '/auth/reauth/challenge', cookies, payload: { purpose: 'factor_change' } })).statusCode).toBe(200);
  });

  it('requires recovery readiness and a code to enable, revokes siblings and blocks factor removal until explicitly disabled', async () => {
    const wallet = await protectedPlayer();
    await conn.db.update(players).set({ loginTotpRequired: false }).where(eq(players.wallet, wallet));
    const current = await full(wallet);
    const sibling = await full(wallet);
    await expect(setLoginProtection(conn.db, current, true, code(), false)).rejects.toMatchObject({ statusCode: 409 });
    await conn.db.update(players).set({ emailVerified: false }).where(eq(players.wallet, wallet));
    await expect(setLoginProtection(conn.db, current, true, code(), true)).rejects.toMatchObject({ statusCode: 409 });
    await conn.db.update(players).set({ emailVerified: true }).where(eq(players.wallet, wallet));
    await setLoginProtection(conn.db, current, true, code(), true);
    expect((await conn.db.select().from(sessions).where(eq(sessions.id, sibling.sessionId)))[0]?.revokedAt).not.toBeNull();
    await expect(disableTotp(conn.db, wallet, code())).rejects.toMatchObject({ statusCode: 409 });
    await conn.db.update(players).set({ totpLastUsedStep: null }).where(eq(players.wallet, wallet));
    await setLoginProtection(conn.db, current, false, code(), false);
    expect((await conn.db.select().from(players).where(eq(players.wallet, wallet)))[0]?.loginTotpRequired).toBe(false);
  });

  it('requires a fresh wallet proof at the policy endpoint, including when a full game session is valid', async () => {
    const secret = utils.randomSecretKey();
    const wallet = bs58.encode(await getPublicKeyAsync(secret));
    await protectedPlayer(wallet);
    await conn.db.update(players).set({ loginTotpRequired: false }).where(eq(players.wallet, wallet));
    const current = await full(wallet);
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, wallet, current.sessionId) };
    const payload = { enabled: true, code: code() };
    expect((await app.inject({ method: 'POST', url: '/auth/login/protection', cookies, payload })).statusCode).toBe(428);
    const challenge = (await app.inject({ method: 'POST', url: '/auth/reauth/challenge', cookies, payload: { purpose: 'factor_change' } })).json();
    const proof = (await app.inject({ method: 'POST', url: '/auth/reauth/verify', cookies, payload: {
      challengeToken: challenge.challengeToken,
      signature: bs58.encode(await signAsync(new TextEncoder().encode(challenge.message), secret)),
    } })).json();
    const result = await app.inject({ method: 'POST', url: '/auth/login/protection', cookies,
      headers: { [RECENT_AUTH_HEADER]: proof.grant }, payload });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ loginTotpRequired: true });
  });

  it('expires limited credentials and scopes limited logout to itself, preserving fully authenticated sessions', async () => {
    const wallet = await protectedPlayer();
    const current = await full(wallet);
    const login = await pending(wallet);
    const token = await issueLoginJwt(config, wallet, login.sessionId);
    const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { [LOGIN_COOKIE]: token } });
    expect(out.statusCode).toBe(200);
    expect((await conn.db.select().from(sessions).where(eq(sessions.id, current.sessionId)))[0]?.revokedAt).toBeNull();
    await expect(verifyPendingLogin(config, conn.db, token)).rejects.toMatchObject({ statusCode: 401 });
    const expired = await pending(wallet);
    const expiredToken = await issueLoginJwt(config, wallet, expired.sessionId);
    await conn.db.update(sessions).set({ expiresAt: new Date(1) }).where(eq(sessions.id, expired.sessionId));
    await expect(verifyPendingLogin(config, conn.db, expiredToken)).rejects.toMatchObject({ statusCode: 401 });
    const status = await app.inject({ method: 'GET', url: '/auth/login/status', cookies: { [LOGIN_COOKIE]: expiredToken } });
    expect(status.json()).toEqual({ loginRequired: false, expired: true });
  });

  it('rejects an old full session lacking login MFA and revokes limited credentials after replacement enrollment', async () => {
    const wallet = await protectedPlayer();
    const staleId = randomUUID();
    await conn.db.insert(sessions).values({ id: staleId, wallet, expiresAt: new Date(Date.now() + 60_000) });
    await expect(verifyActiveSession(config, conn.db, await issueSessionJwt(config, wallet, staleId))).rejects.toMatchObject({ statusCode: 401 });
    const login = await pending(wallet);
    await conn.db.update(players).set({ totpEnabled: false, totpEnabledAt: null, totpSecret: null, totpReenrollmentRequired: true }).where(eq(players.wallet, wallet));
    const email = await sendFactorStepUpEmailCode(conn.db, wallet, async () => undefined, login.sessionId);
    const enrollment = await enrollTotp(conn.db, wallet, { method: 'email', code: email.devCode! }, factorChangeEmailChallengeContext(login.sessionId));
    const newCode = new TOTP({ secret: Secret.fromBase32(enrollment.secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
    await verifyTotpEnroll(conn.db, wallet, newCode);
    const [player] = await conn.db.select().from(players).where(eq(players.wallet, wallet));
    expect(player?.loginTotpRequired).toBe(true);
    expect(player?.totpReenrollmentRequired).toBe(false);
    expect((await conn.db.select().from(sessions).where(eq(sessions.id, login.sessionId)))[0]?.revokedAt).not.toBeNull();
  });
});
