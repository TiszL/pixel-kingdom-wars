/** Actual process policy/RPC/HTTP authority separation for historical KEEP tax. */
import { randomUUID } from 'node:crypto';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { createMiningTaxSnapshotReader } from '@shardkeep/chain/mining-tax-snapshot';
import { Keypair, Message, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createMiningTaxSnapshotFixture } from '../../../packages/chain/src/testFixtures/miningTaxSnapshot';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createDb } from '../src/db/client';
import { players, sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createMiningTaxRuntime } from '../src/mining/taxRuntime';
import { miningTaxRuntimeRpc, type MiningTaxRuntimeFixture } from './fixtures/miningTaxRuntime';
import { connectTestDb, TEST_CONFIG } from './helpers';

const owner = connectTestDb(), role = `tax_process_${randomUUID().replaceAll('-', '')}`, password = randomUUID(), signer = Keypair.generate();
let request: ReturnType<typeof createDb>, f: MiningTaxRuntimeFixture;
const key = () => Keypair.generate().publicKey.toBase58();
const economy = () => ({ cluster: TEST_CONFIG.SOLANA_CLUSTER, keepMint: f.trust.mining.keepMint.toBase58(), coreProgram: key(), configPda: key() });
function configured(rpc: string): Config {
  return { ...TEST_CONFIG, SOLANA_RPC_URL: rpc, GEMS_RESERVE_OWNER: f.trust.mining.reserveOwner.toBase58(), HOT_WALLET_PUBKEY: key(),
    MINING_TAX_PROGRAM_ID: f.trust.mining.programId.toBase58(), MINING_TAX_DEPLOYMENT_SLOT: f.trust.mining.reviewedDeploymentSlot,
    MINING_TAX_PROGRAM_DATA_SHA256: f.trust.mining.reviewedProgramDataSha256, MINING_TAX_UPGRADE_AUTHORITY: f.trust.seeker.deployment.upgradeAuthority ?? 'none',
    MINING_TAX_AUCTION_MINT: f.trust.seeker.mint.toBase58(), MINING_TAX_PRIZE_OWNER: f.trust.seeker.prizeOwner.toBase58(), MINING_TAX_STATE_PROVENANCE: 'fresh-reviewed-deployment' };
}
beforeAll(async () => {
  f = await createMiningTaxSnapshotFixture({ wallet: signer.publicKey, genesisHash: new PublicKey(SOLANA_GENESIS_HASH.devnet) });
  f.models.cursor.claimed_total = 0n; await f.encode('cursor');
  await owner.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};
    grant select on players,sessions,mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_receipts,mining_tax_claim_failures,mining_tax_claim_continuations to ${role};
    grant insert on mining_tax_claim_preparations,mining_tax_claim_signed_wires to ${role}`);
  const url = new URL(TEST_CONFIG.DATABASE_URL); url.username = role; url.password = password; request = createDb(url.toString(), { max: 4 });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await request?.sql.end(); await owner.sql.unsafe(`drop owned by ${role};drop role ${role}`); await owner.sql.end(); });
async function auth(wallet = signer.publicKey.toBase58()) {
  await owner.db.insert(players).values({ wallet }).onConflictDoNothing();
  const [row] = await owner.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, row!.id) };
}
async function appFor(service: ReturnType<typeof createMiningTaxRuntime>) {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  return buildApp(TEST_CONFIG, request.db, service ? { miningTaxPreparationSources: service.preparationSources, miningTaxRelaySources: service.relaySources } : {});
}
const headers = { origin: TEST_CONFIG.WEB_ORIGIN[0]! }, consent = () => ({ idempotencyKey: randomUUID(), round: '0', spot: 0, caps: { maxFeeLamports: '10', maxRentLamports: '1000', maxTotalLamports: '1010' } });

it('requires independent complete tax pins and explicit authority; other configured providers never enable it', () => {
  const c = configured('http://127.0.0.1:1'), base = { DATABASE_URL: TEST_CONFIG.DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: TEST_CONFIG.WEB_ORIGIN[0], NODE_ENV: 'test' };
  const pins = Object.fromEntries(Object.entries(c).filter(([name]) => name.startsWith('MINING_TAX_') || ['GEMS_RESERVE_OWNER', 'HOT_WALLET_PUBKEY'].includes(name)).map(([name, value]) => [name, String(value)]));
  expect(createMiningTaxRuntime({ ...TEST_CONFIG, MINING_CLAIM_PROGRAM_ID: c.MINING_TAX_PROGRAM_ID, MINING_CLAIM_DEPLOYMENT_SLOT: c.MINING_TAX_DEPLOYMENT_SLOT, MINING_CLAIM_PROGRAM_DATA_SHA256: c.MINING_TAX_PROGRAM_DATA_SHA256 }, economy())).toBeNull();
  expect(createMiningTaxRuntime(loadConfig({ ...base, ...Object.fromEntries(Object.keys(pins).map(name => [name, ''])) }), economy())).toBeNull();
  for (const name of Object.keys(pins)) expect(() => loadConfig({ ...base, ...pins, [name]: undefined })).toThrow();
  for (const patch of [{ MINING_TAX_DEPLOYMENT_SLOT: '-1' }, { MINING_TAX_STATE_PROVENANCE: 'assumed' }, { MINING_TAX_UPGRADE_AUTHORITY: '' }, { MINING_TAX_PROGRAM_DATA_SHA256: 'bad' }]) expect(() => loadConfig({ ...base, ...pins, ...patch })).toThrow();
  const service = createMiningTaxRuntime(loadConfig({ ...base, ...pins }), economy())!;
  try { expect(service.trust.seeker.deployment.upgradeAuthority).toBeNull(); expect(Object.hasOwn(service.trust.seeker, 'round')).toBe(false); }
  finally { service.close(); }
  expect(() => createMiningTaxRuntime({ ...c, MINING_TAX_STATE_PROVENANCE: undefined }, economy())).toThrow('complete');
  expect(() => createMiningTaxRuntime(c, { ...economy(), cluster: 'mainnet-beta' })).toThrow('complete');
  expect(() => createMiningTaxRuntime({ ...c, MINING_TAX_PRIZE_OWNER: PublicKey.default.toBase58() }, economy())).toThrow();
});

it('prepares from finalized original-term RPC, relays only retained bytes and recovers exact consent while paused and providerless', async () => {
  const rpc = await miningTaxRuntimeRpc(f), config = configured(rpc.url), service = createMiningTaxRuntime(config, economy())!, cookies = await auth(), foreign = await auth(key());
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); let app = await appFor(service);
  try {
    const payload = consent();
    expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', headers, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', cookies, headers, payload })).statusCode).toBe(503); expect(rpc.requests).toHaveLength(0);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); config.SOLANA_RPC_URL = 'http://127.0.0.1:1'; config.MINING_TAX_AUCTION_MINT = key();
    const read = service.receiptSource(new AbortController().signal), failure = service.failureSource(new AbortController().signal);
    expect(Object.keys(read).sort()).toEqual(['getBlock', 'getGenesisHash', 'getMultipleAccountsInfoAndContext', 'getSignaturesForAddress', 'getSlot', 'getTransaction']);
    expect(Object.keys(failure).sort()).toEqual(['getGenesisHash', 'getMultipleAccountsInfoAndContext', 'getSlot', 'getTransaction']);
    const originalTerm = await createMiningTaxSnapshotReader(service.receiptSource, service.trust)(f.request);
    expect(originalTerm).toMatchObject({ wallet: signer.publicKey.toBase58(), entitlement: { available: 3n } });
    expect((await failure.getMultipleAccountsInfoAndContext([f.term.config], { commitment: 'finalized', minContextSlot: 2000 })).value[0]?.address.toBase58()).toBe(f.term.config.toBase58());
    const prepared = await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', cookies, headers, payload });
    expect(prepared.statusCode, prepared.body).toBe(201); const original = prepared.json().preparation;
    expect(original).toMatchObject({ round: '0', spot: 0, caps: payload.caps, fees: { payerBalanceLamports: '1000000' } });
    const tx = new VersionedTransaction(Message.from(Buffer.from(original.transactions[0].messageHex, 'hex'))); tx.sign([signer]);
    const bytes = Buffer.from(tx.serialize()).toString('base64'), signed = { idempotencyKey: payload.idempotencyKey, signedTransaction: bytes };
    const sent = await app.inject({ method: 'POST', url: '/claims/mining-tax/submit', cookies, headers, payload: signed });
    expect(sent.statusCode, sent.body).toBe(202); expect(sent.json()).toMatchObject({ delivery: 'held', reason: 'SEND_UNCERTAIN' }); expect(rpc.sent).toEqual([bytes]);
    expect(rpc.requests.find(row => row.method === 'sendTransaction')!.params[1]).toMatchObject({ encoding: 'base64', preflightCommitment: 'finalized', maxRetries: 0 });
    await expect(request.sql`insert into mining_tax_claim_receipts default values`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`insert into mining_tax_claim_failures default values`).rejects.toMatchObject({ code: '42501' });
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); const count = rpc.requests.length;
    expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/submit', cookies, headers, payload: signed })).json()).toMatchObject({ reason: 'PAUSED' }); expect(rpc.requests).toHaveLength(count);
    await app.close(); service.close(); app = await appFor(null);
    const path = `/claims/mining-tax/by-key/${payload.idempotencyKey}`, recovered = await app.inject({ url: path, cookies });
    expect(recovered.headers['cache-control']).toBe('private, no-store'); expect(recovered.json()).toMatchObject({ status: 'signed', preparation: original, settlement: null }); expect(recovered.json().wires[0].signedTransactionHex).toBe(Buffer.from(bytes, 'base64').toString('hex'));
    expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', cookies, headers, payload })).json().preparation).toEqual(original);
    expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', cookies, headers, payload: { ...payload, round: '1' } })).statusCode).toBe(409);
    expect((await app.inject({ url: path, cookies: foreign })).json()).toMatchObject({ preparation: null, wires: [], settlement: null });
    expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/submit', cookies, headers, payload: signed })).json()).toMatchObject({ reason: 'DELIVERY_UNAVAILABLE' });
    expect(rpc.requests).toHaveLength(count); expect(rpc.sent).toEqual([bytes]);
    expect(await owner.sql`select * from mining_tax_claim_receipts where claim_id=${original.claimId}`).toHaveLength(0);
  } finally { await app.close(); service.close(); await rpc.close(); }
}, 120_000);

it('refuses wrong deployment, original winner and auction/reserve identity without saving new consent', async () => {
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); const rpc = await miningTaxRuntimeRpc(f), cookies = await auth(), foreign = await auth(key());
  const before = await owner.sql`select count(*)::int count from mining_tax_claim_preparations`;
  try {
    for (const patch of [{ MINING_TAX_PROGRAM_DATA_SHA256: 'f'.repeat(64) }, { MINING_TAX_UPGRADE_AUTHORITY: key() }, { MINING_TAX_AUCTION_MINT: key() }, { MINING_TAX_PRIZE_OWNER: key() }, { GEMS_RESERVE_OWNER: key() }]) {
      const service = createMiningTaxRuntime({ ...configured(rpc.url), ...patch }, economy())!, app = await appFor(service);
      try { const result = await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', cookies, headers, payload: consent() }); expect(result.statusCode, result.body).toBe(503); }
      finally { await app.close(); service.close(); }
    }
    const service = createMiningTaxRuntime(configured(rpc.url), economy())!, app = await appFor(service);
    try {
      expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', cookies: foreign, headers, payload: consent() })).statusCode).toBe(503);
      rpc.control.genesisHash = key(); expect((await app.inject({ method: 'POST', url: '/claims/mining-tax/prepare', cookies, headers, payload: consent() })).statusCode).toBe(503);
    } finally { await app.close(); service.close(); }
    expect(await owner.sql`select count(*)::int count from mining_tax_claim_preparations`).toEqual(before); expect(rpc.sent).toHaveLength(0);
  } finally { await rpc.close(); }
}, 120_000);

it('cancels in-flight RPC and refuses all retained connectors after shutdown', async () => {
  const rpc = await miningTaxRuntimeRpc(f); rpc.stall(); const service = createMiningTaxRuntime(configured(rpc.url), economy())!;
  try {
    const connection = service.preparationSources.connect(new AbortController().signal), pending = connection.getGenesisHash(), failed = expect(pending).rejects.toThrow();
    await rpc.arrival; service.close(); await failed; await expect(connection.getGenesisHash()).rejects.toThrow();
    for (const connect of [service.relaySources.transport, service.receiptSource, service.failureSource]) expect(() => connect(new AbortController().signal)).toThrow();
    expect(rpc.requests).toHaveLength(1);
  } finally { service.close(); await rpc.close(); }
});
