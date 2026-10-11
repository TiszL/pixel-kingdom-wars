/** D-151 opens only a dark policy read. Future economy rules must not grant
 * gameplay authority, bypass admission, create a base or alter a balance. */
import { randomUUID } from 'node:crypto';
import { PhaseECatalogueResponseSchema } from '@shardkeep/shared/phaseE';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import { accounts, bases, ledgerEntries, players, sessions } from '../src/db/schema';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';

const PATH = '/game/phase-e/catalogue';
const conn = connectTestDb();
const originalFlag = process.env['PHASE_E_CATALOG_ENABLED'];
const apps: FastifyInstance[] = [];

beforeEach(() => { delete process.env['PHASE_E_CATALOG_ENABLED']; });
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (originalFlag === undefined) delete process.env['PHASE_E_CATALOG_ENABLED'];
  else process.env['PHASE_E_CATALOG_ENABLED'] = originalFlag;
});
afterAll(async () => { await conn.sql.end(); });

async function makeApp(config = TEST_CONFIG): Promise<FastifyInstance> {
  const app = await buildApp(config, conn.db);
  apps.push(app);
  return app;
}

async function signedInPlayer() {
  const player = await createTestPlayer(conn.db);
  const sessionId = randomUUID();
  await conn.db.insert(sessions).values({
    id: sessionId, wallet: player.wallet, expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = await issueSessionJwt(TEST_CONFIG, player.wallet, sessionId);
  return { ...player, sessionId, cookies: { [SESSION_COOKIE]: token } };
}

async function playerState(wallet: string) {
  return Promise.all([
    conn.db.select().from(players).where(eq(players.wallet, wallet)),
    conn.db.select().from(bases).where(eq(bases.ownerWallet, wallet)),
    conn.db.select().from(accounts).where(eq(accounts.ownerWallet, wallet)).orderBy(accounts.id),
    conn.db.select({ entry: ledgerEntries }).from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(eq(accounts.ownerWallet, wallet)).orderBy(ledgerEntries.id),
  ]);
}

describe('Phase E catalogue admission and dark rollout', () => {
  it('refuses an authenticated player while unset, without publishing the catalogue', async () => {
    const app = await makeApp();
    const player = await signedInPlayer();
    const before = await playerState(player.wallet);
    const response = await app.inject({ method: 'GET', url: PATH, cookies: player.cookies });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: {
      code: 'PHASE_E_DISABLED', message: 'Phase E catalogue is not enabled',
    } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await playerState(player.wallet)).toEqual(before);
  });

  it.each(['false', 'true'])('requires authentication with flag %s', async (flag) => {
    process.env['PHASE_E_CATALOG_ENABLED'] = flag;
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: PATH });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { message: 'authentication required' } });
  });

  it('returns the same strict policy to deedless players without creating gameplay state', async () => {
    process.env['PHASE_E_CATALOG_ENABLED'] = 'true';
    const app = await makeApp();
    const first = await signedInPlayer();
    const second = await signedInPlayer();
    const before = await Promise.all([playerState(first.wallet), playerState(second.wallet)]);
    const responses = await Promise.all([first, second].map((player) =>
      app.inject({ method: 'GET', url: PATH, cookies: player.cookies })));
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const parsed = PhaseECatalogueResponseSchema.parse(response.json());
      expect(parsed).toMatchObject({ version: 1, status: 'specified', gameplayEnabled: false, claims: { genesis: 'none' }, currencies: { legacyCustodialKeep: 'converts-to-gems-at-cutover' } });
      expect(response.body).not.toContain(first.wallet);
      expect(response.body).not.toContain(second.wallet);
    }
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(await Promise.all([playerState(first.wallet), playerState(second.wallet)])).toEqual(before);

    // A cached policy response cannot bypass the operational read gate.
    process.env['PHASE_E_CATALOG_ENABLED'] = 'false';
    const disabled = await app.inject({ method: 'GET', url: PATH, cookies: first.cookies });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().error.code).toBe('PHASE_E_DISABLED');
  });

  it('honors session revocation even when the catalogue is enabled', async () => {
    process.env['PHASE_E_CATALOG_ENABLED'] = 'true';
    const app = await makeApp();
    const player = await signedInPlayer();
    await conn.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, player.sessionId));
    const response = await app.inject({ method: 'GET', url: PATH, cookies: player.cookies });
    expect(response.statusCode).toBe(401);
  });

  it('preserves alpha admission rather than treating a session as catalogue access', async () => {
    process.env['PHASE_E_CATALOG_ENABLED'] = 'true';
    const app = await makeApp({ ...TEST_CONFIG, PLAYTEST_OPEN: 'false', ALPHA_WALLETS: [randomWallet()] });
    const player = await signedInPlayer();
    const response = await app.inject({ method: 'GET', url: PATH, cookies: player.cookies });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ALPHA_GATED');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('does not register a %s mutation', async (method) => {
    process.env['PHASE_E_CATALOG_ENABLED'] = 'true';
    const app = await makeApp();
    const player = await signedInPlayer();
    const before = await playerState(player.wallet);
    const response = await app.inject({ method, url: PATH, cookies: player.cookies });
    expect(response.statusCode).toBe(404);
    expect(app.hasRoute({ method, url: PATH })).toBe(false);
    expect(await playerState(player.wallet)).toEqual(before);
  });
});
