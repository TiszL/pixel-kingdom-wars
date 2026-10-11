/** Normal browser/native collection invokes server-owned prospective admission.
 * Real finalized account/settlement verification runs against the injected bank. */
import { Keypair, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_OWNERSHIP, MINING, PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION, getMiningQuota } from '@shardkeep/shared';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { buildApp, type AppDeps } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, buildings, mineAccrualStates, players, sessions } from '../src/db/schema';
import { MINE_DAY_MS } from '../src/game/baseMining';
import { TEST_CONFIG } from './helpers';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

const conn = resourceClaimsDatabase(), db = conn.db;
const start = new Date('2035-01-01T00:00:00.000Z'), quota = getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS);
const unitMs = MINE_DAY_MS / quota, servers: FastifyInstance[] = [];
let original: Awaited<ReturnType<typeof createMiningTermFixture>>, bank: typeof original;
const connect = vi.fn((signal: AbortSignal) => bank.connect(signal));
function time(at: Date) {
  vi.setSystemTime(at); bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+at / 1_000)), 32);
}
beforeAll(async () => {
  await conn.setup();
  await conn.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at) values(1,1,1,1,${start.toISOString()})`;
  original = await createMiningTermFixture({ day: '2035-01-01', genesisHash: Keypair.generate().publicKey, programId: Keypair.generate().publicKey });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); bank = original; time(start);
  connect.mockReset().mockImplementation((signal: AbortSignal) => bank.connect(signal));
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); vi.stubEnv('FREE_ONBOARDING', 'true');
});
afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
afterAll(() => conn.close());
async function open(provider = true, market?: AppDeps['market']) {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  try {
    const app = await buildApp(TEST_CONFIG, db, {
      ...(provider ? { physicalMineSourceProvider: { policy: original.policy, connect } } : {}),
      ...(market ? { market } : {}),
    });
    servers.push(app); await app.ready(); return app;
  } finally { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); }
}
async function fixture() {
  // Deeded ownership requires a signable wallet; arbitrary random public-key
  // bytes can be off-curve and make the paid-base case fail nondeterministically.
  const wallet = Keypair.generate().publicKey.toBase58();
  await db.insert(players).values({ wallet });
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 1 }).returning();
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
  const [mine] = await db.insert(buildings).values({ playerWallet: wallet, baseId: base!.id, type: 'mine', level: 1, tx: 1, ty: 1 }).returning();
  await db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: start });
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(+start + SESSION_TTL_SEC * 1_000) }).returning();
  return { wallet, base: base!, mine: mine!, cookies: { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const collect = (app: FastifyInstance, f: Fixture, payload: object = { baseId: f.base.id }) => app.inject({ method: 'POST', url: '/mine/collect', payload, cookies: f.cookies });
const admissions = (f: Fixture) => conn.sql`select id,mine_ids from shards_mine_admissions where wallet=${f.wallet} order by admitted_at`;
const state = async (f: Fixture) => (await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mine.id)))[0]!;

describe.sequential('automatic physical Mine source admission through normal collection', () => {
  it('admits through the existing selected-base POST, then returns only the conserved server amount', async () => {
    const f = await fixture(), app = await open();
    const initial = await collect(app, f); expect(initial.statusCode, initial.body).toBe(200); expect(initial.json()).toEqual({ amount: '0' });
    expect(await admissions(f)).toHaveLength(1); expect(connect).toHaveBeenCalledOnce();
    time(new Date(+start + 2 * unitMs)); const paid = await collect(app, f);
    expect(paid.statusCode, paid.body).toBe(200); expect(paid.json()).toEqual({ amount: '2' });
    expect((await collect(app, f)).json()).toEqual({ amount: '0' });
    expect(await admissions(f)).toHaveLength(1); expect(connect).toHaveBeenCalledOnce();
    const [net] = await conn.sql`select coalesce(sum(e.delta),0)::text amount from ledger_entries e join accounts a on a.id=e.account_id where a.base_id=${f.base.id} and a.kind='base_shards'`;
    expect(net!.amount).toBe('2');
  });

  it('keeps the fractional anchor on empty taps and converges concurrent first requests to one source', async () => {
    const f = await fixture(), app = await open();
    const responses = await Promise.all([collect(app, f), collect(app, f)]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200]); expect(await admissions(f)).toHaveLength(1);
    const before = await state(f), reads = connect.mock.calls.length;
    time(new Date(+start + Math.floor(unitMs * 3 / 4)));
    expect((await collect(app, f)).json()).toEqual({ amount: '0' }); expect(await state(f)).toEqual(before);
    time(new Date(+start + Math.ceil(unitMs * 3 / 2)));
    expect((await collect(app, f)).json()).toEqual({ amount: '1' });
    expect(await admissions(f)).toHaveLength(1); expect(connect).toHaveBeenCalledTimes(reads);
  });

  it('enrolls a newly producing Mine without destroying a covered sibling fractional clock', async () => {
    const f = await fixture(), app = await open(); expect((await collect(app, f)).statusCode).toBe(200);
    const before = await state(f); time(new Date(+start + Math.floor(unitMs * 3 / 4)));
    const [mine] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.base.id, type: 'mine', level: 1, tx: 3, ty: 3 }).returning();
    await db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: new Date() });
    const response = await collect(app, f); expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ amount: '0' });
    expect(await state(f)).toEqual(before); expect((await admissions(f))[1]!.mine_ids).toEqual([mine!.id]);
    time(new Date(+start + Math.ceil(unitMs * 3 / 2))); expect((await collect(app, f)).json()).toEqual({ amount: '1' });
  });

  it('keeps covered collection available while paused and with the provider absent after restart', async () => {
    const f = await fixture(), app = await open(); expect((await collect(app, f)).statusCode).toBe(200);
    const restarted = await open(false); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); time(new Date(+start + 2 * unitMs));
    const response = await collect(restarted, f); expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ amount: '2' });
    expect(await admissions(f)).toHaveLength(1); expect(connect).toHaveBeenCalledOnce();
  });

  it('a failed current reader cannot strand a covered sibling when the new Mine has no whole earning', async () => {
    const f = await fixture(), app = await open(); expect((await collect(app, f)).statusCode).toBe(200);
    time(new Date(+start + 2 * unitMs));
    const [mine] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.base.id, type: 'mine', level: 1, tx: 3, ty: 3 }).returning();
    await db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: new Date() });
    connect.mockImplementationOnce(() => { throw Error('Fixture provider outage'); });
    const response = await collect(app, f); expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ amount: '2' });
    expect(await admissions(f)).toHaveLength(1);
    expect(await conn.sql`select mine_id from shards_mine_heads where mine_id=${mine!.id}`).toHaveLength(0);
  });

  it('does not turn an unavailable provider or delayed first admission into legacy production', async () => {
    const f = await fixture(), missing = await open(false); time(new Date(+start + 2 * unitMs));
    const response = await collect(missing, f); expect(response.statusCode, response.body).toBe(503); expect(response.json().error.code).toBe('SHARDS_SOURCE_HELD');
    expect(await admissions(f)).toHaveLength(0); expect((await state(f)).lastAccrualAt).toEqual(start);
    const app = await open(); const later = await collect(app, f); expect(later.statusCode, later.body).toBe(503);
    expect(later.json().error.code).toBe('SHARDS_SOURCE_HELD'); expect(await admissions(f)).toHaveLength(1);
    const [held] = await conn.sql`select sum(buffer)::text amount from shards_mine_segments where mine_id=${f.mine.id} and wallet is not null and admission_id is null`;
    expect(held!.amount).toBe('2');
  });

  it('authenticates before source reads and rechecks custody after finalized prefetch', async () => {
    const f = await fixture(), app = await open();
    expect((await app.inject({ method: 'POST', url: '/mine/collect', payload: { baseId: f.base.id } })).statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
    connect.mockImplementationOnce(signal => { const rpc = bank.connect(signal), read = rpc.getGenesisHash.bind(rpc); return { ...rpc, getGenesisHash: async () => {
      await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.base.id)); return read();
    } }; });
    const response = await collect(app, f); expect(response.statusCode, response.body).toBe(404); expect(await admissions(f)).toHaveLength(0);
  });

  it('renews paid-base deed proof after a healthy term read crosses its shorter freshness window', async () => {
    const f = await fixture(), assetId = Keypair.generate().publicKey.toBase58(), collection = Keypair.generate().publicKey.toBase58();
    await db.update(bases).set({ deedAssetId: assetId }).where(eq(bases.id, f.base.id));
    const proofTimes: number[] = [];
    const deedReader = vi.fn(async (asset: string, floor?: number) => {
      expect(asset).toBe(assetId); proofTimes.push(Date.now());
      return { owner: f.wallet, collection, frozen: false, delegate: null, slot: Math.max(100, floor ?? 0) + proofTimes.length };
    });
    const app = await open(true, { finalizedDeedReader: deedReader, deedCollection: collection });
    const delayedAt = new Date(+start + BASE_OWNERSHIP.mutationFreshnessMs + 1_000);
    expect(+delayedAt - +start).toBeLessThan(unitMs);
    connect.mockImplementationOnce(signal => {
      const rpc = bank.connect(signal), read = rpc.getGenesisHash.bind(rpc);
      return { ...rpc, getGenesisHash: async () => { expect(proofTimes).toEqual([+start]); time(delayedAt); return read(); } };
    });
    const response = await collect(app, f);
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ amount: '0' });
    expect(proofTimes).toEqual([+start, +delayedAt]); expect(connect).toHaveBeenCalledOnce();
    expect(await admissions(f)).toHaveLength(1);
    const [accepted] = await conn.sql`select admitted_at from shards_mine_admissions where wallet=${f.wallet}`;
    expect(+new Date(accepted!.admitted_at)).toBe(+delayedAt);
  });

  it('pins an omitted sole-base selection across prefetch instead of letting another base become the target', async () => {
    const f = await fixture(), app = await open(); let added = false;
    connect.mockImplementationOnce(signal => { const rpc = bank.connect(signal), read = rpc.getGenesisHash.bind(rpc); return { ...rpc, getGenesisHash: async () => {
      if (!added) { added = true;
        const [other] = await db.insert(bases).values({ ownerWallet: f.wallet, status: 'active' }).returning();
        await db.insert(baseSlots).values({ wallet: f.wallet, slot: 2, baseId: other!.id });
      }
      return read();
    } }; });
    const response = await collect(app, f, {}); expect(response.statusCode, response.body).toBe(200);
    expect(added).toBe(true); expect(await admissions(f)).toHaveLength(1);
    expect((await admissions(f))[0]!.mine_ids).toEqual([f.mine.id]);
  });

  it('discovers the next operating round without letting that source cover the offline preceding gap', async () => {
    const f = await fixture(), app = await open(); expect((await collect(app, f)).statusCode).toBe(200);
    const next = new Date(+start + PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000);
    const beforeRollover = new Date(+next - PHASE_E_SEEKER_AUCTION.settlementGraceSec * 1_000 - unitMs);
    time(beforeRollover);
    const [freshSession] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(+next + SESSION_TTL_SEC * 1_000) }).returning();
    f.cookies[SESSION_COOKIE] = await issueSessionJwt(TEST_CONFIG, f.wallet, freshSession!.id);
    expect((await collect(app, f)).statusCode).toBe(200);
    bank = await createMiningTermFixture({ day: next.toISOString().slice(0, 10), genesisHash: original.policy.genesisHash,
      programId: original.policy.programId, programData: original.programData, programDataAddress: original.programDataAddress,
      upgradeAuthority: original.upgradeAuthority, mint: original.policy.mint, prizeOwner: original.policy.prizeOwner, round: 1n,
      firstOperatingStart: BigInt(+start / 1_000 - PHASE_E_SEEKER_AUCTION.settlementGraceSec) });
    time(next);
    // Renew the fixture session without changing the actual game caller.
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(+next + SESSION_TTL_SEC * 1_000) }).returning();
    f.cookies[SESSION_COOKIE] = await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id);
    const response = await collect(app, f); expect(response.statusCode, response.body).toBe(503); expect(response.json().error.code).toBe('SHARDS_SOURCE_HELD');
    expect(await admissions(f)).toHaveLength(2);
    const [source] = await conn.sql`select a.observation from shards_mine_heads h join shards_mine_admissions a on a.id=h.admission_id where h.mine_id=${f.mine.id}`;
    expect(source!.observation.snapshot.source.round).toBe('1');
  });
});
