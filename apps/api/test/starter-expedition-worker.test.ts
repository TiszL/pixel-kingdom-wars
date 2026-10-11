/** Whole-database discovery needs its own database, not a filter that could
 * hide another suite's obligations. Synthetic authority stays in test fixtures. */
import { randomUUID } from 'node:crypto';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bases, baseSlots, players, resourceStocks, starterExpeditionInflight, starterExpeditionReturns, starterExpeditions } from '../src/db/schema';
import { readStarterExpeditionReturn } from '../src/game/starterExpeditionReturns';
import { runStarterExpeditionReturns, type StarterExpeditionWorkerOptions } from '../src/game/starterExpeditionWorker';
import { ADMIN_DATABASE_URL } from './db-url';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { createTestPlayer } from './helpers';

const name = `starter_worker_${randomUUID().replaceAll('-', '')}_test`;
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
let conn: ReturnType<typeof createDb>, db: Db;
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`);
  conn = createDb(url.toString()); db = conn.db;
  await runMigrations(db);
}, 120_000);
afterAll(async () => {
  try { await conn?.sql.end(); }
  finally {
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    finally { await admin.end(); }
  }
});
async function accepted() {
  const f = await createStarterExpeditionFixture(db);
  return { ...f, trip: await f.dispatch() };
}
const run = (at: Date, limit = 100, afterBaseId?: string) => runStarterExpeditionReturns(db, {
  limit, ...(afterBaseId === undefined ? {} : { afterBaseId }), clock: () => new Date(at),
});
const stock = async (f: Awaited<ReturnType<typeof accepted>>) => (await db.select().from(resourceStocks)
  .where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.trip.resourceId))))[0];
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

describe.sequential('isolated automatic starter return runner', () => {
  it('rejects invalid operational bounds, cursor and clock before any database call', async () => {
    const unused = {} as Db, valid = { limit: 1, clock: () => new Date() };
    for (const limit of [0, -1, 101, 1.5, NaN, '1']) {
      await expect(runStarterExpeditionReturns(unused, { ...valid, limit } as StarterExpeditionWorkerOptions)).rejects.toThrow('limit');
    }
    await expect(runStarterExpeditionReturns(unused, { ...valid, afterBaseId: 'not-a-base' })).rejects.toThrow();
    await expect(runStarterExpeditionReturns(unused, { ...valid, clock: undefined } as unknown as StarterExpeditionWorkerOptions)).rejects.toThrow('clock');
    await expect(runStarterExpeditionReturns(unused, { ...valid, clock: () => new Date(NaN) })).rejects.toThrow();
  });

  it('excludes future obligations and includes a return exactly at its original deadline', async () => {
    const f = await accepted();
    expect(await run(new Date(f.trip.returnsAt.getTime() - 1))).toEqual({ processedBaseIds: [], failures: [], nextAfterBaseId: null });
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    expect(await run(f.trip.returnsAt)).toEqual({ processedBaseIds: [f.baseId], failures: [], nextAfterBaseId: null });
    expect(await stock(f)).toMatchObject({ available: f.trip.net, reserved: 0n });
  });

  it('settles original free stock after sale and deactivation without a current slot or term reader', async () => {
    const f = await accepted(), buyer = await createTestPlayer(db);
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    const reader = vi.spyOn(f.reader, 'readOperatingTerm').mockRejectedValue(new Error('term provider unavailable'));
    try {
      expect((await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!.landPaidAt).toBeNull();
      expect((await run(f.trip.returnsAt)).failures).toEqual([]);
      const proof = await readStarterExpeditionReturn(db, f.trip.id);
      expect(proof).toMatchObject({ expedition: { actorWallet: f.wallet, baseId: f.baseId }, receipt: { custodyWallet: buyer.wallet } });
      expect(await stock(f)).toMatchObject({ available: f.trip.net });
      expect(reader).not.toHaveBeenCalled();
    } finally { reader.mockRestore(); }
  });

  it('concurrent runners and a reconnected runner conserve one original source posting', async () => {
    const f = await accepted(), runs = await Promise.all([run(f.trip.returnsAt), run(f.trip.returnsAt)]);
    expect(runs.flatMap(r => r.failures)).toEqual([]);
    expect(runs.flatMap(r => r.processedBaseIds)).toContain(f.baseId);
    const proof = await readStarterExpeditionReturn(db, f.trip.id);
    expect(proof!.entries).toHaveLength(3);
    expect(proof!.entries.reduce((sum, e) => sum + e.delta, 0n)).toBe(0n);
    expect(await db.select().from(starterExpeditionReturns).where(eq(starterExpeditionReturns.expeditionId, f.trip.id))).toHaveLength(1);
    expect(await stock(f)).toMatchObject({ available: f.trip.net });
    const reopened = createDb(url.toString(), { max: 1 });
    try {
      expect(await runStarterExpeditionReturns(reopened.db, { limit: 100, clock: () => f.trip.returnsAt }))
        .toEqual({ processedBaseIds: [], failures: [], nextAfterBaseId: null });
      expect(await readStarterExpeditionReturn(reopened.db, f.trip.id)).toEqual(proof);
    } finally { await reopened.sql.end(); }
  });

  it('reports overflow while completing another base, then retries the retained obligation', async () => {
    const failed = await accepted(), good = await accepted();
    // Synthetic opening stock only; never an issuance helper in production.
    await db.insert(resourceStocks).values({ baseId: failed.baseId, resourceId: failed.trip.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    try {
      const result = await run(failed.trip.returnsAt);
      expect(result.processedBaseIds).toEqual([good.baseId]);
      expect(result.failures).toHaveLength(1); expect(result.failures[0]!.baseId).toBe(failed.baseId);
      expect(String(result.failures[0]!.error)).toContain('overflow');
      expect(await readStarterExpeditionReturn(db, failed.trip.id)).toBeNull();
      expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId, failed.trip.id))).toHaveLength(1);
      expect(await stock(failed)).toMatchObject({ available: RAW_RESOURCE_STORAGE_MAX });
      expect(await stock(good)).toMatchObject({ available: good.trip.net });
    } finally {
      await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, failed.baseId));
      expect((await run(failed.trip.returnsAt)).failures).toEqual([]);
    }
  });

  it('advances its fair cursor past failed bases and wraps only after reaching the end', async () => {
    const all = await Promise.all([accepted(), accepted(), accepted()]); all.sort((a, b) => a.baseId.localeCompare(b.baseId));
    const [bad, middle, last] = all;
    await db.insert(resourceStocks).values({ baseId: bad!.baseId, resourceId: bad!.trip.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    try {
      const a = await run(bad!.trip.returnsAt, 1);
      expect(a.processedBaseIds).toEqual([]); expect(a.failures.map(f => f.baseId)).toEqual([bad!.baseId]);
      expect(a.nextAfterBaseId).toBe(bad!.baseId);
      const b = await run(bad!.trip.returnsAt, 1, a.nextAfterBaseId!.toUpperCase());
      expect(b).toEqual({ processedBaseIds: [middle!.baseId], failures: [], nextAfterBaseId: middle!.baseId });
      expect(await run(bad!.trip.returnsAt, 1, b.nextAfterBaseId!))
        .toEqual({ processedBaseIds: [last!.baseId], failures: [], nextAfterBaseId: null });
    } finally {
      await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, bad!.baseId));
      expect((await run(bad!.trip.returnsAt)).failures).toEqual([]);
    }
  });

  it('discovers a missing flight as a failed obligation instead of hiding it forever', async () => {
    const f = await accepted();
    // Deliberate owner-only corruption inside this disposable database. The
    // ordinary deferred state guard forbids this transition at commit.
    await db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE starter_expedition_inflight DISABLE TRIGGER starter_flight_state`);
      await tx.delete(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId, f.trip.id));
      await tx.execute(sql`ALTER TABLE starter_expedition_inflight ENABLE TRIGGER starter_flight_state`);
    });
    try {
      const result = await run(f.trip.returnsAt);
      expect(result.processedBaseIds).toEqual([]); expect(result.failures.map(e => e.baseId)).toEqual([f.baseId]);
      expect(String(result.failures[0]!.error)).toContain('reservation');
      expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull(); expect(await stock(f)).toBeUndefined();
    } finally {
      await db.insert(starterExpeditionInflight).values({ installationId: f.installationId, expeditionId: f.trip.id });
      expect((await run(f.trip.returnsAt)).failures).toEqual([]);
    }
  });

  it('samples the return cutoff after the actual base lock wait without changing original observation', async () => {
    const f = await accepted(), permit = gate(); let held = false;
    const holder = db.transaction(async tx => {
      await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update'); held = true; await permit.promise;
    });
    const worker = createDb(url.toString(), { max: 1 });
    let pending: ReturnType<typeof runStarterExpeditionReturns> | undefined;
    const clock = vi.fn(() => new Date(f.trip.returnsAt));
    try {
      await expect.poll(() => held, { timeout: 5_000 }).toBe(true);
      const [pid] = await worker.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pending = runStarterExpeditionReturns(worker.db, { limit: 1, clock });
      await expect.poll(async () => (await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid!.pid}`)[0]?.['wait_event_type'], { timeout: 5_000 }).toBe('Lock');
      expect(clock).toHaveBeenCalledTimes(1);
      const afterWait = new Date(f.trip.returnsAt.getTime() + 10_000);
      clock.mockImplementation(() => afterWait); permit.release();
      expect((await pending).failures).toEqual([]);
      expect((await readStarterExpeditionReturn(db, f.trip.id))!.receipt.returnedAt).toEqual(afterWait);
      const [stored] = await db.select().from(starterExpeditions).where(eq(starterExpeditions.id, f.trip.id));
      expect(stored!.finality).toEqual(f.trip.finality); expect(stored!.departedAt).toEqual(f.trip.departedAt);
    } finally { permit.release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); await worker.sql.end(); }
  });

  it('finishes while a player FOR UPDATE lock is held, forbidding implicit base-to-player FK locks too', async () => {
    const f = await accepted(), permit = gate(); let held = false, finished = false;
    const holder = db.transaction(async tx => {
      await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update'); held = true; await permit.promise;
    });
    let pending: ReturnType<typeof run> | undefined;
    try {
      await expect.poll(() => held, { timeout: 5_000 }).toBe(true);
      pending = run(f.trip.returnsAt).then(result => { finished = true; return result; });
      // Receipt custody is validated from the locked base, not a new player FK
      // KEY SHARE. A player→base transfer would otherwise deadlock this worker.
      await expect.poll(() => finished, { timeout: 5_000 }).toBe(true);
      expect((await pending).failures).toEqual([]);
      expect(await stock(f)).toMatchObject({ available: f.trip.net });
    } finally { permit.release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); }
  });
});
