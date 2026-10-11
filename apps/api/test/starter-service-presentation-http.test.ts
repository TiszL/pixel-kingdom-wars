/** Normal authenticated application pairing. Facilities and term authority are
 * explicit test fixtures; installation, dispatch and read-time return are real.
 * No art permission, source event animation or production activation is implied. */
import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { sessions, starterExpeditionReturns } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), db = conn.db;
let app: FastifyInstance;
beforeAll(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  // This fixture is a deedless kingdom; install the normal free-player route
  // policy at application construction instead of fabricating a paid deed.
  vi.stubEnv('FREE_ONBOARDING', 'true');
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(async () => { await app?.close(); await conn.sql.end(); });

describe('normal authenticated starter presentation HTTP pair', () => {
  it('carries one original installation away and home without authorizing art or a second return', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2035-01-01T01:00:00.000Z'));
    vi.stubEnv('MULTI_BASE_ENABLED', 'true');
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'true');
    const f = await createStarterExpeditionFixture(db);
    const [session] = await db.insert(sessions).values({ wallet: f.wallet,
      expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
    const url = `/base?baseId=${f.baseId}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    async function read(presence: 'occupied' | 'away') {
      const response = await app.inject({ url, cookies });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.baseId).toBe(f.baseId);
      expect(body.starterFleet.installation).toMatchObject({ installationId: f.installationId, berthId: f.berthId });
      expect(body.servicePresentation).toEqual({ version: 1, berths: [{ buildingId: f.berthId,
        installation: { family: 'starter', presence } }] });
      expect(body.features?.phaseEArt).toBeUndefined();
      return response.body;
    }
    const occupied = await read('occupied');
    const trip = await f.dispatch();
    const away = await read('away');
    vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    vi.setSystemTime(new Date(trip.returnsAt.getTime() - 1));
    await read('away');
    vi.setSystemTime(trip.returnsAt);
    const returned = await read('occupied');
    await read('occupied');
    expect(await db.select().from(starterExpeditionReturns).where(eq(starterExpeditionReturns.expeditionId, trip.id))).toHaveLength(1);
    const output = process.env['STARTER_SERVICE_HTTP_PAIR_OUTPUT'];
    if (output) writeFileSync(output, JSON.stringify({ source: {
      kind: 'normal-buildApp-authenticated-inject-response-bodies',
      authority: 'Synthetic facility completion and finalized-term fixture; actual install, dispatch and automatic return services.',
      clock: 'Date-only test clock; return uses the immutable original returnsAt.',
      limits: 'No listening socket, native HTTP request, art capability, pixels, Android or release acceptance.',
      wallet: f.wallet, baseId: f.baseId, installationId: f.installationId, berthId: f.berthId, expeditionId: trip.id,
    }, occupied, away, returned }, null, 2) + '\n');
  });
});
