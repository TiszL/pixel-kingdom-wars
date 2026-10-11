/** HTTP/SQL fixtures use a deliberately synthetic term reader. Real chain
 * prefetch is independently tested and the genuine timed acceptance stays held. */
import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, CAPS } from '@shardkeep/shared';
import { matchStarterExpeditionEnvelope, StarterExpeditionViewSchema } from '@shardkeep/shared/starterExpeditionApi';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, builderJobs, buildings, expeditionFreeHomes, expeditionTermSnapshots, ledgerTransactions, players, sessions, starterExpeditions, starterExpeditionInflight } from '../src/db/schema';
import * as ownership from '../src/game/baseOwnership';
import { placeBuilding } from '../src/game/base';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { claimRect } from '../src/game/footprints';
import * as termStore from '../src/game/expeditionTermStore';
import * as prefetch from '../src/game/expeditionTermReader';
import * as dispatch from '../src/game/starterExpeditionDispatch';
import { readStarterExpeditionReturn } from '../src/game/starterExpeditionReturns';
import type { StarterExpeditionProvider } from '../src/game/starterExpeditionRoutes';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
const conn = connectTestDb(), db = conn.db; let app: FastifyInstance, missing: FastifyInstance;
const key = new PublicKey('11111111111111111111111111111111');
const provider: StarterExpeditionProvider = { policy: { genesisHash: key, programId: key, config: key, round: 1n,
  mint: key, prizeOwner: key, prizeAta: key, stateProvenance: 'fresh-reviewed-deployment',
  deployment: { programDataAddress: key.toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } },
  connect: () => { throw new Error('Synthetic HTTP test must not contact RPC'); } };
beforeAll(async () => {
  const old = process.env['MULTI_BASE_ENABLED']; process.env['MULTI_BASE_ENABLED'] = 'false';
  try { await bootstrapSystemAccounts(db); app = await buildApp(TEST_CONFIG, db, { starterExpeditionProvider: provider });
    missing = await buildApp(TEST_CONFIG, db); await app.ready(); await missing.ready(); }
  finally { if (old === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = old; }
});
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'true'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await app.close(); await missing.close(); await conn.sql.end(); });
async function fixture(now = new Date()) {
  const f = await createStarterExpeditionFixture(db, { now });
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
  const { id: idempotencyKey, ...body } = f.command;
  return { ...f, request: { idempotencyKey, ...body }, cookies: { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, body = f.request, server = app) => server.inject({ method: 'POST', url: '/starter-expeditions', cookies: f.cookies, payload: body });
const get = (f: Fixture, url = `/starter-expeditions?baseId=${f.baseId}`, server = app) => server.inject({ url, cookies: f.cookies });
const receipt = (f: Fixture, id = f.request.idempotencyKey, server = app) => get(f, `/starter-expeditions/by-key/${id}`, server);
const trips = (f: Fixture) => db.select().from(starterExpeditions).where(eq(starterExpeditions.baseId, f.baseId));
const homes = (f: Fixture) => db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId));
const mock = (f: Fixture) => vi.spyOn(prefetch, 'prefetchExpeditionTermReader').mockImplementation(async () => {
  let used = false; return { async readOperatingTerm(at: string) { if (used) throw new Error('one use'); used = true; return f.reader.readOperatingTerm(at); } };
});
function barrier() { let arrive!: () => void, release!: () => void;
  return { seen: new Promise<void>(r => { arrive = r; }), gate: new Promise<void>(r => { release = r; }), arrive: () => arrive(), release: () => release() }; }
async function transfer(f: Fixture, buyer: Fixture) {
  await db.transaction(async tx => {
    await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
    await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
    await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
    await tx.insert(baseSlots).values({ wallet: buyer.wallet, baseId: f.baseId, slot: 2 });
  });
}
describe('authenticated synthetic starter departure HTTP', () => {
  it('authenticates all routes before pauses and never accepts client authority', async () => {
    const f = await fixture(), rpc = mock(f); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    for (const opts of [{ url: `/starter-expeditions?baseId=${f.baseId}` }, { method: 'POST' as const, url: '/starter-expeditions', payload: f.request },
      { url: `/starter-expeditions/by-key/${f.request.idempotencyKey}` }]) {
      const r = await app.inject(opts); expect(r.statusCode).toBe(401); expect(r.headers['cache-control']).toBe('private, no-store');
    }
    expect((await post(f)).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/starter-expeditions', cookies: f.cookies, payload: { ...f.request, finality: {} } })).statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled(); expect(await trips(f)).toEqual([]);
  });
  it('missing provider refuses new departures while current and original recovery remain readable', async () => {
    const f = await fixture(); mock(f);
    expect((await post(f, f.request, missing)).statusCode).toBe(503);
    expect((await get(f, undefined, missing)).json()).toMatchObject({ acceptingDepartures: false, flight: null });
    expect((await post(f)).statusCode).toBe(201);
    expect((await post(f, f.request, missing)).statusCode).toBe(200);
    expect((await receipt(f, undefined, missing)).json().status).toBe('accepted');
  });
  it('publishes eleven routes and positive facilities without creating home or flight', async () => {
    const f = await fixture(), rpc = mock(f); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    const r = await get(f); expect(r.statusCode).toBe(200);
    const view = StarterExpeditionViewSchema.parse(r.json()); expect(view.home?.source).toBe('free_policy_preview');
    expect(view.routes).toHaveLength(11); expect(view.installation?.installationId).toBe(f.installationId); expect(view.lodgeCompletedAt).not.toBeNull();
    expect(await homes(f)).toEqual([]); expect(await trips(f)).toEqual([]); expect(rpc).not.toHaveBeenCalled();
    // A build cannot be cancelled under SQL policy. A cancelled upgrade's
    // completed timestamp is not evidence that the original Lodge was built.
    await expect(db.update(builderJobs).set({ cancelledAt: new Date() }).where(eq(builderJobs.id, f.lodgeJobId))).rejects.toThrow();
    const receipts = await db.insert(ledgerTransactions).values(['debit', 'refund'].map(kind => ({
      type: `test.cancelled-lodge.${kind}`, idempotencyKey: randomUUID(), metadata: { synthetic: true },
    }))).returning();
    await db.update(builderJobs).set({ kind: 'upgrade', paidShardCost: 1n,
      debitLedgerTxnId: receipts[0]!.id, refundLedgerTxnId: receipts[1]!.id,
      cancelledAt: new Date(), cancelIdempotencyKey: randomUUID() }).where(eq(builderJobs.id, f.lodgeJobId));
    expect((await get(f)).json().lodgeCompletedAt).toBeNull();
  });
  it('persists one departure for concurrent identical commands and recovers a lost response', async () => {
    const f = await fixture(); mock(f);
    const all = await Promise.all(Array.from({ length: 3 }, () => post(f)));
    const original = matchStarterExpeditionEnvelope(all[0]!.json(), f.wallet, f.request);
    for (const r of all) { expect([200, 201]).toContain(r.statusCode); expect(r.json().receipt).toEqual(original.receipt); }
    expect(await trips(f)).toHaveLength(1); expect((await receipt(f)).json().receipt).toEqual(original.receipt);
    expect((await post(f, { ...f.request, routeVersion: 999 })).statusCode).toBe(409);
    expect((await post(f, { ...f.request, idempotencyKey: randomUUID() })).statusCode).toBe(409);
    expect((await get(f)).json().flight.expeditionId).toBe(f.request.idempotencyKey);
  });
  it('foreign keys are unknown before any private historical proof read', async () => {
    const f = await fixture(), other = await fixture(); mock(f); expect((await post(f)).statusCode).toBe(201);
    const privateRead = vi.spyOn(termStore, 'readStoredExpeditionTerm').mockRejectedValue(new Error('must not read foreign evidence'));
    const r = await receipt(other, f.request.idempotencyKey); expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ status: 'unknown', receipt: null, return: null });
    expect((await post(other, { ...other.request, idempotencyKey: f.request.idempotencyKey })).statusCode).toBe(409);
    expect(privateRead).not.toHaveBeenCalled(); expect(r.body).not.toContain(f.wallet);
  });
  it.each(['GET', 'POST'] as const)('rechecks %s authority after preflight transfer', async method => {
    const f = await fixture(), buyer = await fixture(), pause = barrier(), real = ownership.requireFreshBaseAuthority; mock(f);
    vi.spyOn(ownership, 'requireFreshBaseAuthority').mockImplementation(async (...args) => { const result = await real(...args); pause.arrive(); await pause.gate; return result; });
    const pending = method === 'GET' ? get(f) : post(f);
    try { await pause.seen; await transfer(f, buyer); } finally { pause.release(); }
    const r = await pending; expect(r.statusCode).toBe(404); expect(r.body).not.toContain(buyer.wallet); expect(await trips(f)).toEqual([]);
  });
  it('rechecks live pause under locks and rolls back home creation', async () => {
    const f = await fixture(); mock(f); const real = ownership.assertFreshLockedBaseAuthority;
    vi.spyOn(ownership, 'assertFreshLockedBaseAuthority').mockImplementation(async (...args) => { const result = await real(...args); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false'); return result; });
    expect((await post(f)).statusCode).toBe(503); expect(await trips(f)).toEqual([]); expect(await homes(f)).toEqual([]);
  });
  it('replays a concurrently accepted original before newly paused or transferred admission', async () => {
    const f = await fixture(), buyer = await fixture(), pause = barrier(), real = db.transaction.bind(db); mock(f); let once = false;
    vi.spyOn(db, 'transaction').mockImplementation(async (...args) => { if (!once) { once = true; pause.arrive(); await pause.gate; } return real(...args); });
    const pending = post(f);
    try { await pause.seen; await real(tx => dispatch.dispatchStarterExpedition(tx, f.wallet, f.command, f.authority, { reader: f.reader }));
      await transfer(f, buyer); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false'); } finally { pause.release(); }
    // The original committed elsewhere during this request: recovery is not a fresh departure.
    const r = await pending; expect(r.statusCode).toBe(200); expect(r.json().receipt.wallet).toBe(f.wallet); expect(await trips(f)).toHaveLength(1);
    expect((await get(f)).statusCode).toBe(404); expect((await receipt(f)).body).not.toContain(buyer.wallet);
  });
  it('rolls back a cross-actor key collision including the losing free home and flight', async () => {
    const a = await fixture(), b = await fixture(), pause = barrier(); let reached = 0, prefetched = 0;
    vi.spyOn(prefetch, 'prefetchExpeditionTermReader').mockImplementation(async () => {
      const source = ++prefetched === 1 ? a : b;
      return { async readOperatingTerm(at: string) {
        if (++reached === 2) pause.release(); await pause.gate; return source.reader.readOperatingTerm(at);
      } };
    });
    const responses = await Promise.all([post(a), post(b, { ...b.request, idempotencyKey: a.request.idempotencyKey })]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]);
    const loser = responses[0]!.statusCode === 409 ? a : b;
    expect(await trips(loser)).toEqual([]); expect(await homes(loser)).toEqual([]);
    // Each actor receives its own synthetic source, so the loser cannot leave a pinned term.
    const winner = loser === a ? b : a;
    const [won] = await trips(winner);
    const losingTerm = won!.termId === a.snapshot.termId ? b.snapshot.termId : a.snapshot.termId;
    expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, losingTerm))).toEqual([]);
    expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, loser.installationId))).toEqual([]);
  });
  it('actual Berth and Lodge construction completes before explicit HTTP installation and departure', async () => {
    const source = await fixture(); mock(source);
    const { wallet } = await createTestPlayer(db), claim = claimRect(0), level = Math.max(BUILD_COSTS.berth.requiresKeepLevel, BUILD_COSTS.lodge.requiresKeepLevel);
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: level, builders: CAPS.buildersMax }).returning();
    const baseId = base!.id;
    await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
    await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Keep, level, tx: claim.min, ty: claim.min });
    const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    const authority = { baseId, assertAuthority: async (tx: Parameters<typeof ownership.assertFreshLockedBaseAuthority>[0], actor: string, id: string) => { await ownership.assertFreshLockedBaseAuthority(tx, actor, id); } };
    await rewardBaseShards(db, baseId, BigInt(BUILD_COSTS.berth.costShards + BUILD_COSTS.lodge.costShards), 'test.expedition.facilities', randomUUID());
    const placed = [];
    for (const [type, offset] of [[BuildingType.Berth, 4], [BuildingType.Lodge, 8]] as const) {
      placed.push(await placeBuilding(db, wallet, type, claim.min + offset, claim.min, randomUUID(),
        new Date(Date.now() - (BUILD_COSTS[type].buildSec + 1) * 1_000), baseId, authority));
    }
    const request = { idempotencyKey: randomUUID(), baseId, berthId: placed[0]!.id };
    expect((await app.inject({ method: 'POST', url: '/starter-fleet/installations', cookies, payload: request })).statusCode).toBe(409);
    const current = await app.inject({ url: `/starter-expeditions?baseId=${baseId}`, cookies }); expect(current.statusCode).toBe(200);
    expect(current.json().installation).toBeNull(); expect(current.json().lodgeCompletedAt).not.toBeNull();
    const installation = await app.inject({ method: 'POST', url: '/starter-fleet/installations', cookies, payload: request });
    expect(installation.statusCode).toBe(201);
    const departure = await app.inject({ method: 'POST', url: '/starter-expeditions', cookies,
      payload: { ...source.request, idempotencyKey: randomUUID(), baseId, installationId: installation.json().receipt.installation.installationId } });
    expect(departure.statusCode).toBe(201); expect(departure.json().receipt.request.baseId).toBe(baseId);
  });
  it('a failed one-use observation rolls back admission and a retry obtains a fresh prefetch', async () => {
    const f = await fixture(), pause = barrier(); let consumed = 0;
    const rpc = vi.spyOn(prefetch, 'prefetchExpeditionTermReader').mockImplementationOnce(async () => ({ async readOperatingTerm() {
      consumed++; throw new Error('Prefetched expedition term observation is stale');
    } }));
    const lock = db.transaction(async tx => { await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update'); pause.arrive(); await pause.gate; });
    await pause.seen;
    const pending = post(f);
    try { await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1)); expect(consumed).toBe(0); } finally { pause.release(); }
    await lock; expect((await pending).statusCode).toBe(500); expect(consumed).toBe(1); expect(await trips(f)).toEqual([]); expect(await homes(f)).toEqual([]);
    expect((await receipt(f)).json().status).toBe('unknown');
    rpc.mockImplementation(async () => f.reader); expect((await post(f)).statusCode).toBe(201); expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('automatically returns through buyer GET while paused without changing the original departure', async () => {
    const f = await fixture(new Date(Date.now() - 3_600_000)), buyer = await fixture(); mock(f);
    // Since 86856e28a (2026-10-01) the route departs through dispatchStarterExpeditionCommitted;
    // pinning the clock on the legacy transaction entry no longer reaches it, so the trip
    // departed at wall-clock now and was not yet due when the buyer read.
    const real = dispatch.dispatchStarterExpeditionCommitted;
    vi.spyOn(dispatch, 'dispatchStarterExpeditionCommitted').mockImplementation((database, wallet, command, authority, deps) => real(database, wallet, command, authority, { ...deps, clock: () => f.now }));
    const accepted = await post(f); expect(accepted.statusCode).toBe(201); const original = accepted.json().receipt;
    expect(accepted.json().return).toBeNull(); await transfer(f, buyer); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    const view = await get(buyer, `/starter-expeditions?baseId=${f.baseId}`); expect(view.statusCode).toBe(200); expect(view.json().flight).toBeNull();
    expect(view.json().rawStock.find((s: { resourceId: string }) => s.resourceId === original.route.resourceId).available).toBe(original.route.netQuantity);
    const recovered = await receipt(f); expect(recovered.json().receipt).toEqual(original); expect(recovered.json().return).not.toBeNull(); expect(recovered.body).not.toContain(buyer.wallet);
    const proof = await readStarterExpeditionReturn(db, f.command.id); expect(proof!.entries.reduce((sum, e) => sum + e.delta, 0n)).toBe(0n);
    expect(proof!.receipt.custodyWallet).toBe(buyer.wallet); expect((await receipt(buyer, f.command.id)).json().status).toBe('unknown');
  });
});
