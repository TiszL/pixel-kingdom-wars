/** Actual isolated SQL lifecycle with synthetic facilities/finalized term input.
 * These tests establish commit provenance, not chain admission or animation. */
import { PublicKey } from '@solana/web3.js';
import { matchStarterExpeditionEnvelope } from '@shardkeep/shared/starterExpeditionApi';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { expeditionFreeHomes, expeditionTermSnapshots, players, starterExpeditionInflight, starterExpeditions } from '../src/db/schema';
import * as prefetch from '../src/game/operatingExpeditionTermReader';
import { dispatchStarterExpedition, dispatchStarterExpeditionCommitted, readStarterExpedition } from '../src/game/starterExpeditionDispatch';
import { createStarterExpeditionWorkflow, type StarterExpeditionProvider } from '../src/game/starterExpeditionWorkflow';
import { starterExpeditionEnvelope } from '../src/game/starterExpeditionView';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';

const conn = resourceClaimsDatabase(), db = conn.db;
const key = new PublicKey('11111111111111111111111111111111');
const provider: StarterExpeditionProvider = {
  policy: { genesisHash: key, programId: key, config: key, round: 1n, mint: key, prizeOwner: key, prizeAta: key,
    stateProvenance: 'fresh-reviewed-deployment',
    deployment: { programDataAddress: key.toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } },
  connect: () => { throw new Error('Synthetic source fixture must not contact RPC'); },
};
const workflow = createStarterExpeditionWorkflow(db, { provider });
beforeAll(async () => {
  await conn.setup();
  console.info('starter-created owned database:', (await conn.sql`select current_database() name`)[0]!.name);
}, 180_000);
afterAll(async () => { await conn.close(); console.info('starter-created owned database closed and dropped'); });
beforeEach(() => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'true');
  vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
  vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'true');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
type Fixture = Awaited<ReturnType<typeof createStarterExpeditionFixture>>;
const fixture = () => createStarterExpeditionFixture(db, { now: new Date() });
function request(f: Fixture) {
  const { id: idempotencyKey, ...body } = f.command;
  return { idempotencyKey, ...body };
}
function committed(f: Fixture) {
  return dispatchStarterExpeditionCommitted(db, f.wallet, f.command, f.authority, { reader: f.reader, clock: () => f.now });
}
function barrier() {
  let release!: () => void;
  return { gate: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function outcome<T>(pending: Promise<T>) {
  return pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}

it('marks exactly one concurrent same-key workflow start fresh without changing the canonical original', async () => {
  const f = await fixture(), bothPrefetched = barrier();
  let arrivals = 0;
  vi.spyOn(prefetch, 'prefetchOperatingExpeditionTermReader').mockImplementation(async () => {
    if (++arrivals === 2) bothPrefetched.release();
    await bothPrefetched.gate;
    return f.reader;
  });
  // Both workflow pre-reads must miss before either dispatcher can insert.
  const replies = await Promise.all([workflow.start(f.wallet, request(f)), workflow.start(f.wallet, request(f))]);
  expect(arrivals).toBe(2);
  expect(replies.map(reply => reply.created).sort()).toEqual([false, true]);
  const original = matchStarterExpeditionEnvelope(replies[0]!.envelope, f.wallet, request(f));
  expect(original.status).toBe('accepted');
  expect(replies[1]!.envelope.receipt).toEqual(original.receipt);
  expect(Object.keys(original).sort()).toEqual(['idempotencyKey', 'receipt', 'return', 'serverNow', 'status', 'wallet']);
  expect(await db.select().from(starterExpeditions).where(eq(starterExpeditions.baseId, f.baseId))).toHaveLength(1);
  expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, f.installationId)))
    .toEqual([{ installationId: f.installationId, expeditionId: f.command.id }]);
});

it('returns false for a preexisting original before provider or paused-admission work and preserves the legacy row', async () => {
  const f = await fixture(), created = await committed(f);
  expect(created.created).toBe(true);
  vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
  const denied = vi.fn(() => { throw new Error('Recovery must not run current admission'); });
  vi.spyOn(prefetch, 'prefetchOperatingExpeditionTermReader').mockImplementation(denied);
  const recovered = await dispatchStarterExpeditionCommitted(db, f.wallet, f.command,
    { ...f.authority, assertAuthority: async () => denied() }, { clock: denied, assertAdmission: denied });
  expect(recovered).toEqual({ created: false, expedition: created.expedition });
  const reply = await workflow.start(f.wallet, request(f));
  expect(reply.created).toBe(false);
  expect(matchStarterExpeditionEnvelope(reply.envelope, f.wallet, request(f)).receipt)
    .toEqual((await starterExpeditionEnvelope(db, f.wallet, f.command.id)).receipt);
  expect(await dispatchStarterExpedition(db, f.wallet, f.command, f.authority)).toEqual(created.expedition);
  expect(denied).not.toHaveBeenCalled();
});

it('reports false when another transaction inserts the original while this dispatch waits on the actual player lock', async () => {
  const f = await fixture(), release = barrier();
  let holderPid: number | undefined;
  const holder = outcome(db.transaction(async tx => {
    await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
    holderPid = Number((await tx.execute(sql`select pg_backend_pid() pid`))[0]!.pid);
    await release.gate;
    return dispatchStarterExpedition(tx, f.wallet, f.command, f.authority, { reader: f.reader, clock: () => f.now });
  }));
  let waiting: ReturnType<typeof outcome<Awaited<ReturnType<typeof committed>>>> | undefined;
  try {
    await expect.poll(() => holderPid).toBeDefined();
    waiting = outcome(committed(f));
    await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`
      select exists(select 1 from pg_stat_activity where ${holderPid!}=any(pg_blocking_pids(pid))
        and query like '%players%') waiting`)[0]!.waiting).toBe(true);
    release.release();
    const first = await holder, late = await waiting;
    expect(first.ok).toBe(true); expect(late.ok).toBe(true);
    if (!first.ok || !late.ok) throw new Error('Expected both original results');
    expect(late.value).toEqual({ created: false, expedition: first.value });
  } finally {
    release.release(); await holder; if (waiting) await waiting;
  }
});

it('does not expose a fresh result when the owning transaction fails after insertion, and permits the rolled-back key', async () => {
  const f = await fixture(), transaction = db.transaction.bind(db);
  const failBeforeCommit = vi.spyOn(db, 'transaction').mockImplementationOnce(async (run, options) => transaction(async tx => {
    const result = await run(tx);
    expect(result).toMatchObject({ created: true, expedition: { id: f.command.id } });
    expect(await tx.select().from(starterExpeditions).where(eq(starterExpeditions.id, f.command.id))).toHaveLength(1);
    throw new Error('Synthetic outer transaction failure after canonical insertion');
  }, options));
  await expect(committed(f)).rejects.toThrow('Synthetic outer transaction failure');
  failBeforeCommit.mockRestore();
  expect(await readStarterExpedition(db, f.command.id)).toBeNull();
  expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, f.installationId))).toEqual([]);
  expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
  expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, f.snapshot.termId))).toEqual([]);
  expect((await committed(f)).created).toBe(true);
});

it('refuses a savepoint as commit proof while the legacy row entry remains rollback-atomic for transaction callers', async () => {
  const f = await fixture();
  await expect(db.transaction(async tx => {
    await expect(dispatchStarterExpeditionCommitted(tx as unknown as Db, f.wallet, f.command, f.authority))
      .rejects.toThrow('top-level connection');
    const row = await dispatchStarterExpedition(tx, f.wallet, f.command, f.authority, { reader: f.reader, clock: () => f.now });
    expect(row.id).toBe(f.command.id);
    expect(row).not.toHaveProperty('created');
    await expect(dispatchStarterExpeditionCommitted(tx as unknown as Db, f.wallet, f.command, f.authority))
      .rejects.toThrow('top-level connection');
    throw new Error('Legacy caller still owns rollback');
  })).rejects.toThrow('Legacy caller still owns rollback');
  expect(await readStarterExpedition(db, f.command.id)).toBeNull();
});

// 2026-10-10 (CI cluster E): the top-level guard moved from construction to each
// operation. buildApp registers the starter routes unconditionally, so an app built
// on a rolled-back fixture transaction (keep-custody-sinks/http) must construct;
// what must never happen is a starter read or departure running inside a caller's
// transaction, where the committed dispatch could not prove its commit.
it('constructs on a transaction for route registration but refuses every starter operation there', async () => {
  const f = await fixture();
  await expect(db.transaction(async tx => {
    const bound = createStarterExpeditionWorkflow(tx as unknown as Db, { provider });
    for (const run of [() => bound.read(f.wallet, f.command.id), () => bound.view(f.wallet, { baseId: f.baseId }),
      () => bound.paidView(f.wallet, { baseId: f.baseId, realm: 0 } as never), () => bound.start(f.wallet, request(f))]) {
      await expect(run()).rejects.toThrow('Starter workflow requires a top-level connection');
    }
    throw new Error('Fixture transaction rolls back');
  })).rejects.toThrow('Fixture transaction rolls back');
  expect(await readStarterExpedition(db, f.command.id)).toBeNull();
});
