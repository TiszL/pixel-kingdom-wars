import {REALM_IDS} from '@shardkeep/shared/baseVisual';
import {PaidStarterRouteIdSchema,paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {applyEquipmentFitting,type EquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';

// These are compatibility hints only. The server still supplies current terms and access.
const destinations=PaidStarterRouteIdSchema.options.map(id=>paidStarterRoutePreview(id));
export function paidDestinations(fitting:EquipmentFitting){
 return destinations.map(route=>{
  let compatible=true;
  try{applyEquipmentFitting(route,fitting);}catch{compatible=false;}
  return {realm:REALM_IDS.indexOf(route.realmId),realmId:route.realmId,resourceId:route.resourceId,compatible};
 });
}
