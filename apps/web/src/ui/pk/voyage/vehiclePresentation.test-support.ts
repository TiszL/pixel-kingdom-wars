/** Display-only fixtures. No wire is signed, no keypair is created and these
 * observations must never be used as signing/trust/chain-admission evidence. */
import {PHASE_E_ORDINARY_ROUTES,PHASE_E_VEHICLES} from '@shardkeep/shared';
import {advancedExpeditionPreview} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {ORDINARY_ROUTE_IDS} from '@shardkeep/shared/ordinaryRoutes';
import type {VehicleClient} from '@shardkeep/shared/vehicleClientApi';
import type {AdvancedFleetVehicle} from '@shardkeep/shared/advancedFleetApi';
import type {VehicleOperation} from '../../../lib/vehicles/journal';
import {identity,id,view} from '../../../lib/starterExpedition/fixtures.test-support';
export {identity,id};
export const vehicle:AdvancedFleetVehicle={installationId:id(8),berthId:id(7),family:'survey_balloon',tier:1,revision:0,completedTotal:'0',allowanceStart:'0',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall,away:false,pendingService:false};
export const route=advancedExpeditionPreview({family:vehicle.family,tier:vehicle.tier,homeRealmId:'crownlands',routeId:ORDINARY_ROUTE_IDS[0]},PHASE_E_ORDINARY_ROUTES.policyVersion);
export const stock=()=>({...view(),rawStock:view().rawStock.map(row=>{const supplied=route.supplies.find(s=>s.resourceId===row.resourceId);return supplied?{...row,total:supplied.quantity,available:supplied.quantity,reserved:'0'}:row;})});
export function preparedOperation():VehicleOperation {
 const at='2035-01-01T00:00:00.000001Z',request={baseId:id(1),berthId:vehicle.berthId,assetId:identity.wallet,idempotencyKey:id(9)};
 const original:VehicleClient={version:1,kind:'installation',consentSource:{genesisHash:identity.wallet,anchorSlot:1,reviewedDeploymentSlot:1,reviewedProgramDataSha256:'a'.repeat(64)},burnReceipt:null,
  record:{version:1,purpose:'vehicle_installation',wallet:identity.wallet,idempotencyKey:request.idempotencyKey,serverNow:'2035-01-01T00:00:01.000Z',signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false,installationAuthorized:false,status:'prepared',signed:null,installation:null,
   reservation:{reservationId:id(9),wallet:identity.wallet,request,identity:{assetId:identity.wallet,collection:identity.wallet,family:vehicle.family,tier:vehicle.tier},completedBuildJobId:id(7),berthCompletedAt:at,reservedAt:at},
   preparation:{messageHex:'00',messageSha256:'b'.repeat(64),blockhash:identity.wallet,blockhashContextSlot:1,lastValidBlockHeight:2,recordedAt:at}}};
 return {command:{kind:'installation',key:id(9),request,reference:null},original,signingStarted:false,signed:null,actions:['create','prepare'],observedTerminal:false};
}

/** Original envelope-shaped observations, not a verified chain receipt. */
export function expeditionOperation(status:'missing'|'unknown'|'accepted',installationId=vehicle.installationId):VehicleOperation {
 const request={baseId:id(1),installationId,routeId:route.routeId,policyVersion:route.policyVersion,idempotencyKey:id(10)};
 const departedAt='2035-01-01T00:00:00.000Z';
 const original=status==='missing'?null:status==='unknown'?{wallet:identity.wallet,idempotencyKey:request.idempotencyKey,serverNow:departedAt,status:'unknown' as const,receipt:null,return:null}:{
  wallet:identity.wallet,idempotencyKey:request.idempotencyKey,serverNow:departedAt,status:'accepted' as const,return:null,
  receipt:{wallet:identity.wallet,request,expeditionId:request.idempotencyKey,installationId,route,departedAt,returnsAt:new Date(Date.parse(departedAt)+route.durationSec*1000).toISOString(),termId:id(11),termHash:'c'.repeat(64),completedBefore:'0'}};
 return {command:{kind:'expedition',key:request.idempotencyKey,request,reference:null},original,signingStarted:false,signed:null,actions:['create'],observedTerminal:false};
}

export function reservedServiceOperation(installationId=vehicle.installationId):VehicleOperation {
 const request={installationId,assetId:identity.wallet,operation:'upgrade' as const,idempotencyKey:id(12)};
 const original:VehicleClient={version:1,kind:'service',consentSource:null,burnReceipt:null,record:{version:1,purpose:'vehicle_service',wallet:identity.wallet,idempotencyKey:request.idempotencyKey,serverNow:'2035-01-01T00:00:01.000Z',status:'reserved',preparation:null,signed:null,application:null,signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false,serviceAuthorized:false,
  intent:{intentId:id(12),wallet:identity.wallet,request,identity:{assetId:identity.wallet,collection:identity.wallet,family:vehicle.family,tier:vehicle.tier},reservedAt:'2035-01-01T00:00:00.000001Z',state:{operation:'upgrade',installationId,baseId:id(1),berthId:vehicle.berthId,revision:vehicle.revision,family:vehicle.family,tier:vehicle.tier,completedTotal:vehicle.completedTotal,allowanceStart:vehicle.allowanceStart}}}};
 return {command:{kind:'service',key:request.idempotencyKey,request,reference:null},original,signingStarted:false,signed:null,actions:['create'],observedTerminal:false};
}
