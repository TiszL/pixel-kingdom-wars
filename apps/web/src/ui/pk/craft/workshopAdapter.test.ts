import { describe, expect, it } from 'vitest';
import { view as ordinaryView } from '../../../lib/ordinaryCrafting/fixtures.test-support';
import { view as ingotView, id } from '../../../lib/workshop/fixtures.test-support';
import type { OrdinaryCraftingSnapshot } from '../../../lib/ordinaryCrafting/snapshot';
import type { WorkshopSnapshot } from '../../../lib/workshop/snapshot';
import { ingredientState } from './craftLogic';
import { ordinaryWorkshopModel, ingotWorkshopModel, ingotJobs, ordinaryJobs } from './workshopAdapter';

const ordinary = (): OrdinaryCraftingSnapshot => ({ view: ordinaryView(), balances: { keep: '0', shards: '10000', keepRate: 1 }, workshopLevel: 1, enabled: true });
const ingots = (): WorkshopSnapshot => ({ view: ingotView(), balances: { keep: '0', shards: '100000000', keepRate: 1 }, enabled: true });

describe('workshop adapter uses current server snapshots', () => {
  it('unknown snapshot has no spendable stock or invented recipes', () => {
    const result = ordinaryWorkshopModel(null, id(1), 'REFINE', '', 1);
    expect(result.recipes).toEqual([]); expect(result.recipe).toBeNull(); expect(result.canStart).toBe(false);
  });
  it('a previous kingdom snapshot cannot become current stock', () => {
    expect(ordinaryWorkshopModel(ordinary(), id(9), 'REFINE', '', 1).recipes).toEqual([]);
    expect(ingotWorkshopModel(ingots(), id(9), 1).recipe).toBeNull();
  });
  it('renders exact large ingredient counts without Number rounding', () => {
    const snapshot = ordinary(), recipe = snapshot.view.recipes.find(r => r.recipeId === 'refine_frostglass')!;
    snapshot.view.rawStock.find(row => row.resourceId === recipe.inputs[0]!.itemId)!.available = '9007199254740993';
    const result = ordinaryWorkshopModel(snapshot, id(1), 'REFINE', recipe.recipeId, 1);
    expect(result.recipe!.ingredients[0]!.have).toBe(9007199254740993n);
    expect(ingredientState(9007199254740993n, 9007199254740994n)).toMatchObject({ count: '9,007,199,254,740,993/9,007,199,254,740,994', missing: 1n, short: true });
  });
  it('uses the existing exact server-recipe batch scaler', () => {
    const snapshot = ordinary(), recipe = snapshot.view.recipes.find(r => r.recipeId === 'refine_frostglass')!;
    const quantity = Math.min(2, snapshot.view.maxBatch);
    const result = ordinaryWorkshopModel(snapshot, id(1), 'REFINE', recipe.recipeId, quantity);
    expect(result.recipe!.ingredients[0]!.need).toBe(BigInt(recipe.inputs[0]!.quantity) * BigInt(quantity));
    expect(result.recipe!.amount).toBe((BigInt(recipe.output.quantity) * BigInt(quantity)).toLocaleString('en-US'));
  });
  it('unknown stock blocks a start and never becomes a zero balance', () => {
    const snapshot = ordinary(); snapshot.view.rawStock = [];
    const result = ordinaryWorkshopModel(snapshot, id(1), 'REFINE', 'refine_frostglass', 1);
    expect(result.canStart).toBe(false); expect(result.recipe!.ingredients[0]!.have).toBeNull();
  });
  it('a missing recipe never silently selects a substitute', () => {
    expect(ordinaryWorkshopModel(ordinary(), id(1), 'REFINE', 'removed_recipe', 1).recipe).toBeNull();
  });
  it('refuses quantities outside the current server limit', () => {
    const snapshot = ordinary();
    for (const quantity of [0, -1, 1.5, snapshot.view.maxBatch + 1]) {
      expect(ordinaryWorkshopModel(snapshot, id(1), 'REFINE', 'refine_frostglass', quantity).canStart).toBe(false);
    }
  });
  it('paused refining does not imply paid ingot collection is unavailable', () => {
    const snapshot = ingots(); snapshot.enabled = false; snapshot.view.acceptingJobs = false;
    expect(ingotWorkshopModel(snapshot, id(1), 1).canStart).toBe(false);
    expect(ingotJobs(snapshot, id(1))[0]!.state).toBe('READY');
  });
  it('ingot limits use batch, daily and holding remaining, not selected stock', () => {
    const snapshot = ingots(); snapshot.view.batch.size = 8; snapshot.view.allowance.daily.remaining = 3; snapshot.view.allowance.holding.remaining = 2;
    const result = ingotWorkshopModel(snapshot, id(1), 3);
    expect(result.limits).toEqual({ batch: 8, daily: 3, holding: 2 }); expect(result.recipe!.maximum).toBe(2); expect(result.canStart).toBe(false);
  });
  it('a past due time never makes an ingot job ready without the server flag', () => {
    const snapshot = ingots(); snapshot.view.jobs[0]!.ready = false;
    expect(ingotJobs(snapshot, id(1))[0]!.state).toBe('WORKING');
  });
  it('ordinary jobs remain auto-delivered and never acquire a collect action', () => {
    const snapshot = ordinary(), recipe = snapshot.view.recipes[0]!;
    snapshot.view.pendingJobs = [{ jobId: id(4), recipe, startedAt: snapshot.view.serverNow, readyAt: snapshot.view.serverNow }];
    const jobs = ordinaryJobs(snapshot, id(1));
    expect(jobs[0]).toMatchObject({ mode: 'AUTO', state: 'WORKING', receiptId: null });
  });
});
