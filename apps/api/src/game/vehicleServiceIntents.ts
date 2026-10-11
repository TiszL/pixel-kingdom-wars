/** D-153.137 private intent only: no signing, service application or release.
 * Registry identity is owner-attested; actual Core ownership and current base
 * authority are independently read before a new permanent reservation. */
import type {VehicleBurnOwnerAnchor} from '@shardkeep/chain/vehicle-burn-finality';
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
import {VehicleServiceStateSchema,vehicleServiceTransition} from '@shardkeep/shared/phaseEVehicleService';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {phaseEVehiclesEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {lockStablePrerequisiteBase} from './stableBasePrerequisites';
import {readLockedVehicleLifecycle} from './vehicleLifecycle';
const address=PhaseEVehicleMintIdentitySchema.shape.assetId,uuid=z.uuid().transform(v=>v.toLowerCase()),key=z.string().min(1).max(128);
const Request=z.object({wallet:address,installationId:uuid,assetId:address,operation:z.enum(['upgrade','restore_uses']),idempotencyKey:key}).strict();
const number=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),hex=z.string().min(2).max(131072).regex(/^([0-9a-f]{2})+$/);
const Anchor=z.object({version:z.literal(1),wallet:address,identity:PhaseEVehicleMintIdentitySchema,slot:number,genesisHash:address,reviewedDeploymentSlot:number,reviewedProgramDataSha256:z.string().regex(/^[0-9a-f]{64}$/),assetDataHex:hex,collectionDataHex:hex}).strict();
const Saved=z.object({id:uuid,wallet:address,idempotencyKey:key,identity:PhaseEVehicleMintIdentitySchema,state:VehicleServiceStateSchema,reservedAt:z.string()}).strict();
export interface VehicleServiceIntentDependencies {
 enabled?:()=>boolean;
 captureOwner?:(input:{wallet:string;identity:PhaseEVehicleMintIdentity})=>Promise<VehicleBurnOwnerAnchor>;
 finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null;
}
export type VehicleServiceIntent=z.infer<typeof Saved>&{transition:ReturnType<typeof vehicleServiceTransition>;signingAuthorized:false;broadcastAuthorized:false;serviceAuthorized:false;reservationReleaseAuthorized:false};
const fail=(code:string):never=>{throw new HttpError(code==='VEHICLE_SERVICE_CONFLICT'?409:503,code,code);};
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_service_intents'::regclass) allowed`);if(!r?.allowed)fail('VEHICLE_SERVICE_OWNER');}
const projection=sql`jsonb_build_object('id',i.id,'wallet',i.wallet,'idempotencyKey',i.idempotency_key,'identity',jsonb_build_object('assetId',m.asset_id,'collection',m.collection,'family',m.family,'tier',m.tier),
 'state',jsonb_build_object('operation',i.operation,'installationId',i.installation_id,'baseId',i.base_id,'berthId',i.berth_id,'revision',i.revision,'family',i.family,'tier',i.tier,'completedTotal',i.completed_total::text,'allowanceStart',i.allowance_start::text),
 'reservedAt',to_char(i.reserved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`;
function decode(raw:unknown):VehicleServiceIntent{const saved=Saved.parse(raw);if(saved.identity.family!==saved.state.family||saved.identity.tier!==saved.state.tier)fail('VEHICLE_SERVICE_SOURCE');return {...saved,transition:vehicleServiceTransition(saved.state),signingAuthorized:false,broadcastAuthorized:false,serviceAuthorized:false,reservationReleaseAuthorized:false};}
async function prior(db:DbOrTx,wallet:string,idempotencyKey:string){const [r]=await db.execute<{value:unknown}>(sql`select ${projection} value from public.vehicle_service_intents i join public.vehicle_mint_registry m on m.asset_id=i.asset_id where i.wallet=${wallet} and i.idempotency_key=${idempotencyKey}`);return r?decode(r.value):null;}
function replay(saved:VehicleServiceIntent,input:z.infer<typeof Request>){if(saved.identity.assetId!==input.assetId||saved.state.installationId!==input.installationId||saved.state.operation!==input.operation)fail('VEHICLE_SERVICE_CONFLICT');return saved;}
function translate(error:unknown):never{let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){if('code'in cause&&cause.code==='55P03')fail('VEHICLE_SERVICE_BUSY');cause='cause'in cause?cause.cause:undefined;}throw error;}
export function createVehicleServiceIntents(db:Db,dependencies:VehicleServiceIntentDependencies={}){
 if('rollback'in db)fail('VEHICLE_SERVICE_TOP_LEVEL');
 const extra=dependencies.enabled,capture=dependencies.captureOwner,deedReader=dependencies.finalizedDeedReader??null,collection=dependencies.deedCollection??null;
 const gate=()=>{if(extra&&!extra()||!phaseEVehiclesEnabled())fail('VEHICLE_SERVICE_DISABLED');};
 async function get(wallet:string,id:string){wallet=address.parse(wallet);id=uuid.parse(id);await owner(db);const [r]=await db.execute<{value:unknown}>(sql`select ${projection} value from public.vehicle_service_intents i join public.vehicle_mint_registry m on m.asset_id=i.asset_id where i.wallet=${wallet} and i.id=${id}`);return r?decode(r.value):null;}
 async function getByKey(wallet:string,idempotencyKey:string){wallet=address.parse(wallet);idempotencyKey=key.parse(idempotencyKey);await owner(db);return prior(db,wallet,idempotencyKey);}
 async function reserve(value:z.infer<typeof Request>):Promise<VehicleServiceIntent>{
  const input=Request.parse(value);await owner(db);const old=await prior(db,input.wallet,input.idempotencyKey);if(old)return replay(old,input);gate();if(!capture)fail('VEHICLE_SERVICE_UNAVAILABLE');
  const [installation]=await db.execute<{base_id:string;family:string}>(sql`select base_id,family from public.advanced_vehicle_installations where reservation_id=${input.installationId}`);if(!installation)fail('VEHICLE_SERVICE_INSTALLATION');
  const [row]=await db.execute<{identity:unknown}>(sql`select jsonb_build_object('assetId',asset_id,'collection',collection,'family',family,'tier',tier) identity from public.vehicle_mint_registry where asset_id=${input.assetId}`);if(!row)fail('VEHICLE_SERVICE_REGISTRY');const identity=PhaseEVehicleMintIdentitySchema.parse(row!.identity);
  // Only family is immutable on the original installation. Current tier is
  // checked under its mutex after ownership prefetch, never against the old tier.
  if(identity.family!==installation!.family)fail('VEHICLE_SERVICE_IDENTITY');
  let anchor:VehicleBurnOwnerAnchor;try{anchor=Anchor.parse(await capture!({wallet:input.wallet,identity:{...identity}}));}catch{return fail('VEHICLE_SERVICE_UNAVAILABLE');}
  if(anchor.wallet!==input.wallet||JSON.stringify(anchor.identity)!==JSON.stringify(identity)||anchor.reviewedDeploymentSlot>anchor.slot)fail('VEHICLE_SERVICE_SOURCE');
  const baseId=installation!.base_id;await requireFreshBaseAuthority(db,input.wallet,baseId,deedReader,collection);
  try{return await db.transaction(async tx=>{
   await tx.execute(sql`select wallet from public.players where wallet=${input.wallet} for update nowait`);
   await lockStablePrerequisiteBase(tx,input.wallet,{baseId,assertAuthority:async(t,w,id)=>{await assertFreshLockedBaseAuthority(t,w,id);}});
   const winner=await prior(tx,input.wallet,input.idempotencyKey);if(winner)return replay(winner,input);gate();
   const lifecycle=await readLockedVehicleLifecycle(tx,input.installationId);
   if(!lifecycle||lifecycle.baseId!==baseId)fail('VEHICLE_SERVICE_INSTALLATION');
   if(identity.family!==lifecycle!.family||identity.tier!==lifecycle!.tier)fail('VEHICLE_SERVICE_IDENTITY');
   await tx.execute(sql`select asset_id from public.vehicle_mint_registry where asset_id=${input.assetId} for update nowait`);
   const [held]=await tx.execute<{held:boolean}>(sql`select exists(select 1 from vehicle_activation_reservations where asset_id=${input.assetId}) or exists(select 1 from vehicle_service_intents where asset_id=${input.assetId}) held`);if(held?.held||lifecycle!.pendingIntentId!==null)fail('VEHICLE_SERVICE_RESERVED');
   if(lifecycle!.away)fail('VEHICLE_SERVICE_AWAY');
   vehicleServiceTransition(VehicleServiceStateSchema.parse({operation:input.operation,installationId:lifecycle!.installationId,baseId:lifecycle!.baseId,berthId:lifecycle!.berthId,revision:lifecycle!.revision,family:lifecycle!.family,tier:lifecycle!.tier,completedTotal:String(lifecycle!.completedTotal),allowanceStart:String(lifecycle!.allowanceStart)}));
   await tx.execute(sql`insert into public.vehicle_service_intents(wallet,idempotency_key,installation_id,asset_id,operation) values(${input.wallet},${input.idempotencyKey},${input.installationId},${input.assetId},${input.operation})`);
   const saved=await prior(tx,input.wallet,input.idempotencyKey);if(!saved)fail('VEHICLE_SERVICE_SOURCE');await assertFreshLockedBaseAuthority(tx,input.wallet,baseId);gate();return saved!;
  });}catch(error){return translate(error);}
 }
 return Object.freeze({reserve,get,getByKey});
}
