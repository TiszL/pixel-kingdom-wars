/** Real accepted trips, followed by explicit historical deed fixtures. Synthetic
 * finalized readers remain test-only; production has no authority fallback. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { SIM_VERSION } from '@shardkeep/sim';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { baseClaimCommands, bases, baseSlots, baseTransfers, builderJobs, buildings, deedOwnershipObservations, players, raids,
  resourceStocks, starterExpeditionInflight } from '../src/db/schema';
import { executeBaseClaim } from '../src/game/baseClaimCommands';
import { observationHash, refreshBaseOwnership, transferStableBase } from '../src/game/baseOwnership';
import { readStarterExpeditionReturn, settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { TEST_DATABASE_URL } from './db-url';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db;
const flags = ['BASE_CLAIM_V1_ENABLED', 'MULTI_BASE_ENABLED'] as const;
const original = Object.fromEntries(flags.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of flags) process.env[key] = 'true'; });
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of flags) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
});
afterAll(() => conn.sql.end());
const key = () => Keypair.generate().publicKey.toBase58();
async function fixture() {
  const wallet = key(), buyer = key(), deed = key(), collection = key();
  await db.insert(players).values([{ wallet }, { wallet: buyer }]);
  const f = await createStarterExpeditionFixture(db, { wallet }), trip = await f.dispatch();
  // Registration/capacity have their own suites. Seed only this fixture's
  // historical deed identity so unrelated full-suite active deeds cannot prevent
  // reaching the actual transfer/return boundary under test. No guard is relaxed.
  await db.update(bases).set({ deedAssetId: deed, deedMintAssetId: deed, landPaidAt: f.now })
    .where(eq(bases.id, f.baseId));
  const proof = { owner: buyer, collection, frozen: false, delegate: null, slot: 100 };
  return { ...f, trip, buyer, deed, collection, proof };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const base = async (f: Fixture) => (await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!;
const stock = async (f: Fixture) => (await db.select().from(resourceStocks)
  .where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.trip.resourceId))))[0];
const move = (path: 'direct' | 'observer', f: Fixture, at: Date, database: Db = db, clock: () => Date = () => at) =>
  path === 'direct'
    ? transferStableBase(database, f.baseId, f.wallet, f.buyer, f.deed, { ...f.proof, observedAtMs: at.getTime() }, clock)
    : refreshBaseOwnership(database, f.baseId, async () => f.proof, f.collection, at, 'test-expedition-transfer', clock);
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

describe.sequential('automatic return at the actual stable custody boundary', () => {
  it.each(['direct', 'observer'] as const)('settles due builder work and returns for the seller before %s custody changes', async path => {
    const f = await fixture(), at = f.trip.returnsAt;
    const [job] = await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId,
      kind: 'upgrade', buildingId: f.lodgeId, startedAt: f.trip.departedAt, finishesAt: at }).returning();
    await move(path, f, at);
    expect((await base(f)).ownerWallet).toBe(f.buyer); expect((await base(f)).updatedAt).toEqual(at);
    expect((await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, f.deed)))[0]!.createdAt).toEqual(at);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]!.completedAt).toEqual(at);
    expect((await db.select().from(buildings).where(eq(buildings.id, f.lodgeId)))[0]!.level).toBe(2);
    const returned = await readStarterExpeditionReturn(db, f.trip.id);
    expect(returned).toMatchObject({ expedition: { actorWallet: f.wallet, baseId: f.baseId },
      receipt: { custodyWallet: f.wallet, returnedAt: at } });
    expect(await stock(f)).toMatchObject({ available: f.trip.net });
    if (path === 'direct') {
      expect((await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId)))[0]!.selectedAt).toEqual(at);
    } else expect((await base(f)).status).toBe('inactive');
  });

  it.each(['direct', 'observer'] as const)('retains future trips through %s transfer and later credits the saved buyer base', async path => {
    const f = await fixture(), beforeDue = new Date(f.trip.returnsAt.getTime() - 1);
    await move(path, f, beforeDue);
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull(); expect(await stock(f)).toBeUndefined();
    expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId, f.trip.id))).toHaveLength(1);
    const [returned] = await db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, f.trip.returnsAt));
    expect(returned).toMatchObject({ expedition: { actorWallet: f.wallet, baseId: f.baseId }, receipt: { custodyWallet: f.buyer } });
    expect(await stock(f)).toMatchObject({ available: f.trip.net });
    if (path === 'observer') expect((await base(f)).status).toBe('inactive');
  });

  it('rolls delivery and claim back while preserving the independently finalized custody fact', async () => {
    const f = await fixture(), request = { idempotencyKey: randomUUID(), baseId: f.baseId, deedAssetId: f.deed };
    const readers = { collection: f.collection, ownerOf: async () => f.proof, ownedDeeds: async () => [f.deed] };
    const transaction = db.transaction.bind(db);
    const fail = vi.spyOn(db, 'transaction').mockImplementation((work, config) => transaction(async tx => {
      const result = await work(tx);
      // The separate fact journal commits no claim/return. Inject failure only
      // after the actual acceptance transaction has written its receipt.
      const claim = await tx.select().from(baseClaimCommands).where(eq(baseClaimCommands.requestKey, request.idempotencyKey));
      if (!claim.length) return result;
      expect(await readStarterExpeditionReturn(tx, f.trip.id)).not.toBeNull();
      expect(claim).toHaveLength(1);
      throw new Error('outer claim failed after receipt');
    }, config));
    try {
      await expect(executeBaseClaim(db, readers, f.buyer, request, () => f.trip.returnsAt)).rejects.toThrow('outer claim failed');
    } finally { fail.mockRestore(); }
    expect((await base(f)).ownerWallet).toBe(f.wallet);
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull(); expect(await stock(f)).toBeUndefined();
    expect(await db.select().from(baseClaimCommands).where(eq(baseClaimCommands.requestKey, request.idempotencyKey))).toEqual([]);
    expect(await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, f.deed))).toEqual([]);
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toMatchObject([
      { owner: f.buyer, status: 'mismatch', slot: BigInt(f.proof.slot), checkedAt: f.trip.returnsAt,
        auditHash: observationHash(f.deed, f.buyer, 'mismatch', BigInt(f.proof.slot), f.trip.returnsAt) },
    ]);
    expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId, f.trip.id))).toHaveLength(1);
    const accepted = await executeBaseClaim(db, readers, f.buyer, request, () => f.trip.returnsAt);
    expect(accepted.createdAt).toBe(f.trip.returnsAt.toISOString());
    expect((await base(f)).updatedAt).toEqual(f.trip.returnsAt);
    expect((await readStarterExpeditionReturn(db, f.trip.id))!.receipt.custodyWallet).toBe(f.wallet);
  });

  it.each(['direct', 'observer'] as const)('samples %s custody after a real base-lock wait crosses the return deadline', async path => {
    const f = await fixture(), permit = gate(); let held = false;
    const holder = db.transaction(async tx => {
      await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update'); held = true; await permit.promise;
    });
    const connection = createDb(TEST_DATABASE_URL, { max: 1, legacyTestEscape: true });
    const observedAt = new Date(f.trip.returnsAt.getTime() - 1), eventAt = new Date(f.trip.returnsAt.getTime() + 1);
    const clock = vi.fn(() => observedAt);
    let pending: ReturnType<typeof move> | undefined;
    try {
      await expect.poll(() => held, { timeout: 5_000 }).toBe(true);
      const [pid] = await connection.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pending = move(path, f, observedAt, connection.db, clock);
      await expect.poll(async () => (await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid!.pid}`)[0]?.['wait_event_type'], { timeout: 5_000 }).toBe('Lock');
      expect(clock).not.toHaveBeenCalled(); clock.mockImplementation(() => eventAt); permit.release(); await pending;
      // Independently committed fact cutoff, then actual reconciliation cutoff;
      // both are sampled only after their canonical lock acquisition.
      expect(clock).toHaveBeenCalledTimes(2);
      expect((await readStarterExpeditionReturn(db, f.trip.id))!.receipt).toMatchObject({ custodyWallet: f.wallet, returnedAt: eventAt });
      expect((await base(f)).updatedAt).toEqual(eventAt);
      if (path === 'observer') {
        const [observation] = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId));
        expect(observation).toMatchObject({ checkedAt: observedAt,
          auditHash: observationHash(f.deed, f.buyer, 'mismatch', BigInt(f.proof.slot), observedAt) });
      }
    } finally { permit.release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); await connection.sql.end(); }
  });

  it('preserves outgoing-raid refusal/defer and settles only when the custody mutation becomes permitted', async () => {
    const f = await fixture(), opponent = await createStarterExpeditionFixture(db), clock = vi.fn(() => f.trip.returnsAt);
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: f.wallet, attackerBaseId: f.baseId,
      defenderWallet: opponent.wallet, defenderBaseId: opponent.baseId, seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: SIM_VERSION,
      ordersDeadlineAt: new Date(f.trip.returnsAt.getTime() + 60_000) }).returning();
    await expect(move('direct', f, f.trip.returnsAt, db, clock)).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });
    expect(clock).toHaveBeenCalledTimes(1); // Finalized fact survives the refused move.
    expect(await move('observer', f, f.trip.returnsAt, db, clock)).toBe('mismatch');
    // Positive finalized loss now ends a Harvester lease immediately. The
    // starter trip and DB custody still wait for the frozen outgoing battle.
    expect(clock).toHaveBeenCalledTimes(3); expect((await base(f)).ownerWallet).toBe(f.wallet);
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    await db.update(raids).set({ status: 'resolved', resolvedAt: f.trip.returnsAt }).where(eq(raids.id, raid!.id));
    expect(await move('observer', f, f.trip.returnsAt, db, clock)).toBe('mismatch');
    expect((await base(f)).ownerWallet).toBe(f.buyer);
    expect((await readStarterExpeditionReturn(db, f.trip.id))!.receipt.custodyWallet).toBe(f.wallet);
  });

  it('an unavailable reader cannot manufacture a custody event or freshen its observation from the return clock', async () => {
    const f = await fixture(), observedAt = f.now, clock = vi.fn(() => f.trip.returnsAt);
    expect(await refreshBaseOwnership(db, f.baseId, async () => null, f.collection, observedAt, 'test-unavailable', clock)).toBe('unavailable');
    expect(clock).not.toHaveBeenCalled(); expect((await base(f)).ownerWallet).toBe(f.wallet);
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    const [observation] = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId));
    expect(observation).toMatchObject({ checkedAt: observedAt, status: 'unavailable', owner: null });
  });
});
