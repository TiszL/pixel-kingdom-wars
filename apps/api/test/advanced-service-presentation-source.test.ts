/** Owned loopback fixture: synthetic historical clocks/materials and encoded
 * finalized chain observations; genuine install, service, dispatch and return. */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bases, buildings, players, sessions } from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { readAdvancedServicePresentation } from '../src/game/advancedServicePresentation';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { createVehicleServiceApplications } from '../src/game/vehicleServiceApplications';
import { settleDueAdvancedExpeditions } from '../src/game/advancedExpeditionReturns';
import { transferStableBase, assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { TEST_CONFIG } from './helpers';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceConsentFixture } from './fixtures/vehicleServicePreparation';
import { vehicleServiceExpeditions, vehicleServiceInstallation } from './fixtures/vehicleService';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { ADMIN_DATABASE_URL } from './db-url';

const conn = resourceClaimsDatabase(), db = conn.db;
const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const apply = async (tx: postgres.TransactionSql, body: string) => {
  for (const part of body.split('--> statement-breakpoint')) if (part.trim()) await tx.unsafe(part);
};
const flags = () => {
  for (const key of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(key, 'true');
};
const seals = async () => {
  const result: Record<string, unknown> = {};
  for (const table of ['raid_advanced_presentation_contract', 'raid_starter_presentation_contract', 'bound_cosmetic_return_contract', 'bound_cosmetic_charter_contract', 'bound_cosmetic_wake_contract', 'service_activity_contract']) result[table] = await conn.sql.unsafe(`select * from public.${table}`);
  return result;
};
let before: Record<string, unknown>, readerSql: string, sourceSql: string;
beforeAll(async () => {
  const folder = await mkdtemp(join(tmpdir(), 'current-advanced-journal-')), real = runMigrations;
  try {
    await cp(migrations, folder, { recursive: true });
    const path = join(folder, 'meta/_journal.json'), journal = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...journal, entries: journal.entries.filter((e: { idx: number }) => e.idx < 293) }));
    const mod = await import('../src/db/migrate');
    const spy = vi.spyOn(mod, 'runMigrations').mockImplementationOnce(db => real(db, { migrationsFolder: folder }));
    try { await conn.setup(); } finally { spy.mockRestore(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
  await writeFile('/tmp/advanced-current-owned-db.json', JSON.stringify({ database: (await conn.sql`select current_database() name`)[0]!.name, host: '127.0.0.1', port: 55492, state: 'running-owned-fixture' }));
  before = await seals();
  readerSql = await readFile(join(migrations, '0290_current_advanced_presentation.sql'), 'utf8');
  sourceSql = await readFile(join(migrations, '0291_current_advanced_presentation_source.sql'), 'utf8');
}, 180000);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await conn.close();
  const path = '/tmp/advanced-current-owned-db.json';
  try { const record = JSON.parse(await readFile(path, 'utf8')); await writeFile(path, JSON.stringify({ ...record, state: 'closed-and-owned-database-dropped' })); }
  catch { /* Vitest reports setup errors independently. */ }
});
it('admits only the exact additive capability and preserves every predecessor seal', async () => {
  for (const mutation of ['alter function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) security invoker',
    "create or replace function public.shardkeep_current_advanced_presentation(actor text,target uuid,current_buildings jsonb,cutoff timestamptz) returns jsonb language sql set search_path=pg_catalog,public,pg_temp as $$select null::jsonb$$"]) {
    await expect(conn.sql.begin(async tx => { await apply(tx, readerSql); await tx.unsafe(mutation); await apply(tx, sourceSql); })).rejects.toThrow('CURRENT_ADVANCED_SEAL_SOURCE');
  }
  await runMigrations(db);
  expect(await seals()).toEqual(before);
  expect((await conn.sql`select public.shardkeep_current_advanced_sources_valid() current, public.shardkeep_bound_cosmetic_wake_sources_valid() previous`)[0]).toEqual({ current: true, previous: true });
}, 180000);
type Fixture = Awaited<ReturnType<typeof vehicleBurnDatabase>>;
async function installation() {
  flags(); await runMigrations(db);
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn, completedAt: new Date(Date.now() - 8 * 86400000) });
  f.finalizeBurn(); await createVehicleInstallations(db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
  // Explicit synthetic placement matches the accepted expedition fixture's old
  // bank clock; only these timestamp fields change, with triggers restored.
  await conn.sql.begin(async tx => {
    await tx`set local session_replication_role=replica`;
    await tx`update vehicle_activation_reservations set reserved_at=reserved_at-interval '7 days' where id=${f.reservation.id}`;
    await tx`update vehicle_burn_consumptions set recorded_at=recorded_at-interval '7 days' where reservation_id=${f.reservation.id}`;
    await tx`update advanced_vehicle_installations set installed_at=installed_at-interval '7 days' where reservation_id=${f.reservation.id}`;
  });
  return f;
}
const authority = async (...args: Parameters<typeof assertFreshLockedBaseAuthority>) => { await assertFreshLockedBaseAuthority(...args); };
const state = (f: Fixture, at = new Date()) => getBaseState(db, f.actor, at, f.baseId, authority, () => at);
const shape = (f: Fixture, presence: 'occupied' | 'away' | 'exhausted', tier = 1) => ({ version: 1, berths: [{ buildingId: f.berthId, installation: { family: 'survey_balloon', tier, presence } }] });
const current = async (f: Fixture, at = new Date()) => db.transaction(async tx => {
  const b = await tx.select().from(buildings).where(eq(buildings.baseId, f.baseId));
  return readAdvancedServicePresentation(tx, f.actor, f.baseId, b, at);
});
it('retains the applied tier during pending upgrade and pause, then reads the genuine application', async () => {
  const f = await installation(), consent = await vehicleServiceConsentFixture(f);
  const prepared = await consent.preparations.prepare(f.actor, consent.intent.id);
  expect((await state(f)).advancedServicePresentation).toEqual(shape(f, 'occupied'));
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED', 'false');
  expect((await state(f)).advancedServicePresentation).toEqual(shape(f, 'occupied'));
  consent.finalizeService(prepared);
  await createVehicleServiceApplications(db, { verifyBurn: consent.reader.verify }).recover(f.actor, consent.intent.id);
  expect((await state(f)).advancedServicePresentation).toEqual(shape(f, 'occupied', 2));
  expect(await getBaseState(db, f.actor, new Date(), f.baseId)).not.toHaveProperty('advancedServicePresentation');
});
it('keeps overdue unreturned originals away without stock ledger or return writes, until actual collection', async () => {
  const f = await installation(), trips = await vehicleServiceExpeditions(f), trip = await trips.depart();
  const beforeStock = await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${f.baseId} order by resource_id`;
  const beforeLedger = await conn.sql`select count(*)::integer n from ledger_transactions`;
  expect((await state(f, new Date(+trip.returnsAt + 1))).advancedServicePresentation).toEqual(shape(f, 'away'));
  expect(await conn.sql`select * from advanced_expedition_returns where expedition_id=${trip.id}`).toHaveLength(0);
  expect(await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${f.baseId} order by resource_id`).toEqual(beforeStock);
  expect(await conn.sql`select count(*)::integer n from ledger_transactions`).toEqual(beforeLedger);
  await trips.complete(trip);
  expect((await state(f, trip.returnsAt)).advancedServicePresentation).toEqual(shape(f, 'occupied'));
});
it('closes construction empty berths and multiple installed families without replacing starter facts', async () => {
  const f = await installation(), second = await vehicleServiceInstallation(f, 'cargo_cutter');
  const scaffold = randomUUID(), empty = randomUUID();
  await conn.sql`insert into buildings(id,player_wallet,base_id,type,level,tx,ty) values(${scaffold},${f.actor},${f.baseId},'berth',0,15,15),(${empty},${f.actor},${f.baseId},'berth',1,20,20)`;
  await conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${f.actor},${f.baseId},${scaffold},'build',now(),now()+interval '1 day')`;
  const result = await state(f), berths = result.advancedServicePresentation!.berths;
  expect(berths).toHaveLength(4);
  expect(berths).toContainEqual(shape(f, 'occupied').berths[0]);
  expect(berths).toContainEqual({ buildingId: second.reservation.berthId, installation: { family: 'cargo_cutter', tier: 1, presence: 'occupied' } });
  for (const id of [scaffold, empty]) expect(berths).toContainEqual({ buildingId: id, installation: null });
  expect(result.servicePresentation).toBeDefined();
});
it('refuses broken pointers service half-pairs and build originals even with unavailable caller structure', async () => {
  const f = await installation(), consent = await vehicleServiceConsentFixture(f), prepared = await consent.preparations.prepare(f.actor, consent.intent.id);
  consent.finalizeService(prepared); await createVehicleServiceApplications(db, { verifyBurn: consent.reader.verify }).recover(f.actor, consent.intent.id);
  const rollback = Error('rollback owned corruption');
  for (const mutation of [sql`delete from vehicle_service_applications where intent_id=${consent.intent.id}`,
    sql`update builder_jobs set completed_at=completed_at+interval '1 millisecond' where id=${f.jobId}`]) {
    await expect(db.transaction(async tx => {
      await tx.execute(sql`set local session_replication_role=replica`); await tx.execute(mutation); await tx.execute(sql`set local session_replication_role=origin`);
      await expect(readAdvancedServicePresentation(tx, f.actor, f.baseId, [], new Date())).rejects.toThrow(); throw rollback;
    })).rejects.toBe(rollback);
  }
  const g = await installation(), trips = await vehicleServiceExpeditions(g), trip = await trips.depart();
  await expect(db.transaction(async tx => {
    await tx.execute(sql`set local session_replication_role=replica`);
    await tx.execute(sql`delete from advanced_expedition_inflight where installation_id=${g.reservation.id}`);
    await tx.execute(sql`set local session_replication_role=origin`);
    await expect(readAdvancedServicePresentation(tx, g.actor, g.baseId, [], new Date())).rejects.toMatchObject({ cause: { message: 'CURRENT_ADVANCED_FLIGHT_SOURCE' } });
    throw rollback;
  })).rejects.toBe(rollback);
  await trips.complete(trip);
  await expect(db.transaction(async tx => {
    await tx.execute(sql`set local session_replication_role=replica`);
    await tx.execute(sql`update advanced_expedition_returns set returned_at='infinity' where expedition_id=${trip.id}`);
    await tx.execute(sql`set local session_replication_role=origin`);
    await expect(readAdvancedServicePresentation(tx, g.actor, g.baseId, [], new Date()))
      .rejects.toMatchObject({ cause: { message: 'CURRENT_ADVANCED_ORIGINAL_CLOCK' } });
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await db.transaction(tx => readAdvancedServicePresentation(tx, f.actor, f.baseId, [], new Date()))).toBeNull();
});
it('holds installation locks and returns optional unavailable for a genuine service after the sampled cutoff', async () => {
  const f = await installation(), consent = await vehicleServiceConsentFixture(f), prepared = await consent.preparations.prepare(f.actor, consent.intent.id);
  consent.finalizeService(prepared);
  const proof = await consent.reader.verify({ reservationId: consent.intent.id });
  const cutoff = new Date(), other = conn.reopen();
  let entered!: () => void, release!: () => void;
  const locked = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const holder = other.sql.begin(async tx => {
    await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${consent.intent.id},${JSON.stringify(proof)}::jsonb)`;
    await tx`insert into vehicle_service_applications(intent_id) values(${consent.intent.id})`;
    entered(); await gate;
  });
  try {
    await locked;
    await expect(current(f)).rejects.toMatchObject({ cause: { code: '55P03' } });
  } finally { release(); await holder; await other.sql.end(); }
  expect(await current(f, cutoff)).toBeNull();
  expect(await current(f)).toEqual(shape(f, 'occupied', 2));
});
it('uses actual provisioned private roles for normal current HTTP bytes and preserves current custody closure', async () => {
  const f = await installation(), trips = await vehicleServiceExpeditions(f), trip = await trips.depart();
  vi.useRealTimers();
  const scaffold = randomUUID();
  await conn.sql`insert into buildings(id,player_wallet,base_id,type,level,tx,ty) values(${scaffold},${f.actor},${f.baseId},'berth',0,15,15)`;
  await conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${f.actor},${f.baseId},${scaffold},'build',now(),now()+interval '1 day')`;
  const role = 'caapi_' + randomBytes(8).toString('hex'), worker = 'caworker_' + randomBytes(8).toString('hex');
  const password = randomBytes(32).toString('hex'), workerPassword = randomBytes(32).toString('hex');
  const adminUrl = new URL(ADMIN_DATABASE_URL), name = String((await conn.sql`select current_database() name`)[0]!.name);
  const provision = () => execFileSync('sh', [fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url))], {
    timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: {
      PATH: '/opt/homebrew/opt/postgresql@16/bin:' + process.env.PATH, PGHOST: adminUrl.hostname, PGPORT: adminUrl.port,
      PGDATABASE: name, PGUSER: decodeURIComponent(adminUrl.username), PGPASSWORD: decodeURIComponent(adminUrl.password),
      POSTGRES_USER: decodeURIComponent(adminUrl.username), POSTGRES_PASSWORD: decodeURIComponent(adminUrl.password) || 'owned-loopback-trust-fixture',
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: role, API_DB_PASSWORD: password,
      WORKER_DB_USER: worker, WORKER_DB_PASSWORD: workerPassword,
    },
  });
  let request: ReturnType<typeof createDb> | undefined, app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    provision();
    await conn.sql`grant select(record) on current_advanced_presentation_contract to shardkeep_api_runtime`;
    await conn.sql`grant select(record) on current_advanced_presentation_contract to shardkeep_worker_runtime`;
    provision();
    const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + name; url.username = role; url.password = password;
    request = createDb(url.toString(), { max: 2 });
    expect((await request.sql`select
      has_any_column_privilege(current_user,'current_advanced_presentation_contract','SELECT,INSERT,UPDATE') seal,
      has_table_privilege(current_user,'advanced_vehicle_installations','SELECT,INSERT,UPDATE') originals,
      has_function_privilege(current_user,'shardkeep_vehicle_lifecycle(uuid)','EXECUTE') lifecycle,
      has_function_privilege(current_user,'shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz)','EXECUTE') reader`)[0])
      .toEqual({ seal: false, originals: false, lifecycle: false, reader: true });
    await expect(request.sql`select * from current_advanced_presentation_contract`).rejects.toMatchObject({ code: '42501' });
    const config = { ...TEST_CONFIG, FREE_ONBOARDING: 'true', MULTI_BASE_ENABLED: 'true' } as typeof TEST_CONFIG;
    app = await buildApp(config, request.db); const errors: string[] = [];
    app.addHook('onError', async (_req, _reply, error) => { errors.push(String(error.cause ?? error)); });
    await app.ready();
    const [session] = await db.insert(sessions).values({ wallet: f.actor, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, f.actor, session!.id) }, path = `/base?baseId=${f.baseId}`;
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    const read = async () => {
      const response = await app!.inject({ url: path, cookies });
      expect(response.statusCode, response.body + JSON.stringify(errors)).toBe(200); return response.body;
    };
    const overdueAway = await read();
    expect(JSON.parse(overdueAway).advancedServicePresentation.berths).toContainEqual(shape(f, 'away').berths[0]);
    expect(JSON.parse(overdueAway).advancedServicePresentation.berths).toContainEqual({ buildingId: scaffold, installation: null });
    expect(await conn.sql`select * from advanced_expedition_returns where expedition_id=${trip.id}`).toHaveLength(0);
    await db.transaction(tx => settleDueAdvancedExpeditions(tx, f.baseId, new Date(+trip.returnsAt)));
    const returned = await read();
    expect(JSON.parse(returned).advancedServicePresentation.berths).toContainEqual(shape(f, 'occupied').berths[0]);
    await writeFile('/tmp/advanced-current-primary-http-pair.json', JSON.stringify({ provenance: {
      kind: 'normal-buildApp-authenticated-inject-response-bodies',
      authority: 'Actual install, dispatch, accepted return and provisioned request-role /base reads; synthetic encoded finalized chain, historical initial clock and scaffolding fixture.',
      limits: 'No listening socket, native HTTP, Android pixels, art admission or release proof. No advanced collector is injected into this app: the reader itself never collects.',
      wallet: f.actor, baseId: f.baseId, berthId: f.berthId, constructionId: scaffold,
    }, overdueAway, returned }, null, 2) + '\n');
    const buyer = Keypair.generate().publicKey.toBase58(), deed = Keypair.generate().publicKey.toBase58(), collection = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet: buyer });
    await db.update(bases).set({ deedAssetId: deed, deedMintAssetId: deed, landPaidAt: new Date() }).where(eq(bases.id, f.baseId));
    await transferStableBase(db, f.baseId, f.actor, buyer, deed, { owner: buyer, collection, frozen: false, delegate: null, slot: 100, observedAtMs: Date.now() }, () => new Date());
    await expect(current(f)).rejects.toMatchObject({ cause: { message: 'CURRENT_ADVANCED_OWNER' } });
    const transferred = await getBaseState(request.db, buyer, new Date(), f.baseId, authority);
    expect(transferred.advancedServicePresentation!.berths).toContainEqual(shape(f, 'occupied').berths[0]);
    for (const mutation of ['grant select(record) on current_advanced_presentation_contract to public',
      'alter table current_advanced_presentation_contract disable trigger current_advanced_seal_guard',
      "create or replace function public.shardkeep_current_advanced_contract() returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$select '{}'::jsonb$$"]) {
      await expect(conn.sql.begin(async tx => {
        await tx.unsafe(mutation); await tx`select public.shardkeep_current_advanced_presentation(${buyer},${f.baseId},'[]',now())`;
      })).rejects.toThrow('CURRENT_ADVANCED_SOURCE');
    }
    await conn.sql`revoke execute on function public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) from shardkeep_api_runtime`;
    await expect(request.db.transaction(tx => readAdvancedServicePresentation(tx, buyer, f.baseId, [], new Date())))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  } finally {
    await app?.close(); await request?.sql.end();
    for (const login of [role, worker]) { await conn.sql.unsafe(`drop owned by ${login}`); await conn.sql.unsafe(`drop role ${login}`); }
  }
}, 60000);
