/** Real Postgres tests. Requires migration 0299_devnet_skr_faucet and P2;
 * never run during device/C2 holds or against a shared/production database. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SKR_FAUCET } from '@shardkeep/shared';
import { bases, players, baseSlots, deedOwnershipObservations, ledgerTransactions, baseAbandons, fantasyRetirementExclusions, devnetSkrFaucetGrants as grants,
  devnetSkrFaucetAttempts as attempts } from '../src/db/schema';
import { makeSkrFaucetStore, lockSkrClaimAdmission, readSkrDeedEligibility, refreshSkrClaimDeed, deedlessSkrClaimKey,
  type SkrGrantUnit } from '../src/devnet-only/skrFaucetStore';
import { makeSkrFaucetService, processSkrFaucetGrant } from '../src/devnet-only/skrFaucet';
import { recordedDeedRefusal } from '../src/game/recordedDeed';
import { isolatedFantasyTestDb } from './fantasy-test-db';
import { mint, referenceMessage, testRpc, policy, signPrepared, faucet } from './skr-faucet-fixtures';

const conn = isolatedFantasyTestDb(), now = new Date('2026-10-02T12:00:00Z');
beforeAll(async () => { await conn.prepare(); }, 120_000);
afterAll(async () => { await conn.dispose(); });
async function ownedBase(withDeed = true) {
  const signer = Keypair.generate(), wallet = signer.publicKey.toBase58(), deed = Keypair.generate().publicKey.toBase58();
  await conn.db.insert(players).values({ wallet });
  const [base] = await conn.db.insert(bases).values({ ownerWallet: wallet, landPaidAt: now, deedAssetId: withDeed ? deed : null, deedMintAssetId: withDeed ? deed : null }).returning();
  if (!base) throw new Error('missing fixture base');
  await conn.db.insert(baseSlots).values({ wallet, slot: 1, baseId: base.id, active: true });
  await conn.db.insert(deedOwnershipObservations).values({ baseId: base.id, assetId: deed, owner: wallet,
    slot: 100n, checkedAt: now, source: 'test-finalized-reader', status: 'owned', auditHash: 'test-finalized-proof' });
  return { wallet, signer, base, deed };
}
async function retainedGrant() {
  const owned = await ownedBase();
  const [grant] = await conn.db.insert(grants).values({ wallet: owned.wallet, baseId: owned.base.id,
    deedAssetId: owned.deed, day: '2026-10-02', requestedAt: now, mint, decimals: 6, amountRaw: '1000000000' }).returning();
  if (!grant) throw new Error('missing fixture grant'); return { ...owned, grant };
}
async function attemptFor(grant: typeof grants.$inferSelect) {
  const reference = Keypair.generate().publicKey.toBase58(), built = referenceMessage(grant, reference);
  const [attempt] = await conn.db.insert(attempts).values({ grantId: grant.id, attemptNo: 1, reference,
    message: built.message, recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(85)).publicKey.toBase58(), lastValidBlockHeight: 200n, createdAt: now }).returning();
  if (!attempt) throw new Error('missing fixture attempt'); return attempt;
}

describe.sequential('SKR faucet Postgres selection, authority and immutability', () => {
  it('skips twenty claim-only reservations and sweeps later live work; cursor passes unknown work instead of starving later rows', async () => {
    const store = makeSkrFaucetStore(conn.db);
    for (let index = 0; index < SKR_FAUCET.devnet.maxGrantsPerSweep; index++) await retainedGrant();
    const first = await retainedGrant(), second = await retainedGrant(); await attemptFor(first.grant); await attemptFor(second.grant);
    const page1 = await store.pending(1, undefined, now); expect(page1).toHaveLength(1);
    const page2 = await store.pending(1, page1[0], now); expect(page2).toHaveLength(1);
    expect(new Set([...page1, ...page2].map((row) => row.id))).toEqual(new Set([first.grant.id, second.grant.id]));
    expect(await store.pending(1, page2[0], now)).toHaveLength(0);
    // Each test leaves its retained original; terminalize the two live rows legitimately.
    for (const row of [first, second]) await store.withGrant(row.grant.id, null, async (unit) => {
      await unit.updateAttempt(unit.attempts[0]!.id, { phase: 'abandoned', settledAt: now }); await unit.updateGrant({ status: 'failed', error: 'test_complete' });
    });
  });
  it('twenty parallel claims reserve one row and nineteen specific 429 daily conflicts', async () => {
    const owned = await ownedBase(), store = makeSkrFaucetStore(conn.db), chain = testRpc();
    const service = makeSkrFaucetService(policy, store, chain.rpc, { now: () => now,
      eligibility: (wallet, id, at) => readSkrDeedEligibility(conn.db, wallet, id, at), refreshDeed: async () => owned.deed });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.claim(owned.wallet, owned.base.id)));
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((row) => row.status === 'rejected'); expect(rejected).toHaveLength(19);
    for (const row of rejected) if (row.status === 'rejected') expect(row.reason).toMatchObject({ statusCode: 429, code: 'SKR_FAUCET_DAILY_LIMIT' });
    expect(await conn.db.select().from(grants).where(eq(grants.wallet, owned.wallet))).toHaveLength(1);
  });
  it('retains wallet/day and deed/day uniqueness even when a writer omits application locks', async () => {
    const { grant } = await retainedGrant(), other = await ownedBase();
    await expect(conn.db.insert(grants).values({ wallet: grant.wallet, baseId: grant.baseId, deedAssetId: other.deed,
      day: grant.day, requestedAt: now, mint, decimals: 6, amountRaw: grant.amountRaw })).rejects.toThrow();
    await expect(conn.db.insert(grants).values({ wallet: other.wallet, baseId: other.base.id, deedAssetId: grant.deedAssetId,
      day: grant.day, requestedAt: now, mint, decimals: 6, amountRaw: grant.amountRaw })).rejects.toThrow();
    expect(await conn.db.select().from(grants).where(eq(grants.wallet, other.wallet))).toHaveLength(0);
  });
  it('refuses paid deedless, quarantined legacy, inactive slot and another wallet before any grant exists', async () => {
    const free = await ownedBase(false), legacy = await ownedBase(false), inactive = await ownedBase(), other = await ownedBase();
    const store = makeSkrFaucetStore(conn.db);
    const input = (owned: Awaited<ReturnType<typeof ownedBase>>) => ({ wallet: owned.wallet, baseId: owned.base.id,
      refreshedDeed: owned.deed, enteredAt: now, mint, decimals: 6, amountRaw: '1000000000' });
    await expect(store.reserve(input(free), () => now)).rejects.toMatchObject({ statusCode: 409 });
    await conn.db.update(bases).set({ deedMintAssetId: `legacy-unknown:${legacy.base.id}` }).where(eq(bases.id, legacy.base.id));
    await expect(store.reserve(input(legacy), () => now)).rejects.toMatchObject({ statusCode: 503 });
    // A quarantined identity is deliberately not reset: 0072 forbids that.
    await conn.db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, inactive.base.id));
    await expect(store.reserve(input(inactive), () => now)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.reserve({ ...input(other), wallet: free.wallet }, () => now)).rejects.toMatchObject({ statusCode: 404 });
    for (const owned of [free, legacy, inactive]) expect(await conn.db.select().from(grants).where(eq(grants.wallet, owned.wallet))).toHaveLength(0);
  });
  it('refuses stale/future finalized observations and a UTC day change during reservation locks', async () => {
    const owned = await ownedBase(), store = makeSkrFaucetStore(conn.db);
    const input = { wallet: owned.wallet, baseId: owned.base.id, refreshedDeed: owned.deed, enteredAt: now, mint, decimals: 6, amountRaw: '1000000000' };
    for (const checkedAt of [new Date(now.getTime() - 600_000), new Date(now.getTime() + 1)]) {
      await conn.db.insert(deedOwnershipObservations).values({ baseId: owned.base.id, assetId: owned.deed, owner: owned.wallet,
        slot: 101n, checkedAt, source: 'test-finalized-reader', status: 'owned', auditHash: 'test-invalid-clock' });
      // Supplied observation is deliberately the selected latest row for this test.
      await conn.db.update(deedOwnershipObservations).set({ checkedAt }).where(eq(deedOwnershipObservations.baseId, owned.base.id));
      await expect(store.reserve(input, () => now)).rejects.toMatchObject({ statusCode: 503 });
    }
    await conn.db.update(deedOwnershipObservations).set({ checkedAt: new Date('2026-10-03T00:00:00Z') }).where(eq(deedOwnershipObservations.baseId, owned.base.id));
    await expect(store.reserve({ ...input, enteredAt: new Date('2026-10-02T23:59:59.999Z') }, () => new Date('2026-10-03T00:00:00Z')))
      .rejects.toMatchObject({ code: 'SKR_FAUCET_DAY_CHANGED' });
    expect(await conn.db.select().from(grants).where(eq(grants.wallet, owned.wallet))).toHaveLength(0);
  });
  it("enforces one live attempt and immutable originals while retaining the contract's TRUNCATE cleanup path", async () => {
    const { grant } = await retainedGrant(), attempt = await attemptFor(grant);
    await expect(conn.db.insert(attempts).values({ grantId: grant.id, attemptNo: 2, message: attempt.message,
      reference: Keypair.generate().publicKey.toBase58(), recentBlockhash: attempt.recentBlockhash, lastValidBlockHeight: 201n })).rejects.toThrow();
    await expect(conn.db.update(attempts).set({ message: Buffer.from('changed') }).where(eq(attempts.id, attempt.id))).rejects.toThrow();
    await expect(conn.db.update(grants).set({ amountRaw: '999' }).where(eq(grants.id, grant.id))).rejects.toThrow();
    await expect(conn.db.delete(attempts).where(eq(attempts.id, attempt.id))).rejects.toThrow();
    await expect(conn.db.delete(grants).where(eq(grants.id, grant.id))).rejects.toThrow();
    const store = makeSkrFaucetStore(conn.db); await store.withGrant(grant.id, null, async (unit) => {
      await unit.updateAttempt(attempt.id, { phase: 'abandoned', settledAt: now }); await unit.updateGrant({ status: 'failed', error: 'test_complete' });
    });
    await expect(conn.db.update(attempts).set({ phase: 'prepared', settledAt: null }).where(eq(attempts.id, attempt.id))).rejects.toThrow();
    await expect(conn.db.update(grants).set({ status: 'requested', error: null }).where(eq(grants.id, grant.id))).rejects.toThrow();
    const rollback = new Error('rollback test-only successful truncate');
    await expect(conn.db.transaction(async (tx) => {
      await tx.execute(sql`TRUNCATE devnet_skr_faucet_grants CASCADE`);
      expect(await tx.select().from(grants)).toHaveLength(0); expect(await tx.select().from(attempts)).toHaveLength(0);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});

describe.sequential('SKR faucet real transaction lifecycle', () => {
  it('twenty parallel prepares return one original and twenty submissions retain one player wire', async () => {
    const owned = await retainedGrant(), store = makeSkrFaucetStore(conn.db), chain = testRpc();
    const service = makeSkrFaucetService(policy, store, chain.rpc, { now: () => now,
      eligibility: async () => ({ reason: 'ok', deed: owned.deed }), refreshDeed: async () => owned.deed });
    const prepared = await Promise.all(Array.from({ length: 20 }, () => service.prepare(owned.wallet, owned.grant.id)));
    const one = prepared[0]!; expect(new Set(prepared.map((row) => row.grant.attempt?.id)).size).toBe(1);
    expect(new Set(prepared.map((row) => row.unsignedTransaction)).size).toBe(1);
    const wire = signPrepared(one.unsignedTransaction, owned.signer), attemptId = one.grant.attempt!.id;
    const submitted = await Promise.all(Array.from({ length: 20 }, () => service.submit(owned.wallet, attemptId, wire)));
    expect(submitted.every((row) => row.grant.attempt?.phase === 'player_signed')).toBe(true);
    const rows = await conn.db.select().from(attempts).where(eq(attempts.grantId, owned.grant.id)); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'player_signed', playerWire: Buffer.from(wire, 'base64'), faucetWire: null });
  });
  it('persists submitted bytes before send and twenty real grant locks cannot create another signature', async () => {
    const owned = await retainedGrant(), store = makeSkrFaucetStore(conn.db), chain = testRpc();
    const service = makeSkrFaucetService(policy, store, chain.rpc, { now: () => now,
      eligibility: async () => ({ reason: 'ok', deed: owned.deed }), refreshDeed: async () => owned.deed });
    const prepared = await service.prepare(owned.wallet, owned.grant.id), attemptId = prepared.grant.attempt!.id;
    await service.submit(owned.wallet, attemptId, signPrepared(prepared.unsignedTransaction, owned.signer));
    const committedAtSend: boolean[] = [];
    chain.methods.sendRawTransaction.mockImplementation(async (wire) => {
      // Separate connection read cannot see uncommitted submitted bytes. Record
      // the verdict outside the callback: send errors are intentionally caught.
      const [persisted] = await conn.db.select().from(attempts).where(eq(attempts.id, attemptId));
      committedAtSend.push(persisted?.phase === 'submitted' && persisted.faucetWire?.equals(Buffer.from(wire)) === true);
      throw new Error('simulated ambiguous send');
    });
    await Promise.all(Array.from({ length: 20 }, () => processSkrFaucetGrant(policy, store, chain.rpc, faucet, owned.grant.id, () => now)));
    const retained = await conn.db.select().from(attempts).where(eq(attempts.grantId, owned.grant.id));
    expect(retained).toHaveLength(1); expect(retained[0]!.phase).toBe('submitted');
    expect(committedAtSend.length).toBeGreaterThan(0); expect(committedAtSend.every(Boolean)).toBe(true);
    expect(new Set(chain.methods.sendRawTransaction.mock.calls.map(([wire]) => Buffer.from(wire).toString('base64'))).size).toBe(1);
  });
  it('serializes distinct grants at the real mint lock when only one additional grant fits the budget', async () => {
    const first = await retainedGrant(), second = await retainedGrant(), store = makeSkrFaucetStore(conn.db), chain = testRpc();
    expect(first.wallet).not.toBe(second.wallet); expect(first.deed).not.toBe(second.deed); expect(first.grant.id).not.toBe(second.grant.id);
    for (const owned of [first, second]) {
      const service = makeSkrFaucetService(policy, store, chain.rpc, { now: () => now,
        eligibility: async () => ({ reason: 'ok', deed: owned.deed }), refreshDeed: async () => owned.deed });
      const prepared = await service.prepare(owned.wallet, owned.grant.id);
      await service.submit(owned.wallet, prepared.grant.attempt!.id, signPrepared(prepared.unsignedTransaction, owned.signer));
    }
    // Earlier cases retain originals. Count that committed baseline explicitly;
    // this race has headroom for exactly ONE additional grant, never two.
    const baseline = await store.withGrant(first.grant.id, null, (unit) => unit.tallies(mint, first.grant.day), mint);
    const scale = 10n ** BigInt(first.grant.decimals), beforeRaw = baseline.reservedDayRaw + baseline.sentTodayRaw;
    expect(beforeRaw % scale).toBe(0n);
    const budgetSkr = Number(beforeRaw / scale) + SKR_FAUCET.devnet.grantSkr;
    expect(Number.isSafeInteger(budgetSkr)).toBe(true);
    const boundedPolicy = { ...policy, dailyBudgetSkr: budgetSkr };
    const backendPids: number[] = [], snapshots = new Map<string, Awaited<ReturnType<SkrGrantUnit['tallies']>>>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Observe the two actual transaction backends before the store takes its
    // lock. Do not introduce another lock or replace real DB tally queries.
    const observedDb = new Proxy(conn.db, { get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (run: Parameters<typeof conn.db.transaction>[0]) => conn.db.transaction(async (tx) => {
        const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        backendPids.push(row!.pid); return run(tx);
      });
    } });
    const observedStore = makeSkrFaucetStore(observedDb);
    const pausedStore: typeof store = { ...observedStore,
      withGrant: <T>(id: string, wallet: string | null, run: (unit: SkrGrantUnit) => Promise<T>, treasuryMint?: string): Promise<T> =>
        observedStore.withGrant(id, wallet, (unit) => run({ ...unit, tallies: async (selectedMint, day) => {
          const totals = await unit.tallies(selectedMint, day); snapshots.set(id, totals);
          await gate; return totals;
        } }), treasuryMint),
    };
    const running: Array<Promise<PromiseSettledResult<void>>> = [];
    const start = (id: string) => running.push(processSkrFaucetGrant(boundedPolicy, pausedStore, chain.rpc, faucet, id, () => now)
      .then((value) => ({ status: 'fulfilled' as const, value }), (reason: unknown) => ({ status: 'rejected' as const, reason })));
    let boundary: 'mint_lock' | 'dual_snapshot' | undefined, completed: PromiseSettledResult<void>[] = [];
    try {
      start(first.grant.id);
      await expect.poll(() => snapshots.has(first.grant.id), { timeout: 5_000 }).toBe(true);
      start(second.grant.id);
      await expect.poll(async () => {
        // Mutation witness: without the mint lock both independent grant rows
        // can reach their real zero-headroom-consumed snapshots before release.
        if (snapshots.has(second.grant.id)) { boundary = 'dual_snapshot'; return true; }
        if (backendPids.length !== 2) return false;
        const [row] = await conn.sql<{ blocked: boolean }[]>`
          SELECT ${backendPids[0]!}::integer = ANY(pg_blocking_pids(pid))
            AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%' AS blocked
          FROM pg_stat_activity WHERE datname = current_database() AND pid = ${backendPids[1]!}::integer`;
        if (row?.blocked) { boundary = 'mint_lock'; return true; }
        return false;
      }, { timeout: 5_000 }).toBe(true);
    } finally {
      release(); completed = await Promise.all(running);
    }
    expect(completed).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    const a = await store.readGrant(first.grant.id, first.wallet), b = await store.readGrant(second.grant.id, second.wallet);
    expect(a.attempts).toHaveLength(1); expect(b.attempts).toHaveLength(1);
    expect(a.attempts[0]).toMatchObject({ phase: 'submitted', faucetWire: expect.any(Buffer) });
    expect(b.attempts[0]).toMatchObject({ phase: 'player_signed', faucetWire: null });
    expect(b.grant).toMatchObject({ status: 'requested', error: 'daily_budget' });
    expect(chain.methods.sendRawTransaction).toHaveBeenCalledTimes(1);
    const after = await store.withGrant(first.grant.id, null, (unit) => unit.tallies(mint, first.grant.day), mint);
    expect(after.reservedDayRaw + after.sentTodayRaw).toBe(BigInt(budgetSkr) * scale);
    expect(snapshots.get(first.grant.id)).toEqual(baseline);
    expect(snapshots.get(second.grant.id)?.reservedDayRaw).toBe(baseline.reservedDayRaw + BigInt(first.grant.amountRaw));
    expect(new Set(backendPids).size).toBe(2); expect(boundary).toBe('mint_lock');
  }, 20_000);
});


describe.sequential('recorded deed daily cap across custody', () => {
  it('refuses an active retired deed by base or mint identity', async () => {
    for (const viaMint of [false, true]) {
      const claimant = await ownedBase(), other = viaMint ? await ownedBase() : null;
      // 0118 requires one exact receipt instant, no earlier than the base,
      // and the excluded base's actual attached mint. Preserve those fences.
      const retiredAt = new Date(Math.max(Date.now(), claimant.base.createdAt.getTime()) + 1000);
      const [receipt] = await conn.db.insert(ledgerTransactions).values({ type: 'retire.scripted-deed',
        idempotencyKey: `skr-retirement-test:${randomUUID()}`, metadata: { wallet: claimant.wallet }, createdAt: retiredAt }).returning();
      const [abandon] = await conn.db.insert(baseAbandons).values({ playerWallet: claimant.wallet, priorKeepLevel: 1,
        priorExpansions: 0, buildingsDeleted: 0, obstaclesTombstoned: 0, jobsDeleted: 0, createdAt: retiredAt }).returning();
      expect(receipt!.createdAt).toEqual(abandon!.createdAt);
      await conn.db.insert(fantasyRetirementExclusions).values({ baseId: claimant.base.id, mintId: claimant.base.deedAssetId,
        receiptId: receipt!.id, abandonReceiptId: abandon!.id, evidenceHash: 'a'.repeat(64), createdAt: retiredAt });
      if (other) {
        // A second base cannot persist the retired mint. Exercise only the
        // predicate's input to isolate its mint OR branch, as P2 rev2 does.
        expect(await recordedDeedRefusal(conn.db, { ...other.base, deedAssetId: claimant.deed })).toBe('RETIRED_DEED');
        expect((await readSkrDeedEligibility(conn.db, other.wallet, other.base.id, now)).reason).toBe('ok');
      } else {
        expect(await recordedDeedRefusal(conn.db, { ...claimant.base,
          deedAssetId: Keypair.generate().publicKey.toBase58() })).toBe('RETIRED_DEED');
      }
      const store = makeSkrFaucetStore(conn.db);
      expect((await readSkrDeedEligibility(conn.db, claimant.wallet, claimant.base.id, now)).reason).toBe('retired_deed');
      await expect(store.reserve({ wallet: claimant.wallet, baseId: claimant.base.id, refreshedDeed: claimant.deed,
        enteredAt: now, mint, decimals: 6, amountRaw: '1000000000' }, () => now)).rejects.toMatchObject({ statusCode: 409 });
      expect(await conn.db.select().from(grants).where(eq(grants.wallet, claimant.wallet))).toHaveLength(0);
    }
  });
  it('keeps the deed-day consumed after resale and permits only the next UTC day', async () => {
    const seller = await retainedGrant(), buyer = Keypair.generate().publicKey.toBase58(), store = makeSkrFaucetStore(conn.db);
    await conn.db.insert(players).values({ wallet: buyer });
    // Fixture custody handoff updates the existing slot and finalized fact; the
    // grant itself must keep the seller, original deed and reserved day.
    await conn.db.transaction(async (tx) => {
      await tx.update(bases).set({ ownerWallet: buyer }).where(eq(bases.id, seller.base.id));
      await tx.update(baseSlots).set({ wallet: buyer }).where(eq(baseSlots.baseId, seller.base.id));
      await tx.update(deedOwnershipObservations).set({ owner: buyer, slot: 101n, checkedAt: now }).where(eq(deedOwnershipObservations.baseId, seller.base.id));
    });
    const input = { wallet: buyer, baseId: seller.base.id, refreshedDeed: seller.deed, enteredAt: now, mint, decimals: 6, amountRaw: '1000000000' };
    expect(await store.reserve(input, () => now)).toMatchObject({ conflict: true, grant: { id: seller.grant.id, wallet: seller.wallet } });
    const tomorrow = new Date('2026-10-03T00:00:00Z');
    await conn.db.update(deedOwnershipObservations).set({ checkedAt: tomorrow }).where(eq(deedOwnershipObservations.baseId, seller.base.id));
    const next = await store.reserve({ ...input, enteredAt: tomorrow }, () => tomorrow);
    expect(next).toMatchObject({ conflict: false, grant: { wallet: buyer, day: '2026-10-03' } });
    expect(next.grant.id).not.toBe(seller.grant.id);
  });
});


describe.sequential('P5 M2 real SQL prior-day reservation split', () => {
  it('retains prior-day submitted floor debt while excluding it from the current grant-day budget', async () => {
    const owned = await retainedGrant(), store = makeSkrFaucetStore(conn.db), chain = testRpc();
    const service = makeSkrFaucetService(policy, store, chain.rpc, { now: () => now,
      eligibility: async () => ({ reason: 'ok', deed: owned.deed }), refreshDeed: async () => owned.deed });
    const prepared = await service.prepare(owned.wallet, owned.grant.id);
    await service.submit(owned.wallet, prepared.grant.attempt!.id, signPrepared(prepared.unsignedTransaction, owned.signer));
    const before = await store.withGrant(owned.grant.id, null, (unit) => unit.tallies(mint, '2026-10-03'));
    await processSkrFaucetGrant(policy, store, chain.rpc, faucet, owned.grant.id, () => now);
    const after = await store.withGrant(owned.grant.id, null, (unit) => unit.tallies(mint, '2026-10-03'));
    expect((await store.readGrant(owned.grant.id, owned.wallet)).attempts[0]?.phase).toBe('submitted');
    expect(after.reservedAllRaw - before.reservedAllRaw).toBe(BigInt(owned.grant.amountRaw));
    expect(after.reservedDayRaw).toBe(before.reservedDayRaw);
    expect(after.sentTodayRaw).toBe(before.sentTodayRaw);
    const sameDay = await store.withGrant(owned.grant.id, null, (unit) => unit.tallies(mint, owned.grant.day));
    expect(sameDay.reservedDayRaw).toBe(after.reservedAllRaw);
  });
});


// Owner N-045 (6 Oct 2026, 12:15 UTC): deedless SKR faucet claims on the QA chain lane (DEVNET_SKR_FAUCET_DEEDLESS_OK=true,
// devnet only, refused by loadConfig under NODE_ENV=production); production rule D153.290 ("a deedless player cannot claim")
// is unchanged. Why these pins matter: the switch is the only thing between a deedless tester and a test-SKR grant. Off, it
// must refuse exactly as before (even a forged deedless key); on, it must admit exactly a base with no deed at all (never a
// quarantined mint, never a deeded base without its fresh finalized proof); the one-claim-per-wallet-per-UTC-day limit holds.
describe.sequential('N-045 deedless claims behind the QA chain-lane switch', () => {
  const lane = (deedlessOk: boolean) => {
    const store = makeSkrFaucetStore(conn.db, { deedlessOk }), chain = testRpc();
    const service = makeSkrFaucetService(policy, store, chain.rpc, { now: () => now,
      eligibility: (wallet, id, at) => readSkrDeedEligibility(conn.db, wallet, id, at, deedlessOk),
      refreshDeed: (wallet, id) => refreshSkrClaimDeed(conn.db, wallet, id, null, null, () => now, deedlessOk) });
    return { store, service };
  };
  async function deedlessBase(paid: boolean) {
    const owned = await ownedBase(false);
    if (!paid) await conn.db.update(bases).set({ landPaidAt: null }).where(eq(bases.id, owned.base.id));
    return owned;
  }
  const input = (owned: Awaited<ReturnType<typeof ownedBase>>, refreshedDeed: string) => ({ wallet: owned.wallet, baseId: owned.base.id,
    refreshedDeed, enteredAt: now, mint, decimals: 6, amountRaw: '1000000000' });

  it('by default refuses a free or paid deedless base: 409 SKR_FAUCET_DEED_REQUIRED, status deed_required, no grant', async () => {
    for (const paid of [false, true]) {
      const owned = await deedlessBase(paid), { service } = lane(false); await service.prime();
      expect(await service.status(owned.wallet, owned.base.id)).toMatchObject({ eligible: false, reason: 'deed_required' });
      await expect(service.claim(owned.wallet, owned.base.id)).rejects.toMatchObject({ statusCode: 409, code: 'SKR_FAUCET_DEED_REQUIRED' });
      // The deedless key is no bypass without the switch, whichever store default is used.
      for (const store of [makeSkrFaucetStore(conn.db), lane(false).store]) {
        await expect(store.reserve(input(owned, deedlessSkrClaimKey(owned.base.id)), () => now))
          .rejects.toMatchObject({ statusCode: 409, code: 'SKR_FAUCET_DEED_REQUIRED' });
      }
      expect(await conn.db.select().from(grants).where(eq(grants.wallet, owned.wallet))).toHaveLength(0);
    }
  });
  it('with the switch admits a free or paid deedless base once per wallet per UTC day', async () => {
    for (const paid of [false, true]) {
      const owned = await deedlessBase(paid), { service } = lane(true); await service.prime();
      expect(await service.status(owned.wallet, owned.base.id)).toMatchObject({ eligible: true, reason: 'ok', today: null });
      const claimed = await service.claim(owned.wallet, owned.base.id);
      expect(claimed.grant).toMatchObject({ status: 'requested', mint, amountRaw: '1000000000', attempt: null });
      const rows = await conn.db.select().from(grants).where(eq(grants.wallet, owned.wallet));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ baseId: owned.base.id, deedAssetId: deedlessSkrClaimKey(owned.base.id), day: '2026-10-02' });
      await expect(service.claim(owned.wallet, owned.base.id)).rejects.toMatchObject({ statusCode: 429, code: 'SKR_FAUCET_DAILY_LIMIT' });
      expect(await service.status(owned.wallet, owned.base.id)).toMatchObject({ eligible: false, reason: 'sign_required' });
      expect(await conn.db.select().from(grants).where(eq(grants.wallet, owned.wallet))).toHaveLength(1);
    }
  });
  it('with the switch still refuses a quarantined mint, a stale deeded proof, and a deed minted after a deedless refresh', async () => {
    const { store, service } = lane(true); await service.prime();
    const legacy = await ownedBase(false);
    await conn.db.update(bases).set({ deedMintAssetId: `legacy-unknown:${legacy.base.id}` }).where(eq(bases.id, legacy.base.id));
    expect((await service.status(legacy.wallet, legacy.base.id)).reason).toBe('deed_unavailable');
    await expect(service.claim(legacy.wallet, legacy.base.id)).rejects.toMatchObject({ statusCode: 503, code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await expect(store.reserve(input(legacy, deedlessSkrClaimKey(legacy.base.id)), () => now)).rejects.toMatchObject({ statusCode: 503 });
    const stale = await ownedBase();
    await conn.db.update(deedOwnershipObservations).set({ checkedAt: new Date(now.getTime() - 600_000) })
      .where(eq(deedOwnershipObservations.baseId, stale.base.id));
    await expect(store.reserve(input(stale, stale.deed), () => now)).rejects.toMatchObject({ statusCode: 503 });
    await expect(store.reserve(input(stale, deedlessSkrClaimKey(stale.base.id)), () => now)).rejects.toMatchObject({ statusCode: 503 });
    const deeded = await ownedBase();
    await expect(store.reserve(input(deeded, deedlessSkrClaimKey(deeded.base.id)), () => now))
      .rejects.toMatchObject({ statusCode: 409, code: 'DEED_OWNERSHIP_CHANGED' });
    for (const owned of [legacy, stale, deeded]) expect(await conn.db.select().from(grants).where(eq(grants.wallet, owned.wallet))).toHaveLength(0);
  });
});
