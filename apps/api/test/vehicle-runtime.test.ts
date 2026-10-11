/** Normal private composition + real loopback RPC + restricted authenticated HTTP.
 * Fixture registry/Core records remain synthetic, owner-attested source evidence. */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { afterEach, expect, it, vi } from 'vitest';
import type { VehicleClient, VehicleReference } from '@shardkeep/shared/vehicleClientApi';
import { createVehicleRuntime } from '../src/game/vehicleRuntime';
import { createPhaseEServices } from '../src/phaseEServices';
import { createDb } from '../src/db/client';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { vehicleClientPairFixture } from './fixtures/vehicleClientPair';
import { ADMIN_DATABASE_URL } from './db-url';
import { releaseMigratedTemplates } from './migratedTemplate';
import { TEST_CONFIG } from './helpers';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const pins = { VEHICLE_CORE_DEPLOYMENT_SLOT: 50, VEHICLE_CORE_PROGRAM_DATA_SHA256: '1'.repeat(64), VEHICLE_CORE_UPGRADE_AUTHORITY: 'none' };
it('defaults to offline history and requires every explicit Core pin without borrowing mining authority', () => {
  expect(createVehicleRuntime(TEST_CONFIG)).toBeNull();
  const base = { DATABASE_URL: TEST_CONFIG.DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: TEST_CONFIG.WEB_ORIGIN[0], NODE_ENV: 'test' };
  const fields = Object.fromEntries(Object.entries(pins).map(([key, value]) => [key, String(value)]));
  expect(createVehicleRuntime(loadConfig({ ...base, ...Object.fromEntries(Object.keys(pins).map(key => [key, ''])) }))).toBeNull();
  for (const key of Object.keys(pins)) expect(() => loadConfig({ ...base, ...fields, [key]: undefined })).toThrow();
  for (const patch of [{ VEHICLE_CORE_DEPLOYMENT_SLOT: -1 }, { VEHICLE_CORE_PROGRAM_DATA_SHA256: 'bad' }, { VEHICLE_CORE_UPGRADE_AUTHORITY: '11111111111111111111111111111111' }]) {
    expect(() => createVehicleRuntime({ ...TEST_CONFIG, ...pins, ...patch })).toThrow();
  }
  const source = createVehicleRuntime({ ...TEST_CONFIG, ...pins })!;
  expect(source.sources.workflow.trust).toEqual({ expectedGenesisHash: SOLANA_GENESIS_HASH.devnet, reviewedDeploymentSlot: 50, reviewedProgramDataSha256: pins.VEHICLE_CORE_PROGRAM_DATA_SHA256, upgradeAuthority: null });
  source.close();
});
it.each(['finality', 'current', 'blockhash'] as const)('aborts actual stalled %s RPC and refuses retained methods after close', async kind => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  const server = createServer(() => { calls++; entered(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('No fixture port');
  const source = createVehicleRuntime({ ...TEST_CONFIG, ...pins, SOLANA_RPC_URL: `http://127.0.0.1:${address.port}` })!;
  const read = kind === 'blockhash' ? source.sources.workflow.getBlockhash :
    (kind === 'finality' ? source.sources.workflow.connect : source.sources.current.connect)(new AbortController().signal).getGenesisHash;
  try {
    const pending = read(), rejected = expect(pending).rejects.toThrow(); await started; source.close(); await rejected;
    await expect(read()).rejects.toThrow(); expect(calls).toBe(1);
    expect(() => source.sources.current.connect(new AbortController().signal)).toThrow();
  } finally { source.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it('mounts actual initial/service consent and finalized recovery privately through pause and providerless restart', async () => {
  const f = await vehicleClientPairFixture({ genesisHash: SOLANA_GENESIS_HASH.devnet });
  const seen: string[] = []; let loseReply = true;
  const rpc = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { id: string; method: string; params: unknown[] }; seen.push(body.method);
    try {
      const result = await f.live(body.method, body.params);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body.method === 'sendTransaction' && loseReply
        ? { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Fixture acknowledgement lost' } } : { ...result, id: body.id }));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve)); const address = rpc.address();
  if (!address || typeof address === 'string') throw Error('No fixture port');
  const [database] = await f.f.conn.sql`select current_database() name`;
  const ownerUrl = new URL(ADMIN_DATABASE_URL); ownerUrl.pathname = `/${database!.name}`;
  const role = `vehicle_runtime_${randomUUID().replaceAll('-', '')}`, worker = `vehicle_worker_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
  execFileSync('sh', [fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url))], {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH,
      PGHOST: ownerUrl.hostname, PGPORT: ownerUrl.port, PGDATABASE: database!.name, PGUSER: decodeURIComponent(ownerUrl.username), PGPASSWORD: decodeURIComponent(ownerUrl.password),
      POSTGRES_USER: decodeURIComponent(ownerUrl.username), POSTGRES_PASSWORD: decodeURIComponent(ownerUrl.password), DB_ROLE_MODE: 'isolated', SOLANA_CLUSTER: 'devnet',
      API_DB_USER: role, API_DB_PASSWORD: password, WORKER_DB_USER: worker, WORKER_DB_PASSWORD: randomBytes(32).toString('hex') } });
  const requestUrl = new URL(ownerUrl); requestUrl.username = role; requestUrl.password = password;
  const request = createDb(requestUrl.toString(), { max: 2 });
  const config = { ...TEST_CONFIG, ...pins, VEHICLE_CORE_PROGRAM_DATA_SHA256: f.f.trust.reviewedProgramDataSha256,
    DATABASE_URL: requestUrl.toString(), PHASE_E_SERVICE_DATABASE_URL: ownerUrl.toString(), SOLANA_RPC_URL: `http://127.0.0.1:${address.port}` };
  const source = createVehicleRuntime(config)!;
  let services = await createPhaseEServices(config, request.db, {}, undefined, undefined, undefined, source.sources);
  let app = await buildApp(config, request.db, services!.deps);
  const headers = { origin: config.WEB_ORIGIN[0]! }, saved: { path: string; original: VehicleClient }[] = [];
  async function post(path: string, payload: object = {}) {
    const reply = await app.inject({ method: 'POST', url: path, cookies: f.cookies, headers, payload });
    expect(reply.statusCode, reply.body).toBe(200); return reply.json();
  }
  try {
    expect(seen).toHaveLength(0);
    config.SOLANA_RPC_URL = 'http://127.0.0.1:1'; config.VEHICLE_CORE_PROGRAM_DATA_SHA256 = '0'.repeat(64);
    let installationId = '';
    for (const kind of ['installation', 'service'] as const) {
      f.state({ paused: false }); const prefix = `/vehicles/client/${kind === 'installation' ? 'installations' : 'services'}`;
      const reservation = await post(prefix, kind === 'installation'
        ? { baseId: f.config.baseId, berthId: f.config.berthId, assetId: f.config.initialAssetId, idempotencyKey: randomUUID() }
        : { installationId, assetId: f.config.upgradeAssetId, operation: 'upgrade', idempotencyKey: randomUUID() });
      const id = kind === 'installation' ? reservation.record.reservation.reservationId : reservation.record.intent.intentId;
      if (kind === 'installation') installationId = id;
      const path = `${prefix}/${id}`, ref: VehicleReference = { kind, id };
      const prepared = await post(path + '/prepare'); expect((await post(path + '/review')).status).toBe('ready');
      if (kind === 'installation') {
        const wrong = createVehicleRuntime({ ...config, SOLANA_RPC_URL: `http://127.0.0.1:${address.port}` })!;
        const held = await createPhaseEServices(config, request.db, {}, undefined, undefined, undefined, wrong.sources);
        const heldApp = await buildApp(config, request.db, held!.deps);
        try {
          const refused = await heldApp.inject({ method: 'POST', url: path + '/review', cookies: f.cookies, headers, payload: {} });
          expect(refused.statusCode, refused.body).toBe(200); expect(refused.json()).toMatchObject({ status: 'held', reason: 'IDENTITY' });
          expect(f.sent).toHaveLength(0);
        } finally { await heldApp.close(); await held!.close(); wrong.close(); }
      }
      const signed = await f.sign(prepared); await post(path + '/signed', { signedTransaction: Buffer.from(signed.signedTransactionHex, 'hex').toString('base64') });
      const delivered = await post(path + '/deliver'); expect(delivered.status).toBe(loseReply ? 'held' : 'submitted');
      if (loseReply) expect(delivered.reason).toBe('SEND_UNCERTAIN');
      await f.finalize(ref); f.state({ paused: true });
      const recovered = await post(path + '/recover');
      expect(recovered.record.status).toBe(kind === 'installation' ? 'installed' : 'applied');
      expect(recovered.burnReceipt.signature).toBe(signed.signature); saved.push({ path, original: recovered }); loseReply = false;
    }
    expect(f.sent).toHaveLength(2); expect(new Set(f.sent).size).toBe(2);
    await expect(request.sql`select * from vehicle_activation_reservations`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`insert into vehicle_burn_consumptions default values`).rejects.toMatchObject({ code: '42501' });
    expect(await f.f.conn.sql`select count(*)::int n from vehicle_burn_consumptions`).toEqual([{ n: 1 }]);
    expect(await f.f.conn.sql`select count(*)::int n from vehicle_service_consumptions`).toEqual([{ n: 1 }]);
    await app.close(); await services!.close(); source.close();
    services = await createPhaseEServices(config, request.db); app = await buildApp(config, request.db, services!.deps);
    const count = seen.length;
    for (const { path, original } of saved) {
      const recovered = await app.inject({ url: path, cookies: f.cookies });
      expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().burnReceipt).toEqual(original.burnReceipt);
      expect(recovered.headers['cache-control']).toBe('private, no-store'); expect((await app.inject({ url: path })).statusCode).toBe(401);
      expect((await post(path + '/deliver')).status).toBe('terminal');
    }
    expect(seen).toHaveLength(count);
  } finally {
    await app.close(); await services!.close(); source.close(); await request.sql.end();
    // A migrated template holds GRANTs to the groups; release it before dropping them.
    await releaseMigratedTemplates();
    for (const name of [role, worker, 'shardkeep_api_runtime', 'shardkeep_worker_runtime']) await f.f.conn.sql.unsafe(`drop owned by ${name};drop role ${name}`);
    rpc.closeAllConnections(); await new Promise<void>((resolve, reject) => rpc.close(error => error ? reject(error) : resolve())); await f.dispose();
  }
}, 120_000);
