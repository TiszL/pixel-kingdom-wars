import { randomBytes, randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOOT, MINING, PHASE_E_HARVESTER, PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION, getMiningQuota } from '@shardkeep/shared';
import { baseEconomyBackfills, bases, baseSlots, builderJobs, buildings, mineAccrualStates,
  raidLootReservations, raidMineLootReservations, raids } from '../src/db/schema';
import { collectBaseMines, ensureBaseMineState, MINE_DAY_MS, reanchorBaseMineAccrual } from '../src/game/baseMining';
import { completeDueJobs } from '../src/game/base';
import { admitPhysicalMineTaxSources } from '../src/mining/shardsTaxMineSources';
import { readCompleteShardsTaxPool } from '../src/mining/shardsTaxHistory';
import { bootstrapSystemAccounts, getOrCreateBaseAccount } from '../src/ledger';
import { createTestPlayer } from './helpers';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

const conn = resourceClaimsDatabase(), db = conn.db;
const start = new Date('2035-01-01T00:00:00.000Z');
const boundary = new Date(+start + MINE_DAY_MS / 2);
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
function term(at: Date) {
  return {
    snapshot: { version: 1 as const, termId: randomUUID(), startsAt: start.toISOString(),
      endsAt: new Date(+start + PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000).toISOString(),
      source: { kind: 'solana_auction_round' as const, genesisHash: key(201), programId: key(202),
        auctionConfig: new PublicKey(randomBytes(32)).toBase58(), round: '1' },
      spots: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({
        spotId, ownerWallet: spotId < 2 ? key(204) : null, auctionAccount: key(spotId + 1),
        settlementSignature: bs58.encode(new Uint8Array(64).fill(7)),
        settlementSlot: String(100 + spotId), termsHash: 'ab'.repeat(32),
      })) },
    finality: { commitment: 'finalized' as const, contextSlot: '200', observedAt: at.toISOString() },
  };
}
async function fixture(amount = 7n, anchor = start, withState = true) {
  const player = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: player.wallet, status: 'active', keepLevel: 1 }).returning();
  await db.insert(baseSlots).values({ wallet: player.wallet, slot: 1, baseId: base!.id });
  const [mine] = await db.insert(buildings).values({ playerWallet: player.wallet, baseId: base!.id,
    type: 'mine', level: 1, tx: 1, ty: 1 }).returning();
  if (withState) await db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, accruedShards: amount, lastAccrualAt: anchor });
  return { player, base: base!, mine: mine!, context: { baseId: base!.id, assertAuthority: async () => {} },
    quota: BigInt(getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS)) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function admit(f: Fixture, at: Date) {
  const observation = term(at);
  return admitPhysicalMineTaxSources(db, f.player.wallet,
    { idempotencyKey: randomUUID(), baseId: f.base.id }, f.context,
    { clock: () => at, reader: { readOperatingTerm: async () => observation } });
}
beforeAll(async () => {
  await conn.setup();
  await conn.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at)
    values(1,1,1,1,${boundary.toISOString()})`;
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
afterAll(() => conn.close());

describe.sequential('physical Mine initialization at the durable earning-policy boundary', () => {
  it('records the original opening state without changing the buffer, fractional anchor or version', async () => {
    const anchor = new Date(+start + 123), f = await fixture(7n, anchor), at = new Date(+boundary + 1_000);
    const [before] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
    await db.transaction(tx => ensureBaseMineState(tx, f.mine.id, anchor, at));
    await db.transaction(tx => ensureBaseMineState(tx, f.mine.id, anchor, at));
    const [after] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
    expect(after).toEqual(before);
    const [era] = await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`;
    expect(era).toMatchObject({ policy_boundary_id: 1, initialization_kind: 'locked_pre_policy_state', source_state_version: 0 });
    expect(+new Date(era!.source_anchor_at)).toBe(+anchor);
    expect(+new Date(era!.admitted_at)).toBe(+at);
  });

  it('does not turn delayed post-boundary production into untaxed legacy at first admission', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const f = await fixture(), at = new Date(+boundary + MINE_DAY_MS / 4);
    await admit(f, at);
    const [era] = await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`;
    expect(BigInt(era!.legacy_gross)).toBe(7n);
    const rows = await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`;
    const pre = rows.filter(r => r.wallet === null).reduce((n, r) => n + BigInt(r.gross), 0n);
    expect(pre).toBe(7n + BigInt(+boundary - +start - 1) * f.quota / BigInt(MINE_DAY_MS));
    const held = rows.filter(r => r.wallet !== null && r.admission_id === null);
    expect(held.length).toBeGreaterThan(0);
    await expect(collectBaseMines(db, f.player.wallet, f.context, at)).rejects.toThrow('original earning term');
    const [state] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
    expect(state!.accruedShards).toBe(7n + f.quota * 3n / 4n);
  });

  it('issues pre-policy legacy and original-term taxed production in one conserved collection after pause', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const f = await fixture(), source = await admit(f, start), at = new Date(+boundary + MINE_DAY_MS / 4);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    const gross = 7n + f.quota * 3n / 4n;
    const legacy = 7n + BigInt(+boundary - +start - 1) * f.quota / BigInt(MINE_DAY_MS);
    const taxable = gross - legacy, policy = PHASE_E_HARVESTER.v1;
    const tax = taxable * BigInt(policy.islandPoolBps) / BigInt(policy.taxBasisPoints);
    const result = await collectBaseMines(db, f.player.wallet, f.context, at);
    expect(result.amount + tax).toBe(gross);
    const rows = await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`;
    expect(rows.filter(r => r.wallet === null).reduce((n, r) => n + BigInt(r.issued), 0n)).toBe(legacy);
    const [assessment] = await conn.sql`select * from shards_tax_assessments where wallet=${f.player.wallet}`;
    expect(assessment!.term_id).toBe(source.termId);
    expect(BigInt(assessment!.gross)).toBe(taxable);
    expect(BigInt(assessment!.tax)).toBe(tax);
    expect(BigInt(assessment!.carry_after)).toBe(taxable * BigInt(policy.islandPoolBps) % BigInt(policy.taxBasisPoints));
    expect(await readCompleteShardsTaxPool(db, source.termId, source.termHash)).toBe(tax);
    expect((await collectBaseMines(db, f.player.wallet, f.context, at)).amount).toBe(0n);
    expect(await conn.sql`select * from shards_tax_assessments where wallet=${f.player.wallet}`).toHaveLength(1);
    expect(await readCompleteShardsTaxPool(db, source.termId, source.termHash)).toBe(tax);
  });

  it.each([0, 1_000])('holds an untracked nonzero buffer anchored at or beyond the boundary (%i ms)', async offset => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const anchor = new Date(+boundary + offset), f = await fixture(9n, anchor);
    await expect(admit(f, new Date(+anchor + 1_000))).rejects.toMatchObject({ code: 'SHARDS_MINE_POLICY_HELD' });
    expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(0);
    const [state] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
    expect(state).toMatchObject({ accruedShards: 9n, lastAccrualAt: anchor, version: 0 });
  });

  it('does not turn a durable boundary into a legacy exemption during pause or provider loss', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    const f = await fixture(), at = new Date(+boundary + MINE_DAY_MS / 4);
    await expect(collectBaseMines(db, f.player.wallet, f.context, at)).rejects.toMatchObject({ code: 'SHARDS_SOURCE_HELD' });
    const [state] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
    expect(state).toMatchObject({ accruedShards: 7n, lastAccrualAt: start, version: 0 });
    await db.transaction(tx => reanchorBaseMineAccrual(tx, f.base.id, at));
    const held = await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id} and wallet is not null and admission_id is null`;
    expect(held.length).toBeGreaterThan(0);
    expect(await conn.sql`select * from shards_tax_assessments where wallet=${f.player.wallet}`).toHaveLength(0);
    await expect(collectBaseMines(db, f.player.wallet, f.context, at)).rejects.toMatchObject({ code: 'SHARDS_SOURCE_HELD' });
  });

  it.each(['completion', 'collection'] as const)('uses the scheduled Mine finish through the %s initialization path', async path => {
    const finished = new Date(+boundary + 1_000), at = new Date(+finished + MINE_DAY_MS / 4);
    const f = await fixture(0n, finished, false);
    const [job] = await db.insert(builderJobs).values({ playerWallet: f.player.wallet, baseId: f.base.id,
      kind: 'build', buildingId: f.mine.id, startedAt: start, finishesAt: finished }).returning();
    if (path === 'completion') {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
      await db.transaction(tx => completeDueJobs(tx, f.player.wallet, at, f.base.id));
    }
    else await expect(collectBaseMines(db, f.player.wallet, f.context, at)).rejects.toMatchObject({ code: 'SHARDS_SOURCE_HELD' });
    const [era] = await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`;
    expect(era).toMatchObject({ initialization_kind: 'fresh_scheduled_build', build_job_id: job!.id });
    expect(BigInt(era!.legacy_gross)).toBe(0n);
    expect(+new Date(era!.production_started_at)).toBe(+finished);
    const [state] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
    expect(state).toMatchObject({ accruedShards: 0n, lastAccrualAt: finished, version: 0 });
    await expect(collectBaseMines(db, f.player.wallet, f.context, at)).rejects.toMatchObject({ code: 'SHARDS_SOURCE_HELD' });
  });

  it('adopts separately proven custody-cutover stock once after initialization without exempting new production', async () => {
    const f = await fixture(0n), base = await getOrCreateBaseAccount(db, f.base.id, 'base_shards');
    const forge = await getOrCreateBaseAccount(db, f.base.id, 'base_forge_escrow'), sys = await bootstrapSystemAccounts(db);
    await db.insert(baseEconomyBackfills).values({ legacyWallet: f.player.wallet, primaryBaseId: f.base.id,
      destinationShardAccountId: base.id, sourceForgeEscrowAccountId: sys.forge_escrow,
      destinationForgeEscrowAccountId: forge.id, legacyMineBufferPending: 19n, ledgerStatus: 'complete', completedAt: start });
    await db.transaction(tx => ensureBaseMineState(tx, f.mine.id, start, boundary));
    await db.transaction(tx => ensureBaseMineState(tx, f.mine.id, start, boundary));
    const [era] = await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`;
    expect(BigInt(era!.legacy_gross)).toBe(0n);
    const legacy = await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id} and wallet is null`;
    expect(legacy).toHaveLength(1);
    expect(BigInt(legacy[0]!.gross)).toBe(19n);
    await expect(collectBaseMines(db, f.player.wallet, f.context, new Date(+boundary + MINE_DAY_MS / 4)))
      .rejects.toMatchObject({ code: 'SHARDS_SOURCE_HELD' });
    const [pending] = await db.select().from(baseEconomyBackfills).where(eq(baseEconomyBackfills.legacyWallet, f.player.wallet));
    expect(pending!.legacyMineBufferPending).toBe(0n);
  });

  it('rolls initialization back with its caller and never changes the original opening state', async () => {
    const f = await fixture();
    await expect(db.transaction(async tx => {
      await ensureBaseMineState(tx, f.mine.id, start, boundary);
      throw Error('caller rollback');
    })).rejects.toThrow('caller rollback');
    expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(0);
    expect(await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`).toHaveLength(0);
    const [state] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
    expect(state).toMatchObject({ accruedShards: 7n, lastAccrualAt: start, version: 0 });
  });

  it('holds first initialization while an older unmanaged raid owns detached Mine stock', async () => {
    const f = await fixture(0n), attacker = await fixture(0n);
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.player.wallet,
      attackerBaseId: attacker.base.id, defenderWallet: f.player.wallet, defenderBaseId: f.base.id,
      seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: 9, ordersDeadlineAt: boundary }).returning();
    await db.insert(raidLootReservations).values({ raidId: raid!.id, formulaVersion: LOOT.formulaVersion,
      attackerBaseId: attacker.base.id, defenderBaseId: f.base.id, mineReservedShards: 7n,
      privateSnapshotHash: 'ab'.repeat(32), reservedAt: start });
    await db.insert(raidMineLootReservations).values({ raidId: raid!.id, mineBuildingId: f.mine.id, frozenShards: 7n });
    await expect(db.transaction(tx => ensureBaseMineState(tx, f.mine.id, start, boundary)))
      .rejects.toMatchObject({ code: 'SHARDS_MINE_POLICY_HELD' });
    expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(0);
  });

  it('rechecks finalized term freshness after waiting for the original wallet carry lock', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const at = new Date(+boundary + 1_000), f = await fixture(0n), observation = term(at);
    await conn.sql`insert into shards_tax_wallet_locks(wallet) values(${f.player.wallet})`;
    let now = at, release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const locker = conn.sql.begin(async tx => {
      await tx`select wallet from shards_tax_wallet_locks where wallet=${f.player.wallet} for update`;
      ready(); await gate;
    });
    await locked;
    let request: Promise<unknown> | undefined;
    try {
      request = admitPhysicalMineTaxSources(db, f.player.wallet,
        { idempotencyKey: randomUUID(), baseId: f.base.id }, f.context,
        { clock: () => now, reader: { readOperatingTerm: async () => observation } }).catch(error => error);
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const [row] = await conn.sql`select count(*)::integer n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'
          and query like '%shards_tax_wallet_locks%'`;
        if (row!.n > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      now = new Date(+at + PHASE_E_SEEKER_AUCTION.observationMaxAgeMs + 1);
      release(); await locker;
      expect(await request).toBeInstanceOf(Error);
      expect(String(await request)).toContain('stale term');
      expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(0);
      expect(await conn.sql`select * from shards_mine_admissions where base_id=${f.base.id}`).toHaveLength(0);
    } finally { release(); await Promise.allSettled([locker, ...(request ? [request] : [])]); }
  });

  it('refuses busy provenance so real pool-handle Mine completion can finish without a base/job lock cycle', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const at = new Date(+boundary + 1_000), f = await fixture(0n, at, false), observation = term(at);
    const [job] = await db.insert(builderJobs).values({ playerWallet: f.player.wallet, baseId: f.base.id,
      kind: 'build', buildingId: f.mine.id, startedAt: start, finishesAt: at }).returning();
    // Existing carry identity lets completion reach the era's base FK rather
    // than first waiting on a new carry row's player FK.
    await conn.sql`insert into shards_tax_wallet_locks(wallet) values(${f.player.wallet})`;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owned = new Promise<void>(resolve => { ready = resolve; });
    const context = { ...f.context, assertAuthority: async () => { ready(); await gate; } };
    const request = admitPhysicalMineTaxSources(db, f.player.wallet,
      { idempotencyKey: randomUUID(), baseId: f.base.id }, context,
      { clock: () => at, reader: { readOperatingTerm: async () => observation } }).catch(error => error);
    await owned; // Admission holds the base before normal completion claims its job.
    const completion = completeDueJobs(db, f.player.wallet, at, f.base.id).catch(error => error);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 1_000; attempt++) {
        const [row] = await conn.sql`select count(*)::integer n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query like '%insert into shards_mine_eras%'`;
        if (row!.n > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true); // Real era FK waits for admission's base lock.
      release();
      const refused = await request;
      expect(await completion).toBeUndefined();
      expect(refused).toMatchObject({ code: 'SHARDS_SOURCE_HELD', statusCode: 503 });
      const [done] = await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id));
      expect(done!.completedAt).toEqual(at);
      expect(await conn.sql`select * from shards_mine_admissions where base_id=${f.base.id}`).toHaveLength(0);
      expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(1);
      await expect(admitPhysicalMineTaxSources(db, f.player.wallet,
        { idempotencyKey: randomUUID(), baseId: f.base.id }, f.context,
        { clock: () => at, reader: { readOperatingTerm: async () => observation } })).resolves.toMatchObject({ baseId: f.base.id });
    } finally { release(); await Promise.allSettled([request, completion]); }
  });

  it('rolls back a fresh ordinary collection state when its scheduled provenance is busy and retries after release', async () => {
    const at = new Date(+boundary + 1_000), f = await fixture(0n, at, false);
    const [job] = await db.insert(builderJobs).values({ playerWallet: f.player.wallet, baseId: f.base.id,
      kind: 'build', buildingId: f.mine.id, startedAt: start, finishesAt: at }).returning();
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const locker = conn.sql.begin(async tx => {
      await tx`select id from builder_jobs where id=${job!.id} for update`;
      ready(); await gate;
    });
    await locked;
    const collectAt = new Date(+at + MINE_DAY_MS / 4);
    try {
      await expect(collectBaseMines(db, f.player.wallet, f.context, collectAt))
        .rejects.toMatchObject({ code: 'SHARDS_MINE_POLICY_HELD', statusCode: 503 });
      expect(await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id))).toHaveLength(0);
      expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(0);
      release(); await locker;
      await expect(collectBaseMines(db, f.player.wallet, f.context, collectAt))
        .rejects.toMatchObject({ code: 'SHARDS_SOURCE_HELD' });
      const [state] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
      expect(state).toMatchObject({ accruedShards: 0n, lastAccrualAt: at, version: 0 });
      expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(1);
    } finally { release(); await locker; }
  });

  it('keeps all fractional and whole-unit production under the original source during a valid renewal wait', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const f = await fixture(0n, boundary), level = MINING.MINE_MULT_BPS.length;
    await db.update(buildings).set({ level }).where(eq(buildings.id, f.mine.id));
    await db.update(bases).set({ keepLevel: level }).where(eq(bases.id, f.base.id));
    const quota = BigInt(getMiningQuota(level, [level], 0, MINING.EPOCH_RATE_BPS));
    const observation = term(boundary), original = await admitPhysicalMineTaxSources(db, f.player.wallet,
      { idempotencyKey: randomUUID(), baseId: f.base.id }, f.context,
      { clock: () => boundary, reader: { readOperatingTerm: async () => observation } });
    // 3/4 unit before the wait + 7/4 units during it: a second intermediate
    // reanchor loses one whole unit by separately flooring the two intervals.
    const priorMs = Math.ceil(MINE_DAY_MS * 3 / (Number(quota) * 4));
    const waitMs = Math.ceil(MINE_DAY_MS * 7 / (Number(quota) * 4));
    expect(waitMs).toBeLessThan(PHASE_E_SEEKER_AUCTION.observationMaxAgeMs);
    const prepared = new Date(+boundary + priorMs), actual = new Date(+prepared + waitMs);
    let now = prepared, release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const locker = conn.sql.begin(async tx => {
      await tx`select wallet from shards_tax_wallet_locks where wallet=${f.player.wallet} for update`;
      ready(); await gate;
    });
    await locked;
    let request: Promise<unknown> | undefined;
    try {
      request = admitPhysicalMineTaxSources(db, f.player.wallet,
        { idempotencyKey: randomUUID(), baseId: f.base.id }, f.context,
        { clock: () => now, reader: { readOperatingTerm: async () => ({ ...observation,
          finality: { ...observation.finality, observedAt: prepared.toISOString() } }) } }).catch(error => error);
      let waiting = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const [row] = await conn.sql`select count(*)::integer n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query like '%shards_tax_wallet_locks%'`;
        if (row!.n > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      now = actual; release(); await locker;
      const renewed = await request;
      expect(renewed).not.toBeInstanceOf(Error);
      expect(renewed).toMatchObject({ admittedAt: actual.toISOString() });
      const expected = BigInt(+actual - +boundary) * quota / BigInt(MINE_DAY_MS);
      expect(expected).toBeGreaterThan(BigInt(priorMs) * quota / BigInt(MINE_DAY_MS)
        + BigInt(waitMs) * quota / BigInt(MINE_DAY_MS));
      const rows = await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.admission_id === original.idempotencyKey)).toBe(true);
      expect(rows.reduce((n, row) => n + BigInt(row.gross), 0n)).toBe(expected);
      const [state] = await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id));
      expect(state!.accruedShards).toBe(expected);
      expect(state!.lastAccrualAt).toEqual(actual);
      expect((await collectBaseMines(db, f.player.wallet, f.context, actual)).amount).toBe(expected);
    } finally { release(); await Promise.allSettled([locker, ...(request ? [request] : [])]); }
  });
});
