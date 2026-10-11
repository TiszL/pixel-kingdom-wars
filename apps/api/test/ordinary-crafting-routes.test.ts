/** Real authenticated routes and SQL conversion with explicitly seeded raw and
 * completed Workshop fixtures. These cases do not prove earning or placement. */
import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType, PHASE_E_ORDINARY_CRAFTING as P, PHASE_E_ORDINARY_CRAFTING_V2 as P2 } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { matchOrdinaryCraftingEnvelope, OrdinaryCraftingEnvelopeSchema, OrdinaryCraftingViewSchema,
  type OrdinaryCraftingRequest } from '@shardkeep/shared/ordinaryCraftingApi';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { loadConfig, ordinaryCraftingEnabled } from '../src/config';
import { baseRaidLocks, bases, baseSlots, buildings, builderJobs, craftingStocks, ordinaryCraftingJobs,
  players, raids, resourceStocks, resourceStockOperations, sessions } from '../src/db/schema';
import * as ownership from '../src/game/baseOwnership';
import * as stable from '../src/game/stableBasePrerequisites';
import * as resource from '../src/game/resourceStock';
import { readOrdinaryCrafting, settleDueOrdinaryCrafting, startOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), db = conn.db;
let app: FastifyInstance;
const reader = vi.fn(async () => { throw new Error('RPC unavailable in this fixture'); });
beforeAll(async () => {
  const previous = process.env['MULTI_BASE_ENABLED'];
  const previousFree = process.env['FREE_ONBOARDING'];
  process.env['MULTI_BASE_ENABLED'] = 'false';
  // This suite deliberately exercises deedless free bases. /base chooses its
  // free-tier admission at registration, as in base-bootstrap-route.test.ts.
  process.env['FREE_ONBOARDING'] = 'true';
  try {
    await bootstrapSystemAccounts(db);
    app = await buildApp(TEST_CONFIG, db, { market: { finalizedDeedReader: reader, deedCollection: '11111111111111111111111111111111' } });
    await app.ready();
  } finally {
    if (previous === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = previous;
    if (previousFree === undefined) delete process.env['FREE_ONBOARDING']; else process.env['FREE_ONBOARDING'] = previousFree;
  }
});
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'true'); reader.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await app.close(); await conn.sql.end(); });
async function fixture(opts: { available?: bigint } = {}) {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  const baseId = base!.id;
  await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Keep, tx: 15, ty: 15 });
  const [workshop] = await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Workshop, tx: 20, ty: 20 }).returning();
  const completedAt = new Date(Date.now() - 1_000);
  await db.insert(builderJobs).values({ baseId, playerWallet: wallet, buildingId: workshop!.id, kind: 'build', completedAt,
    finishesAt: completedAt, startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Workshop].buildSec * 1_000) });
  await db.insert(resourceStocks).values({ baseId, resourceId: 'frost_quartz', available: opts.available ?? BigInt(P.v1.refining.rawPerOutput) });
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  const request: OrdinaryCraftingRequest = { idempotencyKey: randomUUID(), baseId, recipeId: 'refine_frostglass', recipeVersion: P.currentRecipeVersion, quantity: 1 };
  return { wallet, baseId, cookies, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, body: object = f.request) => app.inject({ method: 'POST', url: '/ordinary-crafting/jobs', cookies: f.cookies, payload: body });
const get = (f: Fixture, url = `/ordinary-crafting?baseId=${f.baseId}`) => app.inject({ method: 'GET', url, cookies: f.cookies });
const receipt = (f: Fixture, key = f.request.idempotencyKey) => get(f, `/ordinary-crafting/jobs/by-key/${key}`);
const raw = async (f: Fixture) => (await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId)))[0]!;
const outputs = (f: Fixture) => db.select().from(craftingStocks).where(eq(craftingStocks.baseId, f.baseId));
const jobs = (f: Fixture) => db.select().from(ordinaryCraftingJobs).where(eq(ordinaryCraftingJobs.baseId, f.baseId));
async function transferFixture(f: Fixture, buyer: string) {
  // Only the test custody transition is seeded. All subsequent route authority,
  // slot fences, settlement and immutable proof reads execute production SQL.
  await db.transaction(async tx => {
    await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
    await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
    await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await tx.update(bases).set({ ownerWallet: buyer }).where(eq(bases.id, f.baseId));
    await tx.insert(baseSlots).values({ wallet: buyer, baseId: f.baseId, slot: 1 });
  });
}
function barrier() {
  let arrive!: () => void, release!: () => void;
  const seen = new Promise<void>(r => { arrive = r; }), gate = new Promise<void>(r => { release = r; });
  return { arrive, release, seen, gate };
}

describe('ordinary crafting is dark, authenticated and original-key recoverable', () => {
  it('defaults off, rejects child-only config, and reads all live new-start prerequisites', () => {
    const env = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
    expect(loadConfig(env).ORDINARY_CRAFTING_ENABLED).toBe('false');
    expect(() => loadConfig({ ...env, ORDINARY_CRAFTING_ENABLED: 'true' })).toThrow(/ORDINARY_CRAFTING_ENABLED=true requires PHASE_E_BUILDINGS_ENABLED=true/);
    expect(loadConfig({ ...env, PHASE_E_BUILDINGS_ENABLED: 'true', ORDINARY_CRAFTING_ENABLED: 'true' }).ORDINARY_CRAFTING_ENABLED).toBe('true');
    for (const value of ['TRUE', '1', 'yes']) expect(() => loadConfig({ ...env, ORDINARY_CRAFTING_ENABLED: value })).toThrow(/ORDINARY_CRAFTING_ENABLED/);
    expect(ordinaryCraftingEnabled({})).toBe(false);
    for (const absent of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'ORDINARY_CRAFTING_ENABLED']) {
      const flags: NodeJS.ProcessEnv = { MULTI_BASE_ENABLED: 'true', PHASE_E_BUILDINGS_ENABLED: 'true', ORDINARY_CRAFTING_ENABLED: 'true' };
      flags[absent] = 'false'; expect(ordinaryCraftingEnabled(flags)).toBe(false);
    }
  });
  it('authenticates every route before flags or body validation and never caches its refusals', async () => {
    vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'false');
    for (const options of [{ method: 'GET' as const, url: '/ordinary-crafting' }, { method: 'POST' as const, url: '/ordinary-crafting/jobs', payload: {} },
      { method: 'GET' as const, url: `/ordinary-crafting/jobs/by-key/${randomUUID()}` }]) {
      const response = await app.inject(options);
      expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('private, no-store');
    }
  });
  it('requires explicit canonical base/key and strict bodies without any stock mutation', async () => {
    const f = await fixture();
    for (const body of [{ ...f.request, baseId: undefined }, { ...f.request, baseId: f.baseId.toUpperCase() }, { ...f.request, price: '0' },
      { ...f.request, quantity: 1.5 }, { ...f.request, idempotencyKey: 'retry-this' }]) expect((await post(f, body)).statusCode).toBe(400);
    expect((await get(f, '/ordinary-crafting')).statusCode).toBe(400);
    expect((await get(f, `/ordinary-crafting?baseId=${f.baseId}&owner=${f.wallet}`)).statusCode).toBe(400);
    expect(await jobs(f)).toEqual([]); expect((await raw(f)).available).toBe(BigInt(P.v1.refining.rawPerOutput));
  });
  it('foreign and missing base views have identical refusal and no buyer inventory', async () => {
    const f = await fixture(), other = await fixture();
    const foreign = await get(f, `/ordinary-crafting?baseId=${other.baseId}`), missing = await get(f, `/ordinary-crafting?baseId=${randomUUID()}`);
    expect(foreign.statusCode).toBe(404); expect(foreign.json()).toEqual(missing.json());
    expect(foreign.body).not.toContain(other.wallet); expect(foreign.body).not.toContain('rawStock');
  });
  it.each(['PHASE_E_BUILDINGS_ENABLED', 'ORDINARY_CRAFTING_ENABLED', 'MULTI_BASE_ENABLED'])('%s off refuses new starts while original receipt recovery remains available', async flag => {
    const f = await fixture();
    const accepted = (await post(f)).json();
    vi.stubEnv(flag, 'false');
    const replay = await post(f), recovered = await receipt(f), newKey = await post(f, { ...f.request, idempotencyKey: randomUUID() });
    expect(replay.statusCode).toBe(200); expect(replay.json().receipt).toEqual(accepted.receipt); expect(recovered.json().receipt).toEqual(accepted.receipt);
    expect(newKey.statusCode).toBe(503); expect(newKey.json().error.code).toBe('PHASE_E_DISABLED');
    expect(await jobs(f)).toHaveLength(1);
  });
  it('accepts identical concurrent commands once and refuses every changed original body', async () => {
    const f = await fixture(), responses = await Promise.all([post(f), post(f)]);
    for (const response of responses) { expect([200, 201]).toContain(response.statusCode); matchOrdinaryCraftingEnvelope(response.json(), f.wallet, f.request); }
    expect(responses[0]!.json().receipt).toEqual(responses[1]!.json().receipt);
    expect(await jobs(f)).toHaveLength(1); expect((await raw(f)).available).toBe(0n);
    expect(await db.select().from(resourceStockOperations).where(eq(resourceStockOperations.baseId, f.baseId))).toHaveLength(2);
    for (const change of [{ quantity: 2 }, { recipeVersion: P2.recipeVersion + 1 }, { recipeId: 'refine_heartwood_beams' }, { baseId: randomUUID() }]) {
      const response = await post(f, { ...f.request, ...change });
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    }
  });
  it('recovers frozen starts RPC-free after transfer, pause, catalogue change and deleted current ownership', async () => {
    const f = await fixture(), buyer = await createTestPlayer(db), accepted = (await post(f)).json();
    const proof = (await readOrdinaryCrafting(db, f.request.idempotencyKey))!;
    await transferFixture(f, buyer.wallet);
    await db.update(bases).set({ deedAssetId: 'unavailable-deed-after-transfer' }).where(eq(bases.id, f.baseId));
    vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'false');
    const current = P as unknown as { currentRecipeVersion: number }, prior = current.currentRecipeVersion;
    try {
      current.currentRecipeVersion++;
      const replay = await post(f), original = await receipt(f);
      expect(replay.statusCode).toBe(200); expect(original.statusCode).toBe(200);
      expect(replay.json().receipt).toEqual(accepted.receipt); expect(original.json().receipt).toEqual(accepted.receipt);
      await db.transaction(tx => settleDueOrdinaryCrafting(tx, f.baseId, proof.job.readyAt));
      const completed = OrdinaryCraftingEnvelopeSchema.parse((await receipt(f)).json());
      expect(completed.receipt).toEqual(accepted.receipt); expect(completed.completion).toEqual({ completedAt: proof.job.readyAt.toISOString() });
      expect(JSON.stringify(completed)).not.toContain(buyer.wallet); expect(reader).not.toHaveBeenCalled();
      expect((await readOrdinaryCrafting(db, proof.job.id))!.completion!.custodyWallet).toBe(buyer.wallet);
    } finally { current.currentRecipeVersion = prior; }
  });
  it('a new deed-backed command requires fresh finalized authority before any stock write', async () => {
    const f = await fixture(), asset = (await createTestPlayer(db)).wallet;
    await db.update(bases).set({ deedAssetId: asset, deedMintAssetId: asset }).where(eq(bases.id, f.baseId));
    const response = await post(f);
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('DEED_AUTHORITY_UNAVAILABLE');
    expect(reader).toHaveBeenCalled(); expect(await jobs(f)).toEqual([]); expect(await outputs(f)).toEqual([]);
    expect((await raw(f)).available).toBe(BigInt(P.v1.refining.rawPerOutput));
  });
  it('foreign and unknown historical keys are indistinguishable, while actor substitution cannot start', async () => {
    const owner = await fixture(), other = await fixture(); await post(owner);
    const foreign = OrdinaryCraftingEnvelopeSchema.parse((await receipt(other, owner.request.idempotencyKey)).json());
    const unknown = OrdinaryCraftingEnvelopeSchema.parse((await receipt(other, randomUUID())).json());
    expect(foreign).toMatchObject({ wallet: other.wallet, status: 'unknown', receipt: null, completion: null });
    expect(unknown).toMatchObject({ wallet: other.wallet, status: 'unknown', receipt: null, completion: null });
    const substituted = await post(other, owner.request);
    expect(substituted.statusCode).toBe(409); expect(substituted.json().error.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    expect(substituted.body).not.toContain(owner.wallet); expect(reader).not.toHaveBeenCalled();
  });
});

describe('ordinary current inventory and new admission retain stable-base fences', () => {
  it('publishes same-snapshot raw reservation and protected pending conservation, then auto-delivers through GET while paused', async () => {
    const f = await fixture({ available: BigInt(P.v1.refining.rawPerOutput * 2) });
    const accepted = (await post(f)).json();
    const before = OrdinaryCraftingViewSchema.parse((await get(f)).json());
    expect(before.rawStock.find(s => s.resourceId === 'frost_quartz')).toMatchObject({ available: String(P.v1.refining.rawPerOutput), reserved: '0', total: String(P.v1.refining.rawPerOutput) });
    expect(before.craftingStock.find(s => s.itemId === 'frostglass')).toEqual({ itemId: 'frostglass', available: '0', pendingOutput: accepted.receipt.recipe.output.quantity });
    expect(before.pendingJobs.map(j => j.jobId)).toEqual([f.request.idempotencyKey]);
    vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'false');
    const cutoff = new Date(accepted.receipt.readyAt);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(cutoff);
    try {
      const after = OrdinaryCraftingViewSchema.parse((await get(f)).json());
      expect(after.acceptingJobs).toBe(false); expect(after.serverNow).toBe(cutoff.toISOString()); expect(after.pendingJobs).toEqual([]);
      expect(after.craftingStock.find(s => s.itemId === 'frostglass')).toEqual({ itemId: 'frostglass', available: accepted.receipt.recipe.output.quantity, pendingOutput: '0' });
      const stableBase = await get(f, `/base?baseId=${f.baseId}`);
      expect(stableBase.statusCode).toBe(200); expect(stableBase.json().rawStock).toEqual(after.rawStock);
      expect((await receipt(f)).json().receipt).toEqual(accepted.receipt);
    } finally { vi.useRealTimers(); }
  });
  it.each(['GET', 'POST'] as const)('a transfer after %s preflight cannot read or mutate the buyer current inventory', async method => {
    const f = await fixture(), buyer = await createTestPlayer(db), pause = barrier();
    const prefetch = ownership.requireFreshBaseAuthority;
    vi.spyOn(ownership, 'requireFreshBaseAuthority').mockImplementation(async (...args) => {
      const result = await prefetch(...args); pause.arrive(); await pause.gate; return result;
    });
    const pending = method === 'GET' ? get(f) : post(f);
    try { await pause.seen; await transferFixture(f, buyer.wallet); } finally { pause.release(); }
    const response = await pending;
    expect(response.statusCode).toBe(404); expect(response.json().error.code).toBe('BASE_NOT_OWNED');
    expect(response.body).not.toContain(buyer.wallet); expect(await jobs(f)).toEqual([]);
    expect((await raw(f)).available).toBe(BigInt(P.v1.refining.rawPerOutput));
  });
  it('a pause after player/base/slot lock acquisition blocks all new writes', async () => {
    const f = await fixture(), pause = barrier(), lock = stable.lockStablePrerequisiteBase;
    vi.spyOn(stable, 'lockStablePrerequisiteBase').mockImplementation(async (...args) => {
      const base = await lock(...args); pause.arrive(); await pause.gate; return base;
    });
    const pending = post(f);
    try { await pause.seen; vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'false'); } finally { pause.release(); }
    const response = await pending;
    expect(response.statusCode).toBe(503); expect(await jobs(f)).toEqual([]); expect(await outputs(f)).toEqual([]);
    expect(await db.select().from(resourceStockOperations).where(eq(resourceStockOperations.baseId, f.baseId))).toEqual([]);
  });
  it('locked replay wins if another command accepts after the first preflight miss', async () => {
    const f = await fixture(), pause = barrier(), transact = db.transaction.bind(db);
    let intercepted = false;
    // Pause after the service's own initial key miss, before its transaction.
    // The transaction and its canonical locks still execute real SQL.
    vi.spyOn(db, 'transaction').mockImplementation(async (...args) => {
      if (!intercepted) { intercepted = true; pause.arrive(); await pause.gate; }
      return transact(...args);
    });
    const pending = post(f);
    try {
      await pause.seen;
      await transact(tx => startOrdinaryCrafting(tx, f.wallet, { id: f.request.idempotencyKey, baseId: f.baseId, recipeId: f.request.recipeId,
        recipeVersion: f.request.recipeVersion, quantity: f.request.quantity }, { baseId: f.baseId, assertAuthority: async (locked, wallet, baseId) => {
          await ownership.assertFreshLockedBaseAuthority(locked, wallet, baseId);
        } }));
      vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'false');
    } finally { pause.release(); }
    const response = await pending;
    expect(response.statusCode).toBe(201); expect(matchOrdinaryCraftingEnvelope(response.json(), f.wallet, f.request).status).toBe('accepted');
    expect(await jobs(f)).toHaveLength(1); expect((await raw(f)).available).toBe(0n);
  });
  it('refuses stale recipes and insufficient raw without reserving or inventing protected stock', async () => {
    const f = await fixture({ available: 0n });
    // D153.208 admits immutable v2; a genuinely unknown successor must still refuse.
    let response = await post(f, { ...f.request, recipeVersion: P2.recipeVersion + 1 });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('ORDINARY_RECIPE_CHANGED');
    for (const change of [{ recipeId: 'future_unknown_recipe' }, { quantity: P.v1.maxBatch + 1 }]) {
      response = await post(f, { ...f.request, ...change });
      expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('ORDINARY_RECIPE_INVALID');
    }
    response = await post(f); expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('INSUFFICIENT_RAW_STOCK');
    expect(await jobs(f)).toEqual([]); expect(await outputs(f)).toEqual([]);
  });
  it('refuses raid-time conversion while preserving accepted read/completion obligations', async () => {
    const f = await fixture({ available: BigInt(P.v1.refining.rawPerOutput * 2) }), attacker = await fixture();
    const accepted = (await post(f)).json();
    const original = await readOrdinaryCrafting(db, f.request.idempotencyKey);
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet, attackerBaseId: attacker.baseId,
      defenderWallet: f.wallet, defenderBaseId: f.baseId, seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: SIM_VERSION,
      ordersDeadlineAt: new Date(Date.now() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: raid!.ordersDeadlineAt });
    const response = await post(f, { ...f.request, idempotencyKey: randomUUID() });
    expect(response.statusCode).toBe(423); expect(response.json().error.code).toBe('BASE_BEING_RAIDED');
    expect((await get(f)).statusCode).toBe(200); expect(await jobs(f)).toHaveLength(1);
    expect((await raw(f)).available).toBe(BigInt(P.v1.refining.rawPerOutput));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(accepted.receipt.readyAt));
    try {
      const completed = OrdinaryCraftingViewSchema.parse((await get(f)).json());
      expect(completed.pendingJobs).toEqual([]);
      expect(completed.craftingStock.find(s => s.itemId === 'frostglass')?.available).toBe(accepted.receipt.recipe.output.quantity);
      expect((await receipt(f)).json().receipt).toEqual(accepted.receipt);
      expect((await readOrdinaryCrafting(db, f.request.idempotencyKey))!.inputs).toEqual(original!.inputs);
    } finally { vi.useRealTimers(); }
  });
  it('a failure after actual raw consumption rolls back every row and leaves the original key reusable', async () => {
    const f = await fixture(), consume = resource.consumeRawStockReservation;
    const fault = vi.spyOn(resource, 'consumeRawStockReservation').mockImplementation(async (...args) => {
      await consume(...args); throw new Error('injected after real raw consumption');
    });
    expect((await post(f)).statusCode).toBe(500);
    expect(await jobs(f)).toEqual([]); expect(await outputs(f)).toEqual([]);
    expect(await db.select().from(resourceStockOperations).where(eq(resourceStockOperations.baseId, f.baseId))).toEqual([]);
    expect((await raw(f)).available).toBe(BigInt(P.v1.refining.rawPerOutput));
    expect((await receipt(f)).json()).toMatchObject({ status: 'unknown', receipt: null, completion: null });
    fault.mockRestore(); expect((await post(f)).statusCode).toBe(201);
    const proof = (await readOrdinaryCrafting(db, f.request.idempotencyKey))!;
    for (const input of proof.inputs) {
      expect(await resource.readResourceStockProof(db, input.reserveOperationId!)).not.toBeNull();
      expect(await resource.readResourceStockProof(db, input.consumeOperationId!)).not.toBeNull();
    }
    expect(await db.select().from(resourceStockOperations).where(and(eq(resourceStockOperations.baseId, f.baseId), eq(resourceStockOperations.kind, 'consume')))).toHaveLength(1);
  });
});

it('returns a definitive SHARDS shortage only after rolling back the entire Expedition recipe', async () => {
  const f = await fixture({ available: 0n });
  await db.insert(craftingStocks).values([
    { baseId: f.baseId, itemId: 'heartwood_beams', available: 1n },
    { baseId: f.baseId, itemId: 'thornsilk', available: 1n },
  ]);
  const request = { ...f.request, recipeId: 'craft_expedition_kit', recipeVersion: P2.recipeVersion };
  const response = await post(f, request);
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({ error: { code: 'ledger.insufficient_funds' } });
  expect((await receipt(f)).json()).toMatchObject({ status: 'unknown', receipt: null });
  expect(await jobs(f)).toEqual([]);
  expect((await outputs(f)).map(row => ({ itemId: row.itemId, available: row.available, pendingOutput: row.pendingOutput }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual([
      { itemId: 'heartwood_beams', available: 1n, pendingOutput: 0n },
      { itemId: 'thornsilk', available: 1n, pendingOutput: 0n },
    ]);
});
