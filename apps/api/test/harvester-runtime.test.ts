/** Real DB runtime boundaries with synthetic Seeker terms and seeded completed
 * facilities. These tests do not establish genuine finality or placement. */
import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { BASE_OWNERSHIP, BUILD_COSTS, BuildingType, FORGE_INGOT, PHASE_E_HARVESTER, PHASE_E_POLICY,
  pvpAttackShardCostForKeepLevel } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../src/db/client';
import { bases, baseSlots, buildings, builderJobs, deposits, harvesterCustodyStops, harvesterSourceHeads, harvesterWalletLocks,
  players, raids, rawRaidResources, resourceStocks } from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { activateBase, assertFreshLockedBaseAuthority, refreshBaseOwnership, registerOwnedDeed, transferStableBase } from '../src/game/baseOwnership';
import { abandonFreeBase } from '../src/game/baseTransfer';
import { cancelUnacceptedBaseClaim, executeBaseClaim, getBaseClaim } from '../src/game/baseClaimCommands';
import type { ExpeditionTermSnapshot } from '../src/game/expeditionTerms';
import { claimRect } from '../src/game/footprints';
import { closeHarvesterSources, readHarvesterSettlement, settleDueHarvesterSources } from '../src/game/harvesterSettlement';
import { selectHarvesterSource } from '../src/game/harvesterSources';
import { createRaid, type RaidBaseAuthority } from '../src/game/raids';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createDepositIntent, creditDeposit } from '../src/money/deposits';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db, V1 = PHASE_E_HARVESTER.v1;
beforeAll(() => bootstrapSystemAccounts(db));
afterAll(() => conn.sql.end());
beforeEach(() => vi.stubEnv('MULTI_BASE_ENABLED', 'true'));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const key = () => Keypair.generate().publicKey.toBase58();
// 2026-10-10: 0286 refuses a raid capture cutoff later than Postgres clock_timestamp(), which no test can fake, so the
// raid cases share one calendar three real days ago; the other cases keep the original 2035 calendar.
const raidCalendar = new Date(Date.now() - 3 * 86_400_000);
async function fixture(baseId: string = randomUUID(), wallet = key(), now = new Date('2035-01-01T01:00:00.000Z')) {
  const level = 5, claim = claimRect(0);
  await db.insert(players).values({ wallet, keepLevel: level });
  await db.insert(bases).values({ id: baseId, ownerWallet: wallet, status: 'active', keepLevel: level });
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  await db.insert(buildings).values({ baseId, playerWallet: wallet, type: BuildingType.Keep,
    level, tx: claim.min, ty: claim.min });
  const [harvester] = await db.insert(buildings).values({ baseId, playerWallet: wallet,
    type: BuildingType.Harvester, tx: claim.min + 6, ty: claim.min }).returning();
  const completedAt = new Date(now.getTime() - 1_000);
  await db.insert(builderJobs).values({ baseId, playerWallet: wallet, buildingId: harvester!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Harvester].buildSec * 1_000), finishesAt: completedAt, completedAt });
  const address = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
  const startsAt = new Date(now.getTime() - 3_600_000).toISOString();
  const snapshot: ExpeditionTermSnapshot = { version: 1, termId: randomUUID(), startsAt,
    endsAt: new Date(Date.parse(startsAt) + PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000).toISOString(),
    source: { kind: 'solana_auction_round', genesisHash: address(201), programId: address(202), auctionConfig: key(), round: '1' },
    spots: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({ spotId, ownerWallet: null,
      auctionAccount: address(spotId + 1), settlementSignature: bs58.encode(new Uint8Array(64).fill(7)),
      settlementSlot: String(100 + spotId), termsHash: 'ab'.repeat(32) })) };
  const authority = { baseId, assertAuthority: async (tx: DbTx, actor: string, id: string) => {
    await assertFreshLockedBaseAuthority(tx, actor, id);
  } };
  const source = await selectHarvesterSource(db, wallet, { id: randomUUID(), baseId, harvesterId: harvester!.id,
    policyVersion: V1.policyVersion }, authority, { clock: () => now, reader: { async readOperatingTerm() {
      return { snapshot, finality: { commitment: 'finalized', contextSlot: '200', observedAt: now.toISOString() } };
    } } });
  return { wallet, baseId, now, source, harvesterId: harvester!.id, authority };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const at = (f: Fixture, ordinal: number) => new Date(f.source.admittedAt.getTime() + ordinal * V1.cadenceSec * 1_000);
const history = async (f: Fixture) => (await readHarvesterSettlement(db, f.source.id))!;
const stock = async (f: Fixture) => (await db.select().from(resourceStocks)
  .where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.source.resourceId))))[0];
const base = async (f: Fixture) => (await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!;
const read = (f: Fixture, cutoff: Date) => getBaseState(db, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => cutoff);
async function conserved(f: Fixture, gross: bigint, net: bigint, tax: bigint, seededStock = 0n) {
  const proof = await history(f);
  expect(proof.events.reduce((sum, p) => sum + p.event.gross, 0n)).toBe(gross);
  expect(proof.events.reduce((sum, p) => sum + p.event.net, 0n)).toBe(net);
  expect(proof.events.reduce((sum, p) => sum + p.event.tax, 0n)).toBe(tax);
  expect(proof.events.every(p => p.entries.length === 3 && p.entries.reduce((sum, e) => sum + e.delta, 0n) === 0n)).toBe(true);
  expect((await stock(f))?.available ?? 0n).toBe(seededStock + net);
}
async function deed(f: Fixture) {
  const buyer = key(), asset = key(), collection = key(); await db.insert(players).values({ wallet: buyer });
  await db.update(bases).set({ deedAssetId: asset, deedMintAssetId: asset, landPaidAt: f.now }).where(eq(bases.id, f.baseId));
  return { ...f, buyer, asset, collection, proof: { owner: buyer, collection, frozen: false, delegate: null, slot: 100 } };
}
type DeedFixture = Awaited<ReturnType<typeof deed>>;
const move = (path: 'direct' | 'observer', f: DeedFixture, cutoff: Date) => path === 'direct'
  ? transferStableBase(db, f.baseId, f.wallet, f.buyer, f.asset, { ...f.proof, observedAtMs: cutoff.getTime() }, () => cutoff)
  : refreshBaseOwnership(db, f.baseId, async () => f.proof, f.collection, cutoff, 'test-harvester-custody', () => cutoff);
const raidAuthority: RaidBaseAuthority = async (wallet, id, tx) => { if (tx) await assertFreshLockedBaseAuthority(tx, wallet, id); };
const raidOptions = (a: Fixture, d: Fixture) => ({ attackerBaseId: a.baseId, defenderBaseId: d.baseId, defenderWallet: d.wallet,
  idempotencyKey: randomUUID(), authorizeAttackerBase: raidAuthority, authorizeDefenderBase: raidAuthority });
const fund = (f: Fixture) => rewardBaseShards(db, f.baseId, BigInt(pvpAttackShardCostForKeepLevel(5)), 'harvester.runtime.fixture', randomUUID());
async function outgoing(f: Fixture, opponent: Fixture, cutoff: Date) {
  const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: f.wallet, attackerBaseId: f.baseId,
    defenderWallet: opponent.wallet, defenderBaseId: opponent.baseId, seed: 1n, snapshot: {}, armySnapshot: {},
    simVersion: SIM_VERSION, ordersDeadlineAt: new Date(cutoff.getTime() + 60_000) }).returning();
  return raid!;
}

describe.sequential('Harvester materialization at actual runtime boundaries', () => {
  it('authorized reads settle complete cadence once, retaining the original tax carry and term', async () => {
    const f = await fixture(); await read(f, new Date(at(f, 1).getTime() - 1));
    expect((await history(f)).events).toEqual([]);
    await read(f, at(f, 5)); const original = await history(f); await read(f, at(f, 5));
    expect(await history(f)).toEqual(original); expect(original.source.termId).toBe(f.source.termId);
    expect(original.events.at(-1)!.event).toMatchObject({ net: 0n, tax: 1n, carryBefore: 8_000n, carryAfter: 0n });
    await conserved(f, 5n, 4n, 1n);
  });

  it('legacy and unprotected reads cannot issue resources from an otherwise due source', async () => {
    const f = await fixture(); await getBaseState(db, f.wallet, at(f, 5), f.baseId);
    vi.stubEnv('MULTI_BASE_ENABLED', 'false'); await getBaseState(db, f.wallet, at(f, 5));
    expect((await history(f)).events).toEqual([]); expect(await stock(f)).toBeUndefined();
  });

  it.each(['authority', 'inactive', 'missing-slot'] as const)('%s refusal leaves original earnings unsettled', async reason => {
    const f = await fixture();
    if (reason === 'authority') f.authority.assertAuthority = async () => { throw new Error('authority unavailable'); };
    if (reason === 'inactive') await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    if (reason === 'missing-slot') await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await expect(read(f, at(f, 5))).rejects.toThrow(); expect((await history(f)).events).toEqual([]);
  });

  it('samples the authorized read cutoff after a real base-lock wait crosses the fifth tax unit', async () => {
    const f = await fixture(); let release!: () => void, pid: number | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => { await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>; pid = row!.pid; await gate; });
    const clock = vi.fn(() => new Date(at(f, 5).getTime() - 1)); let pending: ReturnType<typeof getBaseState> | undefined;
    try {
      await expect.poll(() => pid, { timeout: 5_000 }).toBeDefined();
      pending = getBaseState(db, f.wallet, f.now, f.baseId, f.authority.assertAuthority, clock);
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid!}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting,
        { timeout: 5_000 }).toBe(true);
      expect(clock).not.toHaveBeenCalled(); clock.mockImplementation(() => at(f, 5)); release(); await pending;
      expect(clock).toHaveBeenCalledTimes(1); await conserved(f, 5n, 4n, 1n);
    } finally { release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); }
  });

  it.each(['direct', 'observer'] as const)('%s custody closes the seller at its cutoff and cannot earn for the buyer later', async path => {
    const f = await deed(await fixture()), cutoff = at(f, 5.5); await move(path, f, cutoff);
    const original = await history(f);
    expect(original.closure).toMatchObject({ cutoffAt: cutoff, reason: 'custody_change', custodyWallet: f.wallet, processedOrdinal: 5 });
    expect(original.events.every(p => p.event.actorWallet === f.wallet && p.event.custodyWallet === f.wallet)).toBe(true);
    expect((await base(f)).ownerWallet).toBe(f.buyer); await conserved(f, 5n, 4n, 1n);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, at(f, 10)));
    expect(await history(f)).toEqual(original);
  });

  it('positive finalized ownership loss closes production even while an outgoing raid defers custody', async () => {
    const f = await deed(await fixture()), opponent = await fixture(), cutoff = at(f, 5.5);
    const raid = await outgoing(f, opponent, cutoff);
    await expect(move('direct', f, cutoff)).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });
    expect((await history(f)).closure).toBeNull();
    expect(await move('observer', f, cutoff)).toBe('mismatch');
    expect((await base(f)).ownerWallet).toBe(f.wallet);
    const original = await history(f); expect(original.closure).toMatchObject({ cutoffAt: cutoff, processedOrdinal: 5 });
    await conserved(f, 5n, 4n, 1n);
    await db.update(raids).set({ status: 'resolved', resolvedAt: cutoff }).where(eq(raids.id, raid.id));
    await move('observer', f, at(f, 10)); expect((await base(f)).ownerWallet).toBe(f.buyer);
    expect(await history(f)).toEqual(original);
  });

  it('unavailable ownership RPC cannot invent a closure or sample its event clock', async () => {
    const f = await deed(await fixture()), clock = vi.fn(() => at(f, 5));
    expect(await refreshBaseOwnership(db, f.baseId, async () => null, f.collection, f.now, 'test-harvester-unavailable', clock)).toBe('unavailable');
    expect(clock).not.toHaveBeenCalled(); expect((await history(f)).closure).toBeNull();
    expect((await history(f)).events).toEqual([]); expect((await base(f)).ownerWallet).toBe(f.wallet);
  });

  it.each(['direct', 'observer', 'native'] as const)('%s preserves the first finalized loss cutoff when full storage defers delivery', async path => {
    vi.stubEnv('BASE_CLAIM_V1_ENABLED', 'true');
    const f = await deed(await fixture()), firstAt = at(f, 2.5), laterAt = at(f, 4.5);
    const request = { baseId: f.baseId, deedAssetId: f.asset, idempotencyKey: randomUUID() };
    const readers = { collection: f.collection, ownerOf: async () => f.proof, ownedDeeds: async () => [f.asset] };
    const reconcile = (cutoff: Date) => path === 'native'
      ? executeBaseClaim(db, readers, f.buyer, request, () => cutoff) : move(path, f, cutoff);
    // Explicit synthetic saturation, not resource issuance or a pacing claim.
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    await expect(reconcile(firstAt)).rejects.toThrow('overflow');
    const [stop] = await db.select().from(harvesterCustodyStops).where(eq(harvesterCustodyStops.sourceId, f.source.id));
    expect(stop).toMatchObject({ cutoffAt: firstAt, custodyWallet: f.wallet, observedOwner: f.buyer, checkedAt: firstAt, observedSlot: 100n });
    expect((await history(f)).events).toEqual([]); expect((await history(f)).closure).toBeNull();
    expect((await base(f)).ownerWallet).toBe(f.wallet);
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id))).toHaveLength(1);
    if (path === 'native') expect((await getBaseClaim(db, f.buyer, request.idempotencyKey)).receipt).toBeNull();
    // Fixture capacity is released later; elapsed time cannot extend the source.
    await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.baseId));
    await reconcile(laterAt);
    expect((await base(f)).ownerWallet).toBe(f.buyer);
    expect((await history(f)).closure).toMatchObject({ cutoffAt: firstAt, processedOrdinal: 2, reason: 'custody_change' });
    expect((await history(f)).events.map(p => p.event.earnedAt)).toEqual([at(f, 1), at(f, 2)]);
    await conserved(f, 2n, 2n, 0n);
    expect((await db.select().from(harvesterCustodyStops).where(eq(harvesterCustodyStops.sourceId, f.source.id)))[0]).toEqual(stop);
  });

  it('cancelling an overflowed native claim preserves the independently proven custody stop', async () => {
    vi.stubEnv('BASE_CLAIM_V1_ENABLED', 'true');
    const f = await deed(await fixture()), cutoff = at(f, 2.5);
    const request = { baseId: f.baseId, deedAssetId: f.asset, idempotencyKey: randomUUID() };
    const readers = { collection: f.collection, ownerOf: async () => f.proof, ownedDeeds: async () => [f.asset] };
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    await expect(executeBaseClaim(db, readers, f.buyer, request, () => cutoff)).rejects.toThrow('overflow');
    const original = await history(f);
    expect((await cancelUnacceptedBaseClaim(db, f.buyer, request.idempotencyKey)).cancelled).toBe(true);
    await expect(executeBaseClaim(db, { ...readers, ownerOf: async () => { throw new Error('cancelled replay must not fetch'); } },
      f.buyer, request)).rejects.toMatchObject({ code: 'BASE_CLAIM_CANCELLED' });
    expect(await history(f)).toEqual(original);
  });

  it('an observer proof expiring during a real lock wait cannot bypass the stop journal and apply custody', async () => {
    const f = await deed(await fixture()), observedAt = at(f, 2.5);
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    let release!: () => void, pid: number | undefined, current = observedAt;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>;
      pid = row!.pid; await gate;
    });
    let pending: ReturnType<typeof refreshBaseOwnership> | undefined;
    try {
      await expect.poll(() => pid).toBeDefined();
      pending = refreshBaseOwnership(db, f.baseId, async () => f.proof, f.collection, observedAt, 'test-expired-harvester-proof', () => current);
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid!}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting).toBe(true);
      current = new Date(observedAt.getTime() + BASE_OWNERSHIP.mutationFreshnessMs + 1);
      release(); expect(await pending).toBe('unavailable');
      expect((await history(f)).stop).toBeNull(); expect((await history(f)).events).toEqual([]);
      expect((await base(f)).ownerWallet).toBe(f.wallet);
      expect((await stock(f))!.available).toBe(RAW_RESOURCE_STORAGE_MAX);
    } finally { release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); }
  });

  it('a native receipt committed during proof fetch wins before mutable journal validation', async () => {
    vi.stubEnv('BASE_CLAIM_V1_ENABLED', 'true');
    const f = await deed(await fixture()), cutoff = at(f, 2.5);
    const request = { baseId: f.baseId, deedAssetId: f.asset, idempotencyKey: randomUUID() };
    const readers = { collection: f.collection, ownerOf: async () => f.proof, ownedDeeds: async () => [f.asset] };
    let release!: () => void, fetching = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = executeBaseClaim(db, { ...readers, ownerOf: async () => { fetching = true; await gate; return f.proof; } },
      f.buyer, request, () => cutoff);
    try {
      await expect.poll(() => fetching).toBe(true);
      const accepted = await executeBaseClaim(db, readers, f.buyer, request, () => cutoff);
      release(); expect(await pending).toEqual(accepted);
      await conserved(f, 2n, 2n, 0n);
    } finally { release(); await Promise.allSettled([pending]); }
  });

  it('raid admission settles both sources before freezing raw defender loot, conserving original tax', async () => {
    const a = await fixture(undefined, undefined, raidCalendar), d = await fixture(undefined, undefined, raidCalendar); await fund(a);
    // A snapshot taken before settlement would freeze zero theft. The accepted
    // net production must cross the first positive raw-loot threshold.
    const seededStock = BigInt(FORGE_INGOT.rawStockTheftDivisor) - 1n;
    await db.insert(resourceStocks).values({ baseId: d.baseId, resourceId: d.source.resourceId, available: seededStock });
    expect(seededStock / BigInt(FORGE_INGOT.rawStockTheftDivisor)).toBe(0n);
    const raid = await createRaid(db, a.wallet, raidOptions(a, d), at(a, 5));
    await conserved(a, 5n, 4n, 1n); await conserved(d, 5n, 4n, 1n, seededStock);
    const frozen = await db.select().from(rawRaidResources).where(eq(rawRaidResources.raidId, raid.id));
    expect(frozen.find(row => row.resourceId === d.source.resourceId)).toMatchObject({
      available: seededStock + 4n, reserved: 0n, maximum: 1n, fromAvailable: 1n });
    await read(d, at(d, 6)); expect((await stock(d))!.available).toBe(seededStock + 5n);
    expect(await db.select().from(rawRaidResources).where(eq(rawRaidResources.raidId, raid.id))).toEqual(frozen);
  });

  it('failed raid payment rolls back both sources, stock and wallet carry together', async () => {
    const a = await fixture(undefined, undefined, raidCalendar), d = await fixture(undefined, undefined, raidCalendar);
    await expect(createRaid(db, a.wallet, raidOptions(a, d), at(a, 5))).rejects.toThrow('not enough shards');
    for (const f of [a, d]) { expect((await history(f)).events).toEqual([]); expect(await stock(f)).toBeUndefined(); }
    await fund(a); await createRaid(db, a.wallet, raidOptions(a, d), at(a, 5));
    for (const f of [a, d]) await conserved(f, 5n, 4n, 1n);
  });

  it('raid takes original wallet accounting locks in wallet order even when base order is reversed', async () => {
    const [low, high] = [key(), key()].sort();
    const a = await fixture(`f0000000${randomUUID().slice(8)}`, low!, raidCalendar), d = await fixture(`10000000${randomUUID().slice(8)}`, high!, raidCalendar);
    await fund(a); await db.insert(harvesterWalletLocks).values([{ wallet: low! }, { wallet: high! }]);
    let release!: () => void, pid: number | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => { await tx.select().from(harvesterWalletLocks).where(eq(harvesterWalletLocks.wallet, high!)).for('update');
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>; pid = row!.pid; await gate; });
    let pending: ReturnType<typeof createRaid> | undefined;
    try {
      await expect.poll(() => pid, { timeout: 5_000 }).toBeDefined();
      pending = createRaid(db, a.wallet, raidOptions(a, d), at(a, 5));
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid!}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting,
        { timeout: 5_000 }).toBe(true);
      // A caller following reversed base order would wait on high without first
      // protecting low. NOWAIT proves the live transaction already owns low.
      await expect(conn.sql`SELECT wallet FROM harvester_wallet_locks WHERE wallet=${low!} FOR UPDATE NOWAIT`).rejects.toMatchObject({ code: '55P03' });
      release(); await pending; for (const f of [a, d]) await conserved(f, 5n, 4n, 1n);
    } finally { release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); }
  });

  it('active-slot replacement closes only the displaced source before removing its slot', async () => {
    const f = await fixture(), cutoff = at(f, 5.5);
    for (let slot = 2; slot <= BASE_OWNERSHIP.maxActive; slot++) {
      const [other] = await db.insert(bases).values({ ownerWallet: f.wallet, status: 'active' }).returning();
      await db.insert(baseSlots).values({ wallet: f.wallet, baseId: other!.id, slot });
    }
    const [target] = await db.insert(bases).values({ ownerWallet: f.wallet, status: 'inactive' }).returning();
    await activateBase(db, f.wallet, target!.id, f.baseId, undefined, () => cutoff);
    expect((await history(f)).closure).toMatchObject({ cutoffAt: cutoff, reason: 'deactivation', processedOrdinal: 5 });
    expect((await base(f)).status).toBe('inactive');
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId))).toEqual([]); await conserved(f, 5n, 4n, 1n);
  });

  it('registering the first deed closes the free-home source before changing its realm authority', async () => {
    const f = await fixture(), cutoff = at(f, 5.5);
    // Inactive registration avoids unrelated global observer capacity fixtures.
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    expect((await registerOwnedDeed(db, f.wallet, key(), { ownerOf: async () => null, expectedCollection: null, clock: () => cutoff })).id).toBe(f.baseId);
    expect((await history(f)).closure).toMatchObject({ cutoffAt: cutoff, reason: 'realm_change', processedOrdinal: 5 });
    await conserved(f, 5n, 4n, 1n);
  });

  it('first-land payment uses the post-lock production cutoff while retaining its original payment timestamp', async () => {
    const f = await fixture(), paymentAt = new Date(at(f, 5).getTime() - 1), cutoff = at(f, 5);
    const intent = await createDepositIntent(db, f.wallet, 'entry', undefined, paymentAt);
    if (intent.kind !== 'entry') throw new Error('Expected original entry quote');
    const payment = { wallet: f.wallet, kind: 'entry' as const, finalized: true as const,
      txSignature: bs58.encode(randomBytes(64)), lamports: BigInt(intent.amountLamports) };
    let release!: () => void, pid: number | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => { await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>; pid = row!.pid; await gate; });
    const clock = vi.fn(() => paymentAt); let pending: ReturnType<typeof creditDeposit> | undefined;
    try {
      await expect.poll(() => pid, { timeout: 5_000 }).toBeDefined();
      pending = creditDeposit(db, intent.id, payment, paymentAt, { eventClock: clock });
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid!}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting,
        { timeout: 5_000 }).toBe(true);
      expect(clock).not.toHaveBeenCalled(); clock.mockImplementation(() => cutoff); release(); expect((await pending).credited).toBe(true);
    } finally { release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); }
    expect((await base(f)).landPaidAt).toEqual(paymentAt);
    expect((await history(f)).closure).toMatchObject({ cutoffAt: cutoff, reason: 'realm_change', processedOrdinal: 5 });
    await conserved(f, 5n, 4n, 1n);
    const [credited] = await db.select().from(deposits).where(eq(deposits.id, intent.id));
    expect(credited).toMatchObject({ id: intent.id, playerWallet: f.wallet, kind: 'entry', status: 'credited',
      finalizedAt: paymentAt, txSignature: payment.txSignature, amount: payment.lamports });
    expect((await creditDeposit(db, intent.id, payment, cutoff, { eventClock: () => { throw new Error('replay must not resample'); } })).credited).toBe(false);
    expect((await db.select().from(deposits).where(eq(deposits.id, intent.id)))[0]).toEqual(credited);
  });

  it.each(['active', 'closed', 'compatibility-wallet'] as const)('legacy abandon preserves %s original history and facilities', async mode => {
    const f = await fixture();
    if (mode !== 'active') await db.transaction(tx => closeHarvesterSources(tx, f.baseId, at(f, 5), 'deactivation'));
    if (mode === 'compatibility-wallet') {
      const buyer = key(); await db.insert(players).values({ wallet: buyer });
      await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
      await db.update(bases).set({ ownerWallet: buyer, status: 'inactive' }).where(eq(bases.id, f.baseId));
    }
    const original = await history(f), facilities = await db.select().from(buildings).where(eq(buildings.baseId, f.baseId));
    const jobs = await db.select().from(builderJobs).where(eq(builderJobs.baseId, f.baseId));
    await expect(abandonFreeBase(db, f.wallet, at(f, 6))).rejects.toMatchObject({ code: 'HARVESTER_STABLE_BOUNDARY_REQUIRED' });
    expect(await history(f)).toEqual(original);
    expect(await db.select().from(buildings).where(eq(buildings.baseId, f.baseId))).toEqual(facilities);
    expect(await db.select().from(builderJobs).where(eq(builderJobs.baseId, f.baseId))).toEqual(jobs);
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id))).toHaveLength(mode === 'active' ? 1 : 0);
  });
});
