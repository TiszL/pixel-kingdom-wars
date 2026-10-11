/** Explicit Aurora opt-in. The four-Awning Workshop v1 and original receipts remain unchanged. */
import {z} from 'zod';
import {BoundCosmeticAppearanceSchema,BoundCosmeticEnvelopeSchema} from './boundCosmeticApi';
import {BoundCosmeticRecipeSnapshotSchema} from './phaseEBoundCosmetics';
import {BoundCosmeticWorkshopSelectedBaseSchema,BoundCosmeticBlueprintEligibilitySchema} from './boundCosmeticWorkshopApi';
import {BoundCosmeticWakeReadSchema,BoundCosmeticWakePreferenceRequestSchema,BoundCosmeticWakePreferenceResponseSchema} from './boundCosmeticWake';
import {ORDINARY_CRAFTING_ITEM_IDS_V2} from './phaseEOrdinaryCrafting';
import {PhaseEVehicleMintIdentitySchema} from './phaseEVehicles';
const Time=z.iso.datetime({precision:3}).refine(v=>new Date(v).toISOString()===v);
const available=BoundCosmeticWorkshopSelectedBaseSchema.options[1];
export const BoundCosmeticWakeWorkshopQuerySchema=z.object({baseId:z.uuid().regex(/^[0-9a-f-]+$/).optional()}).strict();
export const BoundCosmeticWakeWorkshopSelectedBaseSchema=z.discriminatedUnion('state',[
 BoundCosmeticWorkshopSelectedBaseSchema.options[0],
 available.pick({state:true,baseId:true,craftingStock:true,workshops:true,queue:true}).extend({lodges:available.shape.workshops}).strict(),
]);
export type BoundCosmeticWakeWorkshopSelectedBase=z.infer<typeof BoundCosmeticWakeWorkshopSelectedBaseSchema>;
export const BoundCosmeticWakePreferenceSnapshotSchema=z.object({enabled:z.boolean(),
 revision:z.union([z.literal('0'),BoundCosmeticWakePreferenceResponseSchema.shape.revision]),visual:BoundCosmeticWakeReadSchema,
}).strict().refine(v=>v.revision!=='0'||!v.enabled,'An absent preference cannot be enabled')
 .refine(v=>v.visual.state!=='available'||(v.visual.visual.wake!==null)===v.enabled,'Preference and available selection differ');
export const BoundCosmeticWakeWorkshopViewSchema=z.object({version:z.literal(1),wallet:PhaseEVehicleMintIdentitySchema.shape.assetId,
 serverNow:Time,applicationReady:z.boolean(),acceptingJobs:z.boolean(),blueprint:BoundCosmeticBlueprintEligibilitySchema,
 recipe:z.object({recipe:BoundCosmeticRecipeSnapshotSchema.refine(r=>r.recipeId==='craft_aurora_wake_v1'),
  appearance:BoundCosmeticAppearanceSchema.refine(a=>a.outputId==='aurora_wake')}).strict(),
 original:BoundCosmeticEnvelopeSchema.nullable(),preference:BoundCosmeticWakePreferenceSnapshotSchema,
 selectedBase:BoundCosmeticWakeWorkshopSelectedBaseSchema.nullable(),
}).strict().superRefine((v,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(v.acceptingJobs&&!v.applicationReady)fail('New crafting requires application admission');
 if(v.blueprint.state==='eligible'&&(v.blueprint.proof.actorWallet!==v.wallet||Date.parse(v.blueprint.proof.completedAt)>Date.parse(v.serverNow)))fail('Blueprint account/time differs');
 const o=v.original;
 if(o&&(o.status!=='accepted'||o.wallet!==v.wallet||o.receipt.recipe.outputId!=='aurora_wake'
  ||Date.parse(o.serverNow)>Date.parse(v.serverNow)||Date.parse(o.receipt.startedAt)>Date.parse(o.serverNow)
  ||o.completion&&Date.parse(o.completion.completedAt)>Date.parse(o.serverNow)))fail('Original account/output/time differs');
 if(v.preference.visual.state==='available'&&v.preference.visual.visual.wake!==null
  &&(!o||o.status!=='accepted'||!o.completion||JSON.stringify(o.receipt.appearance)!==JSON.stringify(v.preference.visual.visual.wake)))fail('Selected Wake lacks its completed original');
 const b=v.selectedBase;if(b?.state==='available'){
  if(b.craftingStock.length!==ORDINARY_CRAFTING_ITEM_IDS_V2.length||ORDINARY_CRAFTING_ITEM_IDS_V2.some(id=>b.craftingStock.filter(s=>s.itemId===id).length!==1))fail('Protected stock is incomplete');
  const facilities=[...b.workshops,...b.lodges];if(new Set(facilities.map(f=>f.buildingId)).size!==facilities.length||facilities.some(f=>Date.parse(f.completedAt)>Date.parse(v.serverNow)))fail('Completed facility identity/time differs');
  if(b.queue.some(j=>Date.parse(j.readyAt)<=Date.parse(v.serverNow)))fail('Due Workshop obligation was not settled');
 }
});
export type BoundCosmeticWakeWorkshopView=z.infer<typeof BoundCosmeticWakeWorkshopViewSchema>;
export {BoundCosmeticWakePreferenceRequestSchema,BoundCosmeticWakePreferenceResponseSchema};
