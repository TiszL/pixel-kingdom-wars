import {it,expect} from 'vitest';
import {applyEquipmentFitting,equipmentFittingMatches,ordinaryEquipmentRecipe,withoutEquipmentFitting} from './phaseEOrdinaryEquipment';
import {PHASE_E_ADVANCED_EXPEDITIONS as A,PHASE_E_SURVEY_LENS as L} from './constants';
import {PHASE_E_RAW_RESOURCE_IDS} from './phaseEResources';
import {REALM_IDS} from './baseVisual';
import {StarterRouteIdSchema,starterRoutePreview} from './phaseEExpeditions';
import {PaidStarterRouteIdSchema,paidStarterRoutePreview,PaidStarterRoutePreviewSchema} from './paidStarterExpeditions';
import {OrdinaryRouteIdSchema} from './ordinaryRoutes';
import {advancedExpeditionPreview,AdvancedExpeditionSnapshotSchema} from './phaseEAdvancedExpeditions';
import {StarterExpeditionViewSchema,StarterExpeditionRouteSnapshotSchema,StarterExpeditionEnvelopeSchema} from './starterExpeditionApi';
import {AdvancedExpeditionEnvelopeSchema} from './advancedExpeditionApi';
import {OrdinaryEquipmentViewSchema,OrdinaryEquipmentViewV2Schema,OrdinaryEquipmentEnvelopeSchema} from './ordinaryEquipmentApi';
import {VehicleRoutesSchema} from './vehicleClientApi';
import fixture from '../testFixtures/surveyLens.json';
import old from '../testFixtures/ordinaryEquipment.json';
const fitting=(resourceId:typeof PHASE_E_RAW_RESOURCE_IDS[number])=>({itemId:'survey_lens',policyVersion:1,resourceId} as const);
function verify<T extends Parameters<typeof applyEquipmentFitting>[0]>(route:T,resourceId:typeof PHASE_E_RAW_RESOURCE_IDS[number]){
 if(route.resourceId===resourceId||BigInt(route.grossQuantity)<25n){expect(()=>applyEquipmentFitting(route,fitting(resourceId))).toThrow();return null;}
 const result=applyEquipmentFitting(route,fitting(resourceId)),part=result.secondaryOutput!;
 expect(withoutEquipmentFitting(result)).toEqual(route);expect(result.durationSec).toBe(route.durationSec);expect(equipmentFittingMatches(result)).toBe(true);
 for(const field of ['grossQuantity','netQuantity','islandPoolQuantity'] as const)expect(BigInt(result[field])+BigInt(part[field])).toBe(BigInt(route[field]));
 expect(BigInt(part.grossQuantity)).toBe(BigInt(route.grossQuantity)/5n/5n*5n);expect(BigInt(part.islandPoolQuantity)*5n).toBe(BigInt(part.grossQuantity));
 expect(equipmentFittingMatches({...result,secondaryOutput:{...part,netQuantity:(BigInt(part.netQuantity)+1n).toString()}})).toBe(false);
 return result;
}
it.each(REALM_IDS)('preserves total/time/tax for every %s starter route and all eight choices',realm=>{
 for(const id of StarterRouteIdSchema.options)for(const resource of PHASE_E_RAW_RESOURCE_IDS){const v=verify(starterRoutePreview(realm,id),resource);if(v)expect(StarterExpeditionRouteSnapshotSchema.parse(v)).toEqual(v);}
});
it.each(PaidStarterRouteIdSchema.options)('does not alter %s permit access or total cargo',id=>{
 const r=paidStarterRoutePreview(id);for(const resource of PHASE_E_RAW_RESOURCE_IDS){const v=verify(r,resource);if(v){expect(PaidStarterRoutePreviewSchema.parse(v)).toEqual(v);expect(v.access).toEqual(r.access);}}
});
for(const family of Object.keys(A.v1.families) as (keyof typeof A.v1.families)[])it.each([1,2,3,4] as const)(`${family} tier%s preserves every supported named route and supplies`,tier=>{
 for(const routeId of OrdinaryRouteIdSchema.options){let route;try{route=advancedExpeditionPreview({family,tier,homeRealmId:'crownlands',routeId},2);}catch{continue;}
  for(const resource of PHASE_E_RAW_RESOURCE_IDS){const v=verify(route,resource);if(v){expect(AdvancedExpeditionSnapshotSchema.parse(v)).toEqual(v);expect(v.supplies).toEqual(route.supplies);expect(v.accessRequirement).toBe(route.accessRequirement);}}
 }
});
it('preserves Compass v1 fixture and exactly freezes Lens v2 recipe/view/recovery proofs',()=>{
 expect(fixture.policy.surveyLens).toEqual(L);expect(ordinaryEquipmentRecipe('craft_survey_lens')).toEqual(fixture.view.recipes[1]);
 expect(OrdinaryEquipmentViewSchema.parse(old.view)).toEqual(old.view);expect(OrdinaryEquipmentViewSchema.safeParse(fixture.view).success).toBe(false);
 expect(OrdinaryEquipmentViewV2Schema.parse(fixture.view)).toEqual(fixture.view);expect(OrdinaryEquipmentEnvelopeSchema.parse(fixture.envelope)).toEqual(fixture.envelope);
 expect(StarterExpeditionViewSchema.parse(fixture.starterView)).toEqual(fixture.starterView);expect(VehicleRoutesSchema.parse(fixture.advancedView)).toEqual(fixture.advancedView);
 for(const e of [fixture.starterEnvelope,fixture.starterReturnedEnvelope])expect(StarterExpeditionEnvelopeSchema.parse(e)).toEqual(e);
 for(const e of [fixture.advancedEnvelope,fixture.advancedReturnedEnvelope])expect(AdvancedExpeditionEnvelopeSchema.parse(e)).toEqual(e);
 expect(StarterExpeditionEnvelopeSchema.safeParse({...fixture.starterReturnedEnvelope,return:{...fixture.starterReturnedEnvelope.return,secondaryOutput:undefined}}).success).toBe(false);
});
it('refuses companions without Lens, multiple fitting slots and zero-cargo evasions',()=>{
 const r=starterRoutePreview('crownlands','coastal_survey'),v=applyEquipmentFitting(r,fitting('rough_prism'));
 expect(equipmentFittingMatches({...r,secondaryOutput:v.secondaryOutput})).toBe(false);
 expect(StarterExpeditionRouteSnapshotSchema.safeParse({...v,fitting:{...v.fitting,extra:'route_compass'}}).success).toBe(false);
 expect(equipmentFittingMatches({...v,secondaryOutput:{...v.secondaryOutput!,grossQuantity:'0',netQuantity:'0',islandPoolQuantity:'0'}})).toBe(false);
});
