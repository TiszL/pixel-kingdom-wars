import {EquipmentFittingSchema,fittingSelection,type EquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {REALM_IDS} from '@shardkeep/shared/baseVisual';
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {OrdinaryEquipmentViewV2Schema} from '@shardkeep/shared/ordinaryEquipmentApi';
import {StarterExpeditionViewSchema,StarterExpeditionUuidSchema} from '@shardkeep/shared/starterExpeditionApi';
import {PaidStarterExpeditionViewSchema} from '@shardkeep/shared/paidStarterExpeditionApi';
import {VehicleRoutesSchema,VehicleCollectResultSchema} from '@shardkeep/shared/vehicleClientApi';
import {AdvancedFleetEnvelopeSchema} from '@shardkeep/shared/advancedFleetApi';
import {requestRouteCompassOriginal} from '../api';
import {captureFleetJourneyPublication,publishFleetDeparture} from '../fleetJourneyPresentation';
import {need,same,parseCompassCommand,matchCompassProof,compassRefusalDefinitive,type CompassCommand,type CompassProof,type CompassIdentity,type CompassRefusal} from './journal';
export type CompassRead={kind:'equipment'|'fleet'|'collect';baseId:string}|{kind:'starter'|'routes';baseId:string;fitting?:EquipmentFitting}|{kind:'paid';baseId:string;realm:number;fitting?:EquipmentFitting};
export async function compassRead(identity:CompassIdentity,r:CompassRead,guard:()=>void){
 const baseId=StarterExpeditionUuidSchema.parse(r.baseId),fitting=EquipmentFittingSchema.parse('fitting'in r&&r.fitting?r.fitting:{itemId:'route_compass',policyVersion:1}),query='&fitting='+fitting.itemId+(fitting.itemId==='survey_lens'?'&resourceId='+fitting.resourceId:'');let path:string;
 if(r.kind==='equipment')path='/ordinary-equipment?baseId='+baseId+'&catalogueVersion=2';
 else if(r.kind==='starter')path='/starter-expeditions?baseId='+baseId+query;
 else if(r.kind==='fleet')path='/vehicles/fleet?baseId='+baseId;
 else if(r.kind==='routes')path='/vehicles/client/routes?baseId='+baseId+'&policyVersion=2'+query;
 else if(r.kind==='collect')path='/advanced-expeditions/collect';
 else{need(r.kind==='paid');need(Number.isInteger(r.realm)&&r.realm>=0&&r.realm<REALM_IDS.length);path='/starter-expeditions/paid-route?baseId='+baseId+'&realm='+r.realm+query;}
 return requestRouteCompassOriginal({method:r.kind==='collect'?'POST':'GET',path,...(r.kind==='collect'?{body:{baseId}}:{}),timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,isCurrent:()=>{guard();return true;},observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;
  const v=r.kind==='equipment'?OrdinaryEquipmentViewV2Schema.parse(raw):r.kind==='starter'?StarterExpeditionViewSchema.parse(raw):r.kind==='fleet'?AdvancedFleetEnvelopeSchema.parse(raw):r.kind==='routes'?VehicleRoutesSchema.parse(raw):r.kind==='collect'?VehicleCollectResultSchema.parse(raw):PaidStarterExpeditionViewSchema.parse(raw);
  need(v.baseId===baseId&&(!('wallet'in v)||v.wallet===identity.wallet));
  if(r.kind==='starter')need('fitting'in v&&same(v.fitting,fitting));
  if(r.kind==='paid')need('realm'in v&&v.realm===r.realm&&same(fittingSelection(v.route).fitting,fitting));
  if(r.kind==='routes')need('items'in v&&v.items.every(item=>item.previews.every(p=>p.policyVersion===2&&same(fittingSelection(p).fitting,fitting))));
  return v;
 }});
}
export async function compassOriginal(input:{identity:CompassIdentity;command:CompassCommand;method:'GET'|'POST';firstAttempt:boolean;guard:()=>void;retain:(p:CompassProof)=>Promise<void>;refused:(r:CompassRefusal)=>Promise<void>}):Promise<CompassProof>{
 const c=parseCompassCommand(input.command),root=c.kind==='craft'?'/ordinary-equipment/jobs':c.kind==='starter'?'/starter-expeditions':'/advanced-expeditions';
 const journey=input.method==='POST'&&c.kind!=='craft'?captureFleetJourneyPublication(c.request.baseId,input.guard):null;let created=false;
 const result=await requestRouteCompassOriginal({method:input.method,path:input.method==='GET'?root+'/by-key/'+c.request.idempotencyKey:root,...(input.method==='POST'?{body:c.request}:{}),timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,isCurrent:()=>{input.guard();return true;},observe:async(status,raw,headers)=>{
  if(status>=200&&status<300){const p=matchCompassProof(raw,input.identity,c);need(input.method==='GET'||p.status==='accepted','Departure did not prove acceptance.');if(p.status==='accepted')await input.retain(p);created=!!journey&&status===201&&headers?.get('x-pkw-journey-created')==='1';return p;}
  if(input.method==='POST'&&input.firstAttempt&&raw&&typeof raw==='object'&&'error'in raw&&raw.error&&typeof raw.error==='object'&&'code'in raw.error&&typeof raw.error.code==='string'&&compassRefusalDefinitive(status,raw.error.code))await input.refused({phase:'first_post',status,code:raw.error.code});
  return undefined;
 }});
 if(created&&journey&&c.kind!=='craft')await publishFleetDeparture(c.kind,input.identity.wallet,result,input.guard,journey);
 return result;
}
