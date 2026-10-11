/** D-153.131 private owner composition. No mint registration, signing, relay or
 * reservation release capability is exposed. Registry provenance is attested. */
import {createVehicleBurnFinalityReader,type VehicleBurnCoreTrust,type VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {phaseEVehiclesEnabled} from '../config';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import type {FinalizedDeedReader} from './baseOwnership';
import {createVehicleActivationReservations} from './vehicleActivationReservations';
import {createVehicleAdmission} from './vehicleAdmission';
import {createVehicleBurnPreparations,type VehicleBurnPreparationDependencies} from './vehicleBurnPreparations';
import {createVehicleBurnSignedStore} from './vehicleBurnSignedStore';
import {createVehicleInstallations} from './vehicleInstallations';
export interface VehicleWorkflowDependencies {
 connect?:(signal:AbortSignal)=>VehicleBurnFinalityRpc;
 trust?:VehicleBurnCoreTrust;
 getBlockhash?:VehicleBurnPreparationDependencies['getBlockhash'];
 finalizedDeedReader?:FinalizedDeedReader|null;
 deedCollection?:string|null;
}
const unknown=():never=>{throw new HttpError(404,'Vehicle reservation not found','VEHICLE_RESERVATION_UNKNOWN');};
export function createVehicleWorkflow(db:Db,deps:VehicleWorkflowDependencies={}){
 const reservations=createVehicleActivationReservations(db),loader=createVehicleBurnPreparations(db),connect=deps.connect;
 const reader=connect&&deps.trust?createVehicleBurnFinalityReader(connect,{...deps.trust},loader.loadSavedReservation):null;
 const ownership={finalizedDeedReader:deps.finalizedDeedReader??null,deedCollection:deps.deedCollection??null};
 const admission=createVehicleAdmission(db,{...ownership,enabled:phaseEVehiclesEnabled,...reader?{captureOwner:reader.captureOwner}:{}});
 const preparations=createVehicleBurnPreparations(db,{enabled:phaseEVehiclesEnabled,...reader?{captureOwner:reader.captureOwner}:{},...deps.getBlockhash?{getBlockhash:deps.getBlockhash}:{}});
 const signed=createVehicleBurnSignedStore(db),installations=createVehicleInstallations(db,reader?{verifyBurn:reader.verify}:{});
 async function original(wallet:string,id:string){const value=await reservations.get(id);if(!value||value.wallet!==wallet)return unknown();return value;}
 async function read(wallet:string,id:string){
  const reservation=await original(wallet,id),preparation=await preparations.get(wallet,id),wire=preparation?await signed.get(wallet,id):null,installation=preparation?await installations.get(wallet,id):null;
  return {reservation,preparation,signed:wire,installation,status:installation?'installed' as const:wire?'signed' as const:preparation?'prepared' as const:'reserved' as const,
   signingAuthorized:false as const,broadcastAuthorized:false as const,reservationReleaseAuthorized:false as const};
 }
 async function readByKey(wallet:string,key:string){const value=await reservations.getByKey(wallet,key);return value?read(wallet,value.id):unknown();}
 async function reserve(wallet:string,input:Omit<Parameters<typeof admission.admit>[0],'wallet'>){const r=await admission.admit({...input,wallet});return read(wallet,r.id);}
 async function prepare(wallet:string,id:string){await original(wallet,id);await preparations.prepare(wallet,id);return read(wallet,id);}
 async function retainSigned(wallet:string,id:string,bytes:Uint8Array){const copied=Uint8Array.from(bytes);await original(wallet,id);try{await signed.accept(wallet,id,copied);}catch(error){if(error instanceof HttpError&&['VEHICLE_SIGNED_INPUT','VEHICLE_SIGNED_WIRE','VEHICLE_SIGNED_CONFLICT'].includes(error.code??''))throw new HttpError(400,'Signed vehicle consent is invalid',error.code);throw error;}return read(wallet,id);}
 async function recover(wallet:string,id:string){
  await original(wallet,id);
  try{const wire=await signed.get(wallet,id);await installations.recover(wallet,id,wire?Buffer.from(wire.signedTransactionHex,'hex'):undefined);}
  catch(error){if(error instanceof HttpError)throw new HttpError(503,'Vehicle recovery is held; keep the original reservation','VEHICLE_RECOVERY_HELD',{reservationId:id,status:'held',reservationReleaseAuthorized:false,broadcastAuthorized:false});throw error;}
  return read(wallet,id);
 }
 return Object.freeze({reserve,readByKey,read,prepare,retainSigned,recover});
}
export type VehicleWorkflowProvider=ReturnType<typeof createVehicleWorkflow>;
