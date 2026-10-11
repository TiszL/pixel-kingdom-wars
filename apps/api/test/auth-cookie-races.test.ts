/** Browser cookie-jar model backed by the actual auth routes and DB sessions.
 * Delaying delivery delays Set-Cookie, not just React's consumption of JSON. */
import { randomUUID } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuthChangedError, AuthCookieCoordinator, type AuthCookieStorage } from '../../web/src/auth/authCookieCoordinatorCore';
import { buildApp } from '../src/app';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../src/auth/session';
import { players } from '../src/db/schema';
import { TEST_CONFIG, connectTestDb, randomWallet } from './helpers';

let app: FastifyInstance;
let conn: ReturnType<typeof connectTestDb>;
beforeAll(async () => {
  conn = connectTestDb();
  app = await buildApp({ ...TEST_CONFIG, SOCIAL_TOKEN_LOGIN_ENABLED: 'true' }, conn.db, {
    socialTokenVerifier: async (wallet) => ({ wallet, subject: `did:privy:${wallet}` }),
  });
  await app.ready();
});
afterAll(async () => { await app.close(); await conn.sql.end(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function browser() {
  const cookies: Record<string, string> = {};
  let revision = '';
  let dirty = false;
  const storage: AuthCookieStorage = { revision: () => revision, dirty: () => dirty,
    set: (r, d) => { revision = r; dirty = d; } };
  const coordinator = new AuthCookieCoordinator(storage, (operation) => operation());
  const request = async (path: string, payload?: Record<string, unknown>, delivery?: ReturnType<typeof deferred>, received?: ReturnType<typeof deferred>) => {
    const res = await app.inject({ method: path === '/me' || path === '/auth/login/status' ? 'GET' : 'POST', url: path,
      cookies: { ...cookies }, ...(payload !== undefined ? { payload } : {}) });
    received?.resolve();
    await delivery?.promise;
    for (const cookie of res.cookies) {
      if (cookie.value) cookies[cookie.name] = cookie.value;
      else delete cookies[cookie.name];
    }
    if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
    return res.json() as { wallet?: string; loginRequired?: boolean; expired?: boolean };
  };
  const clear = () => request('/auth/logout', {});
  const login = (wallet: string, delivery?: ReturnType<typeof deferred>, received?: ReturnType<typeof deferred>) => {
    const attempt = coordinator.begin();
    return coordinator.run({ kind: 'login', clear, isCurrent: () => coordinator.current(attempt),
      operation: () => request('/auth/social', { accessToken: wallet, identityToken: 'signed-identity-placeholder-0123456789' }, delivery, received) });
  };
  return { cookies, storage, coordinator, request, clear, login };
}
describe('auth cookie response ordering', () => {
  it('revokes a delayed A login before logout completes, so reload cannot restore A', async () => {
    const b = browser();
    const delivery = deferred(); const received = deferred();
    const a = b.login(randomWallet(), delivery, received).catch((e: unknown) => e);
    await received.promise;
    const logout = b.coordinator.run({ kind: 'logout', operation: b.clear, clear: b.clear });
    delivery.resolve();
    expect(await a).toBeInstanceOf(Error);
    await logout;
    expect(b.cookies[SESSION_COOKIE]).toBeUndefined();
    expect(b.cookies[LOGIN_COOKIE]).toBeUndefined();
    await expect(b.request('/me')).rejects.toThrow('HTTP 401');
  });

  it('does not send B until delayed A cookies have been delivered and revoked', async () => {
    const b = browser(); const walletB = randomWallet();
    const delivery = deferred(); const received = deferred();
    const a = b.login(randomWallet(), delivery, received).catch((e: unknown) => e);
    await received.promise;
    const next = b.login(walletB);
    expect(() => b.coordinator.assertSession()).toThrow();
    delivery.resolve();
    expect(await a).toBeInstanceOf(Error);
    expect((await next).wallet).toBe(walletB);
    expect((await b.coordinator.session(() => b.request('/me'))).wallet).toBe(walletB);
  });

  it('also drains pending-to-full promotion before a different wallet can log in', async () => {
    const b = browser(); const wallet = randomWallet(); const seed = 'JBSWY3DPEHPK3PXP';
    await conn.db.insert(players).values({ wallet, loginTotpRequired: true, totpEnabled: true,
      totpEnabledAt: new Date(), totpSecret: seed, email: 'test@example.test', emailVerified: true });
    expect((await b.login(wallet)).loginRequired).toBe(true);
    const delivery = deferred(); const received = deferred();
    const attempt = b.coordinator.begin();
    const code = new TOTP({ secret: Secret.fromBase32(seed), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
    const promotion = b.coordinator.run({ kind: 'login', clear: b.clear,
      isCurrent: () => b.coordinator.current(attempt),
      operation: () => b.request('/auth/login/verify', { code }, delivery, received) }).catch((e: unknown) => e);
    await received.promise;
    const walletB = randomWallet(); const next = b.login(walletB);
    delivery.resolve();
    expect(await promotion).toBeInstanceOf(Error);
    await next;
    expect((await b.request('/me')).wallet).toBe(walletB);
    expect(b.cookies[LOGIN_COOKIE]).toBeUndefined();
  });

  it('keeps gameplay and reload bootstrap blocked when stale-cookie cleanup fails', async () => {
    const b = browser(); const wallet = randomWallet();
    const failure = async () => { throw new Error('network down'); };
    await expect(b.coordinator.run({ kind: 'login', clear: failure, operation: async () => {
      await b.request('/auth/social', { accessToken: wallet, identityToken: 'signed-identity-placeholder-0123456789' });
      throw new Error('response body lost after Set-Cookie');
    } })).rejects.toThrow('network down');
    expect(b.storage.dirty()).toBe(true);
    expect(() => b.coordinator.assertSession()).toThrow();
    const reloaded = new AuthCookieCoordinator(b.storage, (operation) => operation());
    await expect(reloaded.ready(failure)).rejects.toThrow('network down');
    expect(() => reloaded.assertSession()).toThrow();
    await reloaded.ready(b.clear);
    expect(b.storage.dirty()).toBe(false);
    await expect(b.request('/me')).rejects.toThrow('HTTP 401');
    const walletB = randomWallet(); await b.login(walletB);
    expect((await b.request('/me')).wallet).toBe(walletB);
  });

  it('waits for an old expired-status cookie clear before issuing a new pending credential', async () => {
    const b = browser(); b.cookies[LOGIN_COOKIE] = `expired-${randomUUID()}`;
    const delivery = deferred(); const received = deferred();
    const status = b.coordinator.run({ kind: 'status', clear: b.clear,
      operation: () => b.request('/auth/login/status', undefined, delivery, received) }).catch((error: unknown) => error);
    await received.promise;
    const wallet = randomWallet();
    await conn.db.insert(players).values({ wallet, loginTotpRequired: true });
    const next = b.login(wallet);
    expect(b.storage.dirty()).toBe(false); // New cookie issuance has not started.
    delivery.resolve();
    // Deliver the old clear under its lock, but never publish its obsolete
    // status to the UI after a new identity has claimed the coordinator.
    expect(await status).toBeInstanceOf(AuthChangedError);
    await next;
    expect(await b.request('/auth/login/status')).toMatchObject({ loginRequired: true, wallet });
  });
  it('revokes a valid full credential even when a stale limited cookie accompanies it', async () => {
    const b = browser(); await b.login(randomWallet());
    const retainedFull = b.cookies[SESSION_COOKIE]!;
    b.cookies[LOGIN_COOKIE] = 'invalid-limited-credential';
    await b.clear();
    const retained = await app.inject({ method: 'GET', url: '/me', cookies: { [SESSION_COOKIE]: retainedFull } });
    expect(retained.statusCode).toBe(401);
    expect(b.cookies).toEqual({});
  });

  it('keeps the same limited credential after a wrong code so a correct retry can promote it', async () => {
    const b = browser(); const wallet = randomWallet(); const seed = 'JBSWY3DPEHPK3PXP';
    await conn.db.insert(players).values({ wallet, loginTotpRequired: true, totpEnabled: true,
      totpEnabledAt: new Date(), totpSecret: seed, email: 'test@example.test', emailVerified: true });
    await b.login(wallet);
    const pending = b.cookies[LOGIN_COOKIE];
    const code = new TOTP({ secret: Secret.fromBase32(seed), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
    const wrong = `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;
    const verify = (value: string) => b.coordinator.run({ kind: 'login', clear: b.clear,
      unchangedOnError: (error) => error instanceof Error && error.message === 'HTTP 422',
      operation: () => b.request('/auth/login/verify', { code: value }) });
    await expect(verify(wrong)).rejects.toThrow('HTTP 422');
    expect(b.cookies[LOGIN_COOKIE]).toBe(pending);
    expect(b.storage.dirty()).toBe(false);
    await verify(code);
    expect(b.cookies[LOGIN_COOKIE]).toBeUndefined();
    expect((await b.request('/me')).wallet).toBe(wallet);
  });

});
