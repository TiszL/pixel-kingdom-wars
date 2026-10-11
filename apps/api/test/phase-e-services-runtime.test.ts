/** Actual private startup + restricted request LOGIN. Synthetic opening resources
 * exercise custody/recovery, not source earning, on-chain trust or deployment. */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { PHASE_E_MINING_SCORE_POLICY as SCORE } from '@shardkeep/shared';
import postgres from 'postgres';
import { ordinaryEquipmentRecipe } from '@shardkeep/shared/phaseEOrdinaryEquipment';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createPhaseEServices } from '../src/phaseEServices';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { TEST_CONFIG } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
import { SEAL_BOUND_SHARED_DB_CASE_MS } from './sealLatencyBudgets';
import { retainRealmSaleSettlementFixture } from './fixtures/realmSaleSettlement';
import { BoundCosmeticAppearanceSchema } from '@shardkeep/shared/boundCosmeticApi';
import { boundCosmeticFixture, cosmeticMaterials, pendingOrdinary } from './fixtures/boundCosmetics';
import { startBoundCosmetic } from '../src/game/boundCosmetics';
import { settleDueOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { baseRenderMarketArtAvailable } from '../src/game/baseRender';

const suffix = randomUUID().replaceAll('-', ''), name = `phase_e_services_${suffix}_test`;
const apiRole = `pe_api_${suffix}`, workerRole = `pe_worker_${suffix}`;
const ownerUrl = new URL(ADMIN_DATABASE_URL); ownerUrl.pathname = `/${name}`;
if (!['localhost', '127.0.0.1', '[::1]'].includes(ownerUrl.hostname)) throw Error('Owned local fixture required');
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
const requestUrl = new URL(ownerUrl); requestUrl.username = apiRole; requestUrl.password = randomBytes(32).toString('hex');
const config = { ...TEST_CONFIG, DATABASE_URL: requestUrl.toString(), PHASE_E_SERVICE_DATABASE_URL: ownerUrl.toString() };
let owner: ReturnType<typeof createDb>, request: ReturnType<typeof createDb>;
beforeAll(async () => {
  await createMigratedDatabase(admin, name); owner = createDb(ownerUrl.toString(), { max: 4 });
  await runMigrations(owner.db); await bootstrapSystemAccounts(owner.db);
  const script = fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url));
  execFileSync('sh', [script], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, PGHOST: ownerUrl.hostname, PGPORT: ownerUrl.port, PGDATABASE: name,
      PGUSER: decodeURIComponent(ownerUrl.username), PGPASSWORD: decodeURIComponent(ownerUrl.password),
      POSTGRES_USER: decodeURIComponent(ownerUrl.username), POSTGRES_PASSWORD: decodeURIComponent(ownerUrl.password),
      DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet', API_DB_USER: apiRole, API_DB_PASSWORD: requestUrl.password,
      WORKER_DB_USER: workerRole, WORKER_DB_PASSWORD: randomBytes(32).toString('hex') } });
  request = createDb(requestUrl.toString(), { max: 2 });
}, 120_000);
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await request?.sql.end(); await owner?.sql.end();
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  // Shared capability roles may serve other local databases; this fixture owns only its LOGINs.
  for (const role of [apiRole, workerRole]) await admin.unsafe(`drop role if exists ${role}`);
  await admin.end();
});
async function actor() {
  const wallet = Keypair.generate().publicKey.toBase58(), baseId = randomUUID();
  await owner.sql`insert into players(wallet) values(${wallet})`;
  await getOrCreatePlayerAccount(owner.db, wallet, 'player_keep');
  await owner.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${wallet},${SCORE.requiredLevel.keep})`;
  await owner.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  for (const [i, type] of (['keep', 'workshop', 'goldforge'] as const).entries()) {
    await owner.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},${type},${SCORE.requiredLevel[type]},${10 + i * 4},10)`;
  }
  await owner.sql`insert into resource_stocks(base_id,resource_id,available) values(${baseId},'heartwood_logs',100)`;
  const [session] = await owner.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString()}) returning id`;
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, wallet, session!.id) };
  return { wallet, baseId, cookies };
}
function pause() {
  for (const flag of ['PHASE_E_MINING_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'PHASE_E_CHARTER_ENABLED', 'MULTI_BASE_ENABLED']) vi.stubEnv(flag, 'false');
}
it('does not promote request credentials when private startup is absent; authenticated reads fail explicitly', async () => {
  pause(); const missing = { ...config, PHASE_E_SERVICE_DATABASE_URL: undefined };
  expect(await createPhaseEServices(missing, request.db)).toBeNull();
  const f = await actor(), app = await buildApp(missing, request.db);
  try {
    for (const [url, code] of [[`/mining/contributions/by-key/${randomUUID()}`, 'MINING_CONTRIBUTION_SOURCE_UNAVAILABLE'],
      [`/bases/free-purchases/by-key/${randomUUID()}`, 'FREE_BASE_SOURCE_UNAVAILABLE'],
      [`/ordinary-equipment/jobs/by-key/${randomUUID()}`, 'EQUIPMENT_UNAVAILABLE']] as const) {
      const result = await app.inject({ url, cookies: f.cookies });
      expect(result.statusCode, result.body).toBe(503); expect(result.json().error.code).toBe(code);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
  } finally { await app.close(); }
});
it('refuses same-role, wrong database, and public request access before exposing capabilities', async () => {
  pause();
  await expect(createPhaseEServices({ ...config, PHASE_E_SERVICE_DATABASE_URL: config.DATABASE_URL }, request.db)).rejects.toThrow('separate private LOGIN');
  const otherDb = new URL(ownerUrl); otherDb.pathname = '/postgres';
  await expect(createPhaseEServices({ ...config, PHASE_E_SERVICE_DATABASE_URL: otherDb.toString() }, request.db)).rejects.toThrow('same database');
  // Connection identity is checked too: supplying an owner Db with a restricted URL is insufficient.
  await expect(createPhaseEServices(config, owner.db)).rejects.toThrow('not isolated');
  await owner.sql.unsafe(`grant select on mining_contribution_receipts to ${apiRole}`);
  try { await expect(createPhaseEServices(config, request.db)).rejects.toThrow('not isolated'); }
  finally { await owner.sql.unsafe(`revoke select on mining_contribution_receipts from ${apiRole}`); }
  await owner.sql.unsafe(`grant select (id) on vehicle_activation_reservations to ${apiRole}`);
  try { await expect(createPhaseEServices(config, request.db)).rejects.toThrow('not isolated'); }
  finally { await owner.sql.unsafe(`revoke select (id) on vehicle_activation_reservations from ${apiRole}`); }
  for (const [table, column] of [['ordinary_equipment_jobs', 'id'], ['mining_roster_baselines', 'wallet']]) {
    await owner.sql.unsafe(`grant select (${column}) on ${table} to ${apiRole}`);
    try { await expect(createPhaseEServices(config, request.db)).rejects.toThrow('not isolated'); }
    finally { await owner.sql.unsafe(`revoke select (${column}) on ${table} from ${apiRole}`); }
  }
});
it('rejects latent owner escalation through NOINHERIT membership and unsafe role attributes', async () => {
  pause(); const ownerRole = decodeURIComponent(ownerUrl.username);
  // No grant is inherited here; SET ROLE would still reach the private owner.
  await owner.sql.unsafe(`alter role ${apiRole} noinherit; grant ${ownerRole} to ${apiRole}`);
  try { await expect(createPhaseEServices(config, request.db)).rejects.toThrow('not isolated'); }
  finally { await owner.sql.unsafe(`revoke ${ownerRole} from ${apiRole}; alter role ${apiRole} inherit`); }
  await owner.sql.unsafe(`alter role ${apiRole} createrole`);
  try { await expect(createPhaseEServices(config, request.db)).rejects.toThrow('not isolated'); }
  finally { await owner.sql.unsafe(`alter role ${apiRole} nocreaterole`); }
});
it('mounts real original vehicle/Charter history while all gates are paused, without chain authority', async () => {
  pause(); const f = await actor(), external = vi.fn(async () => { throw Error('No external authority admitted'); });
  const services = await createPhaseEServices(config, request.db, { finalizedDeedReader: external });
  expect(services).not.toBeNull(); expect(Object.isFrozen(services!.deps)).toBe(true);
  const app = await buildApp(config, request.db, services!.deps);
  try {
    for (const url of ['/vehicles/client/activity', '/clans/charter/client/activity']) {
      const result = await app.inject({ url, cookies: f.cookies });
      expect(result.statusCode, result.body).toBe(200); expect(result.json().items).toEqual([]);
      expect(result.headers['cache-control']).toBe('private, no-store');
    }
    const charter = await app.inject({ url: '/clans/charter/client/activity', cookies: f.cookies });
    expect(charter.json().newActions).toEqual({ creation: false, sale: false });
    expect(external).not.toHaveBeenCalled();
    await expect(request.sql`select * from mining_contribution_receipts`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`select * from charter_creation_reservations`).rejects.toMatchObject({ code: '42501' });
  } finally { await app.close(); await services!.close(); await services!.close(); }
});
it('recovers an actual contribution across pause and private-service restart without new custody or current authority', async () => {
  pause(); const f = await actor(), other = await actor();
  let services = await createPhaseEServices(config, request.db), app = await buildApp(config, request.db, services!.deps);
  const command = { idempotencyKey: randomUUID(), baseId: f.baseId, policyVersion: 2,
    expectedDay: new Date().toISOString().slice(0, 10), lines: [{ resourceId: 'heartwood_logs', quantity: '2' }] };
  const headers = { origin: config.WEB_ORIGIN[0]! };
  try {
    vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const accepted = await app.inject({ method: 'POST', url: '/mining/contributions', cookies: f.cookies, headers, payload: command });
    expect(accepted.statusCode, accepted.body).toBe(201); const original = accepted.json();
    pause(); await app.close(); await services!.close();
    // Transfer after original commitment; historical owner still recovers it.
    await owner.sql`delete from base_slots where base_id=${f.baseId}`;
    await owner.sql`update bases set owner_wallet=${other.wallet} where id=${f.baseId}`;
    services = await createPhaseEServices(config, request.db);
    app = await buildApp(config, request.db, services!.deps);
    const url = `/mining/contributions/by-key/${command.idempotencyKey}`;
    const recovered = await app.inject({ url, cookies: f.cookies });
    expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().receipt).toEqual(original.receipt);
    const replay = await app.inject({ method: 'POST', url: '/mining/contributions', cookies: f.cookies, headers, payload: command });
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().receipt).toEqual(original.receipt);
    const foreign = await app.inject({ url, cookies: other.cookies });
    expect(foreign.statusCode, foreign.body).toBe(200); expect(foreign.json().status).toBe('unknown');
    expect(await owner.sql`select id from mining_contribution_receipts where actor_wallet=${f.wallet}`).toHaveLength(1);
    const [stock] = await owner.sql`select available::text,mining_pending::text from resource_stocks where base_id=${f.baseId} and resource_id='heartwood_logs'`;
    expect(stock).toEqual({ available: '98', mining_pending: '2' });
  } finally { await app.close(); await services?.close(); }
});
it('starts original realm-sale finality privately while paused and serves the durable terminal after providerless restart', async () => {
  pause(); vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false');
  const f = await retainRealmSaleSettlementFixture(owner.db), foreign = await actor();
  await owner.sql`insert into players(wallet) values(${f.key.wallet})`;
  const [session] = await owner.sql`insert into sessions(wallet,expires_at) values(${f.key.wallet},${new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString()}) returning id`;
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, f.key.wallet, session!.id) };
  const source = vi.fn(() => f.chain.rpc);
  let services = await createPhaseEServices(config, request.db, {}, undefined, { receiptSource: source, trust: f.chain.trust });
  let app = await buildApp(config, request.db, services!.deps);
  const path = `/seeker/realm-sales/by-key/${f.key.idempotencyKey}`;
  try {
    expect(source).not.toHaveBeenCalled();
    services!.start(); services!.start();
    await vi.waitFor(async () => { expect(await owner.sql`select wallet from seeker_realm_sale_receipts where wallet=${f.key.wallet}`).toHaveLength(1); }, { timeout: 5_000, interval: 25 });
    const result = await app.inject({ url: path, cookies });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().settlement).toMatchObject({ receipt: { signature: f.chain.signature } });
    expect(result.headers['cache-control']).toBe('private, no-store');
    await expect(request.sql`insert into seeker_realm_sale_receipts default values`).rejects.toMatchObject({ code: '42501' });
    expect(source).toHaveBeenCalledTimes(1);
    await app.close(); await services!.close();
    services = await createPhaseEServices(config, request.db);
    app = await buildApp(config, request.db, services!.deps);
    const recovered = await app.inject({ url: path, cookies });
    expect(recovered.json()).toEqual(result.json());
    expect((await app.inject({ url: path, cookies: foreign.cookies })).json()).toMatchObject({ preparation: null, wire: null, settlement: null });
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect(await owner.sql`select wallet from seeker_realm_sale_signed_wires where wallet=${f.key.wallet}`).toHaveLength(1);
    expect(await owner.sql`select wallet from seeker_realm_sale_failures where wallet=${f.key.wallet}`).toHaveLength(0);
  } finally { await app.close(); await services?.close(); }
});
it('crafts through the restricted HTTP role and preserves exact equipment recovery across pause, transfer and private restart', async () => {
  pause(); vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'true');
  // Real SQL time bounds hold: advancing the original craft remains in the past.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() - 3_600_000);
  const f = await actor(), other = await actor();
  const finished = new Date(Date.now() - 3_600_000).toISOString(), started = new Date(Date.now() - 7_200_000).toISOString();
  await owner.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at)
    select ${f.wallet},${f.baseId},id,'build',${started},${finished},${finished} from buildings where base_id=${f.baseId} and type='workshop'`;
  for (const input of ordinaryEquipmentRecipe().inputs) await owner.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.baseId},${input.itemId},${input.quantity})`;
  let services = await createPhaseEServices(config, request.db), app = await buildApp(config, request.db, services!.deps);
  const command = { idempotencyKey: randomUUID(), baseId: f.baseId, recipeId: 'craft_route_compass', recipeVersion: 1, quantity: 1 };
  const headers = { origin: config.WEB_ORIGIN[0]! }, url = `/ordinary-equipment/jobs/by-key/${command.idempotencyKey}`;
  try {
    expect(Object.keys(services!.deps.ordinaryEquipment!).sort()).toEqual(['read', 'start', 'view']);
    expect(Object.isFrozen(services!.deps.ordinaryEquipment)).toBe(true);
    const posted = await app.inject({ method: 'POST', url: '/ordinary-equipment/jobs', cookies: f.cookies, headers, payload: command });
    expect(posted.statusCode, posted.body).toBe(200); const original = posted.json();
    expect(original.status).toBe('accepted');
    vi.setSystemTime(new Date(original.receipt.readyAt)); vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'false');
    const settled = await app.inject({ url: `/ordinary-equipment?baseId=${f.baseId}&catalogueVersion=2`, cookies: f.cookies });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().equipmentStock).toContainEqual({ itemId: 'route_compass', available: '1', reserved: '0', pendingOutput: '0' });
    await app.close(); await services!.close();
    await owner.sql`delete from base_slots where base_id=${f.baseId}`;
    await owner.sql`update bases set owner_wallet=${other.wallet} where id=${f.baseId}`;
    pause(); services = await createPhaseEServices(config, request.db); app = await buildApp(config, request.db, services!.deps);
    const saved = await app.inject({ url, cookies: f.cookies });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().receipt).toEqual(original.receipt); expect(saved.json().completion).not.toBeNull();
    const replay = await app.inject({ method: 'POST', url: '/ordinary-equipment/jobs', cookies: f.cookies, headers, payload: command });
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().receipt).toEqual(original.receipt);
    expect((await app.inject({ url, cookies: other.cookies })).json().status).toBe('unknown');
    expect((await app.inject({ url })).statusCode).toBe(401); expect(saved.headers['cache-control']).toBe('private, no-store');
    expect(await owner.sql`select id from ordinary_equipment_jobs where id=${command.idempotencyKey}`).toHaveLength(1);
    expect(await owner.sql`select job_id from ordinary_equipment_completions where job_id=${command.idempotencyKey}`).toHaveLength(1);
    await expect(request.sql`select * from ordinary_equipment_jobs`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`insert into ordinary_equipment_completions default values`).rejects.toMatchObject({ code: '42501' });
  } finally { await app.close(); await services?.close(); }
});
it('enrolls only successful ordinary base reads prospectively and leaves mining roster journals private', async () => {
  pause(); vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); vi.stubEnv('FREE_ONBOARDING', 'true');
  const f = await actor(), services = await createPhaseEServices(config, request.db), app = await buildApp(config, request.db, services!.deps);
  try {
    const url = `/base?baseId=${f.baseId}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(await owner.sql`select wallet from mining_roster_baselines where wallet=${f.wallet}`).toHaveLength(0);
    for (let i = 0; i < 2; i++) {
      const result = await app.inject({ url, cookies: f.cookies }); expect(result.statusCode, result.body).toBe(200);
    }
    const [baseline] = await owner.sql`select effective_from>observed_at prospective from mining_roster_baselines where wallet=${f.wallet}`;
    expect(baseline?.prospective).toBe(true);
    expect(await owner.sql`select wallet from mining_roster_checkpoints where wallet=${f.wallet}`).toHaveLength(1);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    const held = await actor(), result = await app.inject({ url: `/base?baseId=${held.baseId}`, cookies: held.cookies });
    expect(result.statusCode, result.body).toBe(200);
    expect(await owner.sql`select wallet from mining_roster_baselines where wallet=${held.wallet}`).toHaveLength(0);
    await expect(request.sql`select * from mining_roster_baselines`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`insert into mining_roster_checkpoints default values`).rejects.toMatchObject({ code: '42501' });
  } finally { await app.close(); await services!.close(); }
});

it('mounts Passport history through private startup while paused without promoting request SQL or inventing mining records', async () => {
  pause(); const f = await actor(), services = await createPhaseEServices(config, request.db);
  expect(services?.deps.realmPassportProvider).toBeDefined();
  const app = await buildApp(config, request.db, services!.deps);
  const unconfigured = await buildApp(config, request.db);
  try {
    for (const url of ['/realm-passport/expeditions?kind=starter', '/realm-passport/expeditions?kind=advanced']) {
      expect((await app.inject({url})).statusCode).toBe(401);
      const response = await app.inject({url,cookies:f.cookies});
      expect(response.statusCode,response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({version:1,wallet:f.wallet,projection:'history-only',state:'available',data:{rows:[],nextCursor:null}});
      expect((await unconfigured.inject({url,cookies:f.cookies})).statusCode).toBe(503);
    }
    for (const url of ['/realm-passport/mining/inclusions','/realm-passport/mining/current']) {
      const response = await app.inject({url,cookies:f.cookies});
      expect(response.statusCode,response.body).toBe(200);
      expect(response.json()).toMatchObject({wallet:f.wallet,projection:'history-only',state:'unavailable',reason:'NOT_CONFIGURED',data:null});
    }
    expect((await app.inject({url:'/realm-passport/expeditions?kind=starter&wallet='+f.wallet,cookies:f.cookies})).statusCode).toBe(400);
    await expect(request.sql`select * from advanced_expeditions`).rejects.toMatchObject({code:'42501'});
    // Existing claim projections are intentionally readable, but Passport adds no write authority.
    expect(await request.sql`select * from mining_claim_entitlement_headers`).toEqual([]);
    await expect(request.sql`insert into mining_claim_entitlement_headers default values`).rejects.toMatchObject({code:'42501'});
    expect(await owner.sql`select id from starter_expeditions where actor_wallet=${f.wallet}`).toHaveLength(0);
    expect(await owner.sql`select id from advanced_expeditions where actor_wallet=${f.wallet}`).toHaveLength(0);
  } finally {await app.close();await unconfigured.close();await services?.close();}
});


it('collects due cosmetics through normal restricted base HTTP before locks and keeps Workshop original retries independent', async () => {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_CATALOG_ENABLED', 'ORDINARY_CRAFTING_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true');
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() - 86_400_000);
  const f = await boundCosmeticFixture(owner.db), shift = Date.now() - +f.now;
  // Facility placement/times and opening materials are fixtures; the refining,
  // C2 Blueprint, consuming craft and completion below use actual services.
  await owner.sql`update builder_jobs set started_at=started_at+${shift}*interval '1 millisecond',
    finishes_at=finishes_at+${shift}*interval '1 millisecond',completed_at=completed_at+${shift}*interval '1 millisecond' where base_id=${f.baseId}`;
  f.now = new Date(); const source = await pendingOrdinary(f);
  f.now = source.job.readyAt; vi.setSystemTime(f.now);
  await owner.db.transaction(tx => settleDueOrdinaryCrafting(tx, f.baseId, f.now));
  const recipe = await cosmeticMaterials(f, 'craft_artisan_market_awning_t1_v1');
  const [binding] = await owner.sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`;
  const appearance = BoundCosmeticAppearanceSchema.parse(binding!.appearance);
  const command = { idempotencyKey: randomUUID(), baseId: f.baseId, recipeId: recipe.recipeId,
    recipeVersion: recipe.recipeVersion, appearanceBindingSha256: appearance.bindingSha256 };
  const original = await startBoundCosmetic(owner.db, f.wallet, command, f.authority, { clock: () => f.now });
  if (original.status !== 'accepted') throw Error('Expected actual cosmetic original');
  const [session] = await owner.sql`insert into sessions(wallet,expires_at) values(${f.wallet},${new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString()}) returning id`;
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, f.wallet, session!.id) }, headers = { origin: config.WEB_ORIGIN[0]! };
  const services = await createPhaseEServices(config, request.db), app = await buildApp(config, request.db, services!.deps);
  try {
    // 2026-10-10 (CI cluster E): Awning admission IS the actual deed renderer's
    // readiness (boundCosmeticApplication.ts), and the generated atlas is gitignored:
    // CI (no `pnpm assets`) has none. Assert the rule in both environments instead of
    // only the art-present branch, which has failed in CI since 2ebef8a97.
    const artReady = baseRenderMarketArtAvailable();
    expect((await services!.deps.boundCosmeticWorkshop!.view(f.wallet)).applicationReady).toBe(artReady);
    const catalogue = await app.inject({url:'/bound-cosmetics?baseId='+f.baseId,cookies});
    expect(catalogue.statusCode,catalogue.body).toBe(200);
    expect(catalogue.headers['cache-control']).toBe('private, no-store');
    expect(catalogue.json()).toMatchObject({applicationReady:artReady,wallet:f.wallet});
    const replay = await app.inject({ method: 'POST', url: '/bound-cosmetics/jobs', cookies, headers, payload: command });
    expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().receipt).toEqual(original.receipt);
    expect((await app.inject({url:'/bound-cosmetics?baseId='+f.baseId})).statusCode).toBe(401);
    const preflight=await app.inject({method:'OPTIONS',url:'/bound-cosmetics/awning',headers:{origin:config.WEB_ORIGIN[0]!, 'access-control-request-method':'PUT','access-control-request-headers':'content-type'}});
    expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
    await expect(request.sql`select * from bound_cosmetic_jobs`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`insert into bound_cosmetic_completions default values`).rejects.toMatchObject({ code: '42501' });
    const url = `/base?baseId=${f.baseId}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(await owner.sql`select job_id from bound_cosmetic_completions where job_id=${command.idempotencyKey}`).toHaveLength(0);
    vi.setSystemTime(new Date(original.receipt.readyAt));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({ url, cookies });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().boundCosmetics).toEqual({ state: 'available', visual: { version: 1, marketAwnings: [] } });
    }
    expect(await owner.sql`select j.actor_wallet,c.completed_at=${original.receipt.readyAt}::timestamptz completed_at_matches from bound_cosmetic_jobs j join bound_cosmetic_completions c on c.job_id=j.id where j.id=${command.idempotencyKey}`)
      .toEqual([{ actor_wallet: f.wallet, completed_at_matches: true }]);
    const applied=await app.inject({method:'PUT',url:'/bound-cosmetics/awning',cookies,headers,payload:{baseId:f.baseId,enabled:true,expectedRevision:'0'}});
    if (artReady) {
      expect(applied.statusCode,applied.body).toBe(200);
      expect((await app.inject({url,cookies})).json().boundCosmetics).toMatchObject({state:'available',visual:{marketAwnings:[{buildingId:f.market.id,appearance}]}});
      const off=await app.inject({method:'PUT',url:'/bound-cosmetics/awning',cookies,headers,payload:{baseId:f.baseId,enabled:false,expectedRevision:'1'}});
      expect(off.statusCode,off.body).toBe(200);expect(off.json()).toMatchObject({enabled:false,revision:'2'});
    } else {
      // No drawable Awning: application is refused and nothing is applied.
      expect(applied.statusCode,applied.body).toBe(503);expect(applied.json().error.code).toBe('BOUND_COSMETIC_APPLICATION_UNAVAILABLE');
      const unchanged=await app.inject({url,cookies});expect(unchanged.statusCode,unchanged.body).toBe(200);
      expect(unchanged.json().boundCosmetics).toEqual({ state: 'available', visual: { version: 1, marketAwnings: [] } });
    }
    for (const input of ordinaryEquipmentRecipe().inputs) await owner.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.baseId},${input.itemId},${input.quantity})
      on conflict(base_id,item_id) do update set available=excluded.available`;
    const equipmentCommand = { idempotencyKey: randomUUID(), baseId: f.baseId, recipeId: 'craft_route_compass', recipeVersion: 1, quantity: 1 };
    const posted = await app.inject({ method: 'POST', url: '/ordinary-equipment/jobs', cookies, headers, payload: equipmentCommand });
    expect(posted.statusCode, posted.body).toBe(200); const equipmentOriginal = posted.json();
    expect(equipmentOriginal.status).toBe('accepted');
    const refiningPath = `/ordinary-crafting/jobs/by-key/${source.job.id}`;
    const refiningOriginal = await app.inject({ url: refiningPath, cookies });
    expect(refiningOriginal.statusCode, refiningOriginal.body).toBe(200);
    // Explicit local transfer; no on-chain sale/transfer completion is claimed.
    const buyer = await actor();
    await owner.sql`delete from base_slots where base_id=${f.baseId}`;
    await owner.sql`update bases set owner_wallet=${buyer.wallet} where id=${f.baseId}`;
    pause(); vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'false'); vi.stubEnv('PHASE_E_CATALOG_ENABLED', 'false');
    const equipmentReplay = await app.inject({ method: 'POST', url: '/ordinary-equipment/jobs', cookies, headers, payload: equipmentCommand });
    expect(equipmentReplay.statusCode, equipmentReplay.body).toBe(200); expect(equipmentReplay.json().receipt).toEqual(equipmentOriginal.receipt);
    const refiningReplay = await app.inject({ method: 'POST', url: '/ordinary-crafting/jobs', cookies, headers,
      payload: { idempotencyKey: source.job.id, baseId: f.baseId, recipeId: source.job.recipeId, recipeVersion: source.job.recipeVersion, quantity: source.job.quantity } });
    expect(refiningReplay.statusCode, refiningReplay.body).toBe(200); expect(refiningReplay.json().receipt).toEqual(refiningOriginal.json().receipt);
    expect(await owner.sql`select job_id from bound_cosmetic_completions where job_id=${command.idempotencyKey}`).toHaveLength(1);
    expect(await owner.sql`select id from ordinary_equipment_jobs where id=${equipmentCommand.idempotencyKey}`).toHaveLength(1);
  } finally { await app.close(); await services?.close(); }
}, SEAL_BOUND_SHARED_DB_CASE_MS);
