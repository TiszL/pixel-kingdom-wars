/** D-153.140: durable purpose-bound service consent, no transport or execution.
 * The committed original intent survives base transfer. New preparations verify
 * actual Core ownership and the unchanged installation state; saved artifacts
 * retain their original state even after a future legitimate service advances it. */
import {buildVehicleServiceBurnMessage,type VehicleServiceBurnMessageInput} from '@shardkeep/chain/vehicle-service-burn-message';
import type {VehicleBurnOwnerAnchor,VehicleServiceBurnSavedReservation} from '@shardkeep/chain/vehicle-service-burn-finality';
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
import {VehicleServiceStateSchema} from '@shardkeep/shared/phaseEVehicleService';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {phaseEVehiclesEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {readLockedVehicleLifecycle} from './vehicleLifecycle';
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),address=PhaseEVehicleMintIdentitySchema.shape.assetId,uuid=z.uuid().transform(v=>v.toLowerCase());
const hex=z.string().min(2).max(131072).regex(/^([0-9a-f]{2})+$/);
const Anchor=z.object({version:z.literal(1),wallet:address,identity:PhaseEVehicleMintIdentitySchema,slot:integer,genesisHash:address,reviewedDeploymentSlot:integer,reviewedProgramDataSha256:z.string().regex(/^[0-9a-f]{64}$/),assetDataHex:hex,collectionDataHex:hex}).strict();
const Blockhash=z.object({blockhash:address,lastValidBlockHeight:integer,contextSlot:integer}).strict();
const Plan=z.object({wallet:address,reservationId:uuid,identity:PhaseEVehicleMintIdentitySchema,blockhash:address,service:VehicleServiceStateSchema}).strict();
const Original=z.object({id:uuid,wallet:address,identity:PhaseEVehicleMintIdentitySchema,state:VehicleServiceStateSchema}).strict();
const Saved=z.object({intentId:uuid,wallet:address,plan:Plan,anchor:Anchor,messageHex:z.string().min(2).max(2334).regex(/^([0-9a-f]{2})+$/),messageSha256:z.string().regex(/^[0-9a-f]{64}$/),blockhashContextSlot:integer,lastValidBlockHeight:integer,recordedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)}).strict();
export interface VehicleServiceBurnPreparationDependencies {
 enabled?:()=>boolean;
 captureOwner?:(input:{wallet:string;identity:PhaseEVehicleMintIdentity})=>Promise<VehicleBurnOwnerAnchor>;
 getBlockhash?:()=>Promise<z.infer<typeof Blockhash>>;
}
export interface VehicleServiceBurnPreparation {
 intentId:string;wallet:string;plan:VehicleServiceBurnMessageInput;anchor:VehicleBurnOwnerAnchor;
 messageHex:string;messageSha256:string;blockhashContextSlot:number;lastValidBlockHeight:number;recordedAt:string;
 signingAuthorized:false;broadcastAuthorized:false;serviceAuthorized:false;reservationReleaseAuthorized:false;
}
const fail=(code:string):never=>{throw new HttpError(503,code,code);};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_service_burn_preparations'::regclass) allowed`);if(!r?.allowed)fail('VEHICLE_SERVICE_PREPARATION_OWNER');}
async function original(db:DbOrTx,id:string){
 const [r]=await db.execute<{value:unknown}>(sql`select jsonb_build_object('id',i.id,'wallet',i.wallet,'identity',jsonb_build_object('assetId',m.asset_id,'collection',m.collection,'family',m.family,'tier',m.tier),
 'state',jsonb_build_object('operation',i.operation,'installationId',i.installation_id,'baseId',i.base_id,'berthId',i.berth_id,'revision',i.revision,'family',i.family,'tier',i.tier,'completedTotal',i.completed_total::text,'allowanceStart',i.allowance_start::text)) value
 from public.vehicle_service_intents i join public.vehicle_mint_registry m on m.asset_id=i.asset_id where i.id=${id}`);
 if(!r)return null;
 try{const v=Original.parse(r.value);if(v.identity.family!==v.state.family||v.identity.tier!==v.state.tier||v.id===v.state.installationId)fail('VEHICLE_SERVICE_PREPARATION_SOURCE');return v;}catch{return fail('VEHICLE_SERVICE_PREPARATION_SOURCE');}
}
async function read(db:DbOrTx,id:string):Promise<VehicleServiceBurnPreparation|null>{
 const [r]=await db.execute<{value:unknown}>(sql`select jsonb_build_object('intentId',intent_id,'wallet',wallet,'plan',plan,'anchor',owner_anchor,'messageHex',encode(message_bytes,'hex'),'messageSha256',message_sha256,'blockhashContextSlot',blockhash_context_slot,'lastValidBlockHeight',last_valid_block_height,'recordedAt',to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) value from public.vehicle_service_burn_preparations where intent_id=${id}`);
 if(!r)return null;
 try{const value=Saved.parse(r.value),source=await original(db,id),built=buildVehicleServiceBurnMessage(value.plan),anchor=value.anchor;
  if(!source||value.intentId!==id||value.plan.reservationId!==id||value.wallet!==source.wallet||built.wallet!==source.wallet||!equal(value.plan.service,source.state)||!equal(value.plan.identity,source.identity)
   ||built.messageSha256!==value.messageSha256||Buffer.from(built.messageBytes).toString('hex')!==value.messageHex||anchor.wallet!==value.wallet||!equal(anchor.identity,source.identity)||anchor.slot>value.blockhashContextSlot||anchor.reviewedDeploymentSlot>anchor.slot)fail('VEHICLE_SERVICE_PREPARATION_SOURCE');
  return {...value,signingAuthorized:false,broadcastAuthorized:false,serviceAuthorized:false,reservationReleaseAuthorized:false};
 }catch{return fail('VEHICLE_SERVICE_PREPARATION_SOURCE');}
}
export function createVehicleServiceBurnPreparations(db:Db,dependencies:VehicleServiceBurnPreparationDependencies={}){
 if('rollback'in db)fail('VEHICLE_SERVICE_PREPARATION_TOP_LEVEL');
 const extra=dependencies.enabled,capture=dependencies.captureOwner,blockhashProvider=dependencies.getBlockhash;
 const gate=()=>{if(extra&&!extra()||!phaseEVehiclesEnabled())fail('VEHICLE_SERVICE_PREPARATION_DISABLED');};
 async function actor(wallet:string,id:string){wallet=address.parse(wallet);id=uuid.parse(id);await owner(db);const source=await original(db,id);if(!source||source.wallet!==wallet)fail('VEHICLE_SERVICE_PREPARATION_ACTOR');return source!;}
 async function get(wallet:string,id:string){const source=await actor(wallet,id);return read(db,source.id);}
 async function prepare(wallet:string,id:string):Promise<VehicleServiceBurnPreparation>{
  const source=await actor(wallet,id),saved=await read(db,source.id);if(saved)return saved;gate();if(!capture||!blockhashProvider)fail('VEHICLE_SERVICE_PREPARATION_UNAVAILABLE');
  let anchor:VehicleBurnOwnerAnchor,blockhash:z.infer<typeof Blockhash>;
  // Providers run without gameplay locks. Zod owns every nested retained field
  // before the next await; callbacks are closed over at construction.
  try{anchor=Anchor.parse(await capture!({wallet:source.wallet,identity:{...source.identity}}));blockhash=Blockhash.parse(await blockhashProvider!());}catch{return fail('VEHICLE_SERVICE_PREPARATION_UNAVAILABLE');}
  if(anchor.wallet!==source.wallet||!equal(anchor.identity,source.identity)||anchor.slot>blockhash.contextSlot||anchor.reviewedDeploymentSlot>anchor.slot)fail('VEHICLE_SERVICE_PREPARATION_SOURCE');
  const plan=Plan.parse({wallet:source.wallet,reservationId:source.id,identity:source.identity,blockhash:blockhash.blockhash,service:source.state}),built=buildVehicleServiceBurnMessage(plan);
  return db.transaction(async tx=>{
   await tx.execute(sql`select reservation_id from public.advanced_vehicle_installations where reservation_id=${source.state.installationId} for update`);
   await tx.execute(sql`select id from public.vehicle_service_intents where id=${source.id} for update`);
   const winner=await read(tx,source.id);if(winner)return winner;
   if(!equal(await original(tx,source.id),source))fail('VEHICLE_SERVICE_PREPARATION_SOURCE');
   const current=await readLockedVehicleLifecycle(tx,source.state.installationId);
   if(!current||current.pendingIntentId!==source.id||current.away||current.baseId!==source.state.baseId||current.berthId!==source.state.berthId
    ||current.family!==source.state.family||current.tier!==source.state.tier||current.revision!==source.state.revision
    ||String(current.completedTotal)!==source.state.completedTotal||String(current.allowanceStart)!==source.state.allowanceStart)fail('VEHICLE_SERVICE_PREPARATION_STATE');
   gate();
   await tx.execute(sql`insert into public.vehicle_service_burn_preparations(intent_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${source.id},${JSON.stringify(plan)}::jsonb,${JSON.stringify(anchor)}::jsonb,${Buffer.from(built.messageBytes)},${blockhash.contextSlot},${blockhash.lastValidBlockHeight})`);
   const result=await read(tx,source.id);gate();return result??fail('VEHICLE_SERVICE_PREPARATION_SOURCE');
  });
 }
 async function loadSavedReservation(id:string):Promise<VehicleServiceBurnSavedReservation|null>{id=uuid.parse(id);await owner(db);const saved=await read(db,id);return saved?{plan:saved.plan,preparedMessageBytes:Uint8Array.from(Buffer.from(saved.messageHex,'hex')),anchor:saved.anchor}:null;}
 return Object.freeze({prepare,get,loadSavedReservation});
}
