/** D-153.126: only the owner capability supplies chain providers. A saved plan is
 * replayable consent, never current signing/broadcast/install/release authority.
 * Independent mint-proof admission remains open. No HTTP or transport here. */
import {buildVehicleBurnMessage,type VehicleBurnMessageInput} from '@shardkeep/chain/vehicle-burn-message';
import type {VehicleBurnOwnerAnchor,VehicleBurnSavedReservation} from '@shardkeep/chain/vehicle-burn-finality';
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {createVehicleActivationReservations} from './vehicleActivationReservations';
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),address=PhaseEVehicleMintIdentitySchema.shape.assetId;
const hex=z.string().min(2).max(131072).regex(/^([0-9a-f]{2})+$/);
const Anchor=z.object({version:z.literal(1),wallet:address,identity:PhaseEVehicleMintIdentitySchema,slot:integer,genesisHash:address,reviewedDeploymentSlot:integer,reviewedProgramDataSha256:z.string().regex(/^[0-9a-f]{64}$/),assetDataHex:hex,collectionDataHex:hex}).strict();
const Blockhash=z.object({blockhash:address,lastValidBlockHeight:integer,contextSlot:integer}).strict();
export interface VehicleBurnPreparationDependencies {
 enabled?:()=>boolean;
 captureOwner?:(input:{wallet:string;identity:PhaseEVehicleMintIdentity})=>Promise<VehicleBurnOwnerAnchor>;
 getBlockhash?:()=>Promise<z.infer<typeof Blockhash>>;
}
export interface VehicleBurnPreparation {
 reservationId:string;wallet:string;plan:VehicleBurnMessageInput;anchor:VehicleBurnOwnerAnchor;
 messageHex:string;messageSha256:string;blockhashContextSlot:number;lastValidBlockHeight:number;recordedAt:string;
 signingAuthorized:false;broadcastAuthorized:false;reservationReleaseAuthorized:false;
}
const fail=(code:string):never=>{throw new HttpError(503,code,code);};
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_burn_preparations'::regclass) allowed`);if(!r?.allowed)fail('VEHICLE_PREPARATION_OWNER');}
async function read(db:DbOrTx,id:string):Promise<VehicleBurnPreparation|null>{
 const [row]=await db.execute<{value:VehicleBurnPreparation}>(sql`select jsonb_build_object('reservationId',reservation_id,'wallet',wallet,'plan',plan,'anchor',owner_anchor,'messageHex',encode(message_bytes,'hex'),'messageSha256',message_sha256,'blockhashContextSlot',blockhash_context_slot,'lastValidBlockHeight',last_valid_block_height,'recordedAt',to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'signingAuthorized',false,'broadcastAuthorized',false,'reservationReleaseAuthorized',false) value from public.vehicle_burn_preparations where reservation_id=${id}`);
 if(!row)return null;const value=row.value;
 try{const rebuilt=buildVehicleBurnMessage(value.plan),anchor=Anchor.parse(value.anchor);integer.parse(value.blockhashContextSlot);integer.parse(value.lastValidBlockHeight);
  if(rebuilt.reservationId!==id||rebuilt.wallet!==value.wallet||rebuilt.messageSha256!==value.messageSha256||Buffer.from(rebuilt.messageBytes).toString('hex')!==value.messageHex||anchor.wallet!==value.wallet||JSON.stringify(anchor.identity)!==JSON.stringify(rebuilt.identity)||anchor.slot>value.blockhashContextSlot||anchor.reviewedDeploymentSlot>anchor.slot)fail('VEHICLE_PREPARATION_SOURCE');
  return {...value,plan:{wallet:rebuilt.wallet,reservationId:id,identity:{...rebuilt.identity},blockhash:rebuilt.blockhash},anchor};
 }catch{ return fail('VEHICLE_PREPARATION_SOURCE');}
}
export function createVehicleBurnPreparations(db:Db,dependencies:VehicleBurnPreparationDependencies={}){
 if('rollback'in db)fail('VEHICLE_PREPARATION_TOP_LEVEL');
 const reservations=createVehicleActivationReservations(db),enabled=dependencies.enabled??(()=>false),capture=dependencies.captureOwner,blockhashProvider=dependencies.getBlockhash;
 async function original(wallet:string,id:string){id=z.uuid().parse(id);wallet=address.parse(wallet);await owner(db);const reservation=await reservations.get(id);if(!reservation||reservation.wallet!==wallet)fail('VEHICLE_PREPARATION_ACTOR');return reservation!;}
 async function get(wallet:string,id:string){const reservation=await original(wallet,id);return read(db,reservation.id);}
 async function prepare(wallet:string,id:string):Promise<VehicleBurnPreparation>{
  const reservation=await original(wallet,id),saved=await read(db,reservation.id);if(saved)return saved;
  if(!enabled())fail('VEHICLE_PREPARATION_DISABLED');if(!capture||!blockhashProvider)fail('VEHICLE_PREPARATION_UNAVAILABLE');
  const [registry]=await db.execute<{collection:string}>(sql`select collection from public.vehicle_mint_registry where asset_id=${reservation.assetId}`);if(!registry)fail('VEHICLE_PREPARATION_SOURCE');
  const identity=PhaseEVehicleMintIdentitySchema.parse({assetId:reservation.assetId,collection:registry!.collection,family:reservation.family,tier:reservation.tier});
  let anchor:VehicleBurnOwnerAnchor,blockhash:z.infer<typeof Blockhash>;
  // No transaction or gameplay locks exist during provider work. Copy returned
  // facts before the next await so a provider cannot mutate retained evidence.
  try{anchor=Anchor.parse(await capture!({wallet,identity:{...identity}}));blockhash=Blockhash.parse(await blockhashProvider!());}catch{return fail('VEHICLE_PREPARATION_UNAVAILABLE');}
  if(anchor.wallet!==wallet||JSON.stringify(anchor.identity)!==JSON.stringify(identity)||anchor.slot>blockhash.contextSlot||anchor.reviewedDeploymentSlot>anchor.slot)fail('VEHICLE_PREPARATION_SOURCE');
  const plan:VehicleBurnMessageInput={wallet,reservationId:reservation.id,identity,blockhash:blockhash.blockhash},built=buildVehicleBurnMessage(plan);
  return db.transaction(async tx=>{
   await tx.execute(sql`select id from public.vehicle_activation_reservations where id=${reservation.id} for update`);
   const winner=await read(tx,reservation.id);if(winner)return winner;
   if(!enabled())fail('VEHICLE_PREPARATION_DISABLED');
   await tx.execute(sql`insert into public.vehicle_burn_preparations(reservation_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${reservation.id},${JSON.stringify(plan)}::jsonb,${JSON.stringify(anchor)}::jsonb,${Buffer.from(built.messageBytes)},${blockhash.contextSlot},${blockhash.lastValidBlockHeight})`);
   if(!enabled())fail('VEHICLE_PREPARATION_DISABLED');return (await read(tx,reservation.id))??fail('VEHICLE_PREPARATION_SOURCE');
  });
 }
 async function loadSavedReservation(id:string):Promise<VehicleBurnSavedReservation|null>{id=z.uuid().parse(id);await owner(db);const saved=await read(db,id);return saved?{plan:saved.plan,preparedMessageBytes:Uint8Array.from(Buffer.from(saved.messageHex,'hex')),anchor:saved.anchor}:null;}
 return Object.freeze({prepare,get,loadSavedReservation});
}
