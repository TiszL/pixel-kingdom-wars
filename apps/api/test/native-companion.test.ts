import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import { buildNativePresentationApp } from '../src/native/app';
import { loadConfig, loadNativeServiceConfig } from '../src/config';
import { issueSessionJwt } from '../src/auth/session';
import { bases, players, raids, sessions } from '../src/db/schema';
import { recordBaseBattle } from '../src/game/baseBattleHistory';
import { persistReplayTimeline } from '../src/game/raidReplayArchive';
import { connectTestDb, createTestPlayer, TEST_CONFIG, randomWallet } from './helpers';

const connection = connectTestDb();
const { db } = connection;
const apps: FastifyInstance[] = [];
const originalMultiBase = process.env['MULTI_BASE_ENABLED'];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  if (originalMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = originalMultiBase;
});
afterAll(async () => { await connection.sql.end(); });

const minimal = (wallet: string) => ({ DATABASE_URL: TEST_CONFIG.DATABASE_URL, REDIS_URL: TEST_CONFIG.REDIS_URL,
  JWT_SECRET: TEST_CONFIG.JWT_SECRET, NODE_ENV: 'test', MULTI_BASE_ENABLED: 'true',
  NATIVE_PRESENTATION_SERVICE: 'true', NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_WALLETS: wallet });

async function fixture() {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  const owner = await createTestPlayer(db);
  const [session] = await db.insert(sessions).values({ wallet: owner.wallet, expiresAt: new Date(Date.now() + 60_000) }).returning();
  const cookie = `shardkeep_session=${await issueSessionJwt(TEST_CONFIG, owner.wallet, session!.id)}`;
  const config = loadNativeServiceConfig(minimal(owner.wallet));
  const app = await buildNativePresentationApp(config, db); apps.push(app);
  const [base] = await db.insert(bases).values({ ownerWallet: owner.wallet, status: 'active', keepLevel: 5 }).returning();
  const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: owner.wallet,
    attackerBaseId: base!.id, seed: 7n, simVersion: SIM_VERSION, status: 'resolved', resolvedAt: new Date(),
    ordersDeadlineAt: new Date(), snapshot: {}, armySnapshot: {} }).returning();
  await recordBaseBattle(db, { raidId: raid!.id, attackerBaseId: base!.id, attackerOwnerWallet: owner.wallet,
    stars: 1, destructionPct: 50, lootShards: 0n });
  await persistReplayTimeline(db, raid!.id, { snapshot: {}, armySnapshot: {}, orders: { deploys: [] }, seed: 7,
    simVersion: SIM_VERSION, events: Array.from({ length: 10_000 }, (_, index) => ({ t: index, e: 'destroyed' as const, id: `structure-${index}` })),
    result: { lootShards: '0' } }, 100);
  return { owner, session: session!, cookie, config, app, url: `/raids/${raid!.id}/presentation?protocolVersion=2` };
}

describe('isolated native companion', () => {
  it('boots with only its real session and native dependencies and refuses accidental public enablement', async () => {
    const wallet = randomWallet();
    const env = minimal(wallet);
    const config = loadNativeServiceConfig({ ...env, NODE_ENV: 'production' });
    expect(config).not.toHaveProperty('RESEND_API_KEY');
    expect(config).not.toHaveProperty('TWOFA_ENCRYPTION_KEYS');
    expect(config.NATIVE_DB_POOL_MAX).toBe(2);
    expect(() => loadNativeServiceConfig({ ...env, NATIVE_PRESENTATION_SERVICE: undefined })).toThrow();
    expect(() => loadNativeServiceConfig({ ...env, NATIVE_PRESENTATION_WALLETS: '' })).toThrow();
    expect(() => loadNativeServiceConfig({ ...env, NATIVE_DB_POOL_MAX: '3' })).toThrow();
    expect(() => loadNativeServiceConfig({ ...env, NATIVE_PRESENTATION_WALLETS: '0'.repeat(44) })).toThrow();
    expect(() => loadNativeServiceConfig({ ...env, NATIVE_PRESENTATION_WALLETS: `${wallet},${wallet}` })).toThrow();
    // The ordinary API fails closed as well (security review 2026-09-11): enabling native
    // presentation without a tester list needs the explicit public switch.
    const ordinary = { ...env, SOLANA_RPC_URL: 'http://localhost:8899', WEB_ORIGIN: 'http://localhost:5173',
      NATIVE_PRESENTATION_WALLETS: '' };
    expect(() => loadConfig(ordinary)).toThrow(/tester list or NATIVE_PRESENTATION_OPEN/);
    expect(loadConfig({ ...ordinary, NATIVE_PRESENTATION_OPEN: 'true' }).NATIVE_PRESENTATION_WALLETS).toBeUndefined();
    await expect(buildNativePresentationApp({ ...config, NATIVE_PRESENTATION_WALLETS: undefined }, db)).rejects.toThrow('tester list');
  });

  it('has no authentication mutation or economy routes and hides availability outside the tester list', async () => {
    const f = await fixture();
    for (const [method, url] of [['POST', '/auth/verify'], ['POST', '/withdrawals'], ['POST', '/raids/create'], ['GET', '/base']] as const) {
      expect((await f.app.inject({ method, url, headers: { cookie: f.cookie } })).statusCode).toBe(404);
    }
    expect((await f.app.inject('/health')).json()).toMatchObject({ ok: true, service: 'native-presentation' });
    const publicCapabilities = await f.app.inject('/native/capabilities');
    expect(publicCapabilities.json().presentation.enabled).toBe(false);
    // Enforcement capability is independent of whether any Gems source is live.
    expect(publicCapabilities.json().economy.gameCurrency).toEqual({ version: 1, exactSpendCurrency: 1 });
    expect(publicCapabilities.body).not.toContain(f.owner.wallet);
    expect((await f.app.inject({ url: '/native/capabilities', headers: { cookie: f.cookie } })).json().presentation.enabled).toBe(true);
    f.config.NATIVE_PRESENTATION_WALLETS = [randomWallet()];
    expect((await f.app.inject({ url: f.url, headers: { cookie: f.cookie } })).json().error.code).toBe('NATIVE_TESTER_REQUIRED');
  });

  it('enforces shared session revocation and enrolled login MFA on every immutable page', async () => {
    const f = await fixture();
    const first = await f.app.inject({ url: f.url, headers: { cookie: f.cookie } });
    expect(first.statusCode).toBe(200);
    const cursor = first.json().nextCursor;
    expect(cursor).toBeTypeOf('string');
    const next = `${f.url}&cursor=${cursor}`;
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, f.session.id));
    expect((await f.app.inject({ url: next, headers: { cookie: f.cookie } })).statusCode).toBe(401);
    await db.update(sessions).set({ revokedAt: null }).where(eq(sessions.id, f.session.id));
    await db.update(players).set({ loginTotpRequired: true }).where(eq(players.wallet, f.owner.wallet));
    expect((await f.app.inject({ url: next, headers: { cookie: f.cookie } })).statusCode).toBe(401);
    await db.update(sessions).set({ loginMfaAt: new Date() }).where(eq(sessions.id, f.session.id));
    expect((await f.app.inject({ url: next, headers: { cookie: f.cookie } })).statusCode).toBe(200);
    f.config.NATIVE_PRESENTATION_WALLETS = [randomWallet()];
    expect((await f.app.inject({ url: next, headers: { cookie: f.cookie } })).statusCode).toBe(403);
  });

  it('rechecks the tester list after a long poll before reading canonical state again', async () => {
    const f = await fixture();
    const first = await f.app.inject({ url: f.url, headers: { cookie: f.cookie } });
    const pending = f.app.inject({ url: `${f.url}&afterRevision=${first.json().revision}&waitMs=1000`, headers: { cookie: f.cookie } });
    const revoke = setTimeout(() => { f.config.NATIVE_PRESENTATION_WALLETS = [randomWallet()]; }, 30);
    try { expect((await pending).statusCode).toBe(403); } finally { clearTimeout(revoke); }
  });
});
