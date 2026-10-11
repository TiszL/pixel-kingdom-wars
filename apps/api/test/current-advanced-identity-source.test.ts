/** 0292/0293: the additive current identity reader beside the sealed predecessor appearance, through genuine installation,
 * service, departure, return, transfer and provisioned-role HTTP fixtures. Root alone executes (owned loopback PostgreSQL). */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bases, buildings, players, sessions } from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { readCurrentAdvancedIdentity } from '../src/game/currentAdvancedIdentity';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { createVehicleServiceApplications } from '../src/game/vehicleServiceApplications';
import { settleDueAdvancedExpeditions } from '../src/game/advancedExpeditionReturns';
import { installStarterFleet } from '../src/game/starterFleet';
import { transferStableBase, assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { TEST_CONFIG } from './helpers';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceConsentFixture } from './fixtures/vehicleServicePreparation';
import { vehicleServiceBuilding, vehicleServiceExpeditions } from './fixtures/vehicleService';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { assertRuntimeRoleProvisioningSafe } from './fixtures/runtimeRoleProvisioningGuard';
import { ADMIN_DATABASE_URL } from './db-url';

const conn = resourceClaimsDatabase(), db = conn.db;
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => undefined });
const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const apply = async (tx: postgres.TransactionSql, body: string) => {
  for (const part of body.split('--> statement-breakpoint')) if (part.trim()) await tx.unsafe(part);
};
const flags = () => {
  for (const key of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(key, 'true');
};
const SEALS = ['raid_advanced_presentation_contract', 'raid_starter_presentation_contract', 'bound_cosmetic_return_contract', 'bound_cosmetic_charter_contract',
  'bound_cosmetic_wake_contract', 'service_activity_contract', 'current_advanced_presentation_contract'];
const seals = async () => {
  const result: Record<string, unknown> = {};
  for (const table of SEALS) result[table] = (await conn.sql.unsafe(`select record from public.${table}`))[0]?.record;
  return result;
};
let before: Record<string, unknown>, readerSql: string, sourceSql: string;
beforeAll(async () => {
  const folder = await mkdtemp(join(tmpdir(), 'current-advanced-identity-journal-')), real = runMigrations;
  try {
    await cp(migrations, folder, { recursive: true });
    const path = join(folder, 'meta/_journal.json'), journal = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...journal, entries: journal.entries.filter((e: { idx: number }) => e.idx < 295) }));
    const mod = await import('../src/db/migrate');
    const spy = vi.spyOn(mod, 'runMigrations').mockImplementationOnce(db => real(db, { migrationsFolder: folder }));
    try { await conn.setup(); } finally { spy.mockRestore(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
  before = await seals();
  readerSql = await readFile(join(migrations, '0292_current_advanced_identity.sql'), 'utf8');
  sourceSql = await readFile(join(migrations, '0293_current_advanced_identity_source.sql'), 'utf8');
}, 180000);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await conn.close(); await admin.end(); });

it('admits only the exact additive identity capability and preserves every predecessor seal byte for byte', async () => {
  for (const mutation of ['alter function public.shardkeep_advanced_identity_current(text,uuid,jsonb,timestamptz) security invoker',
    "create or replace function public.shardkeep_advanced_identity_current(actor text,target uuid,current_buildings jsonb,cutoff timestamptz) returns jsonb language sql set search_path=pg_catalog,public,pg_temp as $$select null::jsonb$$"]) {
    await expect(conn.sql.begin(async tx => { await apply(tx, readerSql); await tx.unsafe(mutation); await apply(tx, sourceSql); })).rejects.toThrow('ADVANCED_IDENTITY_SEAL_SOURCE');
  }
  await runMigrations(db);
  expect(await seals()).toEqual(before);
  expect((await conn.sql`select public.shardkeep_advanced_identity_sources_valid() identity, public.shardkeep_current_advanced_sources_valid() predecessor`)[0])
    .toEqual({ identity: true, predecessor: true });
  // The new namespace never entered the 0291 prefix-based seal: its function set is unchanged.
  expect((await conn.sql`select count(*)::int n from pg_proc where pronamespace='public'::regnamespace and left(proname,length('shardkeep_current_advanced_'))='shardkeep_current_advanced_' and proname like '%identity%'`)[0]!.n).toBe(0);
}, 180000);

type Fixture = Awaited<ReturnType<typeof vehicleBurnDatabase>>;
async function installation() {
  flags(); await runMigrations(db);
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn, completedAt: new Date(Date.now() - 8 * 86400000) });
  f.finalizeBurn(); await createVehicleInstallations(db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
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
const ident = (f: Fixture, tier = 1) => ({ version: 1, berths: [{ buildingId: f.berthId, installation: { installationId: f.reservation.id, family: 'survey_balloon', tier } }] });
const current = async (f: Fixture, wallet = f.actor, at = new Date()) => db.transaction(async tx => {
  const b = await tx.select().from(buildings).where(eq(buildings.baseId, f.baseId));
  return readCurrentAdvancedIdentity(tx, wallet, f.baseId, b, at);
});

it('reads the exact installed reservation identity beside the unchanged appearance, through pending and applied tier', async () => {
  const f = await installation(), consent = await vehicleServiceConsentFixture(f);
  const prepared = await consent.preparations.prepare(f.actor, consent.intent.id);
  let read = await state(f);
  expect(read.advancedServicePresentation).toEqual(shape(f, 'occupied')); expect(read.advancedFleetIdentity).toEqual(ident(f));
  expect(JSON.stringify(read.advancedFleetIdentity)).not.toMatch(/reservationId|completedTotal|allowanceStart|cutoff|signature|mint/);
  consent.finalizeService(prepared);
  await createVehicleServiceApplications(db, { verifyBurn: consent.reader.verify }).recover(f.actor, consent.intent.id);
  read = await state(f);
  expect(read.advancedServicePresentation).toEqual(shape(f, 'occupied', 2)); expect(read.advancedFleetIdentity).toEqual(ident(f, 2));
  // Legacy/unprotected reads omit BOTH the appearance and its identity sibling.
  const legacy = await getBaseState(db, f.actor, new Date(), f.baseId);
  expect(legacy).not.toHaveProperty('advancedServicePresentation'); expect(legacy).not.toHaveProperty('advancedFleetIdentity');
});

it('keeps the same identity while an overdue original is away and writes nothing from reads; the unavailable cutoff yields no identity', async () => {
  const f = await installation(), trips = await vehicleServiceExpeditions(f), trip = await trips.depart();
  vi.useRealTimers();
  const late = new Date(+trip.returnsAt + 60_000);
  const overdue = await state(f, late);
  expect(overdue.advancedServicePresentation).toEqual(shape(f, 'away')); expect(overdue.advancedFleetIdentity).toEqual(ident(f));
  expect(await conn.sql`select * from advanced_expedition_returns where expedition_id=${trip.id}`).toHaveLength(0);
  await db.transaction(tx => settleDueAdvancedExpeditions(tx, f.baseId, late));
  const returned = await state(f, late);
  expect(returned.advancedServicePresentation).toEqual(shape(f, 'occupied')); expect(returned.advancedFleetIdentity).toEqual(ident(f));
  const early = await state(f, new Date(Date.now() - 30 * 86400000));
  expect(early.advancedServicePresentation).toBeNull(); expect(early).not.toHaveProperty('advancedFleetIdentity');
  expect(await current(f, f.actor, new Date(Date.now() - 30 * 86400000))).toEqual({ presentation: null, identity: null });
});

it('uses the provisioned private roles for the current HTTP bytes with the identity sibling and a genuine starter identity, then refuses every seal and ACL mutation', async () => {
  const f = await installation(), trips = await vehicleServiceExpeditions(f), trip = await trips.depart();
  vi.useRealTimers();
  const starterBerth = await vehicleServiceBuilding(f, 'berth');
  const starter = await installStarterFleet(db, f.actor, starterBerth, trips.authority);
  const role = 'ciapi_' + randomBytes(8).toString('hex'), worker = 'ciworker_' + randomBytes(8).toString('hex');
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
  // Read-only refusal boundary for the shared-cluster role fixture BEFORE the first provisioning — and BEFORE the try whose finally
  // unconditionally DROP OWNED / DROP ROLEs these names: a refusal must never reach that cleanup for names that may belong to someone
  // else or not exist. The second provision below is the intentional idempotence/revocation check (it must undo the stray column grant).
  await assertRuntimeRoleProvisioningSafe(admin, role, worker);
  try {
    provision();
    await conn.sql`grant select(record) on advanced_identity_current_contract to shardkeep_api_runtime`;
    provision();
    const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + name; url.username = role; url.password = password;
    request = createDb(url.toString(), { max: 2 });
    expect((await request.sql`select
      has_any_column_privilege(current_user,'advanced_identity_current_contract','SELECT,INSERT,UPDATE') seal,
      has_table_privilege(current_user,'advanced_vehicle_installations','SELECT,INSERT,UPDATE') originals,
      has_function_privilege(current_user,'shardkeep_advanced_identity_current(text,uuid,jsonb,timestamptz)','EXECUTE') identity,
      has_function_privilege(current_user,'shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz)','EXECUTE') reader`)[0])
      .toEqual({ seal: false, originals: false, identity: true, reader: true });
    await expect(request.sql`select * from advanced_identity_current_contract`).rejects.toMatchObject({ code: '42501' });
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
    const away = await read(), awayBody = JSON.parse(away);
    expect(awayBody.advancedServicePresentation.berths).toContainEqual(shape(f, 'away').berths[0]);
    expect(awayBody.advancedFleetIdentity.berths).toContainEqual(ident(f).berths[0]);
    expect(awayBody.advancedFleetIdentity.berths).toContainEqual({ buildingId: starterBerth, installation: null });
    expect(awayBody.starterFleet.installation).toMatchObject({ installationId: starter.installationId, baseId: f.baseId, berthId: starterBerth, family: 'starter' });
    expect(await conn.sql`select * from advanced_expedition_returns where expedition_id=${trip.id}`).toHaveLength(0);
    await db.transaction(tx => settleDueAdvancedExpeditions(tx, f.baseId, new Date(+trip.returnsAt)));
    const returned = await read();
    expect(JSON.parse(returned).advancedServicePresentation.berths).toContainEqual(shape(f, 'occupied').berths[0]);
    expect(JSON.parse(returned).advancedFleetIdentity.berths).toContainEqual(ident(f).berths[0]);
    // Root-selected output: the genuine current HTTP pair (advanced + starter identity) for the ONE new native fixture.
    await writeFile('/tmp/phase-e-continuity-current-http.json', JSON.stringify({ provenance: {
      kind: 'normal-buildApp-authenticated-inject-response-bodies',
      authority: 'Actual advanced install, dispatch, accepted return, genuine starter installation and provisioned request-role /base reads; synthetic encoded finalized chain and historical fixture clock.',
      limits: 'No listening socket, native HTTP, Android pixels, art admission or release proof. No advanced collector is injected into this app.',
      wallet: f.actor, baseId: f.baseId, advancedBerthId: f.berthId, advancedInstallationId: f.reservation.id, starterBerthId: starterBerth, starterInstallationId: starter.installationId,
    }, away, returned }, null, 2) + '\n');
    const buyer = Keypair.generate().publicKey.toBase58(), deed = Keypair.generate().publicKey.toBase58(), collection = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet: buyer });
    await db.update(bases).set({ deedAssetId: deed, deedMintAssetId: deed, landPaidAt: new Date() }).where(eq(bases.id, f.baseId));
    await transferStableBase(db, f.baseId, f.actor, buyer, deed, { owner: buyer, collection, frozen: false, delegate: null, slot: 100, observedAtMs: Date.now() }, () => new Date());
    await expect(current(f)).rejects.toMatchObject({ cause: { message: 'CURRENT_ADVANCED_OWNER' } });
    const transferred = await getBaseState(request.db, buyer, new Date(), f.baseId, authority);
    // The FULL sorted two-berth identity: the advanced installation AND the starter berth's null advanced installation.
    expect(transferred.advancedFleetIdentity).toEqual({ version: 1, berths: [ident(f).berths[0]!, { buildingId: starterBerth, installation: null }]
      .sort((a, b) => a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0) });
    expect(transferred.advancedServicePresentation).toEqual({ version: 1, berths: [shape(f, 'occupied').berths[0]!, { buildingId: starterBerth, installation: null }]
      .sort((a, b) => a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0) });
    expect(await seals()).toEqual(before);
    for (const mutation of ['grant select(record) on advanced_identity_current_contract to public',
      'alter table advanced_identity_current_contract disable trigger advanced_identity_seal_guard',
      "create or replace function public.shardkeep_advanced_identity_contract() returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$select '{}'::jsonb$$"]) {
      await expect(conn.sql.begin(async tx => {
        await tx.unsafe(mutation); await tx`select public.shardkeep_advanced_identity_current(${buyer},${f.baseId},'[]',now())`;
      })).rejects.toThrow('ADVANCED_IDENTITY_SOURCE');
    }
    await conn.sql`revoke execute on function public.shardkeep_advanced_identity_current(text,uuid,jsonb,timestamptz) from shardkeep_api_runtime`;
    await expect(request.db.transaction(tx => readCurrentAdvancedIdentity(tx, buyer, f.baseId, [], new Date())))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  } finally {
    await app?.close(); await request?.sql.end();
    // 2026-10-10 (CI cluster E): a failed provision (rolled back) leaves no role, and
    // the unconditional DROP OWNED then replaced the real error with 'role does not exist'.
    // Both names were absent at the guard, so any that exists now is this test's.
    for (const login of [role, worker]) {
      if (!(await admin`select 1 from pg_roles where rolname=${login}`).length) continue;
      await conn.sql.unsafe(`drop owned by ${login}`); await conn.sql.unsafe(`drop role ${login}`);
    }
  }
}, 60000);
