/** D-153.129 DARK application capability. Registry provenance distinguishes
 * legacy owner attestations from private finalized issuance acquisitions. Current Core ownership admits only a permanent reservation;
 * preparation independently captures ownership again before exposing consent. */
import type {VehicleBurnOwnerAnchor} from '@shardkeep/chain/vehicle-burn-finality';
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {createVehicleActivationReservations,type VehicleActivationReservation} from './vehicleActivationReservations';
const address=PhaseEVehicleMintIdentitySchema.shape.assetId,uuid=z.uuid().transform(v=>v.toLowerCase());
const request=z.object({wallet:address,baseId:uuid,assetId:address,berthId:uuid,idempotencyKey:z.string().min(1).max(128)}).strict();
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),hex=z.string().min(2).max(131072).regex(/^([0-9a-f]{2})+$/);
const Anchor=z.object({version:z.literal(1),wallet:address,identity:PhaseEVehicleMintIdentitySchema,slot:integer,genesisHash:address,reviewedDeploymentSlot:integer,reviewedProgramDataSha256:z.string().regex(/^[0-9a-f]{64}$/),assetDataHex:hex,collectionDataHex:hex}).strict();
export interface VehicleAdmissionDependencies {
 enabled?:()=>boolean;
 /** Private actual finalized Core reader, never supplied by an HTTP command. */
 captureOwner?:(input:{wallet:string;identity:PhaseEVehicleMintIdentity})=>Promise<VehicleBurnOwnerAnchor>;
 finalizedDeedReader?:FinalizedDeedReader|null;
 deedCollection?:string|null;
}
const fail=(code:string):never=>{throw new HttpError(code==='VEHICLE_IDEMPOTENCY_CONFLICT'?409:503,code,code);};
export function createVehicleAdmission(db:Db,dependencies:VehicleAdmissionDependencies={}){
 if('rollback'in db)fail('VEHICLE_ADMISSION_TOP_LEVEL');
 const enabled=dependencies.enabled??(()=>false),capture=dependencies.captureOwner,deedReader=dependencies.finalizedDeedReader??null,collection=dependencies.deedCollection??null;
 const gate=()=>{if(!enabled())fail('VEHICLE_ADMISSION_DISABLED');};
 const reservations=createVehicleActivationReservations(db,{assertNewReservation:gate});
 async function admit(value:z.infer<typeof request>):Promise<VehicleActivationReservation>{
  const input=request.parse(value);
  const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_activation_reservations'::regclass) allowed`);if(!owner?.allowed)fail('VEHICLE_ADMISSION_OWNER');
  // Immutable exact replay precedes all current gates, providers and ownership.
  const [prior]=await db.execute<{id:string}>(sql`select id from public.vehicle_activation_reservations where wallet=${input.wallet} and idempotency_key=${input.idempotencyKey}`);
  if(prior){const saved=await reservations.get(prior.id);if(!saved||saved.assetId!==input.assetId||saved.berthId!==input.berthId||saved.baseId!==input.baseId)fail('VEHICLE_IDEMPOTENCY_CONFLICT');return saved!;}
  gate();if(!capture)fail('VEHICLE_ADMISSION_UNAVAILABLE');
  const [row]=await db.execute<{identity:PhaseEVehicleMintIdentity}>(sql`select jsonb_build_object('assetId',asset_id,'collection',collection,'family',family,'tier',tier) identity from public.vehicle_mint_registry where asset_id=${input.assetId}`);if(!row)fail('VEHICLE_ADMISSION_REGISTRY');
  const identity=PhaseEVehicleMintIdentitySchema.parse(row!.identity);
  let raw:VehicleBurnOwnerAnchor;try{raw=await capture!({wallet:input.wallet,identity:{...identity}});}catch{return fail('VEHICLE_ADMISSION_UNAVAILABLE');}
  // Parse/copy and bind before any other awaited operation. This callback is a
  // configured verifier, not caller evidence or independently proven minting.
  let anchor:VehicleBurnOwnerAnchor;try{anchor=Anchor.parse(raw);}catch{return fail('VEHICLE_ADMISSION_SOURCE');}
  if(anchor.wallet!==input.wallet||JSON.stringify(anchor.identity)!==JSON.stringify(identity)||anchor.reviewedDeploymentSlot>anchor.slot)fail('VEHICLE_ADMISSION_SOURCE');
  await requireFreshBaseAuthority(db,input.wallet,input.baseId,deedReader,collection);
  return reservations.reserve({wallet:input.wallet,assetId:input.assetId,berthId:input.berthId,idempotencyKey:input.idempotencyKey},{baseId:input.baseId,assertAuthority:async(tx,wallet,id)=>{await assertFreshLockedBaseAuthority(tx,wallet,id);}});
 }
 return Object.freeze({admit});
}
