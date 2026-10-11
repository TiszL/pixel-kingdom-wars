/** Real SQL provenance with synthetic terms/seeded facilities only. These cases
 * do not establish genuine Seeker admission or construction acceptance. */
import { randomUUID } from 'node:crypto';
import { PHASE_E_HARVESTER } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../src/db/client';
import { harvesterSourceCommands, harvesterSourceHeads, harvesterSources, resourceStocks } from '../src/db/schema';
import { readHarvesterSourceCommand, selectHarvesterSourceCommand } from '../src/game/harvesterCommands';
import { closeHarvesterSources, readHarvesterSettlement } from '../src/game/harvesterSettlement';
import { readHarvesterSource, selectHarvesterSource } from '../src/game/harvesterSources';
import { createHarvesterFixture } from './fixtures/harvesters';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db, V1 = PHASE_E_HARVESTER.v1;
type Fixture = Awaited<ReturnType<typeof createHarvesterFixture>>;
type Source = typeof harvesterSources.$inferInsert;
afterAll(() => conn.sql.end());
beforeEach(() => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('HARVESTERS_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());
const command = (f: Fixture, id = f.request.idempotencyKey) => ({ id, actorWallet: f.wallet, baseId: f.baseId,
  harvesterId: f.harvesterId, expectedSourceId: null, policyVersion: f.request.policyVersion });
const internal = (f: Fixture, id = f.request.idempotencyKey) => selectHarvesterSource(db, f.wallet,
  { id, baseId: f.baseId, harvesterId: f.harvesterId, policyVersion: f.request.policyVersion },
  f.authority, { reader: f.reader, clock: () => f.now });
const publicSelect = (f: Fixture) => selectHarvesterSourceCommand(db, f.wallet, f.request, f.authority,
  { reader: f.reader, clock: () => f.now });
const commands = (id: string) => db.select().from(harvesterSourceCommands).where(eq(harvesterSourceCommands.id, id));
const heads = (f: Fixture) => db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet, f.wallet));
const stock = (f: Fixture) => db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId));
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}
function sqlCause(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === 'string') return { code: e.code, message: typeof e.message === 'string' ? e.message : '' };
    if (e.cause) return sqlCause(e.cause);
  }
  throw new Error('Expected a PostgreSQL constraint error');
}
async function refused(promise: Promise<unknown>, codes = ['23514']) {
  const result = await outcome(promise);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Invalid provenance unexpectedly committed');
  const cause = sqlCause(result.error); expect(codes).toContain(cause.code); return cause;
}
/** Produce a valid frozen insertion template through actual admission first.
 * Close its zero-cadence predecessor honestly; no trigger bypass or extra head. */
async function insertionTemplate(f: Fixture, id = f.request.idempotencyKey): Promise<Source> {
  const original = await internal(f, randomUUID());
  await db.transaction(tx => closeHarvesterSources(tx, f.baseId, f.now, 'replacement'));
  return { ...original, id, intervalSnapshot: { ...original.intervalSnapshot, sourceId: id } };
}
async function insertSource(tx: DbTx, source: Source) {
  const [inserted] = await tx.insert(harvesterSources).values(source).returning();
  if (!inserted) throw new Error('Fixture source was not inserted');
  await tx.insert(harvesterSourceHeads).values({ wallet: inserted.actorWallet, baseId: inserted.baseId, sourceId: inserted.id });
  return inserted;
}

describe.sequential('Harvester public admission provenance', () => {
  it('atomically binds the normal public command and newly admitted source', async () => {
    const f = await createHarvesterFixture(db), accepted = await publicSelect(f);
    expect(accepted.request).toEqual(f.request);
    expect(await commands(f.request.idempotencyKey)).toEqual([command(f)]);
    expect(await readHarvesterSource(db, f.request.idempotencyKey)).toMatchObject({ publicAdmission: true, actorWallet: f.wallet });
    expect(await heads(f)).toMatchObject([{ sourceId: f.request.idempotencyKey }]);
    expect(await stock(f)).toEqual([]);
  });

  it('cannot relabel a committed internal acceptance by inserting an exact public command through SQL', async () => {
    const f = await createHarvesterFixture(db), original = await internal(f);
    expect(original.publicAdmission).toBe(false);
    const error = await refused(db.transaction(async tx => { await tx.insert(harvesterSourceCommands).values(command(f)); }));
    expect(error.message).toContain('atomic original source');
    expect(await commands(original.id)).toEqual([]);
    expect(await readHarvesterSource(db, original.id)).toEqual(original);
    expect(await readHarvesterSourceCommand(db, f.wallet, original.id)).toBeNull();
  });

  it('overwrites caller-supplied public provenance when no matching command is visible', async () => {
    const f = await createHarvesterFixture(db), template = await insertionTemplate(f);
    const inserted = await db.transaction(tx => insertSource(tx, { ...template, publicAdmission: true }));
    expect(inserted.publicAdmission).toBe(false);
    expect((await readHarvesterSource(db, inserted.id))!.publicAdmission).toBe(false);
    await refused(Promise.resolve(db.update(harvesterSources).set({ publicAdmission: true }).where(eq(harvesterSources.id, inserted.id))));
    expect(await commands(inserted.id)).toEqual([]);
  });

  it.each(['update', 'delete', 'truncate'] as const)('rejects %s of original public consent', async operation => {
    const f = await createHarvesterFixture(db), original = await publicSelect(f);
    const mutation = operation === 'update'
      ? db.update(harvesterSourceCommands).set({ expectedSourceId: randomUUID() }).where(eq(harvesterSourceCommands.id, f.request.idempotencyKey))
      : operation === 'delete' ? db.delete(harvesterSourceCommands).where(eq(harvesterSourceCommands.id, f.request.idempotencyKey))
        : db.execute(sql`TRUNCATE TABLE harvester_source_commands`);
    expect((await refused(Promise.resolve(mutation))).message).toContain('immutable');
    expect(await readHarvesterSourceCommand(db, f.wallet, f.request.idempotencyKey)).toEqual(original);
  });

  it.each(['actor', 'base', 'facility', 'policy', 'source'] as const)('requires exact reciprocal %s binding at commit', async field => {
    const f = await createHarvesterFixture(db), template = await insertionTemplate(f);
    const other = field === 'actor' || field === 'base' ? await createHarvesterFixture(db) : null;
    const changed = { ...command(f), ...(field === 'actor' ? { actorWallet: other!.wallet }
      : field === 'base' ? { baseId: other!.baseId } : field === 'facility' ? { harvesterId: randomUUID() }
        : field === 'policy' ? { policyVersion: f.request.policyVersion + 1 } : { id: randomUUID() }) };
    const error = await refused(db.transaction(async tx => {
      await tx.insert(harvesterSourceCommands).values(changed);
      expect((await insertSource(tx, { ...template, publicAdmission: true })).publicAdmission).toBe(false);
    }), field === 'source' ? ['23503', '23514'] : ['23514']);
    if (field !== 'source') expect(error.message).toContain('atomic original source');
    expect(await commands(changed.id)).toEqual([]);
    expect(await readHarvesterSource(db, f.request.idempotencyKey)).toBeNull();
    expect(await heads(f)).toEqual([]);
  });

  it('rolls an orphan command and its incidental writes back together', async () => {
    const f = await createHarvesterFixture(db);
    await refused(db.transaction(async tx => {
      await tx.insert(harvesterSourceCommands).values(command(f));
      await tx.insert(resourceStocks).values({ baseId: f.baseId, resourceId: 'crown_iron_ore', available: BigInt(V1.grossPerCadence) });
    }), ['23503', '23514']);
    expect(await commands(f.request.idempotencyKey)).toEqual([]);
    expect(await readHarvesterSource(db, f.request.idempotencyKey)).toBeNull();
    expect(await stock(f)).toEqual([]);
  });

  it('cannot adopt an internal insertion that cannot see the uncommitted public command', async () => {
    const f = await createHarvesterFixture(db), template = await insertionTemplate(f), finish = barrier();
    let pending = false;
    const publicAttempt = outcome(db.transaction(async tx => {
      await tx.insert(harvesterSourceCommands).values(command(f));
      await tx.insert(resourceStocks).values({ baseId: f.baseId, resourceId: 'crown_iron_ore', available: BigInt(V1.grossPerCadence) });
      pending = true; await finish.promise;
      // Even raw SQL that omits its own source INSERT must not adopt the winner.
    }));
    try {
      await expect.poll(() => pending).toBe(true);
      await db.transaction(async tx => {
        expect(await tx.select().from(harvesterSourceCommands).where(eq(harvesterSourceCommands.id, f.request.idempotencyKey))).toEqual([]);
        expect((await insertSource(tx, { ...template, publicAdmission: true })).publicAdmission).toBe(false);
      });
    } finally { finish.release(); await publicAttempt; }
    const result = await publicAttempt;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Public command adopted a concurrent internal source');
    expect(sqlCause(result.error)).toMatchObject({ code: '23514', message: expect.stringContaining('atomic original source') });
    expect(await commands(f.request.idempotencyKey)).toEqual([]);
    expect(await heads(f)).toMatchObject([{ sourceId: f.request.idempotencyKey }]);
    expect((await readHarvesterSource(db, f.request.idempotencyKey))!.publicAdmission).toBe(false);
    expect(await stock(f)).toEqual([]);
  });

  it('refuses an exact matching internal winner accepted during public provider prefetch', async () => {
    const f = await createHarvesterFixture(db), finish = barrier(); let fetching = false;
    const attempted = outcome(selectHarvesterSourceCommand(db, f.wallet, f.request, f.authority, {
      clock: () => f.now, reader: { async readOperatingTerm(at) { fetching = true; await finish.promise; return f.reader.readOperatingTerm(at); } },
    }));
    let winner: Awaited<ReturnType<typeof internal>> | undefined;
    try { await expect.poll(() => fetching).toBe(true); winner = await internal(f); }
    finally { finish.release(); await attempted; }
    expect(await attempted).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_BODY_MISMATCH' } });
    expect(await commands(f.request.idempotencyKey)).toEqual([]);
    expect(await readHarvesterSource(db, f.request.idempotencyKey)).toEqual(winner);
    expect(await heads(f)).toMatchObject([{ sourceId: f.request.idempotencyKey }]);
  });

  it('rolls back earned closure, stock, allowance and head changes after a late cross-actor key collision', async () => {
    const f = await createHarvesterFixture(db, { now: new Date(Date.now() - V1.cadenceSec * 1_000) });
    const old = await internal(f, randomUUID());
    f.now = new Date(old.admittedAt.getTime() + V1.cadenceSec * 1_000);
    f.request.expectedSourceId = old.id;
    const other = await createHarvesterFixture(db), template = await insertionTemplate(other, f.request.idempotencyKey);
    const original = await readHarvesterSettlement(db, old.id), finish = barrier(); let holderPid: number | undefined;
    const scope = JSON.stringify([f.snapshot.source.genesisHash, f.snapshot.source.programId, f.snapshot.source.auctionConfig]);
    const held = outcome(db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expedition-term:${scope}`}, 0))`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>;
      holderPid = row!.pid; await finish.promise;
    }));
    let attempted: ReturnType<typeof outcome> | undefined;
    try {
      await expect.poll(() => holderPid).toBeDefined();
      attempted = outcome(publicSelect(f));
      // Term pinning follows original closure. Observe the actual database wait,
      // rather than estimating a scheduler delay or faking completed receipts.
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid!}=ANY(pg_blocking_pids(pid))
          AND query LIKE '%pg_advisory_xact_lock%') AS waiting`)[0]!.waiting).toBe(true);
      // Same-actor/base late insertion is structurally fenced by FK row locks
      // and source continuity. This independent actor can win the global key.
      await db.transaction(tx => insertSource(tx, template));
    } finally { finish.release(); await held; if (attempted) await attempted; }
    expect(await attempted).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_BODY_MISMATCH' } });
    expect(await readHarvesterSettlement(db, old.id)).toEqual(original);
    expect(await heads(f)).toMatchObject([{ sourceId: old.id }]);
    expect(await stock(f)).toEqual([]);
    expect(await commands(f.request.idempotencyKey)).toEqual([]);
    expect(await readHarvesterSource(db, f.request.idempotencyKey)).toMatchObject({ actorWallet: other.wallet, publicAdmission: false });
    expect(await heads(other)).toMatchObject([{ sourceId: f.request.idempotencyKey }]);
  });
});
