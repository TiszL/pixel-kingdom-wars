/** C5 starter hook through the actual provisioned request LOGIN. Synthetic
 * facilities/terms; real dispatch, lazy settlement, grants and ordinary HTTP. */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { assertRuntimeRoleProvisioningSafe } from './fixtures/runtimeRoleProvisioningGuard';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { TEST_CONFIG } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';

const conn = resourceClaimsDatabase(), admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => undefined });
const ownedRoles = new Map<string, number>();
let request: ReturnType<typeof createDb>, app: Awaited<ReturnType<typeof buildApp>>;
const role = 'journeyapi_' + randomBytes(8).toString('hex'), worker = 'journeyworker_' + randomBytes(8).toString('hex');
beforeAll(async () => {
  await assertRuntimeRoleProvisioningSafe(admin, role, worker);
  await conn.setup();
  const url = new URL(ADMIN_DATABASE_URL), name = String((await conn.sql`select current_database() name`)[0]!.name);
  url.pathname = '/' + name;
  const password = randomBytes(32).toString('hex');
  await assertRuntimeRoleProvisioningSafe(admin, role, worker);
  try { execFileSync('sh', [fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url))], {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH,
      PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: name, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
      POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password) || 'owned-loopback-trust-fixture',
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: role, API_DB_PASSWORD: password,
      WORKER_DB_USER: worker, WORKER_DB_PASSWORD: randomBytes(32).toString('hex') },
  }); } finally {
    // Both names were absent immediately before this serialized fixture provision.
    const created = await admin`select rolname,oid from pg_roles where rolname in (${role},${worker})`;
    for (const row of created) ownedRoles.set(String(row.rolname), Number(row.oid));
  }
  url.username = role; url.password = password; request = createDb(url.toString(), { max: 4 });
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('FREE_ONBOARDING', 'true'); app = await buildApp(TEST_CONFIG, request.db); await app.ready(); vi.unstubAllEnvs();
}, 180_000);
afterAll(async () => {
  const failures: unknown[] = [];
  const attempt = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { failures.push(error); } };
  await attempt(async () => app?.close()); await attempt(async () => request?.sql.end());
  for (const [name, oid] of ownedRoles) await attempt(async () => {
    const [current] = await admin`select oid from pg_roles where rolname=${name}`;
    if (!current) return;
    if (Number(current.oid) !== oid) throw Error('Refusing cleanup of replaced fixture role: ' + name);
    await conn.sql.unsafe(`drop owned by ${name}`); await conn.sql.unsafe(`drop role ${name}`);
  });
  await attempt(() => conn.close()); await attempt(() => admin.end());
  if (failures.length) throw new AggregateError(failures, 'Owned fleet journey runtime fixture cleanup failed');
});
beforeEach(() => { for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true'); });
afterEach(() => { vi.unstubAllEnvs(); });
async function fixture() {
  const f = await createStarterExpeditionFixture(conn.db, { now: new Date(Date.now() - 86_400_000) }), trip = await f.dispatch();
  const [session] = await conn.db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  return { ...f, trip, read: () => app.inject({ url: '/base?baseId=' + f.baseId, cookies }) };
}

it('returns a redacted fresh starter callback once with its committed stock, without historical replay', async () => {
  const f = await fixture(), response = await f.read(); expect(response.statusCode, response.body).toBe(200);
  const [proof] = await conn.sql`select id from starter_expedition_returns where expedition_id=${f.trip.id}`;
  expect(proof).toBeDefined();
  expect(response.json().fleetJourneyEvents).toEqual({ version: 1, events: [{ version: 1, kind: 'return', baseId: f.baseId,
    berthId: f.berthId, installationId: f.installationId, expeditionId: f.trip.id, returnId: proof!.id,
    at: expect.any(String), vehicle: { family: 'starter' }, wake: { state: 'available', visual: { version: 1, wake: null } } }] });
  const firstStock = response.json().rawStock, again = await f.read();
  expect(again.statusCode, again.body).toBe(200); expect(again.json()).not.toHaveProperty('fleetJourneyEvents');
  expect(again.json().rawStock).toEqual(firstStock);
  await expect(request.sql`select * from bound_cosmetic_starter_wakes`).rejects.toMatchObject({ code: '42501' });
});

it('rolls back a newly settled return when its mandatory private reader is denied, then retries only the still-uncommitted return', async () => {
  const f = await fixture();
  await conn.sql`revoke execute on function public.shardkeep_bound_cosmetic_starter_wake(uuid) from shardkeep_api_runtime`;
  try {
    const failed = await f.read(); expect(failed.statusCode).toBe(500);
    expect(await conn.sql`select id from starter_expedition_returns where expedition_id=${f.trip.id}`).toEqual([]);
    expect(await conn.sql`select expedition_id from starter_expedition_inflight where expedition_id=${f.trip.id}`).toHaveLength(1);
  } finally { await conn.sql`grant execute on function public.shardkeep_bound_cosmetic_starter_wake(uuid) to shardkeep_api_runtime`; }
  const response = await f.read(); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().fleetJourneyEvents.events).toHaveLength(1);
  expect(await conn.sql`select id from starter_expedition_returns where expedition_id=${f.trip.id}`).toHaveLength(1);
});
