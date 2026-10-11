/** B8/Q/J local composition: actual provisioned request LOGIN and private
 * createPhaseEServices startup. Original fixtures remain local authorities. */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { Keypair } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createDb, type Db } from '../src/db/client';
import { sessions } from '../src/db/schema';
import { createVehicleClient } from '../src/game/vehicleClient';
import { createPhaseEServices } from '../src/phaseEServices';
import { createConfiguredCharterWorkflowRuntime } from '../src/game/charterConfiguredRuntime';
import type { CharterClientOptions } from '../src/game/clanCharterClient';
import { createMiningClaimRuntime } from '../src/mining/claimRuntime';
import { claimSeekerResourceTax } from '../src/game/seekerResourceClaims';
import { createMiningClaimSettlement } from '../src/mining/claimSettlement';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createResourceTaxFixture } from './fixtures/seekerResourceClaims';
import { withMiningClaimSettlementFixture } from './fixtures/miningClaimSettlement';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { charterCreationWorkflowFixture } from './fixtures/charterCreationWorkflow';
import { createTestPlayer, TEST_CONFIG } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';
import { miningClaimRuntimeRpc } from './fixtures/miningClaimRuntime';

const flags = ['GEMS_ENABLED', 'PHASE_E_CATALOG_ENABLED', 'PHASE_E_BUILDINGS_ENABLED',
  'PHASE_E_MINING_ENABLED', 'PHASE_E_SEEKER_ENABLED', 'PHASE_E_VEHICLES_ENABLED',
  'PHASE_E_CHARTER_ENABLED', 'KEEP_EQUIPMENT_MARKET_ENABLED'] as const;
const apps = new Map<FastifyInstance, { request: ReturnType<typeof createDb>; services: NonNullable<Awaited<ReturnType<typeof createPhaseEServices>>>; close: () => Promise<void> }>();
function pause() {
  for (const flag of [...flags, 'MULTI_BASE_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'HARVESTERS_ENABLED']) vi.stubEnv(flag, 'false');
}
function enable(...names: string[]) { for (const name of names) vi.stubEnv(name, 'true'); }
async function open(db: Db, sources: { mining?: NonNullable<ReturnType<typeof createMiningClaimRuntime>>; charter?: CharterClientOptions; ownership?: Parameters<typeof createPhaseEServices>[2] } = {}) {
  const [database] = await db.execute<{ name: string }>(sql`select current_database() name`), owner = new URL(ADMIN_DATABASE_URL);
  owner.pathname = '/' + database!.name;
  const suffix = randomUUID().replaceAll('-', ''), role = 'qj_api_' + suffix, worker = 'qj_worker_' + suffix, password = randomBytes(32).toString('hex');
  execFileSync('sh', [fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url))], {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, PGHOST: owner.hostname, PGPORT: owner.port,
      PGDATABASE: database!.name, PGUSER: decodeURIComponent(owner.username), PGPASSWORD: decodeURIComponent(owner.password),
      POSTGRES_USER: decodeURIComponent(owner.username), POSTGRES_PASSWORD: decodeURIComponent(owner.password), DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet',
      API_DB_USER: role, API_DB_PASSWORD: password, WORKER_DB_USER: worker, WORKER_DB_PASSWORD: randomBytes(32).toString('hex') } });
  const requestUrl = new URL(owner); requestUrl.username = role; requestUrl.password = password;
  const request = createDb(requestUrl.toString(), { max: 3 });
  const config = loadConfig({ DATABASE_URL: requestUrl.toString(), PHASE_E_SERVICE_DATABASE_URL: owner.toString(), JWT_SECRET: TEST_CONFIG.JWT_SECRET,
    WEB_ORIGIN: TEST_CONFIG.WEB_ORIGIN[0], NODE_ENV: 'test', PLAYTEST_OPEN: 'true', REDIS_URL: TEST_CONFIG.REDIS_URL });
  for (const flag of flags) expect(config[flag]).toBe('false');
  const configured = await createConfiguredCharterWorkflowRuntime(config);
  let services: Awaited<ReturnType<typeof createPhaseEServices>> = null;
  const closeSources = async () => { await services?.close(); configured.close(); sources.mining?.close(); await request.sql.end();
    for (const name of [role, worker]) { await db.execute(sql.raw(`drop owned by ${name}`)); await db.execute(sql.raw(`drop role ${name}`)); } };
  try {
    services = await createPhaseEServices(config, request.db, sources.ownership, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, configured.tournaments, sources.charter ?? configured.client);
    expect(services).not.toBeNull();
    const app = await buildApp(config, request.db, { ...services!.deps, ...(sources.mining ? { miningClaimsProvider: sources.mining.provider } : {}) });
    apps.set(app, { request, services: services!, close: async () => { await app.close(); await closeSources(); } }); await app.ready(); return app;
  } catch (error) { await closeSources(); throw error; }
}
async function closeApps() { const active = [...apps.values()]; apps.clear(); await Promise.all(active.map(app => app.close())); }
async function restricted(app: FastifyInstance) {
  const runtime = apps.get(app)!;
  const [login] = await runtime.request.sql`select current_user=session_user exact_login`;
  expect(login!.exact_login).toBe(true);
  for (const table of ['mining_publication_attempts', 'vehicle_activation_reservations', 'charter_creation_reservations', 'keep_equipment_payment_preparations']) {
    const [acl] = await runtime.request.sql`select has_table_privilege(current_user,${'public.' + table},'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') table_acl,
      has_any_column_privilege(current_user,${'public.' + table},'SELECT,INSERT,UPDATE,REFERENCES') column_acl`;
    expect(acl).toEqual({ table_acl: false, column_acl: false });
    await expect(runtime.request.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' });
  }
  await expect(runtime.request.sql`insert into mining_claim_receipts default values`).rejects.toMatchObject({ code: '42501' });
  for (const key of ['db', 'privateDb', 'issuer', 'signer', 'receiptSource', 'divineOperator', 'clanOperator', 'charterOperator']) expect(runtime.services.deps).not.toHaveProperty(key);
}
afterEach(async () => { await closeApps(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function auth(db: Db, wallet: string) {
  const [row] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, row!.id) };
}
async function effects(db: Db) {
  return db.execute(sql`select jsonb_build_object(
    'ledger', (select count(*) from ledger_transactions),
    'ledger_entries', (select count(*) from ledger_entries),
    'resource_stocks', (select coalesce(jsonb_agg(to_jsonb(s) order by base_id,resource_id),'[]'::jsonb) from resource_stocks s),
    'mining_preparations', (select count(*) from mining_claim_preparations),
    'mining_signed', (select count(*) from mining_claim_signed_wires),
    'mining_receipts', (select count(*) from mining_claim_receipts),
    'seeker_claims', (select count(*) from seeker_resource_claims),
    'vehicle_reservations', (select count(*) from vehicle_activation_reservations),
    'vehicle_signed', (select count(*) from vehicle_burn_signed_wires),
    'vehicle_installations', (select count(*) from advanced_vehicle_installations),
    'charter_reservations', (select count(*) from charter_creation_reservations),
    'charter_signed', (select count(*) from charter_creation_signed_wires),
    'charter_terminals', (select count(*) from charter_creation_terminals)) snapshot`);
}
const post = (app: FastifyInstance, cookies: Record<string, string>, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, cookies, payload });
async function sameSharedReads(app: FastifyInstance, cookies: Record<string, string>) {
  const vehicle = await app.inject({ url: '/vehicles/client/activity', cookies });
  const charter = await app.inject({ url: '/clans/charter/client/activity', cookies });
  const mining = await app.inject({ url: '/claims/mining/status', cookies });
  expect(vehicle.statusCode, vehicle.body).toBe(200);
  expect(charter.statusCode, charter.body).toBe(200);
  expect(charter.json().newActions).toEqual({ creation: false, sale: false });
  expect(mining.statusCode, mining.body).toBe(200);
  expect(mining.json()).toMatchObject({ state: 'unavailable', reason: 'DISABLED', preparationAllowed: false });
  for (const response of [vehicle, charter, mining]) expect(response.headers['cache-control']).toBe('private, no-store');
}

it('boots the combined default-off app with mounted real services and refuses valid new requests without effects', async () => {
  pause(); const conn = resourceClaimsDatabase(); await conn.setup();
  try {
    const { wallet } = await createTestPlayer(conn.db), cookies = await auth(conn.db, wallet), app = await open(conn.db);
    await restricted(app);
    const marketEffects = () => conn.sql`select
      (select count(*)::int from keep_equipment_listings) listings,
      (select count(*)::int from keep_equipment_fills) fills,
      (select count(*)::int from keep_equipment_payment_preparations) preparations`;
    const before = await effects(conn.db), marketBefore = await marketEffects(), baseId = randomUUID();
    const requests = [
      { url: '/claims/mining/prepare', payload: { idempotencyKey: randomUUID() }, code: 'CLAIM_UNAVAILABLE' },
      { url: '/seeker/resource-claims', payload: { idempotencyKey: randomUUID(), baseId, termId: randomUUID(), resourceId: 'heartwood_logs', spotId: 0 }, code: 'PHASE_E_DISABLED' },
      { url: '/vehicles/client/installations', payload: { idempotencyKey: randomUUID(), baseId, berthId: randomUUID(), assetId: Keypair.generate().publicKey.toBase58() }, code: 'VEHICLE_ADMISSION_DISABLED' },
      { url: '/clans/charter/client/creations', payload: { creationIntentId: randomUUID(), baseId, name: 'Dark Charter', tag: 'DARK', inviteMode: 'open' }, code: 'CLAN_CHARTER_WORKFLOW_DISABLED' },
      { url: '/keep-equipment-market/listings', payload: { idempotencyKey: randomUUID(), baseId, itemId: 'route_compass', quantity: '1', unitPriceBaseUnits: '1000000' }, code: 'KEEP_EQUIPMENT_MARKET_DISABLED' },
    ];
    for (const request of requests) {
      const response = await post(app, cookies, request.url, request.payload);
      expect(response.statusCode, response.body).toBe(503); expect(response.json()).toMatchObject({ error: { code: request.code } });
    }
    await sameSharedReads(app, cookies); expect(await effects(conn.db)).toEqual(before);
    expect(await marketEffects()).toEqual(marketBefore);
  } finally { await closeApps(); await conn.close(); }
}, 120_000);

it('recovers real mining and Seeker originals together after live pause and an offline app restart', async () => {
  await withMiningClaimSettlementFixture(async f => {
    enable('MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'HARVESTERS_ENABLED', 'PHASE_E_SEEKER_ENABLED');
    const resource = await createResourceTaxFixture(f.conn.db), request = resource.command();
    const receipt = await claimSeekerResourceTax(f.conn.db, resource.winner.wallet, request, resource.authority);
    await createMiningClaimSettlement(f.conn.db, { reader: f.receiptReader, trust: f.trust })({ wallet: f.wallet, claimId: f.preparedClaim.claimId, ordinal: 0 });
    const miningCookies = await auth(f.conn.db, f.wallet), seekerCookies = await auth(f.conn.db, resource.winner.wallet);
    // These are saved free/legacy originals. This combined history case does
    // not claim enabled deed admission; current source constructors have their
    // own accepted real RPC tests. No startup flag is temporarily overridden.
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    const rpc = await miningClaimRuntimeRpc(f), trust = f.bank.trust;
    const mining = createMiningClaimRuntime({ ...TEST_CONFIG, SOLANA_RPC_URL: rpc.url,
      MINING_CLAIM_PROGRAM_ID: trust.programId.toBase58(), MINING_CLAIM_DEPLOYMENT_SLOT: trust.reviewedDeploymentSlot,
      MINING_CLAIM_PROGRAM_DATA_SHA256: trust.reviewedProgramDataSha256, GEMS_RESERVE_OWNER: trust.reserveOwner.toBase58(), HOT_WALLET_PUBKEY: f.wallet },
    { cluster: 'devnet', keepMint: trust.keepMint.toBase58(), coreProgram: f.identity.programId, configPda: f.identity.configAddress })!;
    try {
     let app = await open(f.conn.db, { mining });
     pause(); const before = await effects(f.conn.db), bankReads = f.bank.reads(), quoteReads = f.quote.reads(), rpcReads = rpc.requests.length;
     for (let restart = 0; restart < 2; restart++) {
      if (restart) { await closeApps(); app = await open(f.conn.db); }
      await restricted(app);
      await sameSharedReads(app, miningCookies);
      const prepared = await post(app, miningCookies, '/claims/mining/prepare', { idempotencyKey: f.preparedClaim.idempotencyKey });
      expect(prepared.statusCode, prepared.body).toBe(201); expect(prepared.json().claimId).toBe(f.preparedClaim.claimId);
      const submitted = await post(app, miningCookies, '/claims/mining/submit', { claimId: f.preparedClaim.claimId, signedTransaction: Buffer.from(f.signed.signedTransactionHex, 'hex').toString('base64') });
      expect(submitted.statusCode, submitted.body).toBe(200); expect(submitted.json()).toMatchObject({ signature: f.signed.signature, delivery: 'settled' });
      const claimed = await post(app, seekerCookies, '/seeker/resource-claims', request);
      expect(claimed.statusCode, claimed.body).toBe(200); expect(claimed.json().receipt).toEqual(receipt);
      const foreign = await app.inject({ url: `/seeker/resource-claims/by-key/${request.idempotencyKey}`, cookies: miningCookies });
      expect(foreign.statusCode, foreign.body).toBe(200); expect(foreign.json().receipt).toBeNull();
      const hidden = await app.inject({ url: `/claims/mining/prepare/by-key/${f.preparedClaim.idempotencyKey}`, cookies: seekerCookies });
      expect(hidden.statusCode, hidden.body).toBe(200); expect(hidden.json()).toMatchObject({ status: 'unknown', receipt: null });
      expect(rpc.sent).toHaveLength(0); expect(rpc.requests).toHaveLength(rpcReads); expect(f.bank.reads()).toBe(bankReads); expect(f.quote.reads()).toBe(quoteReads);
      expect(await effects(f.conn.db)).toEqual(before);
     }
    } finally { await closeApps(); mining.close(); await rpc.close(); }
  }, { genesisHash: SOLANA_GENESIS_HASH.devnet });
}, 120_000);

it('retains a real vehicle terminal through the shared paused app without restoring external providers', async () => {
  enable('MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED');
  const f = await vehicleBurnDatabase();
  try {
    const provider = createVehicleClient(f.conn.db, { installation: { connect: () => f.rpc, trust: f.trust } });
    const reference = { kind: 'installation' as const, id: f.reservation.id }, signed = f.finalizeBurn();
    await provider.retainSigned(f.actor, reference, signed.signedTransaction); const original = await provider.recover(f.actor, reference);
    expect(original.record.status).toBe('installed');
    const cookies = await auth(f.conn.db, f.actor), other = await createTestPlayer(f.conn.db), foreign = await auth(f.conn.db, other.wallet);
    // Owner-backed fixture setup ends here; normal app providers are all
    // created by the private service factory, including the first live app.
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    const sourceReads = vi.spyOn(f.rpc, 'getGenesisHash');
    let app = await open(f.conn.db); pause(); f.setOnline(false); const before = await effects(f.conn.db), reads = sourceReads.mock.calls.length;
    for (let restart = 0; restart < 2; restart++) {
      if (restart) { await closeApps(); app = await open(f.conn.db); }
      await restricted(app);
      await sameSharedReads(app, cookies);
      const read = await app.inject({ url: `/vehicles/client/installations/${reference.id}`, cookies });
      expect(read.statusCode, read.body).toBe(200); expect(read.json()).toMatchObject({ record: { status: 'installed', signed: { signature: original.record.signed!.signature }, installation: { baseId: f.baseId } }, burnReceipt: original.burnReceipt });
      const delivered = await post(app, cookies, `/vehicles/client/installations/${reference.id}/deliver`);
      expect(delivered.statusCode, delivered.body).toBe(200); expect(delivered.json().status).toBe('terminal');
      const hidden = await app.inject({ url: `/vehicles/client/installations/${reference.id}`, cookies: foreign });
      expect(hidden.statusCode, hidden.body).toBe(404); expect(await effects(f.conn.db)).toEqual(before); expect(sourceReads).toHaveBeenCalledTimes(reads);
    }
  } finally { await closeApps(); await f.dispose(); }
}, 120_000);

it('keeps real Charter signed custody in the shared paused app and never broadcasts or exposes another actor', async () => {
  const f = await charterCreationWorkflowFixture({ staticLookupTable: true });
  try {
    await f.useSigningActor(); const creation = f.options();
    // Establish this unresolved original with the accepted fixture workflow.
    // Fully enabled configured creation is covered by the separate actual
    // issuer/private-startup suite; this case covers the combined history mount.
    const setup = await f.open(), seeded = await f.prepared(setup), input = seeded.input;
    const signed = f.signed(seeded.state), saved = await f.post(setup, `/clans/charter/creations/${input.creationIntentId}/signed`, signed.body);
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().status).toBe('signed'); await setup.close();
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    let app = await open(f.db, { charter: { creation }, ownership: { finalizedDeedReader: creation.finalizedDeedReader!, deedCollection: creation.deedCollection! } });
    const path = `/clans/charter/client/creations/${input.creationIntentId}`;
    const retained = await post(app, f.auth.cookies, path + '/signed', signed.body);
    expect(retained.statusCode, retained.body).toBe(200); const original = retained.json();
    const other = await f.actor(), foreign = await f.session(other.wallet); pause(); f.setOnline(false);
    const before = await effects(f.db), calls = f.connect.mock.calls.length, issues = vi.mocked(f.issuer.issueOnce).mock.calls.length;
    for (let restart = 0; restart < 2; restart++) {
      if (restart) { await closeApps(); app = await open(f.db); }
      await restricted(app);
      await sameSharedReads(app, f.auth.cookies);
      const read = await app.inject({ url: path, cookies: f.auth.cookies }); expect(read.statusCode, read.body).toBe(200); expect(read.json()).toEqual(original);
      const delivered = await post(app, f.auth.cookies, path + '/deliver'); expect(delivered.statusCode, delivered.body).toBe(200); expect(delivered.json()).toMatchObject({ status: 'held', reason: 'PAUSED' });
      const hidden = await app.inject({ url: path, cookies: foreign.cookies }); expect(hidden.statusCode, hidden.body).toBe(404);
      expect(f.connect).toHaveBeenCalledTimes(calls); expect(f.issuer.issueOnce).toHaveBeenCalledTimes(issues); expect(await effects(f.db)).toEqual(before);
    }
  } finally { await closeApps(); await f.dispose(); }
}, 120_000);
