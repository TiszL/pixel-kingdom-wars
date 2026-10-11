/** D-153.143: authenticated original-actor service through a closed owner
 * capability. Public artifacts omit custody anchors, archival proof and wire bytes. */
import {createVehicleServiceBurnFinalityReader,type VehicleBurnCoreTrust,type VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-service-burn-finality';
import {buildVehicleServiceBurnMessage} from '@shardkeep/chain/vehicle-service-burn-message';
import {VehicleServiceRequestSchema,VehicleServiceEnvelopeSchema,type VehicleServiceEnvelope} from '@shardkeep/shared/vehicleServiceApi';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {vehicleServiceTransition} from '@shardkeep/shared/phaseEVehicleService';
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';
import {phaseEVehiclesEnabled} from '../config';
import {HttpError} from '../lib/errors';
import type {FinalizedDeedReader} from './baseOwnership';
import {createVehicleServiceIntents} from './vehicleServiceIntents';
import {createVehicleServiceBurnPreparations,type VehicleServiceBurnPreparationDependencies} from './vehicleServiceBurnPreparations';
import {createVehicleServiceBurnSignedStore} from './vehicleServiceBurnSignedStore';
import {createVehicleServiceApplications} from './vehicleServiceApplications';
export interface VehicleServiceWorkflowDependencies {
 connect?:(signal:AbortSignal)=>VehicleBurnFinalityRpc;
 trust?:VehicleBurnCoreTrust;
 getBlockhash?:VehicleServiceBurnPreparationDependencies['getBlockhash'];
 finalizedDeedReader?:FinalizedDeedReader|null;
 deedCollection?:string|null;
}
const unknown=():never=>{throw new HttpError(404,'Vehicle service intent not found','VEHICLE_SERVICE_UNKNOWN');};
const held=():never=>{throw new HttpError(503,'Vehicle service history is unavailable','VEHICLE_SERVICE_HISTORY_HELD');};
export function createVehicleServiceWorkflow(db:Db,deps:VehicleServiceWorkflowDependencies={}){
 if('rollback'in db)throw new HttpError(503,'Vehicle service requires a top-level owner capability','VEHICLE_SERVICE_WORKFLOW_TOP_LEVEL');
 const connect=deps.connect,blockhash=deps.getBlockhash,loader=createVehicleServiceBurnPreparations(db);
 const reader=connect&&deps.trust?createVehicleServiceBurnFinalityReader(connect,{...deps.trust},loader.loadSavedReservation):null;
 const ownership={finalizedDeedReader:deps.finalizedDeedReader??null,deedCollection:deps.deedCollection??null};
 const intents=createVehicleServiceIntents(db,{...ownership,...reader?{captureOwner:reader.captureOwner}:{}});
 const preparations=createVehicleServiceBurnPreparations(db,{...reader?{captureOwner:reader.captureOwner}:{},...blockhash?{getBlockhash:blockhash}:{}});
 const signed=createVehicleServiceBurnSignedStore(db),applications=createVehicleServiceApplications(db,reader?{verifyBurn:reader.verify}:{});
 async function original(wallet:string,id:string){
  const value=await intents.get(wallet,id);if(value)return value;
  // A damaged registry join cannot turn an actor's committed intent into absence.
  const [row]=await db.execute(sql`select id from public.vehicle_service_intents where id=${id} and wallet=${wallet}`);if(row)held();return unknown();
 }
 async function read(wallet:string,id:string):Promise<VehicleServiceEnvelope>{
  const intent=await original(wallet,id),preparation=await preparations.get(wallet,intent.id);
  if(!preparation){
   const [row]=await db.execute<{exists:boolean}>(sql`select exists(select 1 from public.vehicle_service_signed_wires where intent_id=${intent.id}) or exists(select 1 from public.vehicle_service_consumptions where intent_id=${intent.id}) or exists(select 1 from public.vehicle_service_applications where intent_id=${intent.id}) exists`);
   if(row?.exists)held();
  }
  const wire=preparation?await signed.get(wallet,intent.id):null,application=preparation?await applications.get(wallet,intent.id):null;
  const request={installationId:intent.state.installationId,assetId:intent.identity.assetId,operation:intent.state.operation,idempotencyKey:intent.idempotencyKey};
  return VehicleServiceEnvelopeSchema.parse({version:1,purpose:'vehicle_service',wallet:intent.wallet,idempotencyKey:intent.idempotencyKey,serverNow:new Date().toISOString(),
   status:application?'applied':wire?'signed':preparation?'prepared':'reserved',
   intent:{intentId:intent.id,wallet:intent.wallet,request,identity:intent.identity,state:intent.state,reservedAt:intent.reservedAt},
   preparation:preparation?{messageHex:preparation.messageHex,messageSha256:preparation.messageSha256,serviceSha256:buildVehicleServiceBurnMessage(preparation.plan).serviceSha256,blockhash:preparation.plan.blockhash,blockhashContextSlot:preparation.blockhashContextSlot,lastValidBlockHeight:preparation.lastValidBlockHeight,recordedAt:preparation.recordedAt}:null,
   signed:wire?{signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256,acceptedAt:wire.acceptedAt}:null,
   application:application?{tierAfter:application.tierAfter,revisionAfter:application.revisionAfter,completedTotal:application.completedTotal,allowanceStartAfter:application.allowanceStartAfter,remainingUses:vehicleServiceTransition(intent.state).remainingUses,appliedAt:application.appliedAt,signature:application.proof.signature}:null,
   signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false,serviceAuthorized:false});
 }
 async function readByKey(wallet:string,key:string){
  const value=await intents.getByKey(wallet,key);if(value)return read(wallet,value.id);
  const [row]=await db.execute(sql`select id from public.vehicle_service_intents where wallet=${wallet} and idempotency_key=${key}`);if(row)held();return unknown();
 }
 async function reserve(wallet:string,raw:unknown){
  wallet=PhaseEVehicleMintIdentitySchema.shape.assetId.parse(wallet);const request=VehicleServiceRequestSchema.parse(raw);
  const old=await intents.getByKey(wallet,request.idempotencyKey);
  if(!old){
   const [known]=await db.execute(sql`select id from public.vehicle_service_intents where wallet=${wallet} and idempotency_key=${request.idempotencyKey}`);if(known)held();
   if(!phaseEVehiclesEnabled())throw new HttpError(503,'Vehicle services are paused','VEHICLE_SERVICE_DISABLED');
   // Hide another actor's installation before any NFT/RPC work. The private
   // primitive independently refreshes custody and rechecks it under its locks.
   const [owned]=await db.execute(sql`select i.reservation_id from public.advanced_vehicle_installations i join public.bases b on b.id=i.base_id join public.base_slots s on s.base_id=b.id and s.wallet=${wallet} and s.active where i.reservation_id=${request.installationId} and b.owner_wallet=${wallet} and b.status='active'`);
   if(!owned)unknown();
  }
  const intent=await intents.reserve({...request,wallet});return read(wallet,intent.id);
 }
 async function prepare(wallet:string,id:string){const saved=await read(wallet,id);await preparations.prepare(wallet,saved.intent.intentId);return read(wallet,saved.intent.intentId);}
 async function retainSigned(wallet:string,id:string,bytes:Uint8Array){
  if(!(bytes instanceof Uint8Array)||bytes.length<66||bytes.length>1232)throw new HttpError(400,'Signed service consent is invalid','VEHICLE_SERVICE_SIGNED_INPUT');
  const copied=Uint8Array.from(bytes),intent=await original(wallet,id);
  try{await signed.accept(wallet,intent.id,copied);}catch(error){if(error instanceof HttpError&&['VEHICLE_SERVICE_SIGNED_INPUT','VEHICLE_SERVICE_SIGNED_WIRE','VEHICLE_SERVICE_SIGNED_CONFLICT'].includes(error.code??''))throw new HttpError(400,'Signed service consent is invalid',error.code);throw error;}
  return read(wallet,intent.id);
 }
 async function recover(wallet:string,id:string){
  const intent=await original(wallet,id);
  try{const preparation=await preparations.get(wallet,intent.id),wire=preparation?await signed.get(wallet,intent.id):null;await applications.recover(wallet,intent.id,wire?Buffer.from(wire.signedTransactionHex,'hex'):undefined);}
  catch(error){if(error instanceof HttpError)throw new HttpError(503,'Vehicle recovery is held; keep the original service intent','VEHICLE_SERVICE_RECOVERY_HELD',{intentId:intent.id,status:'held',signingAuthorized:false,broadcastAuthorized:false,serviceAuthorized:false,reservationReleaseAuthorized:false});throw error;}
  return read(wallet,intent.id);
 }
 return Object.freeze({reserve,readByKey,read,prepare,retainSigned,recover});
}
export type VehicleServiceWorkflowProvider=ReturnType<typeof createVehicleServiceWorkflow>;
