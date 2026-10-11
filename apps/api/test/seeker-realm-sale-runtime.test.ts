/** Process policy/transport + authenticated HTTP using real restricted SQL intent rights. */
import { randomUUID } from 'node:crypto';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { Keypair, Message, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { realmSaleQuoteFixture } from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createDb } from '../src/db/client';
import { players, sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createRealmSaleRuntime } from '../src/seeker/realmSaleRuntime';
import { realmSaleRuntimeRpc, type RealmSaleRuntimeFixture } from './fixtures/realmSaleRuntime';
import { connectTestDb, TEST_CONFIG } from './helpers';

const owner = connectTestDb(), role = `realm_process_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
let request: ReturnType<typeof createDb>, f: RealmSaleRuntimeFixture;
const key = () => Keypair.generate().publicKey.toBase58();
function configured(rpc: string): Config {
  return { ...TEST_CONFIG, SOLANA_RPC_URL: rpc, SEEKER_REALM_SALE_PROGRAM_ID: f.termPolicy.programId.toBase58(),
    SEEKER_REALM_SALE_DEPLOYMENT_SLOT: f.accessTrust.reviewedDeploymentSlot, SEEKER_REALM_SALE_PROGRAM_DATA_SHA256: f.accessTrust.reviewedProgramDataSha256,
    SEEKER_REALM_SALE_UPGRADE_AUTHORITY: f.upgradeAuthority.toBase58(), SEEKER_REALM_SALE_AUCTION_MINT: f.termPolicy.mint.toBase58(),
    SEEKER_REALM_SALE_PRIZE_OWNER: f.termPolicy.prizeOwner.toBase58(), SEEKER_REALM_SALE_DEVELOPER: f.developer.toBase58(),
    SEEKER_REALM_SALE_ROUND: f.termPolicy.round.toString(), SEEKER_REALM_SALE_POLICY_REVISION: 'runtime-r1', SEEKER_REALM_SALE_STATE_PROVENANCE: 'fresh-reviewed-deployment' };
}
beforeAll(async () => {
  f = await realmSaleQuoteFixture({ genesisHash: SOLANA_GENESIS_HASH.devnet });
  await owner.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};
    grant select on players,sessions,seeker_realm_sale_preparations,seeker_realm_sale_signed_wires,seeker_realm_sale_receipts,seeker_realm_sale_failures to ${role};
    grant insert on seeker_realm_sale_preparations,seeker_realm_sale_signed_wires to ${role}`);
  const url = new URL(TEST_CONFIG.DATABASE_URL); url.username = role; url.password = password; request = createDb(url.toString(), { max: 4 });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await request?.sql.end(); await owner.sql.unsafe(`drop owned by ${role};drop role ${role}`); await owner.sql.end(); });
async function auth(wallet = f.buyer.toBase58()) {
  await owner.db.insert(players).values({ wallet }).onConflictDoNothing();
  const [row] = await owner.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, row!.id) };
}
async function appFor(service: ReturnType<typeof createRealmSaleRuntime>) {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  return buildApp(TEST_CONFIG, request.db, service ? { realmSalePreparationSources: service.preparationSources, realmSaleRelaySources: service.relaySources } : {});
}
const headers = { origin: TEST_CONFIG.WEB_ORIGIN[0]! };

it('requires complete explicit operator policy, preserves u64 round and explicit revoked authority, and defaults dark', () => {
  const c = configured('http://127.0.0.1:1'), base = { DATABASE_URL: TEST_CONFIG.DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: TEST_CONFIG.WEB_ORIGIN[0], NODE_ENV: 'test' };
  const pins = Object.fromEntries(Object.entries(c).filter(([name]) => name.startsWith('SEEKER_REALM_SALE_')).map(([name, value]) => [name, String(value)]));
  expect(createRealmSaleRuntime(TEST_CONFIG)).toBeNull();
  expect(createRealmSaleRuntime(loadConfig({ ...base, ...Object.fromEntries(Object.keys(pins).map(name => [name, ''])) }))).toBeNull();
  for (const name of Object.keys(pins)) expect(() => loadConfig({ ...base, ...pins, [name]: undefined })).toThrow();
  for (const value of ['-1', '01', '1e1', '18446744073709551616', 'garbage']) expect(() => loadConfig({ ...base, ...pins, SEEKER_REALM_SALE_ROUND: value })).toThrow();
  const max = loadConfig({ ...base, ...pins, SEEKER_REALM_SALE_ROUND: '18446744073709551615', SEEKER_REALM_SALE_UPGRADE_AUTHORITY: 'none' });
  const service = createRealmSaleRuntime(max)!;
  try { expect(service.preparationSources.policy.term.round).toBe(18446744073709551615n); expect(service.preparationSources.policy.access.upgradeAuthority).toBeNull(); }
  finally { service.close(); }
  expect(() => createRealmSaleRuntime({ ...c, SEEKER_REALM_SALE_STATE_PROVENANCE: undefined })).toThrow('complete');
  expect(() => createRealmSaleRuntime({ ...c, SEEKER_REALM_SALE_PROGRAM_ID: key() })).toThrow();
  expect(() => createRealmSaleRuntime({ ...c, SEEKER_REALM_SALE_DEVELOPER: PublicKey.default.toBase58() })).toThrow();
});

it('quotes and prepares from actual finalized RPC, retains only the original signed wire through pause, policy change and providerless restart', async () => {
  const rpc = await realmSaleRuntimeRpc(f), config = configured(rpc.url), service = createRealmSaleRuntime(config)!, cookies = await auth(), foreign = await auth(key());
  vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false'); let app = await appFor(service);
  try {
    expect((await app.inject({ url: '/seeker/realm-sales/offer?spot=0&realm=0' })).statusCode).toBe(401);
    const dark = await app.inject({ method: 'POST', url: '/seeker/realm-sales/prepare', cookies, headers, payload: { idempotencyKey: randomUUID(), spot: 0, realm: 0 } });
    expect(dark.statusCode, dark.body).toBe(503); expect(rpc.requests).toHaveLength(0);
    vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'true'); config.SOLANA_RPC_URL = 'http://127.0.0.1:1'; config.SEEKER_REALM_SALE_DEVELOPER = key();
    const receiptReader = service.receiptSource(new AbortController().signal);
    expect(Object.keys(receiptReader).sort()).toEqual(['getGenesisHash', 'getMultipleAccountsInfoAndContext', 'getSlot', 'getTransaction']);
    const bank = await receiptReader.getMultipleAccountsInfoAndContext([f.addresses.saleConfig], { commitment: 'finalized', minContextSlot: f.controls.slot });
    expect(bank.value[0]?.address.toBase58()).toBe(f.addresses.saleConfig.toBase58());
    expect(await receiptReader.getTransaction('1'.repeat(64), { commitment: 'finalized', maxSupportedTransactionVersion: 0 })).toBeNull();
    const offer = await app.inject({ url: '/seeker/realm-sales/offer?spot=0&realm=0', cookies });
    expect(offer.statusCode, offer.body).toBe(200); expect(offer.json()).toMatchObject({ status: 'available', authorization: 'none' });
    const idempotencyKey = randomUUID(), prepared = await app.inject({ method: 'POST', url: '/seeker/realm-sales/prepare', cookies, headers, payload: { idempotencyKey, spot: 0, realm: 0 } });
    expect(prepared.statusCode, prepared.body).toBe(201); const original = prepared.json().preparation;
    const tx = new VersionedTransaction(Message.from(Buffer.from(original.quote.messageHex, 'hex'))); tx.sign([Keypair.fromSeed(Buffer.alloc(32, 1))]);
    const bytes = Buffer.from(tx.serialize()).toString('base64'), payload = { idempotencyKey, signedTransaction: bytes };
    const send = await app.inject({ method: 'POST', url: '/seeker/realm-sales/submit', cookies, headers, payload });
    expect(send.statusCode, send.body).toBe(202); expect(send.json()).toMatchObject({ delivery: 'held', reconciliation: { reason: 'SEND_UNCERTAIN' } }); expect(rpc.sent).toEqual([bytes]);
    expect(rpc.requests.find(row => row.method === 'sendTransaction')!.params[1]).toMatchObject({ encoding: 'base64', preflightCommitment: 'finalized', maxRetries: 0 });
    expect((rpc.requests.find(row => row.method === 'sendTransaction')!.params[1] as { skipPreflight?: boolean }).skipPreflight ?? false).toBe(false);
    await expect(request.sql`insert into seeker_realm_sale_receipts default values`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`insert into seeker_realm_sale_failures default values`).rejects.toMatchObject({ code: '42501' });
    const path = `/seeker/realm-sales/by-key/${idempotencyKey}`;
    const saved = (await app.inject({ url: path, cookies })).json(); expect(saved.preparation).toEqual(original);
    vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false'); const count = rpc.requests.length;
    const paused = await app.inject({ method: 'POST', url: '/seeker/realm-sales/submit', cookies, headers, payload });
    expect(paused.json()).toMatchObject({ reconciliation: { reason: 'PAUSED' } }); expect(rpc.requests).toHaveLength(count);
    await app.close(); service.close();
    for (const patch of [{ SEEKER_REALM_SALE_POLICY_REVISION: 'runtime-r2' }, { SEEKER_REALM_SALE_ROUND: '1' }]) {
      const changed = createRealmSaleRuntime({ ...configured(rpc.url), ...patch })!; app = await appFor(changed); vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'true');
      try {
        const held = await app.inject({ method: 'POST', url: '/seeker/realm-sales/submit', cookies, headers, payload });
        expect(held.json()).toMatchObject({ reconciliation: { reason: 'ADMISSION_HELD' } }); expect(rpc.sent).toEqual([bytes]);
        expect((await app.inject({ url: path, cookies })).json()).toEqual(saved);
      } finally { await app.close(); changed.close(); }
    }
    vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false'); app = await appFor(null); const stoppedCount = rpc.requests.length;
    const recovered = await app.inject({ url: path, cookies }); expect(recovered.json()).toEqual(saved); expect(recovered.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ url: path, cookies: foreign })).json()).toMatchObject({ preparation: null, wire: null, settlement: null });
    const offline = await app.inject({ method: 'POST', url: '/seeker/realm-sales/submit', cookies, headers, payload }); expect(offline.statusCode).toBe(202);
    expect(rpc.requests).toHaveLength(stoppedCount); expect(rpc.sent).toEqual([bytes]);
    expect(await owner.sql`select * from seeker_realm_sale_receipts where wallet=${f.buyer.toBase58()} and idempotency_key=${idempotencyKey}`).toHaveLength(0);
  } finally { await app.close(); service.close(); await rpc.close(); }
}, 120_000);

it('rejects mismatched finalized deployment and economic identities before saving new consent', async () => {
  vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'true'); const rpc = await realmSaleRuntimeRpc(f), cookies = await auth();
  const before = await owner.sql`select count(*)::int count from seeker_realm_sale_preparations`;
  try {
    for (const patch of [
      { SEEKER_REALM_SALE_PROGRAM_DATA_SHA256: 'f'.repeat(64) }, { SEEKER_REALM_SALE_UPGRADE_AUTHORITY: key() },
      { SEEKER_REALM_SALE_AUCTION_MINT: key() }, { SEEKER_REALM_SALE_PRIZE_OWNER: key() }, { SEEKER_REALM_SALE_DEVELOPER: key() },
    ]) {
      const service = createRealmSaleRuntime({ ...configured(rpc.url), ...patch })!, app = await appFor(service);
      try { const result = await app.inject({ method: 'POST', url: '/seeker/realm-sales/prepare', cookies, headers, payload: { idempotencyKey: randomUUID(), spot: 0, realm: 0 } }); expect(result.statusCode, result.body).toBe(503); }
      finally { await app.close(); service.close(); }
    }
    const service = createRealmSaleRuntime(configured(rpc.url))!, app = await appFor(service); f.controls.genesisHash = key();
    try { expect((await app.inject({ method: 'POST', url: '/seeker/realm-sales/prepare', cookies, headers, payload: { idempotencyKey: randomUUID(), spot: 0, realm: 0 } })).statusCode).toBe(503); }
    finally { f.controls.genesisHash = SOLANA_GENESIS_HASH.devnet; await app.close(); service.close(); }
    expect(await owner.sql`select count(*)::int count from seeker_realm_sale_preparations`).toEqual(before); expect(rpc.sent).toHaveLength(0);
  } finally { await rpc.close(); }
}, 120_000);

it('aborts unfinished RPC at shutdown and refuses retained quote/relay connectors afterwards', async () => {
  const rpc = await realmSaleRuntimeRpc(f); rpc.stall(); const service = createRealmSaleRuntime(configured(rpc.url))!;
  try {
    const connector = service.preparationSources.connect(new AbortController().signal), pending = connector.getGenesisHash(), failed = expect(pending).rejects.toThrow();
    await rpc.arrival; service.close(); service.close(); await failed;
    await expect(connector.getGenesisHash()).rejects.toThrow();
    expect(() => service.relaySources.transport(new AbortController().signal)).toThrow(); expect(rpc.requests).toHaveLength(1);
  } finally { service.close(); await rpc.close(); }
});
