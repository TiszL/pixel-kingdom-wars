/** review b37cc131 S1. Exercise real base feature production and native
 * serialization; art permission must not change server offers or Berth caps.
 * AUTHORED / UNRUN. Cedar3 must admit the disposable DB fixture and execution. */
import Fastify, { type FastifyInstance } from 'fastify';
import { BUILD_COSTS, BuildingType, PHASE_E_BUILDINGS } from '@shardkeep/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots, buildings } from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { claimRect } from '../src/game/footprints';
import { HttpError } from '../src/lib/errors';
import { registerNativeRoutes } from '../src/native/routes';
import { createTestPlayer } from './helpers';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

const conn = resourceClaimsDatabase(), db = conn.db, apps: FastifyInstance[] = [];
const modern = { 'x-pkw-client': 'android-native', 'x-pkw-renderer-contract': '15' };
const level = Math.max(...PHASE_E_BUILDINGS.types.map(type => BUILD_COSTS[type].requiresKeepLevel));
beforeAll(() => conn.setup(), 120000);
afterAll(() => conn.close());
beforeEach(() => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_VEHICLES_ENABLED', 'false');
  vi.stubEnv('PHASE_E_ART_ENABLED', undefined); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', undefined);
  vi.stubEnv('GEMS_ENABLED', 'false'); vi.stubEnv('FORGE_INGOTS_ENABLED', 'false');
});
afterEach(async () => {
  try { for (const app of apps.splice(0)) await app.close(); }
  finally { vi.unstubAllEnvs(); }
});
async function fixture() {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: level }).returning();
  await db.insert(baseSlots).values({ wallet, baseId: base!.id, slot: 1 });
  await db.insert(buildings).values({ playerWallet: wallet, baseId: base!.id,
    type: BuildingType.Keep, level, tx: claimRect(0).min, ty: claimRect(0).min });
  const app = Fastify(); apps.push(app);
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async () => { throw new HttpError(401, 'no fixture session'); });
  registerNativeRoutes(app, { NATIVE_PRESENTATION_ENABLED: 'false', NATIVE_PRESENTATION_OPEN: 'false',
    NATIVE_UPDATE_CHANNEL_ENABLED: 'false' }, db);
  // The fixture calls the real base producer; production authentication is not under test.
  app.get('/base', () => getBaseState(db, wallet, new Date(), base!.id));
  await app.ready(); return app;
}
async function read(app: FastifyInstance, headers: Record<string, string> = modern) {
  const response = await app.inject({ url: '/base', headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
describe('base art advertisement and server-authoritative construction', () => {
  it.each([
    [undefined, undefined, false], ['true', undefined, false],
    [undefined, 'true', false], ['true', 'true', true],
  ] as const)('art=%s buildings=%s: base permission agrees with native discovery (%s)', async (art, building, enabled) => {
    vi.stubEnv('PHASE_E_ART_ENABLED', art); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', building);
    expect((await read(await fixture())).features.phaseEArt).toEqual({ version: 1, enabled });
  });
  it.each([
    ['legacy native', { 'x-pkw-client': 'android-native', 'x-pkw-renderer-contract': '14' }],
    ['headerless native', { 'x-pkw-client': 'android-native' }],
    ['web', {}],
  ] as Array<[string, Record<string, string>]>)('%s cannot receive the new art feature through GET /base', async (_name, headers) => {
    vi.stubEnv('PHASE_E_ART_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    const app = await fixture(), current = await read(app), older = await read(app, headers);
    expect(older.features).not.toHaveProperty('phaseEArt');
    expect(older.features.phaseEBuildings).toEqual(current.features.phaseEBuildings);
    expect(older.constructionCapacity).toEqual(current.constructionCapacity);
  });
  it('art toggling changes no building offers, Berth capacity or building rows', async () => {
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    const app = await fixture(), off = await read(app);
    vi.stubEnv('PHASE_E_ART_ENABLED', 'true'); const on = await read(app);
    expect(on.features.phaseEBuildings).toEqual({ version: 1, enabledTypes: [...PHASE_E_BUILDINGS.types] });
    expect(off.features.phaseEBuildings).toEqual(on.features.phaseEBuildings);
    expect(off.constructionCapacity).toEqual(on.constructionCapacity);
    // 796a065a MINOR-2: compare real producer rows; no tautological missing-Lodge claim.
    expect(on.buildings).toEqual(off.buildings);
  });
});
