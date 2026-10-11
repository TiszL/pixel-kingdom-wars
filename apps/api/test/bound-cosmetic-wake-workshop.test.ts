/** Local owned PG16 fixtures; synthetic readiness proves the gate, never C5 delivery. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {BoundCosmeticAppearanceSchema} from '@shardkeep/shared/boundCosmeticApi';
import {BoundCosmeticWakeWorkshopViewSchema} from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import {createBoundCosmeticWorkshop} from '../src/game/boundCosmeticWorkshop';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {boundCosmeticFixture,cosmeticMaterials,cosmeticStock,pendingOrdinary} from './fixtures/boundCosmetics';
import {settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {createTestPlayer,TEST_CONFIG} from './helpers';
import {createDb} from '../src/db/client';
import {createPhaseEServices} from '../src/phaseEServices';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {ADMIN_DATABASE_URL} from './db-url';
const conn=resourceClaimsDatabase(),db=conn.db,capture:Record<string,unknown>={provenance:'Actual primary provider/HTTP on isolated PG16 full journal287; historical local facility/raw stock fixtures and explicitly synthetic readiness. No C5 consumer, renderer or production admission.'};
beforeAll(()=>conn.setup(),120000);afterAll(async()=>{await conn.close();if(capture.completed&&capture.runtime)await writeFile('/tmp/bound-cosmetic-wake-workshop-pair.json',JSON.stringify(capture,null,2)+'\n');});
beforeEach(()=>{for(const name of ['MULTI_BASE_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(name,'true');});afterEach(()=>vi.unstubAllEnvs());
async function prepared(settle=true){
 const f=await boundCosmeticFixture(db),at=new Date(Date.now()-86400000),shift=+at-+f.now;
 await conn.sql`update builder_jobs set started_at=started_at+${shift}*interval '1 millisecond',finishes_at=finishes_at+${shift}*interval '1 millisecond',completed_at=completed_at+${shift}*interval '1 millisecond' where base_id=${f.baseId}`;
 f.now=at;const source=await pendingOrdinary(f);f.now=source.job.readyAt;if(settle)await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
 const recipe=await cosmeticMaterials(f,'craft_aurora_wake_v1'),[binding]=await conn.sql`select public.shardkeep_bound_cosmetic_appearance('aurora_wake') appearance`,appearance=BoundCosmeticAppearanceSchema.parse(binding!.appearance);
 const request={idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:recipe.recipeId,recipeVersion:recipe.recipeVersion,appearanceBindingSha256:appearance.bindingSha256};
 const provider=createBoundCosmeticWorkshop(db,{awningApplicationReady:true,clock:()=>f.now,wakeApplicationReady:a=>JSON.stringify(a)===JSON.stringify(appearance)});
 return {f,source,recipe,appearance,request,provider};
}
it('composes authentic first Blueprint, exact Aurora recipe and same-transaction Lodge/stock/queue while v1 remains four Awnings',async()=>{
 const {f,source,request,provider}=await prepared(false),old=await provider.view(f.wallet,f.baseId),before=await provider.wake.view(f.wallet,f.baseId);
 expect(old.recipes).toHaveLength(4);expect(old.selectedBase).not.toHaveProperty('lodges');
 expect(before.blueprint).toMatchObject({state:'eligible',proof:{jobId:source.job.id}});expect(before.recipe.recipe.recipeId).toBe('craft_aurora_wake_v1');
 expect(before.selectedBase).toMatchObject({workshops:[{buildingId:f.workshop.id}],lodges:[{buildingId:f.lodge.id}],queue:[]});expect(before.selectedBase).not.toHaveProperty('markets');
 const stock=await cosmeticStock(f);await conn.sql`update buildings set level=0 where id=${f.market.id}`;
 const started=await provider.wake.start(f.wallet,request);if(started.status!=='accepted')throw Error('Original missing');
 const pending=await provider.wake.view(f.wallet,f.baseId);expect(pending.selectedBase).toMatchObject({queue:[{kind:'cosmetic',jobId:request.idempotencyKey}]});
 const after=await cosmeticStock(f);for(const input of started.receipt.recipe.inputs)expect(after.find(s=>s.itemId===input.itemId)!.available).toBe(stock.find(s=>s.itemId===input.itemId)!.available-BigInt(input.quantity));
 await expect(provider.wake.start(f.wallet,{...request,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'BOUND_COSMETIC_ALREADY_OWNED'});
 f.now=new Date(started.receipt.readyAt);const completed=await provider.wake.view(f.wallet,f.baseId);expect(completed.original?.completion).not.toBeNull();expect(completed.selectedBase).toMatchObject({queue:[]});
 capture.before=before;capture.pending=pending;capture.completed=completed;capture.original=started;
});
it('refuses missing Lodge, insufficient materials and common busy queue before an Aurora debit',async()=>{
 const {f,provider,request}=await prepared(),stock=await cosmeticStock(f);
 await conn.sql`update buildings set level=0 where id=${f.lodge.id}`;await expect(provider.wake.start(f.wallet,request)).rejects.toMatchObject({code:'BOUND_COSMETIC_FACILITY_REQUIRED'});expect(await cosmeticStock(f)).toEqual(stock);
 await conn.sql`update buildings set level=1 where id=${f.lodge.id}`;const busy=await pendingOrdinary(f,'refine_crownsteel');
 expect((await provider.wake.view(f.wallet,f.baseId)).selectedBase).toMatchObject({queue:[{kind:'ordinary',jobId:busy.job.id}]});await expect(provider.wake.start(f.wallet,request)).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
 f.now=busy.job.readyAt;await provider.wake.view(f.wallet,f.baseId);await conn.sql`update crafting_stocks set available=0 where base_id=${f.baseId} and item_id='prismstone_lens'`;
 await expect(provider.wake.start(f.wallet,request)).rejects.toMatchObject({code:'INSUFFICIENT_CRAFTING_STOCK'});expect((await provider.read(f.wallet,request.idempotencyKey)).status).toBe('unknown');
});
it('keeps original completion/replay after transfer, pause and missing C5; Off is account-wide without a selected base',async()=>{
 const {f,provider,request}=await prepared(),held=createBoundCosmeticWorkshop(db,{awningApplicationReady:true,clock:()=>f.now});
 expect((await held.wake.view(f.wallet)).applicationReady).toBe(false);await expect(held.wake.start(f.wallet,request)).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 const started=await provider.wake.start(f.wallet,request);if(started.status!=='accepted')throw Error('Missing original');
 const buyer=await createTestPlayer(db);await conn.sql.begin(async tx=>{await tx`delete from base_slots where base_id=${f.baseId}`;await tx`update bases set owner_wallet=${buyer.wallet} where id=${f.baseId}`;await tx`insert into base_slots(wallet,slot,base_id) values(${buyer.wallet},1,${f.baseId})`;});
 f.now=new Date(started.receipt.readyAt);vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');
 expect((await held.wake.start(f.wallet,request)).receipt).toEqual(started.receipt);expect((await held.read(f.wallet,request.idempotencyKey)).completion).not.toBeNull();
 expect((await held.read(buyer.wallet,request.idempotencyKey)).status).toBe('unknown');await expect(held.wake.start(f.wallet,{...request,baseId:randomUUID()})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
 await expect(held.wake.preference(f.wallet,{enabled:true,expectedRevision:'0'})).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 const off=await held.wake.preference(f.wallet,{enabled:false,expectedRevision:'0'});expect(off).toMatchObject({enabled:false,revision:'1'});expect(await held.wake.preference(f.wallet,{enabled:false,expectedRevision:'0'})).toEqual(off);
 expect((await held.wake.view(f.wallet)).original?.receipt).toEqual(started.receipt);
});
it('requires completed entitlement for free On and preserves exact CAS retries without inverse toggles',async()=>{
 const {f,provider,request}=await prepared();await expect(provider.wake.preference(f.wallet,{enabled:true,expectedRevision:'0'})).rejects.toMatchObject({code:'BOUND_COSMETIC_WAKE_NOT_OWNED'});
 const original=await provider.wake.start(f.wallet,request);if(original.status!=='accepted')throw Error('Missing original');
 await expect(provider.wake.preference(f.wallet,{enabled:true,expectedRevision:'0'})).rejects.toMatchObject({code:'BOUND_COSMETIC_WAKE_NOT_OWNED'});
 f.now=new Date(original.receipt.readyAt);const on=await provider.wake.preference(f.wallet,{enabled:true,expectedRevision:'0'});expect(on).toMatchObject({enabled:true,revision:'1'});
 expect(await provider.wake.preference(f.wallet,{enabled:true,expectedRevision:'0'})).toEqual(on);
 await expect(provider.wake.preference(f.wallet,{enabled:false,expectedRevision:'0'})).rejects.toMatchObject({code:'BOUND_COSMETIC_PREFERENCE_CHANGED'});
 const current=await provider.wake.view(f.wallet);expect(current.preference).toEqual(on);expect(current.selectedBase).toBeNull();capture.on=current;
 await expect(provider.wake.preference(f.wallet,{enabled:false,expectedRevision:'1',baseId:f.baseId})).rejects.toThrow();
});
it('rolls material spending and preference On back if exact readiness disappears at the final locked check',async()=>{
 const {f,appearance,request,provider}=await prepared(),before=await cosmeticStock(f);let checks=0;
 const dropping=createBoundCosmeticWorkshop(db,{awningApplicationReady:true,clock:()=>f.now,wakeApplicationReady:a=>{expect(a).toEqual(appearance);return ++checks<3;}});
 await expect(dropping.wake.start(f.wallet,request)).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});expect(checks).toBe(3);expect(await cosmeticStock(f)).toEqual(before);expect((await provider.read(f.wallet,request.idempotencyKey)).status).toBe('unknown');
 const original=await provider.wake.start(f.wallet,request);if(original.status!=='accepted')throw Error('Missing original');f.now=new Date(original.receipt.readyAt);checks=0;
 await expect(dropping.wake.preference(f.wallet,{enabled:true,expectedRevision:'0'})).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});expect(checks).toBe(3);
 expect((await provider.wake.view(f.wallet)).preference.enabled).toBe(false);expect((await provider.wake.view(f.wallet)).preference.revision).toBe('0');
});
it('fails loud on invalid source without losing the common original or publishing fake off',async()=>{
 const {f,provider,request}=await prepared(),original=await provider.wake.start(f.wallet,request);await conn.sql`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`;
 try{await expect(provider.wake.view(f.wallet)).rejects.toMatchObject({code:'BOUND_COSMETIC_WAKE_SOURCE'});await expect(provider.wake.preference(f.wallet,{enabled:false,expectedRevision:'0'})).rejects.toMatchObject({code:'BOUND_COSMETIC_WAKE_SOURCE'});expect((await provider.read(f.wallet,request.idempotencyKey)).receipt).toEqual(original.receipt);}
 finally{await conn.sql`alter table bound_cosmetic_wake_preferences enable trigger bound_cosmetic_wake_preference_guard`;}
 expect((await provider.wake.view(f.wallet)).original?.receipt).toEqual(original.receipt);
});
it('mounts authenticated opt-in through actual restricted LOGIN while normal startup holds all new Wake spending and On',async()=>{
 const {f,request:command}=await prepared(),[database]=await conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;
 const suffix=randomUUID().replaceAll('-',''),role='wakew_api_'+suffix,worker='wakew_worker_'+suffix,password=randomBytes(32).toString('hex');
 execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,
  PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),POSTGRES_USER:decodeURIComponent(url.username),POSTGRES_PASSWORD:decodeURIComponent(url.password)||'owned-loopback-trust-fixture',DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password=password;const request=createDb(runtimeUrl.toString(),{max:4}),config={...TEST_CONFIG,DATABASE_URL:runtimeUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:url.toString()};
 const services=await createPhaseEServices(config,request.db),app=await buildApp(config,request.db,services!.deps),absent=await buildApp(config,request.db);
 try{
  const [grants]=await request.sql`select has_table_privilege(current_user,'bound_cosmetic_wake_preferences','SELECT,UPDATE') table_access,has_function_privilege(current_user,'shardkeep_bound_cosmetic_wake_preference(text,boolean,bigint,timestamptz)','EXECUTE') writer`;expect(grants).toEqual({table_access:false,writer:false});
  const [session]=await conn.sql`insert into sessions(wallet,expires_at) values(${f.wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`,cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.wallet,session!.id)},headers={origin:config.WEB_ORIGIN[0]!};
  const endpoints=[{method:'GET' as const,url:'/bound-cosmetics/wakes/v1/workshop'},{method:'POST' as const,url:'/bound-cosmetics/wakes/v1/jobs',payload:command},{method:'PUT' as const,url:'/bound-cosmetics/wakes/v1/preference',payload:{enabled:false,expectedRevision:'0'}}];
  for(const endpoint of endpoints){expect((await absent.inject({...endpoint,headers})).statusCode).toBe(401);expect((await absent.inject({...endpoint,headers,cookies})).statusCode).toBe(503);}
  const view=await app.inject({url:'/bound-cosmetics/wakes/v1/workshop?baseId='+f.baseId,cookies});expect(view.statusCode,view.body).toBe(200);expect(view.headers['cache-control']).toBe('private, no-store');
  const body=BoundCosmeticWakeWorkshopViewSchema.parse(view.json());expect(body.applicationReady).toBe(false);expect(body.acceptingJobs).toBe(false);capture.runtime=body;
  for(const entry of [{method:'POST' as const,url:endpoints[1]!.url,payload:command},{method:'PUT' as const,url:endpoints[2]!.url,payload:{enabled:true,expectedRevision:'0'}}])expect((await app.inject({...entry,cookies,headers})).statusCode).toBe(503);
  for(const name of ['MULTI_BASE_ENABLED','PHASE_E_CATALOG_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(name,'false');
  expect((await app.inject({...endpoints[2]!,cookies,headers})).json()).toMatchObject({enabled:false,revision:'1'});
  for(const payload of [{enabled:false,expectedRevision:'1',wallet:f.wallet},{enabled:false,expectedRevision:'1',baseId:f.baseId},{enabled:false,expectedRevision:1}])expect((await app.inject({method:'PUT',url:endpoints[2]!.url,cookies,headers,payload})).statusCode).toBe(400);
  expect((await app.inject({url:endpoints[0]!.url+'?wallet='+f.wallet,cookies})).statusCode).toBe(400);
  expect((await app.inject({url:endpoints[0]!.url.replace('/v1/','/v2/'),cookies})).statusCode).toBe(404);
  const legacy=await app.inject({url:'/bound-cosmetics',cookies});expect(legacy.statusCode,legacy.body).toBe(200);expect(legacy.json().recipes).toHaveLength(4);
 }finally{await app.close();await absent.close();await services!.close();await request.sql.end();for(const name of [role,worker]){await conn.sql.unsafe(`drop owned by ${name}`);await conn.sql.unsafe(`drop role ${name}`);}}
},120000);
