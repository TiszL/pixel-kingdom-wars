/** Snapshot-only presentation. Existing controllers own requests, prices, clocks and proof. */
import type { OrdinaryCraftingRecipeSnapshot } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import type { OrdinaryCraftingView } from '@shardkeep/shared/ordinaryCraftingApi';
import { ordinaryCraftingBatch } from '../../../lib/ordinaryCrafting/controller';
import type { OrdinaryCraftingSnapshot } from '../../../lib/ordinaryCrafting/snapshot';
import type { WorkshopSnapshot } from '../../../lib/workshop/snapshot';
import type { PriceUi } from '../types';
import type { CraftItem, CraftJob, CraftRecipe } from './CraftSheets';
import { ingotCastMax } from './craftLogic';

export const workshopItemName = (id: string): string => id === 'shards' ? 'SHARDS' : id.replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, c => c.toUpperCase());
const whole = (amount: string | number | bigint): string => BigInt(amount).toLocaleString('en-US');
export function ingredientAvailable(view: OrdinaryCraftingView, input: OrdinaryCraftingRecipeSnapshot['inputs'][number]): bigint | null {
  const value = input.kind === 'shards' ? ('shardsAvailable' in view ? view.shardsAvailable : null)
    : input.kind === 'raw' ? view.rawStock.find(row => row.resourceId === input.itemId)?.available
      : view.craftingStock.find(row => row.itemId === input.itemId)?.available;
  return value == null ? null : BigInt(value);
}
interface WorkshopModel { recipes: CraftItem[]; recipe: CraftRecipe | null; price: PriceUi | null; canStart: boolean; reason: string | null }
const unavailable = (): WorkshopModel => ({ recipes: [], recipe: null, price: null, canStart: false, reason: 'Refresh current kingdom stock.' });
export function ordinaryWorkshopModel(snapshot: OrdinaryCraftingSnapshot | null, baseId: string | null, tab: 'REFINE' | 'EQUIPMENT', recipeId: string, quantity: number): WorkshopModel {
  if (!snapshot || snapshot.view.baseId !== baseId) return unavailable();
  const { view } = snapshot;
  const catalogue = view.recipes.filter(recipe => recipe.recipeId.startsWith('refine_') === (tab === 'REFINE'));
  const recipes: CraftItem[] = catalogue.map(recipe => ({ id: recipe.recipeId, name: workshopItemName(recipe.output.itemId), icon: 'shape:hammer', detail: 'Delivered automatically', amount: view.craftingStock.find(row => row.itemId === recipe.output.itemId)?.available == null ? null : whole(view.craftingStock.find(row => row.itemId === recipe.output.itemId)!.available), tag: null }));
  const unit = catalogue.find(recipe => recipe.recipeId === recipeId);
  if (!unit) return { ...unavailable(), recipes, reason: 'Choose a recipe.' };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > view.maxBatch) return { ...unavailable(), recipes, reason: 'Choose a quantity within the server limit.' };
  let batch: OrdinaryCraftingRecipeSnapshot;
  try { batch = ordinaryCraftingBatch(unit, quantity); } catch { return { ...unavailable(), recipes, reason: 'The recipe amount could not be verified.' }; }
  const missing = batch.inputs.find(input => { const have = ingredientAvailable(view, input); return have === null || have < BigInt(input.quantity); });
  const shardInputs = batch.inputs.filter(input => input.kind === 'shards');
  const cost = shardInputs.reduce((sum, input) => sum + BigInt(input.quantity), 0n);
  const balance = 'shardsAvailable' in view ? BigInt(view.shardsAvailable) : null;
  const price: PriceUi | null = shardInputs.length ? { currency: 'SHARDS', amount: whole(cost), status: balance === null ? 'UNAVAILABLE' : balance < cost ? 'SHORT' : cost === 0n ? 'SERVER_ZERO' : 'OK' } : null;
  const reason = !snapshot.enabled || !view.acceptingJobs ? 'New refining is paused.' : view.pendingJobs.length ? 'A refining job is already running.' : missing ? `Check the available ${workshopItemName(missing.itemId)}.` : null;
  return { recipes, price, canStart: reason === null, reason, recipe: {
    id: unit.recipeId, name: workshopItemName(unit.output.itemId), icon: 'shape:hammer', detail: 'Delivered automatically', amount: whole(batch.output.quantity), tag: null,
    secondsEach: unit.durationSec, quantity, minimum: 1, maximum: view.maxBatch, reason,
    ingredients: batch.inputs.filter(input => input.kind !== 'shards').map(input => ({ id: input.itemId, name: workshopItemName(input.itemId), icon: 'shape:chest', source: input.kind === 'raw' ? 'Your kingdom resources' : 'Refined materials and kits', have: ingredientAvailable(view, input), need: BigInt(input.quantity) })),
  } };
}
export function ingotWorkshopModel(snapshot: WorkshopSnapshot | null, baseId: string | null, quantity: number): WorkshopModel & { limits: { batch: number | null; daily: number | null; holding: number | null } } {
  if (!snapshot || snapshot.view.inventory.baseId !== baseId) return { ...unavailable(), limits: { batch: null, daily: null, holding: null } };
  const { view } = snapshot, limits = { batch: view.batch.size, daily: view.allowance.daily.remaining, holding: view.allowance.holding.remaining };
  const maximum = ingotCastMax(limits.batch, limits.daily, limits.holding)!;
  const valid = Number.isSafeInteger(quantity) && quantity > 0;
  const cost = valid ? BigInt(quantity) * BigInt(view.shardsPerIngot) : null;
  const short = cost !== null && BigInt(snapshot.balances.shards) < cost;
  const reason = !snapshot.enabled || !view.acceptingJobs ? 'New refining is paused.' : !valid || quantity > maximum ? 'Choose a quantity within the server limits.' : short ? 'More SHARDS are needed.' : null;
  const item = { id: 'forge_ingot', name: 'Forge Ingots', icon: 'shape:hammer', detail: 'SHARDS are charged at start. Collection has no SOL fee.', amount: valid ? whole(quantity) : null, tag: null };
  return { limits, recipes: [item], canStart: reason === null, reason,
    price: cost === null ? { currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' } : { currency: 'SHARDS', amount: whole(cost), status: short ? 'SHORT' : cost === 0n ? 'SERVER_ZERO' : 'OK' },
    recipe: { ...item, ingredients: [], quantity, minimum: 1, maximum, secondsEach: view.secPerIngot, reason },
  };
}
export function ingotJobs(snapshot: WorkshopSnapshot | null, baseId: string | null): CraftJob[] {
  if (!snapshot || snapshot.view.inventory.baseId !== baseId) return [];
  return snapshot.view.jobs.filter(job => !job.collectedAt).map(job => ({ id: job.jobId, mode: 'SERVER', state: job.ready ? 'READY' : 'WORKING', receiptId: null, name: 'Forge Ingots', icon: 'shape:hammer', quantity: whole(job.ingots), secondsLeft: null, statusLabel: job.ready ? 'Ready to collect' : 'Refining · readiness checked by the server' }));
}
export function ordinaryJobs(snapshot: OrdinaryCraftingSnapshot | null, baseId: string | null): CraftJob[] {
  if (!snapshot || snapshot.view.baseId !== baseId) return [];
  return snapshot.view.pendingJobs.map(job => ({ id: job.jobId, mode: 'AUTO', state: 'WORKING', receiptId: null, name: workshopItemName(job.recipe.output.itemId), icon: 'shape:hammer', quantity: whole(job.recipe.output.quantity), secondsLeft: null, statusLabel: 'Working · delivered automatically' }));
}
