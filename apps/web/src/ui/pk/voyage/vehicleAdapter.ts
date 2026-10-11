/** Pure projections of original observations. These gates cannot grant authority. */
import {PHASE_E_ORDINARY_ROUTES,PHASE_E_VEHICLES} from '@shardkeep/shared';
import type {AdvancedFleetVehicle} from '@shardkeep/shared/advancedFleetApi';
import type {AdvancedExpeditionSnapshot} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {OrdinaryRouteIdSchema,ordinaryRoute} from '@shardkeep/shared/ordinaryRoutes';
import type {VehicleState} from '../../../lib/vehicles/controller';
import {terminal,type VehicleOperation} from '../../../lib/vehicles/journal';
import {sendGate,vehicleCardState,type VehicleGate} from './voyageLogic';
import {canSelect,sendLook,type PrimaryLook} from './voyageNativeLogic';
export interface VehicleSupplyObservation {wallet:string;baseId:string;rawStock:readonly {resourceId:string;available:string}[]}
export function vehicleSnapshot(state:VehicleState,wallet:string|null,baseId:string|null,stock:VehicleSupplyObservation|null) {
 const scoped=<T extends {wallet:string;baseId:string}>(value:T|null):T|null=>value?.wallet===wallet&&value.baseId===baseId?value:null;
 return {fleet:scoped(state.fleet),routes:scoped(state.routes),assets:state.assets?.wallet===wallet?state.assets:null,stock:scoped(stock)};
}
const uncertain=(op:VehicleOperation)=>!op.original||op.signingStarted&&!op.signed||!('kind'in op.original)&&op.original.status==='unknown';
export const vehicleOperationStage=(op:VehicleOperation)=>terminal(op)?'COMPLETED':uncertain(op)?vehicleMoneyStage('ERROR',null):op.signed?'SIGNED':op.original&&'kind'in op.original?op.original.record.status.toUpperCase():'AT_SEA';
/** A request's original scope; history-only unresolved records can have no scope. */
function originalRequest(op:VehicleOperation) {
 if(op.command.request)return op.command.request;
 if(!op.original)return null;
 return 'kind'in op.original?op.original.kind==='installation'?op.original.record.reservation.request:op.original.record.intent.request:op.original.receipt?.request??null;
}
function unknownScope(op:VehicleOperation):boolean {
 const request=originalRequest(op);if(!request)return true;
 return op.command.kind==='expedition'?!('baseId'in request&&'installationId'in request):op.command.kind==='service'?!('installationId'in request):!('baseId'in request&&'berthId'in request&&'assetId'in request);
}
/** The server admits one advanced flight per kingdom. Missing scope fails closed. */
export function vehicleDepartureUncertain(operations:readonly VehicleOperation[],installationId:string|null,baseId:string|null):boolean {
 return operations.some(op=>{
  if(terminal(op))return false;if(unknownScope(op))return true;if(!uncertain(op))return false;
  const request=originalRequest(op)!;
  return op.command.kind==='expedition'&&'baseId'in request&&request.baseId===baseId
   ||op.command.kind==='service'&&'installationId'in request&&request.installationId===installationId;
 });
}
export type VehicleDepartureHold={kind:'CHECK'|'HELD'|'READY';reason:string|null};
export function vehicleDepartureHold(operations:readonly VehicleOperation[],fleet:ReturnType<typeof vehicleSnapshot>['fleet'],baseId:string|null,installationId:string|null):VehicleDepartureHold {
 const pending=operations.filter(op=>!terminal(op));
 if(pending.some(unknownScope))return {kind:'CHECK',reason:'A saved vehicle request has no known kingdom yet. Use CHECK ORIGINAL OUTCOME before any departure.'};
 if(vehicleDepartureUncertain(pending,installationId,baseId)){
  const expedition=pending.some(op=>{const request=originalRequest(op);return op.command.kind==='expedition'&&uncertain(op)&&!!request&&'baseId'in request&&request.baseId===baseId;});
  return {kind:'CHECK',reason:expedition?'A saved expedition request for this kingdom is being checked. Use CHECK ORIGINAL OUTCOME before another departure.':'An original service request for this vehicle is being checked. Use CHECK ORIGINAL OUTCOME before departing.'};
 }
 for(const op of pending){
  const request=originalRequest(op)!;
  if(op.command.kind==='expedition'&&'baseId'in request&&request.baseId===baseId)return {kind:'HELD',reason:'An expedition is still recorded for this kingdom. Use COLLECT ACTUAL RETURNS or CHECK ORIGINAL OUTCOME before another departure.'};
  if(op.command.kind==='service'&&'installationId'in request&&request.installationId===installationId)return {kind:'HELD',reason:'This vehicle has a saved service reservation. It cannot depart until that service is completed. Use CHECK ORIGINAL OUTCOME to see its state.'};
 }
 if(fleet?.baseId===baseId&&fleet.vehicles.some(vehicle=>vehicle.away))return {kind:'HELD',reason:'A vehicle is still recorded away in this kingdom. Use COLLECT ACTUAL RETURNS before another departure.'};
 return {kind:'READY',reason:null};
}
export const vehicleCanRetryOriginal=(op:VehicleOperation)=>!!op.command.request&&(!op.original||!('kind'in op.original)&&op.original.status==='unknown');
/** Keep reservations separate: a new reserve mints a new key. Preserve every
 * unresolved hold on this asset/installation/berth, even a prepared original.
 * An unscoped original reservation fails closed until original recovery reads it. */
export function vehicleReservationHeld(operations:readonly VehicleOperation[],target:{assetId:string;installationId?:string;baseId?:string;berthId?:string}):boolean {
 return operations.some(op=>{
  if(terminal(op))return false;
  const request=originalRequest(op);if(!request)return op.command.kind!=='expedition'||!!target.installationId;
  if(op.command.kind==='expedition')return !!target.installationId&&'installationId'in request&&request.installationId===target.installationId;
  return 'assetId'in request&&request.assetId===target.assetId
   ||!!target.installationId&&'installationId'in request&&request.installationId===target.installationId
   ||!!target.baseId&&!!target.berthId&&'baseId'in request&&'berthId'in request&&request.baseId===target.baseId&&request.berthId===target.berthId;
 });
}
/** A generic transport failure never means FAILED or permits a second payment. */
export function vehicleMoneyStage(stage:string,error:{authoritative:boolean;recoverable:boolean}|null) {
 return stage==='ERROR'?(error?.authoritative===true&&error.recoverable===false?'FAILED':'CHECKING'):stage==='IDLE'||stage==='ARMED'?'READY':stage;
}
export function vehicleServiceOptions(vehicle:AdvancedFleetVehicle,candidate:{family:string;tier:number}|null) {
 const matches=!!candidate&&candidate.family===vehicle.family&&candidate.tier===vehicle.tier&&!vehicle.away&&!vehicle.pendingService;
 return {upgrade:matches&&vehicle.tier!==PHASE_E_VEHICLES.tiers.at(-1),restore:matches&&vehicle.remainingUses===0};
}
export function vehicleDeparture(input:{snapshot:ReturnType<typeof vehicleSnapshot>;vehicle:AdvancedFleetVehicle|null;route:AdvancedExpeditionSnapshot|null;ordersAllowed:boolean;pending:boolean;busy:boolean;error:string|null;holdReason?:string|null;checkReason?:string|null}) {
 const {snapshot,vehicle,route}=input;
 const routeId=OrdinaryRouteIdSchema.safeParse(route?.routeId),grade=routeId.success?ordinaryRoute(routeId.data).grade:null;
 const observedVehicle=vehicle&&snapshot.fleet?.vehicles.find(v=>v.installationId===vehicle.installationId);
 const currentVehicle=!!observedVehicle&&JSON.stringify(observedVehicle)===JSON.stringify(vehicle);
 const routePresent=!!route&&currentVehicle&&snapshot.routes?.items.find(i=>i.installationId===vehicle?.installationId)?.previews.some(p=>JSON.stringify(p)===JSON.stringify(route));
 const compatible=!!route&&!!vehicle&&routePresent&&routeId.success&&route.policyVersion===PHASE_E_ORDINARY_ROUTES.policyVersion&&route.family===vehicle.family&&route.tier===vehicle.tier&&!route.fitting;
 const supplies=(route?.supplies??[]).map(s=>{const available=snapshot.stock?.rawStock.find(row=>row.resourceId===s.resourceId)?.available??null;return {resourceId:s.resourceId,quantity:s.quantity,available,name:s.resourceId.replaceAll('_',' '),short:available===null||BigInt(available)<BigInt(s.quantity),shortLine:available===null?'Stock is unknown. Refresh the original kingdom stock.':`Need more ${s.resourceId.replaceAll('_',' ')}.`};});
 const gateVehicle:VehicleGate|null=currentVehicle&&vehicle?{family:vehicle.family,status:!vehicle.installationId?'EMPTY':vehicle.away?'AWAY':vehicle.pendingService?'BUSY_SERVICE':vehicle.remainingUses===0?'WORN_OUT':'DOCKED',installationId:vehicle.installationId||null,tripsLeft:vehicle.remainingUses,maxGrade:vehicle.tier}:null;
 const preview=compatible?{supplies,permit:null,returnsAtLocal:'the original quoted duration'}:null;
 const state=compatible?'READY' as const:'ERROR' as const,orders=input.ordersAllowed&&!!snapshot.fleet?.acceptingNewActions;
 const gate=sendGate({pending:input.pending,busy:input.busy,lockedReason:input.holdReason??null,ordersAllowed:orders,hasRoute:!!route,vehicle:gateVehicle,routeGrade:grade,previewState:state,preview});
 // Gate first. EMPTY can never become hasVehicle=true by object truthiness.
 let look:PrimaryLook;
 if(gate.action==='CHECK')look={label:'CHECK ORIGINAL OUTCOME',sub:null,state:'ENABLED',verb:'STONE',reason:input.checkReason??'An original request for this vehicle is being checked.'};
 else if(gate.action==='NONE')look={label:gate.reason??'Checking',sub:null,state:'BUSY',verb:'STONE',reason:null};
 else if(gate.action==='EXPLAIN')look={label:'REVIEW DEPARTURE',sub:null,state:'DISABLED',verb:'GOLD',reason:gate.reason};
 else look={...sendLook({hasRoute:!!route,hasVehicle:!!gateVehicle&&canSelect(vehicleCardState(gateVehicle,null,grade)),previewState:state,preview,ordersAllowed:orders,ordersReason:null,lockedReason:null,busy:input.busy,pending:input.pending,previewError:input.error}),label:'REVIEW DEPARTURE',sub:null};
 return {intent:gate.action,look,supplies};
}
