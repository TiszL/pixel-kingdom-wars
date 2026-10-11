import { currentOrdinaryCraftingRecipes, type OrdinaryCraftingView } from '@shardkeep/shared/ordinaryCraftingApi';
import { ORDINARY_CRAFTING_ITEM_IDS_V2, ordinaryCraftingRecipe } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import type { OrdinaryCraftingCommand, OrdinaryCraftingIdentity, OrdinaryCraftingProof } from './journal';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: OrdinaryCraftingIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const now = '2026-09-22T12:00:00.000Z';
const policy = currentOrdinaryCraftingRecipes(2);
export function command(quantity = 1, key = id(2)): OrdinaryCraftingCommand {
  const recipe = ordinaryCraftingRecipe('refine_frostglass', policy.recipeVersion, quantity);
  return { request: { baseId: id(1), idempotencyKey: key, recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, quantity }, recipe };
}
export const start = command();
export const view = (): OrdinaryCraftingView => ({ wallet: identity.wallet, baseId: id(1), features: { ordinaryCrafting: { version: 1, receipts: 1 } },
  acceptingJobs: true, ...structuredClone(policy), rawStock: PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '10000', reserved: '0', total: '10000' })),
  catalogueVersion: 2, shardsAvailable: '10000', craftingStock: ORDINARY_CRAFTING_ITEM_IDS_V2.map(itemId => ({ itemId, available: '10000', pendingOutput: '0' })), pendingJobs: [], serverNow: now });
export function proof(original = start, accepted = false, completed = false): OrdinaryCraftingProof {
  const startedAt = now, readyAt = new Date(Date.parse(startedAt) + original.recipe.durationSec * 1_000).toISOString();
  const common = { wallet: identity.wallet, idempotencyKey: original.request.idempotencyKey, serverNow: completed ? readyAt : now };
  return accepted ? { ...common, status: 'accepted', receipt: { wallet: identity.wallet, request: original.request,
    jobId: original.request.idempotencyKey, recipe: original.recipe, startedAt, readyAt }, completion: completed ? { completedAt: readyAt } : null }
    : { ...common, status: 'unknown', receipt: null, completion: null };
}
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
export const base = () => ({ baseId: id(1), player: { wallet: identity.wallet }, buildings: [{ type: 'workshop', level: 1, underConstruction: false }] });
