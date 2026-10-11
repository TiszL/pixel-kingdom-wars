/** Private Workshop composition wire. Recipe identity never admits delivery. */
import {z} from 'zod';
import {PHASE_E_ORDINARY_CRAFTING} from './constants';
import {BoundCosmeticAppearanceSchema,BoundCosmeticBlueprintProofSchema,BoundCosmeticEnvelopeSchema} from './boundCosmeticApi';
import {BoundCosmeticBaseReadSchema,matchBoundCosmeticBaseRead} from './boundCosmeticVisual';
import {BOUND_COSMETIC_IDS,BoundCosmeticRecipeIdSchema,BoundCosmeticRecipeSnapshotSchema} from './phaseEBoundCosmetics';
import {OrdinaryCraftingRecipeSnapshotSchema,ORDINARY_CRAFTING_ITEM_IDS_V2} from './phaseEOrdinaryCrafting';
import {OrdinaryEquipmentRecipeSnapshotSchema} from './phaseEOrdinaryEquipment';
import {ProtectedCraftingStockSchema} from './ordinaryCraftingApi';
const Uuid=z.uuid().regex(/^[0-9a-f-]+$/),Wallet=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),Time=z.iso.datetime({precision:3});
const Revision=z.string().regex(/^(0|[1-9][0-9]*)$/).max(19).refine(value=>BigInt(value)<=9223372036854775807n);
export const BOUND_COSMETIC_AWNING_RECIPE_IDS=Object.freeze(BoundCosmeticRecipeIdSchema.exclude(['craft_aurora_wake_v1']).options);
export const BoundCosmeticWorkshopQuerySchema=z.object({baseId:Uuid.optional()}).strict();
export const BoundCosmeticPreferenceRequestSchema=z.object({baseId:Uuid,enabled:z.boolean(),expectedRevision:Revision.refine(value=>BigInt(value)<9223372036854775807n)}).strict();
export type BoundCosmeticPreferenceRequest=z.infer<typeof BoundCosmeticPreferenceRequestSchema>;
export const BoundCosmeticPreferenceResponseSchema=z.object({baseId:Uuid,enabled:z.boolean(),revision:Revision.refine(value=>BigInt(value)>0n),visual:BoundCosmeticBaseReadSchema}).strict();
export type BoundCosmeticPreferenceResponse=z.infer<typeof BoundCosmeticPreferenceResponseSchema>;
export const BoundCosmeticBlueprintEligibilitySchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('eligible'),proof:BoundCosmeticBlueprintProofSchema}).strict(),
 z.object({state:z.literal('not-earned'),proof:z.null()}).strict(),
 z.object({state:z.literal('unavailable'),reason:z.enum(['NOT_CONFIGURED','SOURCE_UNAVAILABLE','SOURCE_CONFLICT']),proof:z.null()}).strict(),
]);
const Facility=z.object({buildingId:Uuid,level:z.number().int().positive().safe(),completedAt:Time}).strict();
const Job={jobId:Uuid,startedAt:Time,readyAt:Time};
export const BoundCosmeticWorkshopQueueSchema=z.discriminatedUnion('kind',[
 z.object({...Job,kind:z.literal('ordinary'),recipe:OrdinaryCraftingRecipeSnapshotSchema}).strict(),
 z.object({...Job,kind:z.literal('equipment'),recipe:OrdinaryEquipmentRecipeSnapshotSchema}).strict(),
 z.object({...Job,kind:z.literal('cosmetic'),recipe:BoundCosmeticRecipeSnapshotSchema}).strict(),
]).refine(value=>Date.parse(value.readyAt)-Date.parse(value.startedAt)===value.recipe.durationSec*1000,'Workshop deadline differs from original');
export const BoundCosmeticWorkshopSelectedBaseSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('unavailable'),baseId:Uuid,reason:z.enum(['BASE_NOT_OWNED','BASE_ID_REQUIRED','DEED_AUTHORITY_UNAVAILABLE','DEED_OWNERSHIP_CHANGED'])}).strict(),
 z.object({state:z.literal('available'),baseId:Uuid,craftingStock:z.array(ProtectedCraftingStockSchema),
  workshops:z.array(Facility),markets:z.array(Facility),queue:z.array(BoundCosmeticWorkshopQueueSchema).max(PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase),
  preference:z.object({enabled:z.boolean(),revision:Revision}).strict(),visual:BoundCosmeticBaseReadSchema}).strict(),
]);
export const BoundCosmeticWorkshopViewSchema=z.object({
 version:z.literal(1),wallet:Wallet,serverNow:Time,acceptingJobs:z.boolean(),applicationReady:z.boolean(),blueprint:BoundCosmeticBlueprintEligibilitySchema,
 recipes:z.array(z.object({recipe:BoundCosmeticRecipeSnapshotSchema,appearance:BoundCosmeticAppearanceSchema}).strict()),
 originals:z.array(BoundCosmeticEnvelopeSchema).max(BOUND_COSMETIC_IDS.length),selectedBase:BoundCosmeticWorkshopSelectedBaseSchema.nullable(),
}).strict().superRefine((value,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(value.acceptingJobs&&!value.applicationReady)fail('Crafting cannot precede application admission');
 if(value.blueprint.state==='eligible'&&(value.blueprint.proof.actorWallet!==value.wallet
  ||Date.parse(value.blueprint.proof.completedAt)>Date.parse(value.serverNow)))fail('Blueprint account or observation time differs');
 if(value.recipes.length!==BOUND_COSMETIC_AWNING_RECIPE_IDS.length||BOUND_COSMETIC_AWNING_RECIPE_IDS.some(id=>value.recipes.filter(r=>r.recipe.recipeId===id).length!==1)
  ||value.recipes.some((r,i)=>r.recipe.recipeId!==BOUND_COSMETIC_AWNING_RECIPE_IDS[i]||r.recipe.outputId!==r.appearance.outputId))fail('Awning catalogue is incomplete or mismatched');
 const outputs:string[]=[];
 for(const original of value.originals){
  if(original.status!=='accepted'||original.wallet!==value.wallet)fail('Original belongs to another account or is not accepted');
  else{
   outputs.push(original.receipt.recipe.outputId);
   if(Date.parse(original.serverNow)>Date.parse(value.serverNow)||Date.parse(original.receipt.startedAt)>Date.parse(original.serverNow)
    ||original.completion&&Date.parse(original.completion.completedAt)>Date.parse(original.serverNow))fail('Original observation time differs');
  }
 }
 if(new Set(outputs).size!==outputs.length||new Set(value.originals.map(o=>o.idempotencyKey)).size!==value.originals.length)fail('Duplicate account original');
 const base=value.selectedBase;if(base?.state==='available'){
  if(base.craftingStock.length!==ORDINARY_CRAFTING_ITEM_IDS_V2.length||ORDINARY_CRAFTING_ITEM_IDS_V2.some(id=>base.craftingStock.filter(s=>s.itemId===id).length!==1))fail('Protected stock is incomplete');
  const facilities=[...base.workshops,...base.markets];
  if(new Set(facilities.map(f=>f.buildingId)).size!==facilities.length||facilities.some(f=>Date.parse(f.completedAt)>Date.parse(value.serverNow)))fail('Completed facility identity/time differs');
  if(base.queue.some(j=>Date.parse(j.readyAt)<=Date.parse(value.serverNow)))fail('Due Workshop obligation was not settled');
  if(base.preference.revision==='0'&&base.preference.enabled)fail('An absent preference cannot be enabled');
  try{matchBoundCosmeticBaseRead(base.visual,base.markets.map(f=>({id:f.buildingId,type:'market',level:f.level,underConstruction:false})));}
  catch{fail('Applied Awning differs from completed Market facts');}
 }
});
export type BoundCosmeticWorkshopView=z.infer<typeof BoundCosmeticWorkshopViewSchema>;
export type BoundCosmeticWorkshopSelectedBase=z.infer<typeof BoundCosmeticWorkshopSelectedBaseSchema>;
