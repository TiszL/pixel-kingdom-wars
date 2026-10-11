/** Authenticated HTTP composition with fixture term authority and an injected
 * Date clock. Facilities are fixtures; every raw ingredient comes from returns. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_ORDINARY_CRAFTING as POLICY } from '@shardkeep/shared';
import { matchOrdinaryCraftingEnvelope, OrdinaryCraftingViewSchema, type OrdinaryCraftingRequest } from '@shardkeep/shared/ordinaryCraftingApi';
import { ordinaryCraftingRecipe } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { matchStarterExpeditionEnvelope, StarterExpeditionViewSchema, type StarterExpeditionRequest } from '@shardkeep/shared/starterExpeditionApi';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { builderJobs, buildings, ordinaryCraftingJobs, resourceStocks, sessions } from '../src/db/schema';
import * as prefetch from '../src/game/expeditionTermReader';
import { readOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { readResourceStockProof } from '../src/game/resourceStock';
import { readStarterExpeditionReturn } from '../src/game/starterExpeditionReturns';
import type { StarterExpeditionProvider } from '../src/game/starterExpeditionRoutes';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, TEST_CONFIG } from './helpers';
import { SEAL_BOUND_HTTP_CASE_MS } from './sealLatencyBudgets';

const conn = connectTestDb(), db = conn.db;
const servers: FastifyInstance[] = [];
const connect = vi.fn(() => { throw new Error('Fixture journey must not contact RPC'); });
function termProvider(): StarterExpeditionProvider {
  const key = Keypair.generate().publicKey;
  return { policy: { genesisHash: key, programId: key, config: key, round: 1n,
    mint: key, prizeOwner: key, prizeAta: key, stateProvenance: 'fresh-reviewed-deployment',
    deployment: { programDataAddress: key.toBase58(), programDataSha256: 'ab'.repeat(32), upgradeAuthority: null } }, connect };
}
beforeAll(() => bootstrapSystemAccounts(db));
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
afterAll(() => conn.sql.end());

async function openApp(withTermProvider: boolean) {
  // Match the existing HTTP fixture suites: register without starting the
  // unrelated multibase observer, then exercise the live route flags below.
  const previous = process.env['MULTI_BASE_ENABLED'];
  process.env['MULTI_BASE_ENABLED'] = 'false';
  try {
    const app = await buildApp(TEST_CONFIG, db, withTermProvider ? { starterExpeditionProvider: termProvider() } : {});
    servers.push(app); await app.ready(); return app;
  } finally {
    if (previous === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = previous;
  }
}
async function snapshot(names: readonly string[]) {
  const rows = [];
  for (const name of names) rows.push(await conn.sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${conn.sql(name)} t`);
  return JSON.stringify(rows);
}
const money = () => snapshot(['accounts', 'ledger_transactions', 'ledger_entries']);
const accounting = () => snapshot(['starter_expeditions', 'starter_expedition_returns', 'starter_expedition_entries',
  'starter_expedition_inflight', 'resource_stocks', 'resource_stock_operations', 'resource_stock_entries',
  'crafting_stocks', 'ordinary_crafting_jobs', 'ordinary_crafting_inputs', 'ordinary_crafting_completions']);

describe('authenticated earned HOME inputs and ordinary refining across restart', () => {
  it('conserves raw stock and currency across HTTP earning, refining, restart and pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2035-01-01T01:00:00.000Z'));
    for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'ORDINARY_CRAFTING_ENABLED']) vi.stubEnv(flag, 'true');
    const f = await createStarterExpeditionFixture(db, { now: new Date() });
    const completedAt = new Date(Date.now() - 1_000);
    const [workshop] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet,
      type: BuildingType.Workshop, tx: 8, ty: 2 }).returning();
    await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: workshop!.id, kind: 'build',
      startedAt: new Date(completedAt.getTime() - BUILD_COSTS.workshop.buildSec * 1_000), finishesAt: completedAt, completedAt });
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
    const termReads = vi.spyOn(prefetch, 'prefetchExpeditionTermReader').mockImplementation(async () => {
      let used = false;
      return { async readOperatingTerm(at: string) {
        if (used) throw new Error('Fixture observation is one-use');
        used = true; return f.reader.readOperatingTerm(at);
      } };
    });
    let app = await openApp(true);
    const get = (url: string) => app.inject({ url, cookies });
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, cookies, payload });
    const current = async () => {
      const response = await get(`/ordinary-crafting?baseId=${f.baseId}`);
      expect(response.statusCode, response.body).toBe(200);
      return OrdinaryCraftingViewSchema.parse(response.json());
    };
    const recipe = ordinaryCraftingRecipe('refine_crownsteel', POLICY.currentRecipeVersion, 1);
    const ingredient = recipe.inputs[0]!, inputQuantity = BigInt(ingredient.quantity), outputQuantity = BigInt(recipe.output.quantity);
    const craft: OrdinaryCraftingRequest = { idempotencyKey: randomUUID(), baseId: f.baseId,
      recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, quantity: recipe.quantity };
    const craftReceipt = () => get(`/ordinary-crafting/jobs/by-key/${craft.idempotencyKey}`);
    expect(await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId))).toEqual([]);
    const initial = await current();
    expect(initial.rawStock.every(stock => stock.available === '0' && stock.reserved === '0')).toBe(true);
    expect(initial.craftingStock.every(stock => stock.available === '0' && stock.pendingOutput === '0')).toBe(true);
    const moneyBefore = await money(), empty = await accounting();
    const refused = await post('/ordinary-crafting/jobs', craft);
    expect(refused.statusCode).toBe(422); expect(refused.json().error.code).toBe('INSUFFICIENT_RAW_STOCK');
    expect(await accounting()).toBe(empty);

    const trips = [];
    let earned = 0n, gross = 0n, tax = 0n;
    while (earned < inputQuantity) {
      const { id: _id, ...body } = f.command;
      const request: StarterExpeditionRequest = { idempotencyKey: randomUUID(), ...body };
      const response = await post('/starter-expeditions', request);
      expect(response.statusCode, response.body).toBe(201);
      const accepted = matchStarterExpeditionEnvelope(response.json(), f.wallet, request);
      if (accepted.status !== 'accepted') throw new Error('HTTP departure was not accepted');
      const departure = accepted.receipt;
      expect(departure.route.resourceId).toBe(ingredient.itemId); expect(accepted.return).toBeNull();
      const pending = await accounting();
      vi.setSystemTime(new Date(Date.parse(departure.returnsAt) - 1));
      const early = await get(`/starter-expeditions?baseId=${f.baseId}`);
      expect(early.statusCode, early.body).toBe(200);
      expect(StarterExpeditionViewSchema.parse(early.json()).rawStock.find(stock => stock.resourceId === ingredient.itemId)?.available).toBe(String(earned));
      expect(await accounting()).toBe(pending);
      vi.setSystemTime(new Date(departure.returnsAt));
      const returned = await get(`/starter-expeditions?baseId=${f.baseId}`);
      expect(returned.statusCode, returned.body).toBe(200);
      const view = StarterExpeditionViewSchema.parse(returned.json());
      earned += BigInt(departure.route.netQuantity); gross += BigInt(departure.route.grossQuantity); tax += BigInt(departure.route.islandPoolQuantity);
      expect(view.flight).toBeNull(); expect(view.rawStock.find(stock => stock.resourceId === ingredient.itemId)).toMatchObject({ available: String(earned), reserved: '0' });
      const proof = await readStarterExpeditionReturn(db, request.idempotencyKey);
      expect(proof).not.toBeNull(); expect(proof!.entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
      const recovered = await get(`/starter-expeditions/by-key/${request.idempotencyKey}`);
      expect(recovered.statusCode).toBe(200); expect(recovered.json().receipt).toEqual(departure); expect(recovered.json().return).not.toBeNull();
      trips.push({ request, departure, proof, returned: recovered.json().return });
    }
    expect(trips).toHaveLength(3); expect([gross, tax, earned, inputQuantity, outputQuantity, earned - inputQuantity]).toEqual([15n, 3n, 12n, 10n, 1n, 2n]);
    const starts = await Promise.all([post('/ordinary-crafting/jobs', craft), post('/ordinary-crafting/jobs', craft)]);
    for (const response of starts) expect([200, 201], response.body).toContain(response.statusCode);
    const accepted = matchOrdinaryCraftingEnvelope(starts[0]!.json(), f.wallet, craft);
    if (accepted.status !== 'accepted') throw new Error('HTTP refining was not accepted');
    expect(starts[1]!.json().receipt).toEqual(accepted.receipt); expect(accepted.receipt.recipe).toEqual(recipe);
    expect(await db.select().from(ordinaryCraftingJobs).where(eq(ordinaryCraftingJobs.baseId, f.baseId))).toHaveLength(1);
    const job = (await readOrdinaryCrafting(db, craft.idempotencyKey))!;
    const input = job.inputs[0]!;
    const reserve = (await readResourceStockProof(db, input.reserveOperationId!))!, consume = (await readResourceStockProof(db, input.consumeOperationId!))!;
    expect(reserve.operation).toMatchObject({ kind: 'reserve', quantity: inputQuantity, baseId: f.baseId, resourceId: ingredient.itemId });
    expect(consume.operation).toMatchObject({ kind: 'consume', quantity: inputQuantity, reservationId: reserve.operation.id });
    for (const proof of [reserve, consume]) expect(proof.entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);

    // Discard the app/provider, keep only persistent DB/session state, and make
    // recovery fail if a route tries to obtain new term authority.
    await app.close(); servers.splice(servers.indexOf(app), 1);
    for (const flag of ['PHASE_E_BUILDINGS_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'ORDINARY_CRAFTING_ENABLED']) vi.stubEnv(flag, 'false');
    termReads.mockRejectedValue(new Error('Recovery must not acquire term authority'));
    app = await openApp(false);
    vi.setSystemTime(new Date(Date.parse(accepted.receipt.readyAt) - 1));
    const beforeReady = await current(), pending = await accounting();
    expect(beforeReady.acceptingJobs).toBe(false);
    expect(beforeReady.rawStock.find(stock => stock.resourceId === ingredient.itemId)).toMatchObject({ available: String(earned - inputQuantity), reserved: '0' });
    expect(beforeReady.craftingStock.find(stock => stock.itemId === recipe.output.itemId)).toMatchObject({ available: '0', pendingOutput: String(outputQuantity) });
    expect((await craftReceipt()).json()).toMatchObject({ receipt: accepted.receipt, completion: null });
    const replay = await post('/ordinary-crafting/jobs', craft);
    expect(replay.statusCode).toBe(200); expect(replay.json().receipt).toEqual(accepted.receipt);
    expect((await post('/ordinary-crafting/jobs', { ...craft, idempotencyKey: randomUUID() })).statusCode).toBe(503);
    expect((await post('/starter-expeditions', { ...trips[0]!.request, idempotencyKey: randomUUID() })).statusCode).toBe(503);
    expect(await accounting()).toBe(pending);

    vi.setSystemTime(new Date(accepted.receipt.readyAt));
    const completed = await current();
    expect(completed.acceptingJobs).toBe(false); expect(completed.pendingJobs).toEqual([]);
    expect(completed.rawStock.find(stock => stock.resourceId === ingredient.itemId)).toMatchObject({ available: String(earned - inputQuantity), reserved: '0' });
    expect(completed.craftingStock.find(stock => stock.itemId === recipe.output.itemId)).toMatchObject({ available: String(outputQuantity), pendingOutput: '0' });
    const finalReceipt = await craftReceipt();
    expect(finalReceipt.statusCode).toBe(200); expect(finalReceipt.json()).toMatchObject({ receipt: accepted.receipt, completion: { completedAt: accepted.receipt.readyAt } });
    const terminal = await accounting();
    expect(await current()).toEqual(completed);
    expect((await post('/ordinary-crafting/jobs', craft)).json()).toEqual(finalReceipt.json());
    for (const trip of trips) {
      const recovered = await post('/starter-expeditions', trip.request);
      expect(recovered.statusCode).toBe(200); expect(recovered.json()).toMatchObject({ receipt: trip.departure, return: trip.returned });
      expect(await readStarterExpeditionReturn(db, trip.request.idempotencyKey)).toEqual(trip.proof);
    }
    expect((await readOrdinaryCrafting(db, craft.idempotencyKey))!.inputs).toEqual(job.inputs);
    expect(await accounting()).toBe(terminal); expect(await money()).toBe(moneyBefore);
    expect(termReads).toHaveBeenCalledTimes(trips.length); expect(connect).not.toHaveBeenCalled();
  }, SEAL_BOUND_HTTP_CASE_MS); // HTTP earning/refining/restart over guarded SQL; see sealLatencyBudgets.ts.
});
