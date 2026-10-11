import {expect,it} from 'vitest';
import {PHASE_E_ORDINARY_ROUTES,PHASE_E_VEHICLES} from '@shardkeep/shared';
import {advancedExpeditionPreview} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {applyEquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {PHASE_E_VEHICLE_FAMILY_IDS} from '@shardkeep/shared/phaseEVehicles';
import type {AdvancedFleetVehicle} from '@shardkeep/shared/advancedFleetApi';
import {ORDINARY_ROUTE_IDS} from '@shardkeep/shared/ordinaryRoutes';
import {emptyVehicleState} from '../../../lib/vehicles/controller';
import type {VehicleOperation} from '../../../lib/vehicles/journal';
import {vehicleSnapshot,vehicleDeparture,vehicleOperationStage,vehicleServiceOptions,vehicleMoneyStage,vehicleDepartureUncertain,vehicleReservationHeld,vehicleDepartureHold} from './vehicleAdapter';
import {expeditionOperation,preparedOperation,reservedServiceOperation} from './vehiclePresentation.test-support';
const wallet='11111111111111111111111111111112',baseId='00000000-0000-4000-8000-000000000001';
const vehicle:AdvancedFleetVehicle={installationId:'00000000-0000-4000-8000-000000000002',berthId:'00000000-0000-4000-8000-000000000003',family:'survey_balloon',tier:1,revision:0,completedTotal:'0',allowanceStart:'0',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall,away:false,pendingService:false};
const route=advancedExpeditionPreview({family:vehicle.family,tier:vehicle.tier,homeRealmId:'crownlands',routeId:ORDINARY_ROUTE_IDS[0]},PHASE_E_ORDINARY_ROUTES.policyVersion);
const stock=()=>({wallet,baseId,rawStock:route.supplies.map(s=>({resourceId:s.resourceId,available:s.quantity}))});
const scope=()=>vehicleSnapshot({...emptyVehicleState(),loaded:true,fleet:{version:1,wallet,baseId,serverNow:'2035-01-01T00:00:00.000Z',acceptingNewActions:true,vehicles:[vehicle]},routes:{version:1,wallet,baseId,items:[{installationId:vehicle.installationId,previews:[route]}]}},wallet,baseId,stock());
const decision=(patch:Partial<Parameters<typeof vehicleDeparture>[0]>={})=>vehicleDeparture({snapshot:scope(),vehicle,route,ordersAllowed:true,pending:false,busy:false,error:null,...patch});
// Every guard variant is itself present in the observed snapshot. Identity mismatch cannot mask it.
const observedDecision=(current:AdvancedFleetVehicle,preview:typeof route=route)=>{
 const snapshot=scope();snapshot.fleet={...snapshot.fleet!,vehicles:[current]};snapshot.routes={...snapshot.routes!,items:[{installationId:current.installationId,previews:[preview]}]};
 return decision({snapshot,vehicle:current,route:preview});
};
it('scopes current fleet routes candidates and stock to their original wallet and kingdom',()=>{
 const s=emptyVehicleState();s.fleet=scope().fleet;s.routes=scope().routes;s.assets={version:2,wallet,items:[],nextCursor:null};
 expect(vehicleSnapshot(s,'foreign',baseId,stock())).toMatchObject({fleet:null,routes:null,assets:null,stock:null});
 expect(vehicleSnapshot(s,wallet,'foreign',stock())).toMatchObject({fleet:null,routes:null,stock:null});
});
it('gates missing and empty vehicles before native SEND looks',()=>{
 expect(observedDecision(vehicle)).toMatchObject({intent:'SEND',look:{state:'ENABLED'}});
 expect(decision({vehicle:null})).toMatchObject({intent:'EXPLAIN',look:{state:'DISABLED'}});
 expect(observedDecision({...vehicle,installationId:''})).toMatchObject({intent:'EXPLAIN',look:{state:'DISABLED'}});
});
it('saved uncertain departure takes CHECK precedence over an error and never sends twice',()=>{
 expect(decision({pending:true,error:'response lost'})).toMatchObject({intent:'CHECK',look:{label:'CHECK ORIGINAL OUTCOME',state:'ENABLED'}});
});
it('unknown or insufficient supplied stock blocks a departure without changing server terms',()=>{
 expect(decision({snapshot:{...scope(),stock:null}})).toMatchObject({intent:'EXPLAIN',look:{state:'DISABLED'}});
 const short={...stock(),rawStock:stock().rawStock.map(s=>({...s,available:'0'}))};
 expect(decision({snapshot:{...scope(),stock:short}}).intent).toBe('EXPLAIN');expect(route.supplies.every(s=>BigInt(s.quantity)>0n)).toBe(true);
});
it('only current admitted policy family tier and unfitted routes can be reviewed',()=>{
 expect(decision()).toMatchObject({intent:'SEND',look:{state:'ENABLED'}});
 expect(observedDecision(vehicle,{...route,policyVersion:1}).intent).toBe('EXPLAIN');
 expect(observedDecision({...vehicle,tier:2}).intent).toBe('EXPLAIN');
 expect(decision({snapshot:{...scope(),routes:null}}).intent).toBe('EXPLAIN');
 expect(observedDecision({...vehicle,family:PHASE_E_VEHICLE_FAMILY_IDS.find(f=>f!==vehicle.family)!}).intent).toBe('EXPLAIN');
 expect(observedDecision(vehicle,applyEquipmentFitting(route,{itemId:'route_compass',policyVersion:1})).intent).toBe('EXPLAIN');
});
it('away exhausted service-pending busy and paused vehicles cannot send',()=>{
 expect(observedDecision(vehicle)).toMatchObject({intent:'SEND',look:{state:'ENABLED'}});
 for(const v of [{...vehicle,away:true},{...vehicle,pendingService:true},{...vehicle,remainingUses:0}])expect(observedDecision(v).intent).toBe('EXPLAIN');
 expect(decision({busy:true}).intent).toBe('NONE');expect(decision({ordersAllowed:false}).intent).toBe('EXPLAIN');
});
it('transport errors and signing markers never establish a failed payment or terminal receipt',()=>{
 const op:VehicleOperation={command:{kind:'installation',key:'original',request:null,reference:null},original:null,signingStarted:false,signed:null,actions:[],observedTerminal:false};
 expect(vehicleOperationStage(op)).toBe('CHECKING');expect(vehicleOperationStage({...op,signingStarted:true})).toBe('CHECKING');
 expect(vehicleMoneyStage('ERROR',null)).toBe('CHECKING');expect(vehicleMoneyStage('ERROR',{authoritative:true,recoverable:true})).toBe('CHECKING');
 expect(vehicleMoneyStage('ERROR',{authoritative:true,recoverable:false})).toBe('FAILED');
});
it('service requires an idle installation and a matching current-tier NFT',()=>{
 const matching={family:vehicle.family,tier:vehicle.tier};
 expect(vehicleServiceOptions(vehicle,matching)).toEqual({upgrade:true,restore:false});
 expect(vehicleServiceOptions({...vehicle,remainingUses:0},matching)).toEqual({upgrade:true,restore:true});
 expect(vehicleServiceOptions(vehicle,null)).toEqual({upgrade:false,restore:false});
 expect(vehicleServiceOptions(vehicle,{...matching,tier:2})).toEqual({upgrade:false,restore:false});
 expect(vehicleServiceOptions({...vehicle,away:true},matching)).toEqual({upgrade:false,restore:false});
 expect(vehicleServiceOptions({...vehicle,tier:PHASE_E_VEHICLES.tiers.at(-1)!},{...matching,tier:PHASE_E_VEHICLES.tiers.at(-1)!}).upgrade).toBe(false);
});

it('unknown retained expedition envelopes remain CHECKING and never claim a departure',()=>{
 expect(vehicleOperationStage(expeditionOperation('accepted'))).toBe('AT_SEA');
 expect(vehicleOperationStage(expeditionOperation('unknown'))).toBe('CHECKING');
});
it('uncertain expeditions hold their kingdom and uncertain service holds its installation',()=>{
 const uncertain=expeditionOperation('unknown'),installationId=(uncertain.command.request as {installationId:string}).installationId;
 expect(vehicleDepartureUncertain([uncertain],installationId,baseId)).toBe(true);
 // 7fa67390 corrects the withdrawn per-installation expedition premise.
 expect(vehicleDepartureUncertain([uncertain],'other-installation',baseId)).toBe(true);
 expect(vehicleDepartureUncertain([uncertain],'other-installation','other-kingdom')).toBe(false);
 expect(vehicleDepartureUncertain([expeditionOperation('accepted')],installationId,baseId)).toBe(false);
 expect(vehicleDepartureUncertain([preparedOperation()],installationId,baseId)).toBe(false);
 const service:VehicleOperation={...preparedOperation(),command:{kind:'service',key:'service-key',request:{installationId,assetId:'saved-asset',operation:'upgrade',idempotencyKey:'service-key'},reference:null},original:null};
 expect(vehicleDepartureUncertain([service],installationId,baseId)).toBe(true);
});
it('reservations remain held for the same asset installation and original berth',()=>{
 const op=preparedOperation(),request=op.command.request as {assetId:string;baseId:string;berthId:string};
 expect(vehicleReservationHeld([op],{assetId:request.assetId})).toBe(true);
 expect(vehicleReservationHeld([op],{assetId:'other',baseId:request.baseId,berthId:request.berthId})).toBe(true);
 expect(vehicleReservationHeld([op],{assetId:'other',baseId:'other',berthId:'other'})).toBe(false);
 const service:VehicleOperation={...op,command:{kind:'service',key:'service-key',request:{installationId:'saved-installation',assetId:'saved-asset',operation:'upgrade',idempotencyKey:'service-key'},reference:null},original:null};
 expect(vehicleReservationHeld([service],{assetId:'other',installationId:'saved-installation'})).toBe(true);
 expect(vehicleReservationHeld([service],{assetId:'saved-asset',installationId:'other'})).toBe(true);
 expect(vehicleReservationHeld([expeditionOperation('accepted')],{assetId:'other'})).toBe(false);
 expect(vehicleReservationHeld([{...op,original:null,command:{...op.command,request:null}}],{assetId:'other'})).toBe(true);
});

it('saved accepted flight holds the whole kingdom even when the fleet still shows docked',()=>{
 const op=expeditionOperation('accepted');expect(vehicleDepartureHold([],scope().fleet,baseId,'other-installation').kind).toBe('READY');
 expect(vehicleDepartureHold([op],scope().fleet,baseId,'other-installation')).toEqual({kind:'HELD',reason:'An expedition is still recorded for this kingdom. Use COLLECT ACTUAL RETURNS or CHECK ORIGINAL OUTCOME before another departure.'});
});
it('unscoped history holds every departure for original recovery only',()=>{
 const op={...expeditionOperation('missing'),command:{...expeditionOperation('missing').command,request:null}};
 expect(vehicleDepartureHold([op],scope().fleet,'other-kingdom','other-installation')).toEqual({kind:'CHECK',reason:'A saved vehicle request has no known kingdom yet. Use CHECK ORIGINAL OUTCOME before any departure.'});
});
it('a stale fleet away flag holds new departures even without a local journal record',()=>{
 const fleet={...scope().fleet!,vehicles:[{...vehicle,away:true}]};
 expect(vehicleDepartureHold([],fleet,baseId,'other-installation')).toEqual({kind:'HELD',reason:'A vehicle is still recorded away in this kingdom. Use COLLECT ACTUAL RETURNS before another departure.'});
});
it('a nonterminal service holds its installation while either kind of flight holds a service reserve',()=>{
 const installationId=vehicle.installationId,service=reservedServiceOperation(installationId);
 expect(vehicleDepartureHold([service],scope().fleet,baseId,installationId)).toEqual({kind:'HELD',reason:'This vehicle has a saved service reservation. It cannot depart until that service is completed. Use CHECK ORIGINAL OUTCOME to see its state.'});
 for(const status of ['missing','accepted'] as const){const expedition=expeditionOperation(status,installationId);expect(vehicleReservationHeld([expedition],{assetId:'other',installationId})).toBe(true);}
});

it('pins CHECK copy for an uncertain original service on the selected installation',()=>{
 const service={...reservedServiceOperation(vehicle.installationId),original:null};
 expect(vehicleDepartureHold([service],scope().fleet,baseId,vehicle.installationId)).toEqual({kind:'CHECK',reason:'An original service request for this vehicle is being checked. Use CHECK ORIGINAL OUTCOME before departing.'});
});
