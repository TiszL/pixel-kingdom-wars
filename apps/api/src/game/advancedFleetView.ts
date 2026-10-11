/** D-153.144: current custody sees vehicle state, not a previous actor's consent.
 * Reads never complete trips or authorize gameplay from elapsed time. */
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import {AdvancedFleetRequestSchema,AdvancedFleetEnvelopeSchema,type AdvancedFleetEnvelope,type AdvancedFleetVehicle} from '@shardkeep/shared/advancedFleetApi';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';
import {phaseEVehiclesEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {readLockedVehicleLifecycle} from './vehicleLifecycle';
const unavailable=(code:string):never=>{throw new HttpError(503,'Advanced fleet is temporarily unavailable',code);};
const missing=():never=>{throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');};
function busy(error:unknown){let value=error;for(let n=0;n<8&&value&&typeof value==='object';n++){if('code'in value&&value.code==='55P03')return true;value='cause'in value?value.cause:undefined;}return false;}
export function createAdvancedFleetView(db:Db,dependencies:{finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null}={}){
 if('rollback'in db)unavailable('ADVANCED_FLEET_TOP_LEVEL');const reader=dependencies.finalizedDeedReader??null,collection=dependencies.deedCollection??null;
 async function read(wallet:string,baseId:string):Promise<AdvancedFleetEnvelope>{
  wallet=PhaseEVehicleMintIdentitySchema.shape.assetId.parse(wallet);baseId=AdvancedFleetRequestSchema.parse({baseId}).baseId;
  const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_vehicle_installations'::regclass) allowed`);if(!owner?.allowed)unavailable('ADVANCED_FLEET_OWNER');
  await requireFreshBaseAuthority(db,wallet,baseId,reader,collection);
  try{return await db.transaction(async tx=>{
   const [player]=await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);if(!player)missing();
   const [base]=await tx.execute(sql`select id from public.bases where id=${baseId} and owner_wallet=${wallet} and status='active' for update`);if(!base)missing();
   const [slot]=await tx.execute(sql`select base_id from public.base_slots where base_id=${baseId} and wallet=${wallet} and active for update`);if(!slot)missing();
   await assertFreshLockedBaseAuthority(tx,wallet,baseId);
   // A committed initial burn with its installation missing must not look empty.
   const [broken]=await tx.execute<{broken:boolean}>(sql`select exists(select 1 from public.vehicle_burn_consumptions c join public.vehicle_activation_reservations r on r.id=c.reservation_id left join public.advanced_vehicle_installations i on i.reservation_id=r.id and i.base_id=r.base_id where r.base_id=${baseId} and i.reservation_id is null) broken`);
   if(broken?.broken)unavailable('ADVANCED_FLEET_HELD');
   const ids=await tx.execute<{reservation_id:string}>(sql`select reservation_id from public.advanced_vehicle_installations where base_id=${baseId} order by reservation_id limit ${PHASE_E_VEHICLES.advancedFamilyCount+1}`);
   if(ids.length>PHASE_E_VEHICLES.advancedFamilyCount)unavailable('ADVANCED_FLEET_HELD');
   const vehicles:AdvancedFleetVehicle[]=[];
   for(const {reservation_id:id} of ids){
    let current;try{current=await readLockedVehicleLifecycle(tx,id);}catch(error){unavailable(busy(error)?'ADVANCED_FLEET_BUSY':'ADVANCED_FLEET_HELD');}
    if(!current||current.baseId!==baseId)unavailable('ADVANCED_FLEET_HELD');
    // The writer's projection allows its own in-progress atomic half-pair. This
    // separate top-level reader must reject any already committed incomplete pair.
    const [half]=await tx.execute<{broken:boolean}>(sql`select exists(select 1 from public.vehicle_service_intents s left join public.vehicle_service_consumptions c on c.intent_id=s.id left join public.vehicle_service_applications a on a.intent_id=s.id where s.installation_id=${id} and ((c.intent_id is null)<>(a.intent_id is null))) broken`);
    if(half?.broken)unavailable('ADVANCED_FLEET_HELD');
    vehicles.push({installationId:current!.installationId,berthId:current!.berthId,family:current!.family,tier:current!.tier,revision:current!.revision,
     completedTotal:String(current!.completedTotal),allowanceStart:String(current!.allowanceStart),remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall-Number(current!.completedTotal-current!.allowanceStart),away:current!.away,pendingService:current!.pendingIntentId!==null});
   }
   const [raid]=await tx.execute<{active:boolean}>(sql`select exists(select 1 from public.base_raid_locks where base_id=${baseId}) active`);
   await assertFreshLockedBaseAuthority(tx,wallet,baseId);
   const result=AdvancedFleetEnvelopeSchema.safeParse({version:1,wallet,baseId,serverNow:new Date().toISOString(),acceptingNewActions:phaseEVehiclesEnabled()&&!raid?.active,vehicles});
   if(!result.success)unavailable('ADVANCED_FLEET_HELD');return result.data!;
  },{isolationLevel:'read committed'});}catch(error){if(busy(error))unavailable('ADVANCED_FLEET_BUSY');throw error;}
 }
 return Object.freeze({read});
}
export type AdvancedFleetViewProvider=ReturnType<typeof createAdvancedFleetView>;
