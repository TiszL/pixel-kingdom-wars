/** Real authenticated installation/recovery and SQL. Most berths are explicit
 * fixture proofs; the placement case separately uses the actual paid builder. */
import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType, CAPS } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { matchStarterFleetEnvelope, StarterFleetViewSchema, type StarterFleetRequest } from '@shardkeep/shared/starterFleetApi';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { loadConfig, starterExpeditionsEnabled } from '../src/config';
import { baseRaidLocks, bases, baseSlots, builderJobs, buildings, fleetInstallations, players, raids, sessions, starterFleetCommands } from '../src/db/schema';
import { placeBuilding } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import * as ownership from '../src/game/baseOwnership';
import { claimRect } from '../src/game/footprints';
import * as fleet from '../src/game/starterFleet';
import { installStarterFleetCommand, readStarterFleetCommand } from '../src/game/starterFleetCommands';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), db = conn.db; let app: FastifyInstance;
const reader = vi.fn(async () => { throw new Error('RPC unavailable'); });
beforeAll(async () => {
  const prior = process.env['MULTI_BASE_ENABLED']; process.env['MULTI_BASE_ENABLED'] = 'false';
  try { await bootstrapSystemAccounts(db); app = await buildApp(TEST_CONFIG, db,
    { market: { finalizedDeedReader: reader, deedCollection: '11111111111111111111111111111111' } }); await app.ready(); }
  finally { if (prior === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = prior; }
});
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'true'); reader.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await app.close(); await conn.sql.end(); });
const authority = (baseId: string) => ({ baseId, assertAuthority: async (tx: Parameters<typeof ownership.assertFreshLockedBaseAuthority>[0], wallet: string, id: string) => {
  await ownership.assertFreshLockedBaseAuthority(tx, wallet, id);
} });
async function fixture(withBerth = true) {
  const { wallet } = await createTestPlayer(db), claim = claimRect(0), level = BUILD_COSTS.berth.requiresKeepLevel;
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: level, builders: CAPS.buildersMax }).returning();
  const baseId = base!.id;
  await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Keep, level, tx: claim.min, ty: claim.min });
  let berthId: string = randomUUID();
  if (withBerth) {
    const [berth] = await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Berth, tx: claim.min + 4, ty: claim.min }).returning();
    berthId = berth!.id;
    const completedAt = new Date(Date.now() - 1_000);
    await db.insert(builderJobs).values({ playerWallet: wallet, baseId, buildingId: berthId, kind: 'build', completedAt,
      finishesAt: completedAt, startedAt: new Date(completedAt.getTime() - BUILD_COSTS.berth.buildSec * 1_000) });
  }
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  const request: StarterFleetRequest = { idempotencyKey: randomUUID(), baseId, berthId };
  return { wallet, baseId, request, cookies };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, body: object = f.request) => app.inject({ method: 'POST', url: '/starter-fleet/installations', cookies: f.cookies, payload: body });
const get = (f: Fixture, url = `/starter-fleet?baseId=${f.baseId}`) => app.inject({ url, cookies: f.cookies });
const receipt = (f: Fixture, key = f.request.idempotencyKey) => get(f, `/starter-fleet/installations/by-key/${key}`);
const installs = (f: Fixture) => db.select().from(fleetInstallations).where(eq(fleetInstallations.baseId, f.baseId));
const commands = (f: Fixture) => db.select().from(starterFleetCommands).where(eq(starterFleetCommands.baseId, f.baseId));
function barrier() { let arrive!: () => void, release!: () => void;
  const seen = new Promise<void>(r => { arrive = r; }), gate = new Promise<void>(r => { release = r; }); return { arrive, release, seen, gate }; }
async function transfer(f: Fixture, buyer: Fixture) {
  // Seed only the custody transition; all later locked authority/recovery reads
  // execute production SQL, without fabricating installation or command rows.
  await db.transaction(async tx => {
    await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
    await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
    await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId));
    await tx.insert(baseSlots).values({ wallet: buyer.wallet, baseId: f.baseId, slot: 2 });
  });
}

describe('default-off free starter HTTP consent', () => {
  it('defaults off, refuses missing parents and reads live gates', () => {
    const env = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
    expect(loadConfig(env).STARTER_EXPEDITIONS_ENABLED).toBe('false'); expect(starterExpeditionsEnabled({})).toBe(false);
    for (const flags of [{ STARTER_EXPEDITIONS_ENABLED: 'true' }, { STARTER_EXPEDITIONS_ENABLED: 'true', PHASE_E_BUILDINGS_ENABLED: 'true' }])
      expect(() => loadConfig({ ...env, ...flags })).toThrow(/STARTER_EXPEDITIONS_ENABLED/);
    expect(starterExpeditionsEnabled({ MULTI_BASE_ENABLED: 'true', PHASE_E_BUILDINGS_ENABLED: 'true', STARTER_EXPEDITIONS_ENABLED: 'true' })).toBe(true);
  });
  it('authenticates every route before flags and rejects authority fields', async () => {
    const f = await fixture(); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    for (const opts of [{ url: `/starter-fleet?baseId=${f.baseId}` }, { method: 'POST' as const, url: '/starter-fleet/installations', payload: f.request },
      { url: `/starter-fleet/installations/by-key/${f.request.idempotencyKey}` }]) {
      const r = await app.inject(opts); expect(r.statusCode).toBe(401); expect(r.headers['cache-control']).toBe('private, no-store');
    }
    expect((await post(f)).statusCode).toBe(503); expect(await installs(f)).toEqual([]);
    for (const extra of [{ wallet: f.wallet }, { family: 'starter' }, { completedAt: new Date().toISOString() }]) expect((await post(f, { ...f.request, ...extra })).statusCode).toBe(400);
    expect((await get(f)).json()).toMatchObject({ acceptingInstallations: false, installation: null }); expect(reader).not.toHaveBeenCalled();
  });
  it('persists one original receipt across concurrent same-body requests and lost acknowledgement', async () => {
    const f = await fixture(); const responses = await Promise.all(Array.from({ length: 4 }, () => post(f)));
    const first = matchStarterFleetEnvelope(responses[0]!.json(), f.wallet, f.request);
    expect(first.status).toBe('accepted');
    for (const r of responses) { expect([200, 201]).toContain(r.statusCode); expect(r.json().receipt).toEqual(first.receipt); }
    expect(await installs(f)).toHaveLength(1); expect(await commands(f)).toHaveLength(1);
    expect((await receipt(f)).json().receipt).toEqual(first.receipt);
    expect((await post(f, { ...f.request, berthId: randomUUID() })).statusCode).toBe(409);
    expect((await post(f, { ...f.request, baseId: randomUUID() })).statusCode).toBe(409);
  });
  it('foreign receipt keys stay unknown and cannot be reassigned to another actor', async () => {
    const f = await fixture(), other = await fixture(); await post(f);
    for (const key of [f.request.idempotencyKey, randomUUID()]) {
      const r = await receipt(other, key); expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ wallet: other.wallet, status: 'unknown', receipt: null });
      expect(r.body).not.toContain(f.wallet);
    }
    const r = await post(other, { ...other.request, idempotencyKey: f.request.idempotencyKey }); expect(r.statusCode).toBe(409);
    expect(r.body).not.toContain(f.wallet); expect(await installs(other)).toEqual([]);
  });
  it('keeps seller history after transfer/pause/RPC outage and lets buyer accept the same existing starter', async () => {
    const f = await fixture(), buyer = await fixture(), accepted = (await post(f)).json().receipt;
    await transfer(f, buyer); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    expect((await post(f)).json().receipt).toEqual(accepted); expect((await receipt(f)).json().receipt).toEqual(accepted);
    expect((await receipt(f)).body).not.toContain(buyer.wallet); expect((await get(f)).statusCode).toBe(404); expect(reader).not.toHaveBeenCalled();
    vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'true');
    const next = { ...f.request, idempotencyKey: randomUUID() }; const r = await post(buyer, next);
    expect(r.statusCode).toBe(201); expect(r.json().receipt.wallet).toBe(buyer.wallet);
    expect(r.json().receipt.installation).toEqual(accepted.installation); expect(await installs(f)).toHaveLength(1);
    expect((await installs(f))[0]!.installedWallet).toBe(f.wallet);
  });
  it('new deed-backed installation refuses unavailable finalized authority', async () => {
    const f = await fixture(), asset = (await createTestPlayer(db)).wallet;
    await db.update(bases).set({ deedAssetId: asset, deedMintAssetId: asset }).where(eq(bases.id, f.baseId));
    expect((await post(f)).statusCode).toBe(503); expect(reader).toHaveBeenCalled(); expect(await installs(f)).toEqual([]);
  });
  it.each(['GET', 'POST'] as const)('a transfer after %s preflight cannot read or install on the buyer base', async method => {
    const f = await fixture(), buyer = await fixture(), pause = barrier(), real = ownership.requireFreshBaseAuthority;
    vi.spyOn(ownership, 'requireFreshBaseAuthority').mockImplementation(async (...args) => {
      const result = await real(...args); pause.arrive(); await pause.gate; return result;
    });
    const pending = method === 'GET' ? get(f) : post(f);
    try { await pause.seen; await transfer(f, buyer); } finally { pause.release(); }
    const r = await pending; expect(r.statusCode).toBe(404); expect(r.body).not.toContain(buyer.wallet);
    expect(await installs(f)).toEqual([]); expect(await commands(f)).toEqual([]);
  });
  it('different concurrent berths cannot move or multiply a base starter', async () => {
    const f = await fixture(), completedAt = new Date(Date.now() - 1_000);
    const [second] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId, type: BuildingType.Berth, tx: 25, ty: 25 }).returning();
    await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId, buildingId: second!.id, kind: 'build',
      startedAt: new Date(completedAt.getTime() - BUILD_COSTS.berth.buildSec * 1_000), finishesAt: completedAt, completedAt });
    const results = await Promise.all([post(f), post(f, { ...f.request, berthId: second!.id, idempotencyKey: randomUUID() })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]); expect(await installs(f)).toHaveLength(1); expect(await commands(f)).toHaveLength(1);
    const view = StarterFleetViewSchema.parse((await get(f)).json()); expect(view.eligibleBerths.map(b => b.berthId)).toEqual([view.installation!.berthId]);
  });
  it('rechecks pause under the actual base/slot locks', async () => {
    const f = await fixture(), real = ownership.assertFreshLockedBaseAuthority;
    vi.spyOn(ownership, 'assertFreshLockedBaseAuthority').mockImplementation(async (...args) => {
      const result = await real(...args); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false'); return result;
    });
    expect((await post(f)).statusCode).toBe(503); expect(await installs(f)).toEqual([]); expect(await commands(f)).toEqual([]);
  });
  it('locked original replay precedes transfer and pause gates after an initial key miss', async () => {
    const f = await fixture(), buyer = await fixture(), pause = barrier(), transact = db.transaction.bind(db); let intercepted = false;
    vi.spyOn(db, 'transaction').mockImplementation(async (...args) => {
      if (!intercepted) { intercepted = true; pause.arrive(); await pause.gate; } return transact(...args);
    });
    const pending = post(f); let original;
    try {
      await pause.seen; original = await transact(tx => installStarterFleetCommand(tx, f.wallet, f.request, authority(f.baseId)));
      await transfer(f, buyer); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    } finally { pause.release(); }
    const r = await pending; expect(r.statusCode).toBe(201); expect(r.json().receipt).toEqual(original);
    expect(await installs(f)).toHaveLength(1); expect(await commands(f)).toHaveLength(1);
  });
  it('cross-actor same-key races roll back the losing vehicle as well as its receipt', async () => {
    const a = await fixture(), b = await fixture(), pause = barrier(), real = fleet.installStarterFleet; let reached = 0;
    vi.spyOn(fleet, 'installStarterFleet').mockImplementation(async (...args) => {
      const result = await real(...args); if (++reached === 2) pause.release(); await pause.gate; return result;
    });
    const responses = await Promise.all([post(a), post(b, { ...b.request, idempotencyKey: a.request.idempotencyKey })]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect((await installs(a)).length + (await installs(b)).length).toBe(1);
    expect((await commands(a)).length + (await commands(b)).length).toBe(1);
  });
  it('rolls back a registry write if the command fails, leaving its key recoverably unknown', async () => {
    const f = await fixture(), real = fleet.installStarterFleet;
    const fault = vi.spyOn(fleet, 'installStarterFleet').mockImplementation(async (...args) => { await real(...args); throw new Error('receipt tail fault'); });
    expect((await post(f)).statusCode).toBe(500); expect(await installs(f)).toEqual([]); expect(await commands(f)).toEqual([]);
    expect((await receipt(f)).json()).toMatchObject({ status: 'unknown', receipt: null }); fault.mockRestore(); expect((await post(f)).statusCode).toBe(201);
  });
});

describe('completed berth snapshot and original SQL links', () => {
  it('actual enabled placement completes through paused GET before explicit free installation', async () => {
    const f = await fixture(false), cost = BigInt(BUILD_COSTS.berth.costShards), claim = claimRect(0);
    await rewardBaseShards(db, f.baseId, cost, 'test.starter.place', randomUUID());
    const start = new Date(Date.now() - (BUILD_COSTS.berth.buildSec + 1) * 1_000);
    const building = await placeBuilding(db, f.wallet, BuildingType.Berth, claim.min + 4, claim.min, randomUUID(), start, f.baseId, authority(f.baseId));
    f.request.berthId = building.id; expect(await getBaseShardBalance(db, f.baseId)).toBe(0n);
    expect((await post(f)).statusCode).toBe(409); expect(await installs(f)).toEqual([]);
    vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    const view = StarterFleetViewSchema.parse((await get(f)).json()); expect(view.installation).toBeNull();
    expect(view.eligibleBerths.map(b => b.berthId)).toEqual([building.id]); expect(await installs(f)).toEqual([]);
    vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'true'); const r = await post(f); expect(r.statusCode).toBe(201);
    expect(r.json().receipt.installation.completedBuildJobId).toBe(view.eligibleBerths[0]!.completedBuildJobId);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(0n);
  });
  it('timestamps installation after berth completion even when its transaction queued before the GET cutoff', async () => {
    const f = await fixture(false), claim = claimRect(0);
    await rewardBaseShards(db, f.baseId, BigInt(BUILD_COSTS.berth.costShards), 'test.starter.queued-place', randomUUID());
    const start = new Date(Date.now() - (BUILD_COSTS.berth.buildSec + 1) * 1_000);
    const building = await placeBuilding(db, f.wallet, BuildingType.Berth, claim.min + 4, claim.min,
      randomUUID(), start, f.baseId, authority(f.baseId));
    f.request.berthId = building.id;
    const pause = barrier(), real = ownership.assertFreshLockedBaseAuthority;
    let holderPid: number | undefined, waitingStartedAt: Date | undefined;
    vi.spyOn(ownership, 'assertFreshLockedBaseAuthority').mockImplementation(async (...args) => {
      const result = await real(...args);
      if (holderPid === undefined) {
        const [row] = await args[0].execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>;
        holderPid = row!.pid; pause.arrive(); await pause.gate;
      }
      return result;
    });
    const pendingRead = get(f); let pendingInstall: ReturnType<typeof post> | undefined;
    try {
      await pause.seen; pendingInstall = post(f);
      await expect.poll(async () => {
        const [waiting] = await conn.sql<{ started_at: Date | string }[]>`
          SELECT xact_start AS started_at FROM pg_stat_activity
          WHERE ${holderPid!} = ANY(pg_blocking_pids(pid)) LIMIT 1`;
        waitingStartedAt = waiting ? new Date(typeof waiting.started_at === 'string' ? waiting.started_at : waiting.started_at.getTime()) : undefined;
        return waiting !== undefined;
      }, { timeout: 5_000 }).toBe(true);
      // Ensure the actual server cutoff is later than the waiting transaction;
      // no fabricated completion time or sleep-based lock assumption is used.
      await expect.poll(() => Date.now(), { timeout: 5_000 }).toBeGreaterThan(waitingStartedAt!.getTime());
      pause.release();
      const view = StarterFleetViewSchema.parse((await pendingRead).json()), response = await pendingInstall;
      expect(response.statusCode).toBe(201);
      const proof = matchStarterFleetEnvelope(response.json(), f.wallet, f.request);
      expect(proof.status).toBe('accepted'); if (proof.status !== 'accepted') throw new Error('Starter was not accepted');
      expect(Date.parse(proof.receipt.installation.berthCompletedAt)).toBeGreaterThan(waitingStartedAt!.getTime());
      expect(proof.receipt.installation.berthCompletedAt).toBe(view.eligibleBerths[0]!.berthCompletedAt);
      expect(Date.parse(proof.receipt.installation.installedAt)).toBeGreaterThanOrEqual(Date.parse(proof.receipt.installation.berthCompletedAt));
      expect(Date.parse(proof.receipt.acceptedAt)).toBeGreaterThanOrEqual(Date.parse(proof.receipt.installation.installedAt));
      expect(await installs(f)).toHaveLength(1); expect(await commands(f)).toHaveLength(1);
    } finally { pause.release(); await Promise.allSettled([pendingRead, ...(pendingInstall ? [pendingInstall] : [])]); }
  });
  it('never treats a levelled berth without positive completion as eligible', async () => {
    const f = await fixture(); await db.delete(builderJobs).where(eq(builderJobs.buildingId, f.request.berthId));
    expect((await get(f)).json().eligibleBerths).toEqual([]); expect((await post(f)).statusCode).toBe(409);
  });
  it('raid and pause preserve current reads but refuse new installs', async () => {
    const f = await fixture(), attacker = await fixture();
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet, attackerBaseId: attacker.baseId,
      defenderWallet: f.wallet, defenderBaseId: f.baseId, seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: SIM_VERSION,
      ordersDeadlineAt: new Date(Date.now() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: raid!.ordersDeadlineAt });
    expect((await post(f)).statusCode).toBe(423); vi.stubEnv('STARTER_EXPEDITIONS_ENABLED', 'false');
    const r = await get(f); expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ acceptingInstallations: false, installation: null });
    expect(r.json().eligibleBerths).toHaveLength(1); expect(await installs(f)).toEqual([]);
  });
  it('does not fabricate a command for an existing internal installation', async () => {
    const f = await fixture(); const prior = await fleet.installStarterFleet(db, f.wallet, f.request.berthId, authority(f.baseId));
    expect((await receipt(f)).json()).toMatchObject({ status: 'unknown', receipt: null });
    expect((await get(f)).json().installation.installationId).toBe(prior.installationId);
    expect((await post(f)).json().receipt.installation.installationId).toBe(prior.installationId); expect(await installs(f)).toHaveLength(1);
  });
  it('SQL forbids receipt edits/deletes/truncate and forged actor/link/times', async () => {
    const f = await fixture(), other = await fixture(); await post(f); const row = (await commands(f))[0]!;
    await expect(db.update(starterFleetCommands).set({ actorWallet: other.wallet }).where(eq(starterFleetCommands.id, row.id))).rejects.toThrow();
    await expect(db.delete(starterFleetCommands).where(eq(starterFleetCommands.id, row.id))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE starter_fleet_commands`)).rejects.toThrow();
    for (const change of [{ actorWallet: other.wallet }, { baseId: other.baseId }, { berthId: other.request.berthId },
      { completedBuildJobId: randomUUID() }, { installedAt: new Date(row.installedAt.getTime() + 1) }, { acceptedAt: new Date(0) }])
      await expect(db.insert(starterFleetCommands).values({ ...row, id: randomUUID(), ...change })).rejects.toThrow();
    expect(await commands(f)).toHaveLength(1); expect(await readStarterFleetCommand(db, f.wallet, row.id)).not.toBeNull();
  });
});
