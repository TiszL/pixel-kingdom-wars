/** Real lock waits, injected server time. No sleep advances chain evidence. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db, type DbTx } from '../src/db/client';
import { baseClaimCommands, bases, baseTransfers, deedOwnershipObservations, players, resourceStocks, starterExpeditionInflight } from '../src/db/schema';
import { claimBase } from '../src/game/baseClaim';
import { executeBaseClaim } from '../src/game/baseClaimCommands';
import { observationHash, registerOwnedDeed, transferStableBase } from '../src/game/baseOwnership';
import { readStarterExpeditionReturn } from '../src/game/starterExpeditionReturns';
import { TEST_DATABASE_URL } from './db-url';
import { isolateDeedTestFixtures } from './deed-fixtures';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db;
let restoreDeedFixtures = async () => {};
beforeAll(async () => { restoreDeedFixtures = await isolateDeedTestFixtures(db); });
const keys = ['MULTI_BASE_ENABLED', 'BASE_CLAIM_V1_ENABLED'] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of keys) process.env[key] = 'true'; });
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
});
afterAll(async () => { try { await restoreDeedFixtures(); } finally { await conn.sql.end(); } });
const pubkey = () => Keypair.generate().publicKey.toBase58();
async function fixture() {
  const wallet = pubkey(), buyer = pubkey(), deed = pubkey(), collection = pubkey();
  await db.insert(players).values([{ wallet }, { wallet: buyer }]);
  const f = await createStarterExpeditionFixture(db, { wallet }), trip = await f.dispatch();
  expect((await registerOwnedDeed(db, wallet, deed)).id).toBe(f.baseId);
  const proof = { owner: buyer, collection, frozen: false, delegate: null, slot: 100 };
  const readers = { collection, ownerOf: vi.fn(async () => proof), ownedDeeds: async () => [deed] };
  const request = { baseId: f.baseId, deedAssetId: deed, idempotencyKey: randomUUID() };
  return { ...f, buyer, deed, proof, readers, request, trip, observedAt: trip.returnsAt };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function unchanged(f: Fixture) {
  expect((await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!.ownerWallet).toBe(f.wallet);
  expect(await db.select().from(baseClaimCommands).where(eq(baseClaimCommands.requestKey, f.request.idempotencyKey))).toEqual([]);
  expect(await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, f.deed))).toEqual([]);
  expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
  expect(await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId))).toEqual([]);
  expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId, f.trip.id))).toHaveLength(1);
}
async function waitForLock(f: Fixture, start: (database: Db) => Promise<unknown>, afterWait: () => void,
  kind: 'base' | 'player' = 'base', lockedWrite?: (tx: DbTx) => Promise<void>) {
  let release!: () => void, acquired!: () => void;
  const permit = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const holder = db.transaction(async tx => {
    if (kind === 'base') await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
    else await tx.select().from(players).where(eq(players.wallet, f.buyer)).for('update');
    if (lockedWrite) await lockedWrite(tx);
    acquired(); await permit;
  });
  const connection = createDb(TEST_DATABASE_URL, { max: 1, legacyTestEscape: true });
  let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
  try {
    await Promise.race([ready, holder.then(() => { throw new Error('lock holder ended before admission'); })]);
    const [pid] = await connection.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    pending = start(connection.db).then(value => ({ value }), error => ({ error }));
    await expect.poll(async () => (await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid!.pid}`)[0]?.['wait_event_type'], { timeout: 5_000 }).toBe('Lock');
    afterWait(); release(); return await pending;
  } finally {
    release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); await connection.sql.end();
  }
}

describe.sequential('claim proof receive time survives lock queues', () => {
  it.each(['base', 'player'] as const)('refuses expired original proof after a real %s wait without consuming returns or key', async kind => {
    const f = await fixture(); let at = f.observedAt;
    const outcome = await waitForLock(f, database => executeBaseClaim(database, f.readers, f.buyer, f.request, () => at), () => {
      expect(f.readers.ownerOf).toHaveBeenCalledTimes(1);
      at = new Date(at.getTime() + BASE_OWNERSHIP.mutationFreshnessMs + 1);
    }, kind);
    expect(outcome.error).toMatchObject({ statusCode: 503, code: 'BASE_CLAIM_UNAVAILABLE' });
    await unchanged(f);
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toEqual([]);
    // A newly received finalized response may retry the unconsumed key.
    const accepted = await executeBaseClaim(db, f.readers, f.buyer, f.request, () => at);
    expect(accepted.outcome).toBe('claimed');
    expect((await readStarterExpeditionReturn(db, f.trip.id))!.receipt.custodyWallet).toBe(f.wallet);
    process.env['BASE_CLAIM_V1_ENABLED'] = 'false';
    const unavailable = { ...f.readers, ownerOf: async () => { throw new Error('replay must not read'); } };
    expect(await executeBaseClaim(db, unavailable, f.buyer, f.request, () => { throw new Error('replay must not sample time'); })).toEqual(accepted);
  }, 15_000);

  it('the already-owned shortcut cannot promote an expired proof or create a receipt', async () => {
    const f = await fixture();
    await executeBaseClaim(db, f.readers, f.buyer, f.request, () => f.observedAt);
    f.request.idempotencyKey = randomUUID();
    const originalEvidence = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId));
    const originalReturn = await readStarterExpeditionReturn(db, f.trip.id);
    let at = f.observedAt;
    const result = await waitForLock(f, database => executeBaseClaim(database, f.readers, f.buyer, f.request, () => at), () => {
      at = new Date(at.getTime() + BASE_OWNERSHIP.mutationFreshnessMs + 1);
    });
    expect(result.error).toMatchObject({ code: 'BASE_CLAIM_UNAVAILABLE' });
    expect(await db.select().from(baseClaimCommands).where(eq(baseClaimCommands.requestKey, f.request.idempotencyKey))).toEqual([]);
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toEqual(originalEvidence);
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toEqual(originalReturn);
  }, 15_000);

  it('accepts exact TTL but retains original proof time/hash and immutable identity', async () => {
    const f = await fixture(), originalProof = { ...f.proof }; let at = f.observedAt;
    const result = await waitForLock(f, database => executeBaseClaim(database, f.readers, f.buyer, f.request, () => at), () => {
      f.proof.owner = pubkey(); f.proof.slot += 1; f.proof.frozen = true;
      at = new Date(at.getTime() + BASE_OWNERSHIP.mutationFreshnessMs);
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ outcome: 'claimed', createdAt: at.toISOString(), ownership: { owner: f.buyer, slot: String(originalProof.slot) } });
    const [evidence] = await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId));
    expect(evidence).toMatchObject({ owner: f.buyer, checkedAt: f.observedAt,
      auditHash: observationHash(f.deed, f.buyer, 'owned', BigInt(originalProof.slot), f.observedAt) });
    expect((await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!.updatedAt).toEqual(at);
  }, 15_000);

  it.each(['boundary', 'expired', 'future', 'missing-policy'] as const)('SQL receipt guard enforces original receive age: %s', async mode => {
    const f = await fixture();
    const original = await executeBaseClaim(db, f.readers, f.buyer, f.request, () => f.observedAt);
    const requestKey = randomUUID();
    const age = mode === 'future' ? -1 : BASE_OWNERSHIP.mutationFreshnessMs + (mode === 'expired' ? 1 : 0);
    const admittedAt = new Date(f.observedAt.getTime() + age);
    const receipt = { ...original, idempotencyKey: requestKey, request: { ...original.request, idempotencyKey: requestKey },
      outcome: 'already_owned' as const, transferId: null, fromWallet: null, createdAt: admittedAt.toISOString() };
    const write = db.transaction(async tx => {
      if (mode === 'missing-policy') await tx.execute(sql`select set_config('shardkeep.deed_mutation_freshness_ms', '', true)`);
      await tx.insert(baseClaimCommands).values({ actorWallet: f.buyer, requestKey, receipt, createdAt: admittedAt });
    });
    if (mode === 'boundary') {
      await write;
      expect((await db.select().from(baseClaimCommands).where(eq(baseClaimCommands.requestKey, requestKey)))[0]!.receipt).toEqual(receipt);
    } else {
      await expect(write).rejects.toThrow();
      expect(await db.select().from(baseClaimCommands).where(eq(baseClaimCommands.requestKey, requestKey))).toEqual([]);
    }
    // The receipt guard never refreshes old ownership while deciding admission.
    expect((await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId)))[0]!.checkedAt).toEqual(f.observedAt);
  });

  it.each(['expired', 'future', 'nonfinite', 'infinite', 'unsafe', 'missing'] as const)('canonical transfer refuses %s receive time instead of substituting now', async variant => {
    const f = await fixture(), now = f.observedAt.getTime();
    const stamp = { expired: now - BASE_OWNERSHIP.mutationFreshnessMs - 1, future: now + 1,
      nonfinite: NaN, infinite: Infinity, unsafe: Number.MAX_SAFE_INTEGER + 1, missing: undefined }[variant];
    await expect(transferStableBase(db, f.baseId, f.wallet, f.buyer, f.deed,
      { ...f.proof, observedAtMs: stamp as number }, () => f.observedAt)).rejects.toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await unchanged(f);
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toEqual([]);
  });

  it('fresh wall time does not override a newer finalized onward-sale slot', async () => {
    const f = await fixture(), onward = pubkey();
    const result = await waitForLock(f, database => executeBaseClaim(database, f.readers, f.buyer, f.request, () => f.observedAt), () => {}, 'base', async tx => {
      await tx.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: f.deed, owner: onward,
        slot: BigInt(f.proof.slot + 1), checkedAt: f.observedAt, source: 'test-onward', status: 'mismatch', auditHash: 'test-onward' });
    });
    expect(result.error).toMatchObject({ code: 'BASE_CLAIM_UNAVAILABLE' });
    await unchanged(f);
    expect((await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId)))[0]!.owner).toBe(onward);
  }, 15_000);

  it.each(['legacy-claim', 'reserved-recovery'] as const)('%s transports the actual response timestamp through later transaction waits', async path => {
    const f = await fixture(); let at = f.observedAt;
    if (path === 'reserved-recovery') await db.update(bases).set({ deedAssetId: null, deedMintAssetId: f.deed }).where(eq(bases.id, f.baseId));
    const result = await waitForLock(f, database => path === 'legacy-claim'
      ? claimBase(database, f.readers, f.buyer, () => at)
      : registerOwnedDeed(database, f.buyer, f.deed, { ownerOf: f.readers.ownerOf, expectedCollection: f.readers.collection, clock: () => at }), () => {
      expect(f.readers.ownerOf).toHaveBeenCalledTimes(path === 'legacy-claim' ? 2 : 1);
      at = new Date(at.getTime() + BASE_OWNERSHIP.mutationFreshnessMs + 1);
    });
    expect(result.error).toMatchObject({ code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await unchanged(f);
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toEqual([]);
    if (path === 'reserved-recovery') expect((await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!.deedAssetId).toBeNull();
  }, 15_000);
});
