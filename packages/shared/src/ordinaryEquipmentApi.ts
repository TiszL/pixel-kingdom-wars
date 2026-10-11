/** D153.29 ordinary refining transport. Lazy subpath; never a currency rail.
 * Current policy is separate from the immutable recipe in an accepted receipt. */
import { z } from 'zod';
import { PHASE_E_ORDINARY_EQUIPMENT as POLICY } from './constants';
import { OrdinaryEquipmentRecipeSnapshotSchema, ordinaryEquipmentRecipe } from './phaseEOrdinaryEquipment';
import { ORDINARY_CRAFTING_ITEM_IDS } from './phaseEOrdinaryCrafting';
import { ProtectedCraftingStockSchema } from './ordinaryCraftingApi';
import { PHASE_E_RAW_RESOURCE_IDS, RAW_RESOURCE_STORAGE_MAX, RawResourceQuantitySchema, RawResourceStockSchema } from './phaseEResources';

export const ORDINARY_EQUIPMENT_FEATURE = { version: 1, receipts: 1 } as const;
export const OrdinaryEquipmentUuidSchema = z.uuid().regex(/^[0-9a-f-]+$/);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
// Persistence bounds, not current gameplay tuning. A later cap must not refuse
// an old accepted request before its original replay has been checked.
const Count = z.number().int().positive().max(2_147_483_647);
export const OrdinaryEquipmentRequestSchema = z.object({
  idempotencyKey: OrdinaryEquipmentUuidSchema, baseId: OrdinaryEquipmentUuidSchema,
  recipeId: z.enum(['craft_route_compass','craft_survey_lens']), recipeVersion: z.literal(1), quantity: z.literal(1),
}).strict();
export type OrdinaryEquipmentRequest = z.infer<typeof OrdinaryEquipmentRequestSchema>;
export const OrdinaryEquipmentStockSchema=z.object({itemId:z.enum(['route_compass','survey_lens']),available:RawResourceQuantitySchema,reserved:RawResourceQuantitySchema,pendingOutput:RawResourceQuantitySchema}).strict()
 .refine(v=>BigInt(v.available)+BigInt(v.reserved)+BigInt(v.pendingOutput)<=RAW_RESOURCE_STORAGE_MAX);
const job = { jobId: OrdinaryEquipmentUuidSchema, recipe: OrdinaryEquipmentRecipeSnapshotSchema,
  startedAt: Timestamp, readyAt: Timestamp };
const coherentTime = (v: { recipe: { durationSec: number }; startedAt: string; readyAt: string }) =>
  Date.parse(v.readyAt) - Date.parse(v.startedAt) === v.recipe.durationSec * 1_000;
export const OrdinaryEquipmentPendingJobSchema = z.object(job).strict().refine(coherentTime, 'Crafting deadline differs from original recipe');
export const OrdinaryEquipmentReceiptSchema = z.object({ ...job, wallet: Wallet,
  request: OrdinaryEquipmentRequestSchema,
}).strict().refine(v => coherentTime(v) && v.jobId === v.request.idempotencyKey
  && v.recipe.recipeId === v.request.recipeId && v.recipe.recipeVersion === v.request.recipeVersion
  && v.recipe.quantity === v.request.quantity, 'Crafting receipt differs from original request');
export type OrdinaryEquipmentReceipt = z.infer<typeof OrdinaryEquipmentReceiptSchema>;
const envelope = { wallet: Wallet, idempotencyKey: OrdinaryEquipmentUuidSchema, serverNow: Timestamp };
export const OrdinaryEquipmentEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('unknown'), receipt: z.null(), completion: z.null() }).strict(),
  z.object({ ...envelope, status: z.literal('accepted'), receipt: OrdinaryEquipmentReceiptSchema,
    completion: z.object({ completedAt: Timestamp }).strict().nullable() }).strict(),
]).refine(v => v.status === 'unknown' || v.wallet === v.receipt.wallet
  && v.idempotencyKey === v.receipt.request.idempotencyKey
  && (v.completion === null || Date.parse(v.completion.completedAt) >= Date.parse(v.receipt.readyAt)), 'Crafting envelope differs from original actor/key or completion');
export type OrdinaryEquipmentEnvelope = z.infer<typeof OrdinaryEquipmentEnvelopeSchema>;

/** Per-unit snapshots let clients review a batch using exact integer scaling.
 * Only the server determines and accepts the authoritative conversion. */
export function currentOrdinaryEquipmentRecipes(catalogueVersion:1|2=1){return {recipeVersion:POLICY.recipeVersion,maxBatch:POLICY.maxBatch,recipes:catalogueVersion===2?[ordinaryEquipmentRecipe(),ordinaryEquipmentRecipe('craft_survey_lens')]:[ordinaryEquipmentRecipe()]};}
const viewFields={ wallet: Wallet, baseId: OrdinaryEquipmentUuidSchema,
  features: z.object({ ordinaryEquipment: z.object({ version: z.literal(1), receipts: z.literal(1) }).strict() }).strict(),
  acceptingJobs: z.boolean(), recipeVersion: Count, maxBatch: Count,
  recipes: z.array(OrdinaryEquipmentRecipeSnapshotSchema), equipmentStock: z.array(OrdinaryEquipmentStockSchema),
  craftingStock: z.array(ProtectedCraftingStockSchema), pendingJobs: z.array(OrdinaryEquipmentPendingJobSchema), serverNow: Timestamp,
};
function completeView(v:z.infer<ReturnType<typeof viewObject>>,catalogueVersion:1|2){
 try{
  const current=currentOrdinaryEquipmentRecipes(catalogueVersion),ids=current.recipes.map(r=>r.output.itemId);
  return v.recipeVersion===current.recipeVersion&&v.maxBatch===current.maxBatch&&JSON.stringify(v.recipes)===JSON.stringify(current.recipes)
   &&v.equipmentStock.length===ids.length&&ids.every(id=>v.equipmentStock.filter(s=>s.itemId===id).length===1)
   &&v.craftingStock.length===ORDINARY_CRAFTING_ITEM_IDS.length&&ORDINARY_CRAFTING_ITEM_IDS.every(id=>v.craftingStock.filter(s=>s.itemId===id).length===1)
   &&new Set(v.pendingJobs.map(j=>j.jobId)).size===v.pendingJobs.length&&v.pendingJobs.every(j=>Date.parse(j.readyAt)>Date.parse(v.serverNow)&&ids.includes(j.recipe.output.itemId))
   &&v.equipmentStock.every(s=>BigInt(s.pendingOutput)===v.pendingJobs.filter(j=>j.recipe.output.itemId===s.itemId).reduce((n,j)=>n+BigInt(j.recipe.output.quantity),0n));
 }catch{return false;}
}
function viewObject(){return z.object(viewFields).strict();}
export const OrdinaryEquipmentViewSchema=viewObject().refine(v=>completeView(v,1),'Current Compass view must describe one complete settled inventory snapshot');
export const OrdinaryEquipmentViewV2Schema=z.object({...viewFields,catalogueVersion:z.literal(2)}).strict().refine(v=>completeView(v,2),'Current equipment view must describe both complete settled inventories');
export type OrdinaryEquipmentViewV2=z.infer<typeof OrdinaryEquipmentViewV2Schema>;
export type OrdinaryEquipmentView = z.infer<typeof OrdinaryEquipmentViewSchema>;
export function matchOrdinaryEquipmentEnvelope(raw: unknown, wallet: string, original: OrdinaryEquipmentRequest): OrdinaryEquipmentEnvelope {
  const request = OrdinaryEquipmentRequestSchema.parse(original), proof = OrdinaryEquipmentEnvelopeSchema.parse(raw);
  if (proof.wallet !== wallet || proof.idempotencyKey !== request.idempotencyKey
    || proof.status === 'accepted' && JSON.stringify(proof.receipt.request) !== JSON.stringify(request))
    throw new Error('Ordinary crafting receipt differs from original command');
  return proof;
}
