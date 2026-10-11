/** D-153.124 DARK owner capability. The legacy register method records owner attestations;
 * D153.207 finalized issuance uses its separate private acquisition bridge. Reservations return
 * metadata only: no messages, burn/install authority, cancellation or release. */
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from './stableBasePrerequisites';
const uuid=z.uuid().transform(v=>v.toLowerCase());
const request=z.object({wallet:z.string().min(1).max(128),assetId:PhaseEVehicleMintIdentitySchema.shape.assetId,berthId:uuid,idempotencyKey:z.string().min(1).max(128)}).strict();
type Request=z.infer<typeof request>;
export interface VehicleActivationReservation {id:string;wallet:string;idempotencyKey:string;assetId:string;baseId:string;berthId:string;family:string;tier:number;completedBuildJobId:string;berthCompletedAt:string;reservedAt:string}
const fail=(code:string):never=>{throw new HttpError(code==='VEHICLE_BUSY'?503:409,code,code);};
async function owner(db:DbOrTx){const [row]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_activation_reservations'::regclass) allowed`);if(!row?.allowed)fail('VEHICLE_OWNER_REQUIRED');}
const projection=sql`jsonb_build_object('id',id,'wallet',wallet,'idempotencyKey',idempotency_key,'assetId',asset_id,'baseId',base_id,'berthId',berth_id,'family',family,'tier',tier,'completedBuildJobId',completed_build_job_id,'berthCompletedAt',to_char(berth_completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'reservedAt',to_char(reserved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`;
async function prior(db:DbOrTx,input:Request){const [row]=await db.execute<{value:VehicleActivationReservation}>(sql`select ${projection} value from public.vehicle_activation_reservations where wallet=${input.wallet} and idempotency_key=${input.idempotencyKey}`);return row?.value??null;}
function replay(row:VehicleActivationReservation,input:Request,baseId:string){if(row.assetId!==input.assetId||row.berthId!==input.berthId||row.baseId!==baseId)fail('VEHICLE_IDEMPOTENCY_CONFLICT');return row;}
function translate(error:unknown):never {let cause=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){if('code'in cause&&cause.code==='55P03')fail('VEHICLE_BUSY');cause='cause'in cause?cause.cause:undefined;}throw error;}
export function createVehicleActivationReservations(db:Db,dependencies:{assertNewReservation?:()=>void}={}){
 const assertNewReservation=dependencies.assertNewReservation;
 if('rollback'in db)fail('VEHICLE_TOP_LEVEL_REQUIRED');
 async function register(value:PhaseEVehicleMintIdentity,ownerAttestation:Record<string,unknown>):Promise<void>{
  const identity=PhaseEVehicleMintIdentitySchema.parse(value),attestation=JSON.stringify(z.record(z.string(),z.unknown()).parse(ownerAttestation));
  if(Buffer.byteLength(attestation)>65536)fail('VEHICLE_ATTESTATION_TOO_LARGE');await owner(db);
  await db.transaction(async tx=>{
   await tx.execute(sql`insert into public.vehicle_mint_registry(asset_id,collection,family,tier,owner_attestation) values(${identity.assetId},${identity.collection},${identity.family},${identity.tier},${attestation}::jsonb) on conflict(asset_id) do nothing`);
   const [same]=await tx.execute(sql`select asset_id from public.vehicle_mint_registry where asset_id=${identity.assetId} and collection=${identity.collection} and family=${identity.family} and tier=${identity.tier} and provenance='owner_attestation' and issuance_root is null and owner_attestation=${attestation}::jsonb`);if(!same)fail('VEHICLE_REGISTRY_CONFLICT');
  });
 }
 async function get(id:string):Promise<VehicleActivationReservation|null>{id=uuid.parse(id);await owner(db);const [row]=await db.execute<{value:VehicleActivationReservation}>(sql`select ${projection} value from public.vehicle_activation_reservations where id=${id}`);return row?.value??null;}
 async function getByKey(wallet:string,idempotencyKey:string):Promise<VehicleActivationReservation|null>{
  wallet=PhaseEVehicleMintIdentitySchema.shape.assetId.parse(wallet);idempotencyKey=z.string().min(1).max(128).parse(idempotencyKey);await owner(db);
  const [row]=await db.execute<{value:VehicleActivationReservation}>(sql`select ${projection} value from public.vehicle_activation_reservations where wallet=${wallet} and idempotency_key=${idempotencyKey}`);return row?.value??null;
 }
 async function reserve(value:Request,context:StableBaseMutationContext):Promise<VehicleActivationReservation>{
  const input=request.parse(value),authority={baseId:uuid.parse(context.baseId),assertAuthority:context.assertAuthority};await owner(db);
  // Historical replay does not authorize a new burn or require today's buyer to
  // impersonate the original actor. New work still uses locked current authority.
  const old=await prior(db,input);if(old)return replay(old,input,authority.baseId);
  try{return await db.transaction(async tx=>{
   await tx.execute(sql`select wallet from public.players where wallet=${input.wallet} for update nowait`);
   await lockStablePrerequisiteBase(tx,input.wallet,authority);
   const again=await prior(tx,input);if(again)return replay(again,input,authority.baseId);
   assertNewReservation?.();
   await tx.execute(sql`insert into public.vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${input.wallet},${input.idempotencyKey},${input.assetId},${authority.baseId},${input.berthId})`);
   assertNewReservation?.();
   const saved=await prior(tx,input);return saved??fail('VEHICLE_RESERVATION_MISSING');
  });}catch(error){return translate(error);}
 }
 return Object.freeze({register,reserve,get,getByKey});
}
