/** Real database + ordinary HTTP hooks, with existing synthetic term/Core/finality
 * fixtures. This is owner-DB evidence, not live provider or restricted LOGIN proof. */
import { PublicKey } from '@solana/web3.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { sessions } from '../src/db/schema';
import { createAdvancedExpeditionGameplay } from '../src/game/advancedExpeditionGameplay';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import * as prefetch from '../src/game/expeditionTermReader';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceExpeditions } from './fixtures/vehicleService';
import { TEST_CONFIG } from './helpers';

const conn = resourceClaimsDatabase(), apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const key = new PublicKey('11111111111111111111111111111111');
const provider = { policy: { genesisHash: key, programId: key, config: key, round: 1n,
  mint: key, prizeOwner: key, prizeAta: key, stateProvenance: 'fresh-reviewed-deployment' as const,
  deployment: { programDataAddress: key.toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } },
  connect: () => { throw new Error('No fixture RPC'); } };
beforeAll(() => conn.setup(), 180_000);
afterAll(() => conn.close());
beforeEach(() => { for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true'); });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
async function cookies(wallet: string) {
  const [session] = await conn.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}
async function open(deps: NonNullable<Parameters<typeof buildApp>[2]>) {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  try { const app = await buildApp(TEST_CONFIG, conn.db, deps); apps.push(app); await app.ready(); return app; }
  finally { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); }
}

it('exposes a fresh starter marker to the game origin only, preserving exact recovery and unrelated response behavior', async () => {
  const f = await createStarterExpeditionFixture(conn.db, { now: new Date() }), auth = await cookies(f.wallet);
  vi.spyOn(prefetch, 'prefetchExpeditionTermReader').mockImplementation(async () => {
    let used = false; return { async readOperatingTerm(at: string) { if (used) throw Error('one use'); used = true; return f.reader.readOperatingTerm(at); } };
  });
  const app = await open({ starterExpeditionProvider: provider });
  const { id: idempotencyKey, ...fields } = f.command, payload = { idempotencyKey, ...fields };
  const post = (origin = TEST_CONFIG.WEB_ORIGIN[0]) => app.inject({ method: 'POST', url: '/starter-expeditions', cookies: auth, headers: { origin }, payload });
  const created = await post();
  expect(created.statusCode, created.body).toBe(201);
  expect(created.headers['x-pkw-journey-created']).toBe('1');
  expect(created.headers['access-control-expose-headers']).toBe('x-pkw-journey-created');
  expect(created.headers['access-control-allow-origin']).toBe(TEST_CONFIG.WEB_ORIGIN[0]);
  const replay = await post();
  expect(replay.statusCode, replay.body).toBe(200); expect(replay.headers['x-pkw-journey-created']).toBeUndefined();
  expect(replay.json().receipt).toEqual(created.json().receipt);
  const foreign = await post('https://untrusted.invalid');
  expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  const view = await app.inject({ url: '/starter-expeditions?baseId=' + f.baseId, cookies: auth, headers: { origin: TEST_CONFIG.WEB_ORIGIN[0] } });
  expect(view.statusCode, view.body).toBe(200); expect(view.headers['x-pkw-journey-created']).toBeUndefined();
});

it('pairs a newly collected advanced return with its ordinary base response once, without historical callback replay', async () => {
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn, completedAt: new Date(Date.now() - 7 * 86_400_000) });
  f.finalizeBurn(); await createVehicleInstallations(conn.db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
  // Reuse D242's declared historical placement fixture: the expedition bank is
  // six days old. Align only original fixture timestamps, never production data.
  await conn.sql.begin(async tx => {
    await tx`set local session_replication_role=replica`;
    await tx`update vehicle_activation_reservations set reserved_at=reserved_at-interval '7 days' where id=${f.reservation.id}`;
    await tx`update vehicle_burn_consumptions set recorded_at=recorded_at-interval '7 days' where reservation_id=${f.reservation.id}`;
    await tx`update advanced_vehicle_installations set installed_at=installed_at-interval '7 days' where reservation_id=${f.reservation.id}`;
  });
  const trips = await vehicleServiceExpeditions(f), trip = await trips.depart();
  vi.setSystemTime(trip.returnsAt); const auth = await cookies(f.actor);
  const app = await open({ advancedExpeditionGameplay: createAdvancedExpeditionGameplay(conn.db) });
  const read = () => app.inject({ url: '/base?baseId=' + f.baseId, cookies: auth });
  const response = await read(); expect(response.statusCode, response.body).toBe(200);
  const [returned] = await conn.sql`select id from advanced_expedition_returns where expedition_id=${trip.id}`;
  expect(returned).toBeDefined();
  expect(response.json().advancedServicePresentation).toMatchObject({ version: 1, berths: expect.arrayContaining([expect.objectContaining({ installation: { family: 'survey_balloon', tier: 1, presence: 'occupied' } })]) });
  expect(response.json().fleetJourneyEvents).toEqual({ version: 1, events: [expect.objectContaining({
    kind: 'return', baseId: f.baseId, installationId: f.reservation.id, expeditionId: trip.id,
    returnId: returned!.id, vehicle: { family: 'survey_balloon', tier: 1 },
  })] });
  const again = await read(); expect(again.statusCode, again.body).toBe(200); expect(again.json()).not.toHaveProperty('fleetJourneyEvents');
  expect(await conn.sql`select id from advanced_expedition_returns where expedition_id=${trip.id}`).toHaveLength(1);
});
