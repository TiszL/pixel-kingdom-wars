/** K234: the actual public route and process constructor must keep two different
 * liabilities separate, including a paused economy or failed chain source. */
import { randomUUID } from 'node:crypto';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { Connection, PublicKey } from '@solana/web3.js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildApp, type AppDeps } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapEconomyAllocations } from '../src/ledger';
import { assertEconomyChainIdentity, assertGemsReserveIdentity } from '../src/money/economyIdentity';
import { createMiningTransparencyRuntime } from '../src/money/miningTransparencyRuntime';
import { getProofOfReserves } from '../src/money/snapshot';
import { createMiningBackingFixture } from '../../../packages/chain/src/testFixtures/miningBacking';
import { ADMIN_DATABASE_URL } from './db-url';
import { TEST_CONFIG, createTestPlayer, fundTestKeep } from './helpers';

const name = `mining_por_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
url.pathname = `/${name}`;
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const economy = { cluster: 'devnet' as const, keepMint: pk(1).toBase58(), coreProgram: pk(30).toBase58(), configPda: pk(31).toBase58() };
let conn: ReturnType<typeof createDb>;
beforeAll(async () => {
  await admin.unsafe(`create database ${name}`); conn = createDb(url.toString());
  await runMigrations(conn.db); await bootstrapEconomyAllocations(conn.db);
  const f = await createMiningBackingFixture();
  await assertEconomyChainIdentity(conn.db, economy, economy);
  await assertGemsReserveIdentity(conn.db, { GEMS_RESERVE_OWNER: f.trust.reserveOwner.toBase58(), HOT_WALLET_PUBKEY: pk(32).toBase58() }, economy,
    [{ getAccountInfoAndContext: async () => ({ context: { slot: 150 }, value: { ...f.rows[2]!, lamports: 1, rentEpoch: 0 } }) }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await conn?.sql.end(); await admin.unsafe(`drop database if exists ${name} with (force)`); await admin.end(); });
async function publicPor(deps: AppDeps = {}, query = '') {
  const app = await buildApp(TEST_CONFIG, conn.db, deps);
  try {
    const response = await app.inject({ url: `/por${query}` });
    expect(response.statusCode, response.body).toBe(200); return response.json();
  } finally { await app.close(); }
}
async function runtime() {
  const f = await createMiningBackingFixture({ genesisHash: new PublicKey(SOLANA_GENESIS_HASH.devnet) });
  vi.spyOn(Connection.prototype, 'getGenesisHash').mockImplementation(f.reader.getGenesisHash);
  vi.spyOn(Connection.prototype, 'getSlot').mockImplementation(() => f.reader.getSlot('finalized'));
  const accounts = vi.spyOn(Connection.prototype, 'getMultipleAccountsInfoAndContext').mockImplementation(async (addresses, options) => {
    const result = await f.reader.getMultipleAccountsInfoAndContext(addresses, options as { commitment: 'finalized'; minContextSlot: number });
    return { context: result.context, value: result.value.map(row => row && { ...row, data: Buffer.from(row.data), lamports: 1, rentEpoch: 0 }) };
  });
  const config = { ...TEST_CONFIG, SOLANA_RPC_URL: 'http://127.0.0.1:1', HOT_WALLET_PUBKEY: pk(32).toBase58(), GEMS_RESERVE_OWNER: f.trust.reserveOwner.toBase58(),
    MINING_TRANSPARENCY_PROGRAM_ID: f.trust.programId.toBase58(), MINING_TRANSPARENCY_DEPLOYMENT_SLOT: f.trust.reviewedDeploymentSlot,
    MINING_TRANSPARENCY_PROGRAM_DATA_SHA256: f.trust.reviewedProgramDataSha256 };
  return { ...f, accounts, config, service: createMiningTransparencyRuntime(conn.db, config, economy)! };
}

it('keeps the exact legacy public response and constructs no RPC when deployment pins are absent', async () => {
  const rpc = vi.spyOn(Connection.prototype, 'getGenesisHash');
  expect(createMiningTransparencyRuntime(conn.db, TEST_CONFIG, economy)).toBeNull();
  expect(await publicPor()).toEqual(JSON.parse(JSON.stringify(await getProofOfReserves(conn.db, null))));
  expect(rpc).not.toHaveBeenCalled();
});

it('mounts actual finalized mining accounting while preserving custody totals and paused original rights', async () => {
  const f = await runtime(), { wallet } = await createTestPlayer(conn.db);
  await fundTestKeep(conn.db, wallet, 100n, 'test.por.custody', randomUUID());
  const reserveReader = async () => 1_000n, before = await publicPor({ reserveReader });
  try {
    const result = await publicPor({ reserveReader, miningTransparencyReader: f.service.read });
    const { mining, ...custody } = result;
    expect(custody).toEqual(before);
    expect(mining).toMatchObject({ status: 'available', vault: { balanceBaseUnits: '100' },
      liabilities: { playerBaseUnits: '50', taxBaseUnits: '10', totalBaseUnits: '60' },
      unallocatedVaultBaseUnits: '40', emissionReserve: { balanceBaseUnits: '10', countsAsMiningBacking: false },
      custodialCoverageAffected: false, publicationAuthorized: false, claimsAuthorized: false });
    expect(result.coverage.reserveKeep).toBe('1000');
    expect(f.config.PHASE_E_MINING_ENABLED).toBe('false');
  } finally { f.service.close(); }
});

it('cannot select trust through a public query or mutated configuration and shares the process cache', async () => {
  const f = await runtime();
  try {
    f.config.MINING_TRANSPARENCY_PROGRAM_DATA_SHA256 = 'f'.repeat(64);
    f.config.GEMS_RESERVE_OWNER = pk(33).toBase58();
    const deps = { miningTransparencyReader: f.service.read };
    const first = await publicPor(deps, '?programId=forged&mint=forged&reserve=999999999');
    expect(first.mining.status).toBe('available');
    expect(await publicPor(deps)).toEqual(first);
    expect(f.accounts).toHaveBeenCalledTimes(1);
  } finally { f.service.close(); }
});

it('keeps custody available when finalized mining backing cannot be verified, without invented zeros', async () => {
  const f = await runtime();
  vi.spyOn(Connection.prototype, 'getGenesisHash').mockRejectedValue(new Error('provider unavailable'));
  try {
    const result = await publicPor({ miningTransparencyReader: f.service.read });
    expect(result.mining).toEqual({ status: 'unavailable', reason: 'BACKING_UNAVAILABLE' });
    expect(result.coverage).toBeNull(); expect(result.mining).not.toHaveProperty('liabilities');
  } finally { f.service.close(); }
});

it('rejects wrong reviewed executable bytes instead of reporting healthy zero mining liabilities', async () => {
  const f = await runtime(); f.rows[5]!.data[49] = f.rows[5]!.data[49]! ^ 1;
  try { expect((await publicPor({ miningTransparencyReader: f.service.read })).mining).toEqual({ status: 'unavailable', reason: 'BACKING_UNAVAILABLE' }); }
  finally { f.service.close(); }
});

it('freezes the actual HTTP endpoint and aborts outstanding work on shutdown without restarting it', async () => {
  const f = await runtime(); vi.restoreAllMocks();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const requests: string[] = [];
  let observedSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', (input: string | URL, init: RequestInit) => {
    requests.push(String(input)); observedSignal = init.signal!;
    entered();
    return new Promise((_resolve, reject) => {
      if (init.signal!.aborted) reject(new DOMException('Closed', 'AbortError'));
      else init.signal!.addEventListener('abort', () => reject(new DOMException('Closed', 'AbortError')), { once: true });
    });
  });
  f.config.SOLANA_RPC_URL = 'https://unadmitted.invalid';
  const pending = f.service.read();
  try {
    await started; f.service.close();
    expect(observedSignal?.aborted).toBe(true);
    expect((await pending).status).toBe('unavailable');
    expect(requests).toEqual(['http://127.0.0.1:1']);
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_000);
    expect((await f.service.read()).status).toBe('unavailable');
    expect(requests).toHaveLength(1);
  } finally { f.service.close(); }
});

it('fails startup for partial or malformed operator pins; blank example configuration remains dark', () => {
  const base = { DATABASE_URL: url.toString(), JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
  const pins = { MINING_TRANSPARENCY_PROGRAM_ID: pk(10).toBase58(), MINING_TRANSPARENCY_DEPLOYMENT_SLOT: '90', MINING_TRANSPARENCY_PROGRAM_DATA_SHA256: 'a'.repeat(64),
    GEMS_RESERVE_OWNER: pk(2).toBase58(), HOT_WALLET_PUBKEY: pk(32).toBase58() };
  expect(loadConfig({ ...base, ...pins }).MINING_TRANSPARENCY_DEPLOYMENT_SLOT).toBe(90);
  for (const key of Object.keys(pins)) expect(() => loadConfig({ ...base, ...pins, [key]: undefined })).toThrow();
  for (const value of ['-1', '1.5', '9007199254740992', 'unknown']) expect(() => loadConfig({ ...base, ...pins, MINING_TRANSPARENCY_DEPLOYMENT_SLOT: value })).toThrow();
  expect(loadConfig({ ...base, MINING_TRANSPARENCY_PROGRAM_ID: '', MINING_TRANSPARENCY_DEPLOYMENT_SLOT: '', MINING_TRANSPARENCY_PROGRAM_DATA_SHA256: '' }).MINING_TRANSPARENCY_PROGRAM_ID).toBeUndefined();
});
