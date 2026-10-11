import {boundCosmeticQueueError} from './boundCosmeticCollection';
import {readStarterEquipmentEvidence} from './starterEquipmentEvidence';
/** D153.188 base-local durable equipment. SQL owns exact refined debits and
 * stock transitions; callers own canonical base locks and current authority. */
import {sql} from 'drizzle-orm';
import {OrdinaryEquipmentRequestSchema,OrdinaryEquipmentEnvelopeSchema,OrdinaryEquipmentViewSchema,OrdinaryEquipmentViewV2Schema,currentOrdinaryEquipmentRecipes} from '@shardkeep/shared/ordinaryEquipmentApi';
import {EquipmentFittingSnapshotSchema,ordinaryEquipmentRecipe,type EquipmentFittingSnapshot} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import type {Db,DbOrTx,DbTx} from '../db/client';
import {ordinaryCraftingEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from './stableBasePrerequisites';
import {ordinaryWorkshop,readProtectedCraftingStock,settleDueOrdinaryCrafting} from './ordinaryCrafting';

type Job={id:string;actor_wallet:string;base_id:string;recipe_snapshot:unknown;started_at:Date;ready_at:Date;completed_at:Date|null};
const conflict=()=>new HttpError(409,'Equipment key belongs to another original command','IDEMPOTENCY_BODY_MISMATCH');
/** Only exact SQL admission denials, propagated out of the transaction. Never
 * classify a connection/commit failure as a definitive first-post refusal. */
function equipmentAdmissionError(error:unknown):unknown{
 let current=error;
 for(let depth=0;depth<8&&current&&typeof current==='object';depth++){
  if('code'in current&&current.code==='P0001'&&'message'in current){
   if(current.message==='EQUIPMENT_MATERIALS')return new HttpError(422,'Insufficient refined crafting stock','INSUFFICIENT_CRAFTING_STOCK');
   if(current.message==='EQUIPMENT_CRAFT_ADMISSION')return new HttpError(409,'Workshop is busy or no longer available','EQUIPMENT_CRAFT_UNAVAILABLE');
   if(current.message==='LENS_UNAVAILABLE')return new HttpError(409,'No Survey Lens is available in this kingdom','LENS_UNAVAILABLE');
   if(current.message==='EQUIPMENT_UNAVAILABLE')return new HttpError(409,'No Compass is available in this kingdom','COMPASS_UNAVAILABLE');
  }
  current='cause'in current?current.cause:null;
 }return boundCosmeticQueueError(error);
}
const gate=()=>{if(!ordinaryCraftingEnabled())throw new HttpError(503,'Ordinary equipment crafting is paused','PHASE_E_DISABLED');};
async function owner(db:DbOrTx){const [row]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.ordinary_equipment_jobs'::regclass) allowed`);if(!row?.allowed)throw new HttpError(503,'Equipment owner capability is unavailable','EQUIPMENT_OWNER');}
export async function ordinaryEquipmentEnvelope(db:DbOrTx,wallet:string,id:string,now=new Date()){
 const [job]=await db.execute<Job>(sql`select j.*,c.completed_at from ordinary_equipment_jobs j left join ordinary_equipment_completions c on c.job_id=j.id where j.id=${id} and j.actor_wallet=${wallet}`);
 const scope={wallet,idempotencyKey:id,serverNow:now.toISOString()};
 if(!job)return OrdinaryEquipmentEnvelopeSchema.parse({...scope,status:'unknown',receipt:null,completion:null});
 return OrdinaryEquipmentEnvelopeSchema.parse({...scope,status:'accepted',receipt:{wallet,jobId:job.id,
  request:{idempotencyKey:job.id,baseId:job.base_id,recipeId:(job.recipe_snapshot as {recipeId:string}).recipeId,recipeVersion:1,quantity:1},recipe:job.recipe_snapshot,
  startedAt:new Date(job.started_at).toISOString(),readyAt:new Date(job.ready_at).toISOString()},completion:job.completed_at?{completedAt:new Date(job.completed_at).toISOString()}:null});
}
export async function startOrdinaryEquipment(db:Db,wallet:string,raw:unknown,authority:StableBaseMutationContext,deps:{clock?:()=>Date}={}){
 if('rollback'in db)throw Error('Equipment crafting requires top-level DB');await owner(db);
 const request=OrdinaryEquipmentRequestSchema.parse(raw),read=()=>ordinaryEquipmentEnvelope(db,wallet,request.idempotencyKey);
 const existing=await read();if(existing.status==='accepted'){if(JSON.stringify(existing.receipt.request)!==JSON.stringify(request))throw conflict();return existing;}
 return db.transaction(async tx=>{
  await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
  const [identity]=await tx.execute<{actor_wallet:string}>(sql`select actor_wallet from ordinary_equipment_jobs where id=${request.idempotencyKey}`);
  if(identity){const old=await ordinaryEquipmentEnvelope(tx,wallet,request.idempotencyKey);if(old.status!=='accepted'||JSON.stringify(old.receipt.request)!==JSON.stringify(request))throw conflict();return old;}
  gate();if(authority.baseId!==request.baseId)throw conflict();await lockStablePrerequisiteBase(tx,wallet,authority);gate();
  const facility=await ordinaryWorkshop(tx,request.baseId),now=new Date((deps.clock??(()=>new Date()))().getTime());
  if(!Number.isFinite(+now)||facility.completed.completedAt!>now)throw Error('Equipment Workshop completion is unavailable');
  await settleDueOrdinaryCrafting(tx,request.baseId,now);
  const recipe=ordinaryEquipmentRecipe(request.recipeId),ready=new Date(+now+recipe.durationSec*1000);
  await tx.execute(sql`insert into ordinary_equipment_jobs(id,actor_wallet,base_id,recipe_snapshot,workshop_id,workshop_completed_job_id,started_at,ready_at)
   values(${request.idempotencyKey},${wallet},${request.baseId},${JSON.stringify(recipe)}::jsonb,${facility.building.id},${facility.completed.id},${now.toISOString()}::timestamptz,${ready.toISOString()}::timestamptz)`);
  gate();await authority.assertAuthority(tx,wallet,request.baseId);
  return ordinaryEquipmentEnvelope(tx,wallet,request.idempotencyKey,now);
 }).catch(error=>{throw equipmentAdmissionError(error);});
}
export async function settleDueOrdinaryEquipment(tx:DbTx,baseId:string,at:Date){
 if(!('rollback' in tx))throw Error('Equipment completion requires an existing transaction');
 await tx.execute(sql`select public.shardkeep_settle_due_equipment(${baseId}::uuid,${at.toISOString()}::timestamptz)`);
}
export async function assertNoPendingOrdinaryEquipment(tx:DbTx,baseId:string){
 if(!('rollback' in tx))throw Error('Equipment idle check requires an existing transaction');
 const [state]=await tx.execute<{idle:boolean}>(sql`select public.shardkeep_equipment_idle(${baseId}::uuid) idle`);
 if(!state||typeof state.idle!=='boolean')throw Error('Invalid equipment idle result');
 if(!state.idle)throw new HttpError(409,'This base already has an unfinished equipment job','ORDINARY_CRAFTING_BUSY');
}
export async function readOrdinaryEquipmentView(tx:DbTx,wallet:string,baseId:string,at:Date,catalogueVersion:1|2=1){
 const rows=await tx.execute<{item_id:string;available:string;reserved:string;pending_output:string}>(sql`select item_id,available,reserved,pending_output from ordinary_equipment_stocks where base_id=${baseId}`);
 const pending=await tx.execute<Job>(sql`select j.* from ordinary_equipment_jobs j left join ordinary_equipment_completions c on c.job_id=j.id where j.base_id=${baseId} and c.job_id is null order by j.ready_at,j.id`);
 const held=await tx.execute<{item_id:string;count:string}>(sql`select r.fitting_snapshot->>'itemId' item_id,count(*)::text count from ordinary_equipment_reservations r left join ordinary_equipment_releases l on l.trip_kind=r.trip_kind and l.expedition_id=r.expedition_id where r.base_id=${baseId} and l.expedition_id is null group by r.fitting_snapshot->>'itemId'`);
 const current=currentOrdinaryEquipmentRecipes(catalogueVersion),ids=current.recipes.map(r=>r.output.itemId);
 for(const id of ['route_compass','survey_lens'])if(BigInt(rows.find(s=>s.item_id===id)?.reserved??0)!==BigInt(held.find(s=>s.item_id===id)?.count??0))throw Error('Equipment reservation projection differs');
 const view={wallet,baseId,serverNow:at.toISOString(),features:{ordinaryEquipment:{version:1,receipts:1}},acceptingJobs:ordinaryCraftingEnabled(),...current,
  craftingStock:await readProtectedCraftingStock(tx,baseId),equipmentStock:ids.map(itemId=>{const s=rows.find(s=>s.item_id===itemId);return {itemId,available:String(s?.available??0),reserved:String(s?.reserved??0),pendingOutput:String(s?.pending_output??0)};}),
  pendingJobs:pending.filter(j=>ids.includes((j.recipe_snapshot as {output:{itemId:'route_compass'|'survey_lens'}}).output.itemId)).map(j=>({jobId:j.id,recipe:j.recipe_snapshot,startedAt:new Date(j.started_at).toISOString(),readyAt:new Date(j.ready_at).toISOString()}))};
 return catalogueVersion===2?OrdinaryEquipmentViewV2Schema.parse({...view,catalogueVersion}):OrdinaryEquipmentViewSchema.parse(view);
}
export async function reserveOrdinaryEquipment(tx:DbTx,kind:'starter'|'advanced',id:string,baseId:string,fitting:EquipmentFittingSnapshot){
 EquipmentFittingSnapshotSchema.parse(fitting);
 await tx.execute(sql`insert into ordinary_equipment_reservations(trip_kind,expedition_id,base_id,fitting_snapshot) values(${kind},${id},${baseId},${JSON.stringify(fitting)}::jsonb)`).catch(error=>{throw equipmentAdmissionError(error);});
}
export async function assertEquipmentReservation(db:DbOrTx,kind:'starter'|'advanced',id:string,baseId:string,fitting:EquipmentFittingSnapshot){
 const row=kind==='starter'?(await readStarterEquipmentEvidence(db,id)).reservation:(await db.execute<{base_id:string;fitting_snapshot:unknown}>(sql`select base_id,fitting_snapshot from ordinary_equipment_reservations where trip_kind=${kind} and expedition_id=${id}`))[0];
 if(!row||row.base_id!==baseId||JSON.stringify(EquipmentFittingSnapshotSchema.parse(row.fitting_snapshot))!==JSON.stringify(fitting))throw Error('Original equipment reservation is missing or different');
}
export async function releaseOrdinaryEquipment(tx:DbTx,kind:'starter'|'advanced',id:string,returnId:string,baseId:string){
 await tx.execute(sql`insert into ordinary_equipment_releases(trip_kind,expedition_id,base_id,return_id) values(${kind},${id},${baseId},${returnId})`);
}

export async function assertEquipmentRelease(db:DbOrTx,kind:'starter'|'advanced',id:string,returnId:string){
 const row=kind==='starter'?(await readStarterEquipmentEvidence(db,id)).release:(await db.execute<{return_id:string}>(sql`select return_id from ordinary_equipment_releases where trip_kind=${kind} and expedition_id=${id}`))[0];
 if(!row||row.return_id!==returnId)throw Error('Original equipment release is missing or different');
}
