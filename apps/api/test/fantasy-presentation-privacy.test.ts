/** Historical addresses remain recoverable privately, never through a stale
 * globe client after migration or a compatible flag-off rollback. */
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FANTASY_WORLD_ID } from '@shardkeep/shared/fantasyWorld';
import { requireLegacyWorldPresentation } from '../src/game/fantasyLocationRead';
import { listWalletBases } from '../src/game/baseOwnership';
import { resolveFantasyLocation } from '../src/game/fantasyLocationRead';
import { createTestValley, seedPlot } from './helpers';
import { plots } from '../src/db/schema';
import { registerGameRoutes } from '../src/game/routes';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';

let conn: ReturnType<typeof isolatedFantasyTestDb>;
beforeEach(async () => { conn = isolatedFantasyTestDb(); await conn.prepare(); });
afterEach(async () => { vi.unstubAllEnvs(); await conn.dispose(); });

describe('private Earth reconciliation bindings', () => {
  it('returns persisted directory locations and suppresses Earth history for assigned and held deeds even with the flag off', async () => {
    vi.stubEnv('MULTI_BASE_ENABLED', 'true');
    vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
    const fixture = await fantasyBaseFixture(conn.db, { installClaim: true });
    const held = await fantasyBaseFixture(conn.db, { installClaim: true, inactive: true });
    const valley = await createTestValley(conn.db, { name: 'private-reconciliation' });
    await seedPlot(conn.db, { baseId: fixture.baseId, playerWallet: fixture.wallet, valleyId: valley.id, x: 2, y: 2 });
    const before = await conn.db.select().from(plots).where(eq(plots.baseId, fixture.baseId));
    expect(before[0]?.earthCell).not.toBeNull();
    const location = await resolveFantasyLocation(conn.db, fixture.baseId);
    const app = Fastify();
    app.decorateRequest('wallet', '');
    app.decorate('authenticate', async (req: { wallet: string }) => { req.wallet = fixture.wallet; });
    app.decorate('authenticateLoginRecovery', app.authenticate);
    app.decorate('requireLandOwned', async () => undefined);
    registerGameRoutes(app as never, conn.db);
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/bases' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ worldId: 'fantasy-v1', bases: [{
        id: fixture.baseId, deedAssetId: fixture.mintId, earthCell: null, countryA3: null, fantasyLocation: location,
      }] });
      expect(await listWalletBases(conn.db, held.wallet)).toMatchObject([{ fantasyLocation: null, earthCell: null, countryA3: null }]);
      expect(await conn.db.select().from(plots).where(eq(plots.baseId, fixture.baseId))).toEqual(before);
    } finally { await app.close(); }
  });

  it('rejects every old presentation route once a location is assigned, including flag-off rollback', async () => {
    vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
    await expect(requireLegacyWorldPresentation(conn.db)).resolves.toBeUndefined();
    const fixture = await fantasyBaseFixture(conn.db, { installClaim: true });
    const app = Fastify();
    app.decorateRequest('wallet', '');
    app.decorate('authenticate', async (req: { wallet: string }) => { req.wallet = fixture.wallet; });
    app.decorate('authenticateLoginRecovery', app.authenticate);
    app.decorate('requireLandOwned', async () => undefined);
    registerGameRoutes(app as never, conn.db);
    await app.ready();
    try {
      for (const enabled of ['true', 'false']) {
        vi.stubEnv('FANTASY_WORLD_ENABLED', enabled);
        for (const url of ['/map?parcelBand=1', '/map/me', '/map/parcel/1', '/globe',
          '/globe/sector/1', '/globe/parcels', '/map/search?q=aa']) {
          const response = await app.inject({ method: 'GET', url });
          expect(response.statusCode, `${enabled}: ${url}: ${response.body}`).toBe(409);
          expect(response.json().code).toBe('WORLD_UPDATE_REQUIRED');
        }
      }
    } finally { await app.close(); }
  });

  it('keeps the fence after cutover even before the first payment becomes assigned', async () => {
    vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
    await fantasyBaseFixture(conn.db, { installClaim: true, inactive: true });
    await expect(requireLegacyWorldPresentation(conn.db)).resolves.toBeUndefined();
    await conn.db.execute(sql`INSERT INTO fantasy_purchase_cutover(world_id) VALUES (${FANTASY_WORLD_ID})`);
    await expect(requireLegacyWorldPresentation(conn.db)).rejects.toMatchObject({ statusCode: 409, code: 'WORLD_UPDATE_REQUIRED' });
  });
});
