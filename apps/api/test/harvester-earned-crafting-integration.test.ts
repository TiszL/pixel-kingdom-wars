/** Fixture term authority and injected clocks compose Harvester earnings with
 * ordinary refining. Only facilities are seeded; raw stock must be earned. */
import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType, PHASE_E_HARVESTER, PHASE_E_ORDINARY_CRAFTING } from '@shardkeep/shared';
import { ordinaryCraftingRecipe } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { builderJobs, buildings, ordinaryCraftingCompletions, ordinaryCraftingJobs, resourceStocks } from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { readHarvesterSettlement } from '../src/game/harvesterSettlement';
import { selectHarvesterSource } from '../src/game/harvesterSources';
import { readOrdinaryCrafting, startOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { readResourceStockProof } from '../src/game/resourceStock';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createHarvesterFixture } from './fixtures/harvesters';
import { connectTestDb } from './helpers';

let conn = connectTestDb();
beforeAll(() => bootstrapSystemAccounts(conn.db));
afterAll(() => conn.sql.end());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function reconnect() {
  // Drop the service's DB pool; subsequent calls must recover persisted state.
  await conn.sql.end(); conn = connectTestDb();
}
async function snapshot(names: readonly string[]) {
  const rows = [];
  for (const name of names) rows.push(await conn.sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${conn.sql(name)} t`);
  return JSON.stringify(rows);
}
const money = () => snapshot(['accounts', 'ledger_transactions', 'ledger_entries']);
const accounting = () => snapshot(['harvester_sources', 'harvester_source_heads', 'harvester_wallet_locks',
  'harvester_events', 'harvester_entries', 'harvester_source_closures', 'resource_stocks',
  'resource_stock_operations', 'resource_stock_entries', 'crafting_stocks',
  'ordinary_crafting_jobs', 'ordinary_crafting_inputs', 'ordinary_crafting_completions']);

describe('Harvester-earned ingredients and ordinary refining across service recovery', () => {
  it('preserves cadence, midnight tax carry and raw-stock/currency conservation through reconnect and pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2035-01-01T20:00:00.000Z'));
    for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'HARVESTERS_ENABLED', 'ORDINARY_CRAFTING_ENABLED']) vi.stubEnv(flag, 'true');
    const f = await createHarvesterFixture(conn.db, { now: new Date() });
    const completedAt = new Date(f.now.getTime() - 1_000);
    const [workshop] = await conn.db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet,
      type: BuildingType.Workshop, tx: 12, ty: 2 }).returning();
    await conn.db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: workshop!.id, kind: 'build',
      startedAt: new Date(completedAt.getTime() - BUILD_COSTS.workshop.buildSec * 1_000), finishesAt: completedAt, completedAt });
    const moneyBefore = await money();
    const termRead = vi.fn(f.reader.readOperatingTerm);
    const selection = { id: f.request.idempotencyKey, baseId: f.baseId, harvesterId: f.harvesterId, policyVersion: f.request.policyVersion };
    const source = await selectHarvesterSource(conn.db, f.wallet, selection, f.authority, { reader: { readOperatingTerm: termRead }, clock: () => f.now });
    const recipe = ordinaryCraftingRecipe('refine_crownsteel', PHASE_E_ORDINARY_CRAFTING.currentRecipeVersion, 1);
    const ingredient = recipe.inputs[0]!, inputQuantity = BigInt(ingredient.quantity), outputQuantity = BigInt(recipe.output.quantity);
    const command = { id: randomUUID(), baseId: f.baseId, recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, quantity: recipe.quantity };
    const at = (ordinal: number) => new Date(source.admittedAt.getTime() + ordinal * PHASE_E_HARVESTER.v1.cadenceSec * 1_000);
    const read = (cutoff: Date) => getBaseState(conn.db, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => cutoff);
    const history = async () => (await readHarvesterSettlement(conn.db, source.id))!;
    const craft = (cutoff: Date) => startOrdinaryCrafting(conn.db, f.wallet, command, f.authority, { clock: () => cutoff });
    expect(source.resourceId).toBe(ingredient.itemId);
    expect(await conn.db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId))).toEqual([]);
    const empty = await accounting();
    await expect(craft(f.now)).rejects.toMatchObject({ code: 'INSUFFICIENT_RAW_STOCK' });
    expect(await accounting()).toBe(empty);

    // Two completed cadences precede midnight; the next cadence belongs to the
    // next UTC day but must continue the same resource's fractional tax carry.
    const beforeMidnight = await read(at(2)), prior = await history();
    expect(prior.events).toHaveLength(2);
    expect(prior.events.map(p => p.event.utcDay)).toEqual([new Date('2035-01-01T00:00:00Z'), new Date('2035-01-01T00:00:00Z')]);
    expect(beforeMidnight.rawStock!.find(s => s.resourceId === ingredient.itemId)).toMatchObject({ available: '2', reserved: '0' });
    await reconnect();
    termRead.mockRejectedValue(new Error('Recovery must not request another term'));
    expect(await selectHarvesterSource(conn.db, f.wallet, selection, f.authority, { reader: { readOperatingTerm: termRead } })).toEqual(source);
    await read(new Date(at(3).getTime() - 1));
    expect(await history()).toEqual(prior);
    const stillPending = await accounting();
    await expect(craft(new Date(at(3).getTime() - 1))).rejects.toMatchObject({ code: 'INSUFFICIENT_RAW_STOCK' });
    expect(await accounting()).toBe(stillPending);
    const afterMidnight = await read(at(3)), crossed = await history();
    expect(crossed.events).toHaveLength(3); expect(crossed.events.slice(0, 2)).toEqual(prior.events);
    expect(crossed.events[2]!.event).toMatchObject({ earnedAt: at(3), utcDay: new Date('2035-01-02T00:00:00Z'),
      carryBefore: prior.events[1]!.event.carryAfter });
    expect(afterMidnight.rawStock!.find(s => s.resourceId === ingredient.itemId)).toMatchObject({ available: '3', reserved: '0' });

    await read(source.leaseExpiresAt);
    const earned = await history();
    expect(earned.source).toEqual(source); expect(earned.events.slice(0, 3)).toEqual(crossed.events);
    expect(earned.events).toHaveLength(PHASE_E_HARVESTER.v1.maxLeaseSec / PHASE_E_HARVESTER.v1.cadenceSec);
    const gross = earned.events.reduce((sum, p) => sum + p.event.gross, 0n);
    const net = earned.events.reduce((sum, p) => sum + p.event.net, 0n);
    const tax = earned.events.reduce((sum, p) => sum + p.event.tax, 0n);
    expect([gross, tax, net, inputQuantity, outputQuantity, net - inputQuantity]).toEqual([15n, 3n, 12n, 10n, 1n, 2n]);
    for (const { event, entries } of earned.events) {
      expect(entries).toHaveLength(3); expect(entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
      expect(entries.find(entry => entry.bucket === 'base_stock')!.delta).toBe(event.net);
      expect(entries.find(entry => entry.bucket === 'island_pool')!.delta).toBe(event.tax);
    }
    const [accepted, duplicate] = await Promise.all([craft(source.leaseExpiresAt), craft(source.leaseExpiresAt)]);
    expect(duplicate).toEqual(accepted); expect(accepted.job.recipeSnapshot).toEqual(recipe);
    expect(await conn.db.select().from(ordinaryCraftingJobs).where(eq(ordinaryCraftingJobs.baseId, f.baseId))).toHaveLength(1);
    const input = accepted.inputs[0]!;
    const reserve = (await readResourceStockProof(conn.db, input.reserveOperationId!))!;
    const consume = (await readResourceStockProof(conn.db, input.consumeOperationId!))!;
    expect(reserve.operation).toMatchObject({ kind: 'reserve', quantity: inputQuantity, baseId: f.baseId, resourceId: ingredient.itemId });
    expect(consume.operation).toMatchObject({ kind: 'consume', quantity: inputQuantity, reservationId: reserve.operation.id });
    for (const proof of [reserve, consume]) expect(proof.entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);

    await reconnect();
    for (const flag of ['PHASE_E_BUILDINGS_ENABLED', 'HARVESTERS_ENABLED', 'ORDINARY_CRAFTING_ENABLED']) vi.stubEnv(flag, 'false');
    const beforeReady = await read(new Date(accepted.job.readyAt.getTime() - 1));
    expect(beforeReady.craftingStock!.find(s => s.itemId === recipe.output.itemId)).toMatchObject({ available: '0', pendingOutput: String(outputQuantity) });
    expect(await readOrdinaryCrafting(conn.db, command.id)).toEqual(accepted);
    const pending = await accounting();
    expect(await craft(accepted.job.readyAt)).toEqual(accepted);
    await expect(startOrdinaryCrafting(conn.db, f.wallet, { ...command, id: randomUUID() }, f.authority)).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
    expect(await accounting()).toBe(pending);
    const completed = await read(accepted.job.readyAt);
    expect(completed.rawStock!.find(s => s.resourceId === ingredient.itemId)).toMatchObject({ available: String(net - inputQuantity), reserved: '0' });
    expect(completed.craftingStock!.find(s => s.itemId === recipe.output.itemId)).toMatchObject({ available: String(outputQuantity), pendingOutput: '0' });
    expect(completed.ordinaryCrafting!.pendingJobs).toEqual([]);
    const receipt = (await readOrdinaryCrafting(conn.db, command.id))!;
    expect(receipt).toMatchObject({ job: { ...accepted.job, completedAt: accepted.job.readyAt }, inputs: accepted.inputs,
      completion: { jobId: command.id, custodyWallet: f.wallet, completedAt: accepted.job.readyAt } });
    expect(await conn.db.select().from(ordinaryCraftingCompletions).where(eq(ordinaryCraftingCompletions.jobId, command.id))).toHaveLength(1);
    const terminal = await accounting();
    expect(await read(accepted.job.readyAt)).toEqual(completed); expect(await craft(accepted.job.readyAt)).toEqual(receipt);
    expect(await history()).toEqual(earned);
    expect(await readResourceStockProof(conn.db, input.reserveOperationId!)).toEqual(reserve);
    expect(await readResourceStockProof(conn.db, input.consumeOperationId!)).toEqual(consume);
    expect(gross).toBe(tax + inputQuantity + BigInt(completed.rawStock!.find(s => s.resourceId === ingredient.itemId)!.available));
    expect(await accounting()).toBe(terminal); expect(await money()).toBe(moneyBefore); expect(termRead).toHaveBeenCalledTimes(1);
  });
});
