/** Private, unactivated bound-cosmetic custody. SQL owns exact refined debits;
 * this service owns actor/base authority and immutable original recovery.
 * Do not mount consuming HTTP admission until the protected appearance delivery
 * path is accepted. A source binding alone does not establish that readiness. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {BoundCosmeticAppearanceSchema,BoundCosmeticBlueprintProofSchema,BoundCosmeticEnvelopeSchema,
 BoundCosmeticRequestSchema,type BoundCosmeticRequest} from '@shardkeep/shared/boundCosmeticApi';
import {boundCosmeticRecipe,type BoundCosmeticRecipeSnapshot} from '@shardkeep/shared/phaseEBoundCosmetics';
import type {Db,DbOrTx,DbTx} from '../db/client';
import {ordinaryCraftingEnabled,phaseECatalogEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from './stableBasePrerequisites';
import {ordinaryWorkshop,settleDueOrdinaryCrafting} from './ordinaryCrafting';
import {readBoundCosmeticBlueprintEligibility} from './boundCosmeticBlueprint';

const Identity=z.object({wallet:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),id:z.uuid().regex(/^[0-9a-f-]+$/)});
const mismatch=()=>new HttpError(409,'Cosmetic key belongs to another original command','IDEMPOTENCY_BODY_MISMATCH');
const gate=()=>{if(!ordinaryCraftingEnabled()||!phaseECatalogEnabled())throw new HttpError(503,'Cosmetic crafting is paused','PHASE_E_DISABLED');};
function time(at:Date){if(!Number.isFinite(+at)||at.toISOString().length!==24)throw Error('Invalid cosmetic time');return at.toISOString();}
async function owner(db:DbOrTx){
 const [row]=await db.execute<{allowed:boolean}>(sql`select current_user=session_user and current_user::regrole::oid=(select relowner from pg_class where oid='public.bound_cosmetic_jobs'::regclass) allowed`);
 if(!row?.allowed)throw new HttpError(503,'Cosmetic owner capability is unavailable','BOUND_COSMETIC_OWNER');
}
/** Only explicit transaction-rolled-back SQL refusals become known admission
 * errors. Connection and commit uncertainty remain unknown for original lookup. */
function admissionError(error:unknown):unknown{
 let current=error;
 for(let depth=0;depth<8&&current&&typeof current==='object';depth++){
  if('code'in current&&current.code==='P0001'&&'message'in current){
   if(current.message==='BOUND_COSMETIC_MATERIALS')return new HttpError(422,'Insufficient refined crafting stock','INSUFFICIENT_CRAFTING_STOCK');
   if(current.message==='BOUND_COSMETIC_DUPLICATE')return new HttpError(409,'This appearance is already owned or being crafted','BOUND_COSMETIC_ALREADY_OWNED');
   if(current.message==='BOUND_COSMETIC_WORKSHOP_BUSY')return new HttpError(409,'The Workshop already has an unfinished job','ORDINARY_CRAFTING_BUSY');
   if(current.message==='BOUND_COSMETIC_ADMISSION')return new HttpError(409,'The required completed facilities are unavailable','BOUND_COSMETIC_FACILITY_REQUIRED');
   if(current.message==='BOUND_COSMETIC_BLUEPRINT_SOURCE')return new HttpError(409,'Blueprint source is unavailable','BOUND_COSMETIC_BLUEPRINT_UNAVAILABLE');
  }
  current='cause'in current?current.cause:null;
 }
 return error;
}

type Job={id:string;actor_wallet:string;base_id:string;recipe_snapshot:BoundCosmeticRecipeSnapshot;appearance_snapshot:unknown;
 blueprint_id:string;started_at:Date;ready_at:Date;completed_at:Date|null;source_job_id:string;source_base_id:string;source_completed_at:Date};
/** Authenticated actor-only history; no gate, selected-base or current owner
 * prerequisite, and no completion side effect. All fields come from the original. */
export async function boundCosmeticEnvelope(db:DbOrTx,wallet:string,id:string,at=new Date()){
 Identity.parse({wallet,id});await owner(db);
 const [job]=await db.execute<Job>(sql`select j.*,c.completed_at,b.source_job_id,s.base_id source_base_id,s.completed_at source_completed_at
  from public.bound_cosmetic_jobs j
  join public.bound_cosmetic_blueprints b on b.wallet=j.actor_wallet and b.blueprint_id=j.blueprint_id
  join public.ordinary_crafting_jobs s on s.id=b.source_job_id
  left join public.bound_cosmetic_completions c on c.job_id=j.id
  where j.id=${id}::uuid and j.actor_wallet=${wallet}`);
 const scope={version:1,wallet,idempotencyKey:id,serverNow:time(at)};
 if(!job)return BoundCosmeticEnvelopeSchema.parse({...scope,status:'unknown',receipt:null,completion:null});
 const appearance=BoundCosmeticAppearanceSchema.parse(job.appearance_snapshot);
 return BoundCosmeticEnvelopeSchema.parse({...scope,status:'accepted',receipt:{wallet,jobId:job.id,
  request:{idempotencyKey:job.id,baseId:job.base_id,recipeId:job.recipe_snapshot.recipeId,recipeVersion:job.recipe_snapshot.recipeVersion,appearanceBindingSha256:appearance.bindingSha256},
  recipe:job.recipe_snapshot,appearance,blueprint:{blueprintId:job.blueprint_id,jobId:job.source_job_id,baseId:job.source_base_id,actorWallet:job.actor_wallet,completedAt:new Date(job.source_completed_at).toISOString()},
  startedAt:new Date(job.started_at).toISOString(),readyAt:new Date(job.ready_at).toISOString()},
  completion:job.completed_at?{completedAt:new Date(job.completed_at).toISOString()}:null});
}
async function facility(tx:DbTx,baseId:string,recipe:BoundCosmeticRecipeSnapshot,at:Date){
 const [row]=await tx.execute<{id:string;proof_id:string}>(sql`select b.id,p.id proof_id from public.buildings b
  join public.builder_jobs p on p.building_id=b.id and p.base_id=b.base_id and p.kind='build' and p.cancelled_at is null and p.completed_at<=${time(at)}::timestamptz
  where b.base_id=${baseId}::uuid and b.type=${recipe.requiredFacility.type} and b.level>=${recipe.requiredFacility.level}
  and not exists(select 1 from public.builder_jobs pending where pending.building_id=b.id and pending.kind='build' and pending.completed_at is null)
  order by b.id,p.completed_at,p.id limit 1 for update of b`);
 if(!row)throw new HttpError(409,'The required completed facility is unavailable','BOUND_COSMETIC_FACILITY_REQUIRED');
 return row;
}
function exactRequest(original:BoundCosmeticRequest,request:BoundCosmeticRequest){
 if(JSON.stringify(original)!==JSON.stringify(request))throw mismatch();
}
export async function startBoundCosmetic(db:Db,wallet:string,raw:unknown,authority:StableBaseMutationContext,deps:{clock?:()=>Date}={}){
 if('rollback'in db)throw Error('Cosmetic crafting requires top-level DB');
 const request=BoundCosmeticRequestSchema.parse(raw);Identity.parse({wallet,id:request.idempotencyKey});await owner(db);
 const prior=await boundCosmeticEnvelope(db,wallet,request.idempotencyKey);
 if(prior.status==='accepted'){exactRequest(prior.receipt.request,request);return prior;}
 gate();
 const recipe=boundCosmeticRecipe(request.recipeId,request.recipeVersion);
 // A completed original grant is sufficient after source/provider availability
 // changes. First grant uses C2's consistent source snapshot, then SQL revalidates
 // its immutable source atomically with the actual material-consuming admission.
 const [grant]=await db.execute<{source_job_id:string}>(sql`select source_job_id from public.bound_cosmetic_blueprints where wallet=${wallet} and blueprint_id=${recipe.blueprintId}`);
 const eligibility=grant?null:await readBoundCosmeticBlueprintEligibility(db,wallet);
 if(eligibility&&eligibility.state!=='eligible')throw new HttpError(409,
  eligibility.state==='not-earned'?'Complete an ordinary refining job to earn this Blueprint':'Blueprint source is unavailable',
  eligibility.state==='not-earned'?'BOUND_COSMETIC_BLUEPRINT_REQUIRED':'BOUND_COSMETIC_BLUEPRINT_UNAVAILABLE');
 const proof=eligibility?.state==='eligible'?BoundCosmeticBlueprintProofSchema.parse(eligibility.proof):null;
 return db.transaction(async tx=>{
  const [actor]=await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
  if(!actor)throw new HttpError(404,'Player not found');
  const [identity]=await tx.execute<{actor_wallet:string}>(sql`select actor_wallet from public.bound_cosmetic_jobs where id=${request.idempotencyKey}::uuid`);
  if(identity){const saved=await boundCosmeticEnvelope(tx,wallet,request.idempotencyKey);if(saved.status!=='accepted')throw mismatch();exactRequest(saved.receipt.request,request);return saved;}
  gate();if(authority.baseId!==request.baseId)throw mismatch();await lockStablePrerequisiteBase(tx,wallet,authority);gate();
  const now=new Date((deps.clock??(()=>new Date()))().getTime());time(now);
  const workshop=await ordinaryWorkshop(tx,request.baseId);
  if(!workshop.completed.completedAt||workshop.completed.completedAt>now)throw new HttpError(409,'Completed Workshop is unavailable','ORDINARY_WORKSHOP_REQUIRED');
  const required=await facility(tx,request.baseId,recipe,now);
  await settleDueOrdinaryCrafting(tx,request.baseId,now);
  await settleDueBoundCosmetics(tx,request.baseId,now);
  const [frozen]=await tx.execute<{appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
  const appearance=BoundCosmeticAppearanceSchema.parse(frozen?.appearance);
  if(appearance.outputId!==recipe.outputId||appearance.bindingSha256!==request.appearanceBindingSha256)
   throw new HttpError(409,'Appearance review has changed','BOUND_COSMETIC_APPEARANCE_CHANGED');
  const [existingGrant]=await tx.execute(sql`select source_job_id from public.bound_cosmetic_blueprints where wallet=${wallet} and blueprint_id=${recipe.blueprintId}`);
  if(!existingGrant){
   if(!proof||proof.actorWallet!==wallet||proof.blueprintId!==recipe.blueprintId||Date.parse(proof.completedAt)>+now)
    throw new HttpError(409,'Blueprint source is unavailable','BOUND_COSMETIC_BLUEPRINT_UNAVAILABLE');
   await tx.execute(sql`insert into public.bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${wallet},${recipe.blueprintId},${proof.jobId}::uuid,${time(now)}::timestamptz)`);
  }
  const ready=new Date(+now+recipe.durationSec*1000);time(ready);
  await tx.execute(sql`insert into public.bound_cosmetic_jobs(id,actor_wallet,base_id,output_id,recipe_snapshot,appearance_snapshot,blueprint_id,workshop_id,workshop_completed_job_id,facility_id,facility_completed_job_id,started_at,ready_at)
   values(${request.idempotencyKey}::uuid,${wallet},${request.baseId}::uuid,${recipe.outputId},${JSON.stringify(recipe)}::jsonb,${JSON.stringify(appearance)}::jsonb,${recipe.blueprintId},${workshop.building.id}::uuid,${workshop.completed.id}::uuid,${required.id}::uuid,${required.proof_id}::uuid,${time(now)}::timestamptz,${time(ready)}::timestamptz)`);
  gate();await authority.assertAuthority(tx,wallet,request.baseId);
  return boundCosmeticEnvelope(tx,wallet,request.idempotencyKey,now);
 }).catch(error=>{throw admissionError(error);});
}
/** Completion grants the original account only. There is no player lock/FK,
 * flag/provider/facility dependency, resource output, fee or current-owner switch. */
export async function settleDueBoundCosmetics(tx:DbTx,baseId:string,at:Date){
 if(!('rollback'in tx))throw Error('Cosmetic completion requires an existing transaction');
 z.uuid().regex(/^[0-9a-f-]+$/).parse(baseId);time(at);await owner(tx);
 await tx.execute(sql`select id from public.bases where id=${baseId}::uuid for update`);
 const pending=await tx.execute<{id:string}>(sql`select j.id from public.bound_cosmetic_jobs j
  where j.base_id=${baseId}::uuid and j.ready_at<=${time(at)}::timestamptz
  and not exists(select 1 from public.bound_cosmetic_completions c where c.job_id=j.id) order by j.ready_at,j.id`);
 for(const job of pending)await tx.execute(sql`insert into public.bound_cosmetic_completions(job_id,completed_at) values(${job.id}::uuid,${time(at)}::timestamptz)`);
}
