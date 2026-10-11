/** Owned local source fixture: synthetic facilities/materials; genuine crafting
 * admissions, automatic completions, protected reads and custody transfer. */
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import postgres from 'postgres';
import {Keypair} from '@solana/web3.js';
import {eq,sql} from 'drizzle-orm';
import {BuildingType,BUILD_COSTS} from '@shardkeep/shared';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bases,buildings,builderJobs,craftingStocks,players,sessions} from '../src/db/schema';
import {getBaseState,ensureStartingBase} from '../src/game/base';
import {readServiceActivity} from '../src/game/serviceActivity';
import {startOrdinaryEquipment} from '../src/game/ordinaryEquipment';
import {startBoundCosmetic,settleDueBoundCosmetics} from '../src/game/boundCosmetics';
import {createBoundCosmeticWorkshop} from '../src/game/boundCosmeticWorkshop';
import {transferStableBase,assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {boundCosmeticFixture,earnBoundBlueprint,cosmeticMaterials,pendingOrdinary} from './fixtures/boundCosmetics';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {ADMIN_DATABASE_URL} from './db-url';
const conn=resourceClaimsDatabase(),db=conn.db,migrations=fileURLToPath(new URL('../drizzle',import.meta.url));
const apply=async(tx:postgres.TransactionSql,body:string)=>{for(const part of body.split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);};
const flags=()=>{for(const key of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','PHASE_E_CATALOG_ENABLED','FREE_ONBOARDING'])vi.stubEnv(key,'true');};
const seals=async()=>{const result:Record<string,unknown>={};for(const table of ['raid_advanced_presentation_contract','raid_starter_presentation_contract','bound_cosmetic_return_contract','bound_cosmetic_charter_contract','bound_cosmetic_wake_contract'])result[table]=await conn.sql.unsafe(`select * from public.${table}`);return result;};
let before:Record<string,unknown>,readerSql:string,sourceSql:string;
beforeAll(async()=>{
 const folder=await mkdtemp(join(tmpdir(),'service-activity-journal-')),real=runMigrations;
 try{await cp(migrations,folder,{recursive:true});const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,JSON.stringify({...journal,entries:journal.entries.filter((e:{idx:number})=>e.idx<291)}));
  const mod=await import('../src/db/migrate'),spy=vi.spyOn(mod,'runMigrations').mockImplementationOnce(db=>real(db,{migrationsFolder:folder}));
  try{await conn.setup();}finally{spy.mockRestore();}
 }finally{await rm(folder,{recursive:true,force:true});}
 await writeFile('/tmp/service-activity-owned-db.json',JSON.stringify({database:(await conn.sql`select current_database() name`)[0]!.name,host:'127.0.0.1',port:55492,state:'running-owned-fixture'}));
 before=await seals();readerSql=await readFile(join(migrations,'0288_service_activity.sql'),'utf8');sourceSql=await readFile(join(migrations,'0289_service_activity_source.sql'),'utf8');
},180000);
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await conn.close();const path='/tmp/service-activity-owned-db.json';try{const record=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...record,state:'closed-and-owned-database-dropped'}));}catch{ /* setup failures are reported by Vitest */ }});
it('admits only the exact additive reader with unchanged old seals and rejects altered authority',async()=>{
 for(const mutation of ['alter function public.shardkeep_service_activity(text,uuid,jsonb,timestamptz) security invoker',
  "create or replace function public.shardkeep_service_activity(actor text,target uuid,current_buildings jsonb,cutoff timestamptz) returns jsonb language sql set search_path=pg_catalog,public,pg_temp as $$select null::jsonb$$"])
  await expect(conn.sql.begin(async tx=>{await apply(tx,readerSql);await tx.unsafe(mutation);await apply(tx,sourceSql);})).rejects.toThrow('SERVICE_ACTIVITY_SEAL_SOURCE');
 await runMigrations(db);expect(await seals()).toEqual(before);
 expect((await conn.sql`select public.shardkeep_service_activity_sources_valid() current,public.shardkeep_bound_cosmetic_wake_sources_valid() previous`)[0]).toEqual({current:true,previous:true});
},180000);
type Fixture=Awaited<ReturnType<typeof boundCosmeticFixture>>;
async function fixture(){
 flags();await runMigrations(db);const f=await boundCosmeticFixture(db);f.now=new Date(Date.now()-86400000);
 await db.update(builderJobs).set({startedAt:new Date(+f.now-86400000),finishesAt:new Date(+f.now-1000),completedAt:new Date(+f.now-1000)}).where(eq(builderJobs.baseId,f.baseId));return f;
}
const state=(f:Fixture)=>getBaseState(db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now);
const activity=async(f:Fixture)=>{const b=await db.select().from(buildings).where(eq(buildings.baseId,f.baseId));return db.transaction(tx=>readServiceActivity(tx,f.wallet,f.baseId,b,f.now));};
const working=(f:Fixture)=>({buildingId:f.workshop.id,state:'working'});
async function cosmetic(f:Fixture){
 await earnBoundBlueprint(f);const recipe=await cosmeticMaterials(f,'craft_artisan_market_awning_t1_v1');
 const [appearance]=await conn.sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) value`;
 const job=await startBoundCosmetic(db,f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:recipe.recipeId,recipeVersion:1,appearanceBindingSha256:appearance!.value.bindingSha256},f.authority,{clock:()=>f.now});
 if(job.status!=='accepted')throw Error('Cosmetic fixture was not accepted');return job;
}
it('shows the original Workshop through an alternative facility and automatically settles ordinary work while paused',async()=>{
 const f=await fixture(),job=await pendingOrdinary(f);
 const [other]=await db.insert(buildings).values({id:'00000000-0000-4000-8000-000000000001',baseId:f.baseId,playerWallet:f.wallet,type:BuildingType.Workshop,level:1,tx:20,ty:20}).returning();
 await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:other!.id,kind:'build',startedAt:new Date(+f.now-BUILD_COSTS.workshop.buildSec*1000-1),finishesAt:new Date(+f.now-1),completedAt:new Date(+f.now-1)});
 expect((await state(f)).serviceActivity!.services).toContainEqual(working(f));expect((await state(f)).serviceActivity!.services).toContainEqual({buildingId:other!.id,state:'idle'});
 vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');f.now=job.job.readyAt;
 expect((await state(f)).serviceActivity!.services.every(s=>s.state==='idle')).toBe(true);
 expect(await conn.sql`select job_id from ordinary_crafting_completions where job_id=${job.job.id}`).toHaveLength(1);
 expect(await getBaseState(db,f.wallet,f.now,f.baseId)).not.toHaveProperty('serviceActivity');
});
it('binds genuine equipment pending work then includes its automatic completion',async()=>{
 const f=await fixture(),recipe=ordinaryEquipmentRecipe('craft_route_compass');for(const input of recipe.inputs)await db.insert(craftingStocks).values({baseId:f.baseId,itemId:input.itemId,available:BigInt(input.quantity)});
 const job=await startOrdinaryEquipment(db,f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:recipe.recipeId,recipeVersion:1,quantity:1},f.authority,{clock:()=>f.now});
 if(job.status!=='accepted')throw Error('Equipment fixture was not accepted');
 expect((await state(f)).serviceActivity!.services).toContainEqual(working(f));f.now=new Date(job.receipt.readyAt);
 expect((await state(f)).serviceActivity!.services.every(s=>s.state==='idle')).toBe(true);
 expect(await conn.sql`select job_id from ordinary_equipment_completions where job_id=${job.receipt.jobId}`).toHaveLength(1);
});
it('keeps cosmetic deadlines unavailable until the actual private collector completes the original',async()=>{
 const f=await fixture(),job=await cosmetic(f);expect((await state(f)).serviceActivity!.services).toContainEqual(working(f));
 f.now=new Date(job.receipt.readyAt);expect((await state(f)).serviceActivity).toBeNull();
 expect(await conn.sql`select job_id from bound_cosmetic_completions where job_id=${job.receipt.jobId}`).toHaveLength(0);
 vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');await db.transaction(tx=>settleDueBoundCosmetics(tx,f.baseId,f.now));
 expect((await state(f)).serviceActivity!.services.every(s=>s.state==='idle')).toBe(true);
});
it('retains base-local pending activity after real custody transfer and refuses the former owner',async()=>{
 const f=await fixture();f.now=new Date();await pendingOrdinary(f);const buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();
 await db.insert(players).values({wallet:buyer});await db.update(bases).set({deedAssetId:deed,deedMintAssetId:deed,landPaidAt:f.now}).where(eq(bases.id,f.baseId));
 await transferStableBase(db,f.baseId,f.wallet,buyer,deed,{owner:buyer,collection,frozen:false,delegate:null,slot:100,observedAtMs:Date.now()},()=>new Date());
 await expect(activity(f)).rejects.toMatchObject({cause:{message:'SERVICE_ACTIVITY_OWNER'}});
 f.wallet=buyer;f.now=new Date();expect((await state(f)).serviceActivity!.services).toContainEqual(working(f));
});
it('closes current construction and structural absence but fails loudly on corrupt originals and catalogues',async()=>{
 const f=await fixture();await pendingOrdinary(f);const current=await db.select().from(buildings).where(eq(buildings.baseId,f.baseId));
 expect(await db.transaction(tx=>readServiceActivity(tx,f.wallet,f.baseId,[],f.now))).toBeNull();
 const rollback=Error('rollback owned corruption');
 for(const mutation of [sql`update builder_jobs set completed_at=null where id=${f.workshop.jobId}`,sql`delete from builder_jobs where id=${f.workshop.jobId}`])await expect(db.transaction(async tx=>{
  await tx.execute(sql`set local session_replication_role=replica`);await tx.execute(mutation);await tx.execute(sql`set local session_replication_role=origin`);
  await expect(readServiceActivity(tx,f.wallet,f.baseId,current,f.now)).rejects.toMatchObject({cause:{message:'SERVICE_ACTIVITY_ORIGINAL'}});throw rollback;
 })).rejects.toBe(rollback);
 for(const mutation of ['alter table bound_cosmetic_jobs disable trigger bound_cosmetic_guard','grant select(record) on service_activity_contract to public',
  "create or replace function public.shardkeep_service_activity_contract() returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$select '{}'::jsonb$$"])
 await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await tx`select public.shardkeep_service_activity(${f.wallet},${f.baseId},${JSON.stringify(current)}::jsonb,${f.now})`;})).rejects.toThrow();
 const g=await fixture();const [building]=await db.insert(buildings).values({baseId:g.baseId,playerWallet:g.wallet,type:BuildingType.Harvester,level:1,tx:20,ty:20}).returning();
 await db.insert(builderJobs).values({baseId:g.baseId,playerWallet:g.wallet,buildingId:building!.id,kind:'build',startedAt:g.now,finishesAt:new Date(+g.now+60000)});
 expect((await state(g)).serviceActivity!.services).toContainEqual({buildingId:building!.id,state:'idle'});
});
it('serves genuine normal current HTTP bodies with private runtime roles and removes stale column ACLs',async()=>{
 const f=await fixture(),job=await pendingOrdinary(f),role='saapi_'+randomBytes(8).toString('hex'),worker='saworker_'+randomBytes(8).toString('hex');
 const password=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex'),adminUrl=new URL(ADMIN_DATABASE_URL),name=String((await conn.sql`select current_database() name`)[0]!.name);
 const provision=()=>execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{
  PATH:'/opt/homebrew/opt/postgresql@16/bin:'+process.env.PATH,PGHOST:adminUrl.hostname,PGPORT:adminUrl.port,PGDATABASE:name,
  PGUSER:decodeURIComponent(adminUrl.username),PGPASSWORD:decodeURIComponent(adminUrl.password),POSTGRES_USER:decodeURIComponent(adminUrl.username),POSTGRES_PASSWORD:decodeURIComponent(adminUrl.password)||'owned-loopback-trust-fixture',
  DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:workerPassword}});
 let request:ReturnType<typeof createDb>|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
 try{
  provision();await conn.sql`grant select(record) on service_activity_contract to shardkeep_api_runtime`;await conn.sql`grant select(record) on service_activity_contract to shardkeep_worker_runtime`;provision();
  const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;url.username=role;url.password=password;request=createDb(url.toString(),{max:2});
  expect((await request.sql`select has_any_column_privilege(current_user,'service_activity_contract','SELECT,INSERT,UPDATE') seal,
   has_table_privilege(current_user,'bound_cosmetic_jobs','SELECT,INSERT,UPDATE') cosmetic,
   has_table_privilege(current_user,'ordinary_equipment_jobs','SELECT,INSERT,UPDATE') equipment,
   has_function_privilege(current_user,'shardkeep_service_activity(text,uuid,jsonb,timestamptz)','EXECUTE') reader`)[0]).toEqual({seal:false,cosmetic:false,equipment:false,reader:true});
  await expect(request.sql`select * from service_activity_contract`).rejects.toMatchObject({code:'42501'});
  const config={...TEST_CONFIG,FREE_ONBOARDING:'true',MULTI_BASE_ENABLED:'true'} as typeof TEST_CONFIG;
  app=await buildApp(config,request.db,{boundCosmeticWorkshop:createBoundCosmeticWorkshop(db,{awningApplicationReady:false})});const errors:string[]=[];app.addHook('onError',async(_req,_reply,error)=>{errors.push(String(error.cause??error));});await app.ready();
  const [session]=await db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.wallet,session!.id)},path=`/base?baseId=${f.baseId}`;
  expect((await app.inject({url:path})).statusCode).toBe(401);
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.now);
  const active=await app.inject({url:path,cookies});expect(active.statusCode,active.body+JSON.stringify(errors)).toBe(200);expect(active.json().serviceActivity.services).toContainEqual(working(f));
  vi.setSystemTime(job.job.readyAt);const completed=await app.inject({url:path,cookies});expect(completed.statusCode,completed.body+JSON.stringify(errors)).toBe(200);expect(completed.json().serviceActivity.services.every((s:{state:string})=>s.state==='idle')).toBe(true);
  await writeFile('/tmp/service-activity-primary-http-pair.json',JSON.stringify({provenance:{kind:'normal-buildApp-authenticated-inject-response-bodies',
   authority:'Synthetic raw materials, completed facilities and historical Date-only clock; actual ordinary admission, canonical owner precollection, request-role read and automatic completion.',
   limits:'No listening socket, native HTTP, Android rendering, art admission or release proof.',wallet:f.wallet,baseId:f.baseId,workshopId:f.workshop.id},working:active.body,idle:completed.body},null,2)+'\n');
  vi.useRealTimers();await app.close();app=undefined;
  // The first owner prehandler commits just before the deadline. The full
  // restricted read rolls back, collects outside its locks and retries once.
  const raced=await fixture(),racedJob=await pendingOrdinary(raced),deadline=racedJob.job.readyAt;
  const collector=createBoundCosmeticWorkshop(db,{awningApplicationReady:false});let calls=0;
  const crossing={...collector,collectForBaseRead:async(wallet:string,baseId?:string)=>{
   calls++;const selected=await collector.collectForBaseRead(wallet,baseId);if(calls===1)vi.setSystemTime(deadline);return selected;
  }};
  app=await buildApp(config,request.db,{boundCosmeticWorkshop:crossing});await app.ready();
  const [raceSession]=await db.insert(sessions).values({wallet:raced.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const raceCookies={[SESSION_COOKIE]:await issueSessionJwt(config,raced.wallet,raceSession!.id)};
  await ensureStartingBase(db,raced.wallet,raced.baseId,raced.authority.assertAuthority);
  const beforeRaw=await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${raced.baseId}`;
  const beforeMoney=await conn.sql`select id,balance from accounts where base_id=${raced.baseId} order by id`;
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(+deadline-1));
  const raceResponse=await app.inject({url:`/base?baseId=${raced.baseId}`,cookies:raceCookies});expect(raceResponse.statusCode,raceResponse.body).toBe(200);expect(calls).toBe(2);
  expect(raceResponse.json().serviceActivity.services.every((s:{state:string})=>s.state==='idle')).toBe(true);
  expect(await conn.sql`select job_id from ordinary_crafting_completions where job_id=${racedJob.job.id}`).toHaveLength(1);
  expect((await conn.sql`select available,pending_output from crafting_stocks where base_id=${raced.baseId} and item_id=${racedJob.job.outputItemId}`)[0]).toEqual({available:racedJob.job.outputQuantity.toString(),pending_output:'0'});
  expect(await conn.sql`select resource_id,available,reserved from resource_stocks where base_id=${raced.baseId}`).toEqual(beforeRaw);
  expect(await conn.sql`select id,balance from accounts where base_id=${raced.baseId} order by id`).toEqual(beforeMoney);
  vi.useRealTimers();await app.close();app=undefined;
  // Missing collection and a non-progressing second collection are bounded
  // holds; their attempted automatic builder settlement must not escape.
  const held=await fixture(),heldJob=await pendingOrdinary(held);held.now=heldJob.job.readyAt;
  const [incomplete]=await db.insert(buildings).values({baseId:held.baseId,playerWallet:held.wallet,type:BuildingType.Workshop,level:1,tx:25,ty:25}).returning();
  const [build]=await db.insert(builderJobs).values({baseId:held.baseId,playerWallet:held.wallet,buildingId:incomplete!.id,kind:'build',startedAt:new Date(+held.now-60000),finishesAt:held.now}).returning();
  const readHeld=(collect?:()=>Promise<unknown>)=>getBaseState(request!.db,held.wallet,held.now,held.baseId,held.authority.assertAuthority,()=>held.now,undefined,collect);
  await expect(readHeld()).rejects.toMatchObject({statusCode:503,code:'ORDINARY_CRAFTING_COLLECTION_REQUIRED'});
  let retries=0;await expect(readHeld(async()=>{retries++;})).rejects.toMatchObject({statusCode:503,code:'ORDINARY_CRAFTING_COLLECTION_REQUIRED'});expect(retries).toBe(1);
  expect((await db.select().from(builderJobs).where(eq(builderJobs.id,build!.id)))[0]!.completedAt).toBeNull();
  expect(await conn.sql`select job_id from ordinary_crafting_completions where job_id=${heldJob.job.id}`).toHaveLength(0);
  const heldCollector=createBoundCosmeticWorkshop(db,{awningApplicationReady:false,clock:()=>held.now});let secondJob:string|undefined;let secondCollections=0;
  await expect(readHeld(async()=>{
   secondCollections++;await heldCollector.collectForBaseRead(held.wallet,held.baseId);
   const next=await pendingOrdinary(held,'refine_heartwood_beams');secondJob=next.job.id;held.now=next.job.readyAt;
  })).rejects.toMatchObject({statusCode:503,code:'ORDINARY_CRAFTING_COLLECTION_REQUIRED'});expect(secondCollections).toBe(1);
  expect(await conn.sql`select job_id from ordinary_crafting_completions where job_id=${secondJob!}`).toHaveLength(0);
  const callback=vi.fn(async()=>{});await expect(request.db.transaction(tx=>getBaseState(tx,held.wallet,held.now,held.baseId,held.authority.assertAuthority,()=>held.now,undefined,callback))).rejects.toThrow('top-level base read');expect(callback).not.toHaveBeenCalled();
  // Ownership can change after the full rollback and before retry. Fresh locks
  // must reject the old wallet even if the canonical owner collector succeeded.
  const buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();await db.insert(players).values({wallet:buyer});
  await expect(getBaseState(request.db,held.wallet,held.now,held.baseId,held.authority.assertAuthority,()=>held.now,undefined,async()=>{
   await db.update(bases).set({deedAssetId:deed,deedMintAssetId:deed,landPaidAt:new Date()}).where(eq(bases.id,held.baseId));
   await transferStableBase(db,held.baseId,held.wallet,buyer,deed,{owner:buyer,collection,frozen:false,delegate:null,slot:100,observedAtMs:Date.now()},()=>new Date());
  })).rejects.toMatchObject({code:'BASE_NOT_OWNED'});
  expect(await conn.sql`select job_id from ordinary_crafting_completions where job_id=${heldJob.job.id}`).toHaveLength(1);
  await conn.sql`revoke execute on function public.shardkeep_service_activity(text,uuid,jsonb,timestamptz) from shardkeep_api_runtime`;
  await expect(request.db.transaction(tx=>readServiceActivity(tx,f.wallet,f.baseId,[],new Date()))).rejects.toMatchObject({cause:{code:'42501'}});
 }finally{await app?.close();await request?.sql.end();for(const login of [role,worker]){await conn.sql.unsafe(`drop owned by ${login}`);await conn.sql.unsafe(`drop role ${login}`);}}
},60000);

it('returns explicit unavailable when a genuine cosmetic deadline crosses after the prehandler commit',async()=>{
 const f=await fixture(),job=await cosmetic(f),deadline=new Date(job.receipt.readyAt),beforeDeadline=new Date(+deadline-1);
 const provider=createBoundCosmeticWorkshop(db,{awningApplicationReady:false,clock:()=>beforeDeadline});
 const config={...TEST_CONFIG,FREE_ONBOARDING:'true',MULTI_BASE_ENABLED:'true'} as typeof TEST_CONFIG;
 const app=await buildApp(config,db,{boundCosmeticWorkshop:{...provider,collectForBaseRead:async(wallet,baseId)=>{
  const selected=await provider.collectForBaseRead(wallet,baseId);vi.setSystemTime(deadline);return selected;
 }}});await app.ready();
 try{
  const [session]=await db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.wallet,session!.id)};
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(beforeDeadline);
  const response=await app.inject({url:`/base?baseId=${f.baseId}`,cookies});expect(response.statusCode,response.body).toBe(200);
  expect(response.json().serviceActivity).toBeNull();expect(await conn.sql`select job_id from bound_cosmetic_completions where job_id=${job.receipt.jobId}`).toHaveLength(0);
 }finally{vi.useRealTimers();await app.close();}
});
