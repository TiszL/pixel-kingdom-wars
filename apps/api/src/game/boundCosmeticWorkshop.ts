/** Owner capability. Application admission is explicit and never
 * follows from recipe/art source identity. No DB escapes to HTTP consumers. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_BOUND_COSMETICS} from '@shardkeep/shared';
import {BoundCosmeticAppearanceSchema,BoundCosmeticRequestSchema,type BoundCosmeticAppearance} from '@shardkeep/shared/boundCosmeticApi';
import {boundCosmeticRecipe} from '@shardkeep/shared/phaseEBoundCosmetics';
import {BOUND_COSMETIC_AWNING_RECIPE_IDS,BoundCosmeticWorkshopViewSchema,BoundCosmeticWorkshopQuerySchema,
 BoundCosmeticPreferenceRequestSchema,BoundCosmeticPreferenceResponseSchema,type BoundCosmeticWorkshopSelectedBase} from '@shardkeep/shared/boundCosmeticWorkshopApi';
import {BoundCosmeticWakeWorkshopViewSchema,BoundCosmeticWakeWorkshopQuerySchema,BoundCosmeticWakePreferenceSnapshotSchema} from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import {BoundCosmeticWakePreferenceRequestSchema,BoundCosmeticWakePreferenceResponseSchema} from '@shardkeep/shared/boundCosmeticWake';
import type {Db,DbOrTx} from '../db/client';
import {multiBaseEnabled,ordinaryCraftingEnabled,phaseECatalogEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,resolveActiveBase,type FinalizedDeedReader} from './baseOwnership';
import {readBoundCosmeticBlueprintEligibility} from './boundCosmeticBlueprint';
import {boundCosmeticEnvelope,startBoundCosmetic,settleDueBoundCosmetics} from './boundCosmetics';
import {readBoundCosmeticBase,setBoundCosmeticAwning} from './boundCosmeticPresentation';
import {readProtectedCraftingStock,settleDueOrdinaryCrafting} from './ordinaryCrafting';

const Wallet=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const authorityCodes=new Set(['BASE_NOT_OWNED','BASE_ID_REQUIRED','DEED_AUTHORITY_UNAVAILABLE','DEED_OWNERSHIP_CHANGED']);
export interface BoundCosmeticWorkshopOptions{
 readonly awningApplicationReady:boolean|((appearances:readonly BoundCosmeticAppearance[])=>boolean);
 /** Only the accepted C5 consumer may supply this capability; absent in normal startup. */
 readonly wakeApplicationReady?:(appearance:BoundCosmeticAppearance)=>boolean;
 readonly finalizedDeedReader?:FinalizedDeedReader|null;
 readonly deedCollection?:string|null;
 readonly clock?:()=>Date;
}
export function createBoundCosmeticWorkshop(db:Db,options:BoundCosmeticWorkshopOptions={awningApplicationReady:false}){
 if('rollback'in db)throw Error('Cosmetic Workshop requires a top-level owner connection');
 const wakeReadiness=options.wakeApplicationReady,readiness=options.awningApplicationReady,reader=options.finalizedDeedReader??null,collection=options.deedCollection??null,clock=options.clock??(()=>new Date());
 const now=()=>{const at=new Date(clock().getTime());if(!Number.isFinite(+at)||at.toISOString().length!==24)throw Error('Invalid cosmetic Workshop clock');return at;};
 async function owner(){
  const [row]=await db.execute<{allowed:boolean}>(sql`select current_user=session_user and not exists(select 1 from pg_class where oid in(
   'public.bound_cosmetic_jobs'::regclass,'public.bound_cosmetic_completions'::regclass,'public.bound_cosmetic_preferences'::regclass,
   'public.ordinary_crafting_jobs'::regclass,'public.ordinary_equipment_jobs'::regclass) and relowner<>current_user::regrole::oid) allowed`);
  if(!row?.allowed)throw new HttpError(503,'Cosmetic Workshop is unavailable','BOUND_COSMETIC_OWNER');
 }
 async function source(connection:DbOrTx){
  const [row]=await connection.execute<{valid:boolean}>(sql`select public.shardkeep_bound_cosmetic_visual_sources_valid() valid`);
  if(row?.valid!==true)throw Error('BOUND_COSMETIC_WORKSHOP_SOURCE');
 }
 async function recipeRow(id:Parameters<typeof boundCosmeticRecipe>[0],connection:DbOrTx=db){
   const recipe=boundCosmeticRecipe(id,PHASE_E_BOUND_COSMETICS.v1.recipeVersion);
   const [row]=await connection.execute<{appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
   return {recipe,appearance:BoundCosmeticAppearanceSchema.parse(row?.appearance)};
 }
 async function catalogue(connection:DbOrTx=db){return Promise.all(BOUND_COSMETIC_AWNING_RECIPE_IDS.map(id=>recipeRow(id,connection)));}
 function applicationReady(recipes:Awaited<ReturnType<typeof catalogue>>){
  try{return typeof readiness==='function'?readiness(recipes.map(row=>row.appearance))===true:readiness===true;}
  catch{return false;}
 }
 async function admission(connection:DbOrTx=db){
  if(readiness===false||!applicationReady(await catalogue(connection)))
   throw new HttpError(503,'Awning application is not available','BOUND_COSMETIC_APPLICATION_UNAVAILABLE');
 }
 async function prefetch(wallet:string,baseId:string){
  if(!multiBaseEnabled())throw new HttpError(409,'An explicit stable base is required','BASE_ID_REQUIRED');
  await requireFreshBaseAuthority(db,wallet,baseId,reader,collection,now());
 }
 const authority=(baseId:string,requireApplication=false)=>({baseId,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],wallet:string,id:string)=>{
  await assertFreshLockedBaseAuthority(tx,wallet,id,now());await source(tx);
  if(requireApplication)await admission(tx);
 }});
 // Durable original obligations do not need current ownership, action flags or
 // chain RPC. Each base transaction ends before a foreground caller takes locks.
 async function completeAccount(wallet:string,key?:string){
  const at=now(),rows=await db.execute<{base_id:string}>(sql`select distinct j.base_id from bound_cosmetic_jobs j
   where j.actor_wallet=${wallet} and j.ready_at<=${at.toISOString()}::timestamptz ${key?sql`and j.id=${key}::uuid`:sql``}
   and not exists(select 1 from bound_cosmetic_completions c where c.job_id=j.id) order by j.base_id`);
  for(const row of rows)await db.transaction(tx=>settleDueBoundCosmetics(tx,row.base_id,now()));
 }
 async function originals(wallet:string,at:Date){
  const rows=await db.execute<{id:string}>(sql`select id from bound_cosmetic_jobs where actor_wallet=${wallet} and started_at<=${at.toISOString()}::timestamptz order by started_at,id`);
  return Promise.all(rows.map(row=>boundCosmeticEnvelope(db,wallet,row.id,at)));
 }
 async function selected(wallet:string,baseId:string,mode:'awning'|'wake'='awning'){
  try{
   await prefetch(wallet,baseId);
   return await db.transaction(async tx=>{
    await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
    const [base]=await tx.execute(sql`select id from bases where id=${baseId}::uuid and owner_wallet=${wallet} and status='active' for update`);
    const [slot]=await tx.execute(sql`select base_id from base_slots where base_id=${baseId}::uuid and wallet=${wallet} and active for update`);
    if(!base||!slot)throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');
    await assertFreshLockedBaseAuthority(tx,wallet,baseId,now());await (mode==='wake'?wakeSource(tx):source(tx));const at=now();
    await settleDueOrdinaryCrafting(tx,baseId,at);await settleDueBoundCosmetics(tx,baseId,at);
    const facilities=await tx.execute<{buildingId:string;type:string;level:number;completedAt:Date}>(sql`select b.id "buildingId",b.type,b.level,min(proof.completed_at) "completedAt"
     from buildings b join builder_jobs proof on proof.building_id=b.id and proof.base_id=b.base_id and proof.kind='build'
      and proof.cancelled_at is null and proof.completed_at<=${at.toISOString()}::timestamptz
     where b.base_id=${baseId}::uuid and b.type in('workshop',${mode==='wake'?'lodge':'market'}) and b.level>0
      and not exists(select 1 from builder_jobs pending where pending.building_id=b.id and pending.kind='build' and pending.completed_at is null)
     group by b.id,b.type,b.level order by b.id`);
    const queue=await tx.execute<{kind:'ordinary'|'equipment'|'cosmetic';jobId:string;recipe:unknown;startedAt:Date;readyAt:Date}>(sql`
     select 'ordinary'::text kind,id "jobId",recipe_snapshot recipe,started_at "startedAt",ready_at "readyAt" from ordinary_crafting_jobs where base_id=${baseId}::uuid and completed_at is null
     union all select 'equipment',j.id,j.recipe_snapshot,j.started_at,j.ready_at from ordinary_equipment_jobs j where j.base_id=${baseId}::uuid and not exists(select 1 from ordinary_equipment_completions c where c.job_id=j.id)
     union all select 'cosmetic',j.id,j.recipe_snapshot,j.started_at,j.ready_at from bound_cosmetic_jobs j where j.base_id=${baseId}::uuid and not exists(select 1 from bound_cosmetic_completions c where c.job_id=j.id)`);
    const craftingStock=await readProtectedCraftingStock(tx,baseId,2);
    const facts=(type:string)=>facilities.filter(f=>f.type===type).map(({buildingId,level,completedAt})=>({buildingId,level,completedAt:new Date(completedAt).toISOString()}));
    const common={state:'available' as const,baseId,craftingStock,workshops:facts('workshop'),
     queue:queue.map(j=>({...j,startedAt:new Date(j.startedAt).toISOString(),readyAt:new Date(j.readyAt).toISOString()})) as Extract<BoundCosmeticWorkshopSelectedBase,{state:'available'}>['queue']};
    if(mode==='wake'){
     await assertFreshLockedBaseAuthority(tx,wallet,baseId,now());await wakeSource(tx);
     return {at,value:{...common,lodges:facts('lodge')}};
    }
    const [preference]=await tx.execute<{enabled:boolean;revision:string}>(sql`select awning_enabled enabled,revision::text revision from bound_cosmetic_preferences where wallet=${wallet} and base_id=${baseId}::uuid`);
    const visual=await readBoundCosmeticBase(tx,baseId,wallet);
    await assertFreshLockedBaseAuthority(tx,wallet,baseId,now());await source(tx);
    return {at,value:{...common,markets:facts('market'),preference:preference??{enabled:false,revision:'0'},visual}};
   });
  }catch(error){
   if(error instanceof HttpError&&error.code&&authorityCodes.has(error.code))return {at:now(),value:{state:'unavailable',baseId,reason:error.code as Extract<BoundCosmeticWorkshopSelectedBase,{state:'unavailable'}>['reason']}};
   throw error;
  }
 }
 async function wakeSource(connection:DbOrTx){
  const [row]=await connection.execute<{valid:boolean}>(sql`select public.shardkeep_bound_cosmetic_wake_sources_valid() valid`);
  if(row?.valid!==true)throw new HttpError(503,'Aurora source is unavailable','BOUND_COSMETIC_WAKE_SOURCE');
 }
 async function wakeOwner(){await owner();const [row]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.bound_cosmetic_wake_preferences'::regclass) allowed`);
  if(!row?.allowed)throw new HttpError(503,'Aurora Workshop is unavailable','BOUND_COSMETIC_OWNER');}
 function wakeReady(appearance:BoundCosmeticAppearance){try{return wakeReadiness?.(appearance)===true;}catch{return false;}}
 async function wakeAdmission(connection:DbOrTx=db){
  const row=await recipeRow('craft_aurora_wake_v1',connection);
  if(!wakeReady(row.appearance))throw new HttpError(503,'Aurora application is unavailable','BOUND_COSMETIC_APPLICATION_UNAVAILABLE');
 }
 const wakeAuthority=(baseId:string)=>({baseId,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],wallet:string,id:string)=>{
  await assertFreshLockedBaseAuthority(tx,wallet,id,now());await wakeSource(tx);await wakeAdmission(tx);
 }});
 function preferenceFailure(error:unknown):never{
  let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){
   if('code'in cause&&cause.code==='P0001'&&'message'in cause&&typeof cause.message==='string'){
    const code=cause.message;
    if(code==='BOUND_COSMETIC_PREFERENCE_CHANGED'||code==='BOUND_COSMETIC_WAKE_PREFERENCE_CHANGED')throw new HttpError(409,'Your Aurora choice changed. Refresh and try again.','BOUND_COSMETIC_PREFERENCE_CHANGED');
    if(code==='BOUND_COSMETIC_WAKE_NOT_OWNED')throw new HttpError(409,'Complete your Aurora craft before enabling it',code);
    if(code==='BOUND_COSMETIC_WAKE_SOURCE')throw new HttpError(503,'Aurora source is unavailable',code);
   }
   cause='cause'in cause?cause.cause:null;
  }throw error;
 }
 const wake=Object.freeze({
  view:async(wallet:string,baseId?:string)=>{
   Wallet.parse(wallet);({baseId}=BoundCosmeticWakeWorkshopQuerySchema.parse({baseId}));await wakeOwner();await wakeSource(db);await completeAccount(wallet);
   const recipe=await recipeRow('craft_aurora_wake_v1'),ready=wakeReady(recipe.appearance),selection=baseId?await selected(wallet,baseId,'wake'):null,at=selection?.at??now();
   const blueprint=await readBoundCosmeticBlueprintEligibility(db,wallet),rows=(await originals(wallet,at)).filter(o=>o.status==='accepted'&&o.receipt.recipe.outputId==='aurora_wake');
   if(rows.length>1)throw Error('Duplicate Aurora original');
   const preference=await db.transaction(async tx=>{
    const [player]=await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);if(!player)throw new HttpError(404,'Player not found');await wakeSource(tx);
    const [pref]=await tx.execute<{enabled:boolean;revision:string;updatedAt:Date}>(sql`select enabled,revision::text revision,updated_at "updatedAt" from bound_cosmetic_wake_preferences where wallet=${wallet}`);
    if(pref&&+new Date(pref.updatedAt)>+at)throw new HttpError(503,'Aurora changed during this observation. Refresh.','BOUND_COSMETIC_WAKE_OBSERVATION_CHANGED');
    const [selection]=await tx.execute<{visual:unknown}>(sql`select public.shardkeep_bound_cosmetic_wake_selection(${wallet},${at.toISOString()}::timestamptz)->'visual' visual`);
    return BoundCosmeticWakePreferenceSnapshotSchema.parse({enabled:pref?.enabled??false,revision:pref?.revision??'0',visual:selection?.visual});
   });
   return BoundCosmeticWakeWorkshopViewSchema.parse({version:1,wallet,serverNow:at.toISOString(),applicationReady:ready,
    acceptingJobs:ready&&ordinaryCraftingEnabled()&&phaseECatalogEnabled(),blueprint,recipe,original:rows[0]??null,preference,selectedBase:selection?.value??null});
  },
  start:async(wallet:string,raw:unknown)=>{
   Wallet.parse(wallet);const request=BoundCosmeticRequestSchema.parse(raw);await wakeOwner();
   const original=await boundCosmeticEnvelope(db,wallet,request.idempotencyKey,now());
   if(original.status==='accepted'){
    await startBoundCosmetic(db,wallet,request,authority(request.baseId),{clock:now});await completeAccount(wallet,request.idempotencyKey);
    return boundCosmeticEnvelope(db,wallet,request.idempotencyKey,now());
   }
   if(request.recipeId!=='craft_aurora_wake_v1')throw new HttpError(409,'This recipe belongs to the Awning Workshop','BOUND_COSMETIC_APPLICATION_UNAVAILABLE');
   await wakeAdmission();await wakeSource(db);await prefetch(wallet,request.baseId);
   return startBoundCosmetic(db,wallet,request,wakeAuthority(request.baseId),{clock:now});
  },
  preference:async(wallet:string,raw:unknown)=>{
   Wallet.parse(wallet);const request=BoundCosmeticWakePreferenceRequestSchema.parse(raw);await wakeOwner();
   if(request.enabled){await completeAccount(wallet);await wakeAdmission();}
   try{return await db.transaction(async tx=>{
    const [player]=await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);if(!player)throw new HttpError(404,'Player not found');
    await wakeSource(tx);if(request.enabled)await wakeAdmission(tx);
    const [row]=await tx.execute<{response:unknown}>(sql`select public.shardkeep_bound_cosmetic_wake_preference(${wallet},${request.enabled},${request.expectedRevision}::bigint,${now().toISOString()}::timestamptz) response`);
    if(request.enabled)await wakeAdmission(tx);
    return BoundCosmeticWakePreferenceResponseSchema.parse(row?.response);
   },{isolationLevel:'read committed'});}catch(error){return preferenceFailure(error);}
  },
 });
 return Object.freeze({
  wake,
  view:async(wallet:string,baseId?:string)=>{
   Wallet.parse(wallet);({baseId}=BoundCosmeticWorkshopQuerySchema.parse({baseId}));await owner();await source(db);await completeAccount(wallet);
   const recipes=await catalogue(),ready=applicationReady(recipes);
   const selection=baseId?await selected(wallet,baseId):null,selectedBase=selection?.value??null,at=selection?.at??now();
   // Selection settles a first qualifying refine before C2 reads its proof.
   // Use one observation cutoff; concurrently newer history fails strict parsing.
   const blueprint=await readBoundCosmeticBlueprintEligibility(db,wallet);
   return BoundCosmeticWorkshopViewSchema.parse({version:1,wallet,serverNow:at.toISOString(),applicationReady:ready,
    acceptingJobs:ready&&ordinaryCraftingEnabled()&&phaseECatalogEnabled(),blueprint,recipes,originals:await originals(wallet,at),selectedBase});
  },
  read:async(wallet:string,key:string)=>{Wallet.parse(wallet);Uuid.parse(key);await owner();await completeAccount(wallet,key);return boundCosmeticEnvelope(db,wallet,key,now());},
  start:async(wallet:string,raw:unknown)=>{
   Wallet.parse(wallet);const request=BoundCosmeticRequestSchema.parse(raw);await owner();
   const original=await boundCosmeticEnvelope(db,wallet,request.idempotencyKey,now());
   if(original.status==='accepted'){
    // Existing service matches every original field before any current gate.
    await startBoundCosmetic(db,wallet,request,authority(request.baseId),{clock:now});await completeAccount(wallet,request.idempotencyKey);
    return boundCosmeticEnvelope(db,wallet,request.idempotencyKey,now());
   }
   if(!BOUND_COSMETIC_AWNING_RECIPE_IDS.includes(request.recipeId as typeof BOUND_COSMETIC_AWNING_RECIPE_IDS[number]))
    throw new HttpError(409,'This appearance is not admitted','BOUND_COSMETIC_APPLICATION_UNAVAILABLE');
   await admission();await source(db);await prefetch(wallet,request.baseId);
   return startBoundCosmetic(db,wallet,request,authority(request.baseId,true),{clock:now});
  },
  preference:async(wallet:string,raw:unknown)=>{
   Wallet.parse(wallet);const request=BoundCosmeticPreferenceRequestSchema.parse(raw);await owner();if(request.enabled)await admission();
   await prefetch(wallet,request.baseId);await completeAccount(wallet);
   return BoundCosmeticPreferenceResponseSchema.parse(await setBoundCosmeticAwning(db,wallet,request,authority(request.baseId,request.enabled)));
  },
  collectForBaseRead:async(wallet:string,requestedBaseId?:string):Promise<string|null>=>{
   Wallet.parse(wallet);({baseId:requestedBaseId}=BoundCosmeticWorkshopQuerySchema.parse({baseId:requestedBaseId}));await owner();
   let selectedBase;try{selectedBase=await resolveActiveBase(db,wallet,requestedBaseId);}catch(error){if(!requestedBaseId&&error instanceof HttpError&&error.code==='BASE_ID_REQUIRED')return null;throw error;}
   if(!selectedBase)return null;const baseId=selectedBase.base.id;
   await db.transaction(async tx=>{
    const [base]=await tx.execute(sql`select id from bases where id=${baseId}::uuid and owner_wallet=${wallet} and status='active' for update`);
    const [slot]=await tx.execute(sql`select base_id from base_slots where base_id=${baseId}::uuid and wallet=${wallet} and active`);
    if(!base||!slot)throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');
    const at=now();await settleDueOrdinaryCrafting(tx,baseId,at);await settleDueBoundCosmetics(tx,baseId,at);
   });return baseId;
  },
 });
}
export type BoundCosmeticWorkshop=ReturnType<typeof createBoundCosmeticWorkshop>;
