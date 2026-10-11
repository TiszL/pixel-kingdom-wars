/** Real SQL/Redis lifecycle and failure tests. Synthetic accepted obligations do
 * not establish genuine Seeker eligibility; all resources are isolated test state. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection, createServer, Socket } from 'node:net';
import Fastify from 'fastify';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { bases, baseSlots, resourceStocks, starterExpeditionInflight, starterExpeditions } from '../src/db/schema';
import { readStarterExpeditionReturn } from '../src/game/starterExpeditionReturns';
import { runStarterExpeditionReturns } from '../src/game/starterExpeditionWorker';
import { processStarterExpeditionReturnPage, StarterExpeditionCursor, STARTER_RETURN_EVERY_MS,
  STARTER_RETURN_SCHEDULER, runOwnedStarterExpeditionReturnPage, startStarterExpeditionScheduler } from '../src/game/starterExpeditionScheduler';
import { TEST_DATABASE_URL } from './db-url';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { createTestPlayer, TEST_CONFIG } from './helpers';

const redisUrl = TEST_CONFIG.REDIS_URL;
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(redisUrl).hostname)
  || new URL(TEST_DATABASE_URL).pathname !== '/shardkeep_test') throw new Error('Starter scheduler requires isolated local test services');
const conn = createDb(TEST_DATABASE_URL, { max: 6 }), db = conn.db;
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0 });
const at = new Date('2036-01-01T00:00:00.000Z');
const bounds = { lockMs: 100, statementMs: 300, idleMs: 500 };
const queues: Queue[] = [], cursors: StarterExpeditionCursor[] = [];
const closers: Array<() => Promise<void>> = [];
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function accepted() { const f = await createStarterExpeditionFixture(db); return { ...f, trip: await f.dispatch() }; }
async function stock(f: Awaited<ReturnType<typeof accepted>>) {
  return (await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.trip.resourceId))))[0];
}
function queue() {
  const q = new Queue(`test-starter-return-${randomUUID()}`, { connection: { url: redisUrl } }); queues.push(q); return q;
}
async function cursor(name: string) { const c = new StarterExpeditionCursor(redisUrl, name); cursors.push(c); await c.connect(); return c; }
const page = (c: StarterExpeditionCursor) => processStarterExpeditionReturnPage(db, c, { clock: () => at, timeouts: bounds });
beforeAll(async () => { await redis.ping(); });
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const c of cursors.splice(0)) { c.close(); await redis.del(c.key); }
  for (const q of queues.splice(0)) { await q.obliterate({ force: true }); await q.close(); }
  vi.restoreAllMocks();
});
afterAll(async () => { redis.disconnect(); await conn.sql.end(); });

/** Test-owned relay. A connected socket that stops replying exercises the
 * actual driver boundary; no production/test-service-wide pause or shutdown. */
async function proxy(target: URL, intercept: (chunk: Buffer) => 'drop' | 'disconnect' | undefined, halfOpen = false) {
  const sockets = new Set<Socket>(); let blocked = false, upstreamPort: number | undefined;
  const server = createServer({ allowHalfOpen: halfOpen }, client => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
    sockets.add(client); sockets.add(upstream);
    upstream.on('connect', () => { upstreamPort = upstream.localPort; });
    client.on('error', () => undefined); upstream.on('error', () => client.destroy());
    // The hostile half-open case deliberately keeps the database peer alive
    // through either a FIN or RST from the owned client; only relay.close ends it.
    client.on('close', () => { sockets.delete(client); if (!halfOpen) upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.on('data', chunk => {
      const action = intercept(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      if (action) blocked = true;
      if (action === 'disconnect') { for (const socket of sockets) socket.destroy(); return; }
      // Forward the triggering command before suppressing its reply, permitting
      // both real rollback and a committed-but-unacknowledged transaction.
      if (!blocked || action === 'drop') upstream.write(chunk);
    });
    upstream.on('data', chunk => { if (!blocked) client.write(chunk); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing proxy address');
  const url = new URL(target); url.hostname = '127.0.0.1'; url.port = String(address.port);
  return { port: address.port, url: url.toString(), blocked: () => blocked, upstreamPort: () => upstreamPort,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** Decode only test PostgreSQL command framing so reused prepared COMMIT
 * statements are observed at Execute rather than guessed from raw chunks. */
function postgresCommands() {
  let bytes = Buffer.alloc(0); const prepared = new Map<string, string>(), portals = new Map<string, string>();
  return (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]); const commands: string[] = [];
    while (bytes.length >= 5) {
      if (bytes[0] === 0) { const length = bytes.readInt32BE(0); if (bytes.length < length) break; bytes = bytes.subarray(length); continue; }
      const length = bytes.readInt32BE(1); if (bytes.length < length + 1) break;
      const frame = bytes.subarray(5, length + 1), kind = String.fromCharCode(bytes[0]!);
      const field = (offset: number) => { const end = frame.indexOf(0, offset); return [frame.toString('utf8', offset, end), end + 1] as const; };
      if (kind === 'P') { const [name, next] = field(0); prepared.set(name, field(next)[0]); }
      if (kind === 'B') { const [portal, next] = field(0); portals.set(portal, prepared.get(field(next)[0]) ?? ''); }
      if (kind === 'E') commands.push(portals.get(field(0)[0]) ?? '');
      if (kind === 'Q') commands.push(field(0)[0]);
      bytes = bytes.subarray(length + 1);
    }
    return commands;
  };
}

describe.sequential('accepted starter return scheduler', () => {
  it('reconnects the durable full-value cursor and fences stale writers even through wrap', async () => {
    const q = queue(), a = await cursor(q.name), b = await cursor(q.name);
    const absent = await a.read(), base = randomUUID();
    expect(await a.advance(absent, base)).toBe(true);
    expect(await b.advance(absent, randomUUID())).toBe(false);
    const first = await b.read(); expect(first.afterBaseId).toBe(base);
    expect(await b.advance(first, null)).toBe(true);
    const wrapped = await a.read(); expect(wrapped.afterBaseId).toBeNull(); expect(wrapped.raw).not.toBeNull();
    expect(await a.advance(first, randomUUID())).toBe(false);
    expect(await a.advance(absent, randomUUID())).toBe(false);
    expect(await a.read()).toEqual(wrapped);
    a.close(); const reopened = await cursor(q.name); expect(await reopened.read()).toEqual(wrapped);
    expect(await reopened.advance(wrapped, null)).toBe(true); expect((await reopened.read()).raw).not.toBe(wrapped.raw);
  });

  it('refuses corrupt saved progress without replacing it or reading SQL', async () => {
    const q = queue(), c = await cursor(q.name); await redis.set(c.key, '{private original invalid bytes}');
    await expect(processStarterExpeditionReturnPage({} as typeof db, c)).rejects.toThrow('obligations remain pending');
    expect(await redis.get(c.key)).toBe('{private original invalid bytes}');
  });

  it('settles accepted originals after transfer and lost slots with every source flag paused', async () => {
    const f = await accepted(), buyer = await createTestPlayer(db), q = queue(), c = await cursor(q.name);
    const before = (await db.select().from(starterExpeditions).where(eq(starterExpeditions.id, f.trip.id)))[0];
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    const provider = vi.spyOn(f.reader, 'readOperatingTerm').mockRejectedValue(new Error('private provider failure'));
    for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'STARTER_EXPEDITIONS_ENABLED']) vi.stubEnv(flag, 'false');
    try {
      expect(await page(c)).toEqual({ processed: 1, failed: 0 });
      expect(provider).not.toHaveBeenCalled(); expect(await stock(f)).toMatchObject({ available: f.trip.net });
      const proof = await readStarterExpeditionReturn(db, f.trip.id);
      expect(proof!.receipt.custodyWallet).toBe(buyer.wallet);
      expect(proof!.expedition).toMatchObject({ actorWallet: f.wallet, returnsAt: f.trip.returnsAt });
      expect((await db.select().from(starterExpeditions).where(eq(starterExpeditions.id, f.trip.id)))[0]).toEqual(before);
      expect(await page(c)).toEqual({ processed: 0, failed: 0 });
    } finally { vi.unstubAllEnvs(); }
  });

  it('duplicate processors after stalled lease reassignment conserve one receipt and original stock', async () => {
    const f = await accepted(), q = queue(), a = await cursor(q.name), b = await cursor(q.name);
    const stale = await a.read();
    const results = await Promise.all([page(a), page(b)]);
    expect(results.every(r => r.failed === 0)).toBe(true);
    expect(await stock(f)).toMatchObject({ available: f.trip.net });
    const proof = await readStarterExpeditionReturn(db, f.trip.id);
    expect(proof!.entries).toHaveLength(3); expect(proof!.entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
    const winner = await b.read(); expect(winner.raw).not.toBeNull();
    expect(await a.advance(stale, randomUUID())).toBe(false); expect(await a.read()).toEqual(winner);
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toEqual(proof);
  });

  it('advances a 32-base page past an overflowing low UUID and restarts then wraps fairly', async () => {
    const all: Awaited<ReturnType<typeof accepted>>[] = [];
    for (let n = 0; n < 33; n++) all.push(await accepted());
    all.sort((a, b) => a.baseId.localeCompare(b.baseId)); const bad = all[0]!;
    const q = queue(), c = await cursor(q.name);
    await db.insert(resourceStocks).values({ baseId: bad.baseId, resourceId: bad.trip.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    try {
      expect(await page(c)).toEqual({ processed: 31, failed: 1 });
      expect((await c.read()).afterBaseId).toBe(all[31]!.baseId);
      c.close(); const resumed = await cursor(q.name);
      expect(await page(resumed)).toEqual({ processed: 1, failed: 0 });
      expect((await resumed.read()).afterBaseId).toBeNull();
      expect(await readStarterExpeditionReturn(db, bad.trip.id)).toBeNull();
      expect(await stock(all[32]!)).toMatchObject({ available: all[32]!.trip.net });
    } finally {
      await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, bad.baseId));
      const repair = await cursor(q.name); expect(await page(repair)).toEqual({ processed: 1, failed: 0 });
    }
  }, 60_000);

  it('times out a locked base with actual rollback then processes another base and preserves pool settings', async () => {
    const f = await accepted(), good = await accepted(), q = queue(), c = await cursor(q.name), permit = gate();
    let held = false;
    const holding = db.transaction(async tx => { await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update'); held = true; await permit.promise; });
    try {
      await expect.poll(() => held).toBe(true);
      const started = Date.now(); expect(await page(c)).toEqual({ processed: 1, failed: 1 }); expect(Date.now() - started).toBeLessThan(3_000);
      expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull(); expect(await stock(f)).toBeUndefined();
      expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId, f.trip.id))).toHaveLength(1);
      expect(await stock(good)).toMatchObject({ available: good.trip.net });
      expect((await conn.sql`SHOW lock_timeout`)[0]!['lock_timeout']).toBe('0');
      expect((await conn.sql`SHOW statement_timeout`)[0]!['statement_timeout']).toBe('0');
    } finally { permit.release(); await holding; await page(c); }
  });

  it('bounds discovery behind an exclusive table lock and retains its exact prior cursor', async () => {
    const q = queue(), c = await cursor(q.name), prior = await c.read(), permit = gate(); let held = false;
    const holding = db.transaction(async tx => { await tx.execute(sql`LOCK TABLE starter_expeditions IN ACCESS EXCLUSIVE MODE`); held = true; await permit.promise; });
    try {
      await expect.poll(() => held).toBe(true); const started = Date.now();
      await expect(page(c)).rejects.toThrow('obligations remain pending'); expect(Date.now() - started).toBeLessThan(3_000);
      expect(await c.read()).toEqual(prior);
    } finally { permit.release(); await holding; }
    expect(await page(c)).toEqual({ processed: 0, failed: 0 });
  });

  it('replays SQL safely when cursor persistence fails after settlement', async () => {
    const f = await accepted(), q = queue(), c = await cursor(q.name), prior = await c.read();
    const broken = vi.spyOn(c, 'advance').mockRejectedValueOnce(new Error('private Redis URL/password'));
    await expect(page(c)).rejects.toThrow('obligations remain pending');
    const proof = await readStarterExpeditionReturn(db, f.trip.id); expect(proof).not.toBeNull(); expect(await c.read()).toEqual(prior);
    broken.mockRestore(); expect(await page(c)).toEqual({ processed: 0, failed: 0 });
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toEqual(proof); expect(await stock(f)).toMatchObject({ available: f.trip.net });
  });

  it('boots a unique recovery beside retained failed jobs and globally serializes replicas', async () => {
    const q = queue(), events: string[] = []; const seed = new Worker(q.name, async () => { throw new Error('retained historical failure'); }, { connection: { url: redisUrl } });
    await seed.waitUntilReady(); const old = await q.add('starter-expedition-returns', {}, { jobId: 'starter-return-startup-old', removeOnFail: false });
    await expect.poll(() => old.getState()).toBe('failed'); await seed.close();
    const f = await accepted();
    const a = await startStarterExpeditionScheduler(TEST_DATABASE_URL, redisUrl, { queueName: q.name, clock: () => at, timeouts: bounds }); closers.push(a.close);
    const b = await startStarterExpeditionScheduler(TEST_DATABASE_URL, redisUrl, { queueName: q.name, clock: () => at, timeouts: bounds }); closers.push(b.close);
    await expect.poll(() => readStarterExpeditionReturn(db, f.trip.id)).not.toBeNull();
    expect(await q.getGlobalConcurrency()).toBe(1); expect((await q.getJobScheduler(STARTER_RETURN_SCHEDULER))!.every).toBe(STARTER_RETURN_EVERY_MS);
    await a.close(); events.push('first closed'); await b.close(); events.push('second closed');
    expect(events).toHaveLength(2); expect(await stock(f)).toMatchObject({ available: f.trip.net });
    const jobs = await q.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed']);
    expect(jobs.filter(job => job.id?.startsWith('starter-return-startup-') && job.id !== old.id)).toHaveLength(2);
    expect(await old.getState()).toBe('failed');
    const completed = jobs.filter(job => job.finishedOn && job.id !== old.id && job.returnvalue);
    for (const job of completed) expect(Object.keys(job.returnvalue).sort()).toEqual(['failed', 'processed']);
  });

  it('Fastify close waits for a bounded held-base pass and leaves scheduled pending work and cursor intact', async () => {
    const f = await accepted(), q = queue(), permit = gate(); let held = false;
    const holding = db.transaction(async tx => { await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update'); held = true; await permit.promise; });
    const app = Fastify();
    try {
      await expect.poll(() => held).toBe(true);
      const scheduler = await startStarterExpeditionScheduler(TEST_DATABASE_URL, redisUrl, { queueName: q.name, clock: () => at, timeouts: bounds }); closers.push(scheduler.close);
      app.addHook('onClose', scheduler.close); await app.ready();
      await expect.poll(async () => (await conn.sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = 'shardkeep_test' AND wait_event_type = 'Lock' AND query LIKE '%bases%'`)[0]!['count']).toBeGreaterThan(0);
      const started = Date.now(); await app.close(); expect(Date.now() - started).toBeLessThan(3_000);
      expect(await q.getJobCountByTypes('delayed', 'waiting')).toBeGreaterThan(0);
      expect(await redis.get(`bull:${q.name}:scan-cursor`)).not.toBeNull();
      expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
      const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
      expect(server).toContain('workers = await startWorkers(config, db)');
      expect(server).toContain("app.addHook('onClose', async () => { await workers?.close(); })");
    } finally { permit.release(); await holding; await app.close(); await runStarterExpeditionReturns(db, { limit: 32, clock: () => at, timeouts: bounds }); }
  });

  it('destroys its owned SQL socket despite a half-open peer and retains the unacknowledged obligation', async () => {
    const f = await accepted(), q = queue(), c = await cursor(q.name);
    let triggered = false; const commands = postgresCommands();
    // A published Docker port may translate the relay's local client port.
    // Identify the actual PostgreSQL session by an explicit unique startup tag.
    const target = new URL(TEST_DATABASE_URL), applicationName = `starter-half-open-${randomUUID()}`;
    target.searchParams.set('application_name', applicationName);
    const relay = await proxy(target, chunk => {
      if (!triggered && commands(chunk).some(command => command.startsWith('begin'))) { triggered = true; return 'drop'; }
      return undefined;
    }, true);
    let ownedSocket: Socket | undefined;
    const originalDestroy = Socket.prototype.destroy;
    const observed = vi.spyOn(Socket.prototype, 'destroy').mockImplementation(function (this: Socket, error?: Error) {
      if (this.remotePort === relay.port) ownedSocket = this;
      return originalDestroy.call(this, error);
    });
    let relayClosed = false;
    try {
      const started = Date.now();
      const running = runOwnedStarterExpeditionReturnPage(relay.url, c, { clock: () => at, timeouts: bounds, deadlineMs: 500 });
      const rejected = expect(running).rejects.toThrow('obligations remain pending');
      await expect.poll(relay.blocked).toBe(true);
      const port = relay.upstreamPort(); expect(port).toBeTypeOf('number');
      await expect.poll(async () => (await conn.sql`SELECT state FROM pg_stat_activity WHERE datname = 'shardkeep_test' AND application_name = ${applicationName}`)[0]?.['state']).toBe('idle in transaction');
      await rejected; expect(Date.now() - started).toBeLessThan(3_000);
      expect(ownedSocket?.destroyed).toBe(true); expect(ownedSocket?.closed).toBe(true);
      expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull(); expect(await stock(f)).toBeUndefined();
      expect((await c.read()).raw).toBeNull();
      // The deliberately hostile relay keeps its server-side peer alive even
      // after local closure. Close that test resource before claiming DB rollback.
      await relay.close(); relayClosed = true;
      await expect.poll(async () => (await conn.sql`SELECT pid FROM pg_stat_activity WHERE datname = 'shardkeep_test' AND application_name = ${applicationName}`).length).toBe(0);
      expect(await page(c)).toEqual({ processed: 1, failed: 0 });
    } finally { observed.mockRestore(); if (!relayClosed) await relay.close(); await page(c); }
  });

  it('preserves a committed return when SQL COMMIT acknowledgement is lost and does not duplicate on replay', async () => {
    const f = await accepted(), q = queue(), c = await cursor(q.name); let commits = 0; const commands = postgresCommands();
    const relay = await proxy(new URL(TEST_DATABASE_URL), chunk => {
      if (commands(chunk).some(command => command === 'commit' && ++commits === 2)) return 'drop';
      return undefined;
    });
    try {
      await expect(runOwnedStarterExpeditionReturnPage(relay.url, c, { clock: () => at, timeouts: bounds, deadlineMs: 1_000 }))
        .rejects.toThrow('deadline expired');
      expect(relay.blocked()).toBe(true);
      const proof = await readStarterExpeditionReturn(db, f.trip.id); expect(proof).not.toBeNull();
      expect(await stock(f)).toMatchObject({ available: f.trip.net });
      expect((await c.read()).raw).not.toBeNull(); // Completed failed pass advances even when acknowledgement is uncertain.
      expect(await page(c)).toEqual({ processed: 0, failed: 0 }); expect(await readStarterExpeditionReturn(db, f.trip.id)).toEqual(proof);
    } finally { await relay.close(); await page(c); }
  });

  it.each(['drop', 'disconnect'] as const)('drains SQL then closes after Redis %s during post-SQL job acknowledgement', async mode => {
    const f = await accepted(), q = queue(); let tail = '', triggered = false;
    const relay = await proxy(new URL(redisUrl), chunk => {
      tail = (tail + chunk.toString()).slice(-131_072);
      if (!triggered && tail.includes('"processed":1')) { triggered = true; return mode; }
      return undefined;
    });
    let scheduler: Awaited<ReturnType<typeof startStarterExpeditionScheduler>> | undefined;
    try {
      scheduler = await startStarterExpeditionScheduler(TEST_DATABASE_URL, relay.url, { queueName: q.name, clock: () => at, timeouts: bounds });
      closers.push(scheduler.close);
      await expect.poll(relay.blocked).toBe(true);
      const original = await readStarterExpeditionReturn(db, f.trip.id); expect(original).not.toBeNull();
      const started = Date.now(); await scheduler.close(); expect(Date.now() - started).toBeLessThan(20_000);
      expect(await readStarterExpeditionReturn(db, f.trip.id)).toEqual(original);
      expect(await stock(f)).toMatchObject({ available: f.trip.net });
      expect(await redis.get(`bull:${q.name}:scan-cursor`)).not.toBeNull();
      expect(await q.getJobCountByTypes('active', 'waiting', 'delayed')).toBeGreaterThan(0);
    } finally { await scheduler?.close(); await relay.close(); }
  }, 30_000);

  it('bounds disconnected and stalled cursor I/O and closes resources after startup failure', async () => {
    const sockets = new Set<Socket>(); const blackhole = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => blackhole.listen(0, '127.0.0.1', resolve));
    const address = blackhole.address(); if (!address || typeof address === 'string') throw new Error('Missing fake TCP address');
    const unavailable = `redis://127.0.0.1:${address.port}`, c = new StarterExpeditionCursor(unavailable, 'test-stalled-cursor');
    try {
      const started = Date.now(); await expect(c.connect()).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(5_000); c.close();
      await expect(c.read()).rejects.toThrow();
      const booted = Date.now(); await expect(startStarterExpeditionScheduler(TEST_DATABASE_URL, unavailable,
        { queueName: `test-failed-starter-${randomUUID()}` })).rejects.toThrow('failed to start'); expect(Date.now() - booted).toBeLessThan(18_000);
    } finally { c.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => blackhole.close(() => resolve())); }
  }, 25_000);

  it('joins both worker connection initializations when its blocking handshake stalls', async () => {
    const f = await accepted(), q = queue(); let triggered = false;
    const relay = await proxy(new URL(redisUrl), chunk => {
      if (!triggered && chunk.toString().toLowerCase().includes('\r\nsetname\r\n')) { triggered = true; return 'drop'; }
      return undefined;
    });
    try {
      const started = Date.now();
      const boot = startStarterExpeditionScheduler(TEST_DATABASE_URL, relay.url, { queueName: q.name, clock: () => at, timeouts: bounds });
      const refused = expect(boot).rejects.toThrow('failed to start');
      await expect.poll(relay.blocked).toBe(true);
      await refused; expect(Date.now() - started).toBeLessThan(18_000);
      expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
      expect(await q.getJobCountByTypes('delayed', 'waiting')).toBeGreaterThan(0);
    } finally { await relay.close(); await runStarterExpeditionReturns(db, { limit: 32, clock: () => at, timeouts: bounds }); }
  }, 20_000);
});
