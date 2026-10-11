/** Real SQL lock waits with synthetic finalized observations only. No genuine
 * auction admission, wall-clock backdating or production provider fallback. */
import { PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { starterExpeditionsEnabled } from '../src/config';
import { builderJobs, expeditionFreeHomes, expeditionTermSnapshots, resourceStocks,
  starterExpeditions, starterExpeditionInflight } from '../src/db/schema';
import { dispatchStarterExpedition, readStarterExpedition } from '../src/game/starterExpeditionDispatch';
import { HttpError } from '../src/lib/errors';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db;
type Fixture = Awaited<ReturnType<typeof createStarterExpeditionFixture>>;
afterAll(() => conn.sql.end());
beforeEach(() => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());
const assertAdmission = () => {
  if (!starterExpeditionsEnabled()) throw new HttpError(503, 'Starter departures are paused', 'STARTER_EXPEDITIONS_DISABLED');
};
function singleUseObservation(f: Fixture) {
  const observation = { snapshot: f.snapshot,
    finality: { commitment: 'finalized' as const, contextSlot: '200', observedAt: f.now.toISOString() } };
  let consumed = false;
  const readOperatingTerm = vi.fn(async () => {
    if (consumed) throw new Error('Synthetic prefetched observation already consumed');
    consumed = true; return observation;
  });
  return { readOperatingTerm };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}
async function admissionWhileTermLocked(f: Fixture, whileWaiting: () => void | Promise<void>) {
  let release!: () => void, holderPid: number | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scope = JSON.stringify([f.snapshot.source.genesisHash, f.snapshot.source.programId, f.snapshot.source.auctionConfig]);
  const holder = outcome(db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expedition-term:${scope}`}, 0))`);
    const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>;
    holderPid = row!.pid; await gate;
  }));
  const reader = singleUseObservation(f), clock = vi.fn(() => f.now);
  let pending: ReturnType<typeof outcome<Awaited<ReturnType<typeof dispatchStarterExpedition>>>> | undefined;
  try {
    await expect.poll(() => holderPid).toBeDefined();
    pending = outcome(dispatchStarterExpedition(db, f.wallet, f.command, f.authority, { reader, clock, assertAdmission }));
    await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid!}=ANY(pg_blocking_pids(pid))
        AND query LIKE '%pg_advisory_xact_lock%') AS waiting`)[0]!.waiting).toBe(true);
    expect(clock).toHaveBeenCalledTimes(1); expect(reader.readOperatingTerm).toHaveBeenCalledTimes(1);
    await whileWaiting(); release();
    return { result: await pending, reader, clock };
  } finally {
    release(); await holder; if (pending) await pending;
  }
}
async function noAdmission(f: Fixture) {
  expect(await readStarterExpedition(db, f.command.id)).toBeNull();
  expect(await db.select().from(starterExpeditions).where(eq(starterExpeditions.baseId, f.baseId))).toEqual([]);
  expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, f.installationId))).toEqual([]);
  expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
  expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, f.snapshot.termId))).toEqual([]);
  expect(await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId))).toEqual([]);
}

describe.sequential('starter admission after the actual term advisory wait', () => {
  it('rejects proof that ages in the lock queue and rolls home, term and flight back without consuming the key', async () => {
    const f = await createStarterExpeditionFixture(db);
    const { result, reader, clock } = await admissionWhileTermLocked(f, () => {
      f.now = new Date(f.now.getTime() + PHASE_E_SEEKER_AUCTION.observationMaxAgeMs + 1);
    });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('stale') } });
    expect(reader.readOperatingTerm).toHaveBeenCalledTimes(1); expect(clock).toHaveBeenCalledTimes(2);
    await noAdmission(f);
    const accepted = await dispatchStarterExpedition(db, f.wallet, f.command, f.authority,
      { reader: singleUseObservation(f), clock: () => f.now, assertAdmission });
    expect(accepted.id).toBe(f.command.id); expect(accepted.departedAt).toEqual(f.now);
  });

  it('honors a live pause that begins while term pinning waits', async () => {
    const f = await createStarterExpeditionFixture(db);
    const { result, reader } = await admissionWhileTermLocked(f, () => { vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false'); });
    expect(result).toMatchObject({ ok: false, error: { code: 'STARTER_EXPEDITIONS_DISABLED' } });
    expect(reader.readOperatingTerm).toHaveBeenCalledTimes(1); await noAdmission(f);
  });

  it('refuses the exclusive term end even when the observation is still fresh', async () => {
    const f = await createStarterExpeditionFixture(db);
    f.now = new Date(Date.parse(f.snapshot.endsAt) - 1);
    const { result, reader } = await admissionWhileTermLocked(f, () => { f.now = new Date(f.snapshot.endsAt); });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('not current') } });
    expect(reader.readOperatingTerm).toHaveBeenCalledTimes(1); await noAdmission(f);
  });

  it('uses the later departure and full route duration after a valid short wait, with the original observation', async () => {
    const f = await createStarterExpeditionFixture(db), before = f.now;
    const { result, reader, clock } = await admissionWhileTermLocked(f, () => { f.now = new Date(before.getTime() + 1); });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.departedAt).toEqual(f.now);
    expect(result.value.finality.observedAt).toBe(before.toISOString());
    expect(result.value.returnsAt.getTime()).toBe(f.now.getTime() + result.value.routeSnapshot.durationSec * 1_000);
    expect(result.value.returnsAt.getTime()).toBeGreaterThan(before.getTime() + result.value.routeSnapshot.durationSec * 1_000);
    expect(reader.readOperatingTerm).toHaveBeenCalledTimes(1); expect(clock).toHaveBeenCalledTimes(2);
    expect(await readStarterExpedition(db, result.value.id)).toEqual(result.value);
  });

  it('checks facility completion against the final clock sample instead of only the pre-wait sample', async () => {
    const f = await createStarterExpeditionFixture(db, { now: new Date() });
    const [job] = await db.select().from(builderJobs).where(eq(builderJobs.id, f.lodgeJobId));
    const { result } = await admissionWhileTermLocked(f, () => { f.now = new Date(job!.completedAt!.getTime() - 1); });
    expect(result).toMatchObject({ ok: false, error: { message: 'Starter facilities are not complete at dispatch' } });
    await noAdmission(f);
  });

  it('replays the immutable original before provider, pause, current authority or clock work', async () => {
    const f = await createStarterExpeditionFixture(db);
    const accepted = await dispatchStarterExpedition(db, f.wallet, f.command, f.authority,
      { reader: singleUseObservation(f), clock: () => f.now, assertAdmission });
    vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    const denied = vi.fn(() => { throw new Error('Mutable prerequisite must not run during recovery'); });
    const provider = vi.fn(async () => { throw new Error('Provider unavailable'); });
    expect(await dispatchStarterExpedition(db, f.wallet, f.command, { ...f.authority, assertAuthority: async () => denied() },
      { reader: { readOperatingTerm: provider }, clock: denied, assertAdmission: denied })).toEqual(accepted);
    expect(denied).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
});
