/** Account-bound cosmetic originals. Appearance identity is not delivery readiness. */
import {z} from 'zod';
import {BoundCosmeticIdSchema,BoundCosmeticRecipeIdSchema,BoundCosmeticRecipeSnapshotSchema} from './phaseEBoundCosmetics';

const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const Wallet=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Hash=z.string().regex(/^[0-9a-f]{64}$/);
const Time=z.iso.datetime({precision:3});
const BlueprintId=z.literal('architect_blueprint_artisan_finishes_v1');

export const BoundCosmeticAppearanceSchema=z.object({
 version:z.literal(1),outputId:BoundCosmeticIdSchema,
 sourceId:z.enum(['artisan-market-t1','artisan-market-t2','artisan-market-t3','artisan-market-t4','auroraWake']),
 sourceManifestSha256:Hash,sourceIndexSha256:Hash,bindingSha256:Hash,
}).strict().refine(value=>value.sourceId===(value.outputId==='aurora_wake'?'auroraWake':
 `artisan-market-t${value.outputId.slice(-1)}`),'Appearance source differs from the selected output');
export type BoundCosmeticAppearance=z.infer<typeof BoundCosmeticAppearanceSchema>;

export const BoundCosmeticRequestSchema=z.object({
 idempotencyKey:Uuid,baseId:Uuid,recipeId:BoundCosmeticRecipeIdSchema,
 recipeVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),appearanceBindingSha256:Hash,
}).strict();
export type BoundCosmeticRequest=z.infer<typeof BoundCosmeticRequestSchema>;

export const BoundCosmeticBlueprintProofSchema=z.object({
 blueprintId:BlueprintId,jobId:Uuid,baseId:Uuid,actorWallet:Wallet,completedAt:Time,
}).strict();
export type BoundCosmeticBlueprintProof=z.infer<typeof BoundCosmeticBlueprintProofSchema>;

export const BoundCosmeticReceiptSchema=z.object({
 wallet:Wallet,jobId:Uuid,request:BoundCosmeticRequestSchema,
 recipe:BoundCosmeticRecipeSnapshotSchema,appearance:BoundCosmeticAppearanceSchema,
 blueprint:BoundCosmeticBlueprintProofSchema,startedAt:Time,readyAt:Time,
}).strict().superRefine((value,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(value.jobId!==value.request.idempotencyKey||value.wallet!==value.blueprint.actorWallet)
  fail('Original actor or request identity differs');
 if(value.recipe.recipeId!==value.request.recipeId||value.recipe.recipeVersion!==value.request.recipeVersion
  ||value.recipe.outputId!==value.appearance.outputId||value.recipe.blueprintId!==value.blueprint.blueprintId
  ||value.appearance.bindingSha256!==value.request.appearanceBindingSha256)fail('Original reviewed terms differ');
 if(Date.parse(value.readyAt)-Date.parse(value.startedAt)!==value.recipe.durationSec*1000
  ||Date.parse(value.blueprint.completedAt)>Date.parse(value.startedAt))fail('Original source or duration differs');
});
export type BoundCosmeticReceipt=z.infer<typeof BoundCosmeticReceiptSchema>;

const Scope={version:z.literal(1),wallet:Wallet,idempotencyKey:Uuid,serverNow:Time};
export const BoundCosmeticEnvelopeSchema=z.discriminatedUnion('status',[
 z.object({...Scope,status:z.literal('unknown'),receipt:z.null(),completion:z.null()}).strict(),
 z.object({...Scope,status:z.literal('accepted'),receipt:BoundCosmeticReceiptSchema,
  completion:z.object({completedAt:Time}).strict().nullable()}).strict(),
]).superRefine((value,ctx)=>{
 if(value.status==='accepted'&&(value.wallet!==value.receipt.wallet||value.idempotencyKey!==value.receipt.jobId
  ||value.completion&&Date.parse(value.completion.completedAt)<Date.parse(value.receipt.readyAt)))
  ctx.addIssue({code:'custom',message:'Original envelope or completion differs'});
});
export type BoundCosmeticEnvelope=z.infer<typeof BoundCosmeticEnvelopeSchema>;

export function matchBoundCosmeticEnvelope(raw:unknown,wallet:string,original:BoundCosmeticRequest):BoundCosmeticEnvelope{
 const request=BoundCosmeticRequestSchema.parse(original),proof=BoundCosmeticEnvelopeSchema.parse(raw);
 if(proof.wallet!==wallet||proof.idempotencyKey!==request.idempotencyKey
  ||proof.status==='accepted'&&JSON.stringify(proof.receipt.request)!==JSON.stringify(request))
  throw Error('Cosmetic receipt differs from original command');
 return proof;
}
