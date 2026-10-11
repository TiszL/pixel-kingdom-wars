/** SA-3 application lifecycle and finite operator CLI. Importing starts no
 * worker or timer. A write CLI invocation only enqueues into this same queue;
 * it never creates a second signer/runner. Activation remains an external gate.
 * Pending state belongs to the held job/core instance. Cold restart recovers
 * chain bitmaps, not an exactly-once fee guarantee across lost process memory. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Queue, Worker } from 'bullmq';
import { loadAddresses } from '@shardkeep/chain';
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { loadConfig, type Config } from '../config';
import { charterIssuerAuthToken, createCharterPolicyIssuerClient, type CharterPolicyIssuerClientOptions } from '../charterPolicyIssuerClient';
import { createSeekerAuctionRuntime, type SeekerAuctionRegistry } from './auctionRuntime';
import { createSeekerAuctionCrank, type SeekerAuctionCrankEvent, type SeekerAuctionCrankPendingAttempt,
  type SeekerAuctionCrankResult } from './auctionCrank';

const R = PHASE_E_SEEKER_AUCTION_RUNTIME;
const QUEUE = 'seeker-auction-crank', SCHEDULER = 'sched-seeker-auction-crank';
// Secret-file work limits are transport bounds, not economy tuning.
const KEY_FILE_BYTES = 8192, TOKEN_FILE_BYTES = 1024;
const USAGE = 'usage: seeker-auction-crank (--dry-run | --execute) --once';
function jobOptions() {
  return { attempts: 1,
    removeOnComplete: { age: R.completedJobAgeSec, limit: R.completedJobPurgeMax },
    removeOnFail: { age: R.failedJobAgeSec, limit: R.failedJobPurgeMax } };
}
function need(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Seeker auction crank unavailable: ${label}`);
}
function absolute(file: string): void { need(typeof file === 'string' && isAbsolute(file) && !file.includes('\0'), 'absolute dedicated file path'); }
function publicKey(text: string | undefined): string {
  need(typeof text === 'string', 'public key'); const value = new PublicKey(text);
  need(value.toBase58() === text && !value.equals(PublicKey.default) && PublicKey.isOnCurve(value.toBytes()), 'canonical signing identity');
  return text;
}
interface SecretStat {
  readonly mode: number; readonly uid: number; readonly nlink: number; readonly size: number;
  readonly mtimeMs: number; readonly ctimeMs: number; isFile(): boolean;
}
interface SecretHandle {
  stat(): Promise<SecretStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface SeekerAuctionSecretFileIo {
  readonly currentUid: () => number | undefined;
  readonly open: (file: string, flags: number) => Promise<SecretHandle>;
}
const SECRET_IO: SeekerAuctionSecretFileIo = { currentUid: () => process.getuid?.(), open };
async function secretFile(file: string, bound: number, io: SeekerAuctionSecretFileIo): Promise<Buffer> {
  absolute(file); const bytes = Buffer.alloc(bound + 1); let handle: SecretHandle | undefined;
  try {
    const uid = io.currentUid(); need(Number.isSafeInteger(uid) && uid! >= 0, 'owner identity unavailable');
    handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    need(before.isFile() && (before.mode & 0o7777) === 0o600 && before.uid === uid && before.nlink === 1
      && Number.isSafeInteger(before.size) && before.size >= 0 && before.size <= bound, 'private regular single-link file');
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      need(Number.isSafeInteger(read.bytesRead) && read.bytesRead >= 0 && read.bytesRead <= bytes.length - length, 'bounded descriptor read');
      if (read.bytesRead === 0) break; length += read.bytesRead;
    }
    const after = await handle.stat();
    need(length <= bound && length === before.size && after.isFile() && after.uid === before.uid
      && after.mode === before.mode && after.nlink === 1 && after.size === before.size
      && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, 'secret file changed during read');
    return Buffer.from(bytes.subarray(0, length));
  } catch { throw new Error('SEEKER_AUCTION_CRANK_SECRET_FILE'); }
  finally { bytes.fill(0); await handle?.close(); }
}
export async function loadSeekerAuctionCrankKey(file: string, expectedPublicKey: string,
  io: SeekerAuctionSecretFileIo = SECRET_IO): Promise<Keypair> {
  let bytes: Buffer | undefined, secret: Uint8Array | undefined, raw: unknown;
  try {
    const expected = publicKey(expectedPublicKey); bytes = await secretFile(file, KEY_FILE_BYTES, io);
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    need(Array.isArray(raw) && raw.length === 64 && raw.every(value => Number.isInteger(value) && value >= 0 && value <= 255), '64-byte key array');
    secret = Uint8Array.from(raw); const owned = Uint8Array.from(secret);
    try {
      const signer = Keypair.fromSecretKey(owned); need(signer.publicKey.toBase58() === expected, 'dedicated crank key mismatch'); return signer;
    } catch { owned.fill(0); throw new Error('SEEKER_AUCTION_CRANK_SECRET_FILE'); }
  } catch { throw new Error('SEEKER_AUCTION_CRANK_SECRET_FILE'); }
  finally { bytes?.fill(0); secret?.fill(0); if (Array.isArray(raw)) raw.fill(0); }
}
export async function loadSeekerAuctionCrankToken(file: string, io: SeekerAuctionSecretFileIo = SECRET_IO): Promise<string> {
  let bytes: Buffer | undefined;
  try { bytes = await secretFile(file, TOKEN_FILE_BYTES, io);
    return charterIssuerAuthToken(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, ''));
  } catch { throw new Error('SEEKER_AUCTION_CRANK_SECRET_FILE'); }
  finally { bytes?.fill(0); }
}

type Crank = ReturnType<typeof createSeekerAuctionCrank>;
type Runtime = NonNullable<ReturnType<typeof createSeekerAuctionRuntime>>;
type Issuer = Pick<ReturnType<typeof createCharterPolicyIssuerClient>, 'issueOnce' | 'close'>;
interface QueuePort {
  setGlobalConcurrency(value: number): Promise<unknown>;
  upsertJobScheduler(id: string, repeat: { every: number }, job: { name: string; opts?: { attempts: number } }): Promise<unknown>;
  close(): Promise<void>;
}
interface WorkerPort { pause(doNotWaitActive?: boolean): Promise<void>; close(): Promise<void>; }
export type SeekerAuctionWorkerEvent = SeekerAuctionCrankEvent
  | Readonly<{ type: 'poll-error'; signature: string }>
  | Readonly<{ type: 'closing'; pending: SeekerAuctionCrankPendingAttempt | null }>;
export interface SeekerAuctionCrankLifecycleDeps {
  readonly createRuntime: typeof createSeekerAuctionRuntime;
  readonly loadKey: (file: string, expectedPublicKey: string) => Promise<Keypair>;
  readonly loadToken: (file: string) => Promise<string>;
  readonly createIssuer: (options: CharterPolicyIssuerClientOptions) => Issuer;
  readonly createCrank: typeof createSeekerAuctionCrank;
  readonly createQueue: (name: string, options: { connection: { url: string }; defaultJobOptions: { attempts: number } }) => QueuePort;
  readonly createWorker: (name: string, run: (job: { name: string }) => Promise<unknown>, options: { connection: { url: string }; concurrency: number }) => WorkerPort;
  readonly waitForNextPoll: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onEvent: (event: SeekerAuctionWorkerEvent) => void;
}
const DEFAULT_DEPS: SeekerAuctionCrankLifecycleDeps = {
  createRuntime: createSeekerAuctionRuntime, loadKey: loadSeekerAuctionCrankKey, loadToken: loadSeekerAuctionCrankToken,
  createIssuer: createCharterPolicyIssuerClient, createCrank: createSeekerAuctionCrank,
  createQueue: (name, options) => {
    const queue = new Queue(name, options);
    queue.on('error', () => console.error('SEEKER_AUCTION_CRANK_QUEUE_UNAVAILABLE')); return queue;
  },
  createWorker: (name, run, options) => {
    const worker = new Worker(name, run, options);
    worker.on('error', () => console.error('SEEKER_AUCTION_CRANK_WORKER_UNAVAILABLE')); return worker;
  },
  waitForNextPoll: async (ms, signal) => { await delay(ms, undefined, { signal }); },
  onEvent: event => console.info(JSON.stringify({ component: 'seeker-auction-crank', ...event })),
};
function emit(deps: SeekerAuctionCrankLifecycleDeps, event: SeekerAuctionWorkerEvent): void {
  try { void Promise.resolve(deps.onEvent(Object.freeze(event))).catch(() => {}); } catch { /* Observers cannot drop pending state. */ }
}
function writeConfiguration(config: Config): void {
  need(config.SEEKER_AUCTION_CRANK_ENABLED === 'true', 'write flag disabled'); publicKey(config.SEEKER_AUCTION_CRANK_PUBKEY);
  need(config.SEEKER_AUCTION_CRANK_KEYPAIR_FILE, 'dedicated key file'); absolute(config.SEEKER_AUCTION_CRANK_KEYPAIR_FILE);
  need(config.CHARTER_POLICY_ISSUER_URL && config.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE, 'dedicated issuer settings');
  publicKey(config.CHARTER_POLICY_ISSUER_PUBLIC_KEY); absolute(config.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE);
  need(config.SEEKER_AUCTION_CRANK_KEYPAIR_FILE !== config.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE, 'separate key/token files');
  const url = new URL(config.CHARTER_POLICY_ISSUER_URL), loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  need(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
    && (url.protocol === 'https:' || url.protocol === 'http:' && config.CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP === 'true'
      && (loopback || url.origin === 'http://charter-issuer:3004')), 'dedicated issuer endpoint');
}
export interface SeekerAuctionCrankSession { readonly runOnce: Crank['runOnce']; readonly close: () => Promise<void>; }
export async function openSeekerAuctionCrankDryRun(config: Config, registry: SeekerAuctionRegistry | null,
  deps: SeekerAuctionCrankLifecycleDeps = DEFAULT_DEPS): Promise<SeekerAuctionCrankSession> {
  const crankPublicKey = publicKey(config.SEEKER_AUCTION_CRANK_PUBKEY);
  // Preview needs public pins only. It never acquires a write capability, even
  // when the operator's environment also contains enabled worker settings.
  const runtime = deps.createRuntime({ ...config, SEEKER_AUCTION_CRANK_ENABLED: 'false' }, registry);
  need(runtime, 'reviewed read source unavailable'); const stop = new AbortController(), active = new Set<Promise<SeekerAuctionCrankResult>>();
  let closing: Promise<void> | undefined;
  try {
    const crank = deps.createCrank({ source: runtime.source, crankPublicKey, dryRun: true,
      loadSigner: async () => { throw new Error('SEEKER_AUCTION_CRANK_READ_ONLY'); },
      issuer: { issueOnce: async () => { throw new Error('SEEKER_AUCTION_CRANK_READ_ONLY'); } },
      nextRequestId: () => { throw new Error('SEEKER_AUCTION_CRANK_READ_ONLY'); }, onEvent: event => emit(deps, event) });
    return Object.freeze({ runOnce: async (signal: AbortSignal) => {
      stop.signal.throwIfAborted(); const run = crank.runOnce(AbortSignal.any([signal, stop.signal])); active.add(run);
      void run.then(() => active.delete(run), () => active.delete(run)); return run;
    }, close: () => closing ??= (async () => { stop.abort(); await Promise.allSettled([...active]); runtime.close(); })() });
  } catch (error) { stop.abort(); runtime.close(); throw error; }
}

export async function startSeekerAuctionCrankWorker(config: Config, registry: SeekerAuctionRegistry | null,
  deps: SeekerAuctionCrankLifecycleDeps = DEFAULT_DEPS): Promise<{ close: () => Promise<void> } | null> {
  if (config.SEEKER_AUCTION_CRANK_ENABLED !== 'true') return null;
  writeConfiguration(config); const stop = new AbortController();
  let runtime: Runtime | undefined, issuer: Issuer | undefined, crank: Crank | undefined,
    queue: QueuePort | undefined, worker: WorkerPort | undefined, keyBytes: Uint8Array | undefined;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<SeekerAuctionCrankResult>>();
  const close = () => closing ??= (async () => {
    const failures: unknown[] = [];
    const cleanup = async (operation: () => unknown | Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
    await cleanup(() => worker?.pause(true));
    emit(deps, { type: 'closing', pending: crank?.pendingAttempt() ?? null }); stop.abort();
    await Promise.allSettled([...active]); await cleanup(() => worker?.close());
    // The fixed scheduler belongs to the shared queue, not this replica. Keep
    // it on shutdown/startup unwind so another replica keeps receiving work.
    // Never drain or globally pause waiting jobs owned by other processes.
    await cleanup(() => issuer?.close()); await cleanup(() => runtime?.close()); keyBytes?.fill(0);
    await cleanup(() => queue?.close()); if (failures.length) throw new Error('SEEKER_AUCTION_CRANK_CLEANUP_FAILED');
  })();
  try {
    runtime = deps.createRuntime(config, registry) ?? undefined; need(runtime, 'reviewed worker source unavailable');
    const crankPublicKey = publicKey(config.SEEKER_AUCTION_CRANK_PUBKEY);
    const validated = await deps.loadKey(config.SEEKER_AUCTION_CRANK_KEYPAIR_FILE!, crankPublicKey);
    need(validated.publicKey.toBase58() === crankPublicKey, 'dedicated crank key mismatch');
    // This instance owns only its detached bytes. Never wipe an injected
    // loader's key or return this persistent buffer to the per-pass signer.
    keyBytes = Uint8Array.from(validated.secretKey);
    const authToken = await deps.loadToken(config.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE!);
    issuer = deps.createIssuer({ endpoint: config.CHARTER_POLICY_ISSUER_URL!, currentPublicKey: config.CHARTER_POLICY_ISSUER_PUBLIC_KEY!,
      authToken, allowPrivateHttp: config.CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP === 'true' });
    crank = deps.createCrank({ source: runtime.source, crankPublicKey, issuerPublicKey: config.CHARTER_POLICY_ISSUER_PUBLIC_KEY!, dryRun: false,
      loadSigner: async signal => { signal.throwIfAborted(); stop.signal.throwIfAborted(); return Keypair.fromSecretKey(Uint8Array.from(keyBytes!)); },
      issuer, nextRequestId: randomUUID, onEvent: event => emit(deps, event) });
    const ownedCrank = crank;
    async function processJob(): Promise<SeekerAuctionCrankResult> {
      for (;;) {
        stop.signal.throwIfAborted(); let result: SeekerAuctionCrankResult;
        try { result = await ownedCrank.runOnce(stop.signal); }
        catch {
          stop.signal.throwIfAborted(); const pending = ownedCrank.pendingAttempt();
          if (!pending) throw new Error('SEEKER_AUCTION_CRANK_PASS_FAILED');
          emit(deps, { type: 'poll-error', signature: pending.signature });
          await deps.waitForNextPoll(R.crankPollMs, stop.signal); continue;
        }
        stop.signal.throwIfAborted();
        if (result.status !== 'pending' && result.status !== 'submitted' && ownedCrank.pendingAttempt() === null) {
          if (result.status === 'held' && result.alarms.some(alarm => alarm.code === 'ISSUER_REFUSED')) {
            // Retain this job's global lease during the refusal cooldown.
            await deps.waitForNextPoll(R.issuerRefusalBackoffMs, stop.signal);
            stop.signal.throwIfAborted();
          }
          return result;
        }
        // Holding this same BullMQ job keeps the global concurrency slot and
        // lock renewal while the same core resolves its locally signed wire.
        await deps.waitForNextPoll(R.crankPollMs, stop.signal);
      }
    }
    const connection = { url: config.REDIS_URL };
    queue = deps.createQueue(QUEUE, { connection, defaultJobOptions: jobOptions() });
    await queue.setGlobalConcurrency(1);
    await queue.upsertJobScheduler(SCHEDULER, { every: R.crankPollMs }, { name: QUEUE, opts: jobOptions() });
    worker = deps.createWorker(QUEUE, async job => {
      need(job.name === QUEUE, 'unrelated queue job'); stop.signal.throwIfAborted();
      const run = processJob(); active.add(run); void run.then(() => active.delete(run), () => active.delete(run)); return run;
    }, { connection, concurrency: 1 });
    return Object.freeze({ close });
  } catch (error) { await close(); throw error; }
}

export interface SeekerAuctionCrankCliIo {
  readonly loadRegistry: (config: Config) => Promise<SeekerAuctionRegistry | null>;
  readonly openDryRun: (config: Config, registry: SeekerAuctionRegistry) => Promise<SeekerAuctionCrankSession>;
  readonly enqueueOnce: (config: Config, registry: SeekerAuctionRegistry) => Promise<{ jobId: string }>;
  readonly print: (line: string) => void; readonly printError: (line: string) => void;
}
const DEFAULT_IO: SeekerAuctionCrankCliIo = {
  loadRegistry: async config => loadAddresses(config.REPO_ROOT ?? resolve(process.cwd(), '..', '..'), config.SOLANA_CLUSTER),
  openDryRun: openSeekerAuctionCrankDryRun,
  enqueueOnce: async config => {
    const queue = new Queue(QUEUE, { connection: { url: config.REDIS_URL }, defaultJobOptions: jobOptions() });
    queue.on('error', () => console.error('SEEKER_AUCTION_CRANK_QUEUE_UNAVAILABLE'));
    try { const jobId = `seeker-auction-once-${randomUUID()}`; await queue.add(QUEUE, {}, { ...jobOptions(), jobId }); return { jobId }; }
    finally { await queue.close(); }
  },
  print: line => console.log(line), printError: line => console.error(line),
};
/** Exit 0 means previewed or queued; it never asserts a transaction finalized.
 * Exit 1 is held/unavailable, and 2 is an invalid finite invocation. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: SeekerAuctionCrankCliIo = DEFAULT_IO): Promise<number> {
  let dryRun: boolean;
  try {
    const args = parseArgs({ args: argv, strict: true, allowPositionals: false, tokens: true,
      options: { 'dry-run': { type: 'boolean' }, execute: { type: 'boolean' }, once: { type: 'boolean' } } });
    const names = args.tokens.filter(token => token.kind === 'option').map(token => token.name);
    need(args.values.once === true && args.values['dry-run'] !== args.values.execute && names.length === 2
      && new Set(names).size === 2, 'explicit finite mode'); dryRun = args.values['dry-run'] === true;
  } catch { io.printError(USAGE); return 2; }
  let session: SeekerAuctionCrankSession | undefined;
  try {
    const config = loadConfig(env); if (!dryRun) writeConfiguration(config); publicKey(config.SEEKER_AUCTION_CRANK_PUBKEY);
    const registry = await io.loadRegistry(config); need(registry, 'selected registry unavailable');
    const check = createSeekerAuctionRuntime(dryRun ? { ...config, SEEKER_AUCTION_CRANK_ENABLED: 'false' } : config, registry);
    need(check, 'reviewed source unavailable'); check.close();
    if (dryRun) {
      session = await io.openDryRun(config, registry); const result = await session.runOnce(new AbortController().signal);
      io.print(JSON.stringify({ mode: 'dry-run', result }));
    } else {
      const result = await io.enqueueOnce(config, registry); io.print(JSON.stringify({ mode: 'execute', status: 'queued', jobId: result.jobId }));
    }
    return 0;
  } catch { io.printError('SEEKER_AUCTION_CRANK_REFUSED: command held or unavailable'); return 1; }
  finally { try { await session?.close(); } catch { io.printError('SEEKER_AUCTION_CRANK_CLEANUP_FAILED'); return 1; } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
