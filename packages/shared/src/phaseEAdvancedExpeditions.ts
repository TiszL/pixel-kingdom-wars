import {EquipmentSecondaryOutputSchema,EquipmentFittingSnapshotSchema,applyEquipmentFitting,fittingSelection} from './phaseEOrdinaryEquipment';
/** D-153.133 pure advanced profiles, subpath-only. Selecting a HOME/paid route
 * grants no custody, permit, fleet, supply, term or dispatch capability. API
 * admission must bind the real installation and its current lifecycle, consume
 * provisions atomically, and retain independently verified access/term evidence.
 * Historical v1 validation never follows the current policy pointer. */
import {z} from 'zod';
import {PHASE_E_ADVANCED_EXPEDITIONS as C,PHASE_E_PAID_STARTER_ROUTES,PHASE_E_ORDINARY_ROUTES as O} from './constants';
import {OrdinaryRouteIdSchema,ordinaryRoute} from './ordinaryRoutes';
import {REALM_IDS} from './baseVisual';
import {StarterHomeRouteIdSchema} from './phaseEExpeditions';
import {PaidStarterRouteIdSchema} from './paidStarterExpeditions';
import {PhaseEVehicleFamilySchema,PhaseEVehicleTierSchema} from './phaseEVehicles';
import {PHASE_E_RAW_RESOURCE_IDS,PHASE_E_RAW_RESOURCES,PhaseERawResourceIdSchema,PositiveRawResourceQuantitySchema,RawResourceQuantitySchema} from './phaseEResources';

export const AdvancedExpeditionRouteIdSchema=z.enum([...StarterHomeRouteIdSchema.options,...PaidStarterRouteIdSchema.options,...OrdinaryRouteIdSchema.options]);
export type AdvancedExpeditionRouteId=z.infer<typeof AdvancedExpeditionRouteIdSchema>;
export const AdvancedExpeditionSelectionSchema=z.object({family:PhaseEVehicleFamilySchema,tier:PhaseEVehicleTierSchema,
  homeRealmId:z.enum(REALM_IDS),routeId:AdvancedExpeditionRouteIdSchema}).strict();
export type AdvancedExpeditionSelection=z.infer<typeof AdvancedExpeditionSelectionSchema>;
const PositiveQuantity=z.string().max(19).pipe(PositiveRawResourceQuantitySchema);
const Quantity=z.string().max(19).pipe(RawResourceQuantitySchema);
export const AdvancedExpeditionSupplySchema=z.object({resourceId:PhaseERawResourceIdSchema,quantity:PositiveQuantity}).strict();
export type AdvancedExpeditionSupply=z.infer<typeof AdvancedExpeditionSupplySchema>;

function originalSnapshot(input:AdvancedExpeditionSelection,policyVersion:number){
  if(policyVersion!==C.v1.policyVersion&&policyVersion!==O.policyVersion)throw new Error('Unsupported advanced expedition policy');
  const {family,tier,homeRealmId,routeId}=input,policy=C.v1,profile=policy.families[family];
  const named=policyVersion===O.policyVersion?ordinaryRoute(routeId):null;
  if(named&&tier<named.grade)throw new Error('Vehicle tier is below the route grade');
  const factor=named?O.gradeFactors[named.grade]:1;
  const paid=PaidStarterRouteIdSchema.safeParse(routeId);
  if(!named&&!paid.success&&!profile.homeRoutes.some(id=>id===routeId))throw new Error('Vehicle family cannot use this HOME route');
  // Reuse existing route schemas and identity maps, never a current preview:
  // its price/tax validation could otherwise invalidate historical v1 evidence.
  const realmId=named?named.realmId:paid.success?PHASE_E_PAID_STARTER_ROUTES.routes[paid.data]:homeRealmId;
  const resourceId=PHASE_E_RAW_RESOURCE_IDS.find(id=>PHASE_E_RAW_RESOURCES[id].realmId===realmId);
  if(!resourceId)throw new Error('Advanced destination lacks an existing raw resource');
  const alternate=!named&&family==='survey_balloon'&&!paid.success&&(routeId==='introduction'||routeId==='long_survey')
    ?policy.balloonAlternateHome[routeId]:undefined;
  const durationSec=(alternate?.durationSec??profile.durationSecByTier[tier-1]!)*factor;
  const gross=BigInt(alternate?.grossRaw??profile.grossRawByTier[tier-1]!)*BigInt(factor);
  const numerator=gross*BigInt(policy.islandPoolBps),denominator=BigInt(policy.basisPoints);
  if(numerator%denominator!==0n)throw new Error('Advanced policy requires exact whole-resource tax');
  const tax=numerator/denominator;
  const supplies=profile.supplies.map(s=>Object.freeze({resourceId:s.resourceId,quantity:String(s.quantity*factor)}))
    .sort((a,b)=>a.resourceId<b.resourceId?-1:a.resourceId>b.resourceId?1:0);
  return Object.freeze({policyVersion:policyVersion as 1|2,family,tier,homeRealmId,routeId,realmId,resourceId,
    accessRequirement:(named?realmId!==homeRealmId:paid.success)?'paid_realm' as const:'home' as const,durationSec,grossQuantity:gross.toString(),
    netQuantity:(gross-tax).toString(),islandPoolQuantity:tax.toString(),supplies:Object.freeze(supplies)});
}

/** Known versions stay immutable; omission preserves v1 for existing clients.
 * A preview verifies no external authority and reads no inventory. */
export function advancedExpeditionPreview(selection:unknown,policyVersion:number=C.v1.policyVersion){
  return originalSnapshot(AdvancedExpeditionSelectionSchema.parse(selection),policyVersion);
}

/** Complete copied economics for known immutable versions, not a provider
 * observation. The API must separately bind original home/installation evidence. */
export const AdvancedExpeditionSnapshotSchema=AdvancedExpeditionSelectionSchema.extend({
  fitting:EquipmentFittingSnapshotSchema.optional(),secondaryOutput:EquipmentSecondaryOutputSchema.optional(),policyVersion:z.union([z.literal(C.v1.policyVersion),z.literal(O.policyVersion)]),realmId:z.enum(REALM_IDS),resourceId:PhaseERawResourceIdSchema,
  accessRequirement:z.enum(['home','paid_realm']),durationSec:z.number().int().positive().safe(),
  grossQuantity:PositiveQuantity,netQuantity:Quantity,islandPoolQuantity:Quantity,
  supplies:z.array(AdvancedExpeditionSupplySchema).min(1).max(PHASE_E_RAW_RESOURCE_IDS.length),
}).strict().refine(value=>{
  try{
    const expected=applyEquipmentFitting(originalSnapshot(value,value.policyVersion),fittingSelection(value).fitting);
    if(JSON.stringify(value.fitting)!==JSON.stringify(expected.fitting)||JSON.stringify(value.secondaryOutput)!==JSON.stringify(expected.secondaryOutput))return false;
    return value.realmId===expected.realmId&&value.resourceId===expected.resourceId&&value.accessRequirement===expected.accessRequirement
      &&value.durationSec===expected.durationSec&&value.grossQuantity===expected.grossQuantity&&value.netQuantity===expected.netQuantity
      &&value.islandPoolQuantity===expected.islandPoolQuantity&&value.supplies.length===expected.supplies.length
      &&value.supplies.every((s,i)=>s.resourceId===expected.supplies[i]!.resourceId&&s.quantity===expected.supplies[i]!.quantity);
  }catch{return false;}
},'Snapshot differs from its original versioned vehicle/route/provision policy')
  .transform(value=>Object.freeze({...value,supplies:Object.freeze(value.supplies.map(s=>Object.freeze(s)))}));
export type AdvancedExpeditionSnapshot=z.infer<typeof AdvancedExpeditionSnapshotSchema>;
export const AdvancedExpeditionPreviewSchema=AdvancedExpeditionSnapshotSchema;
