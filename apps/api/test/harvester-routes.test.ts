/** Real HTTP/SQL boundaries with explicitly synthetic term evidence. These
 * cases never establish genuine Seeker timing, signing or provider readiness. */
import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, CAPS, PHASE_E_HARVESTER as P, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { HarvesterSourceEnvelopeSchema, HarvesterViewSchema, matchHarvesterSourceEnvelope } from '@shardkeep/shared/harvesterApi';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { harvestersEnabled, loadConfig } from '../src/config';
import { bases, baseSlots, buildings, deedOwnershipObservations, expeditionFreeHomes, expeditionTermSnapshots, harvesterSourceCommands,
  harvesterSources, harvesterSourceHeads, players, resourceStocks, sessions } from '../src/db/schema';
import { placeBuilding } from '../src/game/base';
import { rewardBaseShards } from '../src/game/baseEconomy';
import * as ownership from '../src/game/baseOwnership';
import * as prefetch from '../src/game/expeditionTermReader';
import { claimRect } from '../src/game/footprints';
import { harvesterSourceEnvelope } from '../src/game/harvesterCommands';
import * as settlement from '../src/game/harvesterSettlement';
import * as sources from '../src/game/harvesterSources';
import { consumeRawStockReservation, reserveRawStock } from '../src/game/resourceStock';
import * as stable from '../src/game/stableBasePrerequisites';
import type { StarterExpeditionProvider } from '../src/game/starterExpeditionRoutes';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createHarvesterFixture } from './fixtures/harvesters';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), db = conn.db, V1 = P.v1;
let app: FastifyInstance, missing: FastifyInstance;
const key = new PublicKey('11111111111111111111111111111111');
const provider: StarterExpeditionProvider = { policy: { genesisHash: key, programId: key, config: key, round: 1n,
  mint: key, prizeOwner: key, prizeAta: key, stateProvenance: 'fresh-reviewed-deployment',
  deployment: { programDataAddress: key.toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } },
  connect: () => { throw new Error('Synthetic HTTP test must not contact RPC'); } };
beforeAll(async () => {
  const old = process.env['MULTI_BASE_ENABLED'], free = process.env['FREE_ONBOARDING'];
  process.env['MULTI_BASE_ENABLED'] = 'false'; process.env['FREE_ONBOARDING'] = 'true';
  try { await bootstrapSystemAccounts(db); app = await buildApp(TEST_CONFIG, db, { harvesterProvider: provider });
    missing = await buildApp(TEST_CONFIG, db); await app.ready(); await missing.ready(); }
  finally {
    if (old === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = old;
    if (free === undefined) delete process.env['FREE_ONBOARDING']; else process.env['FREE_ONBOARDING'] = free;
  }
});
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('HARVESTERS_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await app.close(); await missing.close(); await conn.sql.end(); });
async function fixture(options: { wallet?: string; now?: Date } = {}) {
  const f = await createHarvesterFixture(db, options);
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
  return { ...f, cookies: { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, body = f.request, server = app) => server.inject({ method: 'POST', url: '/harvesters/sources', cookies: f.cookies, payload: body });
const get = (f: Fixture, url = `/harvesters?baseId=${f.baseId}`, server = app) => server.inject({ url, cookies: f.cookies });
const receipt = (f: Fixture, id = f.request.idempotencyKey, server = app) => get(f, `/harvesters/sources/by-key/${id}`, server);
const originals = (f: Fixture) => db.select().from(harvesterSources).where(eq(harvesterSources.baseId, f.baseId));
const commands = (f: Fixture) => db.select().from(harvesterSourceCommands).where(eq(harvesterSourceCommands.baseId, f.baseId));
const homes = (f: Fixture) => db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId));
const head = async (f: Fixture) => (await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet, f.wallet)))[0];
const mock = (f: Fixture) => vi.spyOn(prefetch, 'prefetchExpeditionTermReader').mockImplementation(async () => {
  const observedAt = new Date().toISOString(); let used = false;
  return { async readOperatingTerm() { if (used) throw new Error('one use'); used = true; return f.reader.readOperatingTerm(observedAt); } };
});
const newRequest = (f: Fixture, expectedSourceId: string | null) => ({ ...f.request, idempotencyKey: randomUUID(), expectedSourceId });
function barrier() { let arrive!: () => void, release!: () => void;
  return { seen: new Promise<void>(r => { arrive = r; }), gate: new Promise<void>(r => { release = r; }), arrive: () => arrive(), release: () => release() }; }
const later = (source: { admittedAt: string }, ordinal: number) => new Date(Date.parse(source.admittedAt) + ordinal * V1.cadenceSec * 1_000);
const freeze = (at: Date) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); };

describe('authenticated explicit Harvester source consent', () => {
  it('rejects misspelled or parentless boot configuration and keeps the new source default dark', () => {
    const env = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: TEST_CONFIG.JWT_SECRET,
      WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
    expect(loadConfig(env).HARVESTERS_ENABLED).toBe('false');
    for (const parent of [{}, { MULTI_BASE_ENABLED: 'true' }, { PHASE_E_BUILDINGS_ENABLED: 'true' }])
      expect(() => loadConfig({ ...env, ...parent, HARVESTERS_ENABLED: 'true' })).toThrow(/HARVESTERS_ENABLED/);
    for (const value of ['TRUE', '1', 'yes']) expect(() => loadConfig({ ...env, HARVESTERS_ENABLED: value })).toThrow(/HARVESTERS_ENABLED/);
    expect(harvestersEnabled({ HARVESTERS_ENABLED: 'true', MULTI_BASE_ENABLED: 'true', PHASE_E_BUILDINGS_ENABLED: 'true' })).toBe(true);
  });

  it('authenticates every route, rejects extra/coerced scalars and defaults all new selection gates off', async () => {
    const f = await fixture(), rpc = mock(f);
    expect(harvestersEnabled({})).toBe(false);
    for (const options of [{ url: `/harvesters?baseId=${f.baseId}` }, { url: `/harvesters/sources/by-key/${f.request.idempotencyKey}` },
      { method: 'POST' as const, url: '/harvesters/sources', payload: f.request }]) {
      const r = await app.inject(options); expect(r.statusCode).toBe(401); expect(r.headers['cache-control']).toBe('private, no-store');
    }
    for (const body of [{ ...f.request, term: {} }, { ...f.request, policyVersion: '1' }, { ...f.request, expectedSourceId: false },
      { ...f.request, idempotencyKey: f.request.idempotencyKey.toUpperCase() }]) {
      expect((await app.inject({ method: 'POST', url: '/harvesters/sources', cookies: f.cookies, payload: body })).statusCode).toBe(400);
    }
    for (const flag of ['HARVESTERS_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'MULTI_BASE_ENABLED']) {
      vi.stubEnv(flag, 'false'); expect((await post(f)).statusCode).toBe(503); vi.stubEnv(flag, 'true');
    }
    expect(rpc).not.toHaveBeenCalled(); expect(await originals(f)).toEqual([]); expect(await homes(f)).toEqual([]);
  });

  it('current discovery needs no provider, never writes a home/source, and requires positive completed facilities', async () => {
    const f = await fixture(), rpc = mock(f);
    const view = HarvesterViewSchema.parse((await get(f, undefined, missing)).json());
    expect(view).toMatchObject({ acceptingSelections: false, home: { source: 'free_policy_preview' }, source: null, walletSource: null });
    expect(view.facilities).toEqual([{ baseId: f.baseId, harvesterId: f.harvesterId, completedBuildJobId: f.jobId,
      harvesterCompletedAt: new Date(f.now.getTime() - 1_000).toISOString() }]);
    expect((await post(f, f.request, missing)).statusCode).toBe(503);
    await db.update(buildings).set({ level: 0 }).where(eq(buildings.id, f.harvesterId));
    expect((await get(f)).json().facilities).toEqual([]); expect((await post(f)).statusCode).toBe(409);
    expect(await homes(f)).toEqual([]); expect(await commands(f)).toEqual([]); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('persists one atomic source identity for concurrent exact confirmations and recovers its frozen proof', async () => {
    const f = await fixture(); mock(f);
    const responses = await Promise.all([post(f), post(f), post(f)]);
    const original = matchHarvesterSourceEnvelope(responses[0]!.json(), f.wallet, f.request);
    expect(original.status).toBe('accepted');
    for (const r of responses) { expect([200, 201]).toContain(r.statusCode); expect(r.json().originalReceipt).toEqual(original.originalReceipt); }
    expect(await originals(f)).toHaveLength(1); expect((await originals(f))[0]!.publicAdmission).toBe(true);
    expect(await commands(f)).toHaveLength(1); expect(original.settlement).toEqual({ events: [], closure: null, custodyStop: null });
    expect((await receipt(f)).json().originalReceipt).toEqual(original.originalReceipt);
  });

  it('original replay survives pauses, lost custody and missing provider while altered consent stays a conflict', async () => {
    const f = await fixture(), buyer = await createTestPlayer(db), rpc = mock(f);
    const accepted = await post(f); expect(accepted.statusCode).toBe(201); const original = accepted.json().originalReceipt;
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    await db.update(buildings).set({ level: 0 }).where(eq(buildings.id, f.harvesterId));
    vi.stubEnv('HARVESTERS_ENABLED', 'false'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false'); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    rpc.mockRejectedValue(new Error('provider outage'));
    expect((await post(f, f.request, missing)).json().originalReceipt).toEqual(original);
    expect((await receipt(f, undefined, missing)).json().originalReceipt).toEqual(original);
    for (const body of [{ ...f.request, expectedSourceId: randomUUID() }, { ...f.request, policyVersion: f.request.policyVersion + 1 },
      { ...f.request, baseId: randomUUID() }, { ...f.request, harvesterId: randomUUID() }]) {
      const r = await post(f, body, missing); expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    }
    expect(rpc).toHaveBeenCalledTimes(1); expect((await receipt(f)).body).not.toContain(buyer.wallet);
  });

  it('filters foreign actors before private source or settlement decoding and hides internal-only keys', async () => {
    const f = await fixture(), other = await fixture(); mock(f); await post(f);
    const sourceRead = vi.spyOn(sources, 'readHarvesterSource').mockRejectedValue(new Error('private proof must remain unread'));
    const settlementRead = vi.spyOn(settlement, 'readHarvesterSettlement').mockRejectedValue(new Error('private settlement must remain unread'));
    const foreign = HarvesterSourceEnvelopeSchema.parse((await receipt(other, f.request.idempotencyKey)).json());
    const unknown = HarvesterSourceEnvelopeSchema.parse((await receipt(other, randomUUID())).json());
    expect(foreign).toMatchObject({ wallet: other.wallet, status: 'unknown', originalReceipt: null, settlement: null });
    expect(unknown).toMatchObject({ wallet: other.wallet, status: 'unknown', originalReceipt: null, settlement: null });
    expect((await post(other, f.request)).statusCode).toBe(409);
    expect(sourceRead).not.toHaveBeenCalled(); expect(settlementRead).not.toHaveBeenCalled();
    sourceRead.mockRestore(); settlementRead.mockRestore();
    const internal = await fixture();
    await sources.selectHarvesterSource(db, internal.wallet, { id: internal.request.idempotencyKey, baseId: internal.baseId,
      harvesterId: internal.harvesterId, policyVersion: internal.request.policyVersion }, internal.authority, { reader: internal.reader });
    expect((await receipt(internal)).json().status).toBe('unknown');
    expect((await post(internal, internal.request, missing)).statusCode).toBe(409); expect(await commands(internal)).toEqual([]);
  });

  it('requires the exact retained head and serializes two competing replacement reviews', async () => {
    const f = await fixture(); mock(f); const first = await post(f); expect(first.statusCode).toBe(201);
    const stale = await post(f, newRequest(f, null)); expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('HARVESTER_SOURCE_CHANGED');
    const [a, b] = await Promise.all([post(f, newRequest(f, f.request.idempotencyKey)), post(f, newRequest(f, f.request.idempotencyKey))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]); expect(await commands(f)).toHaveLength(2);
    const original = (await receipt(f)).json(); expect(original.originalReceipt).toEqual(first.json().originalReceipt);
    expect(original.settlement.closure.reason).toBe('replacement'); expect((await head(f))!.sourceId).not.toBe(f.request.idempotencyKey);
  });

  it('keeps an expired head visible until explicit reviewed renewal and preserves original history', async () => {
    const f = await fixture(); mock(f); const first = (await post(f)).json();
    freeze(new Date(Date.parse(first.originalReceipt.source.leaseExpiresAt) + 1));
    const view = HarvesterViewSchema.parse((await get(f)).json()); expect(view.walletSource?.sourceId).toBe(f.request.idempotencyKey);
    expect((await post(f, newRequest(f, null))).json().error.code).toBe('HARVESTER_SOURCE_CHANGED');
    const renewed = await post(f, newRequest(f, f.request.idempotencyKey)); expect(renewed.statusCode).toBe(201);
    const original = (await receipt(f)).json(); expect(original.originalReceipt).toEqual(first.originalReceipt);
    expect(original.settlement.closure.reason).toBe('lease_expired');
    expect(original.settlement.events).toHaveLength(Math.floor(V1.maxLeaseSec / V1.cadenceSec));
    expect(renewed.json().settlement.events).toEqual([]);
  });

  it('can review another owned base without settling it, then replaces under the same wallet head', async () => {
    const f = await fixture(); mock(f); const original = (await post(f)).json().originalReceipt;
    await db.update(baseSlots).set({ slot: 2 }).where(eq(baseSlots.baseId, f.baseId));
    const other = await fixture({ wallet: f.wallet }); mock(other);
    freeze(later(original.source, 1));
    const view = HarvesterViewSchema.parse((await get(other)).json()); expect(view.source).toBeNull();
    expect(view.walletSource?.sourceId).toBe(f.request.idempotencyKey);
    expect((await settlement.readHarvesterSettlement(db, f.request.idempotencyKey))!.events).toEqual([]);
    const switched = await post(other, newRequest(other, f.request.idempotencyKey)); expect(switched.statusCode).toBe(201);
    expect((await receipt(f)).json().settlement.events).toHaveLength(1);
    expect((await head(other))!.baseId).toBe(other.baseId);
  });

  it('checks a live pause after canonical locks and rolls back its unaccepted command', async () => {
    const f = await fixture(); mock(f); const original = stable.lockStablePrerequisiteBase;
    vi.spyOn(stable, 'lockStablePrerequisiteBase').mockImplementation(async (...args) => {
      const base = await original(...args); vi.stubEnv('HARVESTERS_ENABLED', 'false'); return base;
    });
    expect((await post(f)).statusCode).toBe(503); expect(await commands(f)).toEqual([]); expect(await originals(f)).toEqual([]); expect(await homes(f)).toEqual([]);
  });

  it.each(['stale', 'paused'] as const)('refuses %s admission after waiting for the shared term advisory lock', async mode => {
    const f = await fixture(); mock(f); const pause = barrier(); let holderPid = 0;
    const scope = JSON.stringify([f.snapshot.source.genesisHash, f.snapshot.source.programId, f.snapshot.source.auctionConfig]);
    const holding = db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expedition-term:${scope}`},0))`);
      holderPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>)[0]!.pid);
      pause.arrive(); await pause.gate;
    });
    await pause.seen; const pending = post(f);
    try {
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting).toBe(true);
      if (mode === 'stale') freeze(new Date(Date.now() + PHASE_E_SEEKER_AUCTION.observationMaxAgeMs + 1));
      else vi.stubEnv('HARVESTERS_ENABLED', 'false');
    } finally { pause.release(); await holding; }
    const r = await pending; expect(r.statusCode).toBe(mode === 'paused' ? 503 : 500);
    expect(await commands(f)).toEqual([]); expect(await originals(f)).toEqual([]); expect(await homes(f)).toEqual([]);
    expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, f.snapshot.termId))).toEqual([]);
  });

  it('recovers the original after an actor-lock wait even when admission pauses before release', async () => {
    const f = await fixture(), rpc = mock(f), pause = barrier(), commit = barrier();
    const holding = db.transaction(async tx => {
      await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update'); pause.arrive(); await pause.gate;
      await sources.selectHarvesterSource(tx, f.wallet, { id: f.request.idempotencyKey, baseId: f.baseId,
        harvesterId: f.harvesterId, policyVersion: f.request.policyVersion }, f.authority,
      { reader: f.reader, publicCommand: { expectedSourceId: null } });
      vi.stubEnv('HARVESTERS_ENABLED', 'false'); commit.arrive();
    });
    await pause.seen; const pending = post(f);
    try { await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1)); }
    finally { pause.release(); }
    await commit.seen; await holding; expect((await pending).statusCode).toBe(201);
    expect(await commands(f)).toHaveLength(1); expect((await receipt(f)).json().status).toBe('accepted');
  });

  it('reports current stock after actual reservation/consumption while keeping cumulative earning only in history', async () => {
    const f = await fixture(); mock(f); const original = (await post(f)).json().originalReceipt;
    freeze(later(original.source, 5)); vi.stubEnv('HARVESTERS_ENABLED', 'false');
    const earned = HarvesterViewSchema.parse((await get(f)).json()), resourceId = original.source.resourceId as 'crown_iron_ore';
    const totalNet = (await receipt(f)).json().settlement.events.reduce((sum: bigint, e: { netQuantity: string }) => sum + BigInt(e.netQuantity), 0n);
    expect(earned.rawStock.find(row => row.resourceId === resourceId)!.total).toBe(totalNet.toString());
    const reservation = randomUUID();
    await reserveRawStock(db, f.wallet, { operationId: reservation, baseId: f.baseId, resourceId, quantity: 1n }, f.authority);
    await consumeRawStockReservation(db, randomUUID(), reservation);
    await reserveRawStock(db, f.wallet, { operationId: randomUUID(), baseId: f.baseId, resourceId, quantity: 1n }, f.authority);
    const current = HarvesterViewSchema.parse((await get(f)).json());
    expect(current.rawStock.find(row => row.resourceId === resourceId)).toMatchObject({ available: (totalNet - 2n).toString(), reserved: '1', total: (totalNet - 1n).toString() });
    expect(current.acceptingSelections).toBe(false); expect((await receipt(f)).json().originalReceipt).toEqual(original);
    const base = await get(f, `/base?baseId=${f.baseId}`);
    expect(base.statusCode, base.body).toBe(200); expect(base.json().rawStock).toEqual(current.rawStock);
  });

  it('retains overflow obligations and supports original recovery before failed GET/new-selection settlement', async () => {
    const f = await fixture(); mock(f); const first = (await post(f)).json(); freeze(later(first.originalReceipt.source, 1));
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: first.originalReceipt.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    for (const response of [await get(f), await post(f, newRequest(f, f.request.idempotencyKey))]) {
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('HARVESTER_SETTLEMENT_PENDING');
    }
    expect((await receipt(f)).json().settlement.events).toEqual([]); expect((await post(f)).json().originalReceipt).toEqual(first.originalReceipt);
    expect(await commands(f)).toHaveLength(1); expect((await head(f))!.sourceId).toBe(f.request.idempotencyKey);
    await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.baseId));
    expect((await get(f)).statusCode).toBe(200); expect((await receipt(f)).json().settlement.events).toHaveLength(1);
  });

  it('recovers one read-only snapshot when closure commits between source and settlement reads', async () => {
    const f = await fixture(); mock(f); const accepted = (await post(f)).json(); freeze(later(accepted.originalReceipt.source, 2));
    const pause = barrier(), real = settlement.readHarvesterSettlement;
    vi.spyOn(settlement, 'readHarvesterSettlement').mockImplementationOnce(async (...args) => { pause.arrive(); await pause.gate; return real(...args); });
    const pending = harvesterSourceEnvelope(db, f.wallet, f.request.idempotencyKey);
    try { await pause.seen; await db.transaction(tx => settlement.closeHarvesterSources(tx, f.baseId, new Date(), 'replacement')); }
    finally { pause.release(); }
    const before = await pending; expect(before.settlement).toEqual({ events: [], closure: null, custodyStop: null });
    const after = await harvesterSourceEnvelope(db, f.wallet, f.request.idempotencyKey);
    expect(after.originalReceipt).toEqual(accepted.originalReceipt); expect(after.settlement?.events).toHaveLength(2);
    expect(after.settlement?.closure?.processedOrdinal).toBe(2);
  });

  it('keeps the first durable custody stop through overflow and later transfer without exposing buyer proof', async () => {
    const f = await fixture(); mock(f); const accepted = (await post(f)).json();
    const buyer = await createTestPlayer(db), asset = (await createTestPlayer(db)).wallet;
    const cutoff = later(accepted.originalReceipt.source, 1.5), late = later(accepted.originalReceipt.source, 5);
    freeze(cutoff);
    await db.update(bases).set({ deedAssetId: asset, deedMintAssetId: asset }).where(eq(bases.id, f.baseId));
    const auditHash = ownership.observationHash(asset, buyer.wallet, 'mismatch', 300n, cutoff);
    const [observation] = await db.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: asset,
      owner: buyer.wallet, slot: 300n, status: 'mismatch', source: 'synthetic-harvester-http', checkedAt: cutoff, auditHash }).returning();
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: accepted.originalReceipt.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    await db.transaction(async tx => {
      await settlement.recordHarvesterCustodyStop(tx, f.baseId, cutoff);
      await expect(settlement.closeHarvesterSources(tx, f.baseId, cutoff, 'custody_change')).rejects.toBeInstanceOf(settlement.HarvesterStorageCapacityError);
    });
    const pending = await receipt(f), originalStop = pending.json().settlement.custodyStop;
    expect(originalStop).toEqual({ sourceId: f.request.idempotencyKey, cutoffAt: cutoff.toISOString(), checkedAt: cutoff.toISOString(), auditHash });
    expect(pending.json().settlement.events).toEqual([]); expect(pending.body).not.toContain(buyer.wallet); expect(pending.body).not.toContain(asset);
    freeze(late); vi.stubEnv('HARVESTERS_ENABLED', 'false');
    await db.update(deedOwnershipObservations).set({ owner: null, slot: null, status: 'unavailable', checkedAt: late,
      auditHash: ownership.observationHash(asset, null, 'unavailable', null, late) }).where(eq(deedOwnershipObservations.id, observation!.id));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    expect((await receipt(f)).json().settlement.custodyStop).toEqual(originalStop);
    await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.baseId));
    await db.transaction(tx => settlement.closeHarvesterSources(tx, f.baseId, late, 'replacement'));
    const delivered = await receipt(f), proof = HarvesterSourceEnvelopeSchema.parse(delivered.json());
    expect(proof.originalReceipt).toEqual(accepted.originalReceipt); expect(proof.settlement?.custodyStop).toEqual(originalStop);
    expect(proof.settlement?.events).toHaveLength(1); expect(proof.settlement?.events[0]?.settledAt).toBe(late.toISOString());
    expect(proof.settlement?.closure).toMatchObject({ cutoffAt: cutoff.toISOString(), reason: 'custody_change', processedOrdinal: 1 });
    expect(delivered.body).not.toContain(buyer.wallet); expect(delivered.body).not.toContain(asset);
    expect((await post(f, f.request, missing)).json().originalReceipt).toEqual(accepted.originalReceipt);
  });

  it('actual Harvester construction is completed by authorized GET before explicit source selection', async () => {
    const term = await fixture(); mock(term); const { wallet } = await createTestPlayer(db), claim = claimRect(0);
    const level = BUILD_COSTS.harvester.requiresKeepLevel;
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: level, builders: CAPS.buildersMax }).returning();
    const baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
    await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Keep, level, tx: claim.min, ty: claim.min });
    await rewardBaseShards(db, baseId, BigInt(BUILD_COSTS.harvester.costShards), 'test.harvester.facility', randomUUID());
    const authority = { baseId, assertAuthority: async (tx: Parameters<typeof ownership.assertFreshLockedBaseAuthority>[0], actor: string, id: string) => { await ownership.assertFreshLockedBaseAuthority(tx, actor, id); } };
    const placed = await placeBuilding(db, wallet, BuildingType.Harvester, claim.min + 4, claim.min, randomUUID(),
      new Date(Date.now() - (BUILD_COSTS.harvester.buildSec + 1) * 1_000), baseId, authority);
    const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    const request = { ...term.request, idempotencyKey: randomUUID(), baseId, harvesterId: placed.id };
    expect((await app.inject({ method: 'POST', url: '/harvesters/sources', cookies, payload: request })).statusCode).toBe(409);
    const current = await app.inject({ url: `/harvesters?baseId=${baseId}`, cookies }); expect(current.statusCode).toBe(200);
    expect(current.json().facilities.map((row: { harvesterId: string }) => row.harvesterId)).toEqual([placed.id]);
    expect((await app.inject({ method: 'POST', url: '/harvesters/sources', cookies, payload: request })).statusCode).toBe(201);
  });
});
