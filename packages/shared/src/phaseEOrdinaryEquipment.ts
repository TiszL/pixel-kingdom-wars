/** D153.188 ordinary durable equipment; lazy subpath, no bound/currency input. */
import {z} from 'zod';
import {PHASE_E_POLICY,PHASE_E_ORDINARY_EQUIPMENT as C,PHASE_E_SURVEY_LENS as L} from './constants';
import {RawResourceQuantitySchema,PositiveRawResourceQuantitySchema,PhaseERawResourceIdSchema} from './phaseEResources';
import {splitResourceEarnings} from './phaseEResourceTax';
const CompassSelection=z.object({itemId:z.literal('route_compass'),policyVersion:z.literal(1)}).strict();
const LensSelection=z.object({itemId:z.literal('survey_lens'),policyVersion:z.literal(1),resourceId:PhaseERawResourceIdSchema}).strict();
export const EquipmentFittingSchema=z.discriminatedUnion('itemId',[CompassSelection,LensSelection]);
export type EquipmentFitting=z.infer<typeof EquipmentFittingSchema>;
const originalTerms={originalDurationSec:z.number().int().positive().safe(),originalGrossQuantity:PositiveRawResourceQuantitySchema,
 originalNetQuantity:RawResourceQuantitySchema,originalIslandPoolQuantity:RawResourceQuantitySchema};
export const EquipmentFittingSnapshotSchema=z.discriminatedUnion('itemId',[CompassSelection.extend(originalTerms).strict(),LensSelection.extend(originalTerms).strict()])
 .refine(v=>BigInt(v.originalNetQuantity)+BigInt(v.originalIslandPoolQuantity)===BigInt(v.originalGrossQuantity));
export type EquipmentFittingSnapshot=z.infer<typeof EquipmentFittingSnapshotSchema>;
export const EquipmentSecondaryOutputSchema=z.object({resourceId:PhaseERawResourceIdSchema,grossQuantity:PositiveRawResourceQuantitySchema,
 netQuantity:PositiveRawResourceQuantitySchema,islandPoolQuantity:PositiveRawResourceQuantitySchema}).strict()
 .refine(v=>BigInt(v.netQuantity)+BigInt(v.islandPoolQuantity)===BigInt(v.grossQuantity));
export type EquipmentSecondaryOutput=z.infer<typeof EquipmentSecondaryOutputSchema>;
type Terms={durationSec:number;grossQuantity:string;netQuantity:string;islandPoolQuantity:string;resourceId?:string|undefined};
type Fitted={fitting?:EquipmentFittingSnapshot|undefined;secondaryOutput?:EquipmentSecondaryOutput|undefined};
export const EquipmentFittingQueryFields={fitting:z.enum(['route_compass','survey_lens']).optional(),resourceId:PhaseERawResourceIdSchema.optional()};
export function equipmentFittingQuery(value:{fitting?:string|undefined;resourceId?:string|undefined}):EquipmentFitting|undefined{
 if(!value.fitting){if(value.resourceId!==undefined)throw Error('A selected resource requires Survey Lens');return undefined;}
 return EquipmentFittingSchema.parse({itemId:value.fitting,policyVersion:1,...value.resourceId!==undefined?{resourceId:value.resourceId}:{}});
}
export function fittingSelection(value:{fitting?:EquipmentFittingSnapshot|undefined}):{fitting?:EquipmentFitting|undefined}{
 return value.fitting?{fitting:{itemId:value.fitting.itemId,policyVersion:value.fitting.policyVersion,...value.fitting.itemId==='survey_lens'?{resourceId:value.fitting.resourceId}:{}} as EquipmentFitting}:{};
}
export function applyEquipmentFitting<T extends Terms>(route:T,selection?:EquipmentFitting):T&Fitted{
 if(selection===undefined)return route;
 const fitting=EquipmentFittingSchema.parse(selection);
 let a=BigInt(PHASE_E_POLICY.basisPoints),b=BigInt(PHASE_E_POLICY.taxes.resources.islandPoolBps);while(b!==0n){const r=a%b;a=b;b=r;}
 const quantum=BigInt(PHASE_E_POLICY.basisPoints)/a,gross=BigInt(route.grossQuantity)*BigInt(C.cargoNumerator)/BigInt(C.cargoDenominator)/quantum*quantum;
 if(fitting.itemId==='survey_lens'){
  if(!route.resourceId||route.resourceId===fitting.resourceId)throw Error('Survey Lens requires a different common resource');
  const original=BigInt(route.grossQuantity),secondary=original*BigInt(L.secondaryNumerator)/BigInt(L.secondaryDenominator)/quantum*quantum,primary=original-secondary;
  const first=splitResourceEarnings(primary,0n),second=splitResourceEarnings(secondary,0n);
  if(secondary<=0n||primary<=0n||first.nextCarry!==0n||second.nextCarry!==0n||first.net+second.net!==BigInt(route.netQuantity)||first.tax+second.tax!==BigInt(route.islandPoolQuantity))throw Error('Invalid Survey Lens output budget');
  return {...route,grossQuantity:primary.toString(),netQuantity:first.net.toString(),islandPoolQuantity:first.tax.toString(),
   secondaryOutput:{resourceId:fitting.resourceId,grossQuantity:secondary.toString(),netQuantity:second.net.toString(),islandPoolQuantity:second.tax.toString()},
   fitting:{...fitting,originalDurationSec:route.durationSec,originalGrossQuantity:route.grossQuantity,originalNetQuantity:route.netQuantity,originalIslandPoolQuantity:route.islandPoolQuantity}};
 }
 const split=splitResourceEarnings(gross,0n),duration=(BigInt(route.durationSec)*BigInt(C.durationNumerator)+BigInt(C.durationDenominator)-1n)/BigInt(C.durationDenominator);
 if(gross<=0n||duration<=0n||duration>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid equipment route terms');
 return {...route,durationSec:Number(duration),grossQuantity:gross.toString(),netQuantity:split.net.toString(),islandPoolQuantity:split.tax.toString(),
  fitting:{...fitting,originalDurationSec:route.durationSec,originalGrossQuantity:route.grossQuantity,originalNetQuantity:route.netQuantity,originalIslandPoolQuantity:route.islandPoolQuantity}};
}
export function withoutEquipmentFitting<T extends Terms&Fitted>(route:T){
 const {fitting,secondaryOutput,...rest}=route;
 return fitting?{...rest,durationSec:fitting.originalDurationSec,grossQuantity:fitting.originalGrossQuantity,netQuantity:fitting.originalNetQuantity,islandPoolQuantity:fitting.originalIslandPoolQuantity}:rest;
}
export function equipmentFittingMatches(route:Terms&Fitted):boolean{
 if(!route.fitting)return route.secondaryOutput===undefined;
 try{const original=withoutEquipmentFitting(route),expected=applyEquipmentFitting(original,fittingSelection(route).fitting);
  return JSON.stringify(route.secondaryOutput)===JSON.stringify(expected.secondaryOutput)&&['durationSec','grossQuantity','netQuantity','islandPoolQuantity'].every(k=>route[k as keyof Terms]===expected[k as keyof Terms]);}catch{return false;}
}
export function ordinaryEquipmentRecipe(recipeId:'craft_route_compass'|'craft_survey_lens'='craft_route_compass'){
 if(recipeId==='craft_survey_lens')return {recipeVersion:L.recipeVersion,recipeId,quantity:L.maxBatch,durationSec:L.recipe.durationSec,
 inputs:[{kind:'crafting' as const,itemId:'prismstone_lens' as const,quantity:String(L.recipe.prismstoneLens)},{kind:'crafting' as const,itemId:'frostglass' as const,quantity:String(L.recipe.frostglass)}],
 output:{itemId:'survey_lens' as const,quantity:String(L.recipe.outputQuantity)}};
 return {recipeVersion:C.recipeVersion,recipeId:'craft_route_compass' as const,quantity:C.maxBatch,durationSec:C.recipe.durationSec,
 inputs:[{kind:'crafting' as const,itemId:'prismstone_lens' as const,quantity:String(C.recipe.prismstoneLens)},
 {kind:'crafting' as const,itemId:'crownsteel' as const,quantity:String(C.recipe.crownsteel)}],output:{itemId:'route_compass' as const,quantity:String(C.recipe.outputQuantity)}};
}
export const OrdinaryEquipmentRecipeSnapshotSchema=z.object({recipeVersion:z.literal(1),recipeId:z.enum(['craft_route_compass','craft_survey_lens']),quantity:z.literal(1),durationSec:z.number().int().positive(),
 inputs:z.array(z.object({kind:z.literal('crafting'),itemId:z.enum(['prismstone_lens','crownsteel','frostglass']),quantity:PositiveRawResourceQuantitySchema}).strict()).length(2),
 output:z.object({itemId:z.enum(['route_compass','survey_lens']),quantity:PositiveRawResourceQuantitySchema}).strict()}).strict().refine(v=>JSON.stringify(v)===JSON.stringify(ordinaryEquipmentRecipe(v.recipeId)),'Equipment recipe differs from immutable policy');
