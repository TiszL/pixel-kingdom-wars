/** Unpaid accepted obligations only. ENABLE_WORKERS owns startup; no mutable
 * source flag, current owner, active slot, RPC or term provider is consulted. */
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis, { type RedisOptions } from 'ioredis';
import { z } from 'zod';
import { createDb, type Db, type DatabaseSocketOptions } from '../db/client';
import { runStarterExpeditionReturns, type StarterExpeditionWorkerOptions } from './starterExpeditionWorker';

export const STARTER_RETURN_QUEUE = 'shardkeep-starter-expedition-returns';
export const STARTER_RETURN_SCHEDULER = 'sched-starter-expedition-returns';
export const STARTER_RETURN_EVERY_MS = 30_000;
export const STARTER_RETURN_BASE_LIMIT = 32;
const JOB = 'starter-expedition-returns';
const IO_MS = 3_000;
const WORKER_COMMAND_MS = 15_000;
const WORKER_SOCKET_MS = 12_000;
const STARTUP_MS = 15_000;
export const STARTER_RETURN_PAGE_DEADLINE_MS = 60_000;
const TIMEOUTS = { lockMs: 1_000, statementMs: 5_000, idleMs: 6_000 };
const RETENTION = { removeOnComplete: { age: 86_400, limit: 50 }, removeOnFail: { age: 172_800, limit: 25 } };
const cursorSchema = z.strictObject({ revision: z.uuid(), afterBaseId: z.uuid().nullable() });
export interface StarterReturnCursor { raw: string | null; afterBaseId: string | null }
const CAS = `
local current = redis.call('GET', KEYS[1])
if (not current and ARGV[1] == '') or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2]); return 1
end
return 0`;

/** BullMQ duplicates the worker client for blocking reads. Retain that public
 * duplicate() result so startup cleanup can join both initializations before
 * BullMQ removes its forwarding error listeners. */
class StarterReturnWorkerRedis extends Redis {
  readonly duplicates: Redis[] = [];
  override duplicate(options?: Partial<RedisOptions>): Redis {
    const client = super.duplicate(options); this.duplicates.push(client); return client;
  }
}
async function disconnectRedis(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  const ended = new Promise<void>(resolve => { client.once('end', resolve); });
  // ioredis disconnect() during its reconnect delay clears the timer but ends
  // an already-closed stream, so no terminal event follows. Start then cancel
  // its public connect() synchronously: StandaloneConnector observes cancellation
  // on nextTick BEFORE opening a new socket and completes the pending end event.
  const cancelled = client.status === 'reconnecting' || client.status === 'close' ? client.connect().catch(() => undefined) : undefined;
  client.disconnect();
  await Promise.all([ended, cancelled]);
}

/** Separate fail-fast connection: a disconnected Redis must not queue a stale
 * cursor write or hold SQL/worker shutdown. Full-value CAS fences stale leases. */
export class StarterExpeditionCursor {
  private readonly redis: Redis;
  readonly key: string;
  constructor(redisUrl: string, queueName = STARTER_RETURN_QUEUE) {
    this.key = `bull:${queueName}:scan-cursor`;
    this.redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, connectTimeout: IO_MS, disconnectTimeout: 100,
      commandTimeout: IO_MS, maxRetriesPerRequest: 0, retryStrategy: () => null });
    this.redis.on('error', () => undefined);
  }
  async connect(): Promise<void> {
    if (this.redis.status === 'ready') return;
    // TCP connect timeout alone does not cover an established INFO/ready check.
    const timer = setTimeout(() => this.redis.disconnect(), IO_MS);
    try { await this.redis.connect(); }
    finally { clearTimeout(timer); }
  }
  async read(): Promise<StarterReturnCursor> {
    // A later scheduled pass can recover an ended cursor connection. Each
    // attempt remains bounded and never queues offline commands.
    if (this.redis.status === 'end' || this.redis.status === 'wait') await this.connect();
    const raw = await this.redis.get(this.key);
    if (raw === null) return { raw, afterBaseId: null };
    try { return { raw, afterBaseId: cursorSchema.parse(JSON.parse(raw)).afterBaseId }; }
    catch { throw new Error('Starter return cursor is invalid; saved progress was preserved'); }
  }
  async advance(prior: StarterReturnCursor, afterBaseId: string | null): Promise<boolean> {
    const next = cursorSchema.parse({ revision: randomUUID(), afterBaseId });
    return await this.redis.eval(CAS, 1, this.key, prior.raw ?? '', JSON.stringify(next)) === 1;
  }
  close(): void { this.redis.disconnect(); }
}

/** Exported processor is also exercised against real isolated SQL/Redis. No
 * private base IDs, term/home evidence or raw exceptions cross BullMQ's boundary. */
export async function processStarterExpeditionReturnPage(db: Db, cursor: StarterExpeditionCursor,
  options: Pick<StarterExpeditionWorkerOptions, 'clock' | 'timeouts'> = { clock: () => new Date() },
): Promise<{ processed: number; failed: number }> {
  try {
    const prior = await cursor.read();
    const result = await runStarterExpeditionReturns(db, { limit: STARTER_RETURN_BASE_LIMIT, clock: options.clock,
      timeouts: options.timeouts ?? TIMEOUTS, ...(prior.afterBaseId === null ? {} : { afterBaseId: prior.afterBaseId }) });
    // A lease can stall and be reassigned. Losing CAS is harmless: a newer pass
    // owns progress, while original SQL receipt uniqueness already fences credit.
    await cursor.advance(prior, result.nextAfterBaseId);
    return { processed: result.processedBaseIds.length, failed: result.failures.length };
  } catch {
    throw new Error('Starter expedition return scan failed; obligations remain pending');
  }
}

/** A connected-but-silent PostgreSQL socket is not bounded by server settings.
 * This deadline terminates ONLY the page's dedicated resources, then joins the
 * actual transaction rejection/rollback. A lost commit acknowledgement is safe:
 * the original return receipt makes the next SQL pass idempotent. */
export async function runOwnedStarterExpeditionReturnPage(databaseUrl: string, cursor: StarterExpeditionCursor,
  options: Pick<StarterExpeditionWorkerOptions, 'clock' | 'timeouts'> & { deadlineMs?: number } = { clock: () => new Date() },
) {
  const deadline = options.deadlineMs ?? STARTER_RETURN_PAGE_DEADLINE_MS;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > STARTER_RETURN_PAGE_DEADLINE_MS) throw new Error('Invalid starter return page deadline');
  const sockets = new Set<Socket>(); let endpoint = 0, destroyed = false;
  const socketFactory = (parsed: DatabaseSocketOptions) => new Promise<Socket>((resolve, reject) => {
    if (destroyed) { reject(new Error('Starter return database transport is closed')); return; }
    const socket = new Socket(); sockets.add(socket);
    const index = endpoint++ % parsed.host.length;
    const host = parsed.host[index]!, port = parsed.port[index]!;
    // postgres.js secure() uses this hostname as SNI. Do not replace its TLS,
    // credential, URL, Unix socket or multihost parsing/negotiation behavior.
    Object.assign(socket, { host, port, ssl: parsed.ssl });
    let connected = false;
    const connecting = setTimeout(() => socket.destroy(new Error('Starter return database connect timed out')), 5_000);
    socket.once('error', reject);
    socket.once('close', () => { clearTimeout(connecting); if (!connected) reject(new Error('Starter return database socket closed')); });
    socket.once('connect', () => {
      clearTimeout(connecting); connected = true;
      if (destroyed) { socket.destroy(); reject(new Error('Starter return database transport closed')); }
      else resolve(socket);
    });
    if (parsed.path) socket.connect(parsed.path); else socket.connect(port, host);
  });
  const destroySockets = async () => {
    destroyed = true;
    await Promise.all([...sockets].map(socket => new Promise<void>(resolve => {
      if (socket.closed) { resolve(); return; }
      // Attach at cleanup: the driver's TLS upgrade removes earlier listeners.
      socket.once('close', () => resolve()); socket.destroy();
    })));
  };
  const pool = createDb(databaseUrl, { max: 1, connectTimeoutSeconds: 5, socketFactory });
  let expired = false, termination: Promise<void> | undefined;
  const timer = setTimeout(() => {
    expired = true;
    termination = Promise.all([pool.sql.end({ timeout: 0 }), destroySockets()]).then(() => undefined);
    void termination.catch(() => undefined);
  }, deadline);
  try {
    const result = await processStarterExpeditionReturnPage(pool.db, cursor, options);
    if (expired) throw new Error('Starter expedition return scan deadline expired; obligations remain pending');
    return result;
  } finally {
    try { await (termination ?? pool.sql.end({ timeout: 1 })); }
    finally { await destroySockets(); clearTimeout(timer); }
  }
}

/** One private max-one SQL pool per owned page prevents API or stale executor
 * pool saturation. Redis reconnects may recover an outage; startup itself has a
 * resource-owning deadline and shutdown joins SQL before closing BullMQ. */
export async function startStarterExpeditionScheduler(databaseUrl: string, redisUrl: string,
  options: { queueName?: string; clock?: () => Date; timeouts?: StarterExpeditionWorkerOptions['timeouts']; deadlineMs?: number } = {},
) {
  const queueName = options.queueName ?? STARTER_RETURN_QUEUE;
  const cursor = new StarterExpeditionCursor(redisUrl, queueName);
  const connection = { connectTimeout: IO_MS, disconnectTimeout: 100, enableOfflineQueue: false, retryStrategy: (attempt: number) => Math.min(attempt * 250, 1_000) };
  // Explicitly owned clients are joined before BullMQ removes its listeners;
  // a missing QUIT reply cannot leave an orphan reconnect loop during cleanup.
  const queueRedis = new Redis(redisUrl, { ...connection, commandTimeout: IO_MS, socketTimeout: IO_MS, maxRetriesPerRequest: 0 });
  // pnpm retains BullMQ's ioredis 5.10 type identity beside the API's 5.11.
  // This boundary passes the real, tested public Redis instance unchanged.
  const queue = new Queue(queueName, { connection: queueRedis as unknown as ConnectionOptions, defaultJobOptions: RETENTION });
  const queueReady = queue.waitUntilReady();
  let worker: Worker | undefined, workerRedis: StarterReturnWorkerRedis | undefined, workerReady: Promise<unknown> | undefined;
  let stopping = false, closing: Promise<void> | undefined, reported = false;
  const owned = new Set<Promise<{ processed: number; failed: number }>>();
  const diagnostic = () => {
    if (!reported) { reported = true; console.warn('[starter-returns] Queue connection unavailable; accepted obligations remain pending'); }
  };
  queueRedis.on('error', diagnostic); queue.on('error', diagnostic);
  const close = () => closing ??= (async () => {
    stopping = true;
    // Stop acquisition first, then join the actual SQL/cursor processors.
    // BullMQ's post-processor acknowledgement may retry disconnected Redis
    // forever; force-close is safe ONLY after these owned promises have joined.
    try {
      try { await worker?.pause(true); }
      finally {
        await Promise.allSettled([...owned]);
        if (workerRedis) await Promise.all([workerRedis, ...workerRedis.duplicates].map(disconnectRedis));
        await workerReady?.catch(() => undefined);
        await worker?.close(true);
      }
    } finally {
      workerRedis?.disconnect();
      try {
        await disconnectRedis(queueRedis);
        await queueReady.catch(() => undefined);
        await queue.close();
      }
      finally { queueRedis.disconnect(); cursor.close(); }
    }
  })();
  const startup = setTimeout(() => { void close().catch(() => undefined); }, STARTUP_MS);
  const live = () => { if (stopping) throw new Error('Starter return scheduler startup stopped'); };
  try {
    await queueReady; live(); await cursor.connect(); live();
    await queue.setGlobalConcurrency(1); live();
    await queue.upsertJobScheduler(STARTER_RETURN_SCHEDULER, { every: STARTER_RETURN_EVERY_MS }, { name: JOB }); live();
    // BullMQ clones this connection for BZPOPMIN. Its legitimate blocking wait
    // is at most 10s (5.78), so 12s socket/15s command bounds preserve that wait
    // while also bounding INFO, moveToActive, completion and connection cleanup.
    workerRedis = new StarterReturnWorkerRedis(redisUrl, { ...connection, commandTimeout: WORKER_COMMAND_MS, socketTimeout: WORKER_SOCKET_MS, maxRetriesPerRequest: null });
    workerRedis.on('error', diagnostic);
    worker = new Worker(queueName, async job => {
      if (stopping) throw new Error('Starter return consumer is stopping; obligations remain pending');
      if (job.name !== JOB) throw new Error('Unknown starter expedition return job');
      const processing = runOwnedStarterExpeditionReturnPage(databaseUrl, cursor, {
        clock: options.clock ?? (() => new Date()), ...(options.timeouts ? { timeouts: options.timeouts } : {}),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      });
      owned.add(processing);
      try { return await processing; }
      finally { owned.delete(processing); }
    }, { connection: workerRedis as unknown as ConnectionOptions, concurrency: 1, autorun: false });
    worker.on('error', diagnostic);
    worker.on('failed', () => { console.warn('[starter-returns] Scan failed; accepted obligations remain pending'); });
    workerReady = worker.waitUntilReady();
    await workerReady; live();
    await queue.add(JOB, {}, { jobId: `starter-return-startup-${randomUUID()}` }); live();
    void worker.run().catch(() => { console.warn('[starter-returns] Consumer stopped; accepted obligations remain pending'); });
    clearTimeout(startup);
    return { close };
  } catch {
    clearTimeout(startup);
    try { await close(); }
    catch { /* Every owned client is disconnected by close's finally blocks. */ }
    throw new Error('Starter expedition return scheduler failed to start');
  }
}
