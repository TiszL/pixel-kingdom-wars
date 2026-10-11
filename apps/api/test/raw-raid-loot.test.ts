/** D153.20: real canonical raid accounting over explicit synthetic fixtures.
 * No external services, authority-provider fallback or client award input. */
import { randomUUID } from 'node:crypto';
import { FORGE_INGOT } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS, PhaseERawResourceIdSchema, RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type DbTx } from '../src/db/client';
import { accounts, baseRaidLocks, bases, ledgerTransactions, raidLootReservations, raids,
  rawRaidSnapshots, rawRaidTerminals, resourceStocks } from '../src/db/schema';
import { freezeRawRaidLoot, readRawRaidProof, releaseRawRaidLoot, settleRawRaidLoot } from '../src/game/rawRaidLoot';
import { getSettledDeedRaidLoot, releaseDeedRaidLoot, reserveDeedRaidLoot, settleDeedRaidLoot } from '../src/game/raidLoot';
import { consumeRawStockReservation, readRawStockReservationRemainder, readResourceStockProof, releaseRawStockReservation } from '../src/game/resourceStock';
import { readStarterExpeditionReturn, settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { getOrCreateBaseAccount } from '../src/ledger';
import { createRawRaidFixture, rawStock, type RawRaidFixture } from './fixtures/rawRaid';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, createTestPlayer } from './helpers';
import { TEST_DATABASE_URL } from './db-url';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
const raw = PHASE_E_RAW_RESOURCE_IDS[0], divisor = BigInt(FORGE_INGOT.rawStockTheftDivisor);
const freeze = (f: RawRaidFixture, at = f.now) => db.transaction(tx => freezeRawRaidLoot(tx, f.raid.id, at));
const results = (f: RawRaidFixture) => [{ id: f.keepId!, type: 'keep' as const, destroyed: true, level: 1 }];
const settle = (f: RawRaidFixture) => db.transaction(tx => settleRawRaidLoot(tx, f.raid.id, results(f), f.now));
const cancel = (f: RawRaidFixture) => db.transaction(tx => releaseRawRaidLoot(tx, f.raid.id, f.now, 'cancelled'));
const reserveBoth = (f: RawRaidFixture) => reserveDeedRaidLoot(db, { raidId: f.raid.id, attackerBaseId: f.attackerBaseId, defenderBaseId: f.defenderBaseId, now: f.now });
const lock = (f: RawRaidFixture) => db.select().from(baseRaidLocks).where(eq(baseRaidLocks.baseId, f.defenderBaseId));
const balances = async () => db.select({ id: accounts.id, balance: accounts.balance }).from(accounts).orderBy(asc(accounts.id));

describe.sequential('canonical frozen raw raid awards', () => {
  it('freezes all eight resources and posts24 zero-sum legs with exact floor rounding', async () => {
    const stocks = Object.fromEntries(PHASE_E_RAW_RESOURCE_IDS.map((id, i) => [id, divisor * BigInt(i + 1) + divisor - 1n]));
    const f = await createRawRaidFixture(db, { stocks });
    const frozen = await freeze(f);
    expect(frozen!.resources).toHaveLength(PHASE_E_RAW_RESOURCE_IDS.length);
    expect(frozen!.snapshot).toMatchObject({ frozenDivisor: FORGE_INGOT.rawStockTheftDivisor, theftVersion: FORGE_INGOT.rawStockTheftVersion, frozenAt: f.now, keepId: f.keepId });
    const proof = await settle(f);
    expect(proof!.entries).toHaveLength(PHASE_E_RAW_RESOURCE_IDS.length * 3);
    for (const [i, id] of PHASE_E_RAW_RESOURCE_IDS.entries()) {
      const amount = BigInt(i + 1), entries = proof!.entries.filter(e => e.resourceId === id);
      expect(entries.reduce((sum, e) => sum + e.delta, 0n)).toBe(0n);
      expect(await rawStock(db, f.attackerBaseId, id)).toEqual({ available: amount, reserved: 0n });
      expect(await rawStock(db, f.defenderBaseId, id)).toEqual({ available: stocks[id]! - amount, reserved: 0n });
    }
  });
  it('retains explicit zero-resource rows/legs without inventing stock', async () => {
    const f = await createRawRaidFixture(db, { stocks: {} }); await freeze(f);
    const proof = await settle(f);
    expect(proof!.terminal?.outcome).toBe('transferred');
    expect(proof!.entries).toHaveLength(PHASE_E_RAW_RESOURCE_IDS.length * 3);
    expect(proof!.entries.every(e => e.delta === 0n)).toBe(true);
    expect(await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.attackerBaseId))).toEqual([]);
  });
  it('uses available stock before any reserved units and never applies Vault/star modifiers', async () => {
    const f = await createRawRaidFixture(db, { stocks: { [raw]: divisor * 2n }, reservations: [{ resourceId: raw, quantity: divisor }] });
    const frozen = await freeze(f);
    expect(frozen!.allocations).toEqual([]);
    await reserveBoth(f);
    await settleDeedRaidLoot(db, f.raid.id, 0, [...results(f), { id: randomUUID(), type: 'vault', destroyed: false, level: 20 }], f.now);
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 2n });
    expect(await rawStock(db, f.defenderBaseId)).toEqual({ available: divisor - 2n, reserved: divisor });
    expect(await readRawStockReservationRemainder(db, f.reservations[0]!.operation.id)).toMatchObject({ lost: 0n, remaining: divisor });
  });
  it('uses exact creation-time then UUID order for claims and loses only allocated residual units', async () => {
    const ids = [randomUUID(), randomUUID()].sort();
    const olderId = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`;
    // Original claims precede the raid, which the fixture stamps at the current time.
    const createdAt = new Date(Date.now() - 3_600_000);
    const f = await createRawRaidFixture(db, { stocks: { [raw]: divisor * 3n }, reservations: [
      { id: ids[1]!, createdAt, resourceId: raw, quantity: divisor * 2n - 1n },
      { id: ids[0]!, createdAt, resourceId: raw, quantity: divisor },
      { id: olderId, createdAt: new Date(createdAt.getTime() - 1_000), resourceId: raw, quantity: 1n },
    ] });
    const proof = await freeze(f);
    expect(proof!.allocations.map(a => [a.reservationId, a.quantity])).toEqual([[ids[0], 2n], [olderId, 1n]]);
    await settle(f);
    expect(await readRawStockReservationRemainder(db, olderId)).toMatchObject({ lost: 1n, remaining: 0n });
    expect(await readRawStockReservationRemainder(db, ids[0]!)).toMatchObject({ lost: 2n, remaining: divisor - 2n });
    expect(await readRawStockReservationRemainder(db, ids[1]!)).toMatchObject({ lost: 0n, remaining: divisor * 2n - 1n });
  });
  it('impaired live claims cannot complete; release preserves original proof and returns residual', async () => {
    const f = await createRawRaidFixture(db, { stocks: { [raw]: divisor }, reservations: [{ resourceId: raw, quantity: divisor }] });
    const original = f.reservations[0]!; await freeze(f); await settle(f);
    await expect(consumeRawStockReservation(db, randomUUID(), original.operation.id)).rejects.toMatchObject({ code: 'RESOURCE_RESERVATION_IMPAIRED' });
    const released = await releaseRawStockReservation(db, randomUUID(), original.operation.id);
    expect(released.operation).toMatchObject({ quantity: divisor, effectiveQuantity: divisor - 1n });
    expect(await readResourceStockProof(db, original.operation.id)).toEqual(original);
    expect(await rawStock(db, f.defenderBaseId)).toEqual({ available: divisor - 1n, reserved: 0n });
  });
  it('follows released original units during a raid instead of substituting a different reservation', async () => {
    const f = await createRawRaidFixture(db, { stocks: { [raw]: divisor }, reservations: [{ resourceId: raw, quantity: divisor }] });
    await freeze(f);
    const released = await releaseRawStockReservation(db, randomUUID(), f.reservations[0]!.operation.id);
    const proof = await settle(f);
    expect(proof!.debits).toEqual([expect.objectContaining({ reservationId: f.reservations[0]!.operation.id,
      bucket: 'available', releaseOperationId: released.operation.id, quantity: 1n })]);
    expect(await readResourceStockProof(db, released.operation.id)).toEqual(released);
    expect(await rawStock(db, f.defenderBaseId)).toEqual({ available: divisor - 1n, reserved: 0n });
  });
  it.each(['different_keep', 'standing_keep', 'no_original_keep'] as const)('releases rather than paying for %s', async mode => {
    const f = await createRawRaidFixture(db, { keep: mode !== 'no_original_keep' }); await freeze(f);
    const result = [{ id: mode === 'different_keep' || !f.keepId ? randomUUID() : f.keepId, destroyed: mode !== 'standing_keep' }];
    const proof = await db.transaction(tx => settleRawRaidLoot(tx, f.raid.id, result, f.now));
    expect(proof!.terminal?.outcome).toBe('released'); expect(proof!.entries).toEqual([]);
    expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n });
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 0n });
  });
  it('rejects duplicate original Keep results before any award', async () => {
    const f = await createRawRaidFixture(db); await freeze(f);
    await expect(db.transaction(tx => settleRawRaidLoot(tx, f.raid.id, [...results(f), ...results(f)], f.now))).rejects.toThrow();
    expect((await readRawRaidProof(db, f.raid.id))!.terminal).toBeNull();
  });
  it('serializes concurrent freeze/settle and replays original proof after reconnect', async () => {
    const f = await createRawRaidFixture(db);
    const snapshots = await Promise.all([freeze(f), freeze(f)]); expect(snapshots[0]).toEqual(snapshots[1]);
    const proofs = await Promise.all([settle(f), settle(f)]); expect(proofs[0]).toEqual(proofs[1]);
    expect(await cancel(f)).toEqual(proofs[0]);
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 3n });
    const reopened = connectTestDb();
    try { expect(await readRawRaidProof(reopened.db, f.raid.id.toUpperCase())).toEqual(proofs[0]); }
    finally { await reopened.sql.end(); }
  });
  it('holds the raid lock before an empty terminal read can straddle another settlement', async () => {
    const f = await createRawRaidFixture(db); await freeze(f);
    const connectionA = createDb(TEST_DATABASE_URL, { max: 1, legacyTestEscape: true });
    const connectionB = createDb(TEST_DATABASE_URL, { max: 1, legacyTestEscape: true });
    let sawEmpty!: () => void, release!: () => void;
    const emptyTerminal = new Promise<void>(resolve => { sawEmpty = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let paused = false;
    type Outcome = { value: Awaited<ReturnType<typeof settleRawRaidLoot>> } | { error: unknown };
    let pendingA: Promise<Outcome> | undefined, pendingB: Promise<Outcome> | undefined;

    // TEST ONLY: the actual SELECT runs on A. Pause AFTER its real empty rows
    // arrive, then return the exact same rows. Never substitute DB results or
    // add a production seam. Preserve this wrapper across nested savepoints.
    function terminalQuery<T extends object>(query: T): T {
      return new Proxy(query, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === 'then') return (fulfilled: (rows: unknown[]) => unknown, rejected: (error: unknown) => unknown) =>
          (async () => {
            const rows = await (target as unknown as PromiseLike<unknown[]>);
            if (!paused) {
              expect(rows).toEqual([]);
              paused = true; sawEmpty(); await resume;
            }
            return rows;
          })().then(fulfilled, rejected);
        return typeof value === 'function' ? (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result && typeof result === 'object' ? terminalQuery(result) : result;
        } : value;
      } });
    }
    function instrument(tx: DbTx): DbTx {
      return new Proxy(tx, { get(target, key) {
        if (key === 'transaction') return (run: (inner: DbTx) => Promise<unknown>) =>
          target.transaction(inner => run(instrument(inner)));
        if (key === 'select') return (fields?: object) => {
          const select = fields ? target.select(fields as Parameters<DbTx['select']>[0]) : target.select();
          return new Proxy(select, { get(builder, property) {
            const value = Reflect.get(builder, property);
            if (property === 'from') return (table: unknown) => {
              const query = Reflect.apply(value, builder, [table]);
              if (table !== rawRaidTerminals) return query;
              if (!query || typeof query !== 'object') throw new Error('expected a terminal SELECT query');
              return terminalQuery(query);
            };
            return typeof value === 'function' ? value.bind(builder) : value;
          } });
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    try {
      const [aPid] = await connectionA.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const [bPid] = await connectionB.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(aPid!.pid).not.toBe(bPid!.pid);
      pendingA = connectionA.db.transaction(tx => settleRawRaidLoot(instrument(tx), f.raid.id, results(f), f.now))
        .then(value => ({ value }), (error: unknown) => ({ error }));
      await Promise.race([emptyTerminal, pendingA.then(outcome => {
        if ('error' in outcome) throw outcome.error;
        throw new Error('first settlement ended before the actual terminal read barrier');
      })]);
      pendingB = connectionB.db.transaction(tx => settleRawRaidLoot(tx, f.raid.id, results(f), f.now))
        .then(value => ({ value }), (error: unknown) => ({ error }));
      // Before the fix A paused without owning the raid row, so B could commit
      // and this exact blocker assertion failed. No sleep approximates order.
      await expect.poll(async () => {
        const [row] = await conn.sql<{ blocked: boolean }[]>`
          select ${aPid!.pid} = any(pg_blocking_pids(${bPid!.pid})) as blocked
        `;
        return row!.blocked;
      }, { timeout: 5_000 }).toBe(true);
      release();
      const [a, b] = await Promise.all([pendingA, pendingB]);
      if ('error' in a) throw a.error;
      if ('error' in b) throw b.error;
      expect(a.value?.terminal?.outcome).toBe('transferred');
      expect(b.value).toEqual(a.value);
      expect(await readRawRaidProof(db, f.raid.id)).toEqual(a.value);
      expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 3n });
      expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n - 3n });
    } finally {
      release();
      await Promise.allSettled([...(pendingA ? [pendingA] : []), ...(pendingB ? [pendingB] : [])]);
      await Promise.all([connectionA.sql.end(), connectionB.sql.end()]);
    }
  }, 15_000);
  it('cancels once and cannot later convert a released raid into a paid outcome', async () => {
    const f = await createRawRaidFixture(db); await freeze(f);
    const proof = await cancel(f); expect(await cancel(f)).toEqual(proof); expect(await settle(f)).toEqual(proof);
    expect(proof!.terminal?.outcome).toBe('released'); expect(proof!.debits).toEqual([]);
    expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n });
  });
  it('never creates an entitlement retroactively for a legacy terminal raid', async () => {
    const f = await createRawRaidFixture(db);
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, f.raid.id));
    expect(await settle(f)).toBeNull(); expect(await cancel(f)).toBeNull();
    await expect(freeze(f)).rejects.toThrow('raw raid cannot freeze after admission');
    expect(await readRawRaidProof(db, f.raid.id)).toBeNull();
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 0n });
  });
  it('requires the exact original incoming lock before freezing', async () => {
    const f = await createRawRaidFixture(db);
    await db.delete(baseRaidLocks).where(eq(baseRaidLocks.baseId, f.defenderBaseId));
    await expect(freeze(f)).rejects.toThrow('raw raid lacks original incoming lock');
    expect(await db.select().from(rawRaidSnapshots).where(eq(rawRaidSnapshots.raidId, f.raid.id))).toEqual([]);
  });
  it('does not enlarge an old award after a real accepted expedition returns', async () => {
    const expedition = await createStarterExpeditionFixture(db), trip = await expedition.dispatch();
    const resourceId = PhaseERawResourceIdSchema.parse(trip.resourceId);
    // The expedition keeps its synthetic future dispatch clock; the raid is
    // stamped at the real current time (no future raid since D153.235/238),
    // so it is still frozen before the trip is due, as before.
    const f = await createRawRaidFixture(db, { defender: { wallet: expedition.wallet, baseId: expedition.baseId },
      stocks: { [resourceId]: divisor * 2n } });
    const original = await freeze(f);
    await db.transaction(tx => settleDueStarterExpeditions(tx, f.defenderBaseId, trip.returnsAt));
    expect(await readStarterExpeditionReturn(db, trip.id)).not.toBeNull();
    const proof = await db.transaction(tx => settleRawRaidLoot(tx, f.raid.id, results(f), trip.returnsAt));
    expect(proof!.resources).toEqual(original!.resources);
    expect(await rawStock(db, f.attackerBaseId, resourceId)).toMatchObject({ available: 2n });
    expect(await rawStock(db, f.defenderBaseId, resourceId)).toMatchObject({ available: divisor * 2n + trip.net - 2n });
  });
  it('credits the original attacking base through changed custody, never its replacement base', async () => {
    const f = await createRawRaidFixture(db); await freeze(f); const buyer = await createTestPlayer(db);
    // Simulated completed custody transition, not an authority bypass API. The
    // actual transfer writer has separate integration tests.
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.attackerBaseId));
    const [replacement] = await db.insert(bases).values({ ownerWallet: f.attackerWallet, status: 'active' }).returning();
    await settle(f);
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 3n });
    expect(await rawStock(db, replacement!.id)).toMatchObject({ available: 0n });
  });
});

describe.sequential('raw and SHARDS settlement are one atomic boundary', () => {
  it('rejects whole-recipient overflow without clipping or creating any terminal proof', async () => {
    const f = await createRawRaidFixture(db); await freeze(f);
    await db.insert(resourceStocks).values({ baseId: f.attackerBaseId, resourceId: raw, available: RAW_RESOURCE_STORAGE_MAX });
    await expect(settle(f)).rejects.toThrow();
    expect((await readRawRaidProof(db, f.raid.id))!.terminal).toBeNull();
    expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n });
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: RAW_RESOURCE_STORAGE_MAX });
    expect(await lock(f)).toHaveLength(1);
  });
  it('cannot commit partial raw effects when the outer caller catches a mid-write failure', async () => {
    const f = await createRawRaidFixture(db); await freeze(f);
    await db.transaction(async tx => {
      // The terminal INSERT is visible before its24 entries only inside the
      // savepoint. Immediate constraints deliberately fault at that boundary.
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await expect(settleRawRaidLoot(tx, f.raid.id, results(f), f.now)).rejects.toThrow();
    });
    expect((await readRawRaidProof(db, f.raid.id))!.terminal).toBeNull();
    expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n });
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 0n });
    expect((await settle(f))!.terminal?.outcome).toBe('transferred');
  });
  it('rolls back raw debit/credit/receipt when a later outer game mutation fails', async () => {
    const f = await createRawRaidFixture(db); await freeze(f);
    await expect(db.transaction(async tx => {
      expect((await settleRawRaidLoot(tx, f.raid.id, results(f), f.now))!.terminal?.outcome).toBe('transferred');
      throw new Error('raid final status failed');
    })).rejects.toThrow('raid final status failed');
    expect((await readRawRaidProof(db, f.raid.id))!.terminal).toBeNull();
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 0n });
  });
  it('raw overflow preserves the SHARDS reservation and incoming lock for a later retry', async () => {
    const f = await createRawRaidFixture(db, { shards: 10_000n }); await reserveBoth(f);
    await getOrCreateBaseAccount(db, f.attackerBaseId, 'base_shards');
    await db.insert(resourceStocks).values({ baseId: f.attackerBaseId, resourceId: raw, available: RAW_RESOURCE_STORAGE_MAX });
    const before = await balances();
    await db.transaction(async tx => {
      await expect(settleDeedRaidLoot(tx, f.raid.id, 3, results(f), f.now)).rejects.toThrow();
    });
    expect(await balances()).toEqual(before);
    expect(await getSettledDeedRaidLoot(db, f.raid.id)).toBeNull();
    expect((await readRawRaidProof(db, f.raid.id))!.terminal).toBeNull();
    expect(await lock(f)).toHaveLength(1);
    // Synthetic recipient-space change permits exact original retry. No clipping.
    await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.attackerBaseId));
    const settled = await settleDeedRaidLoot(db, f.raid.id, 3, results(f), f.now);
    expect(settled.total).toBeGreaterThan(0n);
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 3n });
    expect(await lock(f)).toEqual([]);
  });
  it('a late SHARDS terminal fault rolls back the already-written RAW transfer even when caught', async () => {
    const f = await createRawRaidFixture(db, { shards: 10_000n }); await reserveBoth(f);
    await getOrCreateBaseAccount(db, f.attackerBaseId, 'base_shards');
    const before = await balances();
    const fn = `test_raw_shards_${randomUUID().replaceAll('-', '')}`;
    await conn.sql.unsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.raid_id = '${f.raid.id}'::uuid AND NEW.state = 'settled' THEN
        RAISE EXCEPTION 'test late SHARDS terminal failure'; END IF; RETURN NEW; END $$`);
    await conn.sql.unsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON raid_loot_reservations FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    try {
      await db.transaction(async tx => {
        await expect(settleDeedRaidLoot(tx, f.raid.id, 3, results(f), f.now)).rejects.toThrow();
      });
      expect(await balances()).toEqual(before);
      expect((await readRawRaidProof(db, f.raid.id))!.terminal).toBeNull();
      expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 0n });
      expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n });
      expect((await db.select().from(raidLootReservations).where(eq(raidLootReservations.raidId, f.raid.id)))[0]!.state).toBe('reserved');
      expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `raid:${f.raid.id}:loot-terminal`))).toEqual([]);
      expect(await lock(f)).toHaveLength(1);
    } finally {
      await conn.sql.unsafe(`DROP TRIGGER ${fn} ON raid_loot_reservations`);
      await conn.sql.unsafe(`DROP FUNCTION public.${fn}()`);
    }
    expect((await settleDeedRaidLoot(db, f.raid.id, 3, results(f), f.now)).total).toBeGreaterThan(0n);
  });
  it('combined cancellation restores SHARDS, closes raw proof and unlocks without transferring stock', async () => {
    const f = await createRawRaidFixture(db, { shards: 10_000n });
    const account = await getOrCreateBaseAccount(db, f.defenderBaseId, 'base_shards');
    await reserveBoth(f);
    expect(await releaseDeedRaidLoot(db, f.raid.id, f.now)).toBe(true);
    expect(await releaseDeedRaidLoot(db, f.raid.id, f.now)).toBe(true);
    expect((await db.select().from(accounts).where(eq(accounts.id, account.id)))[0]!.balance).toBe(10_000n);
    expect((await readRawRaidProof(db, f.raid.id))!.terminal?.outcome).toBe('released');
    expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n });
    expect(await rawStock(db, f.attackerBaseId)).toMatchObject({ available: 0n });
    expect(await lock(f)).toEqual([]);
  });
  it('rolls back a newly frozen raw snapshot when combined SHARDS admission fails', async () => {
    const f = await createRawRaidFixture(db);
    await db.transaction(async tx => {
      await expect(reserveDeedRaidLoot(tx, { raidId: f.raid.id, attackerBaseId: f.defenderBaseId,
        defenderBaseId: f.attackerBaseId, now: f.now })).rejects.toThrow('raid loot base identity mismatch');
    });
    expect(await readRawRaidProof(db, f.raid.id)).toBeNull();
    expect(await db.select().from(raidLootReservations).where(eq(raidLootReservations.raidId, f.raid.id))).toEqual([]);
    expect(await rawStock(db, f.defenderBaseId)).toMatchObject({ available: divisor * 3n });
  });
});
