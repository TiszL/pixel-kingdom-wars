import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BUILD_COSTS, BuildingType, PHASE_E_ORDINARY_CRAFTING as P, PHASE_E_ORDINARY_CRAFTING_V2 as P2 } from '@shardkeep/shared';
import { ORDINARY_RECIPE_IDS, ordinaryCraftingRecipe, type OrdinaryRecipeId } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseRaidLocks, bases, baseSlots, buildings, builderJobs, craftingStocks, ordinaryCraftingJobs as jobs,
  ordinaryCraftingInputs as inputs, ordinaryCraftingCompletions as completions, resourceStocks, resourceStockOperations, raids } from '../src/db/schema';
import { startOrdinaryCrafting, readOrdinaryCrafting, settleDueOrdinaryCrafting, type OrdinaryCraftingCommand } from '../src/game/ordinaryCrafting';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, createTestPlayer } from './helpers';
const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
// Explicit service fixture admission; production defaults stay off.
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'true'); });
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const f = await createStarterExpeditionFixture(db);
  const [building] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet, type: BuildingType.Workshop, tx: 9, ty: 2 }).returning();
  const completedAt = new Date(f.now.getTime() - 1_000);
  await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: building!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Workshop].buildSec * 1_000), finishesAt: completedAt, completedAt });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const command = (f: Fixture, recipeId: OrdinaryRecipeId = 'refine_frostglass', quantity = 1): OrdinaryCraftingCommand =>
  ({ id: randomUUID(), baseId: f.baseId, recipeId, recipeVersion: P.v1.recipeVersion, quantity });
const start = (f: Fixture, c = command(f)) => startOrdinaryCrafting(db, f.wallet, c, f.authority, { clock: () => f.now });
const complete = (f: Fixture, at: Date) => db.transaction(tx => settleDueOrdinaryCrafting(tx, f.baseId, at));
async function raw(f: Fixture, recipeId: OrdinaryRecipeId = 'refine_frostglass', quantity = 1) {
  for (const i of ordinaryCraftingRecipe(recipeId, P.v1.recipeVersion, quantity).inputs) {
    if (i.kind !== 'raw') throw new Error('fixture only seeds explicit raw input, never crafted output');
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: i.itemId, available: BigInt(i.quantity) });
  }
}
const stock = async (f: Fixture, itemId = 'frostglass') => (await db.select().from(craftingStocks)
  .where(and(eq(craftingStocks.baseId, f.baseId), eq(craftingStocks.itemId, itemId))))[0];
const rawStock = async (f: Fixture) => (await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId)))[0];

it('SQL freezes the shared immutable recipe v1 rather than mutable current tuning', () => {
  const migration = readFileSync(new URL('../drizzle/0147_ordinary_crafting.sql', import.meta.url), 'utf8');
  for (const id of ORDINARY_RECIPE_IDS) expect(migration).toContain(JSON.stringify(ordinaryCraftingRecipe(id, P.v1.recipeVersion, 1)));
  expect(migration).toContain(`NEW.quantity NOT BETWEEN 1 AND ${P.v1.maxBatch}`);
});

describe('ordinary crafting consumes once and automatically credits protected original-base output', () => {
  it('consumes raw at start, reserves unavailable output and completes once at the exact deadline', async () => {
    const f = await fixture(); await raw(f);
    const before = await db.execute(sql`SELECT count(*)::text n FROM ledger_transactions`);
    const p = await start(f);
    expect(await rawStock(f)).toMatchObject({ available: 0n, reserved: 0n });
    expect(await stock(f)).toMatchObject({ available: 0n, pendingOutput: p.job.outputQuantity });
    expect(p.inputs[0]).toMatchObject({ kind: 'raw', quantity: BigInt(p.job.recipeSnapshot.inputs[0]!.quantity) });
    expect(await complete(f, new Date(p.job.readyAt.getTime() - 1))).toEqual([]);
    expect(await complete(f, p.job.readyAt)).toHaveLength(1);
    expect(await complete(f, p.job.readyAt)).toEqual([]);
    expect(await stock(f)).toMatchObject({ available: p.job.outputQuantity, pendingOutput: 0n });
    expect(await db.execute(sql`SELECT count(*)::text n FROM ledger_transactions`)).toEqual(before);
  });

  it('serializes identical keys and prevents two distinct unfinished jobs on one base', async () => {
    const f = await fixture(); await raw(f, 'refine_frostglass', P.v1.maxBatch);
    const c = command(f), same = await Promise.all([start(f, c), start(f, c)]);
    expect(same[0]).toEqual(same[1]);
    await expect(start(f, command(f))).rejects.toMatchObject({ code: 'ORDINARY_CRAFTING_BUSY' });
    expect(await db.select().from(jobs).where(eq(jobs.baseId, f.baseId))).toHaveLength(1);
    await expect(start(f, { ...c, quantity: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });

  it('rejects insufficient raw and rolls back its job, reservations and output capacity', async () => {
    const f = await fixture();
    await expect(start(f)).rejects.toMatchObject({ code: 'INSUFFICIENT_RAW_STOCK' });
    expect(await stock(f)).toBeUndefined();
    expect(await db.select().from(jobs).where(eq(jobs.baseId, f.baseId))).toEqual([]);
    expect(await db.select().from(resourceStockOperations).where(eq(resourceStockOperations.baseId, f.baseId))).toEqual([]);
  });

  it('crafts Navigation Kit from real prior refining; missing second ingredient rolls back the first deduction', async () => {
    const f = await fixture(); await raw(f, 'refine_prismstone_lens');
    let p = await start(f, command(f, 'refine_prismstone_lens')); f.now = p.job.readyAt; await complete(f, f.now);
    await expect(start(f, command(f, 'craft_navigation_kit'))).rejects.toMatchObject({ code: 'INSUFFICIENT_CRAFTING_STOCK' });
    expect((await stock(f, 'prismstone_lens'))!.available).toBe(1n);
    expect(await stock(f, 'navigation_kit')).toBeUndefined();
    await raw(f); p = await start(f); f.now = p.job.readyAt; await complete(f, f.now);
    p = await start(f, command(f, 'craft_navigation_kit'));
    expect((await stock(f, 'prismstone_lens'))!.available).toBe(0n); expect((await stock(f))!.available).toBe(0n);
    expect((await stock(f, 'navigation_kit'))!.available).toBe(0n);
    await complete(f, p.job.readyAt); expect((await stock(f, 'navigation_kit'))!.available).toBe(1n);
  });

  it('reserves capacity before consuming inputs and permits the exact int64 boundary', async () => {
    const f = await fixture(); await raw(f);
    await db.insert(craftingStocks).values({ baseId: f.baseId, itemId: 'frostglass', available: RAW_RESOURCE_STORAGE_MAX });
    await expect(start(f)).rejects.toMatchObject({ code: 'CRAFTING_STORAGE_FULL' });
    expect((await rawStock(f))!.available).toBe(BigInt(P.v1.refining.rawPerOutput));
    await db.update(craftingStocks).set({ available: RAW_RESOURCE_STORAGE_MAX - 1n }).where(eq(craftingStocks.baseId, f.baseId));
    const p = await start(f);
    await expect(db.update(craftingStocks).set({ available: RAW_RESOURCE_STORAGE_MAX }).where(eq(craftingStocks.baseId, f.baseId))).rejects.toThrow();
    await complete(f, p.job.readyAt); expect((await stock(f))!.available).toBe(RAW_RESOURCE_STORAGE_MAX);
  });

  it('completion and original replay survive inactive new custody, missing Workshop and current catalogue changes', async () => {
    const f = await fixture(), buyer = await createTestPlayer(db); await raw(f); const c = command(f), p = await start(f, c);
    await db.transaction(async tx => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
      await tx.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
      await tx.update(buildings).set({ level: 0 }).where(eq(buildings.id, p.job.workshopId));
    });
    const current = P as unknown as { currentRecipeVersion: number }, old = current.currentRecipeVersion;
    try {
      current.currentRecipeVersion = old + 1;
      const [done] = await complete(f, p.job.readyAt);
      expect(done!.completion!.custodyWallet).toBe(buyer.wallet);
      expect(done!.job.actorWallet).toBe(f.wallet);
      expect(await start(f, c)).toEqual(done);
      await expect(startOrdinaryCrafting(db, buyer.wallet, c, f.authority)).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
    } finally { current.currentRecipeVersion = old; }
  });

  it('an active raid cannot turn its frozen raw into protected work', async () => {
    const f = await fixture(), attacker = await fixture(); await raw(f);
    const frozen = await rawStock(f);
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet, attackerBaseId: attacker.baseId,
      defenderWallet: f.wallet, defenderBaseId: f.baseId, seed: 1n, snapshot: { frozenRaw: frozen!.available.toString() }, armySnapshot: {},
      simVersion: 9, ordersDeadlineAt: new Date(f.now.getTime() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: raid!.ordersDeadlineAt });
    await expect(start(f)).rejects.toMatchObject({ code: 'BASE_BEING_RAIDED' });
    expect(await rawStock(f)).toEqual(frozen); expect(await stock(f)).toBeUndefined();
    expect((await db.select().from(raids).where(eq(raids.id, raid!.id)))[0]).toEqual(raid);
  });

  it('outer rollback preserves both consumed inputs at start and pending output at completion', async () => {
    const f = await fixture(); await raw(f); const c = command(f);
    await expect(db.transaction(async tx => { await startOrdinaryCrafting(tx, f.wallet, c, f.authority, { clock: () => f.now }); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await readOrdinaryCrafting(db, c.id)).toBeNull(); expect((await rawStock(f))!.available).toBe(BigInt(P.v1.refining.rawPerOutput));
    const p = await start(f, c);
    await expect(db.transaction(async tx => { await settleDueOrdinaryCrafting(tx, f.baseId, p.job.readyAt); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect((await readOrdinaryCrafting(db, c.id))!.completion).toBeNull(); expect((await stock(f))!.pendingOutput).toBe(p.job.outputQuantity);
    expect((await Promise.all([complete(f, p.job.readyAt), complete(f, p.job.readyAt)])).flat()).toHaveLength(1);
  });

  it('requires completed Workshop proof and refuses an unsupported new recipe review', async () => {
    const f = await fixture(); await raw(f);
    // D153.208 admits immutable v2; a genuinely unknown successor must still refuse.
    await expect(start(f, { ...command(f), recipeVersion: P2.recipeVersion + 1 })).rejects.toMatchObject({ code: 'ORDINARY_RECIPE_CHANGED' });
    await db.update(builderJobs).set({ completedAt: null }).where(eq(builderJobs.baseId, f.baseId));
    await expect(start(f)).rejects.toMatchObject({ code: 'ORDINARY_WORKSHOP_REQUIRED' });
    expect((await rawStock(f))!.available).toBe(BigInt(P.v1.refining.rawPerOutput));
  });

  it('SQL requires unchanged original evidence and a matching terminal before ending the job', async () => {
    const f = await fixture(); await raw(f); const p = await start(f);
    await expect(db.update(jobs).set({ quantity: 2 }).where(eq(jobs.id, p.job.id))).rejects.toThrow();
    await expect(db.update(jobs).set({ completedAt: p.job.readyAt }).where(eq(jobs.id, p.job.id))).rejects.toThrow();
    await expect(db.delete(inputs).where(eq(inputs.jobId, p.job.id))).rejects.toThrow();
    await expect(db.insert(completions).values({ jobId: p.job.id, custodyWallet: f.wallet, completedAt: f.now })).rejects.toThrow();
    expect(await readOrdinaryCrafting(db, p.job.id)).toEqual(p);
  });
});


it('keeps a coherent original receipt when completion commits after the first read snapshot', async () => {
  const f = await fixture(); await raw(f); const p = await start(f);
  let captured!: () => void, release!: () => void, held = false;
  const seen = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Real SQL still executes. Only delivery of its already-fetched first job
  // snapshot pauses, so completion deterministically commits between reads.
  const delayedDb = Object.assign(Object.create(db) as typeof db, {
    select: (...args: Parameters<typeof db.select>) => {
      const builder = db.select(...args);
      return new Proxy(builder, { get(target, property, receiver) {
        if (property !== 'from') return Reflect.get(target, property, receiver);
        return (...fromArgs: Parameters<typeof builder.from>) => {
          const query = target.from(...fromArgs);
          if (fromArgs[0] === jobs) {
            const then = query.then.bind(query);
            Object.defineProperty(query, 'then', { value:
              (resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                then(async rows => { if (!held) { held = true; captured(); await gate; } return rows; }).then(resolve, reject),
            });
          }
          return query;
        };
      } });
    },
  });
  const reading = readOrdinaryCrafting(delayedDb, p.job.id);
  try {
    await seen;
    expect(await complete(f, p.job.readyAt)).toHaveLength(1);
  } finally { release(); }
  expect(await reading).toEqual(p);
  expect((await readOrdinaryCrafting(db, p.job.id))!.completion).not.toBeNull();
  expect(await complete(f, p.job.readyAt)).toEqual([]);
  expect((await stock(f))!.available).toBe(p.job.outputQuantity);
});
