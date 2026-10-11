/** D153.29 ordinary refining transport. Lazy subpath; never a currency rail.
 * Current policy is separate from the immutable recipe in an accepted receipt. */
import { z } from 'zod';
import { PHASE_E_ORDINARY_CRAFTING as POLICY, PHASE_E_ORDINARY_CRAFTING_V2 as POLICY_V2 } from './constants';
import { ORDINARY_CRAFTING_ITEM_IDS, ORDINARY_CRAFTING_ITEM_IDS_V2, ORDINARY_RECIPE_IDS, ORDINARY_RECIPE_IDS_V2, OrdinaryCraftingItemIdSchema,
  OrdinaryCraftingRecipeSnapshotSchema, ordinaryCraftingRecipe } from './phaseEOrdinaryCrafting';
import { PHASE_E_RAW_RESOURCE_IDS, RAW_RESOURCE_STORAGE_MAX, RawResourceQuantitySchema, RawResourceStockSchema } from './phaseEResources';

export const ORDINARY_CRAFTING_FEATURE = { version: 1, receipts: 1 } as const;
export const OrdinaryCraftingUuidSchema = z.uuid().regex(/^[0-9a-f-]+$/);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
// Persistence bounds, not current gameplay tuning. A later cap must not refuse
// an old accepted request before its original replay has been checked.
const Count = z.number().int().positive().max(2_147_483_647);
export const OrdinaryCraftingRequestSchema = z.object({
  idempotencyKey: OrdinaryCraftingUuidSchema, baseId: OrdinaryCraftingUuidSchema,
  recipeId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), recipeVersion: Count, quantity: Count,
}).strict();
export type OrdinaryCraftingRequest = z.infer<typeof OrdinaryCraftingRequestSchema>;
export const ProtectedCraftingStockSchema = z.object({ itemId: OrdinaryCraftingItemIdSchema,
  available: RawResourceQuantitySchema, pendingOutput: RawResourceQuantitySchema,
}).strict().refine(v => {
  try { return BigInt(v.available) + BigInt(v.pendingOutput) <= RAW_RESOURCE_STORAGE_MAX; } catch { return false; }
}, 'Protected available and pending output exceed storage');
const job = { jobId: OrdinaryCraftingUuidSchema, recipe: OrdinaryCraftingRecipeSnapshotSchema,
  startedAt: Timestamp, readyAt: Timestamp };
const coherentTime = (v: { recipe: { durationSec: number }; startedAt: string; readyAt: string }) =>
  Date.parse(v.readyAt) - Date.parse(v.startedAt) === v.recipe.durationSec * 1_000;
export const OrdinaryCraftingPendingJobSchema = z.object(job).strict().refine(coherentTime, 'Crafting deadline differs from original recipe');
export const OrdinaryCraftingReceiptSchema = z.object({ ...job, wallet: Wallet,
  request: OrdinaryCraftingRequestSchema,
}).strict().refine(v => coherentTime(v) && v.jobId === v.request.idempotencyKey
  && v.recipe.recipeId === v.request.recipeId && v.recipe.recipeVersion === v.request.recipeVersion
  && v.recipe.quantity === v.request.quantity, 'Crafting receipt differs from original request');
export type OrdinaryCraftingReceipt = z.infer<typeof OrdinaryCraftingReceiptSchema>;
const envelope = { wallet: Wallet, idempotencyKey: OrdinaryCraftingUuidSchema, serverNow: Timestamp };
export const OrdinaryCraftingEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('unknown'), receipt: z.null(), completion: z.null() }).strict(),
  z.object({ ...envelope, status: z.literal('accepted'), receipt: OrdinaryCraftingReceiptSchema,
    completion: z.object({ completedAt: Timestamp }).strict().nullable() }).strict(),
]).refine(v => v.status === 'unknown' || v.wallet === v.receipt.wallet
  && v.idempotencyKey === v.receipt.request.idempotencyKey
  && (v.completion === null || Date.parse(v.completion.completedAt) >= Date.parse(v.receipt.readyAt)), 'Crafting envelope differs from original actor/key or completion');
export type OrdinaryCraftingEnvelope = z.infer<typeof OrdinaryCraftingEnvelopeSchema>;

/** Per-unit snapshots let clients review a batch using exact integer scaling.
 * Only the server determines and accepts the authoritative conversion. */
export function currentOrdinaryCraftingRecipes(catalogueVersion = 1) {
  const policy = catalogueVersion === 1 ? POLICY.v1 : catalogueVersion === 2 ? POLICY_V2 : null;
  if (!policy) throw new Error('Unsupported ordinary crafting catalogue');
  const ids = catalogueVersion === 1 ? ORDINARY_RECIPE_IDS : ORDINARY_RECIPE_IDS_V2;
  return { recipeVersion: policy.recipeVersion, maxBatch: policy.maxBatch,
    recipes: ids.map(id => ordinaryCraftingRecipe(id, policy.recipeVersion, 1)) };
}
export const OrdinaryCraftingViewQuerySchema = z.object({ baseId: OrdinaryCraftingUuidSchema,
  catalogueVersion: z.literal('2').optional(),
}).strict();
const view = { wallet: Wallet, baseId: OrdinaryCraftingUuidSchema,
  features: z.object({ ordinaryCrafting: z.object({ version: z.literal(1), receipts: z.literal(1) }).strict() }).strict(),
  acceptingJobs: z.boolean(), recipeVersion: Count, maxBatch: Count,
  recipes: z.array(OrdinaryCraftingRecipeSnapshotSchema), rawStock: z.array(RawResourceStockSchema),
  craftingStock: z.array(ProtectedCraftingStockSchema), pendingJobs: z.array(OrdinaryCraftingPendingJobSchema), serverNow: Timestamp,
};
export const OrdinaryCraftingViewSchema = z.union([
  z.object(view).strict(),
  z.object({ ...view, catalogueVersion: z.literal(2), shardsAvailable: RawResourceQuantitySchema }).strict(),
]).refine(v => {
  try {
    const catalogueVersion = 'catalogueVersion' in v ? v.catalogueVersion : 1;
    const current = currentOrdinaryCraftingRecipes(catalogueVersion);
    const ids = catalogueVersion === 1 ? ORDINARY_CRAFTING_ITEM_IDS : ORDINARY_CRAFTING_ITEM_IDS_V2;
    if (v.recipeVersion !== current.recipeVersion || v.maxBatch !== current.maxBatch
      || v.recipes.length !== current.recipes.length
      || !current.recipes.every(recipe => v.recipes.filter(r => r.recipeId === recipe.recipeId && r.quantity === 1 && r.recipeVersion === v.recipeVersion).length === 1)
      || v.rawStock.length !== PHASE_E_RAW_RESOURCE_IDS.length
      || !PHASE_E_RAW_RESOURCE_IDS.every(id => v.rawStock.filter(s => s.resourceId === id).length === 1)
      || v.craftingStock.length !== ids.length
      || !ids.every(id => v.craftingStock.filter(s => s.itemId === id).length === 1)
      || new Set(v.pendingJobs.map(j => j.jobId)).size !== v.pendingJobs.length
      || v.pendingJobs.some(j => Date.parse(j.readyAt) <= Date.parse(v.serverNow)
        || catalogueVersion === 1 && j.recipe.recipeVersion !== POLICY.v1.recipeVersion)) return false;
    return v.craftingStock.every(stock => BigInt(stock.pendingOutput) === v.pendingJobs
      .filter(j => j.recipe.output.itemId === stock.itemId).reduce((total, j) => total + BigInt(j.recipe.output.quantity), 0n));
  } catch { return false; }
}, 'Current ordinary view must describe one complete settled inventory snapshot');
export type OrdinaryCraftingView = z.infer<typeof OrdinaryCraftingViewSchema>;
export function matchOrdinaryCraftingEnvelope(raw: unknown, wallet: string, original: OrdinaryCraftingRequest): OrdinaryCraftingEnvelope {
  const request = OrdinaryCraftingRequestSchema.parse(original), proof = OrdinaryCraftingEnvelopeSchema.parse(raw);
  if (proof.wallet !== wallet || proof.idempotencyKey !== request.idempotencyKey
    || proof.status === 'accepted' && JSON.stringify(proof.receipt.request) !== JSON.stringify(request))
    throw new Error('Ordinary crafting receipt differs from original command');
  return proof;
}
