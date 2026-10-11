/** Synthetic terms/seeded facilities exercise real DB closure and replacement.
 * They do not prove genuine Seeker admission, placement or runtime custody hooks. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_HARVESTER as P, PHASE_E_SEEKER_AUCTION as A } from '@shardkeep/shared';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, builderJobs, buildings, deedOwnershipObservations, deposits, fantasyLandClaims,
  harvesterEntries, harvesterEvents, harvesterSourceClosures, harvesterSourceHeads, players, resourceStocks } from '../src/db/schema';
import { closeHarvesterSources, readHarvesterSettlement, settleDueHarvesterSources } from '../src/game/harvesterSettlement';
import { selectHarvesterSource } from '../src/game/harvesterSources';
import { registerOwnedDeed } from '../src/game/baseOwnership';
import { installFantasyCatalog } from '../src/game/fantasyLocation';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { isolatedFantasyTestDb } from './fantasy-test-db';

// Realm replacement persists an assigned fantasy claim. That globally fences
// Earth presentation even with the flag off, so these immutable fixtures must
// live in their own database rather than contaminating later legacy suites.
const conn = isolatedFantasyTestDb(), db = conn.db, V1 = P.v1;
beforeAll(() => conn.prepare());
afterAll(() => conn.dispose());
async function fixture(wallet?: string) {
  const f = await createStarterExpeditionFixture(db, wallet === undefined ? {} : { wallet });
  const [b] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet,
    type: BuildingType.Harvester, tx: 9, ty: 2 }).returning();
  const completedAt = new Date(f.now.getTime() - 1_000);
  await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: b!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Harvester].buildSec * 1_000), finishesAt: completedAt, completedAt });
  return { ...f, buildingId: b!.id, command: { id: randomUUID(), baseId: f.baseId, harvesterId: b!.id, policyVersion: V1.policyVersion } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const reader = (f: Fixture) => ({ async readOperatingTerm() { return { snapshot: f.snapshot,
  finality: { commitment: 'finalized' as const, contextSlot: '200', observedAt: f.now.toISOString() } }; } });
const select = (f: Fixture, id = randomUUID()) => selectHarvesterSource(db, f.wallet, { ...f.command, id }, f.authority, { reader: reader(f), clock: () => f.now });
const after = (admittedAt: Date, cadence: number) => new Date(admittedAt.getTime() + cadence * V1.cadenceSec * 1_000);
const read = async (id: string) => (await readHarvesterSettlement(db, id))!;
const close = (f: Fixture, cutoff: Date) => db.transaction(tx => closeHarvesterSources(tx, f.baseId, cutoff, 'deactivation'));

it('pins the closure frontier to the frozen original v1 cadence', () => {
  const migration = readFileSync(new URL('../drizzle/0150_harvester_closures.sql', import.meta.url), 'utf8');
  expect(migration).toContain(`generate_series(1,${Math.floor(V1.maxLeaseSec / V1.cadenceSec)})`);
  expect(migration).toContain(`interval '${V1.cadenceSec} seconds'`);
});

describe('immutable Harvester closure and fresh replacement', () => {
  it('closes complete units and discards only incomplete cadence; historical replay survives later policy/custody', async () => {
    const f = await fixture(), source = await select(f, f.command.id), cutoff = after(source.admittedAt, 2.5);
    const [proof] = await close(f, cutoff);
    expect(proof!.closure).toMatchObject({ sourceId: source.id, cutoffAt: cutoff, processedOrdinal: 2, reason: 'deactivation' });
    expect(proof!.events).toHaveLength(2);
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, source.id))).toEqual([]);
    expect(await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(source.admittedAt, 20)))).toEqual([]);
    expect(await close(f, after(source.admittedAt, 30))).toEqual([]);
    expect(await read(source.id)).toEqual(proof);
    const buyer = Keypair.generate().publicKey.toBase58(); await db.insert(players).values({ wallet: buyer });
    await db.update(bases).set({ ownerWallet: buyer, status: 'inactive' }).where(eq(bases.id, f.baseId));
    expect(await selectHarvesterSource(db, f.wallet, f.command, f.authority, { clock: () => { throw new Error('must not sample replay'); } })).toEqual(source);
  });
  it('same-base source renewal preserves daily usage and carry without retrospective production', async () => {
    const f = await fixture(), source = await select(f);
    f.now = after(source.admittedAt, 4.5); const next = await select(f);
    expect((await read(source.id)).closure).toMatchObject({ cutoffAt: f.now, processedOrdinal: 4, reason: 'replacement' });
    expect(next.admittedAt).toEqual(f.now);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(next.admittedAt, 1)));
    expect((await read(next.id)).events[0]!.event).toMatchObject({ walletSequence: 5n, carryBefore: 8_000n, carryAfter: 0n, net: 0n, tax: 1n });
    const [usage] = await db.select({ gross: sql<string>`sum(${harvesterEvents.gross})::text` }).from(harvesterEvents).where(eq(harvesterEvents.actorWallet, f.wallet));
    expect(usage!.gross).toBe('5');
  });
  it('cross-base replacement credits the original base, preserves wallet carry and leaves one head', async () => {
    const a = await fixture(), first = await select(a);
    await db.update(baseSlots).set({ slot: 2 }).where(eq(baseSlots.baseId, a.baseId));
    const b = await fixture(a.wallet); b.now = after(first.admittedAt, 4); b.snapshot = a.snapshot;
    const second = await select(b);
    await db.transaction(tx => settleDueHarvesterSources(tx, b.baseId, after(second.admittedAt, 1)));
    expect((await read(first.id)).events).toHaveLength(4);
    expect((await read(second.id)).events[0]!.event).toMatchObject({ tax: 1n, net: 0n, carryBefore: 8_000n });
    expect((await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, a.baseId)))[0]!.available).toBe(4n);
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet, a.wallet))).toMatchObject([{ baseId: b.baseId, sourceId: second.id }]);
  });
  it('expired lease renewal starts now and retains all old units without filling the paused gap', async () => {
    const f = await fixture(), source = await select(f); f.now = after(source.admittedAt, 25);
    const next = await select(f), old = await read(source.id);
    expect(old.closure).toMatchObject({ reason: 'lease_expired', processedOrdinal: 15, cutoffAt: f.now });
    expect(next.admittedAt).toEqual(f.now); expect((await read(next.id)).events).toEqual([]);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, new Date(after(next.admittedAt, 1).getTime() - 1)));
    expect((await read(next.id)).events).toEqual([]);
  });
  it('a new term retains old fractional carry and attributes its completed tax unit to the new term', async () => {
    const f = await fixture(); f.now = new Date(Date.parse(f.snapshot.endsAt) - 4.5 * V1.cadenceSec * 1_000);
    const source = await select(f), oldTerm = f.snapshot;
    f.snapshot = { ...oldTerm, termId: randomUUID(), startsAt: oldTerm.endsAt,
      endsAt: new Date(Date.parse(oldTerm.endsAt) + Date.parse(oldTerm.endsAt) - Date.parse(oldTerm.startsAt)).toISOString(),
      source: { ...oldTerm.source, round: '2' } };
    f.now = new Date(f.snapshot.startsAt); const next = await select(f);
    expect((await read(source.id)).events).toHaveLength(4);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(next.admittedAt, 1)));
    expect((await read(next.id)).events[0]!.event).toMatchObject({ tax: 1n, carryBefore: 8_000n });
    expect((await read(next.id)).source.termId).toBe(f.snapshot.termId);
    expect((await read(source.id)).source.termId).toBe(oldTerm.termId);
  });
  it('an assigned deed home change selects its native resource without mixing the wallet resource carry lineages', async () => {
    const f = await fixture(), first = await select(f); f.now = after(first.admittedAt, 4);
    await db.transaction(tx => closeHarvesterSources(tx, f.baseId, f.now, 'realm_change'));
    await db.transaction(installFantasyCatalog);
    const mint = Keypair.generate().publicKey.toBase58();
    expect((await registerOwnedDeed(db, f.wallet, mint)).id).toBe(f.baseId);
    const used = new Set((await db.select().from(fantasyLandClaims)).map(claim => claim.tileId));
    const tile = [...fantasyTiles('elderwood')].find(tile => tile.allocation === 'ordinary' && !used.has(tile.tileId))!;
    const [deposit] = await db.insert(deposits).values({ playerWallet: f.wallet, kind: 'entry', reference: `harvester-home:${randomUUID()}`,
      status: 'credited', payload: { baseId: f.baseId } }).returning();
    await db.insert(fantasyLandClaims).values({ baseId: f.baseId, source: 'purchase', depositId: deposit!.id,
      worldId: tile.worldId, tileId: tile.tileId, state: 'assigned', assignedAt: f.now });
    await db.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: mint, owner: f.wallet, slot: 100n,
      checkedAt: new Date(), status: 'owned', source: 'rpc-finalized', auditHash: randomUUID() });
    const next = await select(f);
    expect(next.resourceId).toBe('heartwood_logs');
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(next.admittedAt, 1)));
    expect((await read(next.id)).events[0]!.event).toMatchObject({ gross: 1n, net: 1n, tax: 0n, carryBefore: 0n, carryAfter: 2_000n });
    expect((await read(first.id)).events.at(-1)!.event.carryAfter).toBe(8_000n);
  });
  it('foreign-actor target head refuses buyer selection until the true custody cutoff closes it', async () => {
    const f = await fixture(), first = await select(f), buyer = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet: buyer });
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: buyer }).where(eq(bases.id, f.baseId));
    await db.insert(baseSlots).values({ wallet: buyer, slot: 1, baseId: f.baseId });
    const buyerFixture = { ...f, wallet: buyer, now: after(first.admittedAt, 2) };
    await expect(select(buyerFixture)).rejects.toMatchObject({ code: 'HARVESTER_SOURCE_PENDING' });
    expect((await read(first.id)).closure).toBeNull();
    // Explicit synthetic boundary cutoff; selection itself did not invent it.
    await db.transaction(tx => closeHarvesterSources(tx, f.baseId, after(first.admittedAt, 1), 'custody_change'));
    const second = await select(buyerFixture);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(second.admittedAt, 1)));
    expect((await read(second.id)).events[0]!.event).toMatchObject({ actorWallet: buyer, walletSequence: 1n, carryBefore: 0n });
    expect((await read(first.id)).events[0]!.event.actorWallet).toBe(f.wallet);
  });
  it('storage overflow refuses closure and replacement without losing either source or earned obligations', async () => {
    const f = await fixture(), source = await select(f);
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: source.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    f.now = after(source.admittedAt, 2);
    await expect(select(f)).rejects.toThrow('overflow');
    expect((await read(source.id)).closure).toBeNull(); expect((await read(source.id)).events).toEqual([]);
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet, f.wallet))).toMatchObject([{ sourceId: source.id }]);
  });
  it('stale lock-wait observation rolls back old closure and refuses a replacement', async () => {
    const f = await fixture(), source = await select(f); f.now = after(source.admittedAt, 1);
    const observed = await reader(f).readOperatingTerm(); let held = false, release!: () => void, pid = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => { await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>; pid = row!.pid; held = true; await gate; });
    let work: Promise<unknown> | undefined;
    try {
      await expect.poll(() => held).toBe(true);
      work = selectHarvesterSource(db, f.wallet, { ...f.command, id: randomUUID() }, f.authority,
        { reader: { async readOperatingTerm() { return observed; } }, clock: () => f.now }).then(value => ({ value }), error => ({ error }));
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting).toBe(true);
      f.now = new Date(f.now.getTime() + A.observationMaxAgeMs + 1); release();
      expect(await work).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('stale') }) });
    } finally { release(); await Promise.allSettled([holder, ...(work ? [work] : [])]); }
    expect((await read(source.id)).closure).toBeNull(); expect((await read(source.id)).events).toEqual([]);
  });
  it('outer rollback restores old head and removes closure/new source/credits together', async () => {
    const f = await fixture(), source = await select(f); f.now = after(source.admittedAt, 3);
    const id = randomUUID();
    await expect(db.transaction(async tx => { await selectHarvesterSource(tx, f.wallet, { ...f.command, id }, f.authority,
      { reader: reader(f), clock: () => f.now }); throw new Error('outer rollback'); })).rejects.toThrow('outer rollback');
    expect(await readHarvesterSettlement(db, id)).toBeNull(); expect((await read(source.id)).closure).toBeNull();
    expect((await read(source.id)).events).toEqual([]);
  });
  it('SQL rejects premature/missing-head closure, reopened heads, late events and closure mutation', async () => {
    const f = await fixture(), source = await select(f);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(source.admittedAt, 1)));
    const closure = { sourceId: source.id, cutoffAt: after(source.admittedAt, 2), reason: 'replacement', custodyWallet: f.wallet, processedOrdinal: 2 };
    await expect(db.insert(harvesterSourceClosures).values(closure)).rejects.toThrow();
    await expect(db.insert(harvesterSourceClosures).values({ ...closure, cutoffAt: after(source.admittedAt, 1), processedOrdinal: 1 })).rejects.toThrow(); // must remove exact head atomically
    await close(f, after(source.admittedAt, 1));
    await expect(db.insert(harvesterSourceHeads).values({ wallet: f.wallet, baseId: f.baseId, sourceId: source.id })).rejects.toThrow();
    await expect(db.update(harvesterSourceClosures).set({ cutoffAt: after(source.admittedAt, 2) }).where(eq(harvesterSourceClosures.sourceId, source.id))).rejects.toThrow();
    const event = (await read(source.id)).events[0]!.event;
    await expect(db.insert(harvesterEvents).values({ ...event, ordinal: 2, walletSequence: 2n, earnedAt: after(source.admittedAt, 2),
      settledAt: after(source.admittedAt, 2), carryBefore: event.carryAfter, carryAfter: event.carryAfter * 2n })).rejects.toThrow();
    expect((await read(source.id)).events).toHaveLength(1);
  });
  it('cannot close at an earlier cutoff than an already settled event', async () => {
    const f = await fixture(), source = await select(f);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(source.admittedAt, 2)));
    await expect(close(f, after(source.admittedAt, 1))).rejects.toThrow();
    expect((await read(source.id)).closure).toBeNull();
  });
  it('SQL refuses closure then a balanced late event before head deletion in the same transaction', async () => {
    const f = await fixture(), source = await select(f);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(source.admittedAt, 1)));
    const before = await read(source.id), event = before.events[0]!.event;
    await expect(db.transaction(async tx => {
      await tx.insert(harvesterSourceClosures).values({ sourceId: source.id, cutoffAt: event.earnedAt,
        reason: 'replacement', custodyWallet: f.wallet, processedOrdinal: 1 });
      // The old pending head still exists here. Every 0149 cadence/carry/entry
      // condition is valid, but this second event is after the frozen cutoff.
      await tx.insert(harvesterEvents).values({ ...event, ordinal: 2, walletSequence: 2n,
        earnedAt: after(source.admittedAt, 2), settledAt: after(source.admittedAt, 2),
        carryBefore: event.carryAfter, carryAfter: event.carryAfter * 2n });
      await tx.insert(harvesterEntries).values([
        { sourceId: source.id, ordinal: 2, bucket: 'issued', delta: -1n },
        { sourceId: source.id, ordinal: 2, bucket: 'base_stock', delta: 1n },
        { sourceId: source.id, ordinal: 2, bucket: 'island_pool', delta: 0n },
      ]);
      await tx.delete(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, source.id));
    })).rejects.toThrow();
    expect(await read(source.id)).toEqual(before);
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, source.id))).toHaveLength(1);
    expect((await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId)))[0]!.available).toBe(1n);
  });
});
