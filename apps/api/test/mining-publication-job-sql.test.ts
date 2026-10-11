/** STAGED / AUTHORED ONLY — the content pipeline must copy to apps/api/test before execution.
 * No DB run, signature, key generation, or service was performed by this lane.
 * These use real migrated SQL and normal custody/preparation APIs. Existing
 * fixtures create throwaway keys; the content pipeline's precise fixture admission is required.
 * External chain readers are serialized local fixtures, never live RPC.
 */
import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import type { MiningPublicationReader } from '@shardkeep/chain/mining-publication';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { createMiningPublicationFixture } from '../../../packages/chain/src/testFixtures/miningPublication';
import { createDb, type Db } from '../src/db/client';
import { withFundedMiningFixture as baseFixture } from './fixtures/fundedMining';
import { runMiningPublicationFixtureMigrations } from './fixtures/miningPublicationClock';
import { createInitialFreePublicationSources, prepareInitialFreePublication } from './fixtures/initialFreePublication';
import { reserveMiningContribution, abortMiningContributions, readMiningContribution } from '../src/game/miningContributions';
import { abortPendingMiningEpoch } from '../src/game/miningIngotReservations';
import { createInitialFreePublicationPreparer, createPublicationPreparer } from '../src/mining/publicationPreparation';
import { createInitialFreeAllocationPlanner } from '../src/mining/initialFreeAllocation';
import { createResourceMiningPublicationPreparer, createResourceMiningAllocationPlanner } from '../src/mining/fundedMiningAllocation';
import { createMiningPublicationOutbox } from '../src/mining/publicationOutbox';
import { createMiningPublicationSettlement } from '../src/mining/publicationSettlement';
import { createMiningPublicationJob, type MiningPublicationJobOptions } from '../src/mining/publicationJob';

const fixture: typeof baseFixture = (run, options = {}) => baseFixture(run, { ...options, publicationClock: true });

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
type Query = ReturnType<PgDialect['sqlToQuery']>;
const originalDay = '2020-01-01';
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const dayOffset = (day: string, delta: number) => new Date(Date.parse(day) + delta * POLICY.daySec * 1000).toISOString().slice(0, 10);

async function contribute(f: Fixture, day: string) {
  const command = { idempotencyKey: randomUUID(), baseId: f.baseId, policyVersion: 2 as const,
    expectedDay: day, lines: [{ resourceId: 'shards' as const, quantity: '2000' }] };
  const result = await reserveMiningContribution(f.conn.db, f.wallet, command, f.context, { clock: () => new Date(`${day}T13:00:00Z`) });
  if (!result.receipt) throw Error('Actual resource custody required');
  return result.receipt;
}

async function bank(f: Fixture) {
  // This fixture API already accepts a genesis. Recompose before preparation;
  // never alter an immutable original or weaken the job's devnet requirement.
  const source = await createInitialFreePublicationSources(f, undefined, [], SOLANA_GENESIS_HASH.devnet);
  source.backing.model.publisher = f.walletSigner.publicKey;
  source.backing.model.flags = 0; await source.backing.config();
  source.backing.rows[7]!.data.writeBigUInt64LE(2000n);
  source.backing.reader.getSlot = async () => 2000;
  source.backing.reader.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 2000 }, value: source.backing.rows });
  let blockhashReads = 0, signCalls = 0;
  const blockhashSource = () => ({ getGenesisHash: async () => SOLANA_GENESIS_HASH.devnet,
    getLatestBlockhashAndContext: async () => { blockhashReads++; return { context: { slot: 2000 },
      value: { blockhash: key(91).toBase58(), lastValidBlockHeight: 2200 } }; } });
  const receiptReader: MiningPublicationReader = { getGenesisHash: async () => SOLANA_GENESIS_HASH.devnet,
    getTransaction: async () => null, getSlot: async () => 2000,
    getMultipleAccountsInfoAndContext: async () => { throw Error('Fixture has no finalized publication'); } };
  const options: MiningPublicationJobOptions = { enabled: true, testerStack: true, cluster: 'devnet',
    operator: f.walletSigner.publicKey, hotWallet: key(77),
    publisher: { publicKey: f.walletSigner.publicKey, ready: async () => true,
      signOriginal: async () => { signCalls++; throw Error('Fixture stops before any signature'); } },
    sources: source.sources, blockhashSource,
    reconcile: { backing: { reader: source.backing.reader, trust: source.backing.trust },
      settlement: { reader: receiptReader, trust: source.backing.trust },
      transport: () => { throw Error('Fixture must not enter transport'); } }, report: () => {},
  };
  return { source, options, blockhashSource, blockhashReads: () => blockhashReads, signCalls: () => signCalls };
}

/** Forward every operation to the real database. Recording cannot synthesize
 * rows, owner permissions, custody decisions, preparation, or success. */
function observeDatabase(db: Db) {
  const queries: Query[] = [], dialect = new PgDialect();
  const observed = new Proxy(db, { get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver);
    if (name === 'execute') return (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
      queries.push(dialect.sqlToQuery(statement));
      return target.execute(statement);
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db: observed, queries };
}
function scanQuery(queries: Query[]) {
  const q = queries.find(q => q.sql.includes('e.epoch_key ~'));
  if (!q) throw Error('Actual job scan was not executed'); return q;
}
function scopeQuery(queries: Query[]) {
  const q = queries.find(q => q.sql.includes('"originalsInFlight"'));
  if (!q) throw Error('Actual job unfinished-original query was not executed'); return q;
}
async function boundary(f: Fixture, query: Query, instant: string, timezone: string) {
  // Execute the actual production-generated SQL, replacing ONLY its wall clock
  // with a bound fixture instant. This proves PostgreSQL boundary/regex/cast
  // semantics; it is not a production clock injection or an elapsed-day claim.
  expect(query.sql.match(/clock_timestamp\(\)/g)).toHaveLength(1);
  const text = query.sql.replace('clock_timestamp()', `$${query.params.length + 1}::timestamptz`);
  return f.conn.sql.begin(async tx => {
    await tx`select set_config('TimeZone',${timezone},true)`;
    return tx.unsafe(text, [...query.params, instant] as never);
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('F4 publication fixture clock preserves prospective source seals', () => {
  const definitions = (f: Fixture) => f.conn.sql`select proname,pg_get_functiondef(oid) definition from pg_proc
    where pronamespace='public'::regnamespace and proname in
    ('shardkeep_mining_free_clock','shardkeep_mining_development_clock','shardkeep_mining_roster_clock') order by proname`;
  const seals = (f: Fixture) => f.conn.sql`select 'enrollment' source,record::text from mining_seeker_enrollment_contract
    union all select 'existing',record::text from mining_existing_wallet_contract
    union all select 'zero',record::text from mining_gems_zero_contract order by source`;
  const retirement = (f: Fixture) => f.conn.sql`select record::text,
    record->>'retirement' sealed,public.shardkeep_raid_starter_retirement_predecessor() live
    from public.bound_cosmetic_charter_contract where singleton`;
  it('F4a full fixture setup preserves the sealed trigger state and its source check through clock changes', async () => fixture(async f => {
    // The callback runs after all migrations AND all coverage initialization.
    // Passing immediately after migration alone cannot discharge this regression.
    await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
    const coverage = await f.conn.sql`select 'free' source,started_at='2019-12-30T00:00:00Z'::timestamptz correct from mining_free_coverage
      union all select 'gems',started_at='2019-12-30T00:00:00Z'::timestamptz from mining_free_gems_coverage
      union all select 'flow',started_at='2019-12-30T00:00:00Z'::timestamptz from mining_gems_flow_coverage`;
    expect(coverage).toHaveLength(3); expect(coverage.every(row => row.correct)).toBe(true);
    const fingerprint = await retirement(f);
    expect(fingerprint).toHaveLength(1); expect(fingerprint[0]!.live).toBe(fingerprint[0]!.sealed);
    const before = await definitions(f), sealed = await seals(f);
    expect(before).toHaveLength(3); expect(sealed).toHaveLength(3);
    for (const instant of ['2020-01-01T13:00:00Z', '2020-01-02T13:00:00Z', null]) {
      await f.clock(instant);
      expect(await definitions(f)).toEqual(before); expect(await seals(f)).toEqual(sealed);
      expect(await retirement(f)).toEqual(fingerprint);
      await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
      if (instant !== null) {
        const [at] = await f.conn.sql`select
          public.shardkeep_mining_free_clock()=${instant}::timestamptz free,
          public.shardkeep_mining_development_clock()=${instant}::timestamptz development,
          public.shardkeep_mining_roster_clock()=${instant}::timestamptz roster`;
        expect(at).toEqual({ free: true, development: true, roster: true });
      }
    }
    const triggers = await f.conn.sql`select t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where c.relnamespace='public'::regnamespace and not t.tgisinternal
      and c.relname in ('mining_seeker_enrollment_contract','mining_existing_wallet_contract','mining_gems_zero_contract')`;
    expect(triggers).toHaveLength(6); expect(triggers.every(t => t.tgenabled === 'O')).toBe(true);
  }), 180_000);
  it('F4b clock substitution is refused by its enrollment seal, independently of the Divine fingerprint', async () => fixture(async f => {
    const before = await definitions(f), sealed = await seals(f);
    await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
    const [valid] = await f.conn.sql`select public.shardkeep_mining_seeker_enrollment_sources_valid() valid`;
    expect(valid!.valid).toBe(true);
    await expect(f.conn.sql.begin(async tx => {
      // The error rolls back the adversarial substitution with its transaction.
      await tx`create or replace function public.shardkeep_mining_free_clock() returns timestamptz
        language sql volatile as $$ select clock_timestamp() $$`;
      const [changed] = await tx`select public.shardkeep_mining_seeker_enrollment_sources_valid() valid`;
      expect(changed!.valid).toBe(false);
      // The free clock is not in the Divine retirement fingerprint path.
      await tx`select public.shardkeep_divine_fragment_source()`;
      // BEFORE INSERT checks its source seal before checking link eligibility.
      await tx`insert into public.mining_seeker_enrollments(wallet) values(${f.wallet})`;
    })).rejects.toMatchObject({ message: 'MINING_SEEKER_ENROLLMENT_SOURCE_UNAVAILABLE' });
    expect(await definitions(f)).toEqual(before); expect(await seals(f)).toEqual(sealed);
    const [restored] = await f.conn.sql`select public.shardkeep_mining_seeker_enrollment_sources_valid() valid`;
    expect(restored!.valid).toBe(true);
    await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
  }), 180_000);
  it('F4c refuses installing over an existing history and refuses an invalid clock without changing it', async () => fixture(async f => {
    const before = await definitions(f), sealed = await seals(f);
    await expect(runMiningPublicationFixtureMigrations(f.conn, '2019-12-30T00:00:00Z')).rejects.toThrow('fresh empty publication fixture required');
    await f.clock('2020-01-01T13:00:00Z');
    await expect(f.clock('not-a-timestamp')).rejects.toThrow('finite publication fixture clock required');
    const [at] = await f.conn.sql`select public.shardkeep_mining_free_clock()='2020-01-01T13:00:00Z'::timestamptz same`;
    expect(at!.same).toBe(true); expect(await definitions(f)).toEqual(before); expect(await seals(f)).toEqual(sealed);
  }), 180_000);
  it('F4d a changed capture-trigger state breaks the retirement fingerprint and Divine source guard', async () => fixture(async f => {
    await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
    const before = await retirement(f);
    expect(before[0]!.live).toBe(before[0]!.sealed);
    await expect(f.conn.sql.begin(async tx => {
      // Only this rolled-back adversarial transaction changes the capture state.
      await tx`alter table public.accounts disable trigger accounts_mining_gems_flow_capture`;
      const [changed] = await tx`select record->>'retirement' sealed,
        public.shardkeep_raid_starter_retirement_predecessor() live from public.bound_cosmetic_charter_contract where singleton`;
      expect(changed!.live).not.toBe(changed!.sealed);
      await tx`select public.shardkeep_divine_fragment_source()`;
    })).rejects.toMatchObject({ message: 'DIVINE_FRAGMENT_SOURCE' });
    expect(await retirement(f)).toEqual(before);
    await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
  }), 180_000);
  it.each(['enrollmentClock', 'precoverageBuyer', 'delayedSeekerMarker'] as const)(
    'F4e publication coverage refuses incompatible %s ordering before opening a fixture', async option => {
      const run = vi.fn(async () => {});
      await expect(baseFixture(run, { publicationClock: true, [option]: true }))
        .rejects.toThrow('publication clock requires ordinary prospective coverage ordering');
      expect(run).not.toHaveBeenCalled();
    });
});

describe('B1/M3 actual job SQL gates', () => {
  it('executes the actual UTC closing predicate at one microsecond before and exactly midnight in two database timezones', async () => fixture(async f => {
    const first = await contribute(f, originalDay), b = await bank(f), observed = observeDatabase(f.conn.db);
    const job = createMiningPublicationJob(observed.db, { ...b.options, publisher: null, sources: null, blockhashSource: null });
    try {
      expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'PUBLISHER_UNAVAILABLE', epochId: first.epochId });
      const query = scanQuery(observed.queries);
      for (const timezone of ['UTC', 'America/Los_Angeles']) {
        expect(await boundary(f, query, '2020-01-01T23:59:59.999999Z', timezone)).toHaveLength(0);
        expect(await boundary(f, query, '2020-01-02T00:00:00.000000Z', timezone)).toMatchObject([{ epochId: first.epochId, day: originalDay, policyVersion: 2 }]);
      }
      expect(await f.conn.sql`select epoch_id from mining_publication_attempts`).toHaveLength(0);
    } finally { await job.close(); }
  }), 180_000);

  it('normal runOnce selects a real closed day, excludes an actual abort, and leaves the current UTC day open', async () => fixture(async f => {
    const [now] = await f.conn.sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD') as "day"`;
    const today = String(now!.day), yesterday = dayOffset(today, -1);
    const closed = await contribute(f, yesterday), open = await contribute(f, today), b = await bank(f);
    const job = createMiningPublicationJob(f.conn.db, { ...b.options, publisher: null, sources: null, blockhashSource: null });
    try {
      expect(await job.runOnce()).toMatchObject({ reason: 'PUBLISHER_UNAVAILABLE', epochId: closed.epochId });
      await abortMiningContributions(f.conn.db, { epochId: closed.epochId, decisionKey: randomUUID(), reason: 'fixture-abort-undecided-day' });
      expect(await job.runOnce()).toEqual({ status: 'idle' });
      expect(await f.conn.sql`select epoch_id from mining_publication_attempts where epoch_id=${open.epochId}`).toHaveLength(0);
      expect(await f.conn.sql`select receipt_id from mining_contribution_terminals where epoch_id=${open.epochId}`).toHaveLength(0);
    } finally { await job.close(); }
  }), 180_000);

  it('repeated holds retain the oldest real closed basket and never prepare the later day', async () => fixture(async f => {
    const first = await contribute(f, originalDay), later = await contribute(f, dayOffset(originalDay, 1)), b = await bank(f);
    const job = createMiningPublicationJob(f.conn.db, { ...b.options, publisher: null, sources: null, blockhashSource: null });
    try {
      for (let pass = 0; pass < 3; pass++) expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'PUBLISHER_UNAVAILABLE', epochId: first.epochId });
      expect(job.getLastResult()).toMatchObject({ status: 'held', day: originalDay, epochId: first.epochId });
      expect(await f.conn.sql`select epoch_id from mining_publication_attempts`).toHaveLength(0);
      expect(await f.conn.sql`select receipt_id from mining_contribution_terminals where epoch_id in (${first.epochId},${later.epochId})`).toHaveLength(0);
      expect(b.signCalls()).toBe(0);
    } finally { await job.close(); }
  }), 180_000);

  it.each([POLICY.publisherMaxGapDays, POLICY.publisherMaxGapDays + 1])('runs the real planner at a %i-day frontier gap without inventing recovery authority', async gap => fixture(async f => {
    const legacy = await prepareInitialFreePublication(f);
    await abortPendingMiningEpoch(f.conn.db, { epochId: legacy.epochId, decisionKey: randomUUID(), reason: 'fixture-migrate-to-resources' });
    const resource = await contribute(f, originalDay), b = await bank(f);
    const day = BigInt(Date.parse(originalDay) / (POLICY.daySec * 1000));
    b.source.backing.model.genesis_day = day - BigInt(gap) + 1n;
    b.source.backing.model.latest_day = day - BigInt(gap);
    await b.source.backing.config();
    const job = createMiningPublicationJob(f.conn.db, b.options);
    try {
      const result = await job.runOnce();
      expect(result).toMatchObject({ status: 'held', epochId: resource.epochId,
        reason: gap === POLICY.publisherMaxGapDays ? 'SIGNING_UNCERTAIN' : 'ONCHAIN_PUBLISHER_REFUSED' });
      expect(await f.conn.sql`select epoch_id from mining_publication_attempts where epoch_id=${resource.epochId}`).toHaveLength(gap === POLICY.publisherMaxGapDays ? 1 : 0);
      expect(b.blockhashReads()).toBe(gap === POLICY.publisherMaxGapDays ? 1 : 0);
      expect(b.signCalls()).toBe(gap === POLICY.publisherMaxGapDays ? 1 : 0);
      expect(await f.conn.sql`select epoch_id from mining_publication_signed_wires`).toHaveLength(0);
      expect(await f.conn.sql`select receipt_id from mining_contribution_terminals where epoch_id=${resource.epochId}`).toHaveLength(0);
    } finally { await job.close(); }
  }), 180_000);

  it.each([false, true])('M3: an actual ingot original blocks new resource preparation (signing reserved=%s)', async reserveSigning => fixture(async f => {
    const input = await prepareInitialFreePublication(f), b = await bank(f);
    const request = { ...input, attemptKey: randomUUID() };
    const prepare = createInitialFreePublicationPreparer(f.conn.db, { sources: b.source.sources,
      signer: f.walletSigner.publicKey, blockhashSource: b.blockhashSource });
    const old = await prepare(request); if (old.status !== 'prepared') throw Error('Actual legacy prepared original required');
    if (reserveSigning) await createMiningPublicationOutbox(f.conn.db, { reader: b.source.backing.reader, trust: b.source.backing.trust }).reserveSigning({ epochId: request.epochId, attemptKey: request.attemptKey });
    const resource = await contribute(f, originalDay), observed = observeDatabase(f.conn.db), before = b.blockhashReads();
    const job = createMiningPublicationJob(observed.db, b.options);
    try {
      expect(await job.runOnce()).toEqual({ status: 'held', reason: 'ORIGINAL_IN_FLIGHT', epochId: resource.epochId });
      const query = scopeQuery(observed.queries);
      expect(await f.conn.sql.unsafe(query.sql, query.params as never)).toEqual([{ originalsInFlight: true }]);
      expect(await f.conn.sql`select epoch_id from mining_publication_attempts order by epoch_id`).toEqual([{ epoch_id: old.epochId }]);
      expect(await f.conn.sql`select epoch_id from mining_publication_signing_reservations`).toHaveLength(reserveSigning ? 1 : 0);
      expect(b.blockhashReads()).toBe(before); expect(b.signCalls()).toBe(0);
      expect(await f.conn.sql`select receipt_id from mining_contribution_terminals where epoch_id=${resource.epochId}`).toHaveLength(0);
    } finally { await job.close(); }
  }), 180_000);

  it('M3 unfinished-original query also recognizes a real resource attempt before signing reservation', async () => fixture(async f => {
    const legacy = await prepareInitialFreePublication(f);
    await abortPendingMiningEpoch(f.conn.db, { epochId: legacy.epochId, decisionKey: randomUUID(), reason: 'fixture-migrate-to-resources' });
    const resource = await contribute(f, originalDay), b = await bank(f), observed = observeDatabase(f.conn.db);
    // Enter the normal job's real SQL checks but stop at the external source
    // boundary before preparation, so the exact query can be retained.
    const { tax: _tax, ...sourcesWithoutTax } = b.options.sources;
    const noSources = { ...b.options, sources: sourcesWithoutTax };
    const job = createMiningPublicationJob(observed.db, noSources);
    try {
      expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'PUBLICATION_SOURCE_UNAVAILABLE' });
      const query = scopeQuery(observed.queries);
      expect(await f.conn.sql.unsafe(query.sql, query.params as never)).toEqual([{ originalsInFlight: false }]);
      const prepare = createResourceMiningPublicationPreparer(f.conn.db, { signer: f.walletSigner.publicKey,
        sources: b.source.sources, blockhashSource: b.blockhashSource });
      const result = await prepare({ epochId: resource.epochId, day: originalDay, policyVersion: 2, attemptKey: randomUUID() });
      expect(result.status).toBe('prepared');
      expect(await f.conn.sql`select epoch_id from mining_publication_signing_reservations`).toHaveLength(0);
      expect(await f.conn.sql.unsafe(query.sql, query.params as never)).toEqual([{ originalsInFlight: true }]);
      const foreign = query.params.map(p => p === SOLANA_GENESIS_HASH.devnet ? key(78).toBase58() : p);
      expect(await f.conn.sql.unsafe(query.sql, foreign as never)).toEqual([{ originalsInFlight: false }]);
    } finally { await job.close(); }
  }), 180_000);

  it('M3 commit fence permits one of two cross-domain preparations on separate connections and leaves the loser wholly unattempted', async () => fixture(async f => {
    const ingot = await prepareInitialFreePublication(f), resource = await contribute(f, originalDay), b = await bank(f);
    const resourceInput = { epochId: resource.epochId, day: originalDay, policyVersion: 2 as const };
    // Capture both genuine plans before either transaction. Reusing these exact
    // real planner results deterministically models the stale-frontier race;
    // neither the common preparer nor its database authority is mocked.
    const ingotPlan = await createInitialFreeAllocationPlanner(f.conn.db, b.source.sources)(ingot);
    const resourcePlan = await createResourceMiningAllocationPlanner(f.conn.db, b.source.sources)(resourceInput);
    expect(ingotPlan.projection).toBe('READY'); expect(resourcePlan.projection).toBe('READY');
    const other = createDb(f.url.toString(), { max: 1 });
    let arrived = 0, release!: () => void;
    const bothBlockhashReads = new Promise<void>(resolve => { release = resolve; });
    const gate = () => { const source = b.blockhashSource(); return { ...source,
      getLatestBlockhashAndContext: async () => {
        arrived++; if (arrived === 2) release();
        await bothBlockhashReads; return source.getLatestBlockhashAndContext();
      } }; };
    const prepareOptions = { signer: f.walletSigner.publicKey, sources: b.source.sources, blockhashSource: gate };
    try {
      const preparations = await Promise.allSettled([
        createPublicationPreparer(f.conn.db, prepareOptions, async () => ingotPlan)({ ...ingot, attemptKey: randomUUID() }),
        createPublicationPreparer(other.db, prepareOptions, async () => resourcePlan)({ ...resourceInput, attemptKey: randomUUID() }),
      ]);
      expect(arrived).toBe(2);
      const winners = preparations.filter(result => result.status === 'fulfilled');
      const losers = preparations.filter(result => result.status === 'rejected');
      expect(winners).toHaveLength(1); expect(losers).toHaveLength(1);
      expect(losers[0]!.status === 'rejected' && losers[0]!.reason).toMatchObject({ code: 'ORIGINAL_IN_FLIGHT' });
      const winner = winners[0]!;
      if (winner.status !== 'fulfilled' || winner.value.status !== 'prepared') throw Error('One actual prepared winner required');
      const losingEpoch = winner.value.epochId === ingot.epochId ? resource.epochId : ingot.epochId;
      expect(await f.conn.sql`select epoch_id from mining_publication_attempts`).toEqual([{ epoch_id: winner.value.epochId }]);
      expect(await f.conn.sql`select epoch_id from mining_publication_manifests where epoch_id=${losingEpoch}`).toHaveLength(0);
      expect(await f.conn.sql`select epoch_id from mining_publication_signing_reservations`).toHaveLength(0);
      expect(await f.conn.sql`select epoch_id from mining_publication_signed_wires`).toHaveLength(0);
      expect(await f.conn.sql`select receipt_id from mining_contribution_terminals where epoch_id=${resource.epochId}`).toHaveLength(0);
      expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions where epoch_id=${ingot.epochId}`).toHaveLength(0);
      expect((await readMiningContribution(f.conn.db, f.wallet, resource.id)).settlement).toBeNull();
      expect(await f.conn.sql`select qty from mining_ingot_reservations where epoch_id=${ingot.epochId}`).toEqual([{ qty: 1 }]);
    } finally { release(); await other.sql.end(); }
  }), 180_000);

  it('M3 commit fence rejects a stale resource plan after its legacy sequence winner has actually settled', async () => fixture(async f => {
    const ingot = await prepareInitialFreePublication(f), resource = await contribute(f, originalDay), b = await bank(f);
    const resourceInput = { epochId: resource.epochId, day: originalDay, policyVersion: 2 as const };
    const stale = await createResourceMiningAllocationPlanner(f.conn.db, b.source.sources)(resourceInput);
    expect(stale.projection).toBe('READY');
    const options = { signer: f.walletSigner.publicKey, sources: b.source.sources, blockhashSource: b.blockhashSource };
    const original = await createInitialFreePublicationPreparer(f.conn.db, options)({ ...ingot, attemptKey: randomUUID() });
    if (original.status !== 'prepared') throw Error('Actual ingot winner required');
    const request = { epochId: original.epochId, attemptKey: original.attemptKey }, p = original.publication;
    const snapshot = await createMiningBackingSnapshotReader(b.source.backing.reader, b.source.backing.trust)();
    const outbox = createMiningPublicationOutbox(f.conn.db, { reader: b.source.backing.reader, trust: b.source.backing.trust });
    await outbox.reserveSigning(request);
    // Existing external-chain fixture signs only under the content pipeline's exact admission;
    // terminal verification, SQL insertion and custody disposition are real.
    const chain = await createMiningPublicationFixture('legacy', { signer: f.walletSigner, identity: b.source.backing.trust,
      genesisHash: b.source.backing.trust.expectedGenesisHash, programData: b.source.backing.programData,
      intentBytes: Buffer.from(original.intentHex, 'hex'), priorFrontier: snapshot.config,
      vaultBefore: snapshot.vaultAmount, reserveBefore: snapshot.reserveAmount, publicationSlot: snapshot.slot + 1,
      args: { sequence: BigInt(p.sequence), day: BigInt(p.day), kind: 0, root: Buffer.from(p.root, 'hex'),
        totalCumulative: BigInt(p.total), leafCount: p.leafCount, budgetGross: BigInt(p.budgetGross),
        freeGross: BigInt(p.freeGross), deedGross: BigInt(p.deedGross), sourceHash: Buffer.from(original.sourceHash, 'hex'),
        taxCommitment: Buffer.from(p.taxCommitment, 'hex'), taxVersion: p.taxVersion } });
    await outbox.acceptSigned({ ...request, signedTransaction: chain.request.signedTransaction });
    await createMiningPublicationSettlement(f.conn.db, { reader: chain.reader, trust: chain.trusted })({ ...request,
      signature: chain.request.signature, signedTransaction: chain.request.signedTransaction });
    expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toEqual([{ epoch_id: original.epochId }]);
    await expect(createPublicationPreparer(f.conn.db, options, async () => stale)({ ...resourceInput, attemptKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await f.conn.sql`select epoch_id from mining_publication_attempts where epoch_id=${resource.epochId}`).toHaveLength(0);
    expect(await f.conn.sql`select epoch_id from mining_publication_manifests where epoch_id=${resource.epochId}`).toHaveLength(0);
    expect(await f.conn.sql`select receipt_id from mining_contribution_terminals where epoch_id=${resource.epochId}`).toHaveLength(0);
    expect((await readMiningContribution(f.conn.db, f.wallet, resource.id)).settlement).toBeNull();
  }), 180_000);
});
