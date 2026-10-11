/** Actual process connector + local JSON-RPC + authenticated restricted-LOGIN HTTP.
 * Accepted source fixtures supply finalized bank bytes, never production trust. */
import { randomUUID } from 'node:crypto';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { MINING_PROGRAM_ADDRESS } from '@shardkeep/chain/mining-program';
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createMiningClaimRuntime } from '../src/mining/claimRuntime';
import { withMiningClaimPreparationFixture, type MiningClaimPreparationFixture } from './fixtures/miningClaimPreparation';
import { miningClaimRuntimeRpc, miningClaimRestrictedRuntime, claimRuntimeKey as pk } from './fixtures/miningClaimRuntime';
import { TEST_CONFIG } from './helpers';

const economy = { cluster: 'devnet' as const, keepMint: pk(1), coreProgram: pk(30), configPda: pk(31) };
const pins = { MINING_CLAIM_PROGRAM_ID: MINING_PROGRAM_ADDRESS, MINING_CLAIM_DEPLOYMENT_SLOT: 90, MINING_CLAIM_PROGRAM_DATA_SHA256: 'a'.repeat(64),
  GEMS_RESERVE_OWNER: pk(2), HOT_WALLET_PUBKEY: pk(32) };
const headers = { origin: TEST_CONFIG.WEB_ORIGIN[0]! };
afterEach(() => vi.unstubAllEnvs());
const fixture = (run: (f: MiningClaimPreparationFixture) => Promise<void>) => withMiningClaimPreparationFixture(run, { genesisHash: SOLANA_GENESIS_HASH.devnet });
function configured(f: MiningClaimPreparationFixture, rpc: string) {
  const trust = f.bank.trust;
  return { ...TEST_CONFIG, ...pins, SOLANA_RPC_URL: rpc, MINING_CLAIM_PROGRAM_ID: trust.programId.toBase58(),
    MINING_CLAIM_DEPLOYMENT_SLOT: trust.reviewedDeploymentSlot, MINING_CLAIM_PROGRAM_DATA_SHA256: trust.reviewedProgramDataSha256,
    GEMS_RESERVE_OWNER: trust.reserveOwner.toBase58() };
}
async function auth(f: MiningClaimPreparationFixture, wallet = f.wallet) {
  const [row] = await f.conn.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, row!.id) };
}

it('keeps PoR-only and blank configuration dark and rejects incomplete independent claim pins', () => {
  const base = { DATABASE_URL: TEST_CONFIG.DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: TEST_CONFIG.WEB_ORIGIN[0], NODE_ENV: 'test' };
  expect(createMiningClaimRuntime(TEST_CONFIG, economy)).toBeNull();
  expect(createMiningClaimRuntime({ ...TEST_CONFIG, ...pins, MINING_CLAIM_PROGRAM_ID: undefined, MINING_CLAIM_DEPLOYMENT_SLOT: undefined,
    MINING_CLAIM_PROGRAM_DATA_SHA256: undefined, MINING_TRANSPARENCY_PROGRAM_ID: pins.MINING_CLAIM_PROGRAM_ID,
    MINING_TRANSPARENCY_DEPLOYMENT_SLOT: pins.MINING_CLAIM_DEPLOYMENT_SLOT, MINING_TRANSPARENCY_PROGRAM_DATA_SHA256: pins.MINING_CLAIM_PROGRAM_DATA_SHA256 }, economy)).toBeNull();
  const envPins = { ...pins, MINING_CLAIM_DEPLOYMENT_SLOT: '90' };
  expect(loadConfig({ ...base, ...envPins }).MINING_CLAIM_DEPLOYMENT_SLOT).toBe(90);
  for (const name of Object.keys(pins)) expect(() => loadConfig({ ...base, ...envPins, [name]: undefined })).toThrow();
  for (const value of ['-1', '1.5', '9007199254740992', 'unknown']) expect(() => loadConfig({ ...base, ...pins, MINING_CLAIM_DEPLOYMENT_SLOT: value })).toThrow();
  expect(loadConfig({ ...base, MINING_CLAIM_PROGRAM_ID: '', MINING_CLAIM_DEPLOYMENT_SLOT: '', MINING_CLAIM_PROGRAM_DATA_SHA256: '' }).MINING_CLAIM_PROGRAM_ID).toBeUndefined();
  expect(() => createMiningClaimRuntime({ ...TEST_CONFIG, MINING_CLAIM_DEPLOYMENT_SLOT: 90 }, economy)).toThrow('complete');
  expect(() => createMiningClaimRuntime({ ...TEST_CONFIG, ...pins }, { ...economy, cluster: 'mainnet-beta' })).toThrow();
  expect(() => createMiningClaimRuntime({ ...TEST_CONFIG, ...pins, MINING_CLAIM_PROGRAM_DATA_SHA256: 'bad' }, economy)).toThrow();
  expect(() => createMiningClaimRuntime({ ...TEST_CONFIG, ...pins, MINING_CLAIM_PROGRAM_ID: '11111111111111111111111111111111' }, economy)).toThrow();
});

it('prepares through actual RPC, retains an uncertain same-wire send, and recovers while paused or providerless without owner rights', async () => fixture(async f => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  const rpc = await miningClaimRuntimeRpc(f), request = await miningClaimRestrictedRuntime(f), cookies = await auth(f), foreign = await auth(f, f.buyer);
  const config = configured(f, rpc.url), service = createMiningClaimRuntime(config, economy)!;
  let app = await buildApp({ ...config, DATABASE_URL: request.url }, request.db, { miningClaimsProvider: service.provider });
  try {
    expect(rpc.requests).toHaveLength(0);
    expect((await app.inject({ url: '/claims/mining/status' })).statusCode).toBe(401);
    const dark = await app.inject({ url: '/claims/mining/status', cookies }); expect(dark.json()).toMatchObject({ state: 'unavailable', reason: 'DISABLED' });
    const refused = await app.inject({ method: 'POST', url: '/claims/mining/prepare', cookies, headers, payload: { idempotencyKey: randomUUID() } });
    expect(refused.statusCode, refused.body).toBe(503); expect(rpc.requests).toHaveLength(0);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    // Runtime pins and endpoint have already been copied, not read again per request.
    config.MINING_CLAIM_PROGRAM_DATA_SHA256 = 'f'.repeat(64); config.SOLANA_RPC_URL = 'http://127.0.0.1:1';
    const ready = await app.inject({ url: '/claims/mining/status', cookies }); expect(ready.json()).toMatchObject({ state: 'ready', preparationAllowed: true });
    const key = randomUUID(), prepared = await app.inject({ method: 'POST', url: '/claims/mining/prepare', cookies, headers, payload: { idempotencyKey: key } });
    expect(prepared.statusCode, prepared.body).toBe(201); const original = prepared.json();
    const transaction = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(original.transactions[0].message, 'base64'))); transaction.sign([f.claimantSigner]);
    const bytes = Buffer.from(transaction.serialize()).toString('base64'), payload = { claimId: original.claimId, signedTransaction: bytes };
    const signed = await app.inject({ method: 'POST', url: '/claims/mining/submit', cookies, headers, payload });
    expect(signed.statusCode, signed.body).toBe(202); expect(signed.json()).toMatchObject({ delivery: 'held', reason: 'SEND_UNCERTAIN' });
    expect(rpc.sent).toEqual([bytes]);
    const send = rpc.requests.find(row => row.method === 'sendTransaction')!;
    expect(send.params[1]).toMatchObject({ encoding: 'base64', preflightCommitment: 'finalized', maxRetries: 0, minContextSlot: 3003 });
    // web3 omits false; RPC's default still runs preflight. Never allow true.
    expect((send.params[1] as { skipPreflight?: boolean }).skipPreflight ?? false).toBe(false);
    expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
    await expect(request.sql`insert into mining_claim_receipts default values`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`insert into mining_claim_failures default values`).rejects.toMatchObject({ code: '42501' });
    await expect(request.sql`select * from mining_publication_attempts`).rejects.toMatchObject({ code: '42501' });
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); const calls = rpc.requests.length;
    const paused = await app.inject({ method: 'POST', url: '/claims/mining/submit', cookies, headers, payload });
    expect(paused.json()).toMatchObject({ delivery: 'held', reason: 'PAUSED', signature: signed.json().signature });
    expect(rpc.requests).toHaveLength(calls);
    await app.close(); service.close();
    app = await buildApp(TEST_CONFIG, request.db);
    const saved = await app.inject({ url: `/claims/mining/prepare/by-key/${key}`, cookies });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().status).toBe('prepared');
    const { serverNow: _originalNow, ...originalReceipt } = original;
    const { serverNow: _recoveryNow, ...recoveredReceipt } = saved.json().receipt;
    expect(recoveredReceipt).toEqual(originalReceipt);
    expect(saved.headers['cache-control']).toBe('private, no-store');
    const retained = await app.inject({ url: `/claims/mining/${original.claimId}`, cookies });
    expect(retained.json()).toMatchObject({ state: 'retained', signature: signed.json().signature, settledBaseUnits: null });
    const hidden = await app.inject({ url: `/claims/mining/prepare/by-key/${key}`, cookies: foreign }); expect(hidden.json()).toMatchObject({ status: 'unknown', receipt: null });
    const offline = await app.inject({ method: 'POST', url: '/claims/mining/submit', cookies, headers, payload });
    expect(offline.json()).toMatchObject({ delivery: 'held', reason: 'PROVIDER_UNAVAILABLE', signature: signed.json().signature });
    expect(rpc.requests).toHaveLength(calls); expect(rpc.sent).toEqual([bytes]);
    const wires = await f.conn.sql`select encode(signed_transaction,'base64') bytes from mining_claim_signed_wires where claim_id=${original.claimId}`;
    expect(String(wires[0]!.bytes).replaceAll('\n', '')).toBe(bytes);
  } finally { await app.close(); service.close(); await request.close(); await rpc.close(); }
}), 120_000);

it('refuses wrong chain, executable, mint and insufficient payer SOL without saving a new preparation', async () => fixture(async f => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); const rpc = await miningClaimRuntimeRpc(f), request = await miningClaimRestrictedRuntime(f), cookies = await auth(f);
  const config = configured(f, rpc.url), service = createMiningClaimRuntime(config, economy)!;
  const app = await buildApp(TEST_CONFIG, request.db, { miningClaimsProvider: service.provider });
  try {
    const before = await f.conn.sql`select claim_id from mining_claim_preparations`;
    const prepare = () => app.inject({ method: 'POST', url: '/claims/mining/prepare', cookies, headers, payload: { idempotencyKey: randomUUID() } });
    rpc.setGenesis(pk(8)); expect((await prepare()).statusCode).toBe(503); rpc.setGenesis(SOLANA_GENESIS_HASH.devnet);
    const programData = f.bank.rows[5]!.data, savedByte = programData[programData.length - 1]!; programData[programData.length - 1] = savedByte ^ 1;
    expect((await prepare()).statusCode).toBe(503); programData[programData.length - 1] = savedByte;
    const mint = f.bank.rows[3]!.data, decimals = mint[44]!; mint[44] = decimals + 1;
    expect((await prepare()).statusCode).toBe(503); mint[44] = decimals;
    const payer = f.bank.rows[13]!; f.bank.rows[13] = { ...payer, lamports: 0 };
    const empty = await prepare(); expect(empty.statusCode, empty.body).toBe(422); expect(empty.json().error.code).toBe('INSUFFICIENT_SOL'); f.bank.rows[13] = payer;
    expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toEqual(before); expect(rpc.sent).toHaveLength(0);
    const calls = rpc.requests.length;
    expect((await app.inject({ method: 'POST', url: '/claims/mining/prepare', cookies, headers, payload: { idempotencyKey: randomUUID(), programId: pk(11) } })).statusCode).toBe(400);
    expect(rpc.requests).toHaveLength(calls);
    // Optional verifier connector is read-only and outside the AppDeps provider.
    expect(service.provider).not.toHaveProperty('receiptSource');
    expect(await service.receiptSource(new AbortController().signal).getTransaction('1'.repeat(64), { commitment: 'finalized', maxSupportedTransactionVersion: 0 })).toBeNull();
    expect(rpc.requests.at(-1)).toMatchObject({ method: 'getTransaction', params: ['1'.repeat(64), { commitment: 'finalized', maxSupportedTransactionVersion: 0 }] });
  } finally { await app.close(); service.close(); await request.close(); await rpc.close(); }
}), 120_000);

it('aborts actual pending HTTP work on shutdown and cannot reconnect through a retained reader', async () => {
  const rpc = await miningClaimRuntimeRpc(); rpc.stall();
  const service = createMiningClaimRuntime({ ...TEST_CONFIG, ...pins, SOLANA_RPC_URL: rpc.url }, economy)!;
  try {
    const pending = service.provider.reader.getGenesisHash(); const rejected = expect(pending).rejects.toThrow();
    await rpc.arrival; service.close(); service.close(); await rejected;
    await expect(service.provider.reader.getGenesisHash()).rejects.toThrow();
    expect(() => service.provider.transport(new AbortController().signal)).toThrow();
    expect(() => service.receiptSource(new AbortController().signal)).toThrow();
    expect(rpc.requests).toHaveLength(1);
  } finally { service.close(); await rpc.close(); }
});
