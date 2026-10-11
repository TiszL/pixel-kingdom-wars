/** Fault injection only: the RPC server is simulated, while HTTP transport,
 * finalized readers, BullMQ orchestration, SQL and authenticated API are real.
 * These seeded fixtures do not replace the unseeded real-wallet acceptance. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Queue, QueueEvents, Worker } from 'bullmq';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, TransactionMessage } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeDeedMintInventoryConnection } from '@shardkeep/chain';
import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE } from '../src/auth/session';
import { bases, players, sessions } from '../src/db/schema';
import { playtestCampaignAudit, playtestCampaigns, playtestFounders,
  playtestMintEvidence, playtestMintInventory } from '../src/db/playtestCampaignSchema';
import { ensurePlaytestCampaigns, snapshotPlaytestFounders } from '../src/game/playtestCampaigns';
import { runMintEvidenceReconciliation } from '../src/jobs';
import { bootstrapEconomyAllocations } from '../src/ledger';
import { disposableMintTestDb } from './disposable-mint-db';
import { TEST_CONFIG } from './helpers';

const id = randomUUID().replaceAll('-', '');
const redisUrl = new URL(TEST_CONFIG.REDIS_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(redisUrl.hostname)) {
  throw new Error('Mint worker fixture requires local test Redis');
}
redisUrl.pathname = '/2';
const connection = disposableMintTestDb('mint_worker');
const db = connection.db;
const admin = Keypair.generate().publicKey.toBase58();
const config = { ...TEST_CONFIG, DATABASE_URL: connection.url, REDIS_URL: redisUrl.toString(), ADMIN_WALLETS: [admin] };
const core = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const collection = Keypair.generate().publicKey;
const mintTime = Math.floor(Date.now() / 1000) - 3_600;
const candidates = Array.from({ length: RULES.founderSpots + 1 }, (_, i) => ({
  asset: Keypair.generate().publicKey,
  owner: Keypair.generate().publicKey,
  signature: bs58.encode(Buffer.alloc(64, i + 1)),
  // The final two share a finalized block; transaction order breaks their tie.
  slot: i < RULES.founderSpots - 1 ? 100 + i : 200,
  position: i + 1,
}));
type Mode = 'healthy' | 'rate-limit-once' | 'server-error-once' | 'changing' | 'incomplete';
type Call = { method: string; params: unknown[]; mode: Mode };
let mode: Mode = 'healthy', chainCount = RULES.founderSpots - 1, slot = 500;
let beforeRead = true, inventoryReads = 0;
const calls: Call[] = [];
const observations: Array<Record<string, unknown>> = [];
let scanHeld: (() => void) | undefined, releaseScan: (() => void) | undefined;
let scanHold: Promise<void> | undefined;
let rpcServer: Server;
let rpcUrl: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let queue: Queue, events: QueueEvents, worker: Worker;

function account(count: number) {
  // Core CollectionV1 wire layout: discriminator, authority, two empty Borsh
  // strings, cumulative mint counter and current size. No SDK mocking.
  const bytes = Buffer.alloc(49);
  bytes[0] = 5;
  collection.toBuffer().copy(bytes, 1);
  bytes.writeUInt32LE(count, 41);
  bytes.writeUInt32LE(count, 45);
  return { owner: core.toBase58(), data: [bytes.toString('base64'), 'base64'],
    executable: false, lamports: 1, rentEpoch: 0 };
}
function mintTransaction(candidate: typeof candidates[number]) {
  // Valid CreateV2 with empty name/URI and None plugin options. The production
  // decoder, instruction account checks and finalized block lookup all run.
  const data = Buffer.alloc(12);
  data[0] = 20;
  const message = new TransactionMessage({ payerKey: candidate.owner,
    recentBlockhash: collection.toBase58(), instructions: [{ programId: core,
      keys: [candidate.asset, collection, candidate.owner, candidate.owner, candidate.owner, core, core, core]
        .map(pubkey => ({ pubkey, isSigner: false, isWritable: false })), data,
    }] }).compileToV0Message();
  return { slot: candidate.slot, blockTime: mintTime, version: 0,
    meta: { err: null, fee: 0, preBalances: [], postBalances: [], loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: [candidate.signature], message: {
      header: message.header, accountKeys: message.staticAccountKeys.map(k => k.toBase58()),
      recentBlockhash: message.recentBlockhash, addressTableLookups: [],
      instructions: message.compiledInstructions.map(ix => ({ programIdIndex: ix.programIdIndex,
        accounts: [...ix.accountKeyIndexes], data: bs58.encode(ix.data) })),
    } },
  };
}
async function rpcResult(method: string, params: unknown[]) {
  if (method === 'getAccountInfo') {
    const wasBefore = beforeRead;
    beforeRead = !beforeRead;
    // The held scan began with 49; concurrent new mints make its closing count 51.
    return { context: { slot: slot++ }, value: account(mode === 'changing' && wasBefore && inventoryReads === 0
      ? RULES.founderSpots - 1 : chainCount) };
  }
  if (method === 'getProgramAccounts') {
    inventoryReads += 1;
    const count = mode === 'changing' && inventoryReads === 1 ? RULES.founderSpots - 1
      : mode === 'incomplete' ? chainCount - 1 : chainCount;
    if (mode === 'changing' && inventoryReads === 1) { scanHeld?.(); await scanHold; }
    return { context: { slot: slot++ }, value: candidates.slice(0, count).map(c => ({
      pubkey: c.asset.toBase58(), account: { ...account(0), data: ['', 'base64'] },
    })) };
  }
  if (method === 'getSignaturesForAddress') {
    const candidate = candidates.find(c => c.asset.toBase58() === params[0]);
    if (!candidate) throw new Error('unexpected fixture asset');
    return [{ signature: candidate.signature, slot: candidate.slot, err: null, memo: null,
      blockTime: mintTime, confirmationStatus: 'finalized' }];
  }
  if (method === 'getTransaction') {
    const candidate = candidates.find(c => c.signature === params[0]);
    if (!candidate) throw new Error('unexpected fixture signature');
    return mintTransaction(candidate);
  }
  if (method === 'getBlock') return { blockhash: collection.toBase58(), previousBlockhash: collection.toBase58(),
    parentSlot: Number(params[0]) - 1, blockTime: mintTime,
    signatures: candidates.filter(c => c.slot === params[0]).map(c => c.signature) };
  throw new Error(`unexpected fixture method ${method}`);
}
async function seedCandidate(candidate: typeof candidates[number], proof: boolean) {
  await db.transaction(async tx => {
    const wallet = candidate.owner.toBase58(), assetId = candidate.asset.toBase58();
    await tx.insert(players).values({ wallet, name: `Mint player ${candidate.position}` });
    await tx.insert(sessions).values({ wallet, scope: 'full', expiresAt: new Date(Date.now() + 3_600_000) });
    await tx.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: new Date(), deedAssetId: assetId });
    if (proof) await tx.insert(playtestMintEvidence).values({ assetId, originalWallet: wallet,
      confirmedAt: new Date(mintTime * 1000), slot: String(candidate.slot), transactionIndex: 0,
      signature: candidate.signature, verifiedAt: new Date() });
  });
}
async function runWorker() {
  const job = await queue.add('reconcile', {});
  return job.waitUntilFinished(events, 25_000);
}
async function apiState(label: string) {
  const publicResponse = await app.inject('/playtest/campaigns');
  const adminResponse = await app.inject({ url: '/admin/playtest/campaigns', cookies: { [SESSION_COOKIE]: adminCookie } });
  expect(publicResponse.statusCode).toBe(200);
  expect(adminResponse.statusCode).toBe(200);
  expect(adminResponse.headers['cache-control']).toBe('private, no-store');
  const publicState = publicResponse.json().campaigns.find((c: { id: string }) => c.id === RULES.foundingId);
  const adminState = adminResponse.json().campaigns.find((c: { id: string }) => c.id === RULES.foundingId);
  observations.push({ label, public: publicState, admin: adminState });
  return { publicState, adminState };
}

beforeAll(async () => {
  await connection.create();
  await bootstrapEconomyAllocations(db);
  await ensurePlaytestCampaigns(db);
  await db.insert(players).values({ wallet: admin });
  const [session] = await db.insert(sessions).values({ wallet: admin, scope: 'full', expiresAt: new Date(Date.now() + 3_600_000) }).returning();
  adminCookie = await issueSessionJwt(config, admin, session!.id);
  app = await buildApp(config, db);
  await app.ready();
  rpcServer = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params: unknown[] };
      calls.push({ method: body.method, params: body.params, mode });
      if (mode === 'rate-limit-once') {
        mode = 'healthy'; response.writeHead(429); response.end('PRIVATE_RPC_BODY'); return;
      }
      if (mode === 'server-error-once' && body.method === 'getProgramAccounts') {
        mode = 'healthy'; response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
          error: { code: -32000, message: 'PRIVATE_RPC_BODY' } })); return;
      }
      const result = await rpcResult(body.method, body.params);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolve => rpcServer.listen(0, '127.0.0.1', resolve));
  const address = rpcServer.address();
  if (!address || typeof address === 'string') throw new Error('RPC fixture did not bind');
  rpcUrl = `http://127.0.0.1:${address.port}`;
  const redisConnection = { url: config.REDIS_URL };
  const queueName = `mint-inventory-e2e-${id}`;
  queue = new Queue(queueName, { connection: redisConnection });
  events = new QueueEvents(queueName, { connection: redisConnection });
  worker = new Worker(queueName, () => runMintEvidenceReconciliation(db,
    new Connection(rpcUrl, { commitment: 'finalized', disableRetryOnRateLimit: true }), collection.toBase58(),
    signal => makeDeedMintInventoryConnection(rpcUrl, signal)), { connection: redisConnection, concurrency: 1 });
  await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
});
afterAll(async () => {
  releaseScan?.();
  if (worker) await worker.close();
  if (events) await events.close();
  if (queue) { await queue.obliterate({ force: true }); await queue.close(); }
  if (rpcServer) await new Promise<void>((resolve, reject) => rpcServer.close(error => error ? reject(error) : resolve()));
  if (app) await app.close();
  await connection.close();
  const output = fileURLToPath(new URL('../../../.reports/inventory-e2e/', import.meta.url));
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/evidence.json`, JSON.stringify({ calls, observations }, null, 2));
});

it('recovers real RPC scans, blocks contradictory evidence and freezes the correct 50 across concurrent 50th/51st mints', async () => {
  for (const candidate of candidates.slice(0, RULES.founderSpots - 1)) await seedCandidate(candidate, true);
  mode = 'rate-limit-once';
  expect(await runWorker()).toMatchObject({ complete: true, assets: RULES.founderSpots - 1, diagnostics: { attempts: 2 } });
  const initial = await apiState('429-recovered');
  expect(initial.publicState.checkpoint).toMatchObject({ count: RULES.founderSpots - 1, frozen: false, available: true });
  expect(initial.adminState.mintVerification).toMatchObject({ complete: true, reason: null });
  expect(JSON.stringify(initial)).not.toContain('PRIVATE_RPC_BODY');

  // A transient asset-read server error must recover inside this worker job,
  // without publishing unavailable verification or combining partial scans.
  mode = 'server-error-once'; beforeRead = true; inventoryReads = 0;
  const serverErrorCalls = calls.length;
  expect(await runWorker()).toMatchObject({ complete: true, assets: RULES.founderSpots - 1,
    diagnostics: { attempts: 2 } });
  expect(calls.slice(serverErrorCalls).map(call => call.method)).toEqual([
    'getAccountInfo', 'getProgramAccounts', 'getAccountInfo', 'getProgramAccounts', 'getAccountInfo',
  ]);
  const recoveredServerError = await apiState('32000-recovered');
  expect(recoveredServerError.publicState.checkpoint).toMatchObject({
    count: RULES.founderSpots - 1, frozen: false, available: true,
  });
  expect(recoveredServerError.adminState.mintVerification).toMatchObject({ complete: true, reason: null });
  expect(JSON.stringify(recoveredServerError)).not.toContain('PRIVATE_RPC_BODY');

  mode = 'changing'; beforeRead = true; inventoryReads = 0;
  const held = new Promise<void>(resolve => { scanHeld = resolve; });
  scanHold = new Promise<void>(resolve => { releaseScan = resolve; });
  const pendingScan = runWorker();
  await held;
  await Promise.all(candidates.slice(RULES.founderSpots - 1).map(candidate => seedCandidate(candidate, false)));
  chainCount = candidates.length;
  // The old 49 receipt cannot authorize a freeze while new mint proofs and the
  // whole collection scan are still pending, even with competing snapshot jobs.
  await Promise.all([snapshotPlaytestFounders(db, [admin]), snapshotPlaytestFounders(db, [admin])]);
  expect(await db.select().from(playtestFounders)).toHaveLength(0);
  releaseScan!();
  expect(await pendingScan).toMatchObject({ complete: true, assets: candidates.length, diagnostics: { attempts: 2 } });
  expect(inventoryReads).toBe(2);
  const newProofs = await db.select().from(playtestMintEvidence).where(eq(playtestMintEvidence.slot, '200'));
  expect(newProofs).toHaveLength(2);
  expect(newProofs.find(p => p.assetId === candidates[RULES.founderSpots - 1]!.asset.toBase58()))
    .toMatchObject({ transactionIndex: 0, originalWallet: candidates[RULES.founderSpots - 1]!.owner.toBase58() });
  expect(newProofs.find(p => p.assetId === candidates[RULES.founderSpots]!.asset.toBase58()))
    .toMatchObject({ transactionIndex: 1, originalWallet: candidates[RULES.founderSpots]!.owner.toBase58() });
  const proofs = await db.select().from(playtestMintEvidence).orderBy(playtestMintEvidence.assetId);
  const changedCalls = calls.filter(c => c.mode === 'changing');
  expect(changedCalls.filter(c => c.method === 'getProgramAccounts')).toHaveLength(2);
  expect(changedCalls.filter(c => c.method === 'getAccountInfo')).toHaveLength(4);
  expect(changedCalls.filter(c => c.method === 'getTransaction')).toHaveLength(2);

  mode = 'incomplete'; beforeRead = true; inventoryReads = 0;
  await expect(runWorker()).rejects.toThrow('inventory_incomplete');
  expect(await db.select().from(playtestMintInventory)).toHaveLength(0);
  await Promise.all([snapshotPlaytestFounders(db, [admin]), snapshotPlaytestFounders(db, [admin])]);
  expect(await db.select().from(playtestFounders)).toHaveLength(0);
  expect((await db.select().from(playtestCampaigns).where(eq(playtestCampaigns.id, RULES.foundingId)))[0]!.snapshotAt).toBeNull();
  const unavailable = await apiState('stable-contradiction');
  expect(unavailable.publicState.checkpoint).toMatchObject({ count: null, frozen: false, available: false,
    verification: { status: 'unavailable', lastSuccessAt: expect.any(String), lastAttemptAt: expect.any(String) } });
  expect(unavailable.adminState.mintVerification).toMatchObject({ complete: false, reason: 'inventory_incomplete',
    diagnostics: { attempts: 1, beforeMinted: candidates.length, assetCount: candidates.length - 1 } });
  expect(await db.select().from(playtestMintEvidence).orderBy(playtestMintEvidence.assetId)).toEqual(proofs);

  mode = 'healthy'; beforeRead = true;
  expect(await runWorker()).toMatchObject({ complete: true, assets: candidates.length });
  await Promise.all([snapshotPlaytestFounders(db, [admin]), snapshotPlaytestFounders(db, [admin])]);
  const frozen = await db.select().from(playtestFounders).orderBy(playtestFounders.position);
  expect(frozen.map(f => f.wallet)).toEqual(candidates.slice(0, RULES.founderSpots).map(c => c.owner.toBase58()));
  expect(new Set(frozen.map(f => f.wallet)).size).toBe(RULES.founderSpots);
  expect(await db.select().from(playtestCampaignAudit).where(and(eq(playtestCampaignAudit.campaignId, RULES.foundingId),
    eq(playtestCampaignAudit.action, 'founder-snapshot')))).toHaveLength(1);
  await db.update(players).set({ name: 'Changed after freeze' }).where(eq(players.wallet, candidates[0]!.owner.toBase58()));
  await runWorker();
  await snapshotPlaytestFounders(db, [admin]);
  expect(await db.select().from(playtestFounders).orderBy(playtestFounders.position)).toEqual(frozen);
  const recovered = await apiState('recovered-and-frozen');
  expect(recovered.publicState.checkpoint).toMatchObject({ count: RULES.founderSpots, frozen: true, available: true,
    verification: { status: 'verified' } });
  expect(recovered.adminState.founders.map((f: { wallet: string }) => f.wallet)).toEqual(frozen.map(f => f.wallet));
  expect((await app.inject('/admin/playtest/campaigns')).statusCode).toBe(401);
  // Every authoritative read must retain finalized commitment and each resumed
  // whole scan must start at or above the previous closing context floor.
  for (const call of calls.filter(c => c.method !== 'getAccountInfo' || c.mode !== 'rate-limit-once')) {
    const options = call.params.at(-1) as { commitment?: string };
    expect(options.commitment).toBe('finalized');
  }
  const collectionReads = changedCalls.filter(c => c.method === 'getAccountInfo');
  expect((collectionReads[2]!.params[1] as { minContextSlot: number }).minContextSlot)
    .toBeGreaterThan((collectionReads[1]!.params[1] as { minContextSlot: number }).minContextSlot);
});
