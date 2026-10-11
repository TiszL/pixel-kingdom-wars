import { closeSync, constants as fsFlags, fstatSync, openSync, readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Queue, Worker, type RedisClient } from 'bullmq';
import type Redis from 'ioredis';
import { SKR_FAUCET } from '@shardkeep/shared';
import { SkrFaucetTransferError, type SkrFaucetRpc } from '@shardkeep/chain/devnet-skr-faucet-transfer';
import type { FastifyInstance } from 'fastify';
import type { DevnetOnlyOptions } from '../devnetOnlyLoader';
import { resolveSkrMint } from '../money/skrIdentity';
import { makeSkrFaucetService, processSkrFaucetGrant, type SkrFaucetPolicy } from './skrFaucet';
import { makeSkrFaucetStore, readSkrDeedEligibility, refreshSkrClaimDeed, type SkrSweepCursor } from './skrFaucetStore';
import { registerSkrFaucetRoutes } from './routes-skr-faucet';
import { createSkrReconcileGate, SKR_RECONCILE_CAS, skrRpcBudget } from './skrFaucetReconciliation';

const queueName = 'shardkeep-devnet-skr-faucet', scheduler = 'sched-devnet-skr-faucet';
/** Operational bounds, local to the isolated module (1c31b73b challenger). */
export const SKR_FAUCET_OPERATIONAL = Object.freeze({ rpcTimeoutMs: 6_000,
  retention: Object.freeze({ removeOnComplete: Object.freeze({ age: 6 * 3_600, limit: 50 }),
    removeOnFail: Object.freeze({ age: 86_400, limit: 25 }) }) });
const retention = SKR_FAUCET_OPERATIONAL.retention;
// Public role exclusions confirmed by D153.364 / Lantern195938f4. Never keys.
const reviewedAuthorities = [
  'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8',
  'AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv',
  '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
] as const;
function publicExclusions(options: DevnetOnlyOptions): string[] {
  const { config, addresses } = options;
  // Missing public identities hold the worker; private paths are never a fallback.
  const required = [config.HOT_WALLET_PUBKEY, config.DEVNET_SKR_FAUCET_ADMIN_PUBKEY,
    config.DEVNET_SKR_FAUCET_SOL_FAUCET_PUBKEY, config.DEVNET_SKR_FAUCET_DEED_OPERATIONS_PUBKEY,
    addresses?.treasuries?.liquidity, addresses?.treasuries?.dev, addresses?.treasuries?.ops, addresses?.skrMint];
  const optional = [addresses?.keepMint, addresses?.keepMintV4, addresses?.keepMintAuthorities?.mintAuthority,
    addresses?.keepMintAuthorities?.freezeAuthority];
  return [...reviewedAuthorities, ...required, ...optional.filter((value): value is string => !!value)].map(value => {
    if (!value) throw new Error('missing public identity');
    const key = new PublicKey(value);
    if (key.equals(PublicKey.default) || key.toBase58() !== value) throw new Error('invalid public identity');
    return value;
  });
}
function policy(options: DevnetOnlyOptions): SkrFaucetPolicy {
  return { enabled: options.config.DEVNET_SKR_FAUCET_ENABLED === 'true', cluster: options.config.SOLANA_CLUSTER,
    identity: resolveSkrMint(options.addresses), authority: options.config.DEVNET_SKR_FAUCET_AUTHORITY ?? null,
    floorSkr: SKR_FAUCET.devnet.treasuryFloorSkr, dailyBudgetSkr: SKR_FAUCET.devnet.dailyBudgetSkr };
}
function connection(url: string): SkrFaucetRpc {
  return new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: async (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(SKR_FAUCET_OPERATIONAL.rpcTimeoutMs) }) });
}
/** Only registerDevnetOnlyJobs calls this. API route registration never opens a key. */
function workerKey(path: string): Keypair {
  const fd = openSync(path, fsFlags.O_RDONLY | fsFlags.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 4096) throw new Error('invalid key file');
    const values: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!Array.isArray(values) || values.length !== 64 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('invalid key bytes');
    return Keypair.fromSecretKey(Uint8Array.from(values));
  } finally { closeSync(fd); }
}
/** Pure identity predicate exposed for startup fixtures, never key loading. */
export function skrWorkerAuthorityAllowed(authority: string, configured: string | undefined, otherAuthorities: readonly string[]): boolean {
  return authority === configured && !otherAuthorities.includes(authority);
}
export async function registerDevnetOnly(app: FastifyInstance, options?: DevnetOnlyOptions): Promise<void> {
  if (!options) throw new Error('devnet-only route context missing');
  if (options.config.SOLANA_CLUSTER !== 'devnet' || options.config.DEVNET_SKR_FAUCET_ENABLED !== 'true') return;
  // N-045 QA chain-lane switch (devnet only, as above; loadConfig refuses it under NODE_ENV=production). Unset = D153.290.
  const deedlessOk = options.config.DEVNET_SKR_FAUCET_DEEDLESS_OK === 'true';
  const selected = policy(options), store = makeSkrFaucetStore(options.db, { deedlessOk }), rpc = connection(options.config.SOLANA_RPC_URL);
  const queue = new Queue(queueName, { connection: { url: options.config.REDIS_URL }, defaultJobOptions: retention });
  app.addHook('onClose', async () => { await queue.close(); });
  const service = makeSkrFaucetService(selected, store, rpc, {
    eligibility: (wallet, baseId, at) => readSkrDeedEligibility(options.db, wallet, baseId, at, deedlessOk),
    refreshDeed: (wallet, baseId) => refreshSkrClaimDeed(options.db, wallet, baseId, options.deedReader ?? null, options.deedCollection ?? null, () => new Date(), deedlessOk),
    enqueue: async (grantId, attemptId) => { await queue.add('grant', { grantId }, { jobId: `attempt-${attemptId}` }); },
  });
  await service.prime(); // Status itself never reads chain state.
  registerSkrFaucetRoutes(app, service);
}
export async function registerDevnetOnlyJobs(options?: DevnetOnlyOptions): Promise<{ close(): Promise<void> } | null> {
  if (!options) throw new Error('devnet-only job context missing');
  if (options.config.SOLANA_CLUSTER !== 'devnet' || options.config.DEVNET_SKR_FAUCET_ENABLED !== 'true') return null;
  const selected = policy(options);
  let signer: Keypair;
  try {
    if (!selected.identity || !selected.authority || selected.floorSkr === null || selected.dailyBudgetSkr === null
      || !options.config.DEVNET_SKR_FAUCET_KEYPAIR_PATH?.trim()) throw new Error('unconfigured');
    const others = publicExclusions(options);
    if (!skrWorkerAuthorityAllowed(selected.authority, selected.authority, others)) throw new Error('excluded authority');
    signer = workerKey(options.config.DEVNET_SKR_FAUCET_KEYPAIR_PATH);
    if (!skrWorkerAuthorityAllowed(signer.publicKey.toBase58(), selected.authority, others)) throw new Error('authority mismatch');
  } catch {
    console.warn('[devnet-skr-faucet] explicitly enabled but activation prerequisites are unavailable; no worker started');
    return null;
  }
  const store = makeSkrFaucetStore(options.db), rpc = connection(options.config.SOLANA_RPC_URL);
  const redis = { url: options.config.REDIS_URL };
  const queue = new Queue(queueName, { connection: redis, defaultJobOptions: retention });
  let worker: Worker | undefined, cursor: SkrSweepCursor | undefined;
  try {
    await queue.setGlobalConcurrency(1);
    // bullmq 5.78's IRedisClient (`RedisClient`) declares only the commands bullmq itself
    // uses, so `eval` is missing from the type. At runtime this repo never sets
    // RedisConnection.clientFactory, so `queue.client` is createIORedisClient's Proxy over a
    // real ioredis instance, and that Proxy forwards undeclared members (`eval`) to ioredis.
    // Widen by exactly ioredis' own `eval` signature (no `any`); emitted JS is unchanged.
    const client = await queue.client as RedisClient & Pick<Redis, 'eval'>;
    const gate = createSkrReconcileGate({ get: (key) => client.get(key),
      compareAndSet: async (key, expected, next) => Number(await client.eval(SKR_RECONCILE_CAS, 1, key,
        expected === null ? 'missing' : 'value', expected ?? '', next)) === 1 });
    worker = new Worker(queueName, async (job) => {
      const context = { gate, budget: skrRpcBudget() }; // one budget shared across the whole sweep/job
      if (job.name === 'grant' && typeof job.data?.grantId === 'string'
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.data.grantId)) {
        await processSkrFaucetGrant(selected, store, rpc, signer, job.data.grantId, undefined, context); return;
      }
      let rows = await store.pending(SKR_FAUCET.devnet.maxGrantsPerSweep, cursor);
      if (rows.length === 0 && cursor) { cursor = undefined; rows = await store.pending(SKR_FAUCET.devnet.maxGrantsPerSweep); }
      for (const row of rows) {
        if (!context.budget.available()) break; // resume after the last processed cursor next sweep
        try { await processSkrFaucetGrant(selected, store, rpc, signer, row.id, undefined, context); }
        catch (error) {
          if (error instanceof SkrFaucetTransferError && error.code === 'GENESIS') throw error;
          console.warn('[devnet-skr-faucet] retained grant awaits reconciliation');
        }
        finally { cursor = row; }
      }
    }, { connection: redis, concurrency: 1 });
    worker.on('failed', () => console.warn('[devnet-skr-faucet] retained job awaits reconciliation'));
    await queue.upsertJobScheduler(scheduler, { every: SKR_FAUCET.devnet.pollMs }, { name: 'sweep' });
  } catch (error) {
    try { await worker?.close(); } finally { await queue.close(); }
    throw error;
  }
  return { close: async () => { try { await worker!.close(); } finally { await queue.close(); } } };
}
