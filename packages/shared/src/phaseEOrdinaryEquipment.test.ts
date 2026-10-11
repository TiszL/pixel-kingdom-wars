import {describe,it,expect} from 'vitest';
import {applyEquipmentFitting,equipmentFittingMatches,ordinaryEquipmentRecipe,OrdinaryEquipmentRecipeSnapshotSchema} from './phaseEOrdinaryEquipment';
import {PHASE_E_ADVANCED_EXPEDITIONS as A,PHASE_E_ORDINARY_EQUIPMENT as C} from './constants';
import {advancedExpeditionPreview,AdvancedExpeditionSnapshotSchema} from './phaseEAdvancedExpeditions';
import {StarterRouteIdSchema,starterRoutePreview} from './phaseEExpeditions';
import {REALM_IDS} from './baseVisual';
import {OrdinaryRouteIdSchema} from './ordinaryRoutes';
import {StarterExpeditionRequestSchema,StarterExpeditionRouteSnapshotSchema} from './starterExpeditionApi';
const fitting={itemId:'route_compass',policyVersion:1} as const;
it('keeps the old unfitted route bytes and explicit opt-in separate',()=>{
 const route=starterRoutePreview('crownlands','introduction');expect(applyEquipmentFitting(route)).toBe(route);
 expect('fitting'in route).toBe(false);
 expect(StarterExpeditionRequestSchema.safeParse({idempotencyKey:'00000000-0000-4000-8000-000000000001',baseId:'00000000-0000-4000-8000-000000000002',installationId:'00000000-0000-4000-8000-000000000003',routeId:'introduction',routeVersion:1,rewardVersion:1,fitting:{...fitting,second:'survey_lens'}}).success).toBe(false);
});
it('freezes exact ordinary recipe without widening nine-item crafting policy',()=>{
 const recipe=ordinaryEquipmentRecipe();expect(OrdinaryEquipmentRecipeSnapshotSchema.parse(recipe)).toEqual(recipe);
 expect(recipe.durationSec).toBe(C.recipe.durationSec);expect(OrdinaryEquipmentRecipeSnapshotSchema.safeParse({...recipe,inputs:[{kind:'bound',itemId:'prismstone_lens',quantity:'2'}]}).success).toBe(false);
});
it.each(REALM_IDS)('conserves all %s starter route taxes and never increases gross/hour',realm=>{
 for(const id of StarterRouteIdSchema.options){const route=starterRoutePreview(realm,id);if(BigInt(route.grossQuantity)<7n){expect(()=>applyEquipmentFitting(route,fitting)).toThrow();continue;}const r=applyEquipmentFitting(route,fitting);
  expect(StarterExpeditionRouteSnapshotSchema.parse(r)).toEqual(r);expect(BigInt(r.netQuantity)+BigInt(r.islandPoolQuantity)).toBe(BigInt(r.grossQuantity));
  expect(BigInt(r.grossQuantity)*BigInt(route.durationSec)).toBeLessThanOrEqual(BigInt(route.grossQuantity)*BigInt(r.durationSec));
  expect(BigInt(r.islandPoolQuantity)*5n).toBe(BigInt(r.grossQuantity));expect(r.durationSec).toBeLessThan(route.durationSec);
 }
});
for(const family of Object.keys(A.v1.families) as (keyof typeof A.v1.families)[])describe(family,()=>{
 it.each([1,2,3,4] as const)('preserves supplies/access and exact tax across tier%s supported ordinary routes',tier=>{
  for(const routeId of OrdinaryRouteIdSchema.options){let route;try{route=advancedExpeditionPreview({family,tier,homeRealmId:'crownlands',routeId},2);}catch{continue;}
   const r=applyEquipmentFitting(route,fitting);expect(AdvancedExpeditionSnapshotSchema.parse(r)).toEqual(r);expect(r.supplies).toEqual(route.supplies);expect(r.accessRequirement).toBe(route.accessRequirement);
   expect(BigInt(r.grossQuantity)*BigInt(route.durationSec)).toBeLessThanOrEqual(BigInt(route.grossQuantity)*BigInt(r.durationSec));expect(BigInt(r.netQuantity)+BigInt(r.islandPoolQuantity)).toBe(BigInt(r.grossQuantity));
   expect(equipmentFittingMatches({...r,durationSec:r.durationSec+1})).toBe(false);
  }
 });
});
it('rejects tiny zero cargo and forged effect or extra fitting instead of inventing carry',()=>{
 expect(()=>applyEquipmentFitting({durationSec:10,grossQuantity:'5',netQuantity:'4',islandPoolQuantity:'1'},fitting)).toThrow();
 const r=applyEquipmentFitting(starterRoutePreview('crownlands','coastal_survey'),fitting);expect(equipmentFittingMatches({...r,netQuantity:'999'})).toBe(false);
 expect(StarterExpeditionRouteSnapshotSchema.safeParse({...r,fitting:{...r.fitting!,power:1}}).success).toBe(false);
});

import fixture from '../testFixtures/ordinaryEquipment.json';
import {OrdinaryEquipmentViewSchema,OrdinaryEquipmentEnvelopeSchema} from './ordinaryEquipmentApi';
import {StarterExpeditionViewSchema,StarterExpeditionEnvelopeSchema} from './starterExpeditionApi';
import {AdvancedExpeditionEnvelopeSchema} from './advancedExpeditionApi';
import {VehicleRoutesSchema} from './vehicleClientApi';
it('pairs identical shared transport bytes for browser, native and API fixtures',()=>{
 expect(OrdinaryEquipmentViewSchema.parse(fixture.view)).toEqual(fixture.view);expect(OrdinaryEquipmentEnvelopeSchema.parse(fixture.envelope)).toEqual(fixture.envelope);
 expect(StarterExpeditionViewSchema.parse(fixture.starterView)).toEqual(fixture.starterView);expect(StarterExpeditionEnvelopeSchema.parse(fixture.starterEnvelope)).toEqual(fixture.starterEnvelope);
 expect(AdvancedExpeditionEnvelopeSchema.parse(fixture.advancedEnvelope)).toEqual(fixture.advancedEnvelope);expect(VehicleRoutesSchema.parse(fixture.advancedView)).toEqual(fixture.advancedView);
});

import {PaidStarterRouteIdSchema,paidStarterRoutePreview,PaidStarterRoutePreviewSchema} from './paidStarterExpeditions';
import {PaidStarterExpeditionViewSchema} from './paidStarterExpeditionApi';
it('accepts every fitted paid current preview and rejects forged original economics',()=>{
 for(const routeId of PaidStarterRouteIdSchema.options){const route=applyEquipmentFitting(paidStarterRoutePreview(routeId),fitting);
  expect(PaidStarterRoutePreviewSchema.parse(route)).toEqual(route);
  expect(PaidStarterExpeditionViewSchema.parse({wallet:fixture.view.wallet,baseId:fixture.view.baseId,realm:REALM_IDS.indexOf(route.realmId),serverNow:fixture.view.serverNow,authorization:'none',acceptingDepartures:true,route,coverage:{status:'unavailable'}}).route).toEqual(route);
  expect(PaidStarterRoutePreviewSchema.safeParse({...route,fitting:{...route.fitting!,originalGrossQuantity:'999'}}).success).toBe(false);
 }
});
