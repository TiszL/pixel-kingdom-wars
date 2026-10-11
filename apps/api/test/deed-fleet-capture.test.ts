/** Real accepted local lifecycle, synthetic encoded chain/facility/clock fixtures.
 * Source packet only: no deed painter, cache publication, PNG or R2 proof. */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { starterRoutePreview } from '@shardkeep/shared/phaseEExpeditions';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { bases, baseSlots, buildings, players } from '../src/db/schema';
import { captureDeedFleetDrawing, deedDrawingFingerprint, deedDrawingIdentityCurrent } from '../src/game/deedFleetCapture';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { createVehicleServiceApplications } from '../src/game/vehicleServiceApplications';
import { installStarterFleet } from '../src/game/starterFleet';
import { dispatchStarterExpedition } from '../src/game/starterExpeditionDispatch';
import { settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { transferStableBase } from '../src/game/baseOwnership';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceBuilding, vehicleServiceExpeditions } from './fixtures/vehicleService';
import { vehicleServiceConsentFixture } from './fixtures/vehicleServicePreparation';
import { ADMIN_DATABASE_URL } from './db-url';

const conn = resourceClaimsDatabase(), db = conn.db;
// Explicit synthetic admission identity for this source test, not actual art admission.
const art = 'ab'.repeat(32);
const resourcePath = '/tmp/deed-fleet-capture-owned-db.json';
beforeAll(async () => {
  await conn.setup();
  await writeFile(resourcePath, JSON.stringify({ database: (await conn.sql`select current_database() name`)[0]!.name,
    host: '127.0.0.1', port: 55492, state: 'running-owned-fixture' }));
}, 180000);
afterAll(async () => {
  await conn.close();
  try { const record = JSON.parse(await readFile(resourcePath, 'utf8')); await writeFile(resourcePath, JSON.stringify({ ...record, state: 'closed-and-owned-database-dropped' })); }
  catch { /* Setup failures are independently reported. */ }
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function installed() {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true');
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn, completedAt: new Date(Date.now() - 8 * 86400000) });
  f.finalizeBurn(); await createVehicleInstallations(db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
  // Same accepted historical expedition fixture clock placement as D242.
  await conn.sql.begin(async tx => {
    await tx`set local session_replication_role=replica`;
    await tx`update vehicle_activation_reservations set reserved_at=reserved_at-interval '7 days' where id=${f.reservation.id}`;
    await tx`update vehicle_burn_consumptions set recorded_at=recorded_at-interval '7 days' where reservation_id=${f.reservation.id}`;
    await tx`update advanced_vehicle_installations set installed_at=installed_at-interval '7 days' where reservation_id=${f.reservation.id}`;
  });
  return { ...f, deedAssetId: Keypair.generate().publicKey.toBase58() };
}
type Fixture = Awaited<ReturnType<typeof installed>>;
async function deed(f: Fixture) {
  await db.update(bases).set({ deedAssetId: f.deedAssetId, deedMintAssetId: f.deedAssetId, landPaidAt: new Date() }).where(eq(bases.id, f.baseId));
}
const capture = (f: Fixture, cutoff = new Date(), database = db) => captureDeedFleetDrawing(database, f.actor, f.baseId, f.deedAssetId, art, () => cutoff);
async function both() {
  const f = await installed(), trips = await vehicleServiceExpeditions(f), berthId = await vehicleServiceBuilding(f, 'berth');
  const starter = await installStarterFleet(db, f.actor, berthId, trips.authority);
  return { ...f, trips, starter };
}

it('captures both real installations and construction once, freezes geometry and hashes only drawing changes', async () => {
  const f = await both(), pending = randomUUID();
  await conn.sql`insert into buildings(id,player_wallet,base_id,type,level,tx,ty) values(${pending},${f.actor},${f.baseId},'berth',0,20,20)`;
  await conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${f.actor},${f.baseId},${pending},'build',now(),now()+interval '1 day')`;
  await deed(f);
  const first = (await capture(f))!, hash = deedDrawingFingerprint(first);
  expect(first.servicePresentation.berths).toContainEqual({ buildingId: f.starter.berthId, installation: { family: 'starter', presence: 'occupied' } });
  expect(first.advancedServicePresentation.berths).toContainEqual({ buildingId: f.berthId, installation: { family: 'survey_balloon', tier: 1, presence: 'occupied' } });
  for (const sibling of [first.servicePresentation, first.advancedServicePresentation]) expect(sibling.berths).toContainEqual({ buildingId: pending, installation: null });
  expect(first.buildings.find(b => b.id === pending)?.underConstruction).toBe(true);
  expect(Object.isFrozen(first.buildings[0])).toBe(true);
  expect(Object.isFrozen(first.advancedServicePresentation.berths[0]?.installation)).toBe(true);
  expect(deedDrawingFingerprint((await capture(f, new Date(Date.now() + 1000)))!)).toBe(hash);
  expect(await deedDrawingIdentityCurrent(db, first)).toBe(true);
  // A pre-existing RR snapshot must never certify identity before a future PUT.
  await expect(db.transaction(tx => deedDrawingIdentityCurrent(tx as unknown as typeof db, first),
    { isolationLevel: 'repeatable read' })).rejects.toThrow('top-level');
  await db.update(buildings).set({ tx: 10 }).where(eq(buildings.id, f.berthId));
  expect(first.buildings.find(b => b.id === f.berthId)?.tx).toBe(2);
  expect(deedDrawingFingerprint(first)).toBe(hash);
  expect(deedDrawingFingerprint((await capture(f))!)).not.toBe(hash);
  expect(JSON.stringify(first)).not.toMatch(/reservationId|completedTotal|allowanceStart|cutoff|signature/);
  await expect(captureDeedFleetDrawing(db, f.actor, f.baseId, f.deedAssetId, 'AB'.repeat(32))).rejects.toThrow();
  // Deliberate invalid JavaScript caller: both the public type and runtime guard refuse it.
  await expect(db.transaction(tx => captureDeedFleetDrawing(tx as unknown as typeof db, f.actor, f.baseId, f.deedAssetId, art))).rejects.toThrow('top-level');
});

it('holds overdue starter while advanced stays away, performs no return writes and uses actual accepted returns', async () => {
  const f = await both(), advanced = await f.trips.depart(), route = starterRoutePreview('crownlands', 'introduction');
  const starter = await dispatchStarterExpedition(db, f.actor, { id: randomUUID(), baseId: f.baseId,
    installationId: f.starter.installationId, routeId: route.routeId, routeVersion: route.routeCatalogueVersion,
    rewardVersion: route.rewardTableVersion }, f.trips.authority, { reader: await f.trips.reader(), clock: f.trips.clock });
  await deed(f);
  const before = (await capture(f))!;
  expect(before.servicePresentation.berths.find(b => b.installation)?.installation?.presence).toBe('away');
  const stock = await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${f.baseId} order by resource_id`;
  const ledger = await conn.sql`select count(*)::integer n from ledger_transactions`;
  const cutoff = new Date(Math.max(+starter.returnsAt, +advanced.returnsAt) + 1);
  expect(await capture(f, cutoff)).toBeNull();
  expect(await conn.sql`select id from starter_expedition_returns where expedition_id=${starter.id}`).toHaveLength(0);
  expect(await conn.sql`select id from advanced_expedition_returns where expedition_id=${advanced.id}`).toHaveLength(0);
  expect(await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${f.baseId} order by resource_id`).toEqual(stock);
  expect(await conn.sql`select count(*)::integer n from ledger_transactions`).toEqual(ledger);
  // An unavailable starter must not suppress the other mandatory source error.
  await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) immutable`;
  try { await expect(capture(f, cutoff)).rejects.toMatchObject({ cause: { message: 'CURRENT_ADVANCED_SOURCE' } }); }
  finally { await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) volatile`; }
  await db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, cutoff));
  const partly = (await capture(f, cutoff))!;
  expect(partly.servicePresentation.berths.find(b => b.installation)?.installation?.presence).toBe('occupied');
  expect(partly.advancedServicePresentation.berths.find(b => b.installation)?.installation?.presence).toBe('away');
  await f.trips.complete(advanced);
  const returned = (await capture(f, cutoff))!;
  expect(returned.advancedServicePresentation.berths.find(b => b.installation)?.installation?.presence).toBe('occupied');
  expect(deedDrawingFingerprint(returned)).not.toBe(deedDrawingFingerprint(partly));
});

it('keeps pending service out of the fingerprint and refuses an actual application after the shared cutoff', async () => {
  const f = await installed();
  const consent = await vehicleServiceConsentFixture(f), prepared = await consent.preparations.prepare(f.actor, consent.intent.id);
  await deed(f);
  const first = (await capture(f))!, cutoff = new Date();
  expect(first.advancedServicePresentation.berths[0]?.installation?.tier).toBe(1);
  expect(deedDrawingFingerprint((await capture(f))!)).toBe(deedDrawingFingerprint(first));
  consent.finalizeService(prepared);
  await createVehicleServiceApplications(db, { verifyBurn: consent.reader.verify }).recover(f.actor, consent.intent.id);
  expect(await capture(f, cutoff)).toBeNull();
  const applied = (await capture(f))!;
  expect(applied.advancedServicePresentation.berths[0]?.installation?.tier).toBe(2);
  expect(deedDrawingFingerprint(applied)).not.toBe(deedDrawingFingerprint(first));
});

it('separates missing optional capability from integrity errors and refuses observed lock contention without a retry', async () => {
  const f = await installed(); await deed(f);
  await conn.sql`alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) rename to owned_fixture_absent_current_advanced`;
  try { expect(await capture(f)).toBeNull(); }
  finally { await conn.sql`alter function public.owned_fixture_absent_current_advanced(text,uuid,jsonb,timestamptz) rename to shardkeep_current_advanced_presentation`; }
  const other = conn.reopen(); let entered!: () => void, release!: () => void;
  const locked = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const holder = other.sql.begin(async tx => { await tx`select id from bases where id=${f.baseId} for update`; entered(); await gate; });
  try { await locked; await expect(capture(f)).rejects.toMatchObject({ cause: { code: '55P03' } }); }
  finally { release(); await holder; await other.sql.end(); }
  expect(await capture(f)).not.toBeNull();
});

it('binds exact asset and custody through a genuine transfer and refuses inactive or missing-slot current facts', async () => {
  const f = await installed(); await deed(f); const captured = (await capture(f))!;
  const buyer = Keypair.generate().publicKey.toBase58(); await db.insert(players).values({ wallet: buyer });
  await transferStableBase(db, f.baseId, f.actor, buyer, f.deedAssetId,
    { owner: buyer, collection: Keypair.generate().publicKey.toBase58(), frozen: false, delegate: null, slot: 100, observedAtMs: Date.now() }, () => new Date());
  expect(await deedDrawingIdentityCurrent(db, captured)).toBe(false);
  expect(await capture(f)).toBeNull();
  const bought = { ...f, actor: buyer };
  const current = (await capture(bought))!;
  expect(current.identity.baseId).toBe(captured.identity.baseId);
  expect(current.advancedServicePresentation).toEqual(captured.advancedServicePresentation);
  expect(await captureDeedFleetDrawing(db, buyer, f.baseId, Keypair.generate().publicKey.toBase58(), art)).toBeNull();
  await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId));
  expect(await capture(bought)).toBeNull(); expect(await deedDrawingIdentityCurrent(db, current)).toBe(false);
  await db.update(baseSlots).set({ active: true }).where(eq(baseSlots.baseId, f.baseId));
  await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
  expect(await capture(bought)).toBeNull();
});

it('captures through the actual restricted worker capability and propagates missing EXECUTE permissions', async () => {
  const f = await both(); await deed(f);
  const api = 'dfapi_' + randomBytes(8).toString('hex'), worker = 'dfworker_' + randomBytes(8).toString('hex');
  const password = randomBytes(32).toString('hex'), workerPassword = randomBytes(32).toString('hex');
  const admin = new URL(ADMIN_DATABASE_URL);
  const name = String((await conn.sql`select current_database() name`)[0]!.name);
  let runtime: ReturnType<typeof createDb> | undefined;
  try {
    execFileSync('sh', [fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url))], {
      timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/opt/homebrew/opt/postgresql@16/bin:' + process.env.PATH,
        PGHOST: admin.hostname, PGPORT: admin.port, PGDATABASE: name, PGUSER: decodeURIComponent(admin.username), PGPASSWORD: decodeURIComponent(admin.password),
        POSTGRES_USER: decodeURIComponent(admin.username), POSTGRES_PASSWORD: decodeURIComponent(admin.password) || 'owned-loopback-trust-fixture',
        DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: api, API_DB_PASSWORD: password, WORKER_DB_USER: worker, WORKER_DB_PASSWORD: workerPassword },
    });
    admin.pathname = '/' + name; admin.username = worker; admin.password = workerPassword;
    runtime = createDb(admin.toString(), { max: 2 });
    expect(await capture(f, new Date(), runtime.db)).toEqual(await capture(f));
    await expect(runtime.sql`select * from advanced_vehicle_installations`).rejects.toMatchObject({ code: '42501' });
    await conn.sql`revoke execute on function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) from shardkeep_worker_runtime`;
    await expect(capture(f, new Date(), runtime.db)).rejects.toMatchObject({ cause: { code: '42501' } });
  } finally {
    await runtime?.sql.end();
    for (const role of [api, worker]) {
      if ((await conn.sql`select 1 from pg_roles where rolname=${role}`).length) {
        await conn.sql.unsafe(`drop owned by ${role}`); await conn.sql.unsafe(`drop role ${role}`);
      }
    }
  }
}, 60000);
