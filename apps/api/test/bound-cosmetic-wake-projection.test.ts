/** Actual primary Wake DTOs from disposable full-journal PostgreSQL fixtures.
 * Local signed Core/term fixtures are not production login, release or art proof. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFile,readFile,cp,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {Keypair,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {BoundCosmeticWakePreferenceResponseSchema} from '@shardkeep/shared/boundCosmeticWake';
import {StarterExpeditionEnvelopeSchema,StarterExpeditionViewSchema} from '@shardkeep/shared/starterExpeditionApi';
import {AdvancedExpeditionEnvelopeSchema} from '@shardkeep/shared/advancedExpeditionApi';
import {AdvancedFleetEnvelopeSchema} from '@shardkeep/shared/advancedFleetApi';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {boundCosmeticFixture,earnBoundBlueprint,cosmeticMaterials,cosmeticInsert} from './fixtures/boundCosmetics';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {createAdvancedFleetView} from '../src/game/advancedFleetView';
import {createAdvancedExpeditionWorkflow} from '../src/game/advancedExpeditionWorkflow';
import {createStarterExpeditionWorkflow,createUnfittedStarterExpeditionWorkflow} from '../src/game/starterExpeditionWorkflow';
import {boundCosmeticOriginalWakeFields} from '../src/game/boundCosmeticWakePresentation';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {dispatchAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {settleDueAdvancedExpeditions} from '../src/game/advancedExpeditionReturns';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bootstrapSystemAccounts} from '../src/ledger';
import {ADMIN_DATABASE_URL} from './db-url';

const conn=resourceClaimsDatabase(),plain={state:'available',visual:{version:1,wake:null}},unavailable={state:'unavailable',visual:null};
const capture:{provenance:Record<string,unknown>;starter:Record<string,unknown>;advanced:Record<string,unknown>;legacy:Record<string,unknown>}={
 provenance:{kind:'local_private_primary_v1_sidecar_fixture',source:'Unchanged primary receipt DTOs paired with separate v1 presentation functions, PostgreSQL16 isolated loopback; synthetic locally signed chain/term and historical clocks. No production login, native assets, deployment or renderer proof.'},starter:{},advanced:{},legacy:{}};
const flags=()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_CATALOG_ENABLED','ORDINARY_CRAFTING_ENABLED','PHASE_E_VEHICLES_ENABLED','STARTER_EXPEDITIONS_ENABLED'])vi.stubEnv(flag,'true');};
// 2026-10-10 (CI 37503885235): the provenance claims a FULL-journal fixture. The old literal 295
// was the journal length when this capture was written and broke at 300 (0297..0299 + 0500); pin the claim itself.
beforeAll(async()=>{await conn.setup();const [row]=await conn.sql`select count(*)::integer count from drizzle.__drizzle_migrations`;
 const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8')) as {entries:unknown[]};
 expect(row!.count).toBe(journal.entries.length);capture.provenance.migrations=row!.count;},120000);
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
afterAll(async()=>{await conn.close();if(capture.starter.selected&&capture.starter.default&&capture.starter.unavailable&&capture.advanced.selected&&capture.advanced.default&&capture.advanced.unavailable&&capture.legacy.starter)await writeFile('/tmp/bound-cosmetic-wake-primary-pair.json',JSON.stringify(capture,null,2)+'\n');});
const clock=(at:Date)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);};
async function earned(wallet?:string){
 flags();const f=await boundCosmeticFixture(conn.db,{slot:2,...wallet?{wallet}:{}});f.now=new Date(Date.now()-3*86400000);
 await conn.sql`update builder_jobs set started_at=started_at-interval '20 years',finishes_at=finishes_at-interval '20 years',completed_at=completed_at-interval '20 years' where base_id=${f.baseId}`;
 await earnBoundBlueprint(f);await cosmeticMaterials(f,'craft_aurora_wake_v1');const job=await cosmeticInsert(f,'craft_aurora_wake_v1');
 await conn.sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${job.id},${job.readyAt.toISOString()})`;
 const [row]=await conn.sql`select public.shardkeep_bound_cosmetic_wake_preference(${f.wallet},true,0,${job.readyAt.toISOString()}::timestamptz) response`;
 const selected=BoundCosmeticWakePreferenceResponseSchema.parse(row!.response);return {...f,job,selected};
}
const off=(wallet:string,at:Date)=>conn.sql`select public.shardkeep_bound_cosmetic_wake_preference(${wallet},false,1,${at.toISOString()}::timestamptz)`;
async function custody(baseId:string,oldWallet:string){
 const buyer=Keypair.generate().publicKey.toBase58();await conn.sql`insert into players(wallet) values(${buyer})`;
 await conn.sql.begin(async tx=>{await tx`select wallet from players where wallet in(${oldWallet},${buyer}) order by wallet for update`;
  await tx`select id from bases where id=${baseId} for update`;await tx`delete from base_slots where base_id=${baseId}`;
  await tx`update bases set owner_wallet=${buyer},status='active' where id=${baseId}`;await tx`insert into base_slots(wallet,slot,base_id) values(${buyer},1,${baseId})`;
 });return buyer;
}
const accepted=<T extends {status:string;receipt:unknown}>(value:T)=>{expect(value.status).toBe('accepted');if(value.status!=='accepted'||!value.receipt)throw Error('Fixture original missing');return value;};


import {createBoundCosmeticWakeViews} from '../src/game/boundCosmeticWakeViews';
import {BoundCosmeticWakeOriginalEnvelopeSchema,BoundCosmeticWakeCurrentEnvelopeSchema} from '@shardkeep/shared/boundCosmeticWakePresentation';
import {buildApp} from '../src/app';
import {createPhaseEServices} from '../src/phaseEServices';
import {TEST_CONFIG} from './helpers';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
const known=(value:Awaited<ReturnType<ReturnType<typeof createBoundCosmeticWakeViews>['original']>>)=>{expect(value.status).toBe('known');if(value.status!=='known')throw Error('Missing original');return value;};
const views=()=>createBoundCosmeticWakeViews(conn.db);
const tripKeys=['kind','expeditionId','installationId','homeRealmId','realmId','departedAt','returnsAt','wake'].sort();
function neverRequest():never{throw Error('Expected accepted original');}
async function advanced(){
 flags();const initial=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000);
 const f=await vehicleBurnDatabase('survey_balloon',1,{}, {connection:conn,completedAt:new Date(+initial-3600000)});
 f.finalizeBurn();await createVehicleInstallations(conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const lodge=randomUUID(),complete=new Date(+initial-3600000).toISOString();await conn.sql`insert into buildings(id,base_id,player_wallet,type,tx,ty) values(${lodge},${f.baseId},${f.actor},'lodge',5,5)`;
 await conn.sql`insert into builder_jobs(base_id,player_wallet,building_id,kind,started_at,finishes_at,completed_at) values(${f.baseId},${f.actor},${lodge},'build',${new Date(+initial-7200000).toISOString()},${complete},${complete})`;
 await conn.sql`insert into resource_stocks(base_id,resource_id,available) values(${f.baseId},'rough_prism',1000)`;
 const authority={baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
 const bank=await createMiningTermFixture({day:initial.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 return {...f,initial,authority,async dispatch(at:Date){clock(at);bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+at/1000)),32);
  const command={id:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'coastal_survey',policyVersion:1};
  const trip=await dispatchAdvancedExpedition(conn.db,f.actor,command,authority,{reader:await prefetchExpeditionTermReader(bank.connect,bank.policy),clock:()=>at});return {trip,command};
 }};
}

it('pairs a versioned starter sidecar with unchanged originals through off, outage, transfer and actual return',async()=>{
 const f=await earned(),at=new Date(+f.job.readyAt+1000);clock(at);const s=await createStarterExpeditionFixture(conn.db,{wallet:f.wallet,now:at});
 const trip=await s.dispatch(),workflow=createStarterExpeditionWorkflow(conn.db),service=views();
 const original=StarterExpeditionEnvelopeSchema.parse(await workflow.read(f.wallet,trip.id));accepted(original);
 const current=BoundCosmeticWakeCurrentEnvelopeSchema.parse(await service.current(f.wallet,s.baseId));
 const sidecar=known(BoundCosmeticWakeOriginalEnvelopeSchema.parse(await service.original(f.wallet,'starter',trip.id)));
 expect(sidecar.presentation).toMatchObject({expeditionId:trip.id,baseId:s.baseId,installationId:trip.installationId,departedAt:trip.departedAt.toISOString(),returnsAt:trip.returnsAt.toISOString(),wake:f.selected.visual});
 expect(current.trips[0]!.wake).toEqual(f.selected.visual);expect(Object.keys(current.trips[0]!).sort()).toEqual(tripKeys);
 expect(original.receipt).not.toHaveProperty('boundCosmeticWake');
 await off(f.wallet,new Date(+at+1));vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');
 const replay=await workflow.start(f.wallet,original.status==='accepted'?original.receipt.request:neverRequest());expect(replay.created).toBe(false);expect(replay.envelope.receipt).toEqual(original.receipt);
 expect(known(await service.original(f.wallet,'starter',trip.id)).presentation).toEqual(sidecar.presentation);
 const before=await conn.sql`select * from bound_cosmetic_starter_wakes where expedition_id=${trip.id}`;
 await conn.sql`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`;
 try{
  expect((await service.current(f.wallet,s.baseId)).trips[0]!.wake).toEqual(unavailable);
  await expect(service.original(f.wallet,'starter',trip.id)).rejects.toMatchObject({statusCode:503,code:'BOUND_COSMETIC_WAKE_ORIGINAL_UNAVAILABLE'});
  expect((await workflow.read(f.wallet,trip.id)).receipt).toEqual(original.receipt); // appearance outage cannot rewrite old receipt
  const foreign=Keypair.generate().publicKey.toBase58();const other=await service.original(foreign,'starter',randomUUID());expect(await service.original(foreign,'starter',trip.id)).toEqual({...other,key:trip.id});
  expect(await service.original(foreign,'starter',trip.id)).toMatchObject({status:'unknown',presentation:null,returnedAt:null});
  expect(await conn.sql`select * from bound_cosmetic_starter_wakes where expedition_id=${trip.id}`).toEqual(before);
 }finally{await conn.sql`alter table bound_cosmetic_wake_preferences enable trigger bound_cosmetic_wake_preference_guard`;}
 expect(known(await service.original(f.wallet,'starter',trip.id)).presentation).toEqual(sidecar.presentation);
 const buyer=await custody(s.baseId,f.wallet),buyerCurrent=await service.current(buyer,s.baseId);
 expect(buyerCurrent.trips).toEqual(current.trips);expect(JSON.stringify(buyerCurrent)).not.toContain(f.wallet);
 expect(await service.original(buyer,'starter',trip.id)).toMatchObject({status:'unknown',presentation:null});
 await expect(service.current(f.wallet,s.baseId)).rejects.toMatchObject({statusCode:404});
 clock(new Date(+trip.returnsAt+1000));expect((await service.current(buyer,s.baseId)).trips).toEqual(current.trips); // due time is not completion
 expect((await service.original(f.wallet,'starter',trip.id)).returnedAt).toBeNull();
 const returned=await conn.db.transaction(tx=>settleDueStarterExpeditions(tx,s.baseId,trip.returnsAt));expect(returned).toHaveLength(1);
 const returnedOriginal=await workflow.read(f.wallet,trip.id),returnedSidecar=known(await service.original(f.wallet,'starter',trip.id));
 expect(returnedOriginal.receipt).toEqual(original.receipt);expect(returnedSidecar.presentation).toEqual(sidecar.presentation);
 expect(returnedSidecar.returnedAt).toBe(returnedOriginal.return?.returnedAt);const afterReturnCurrent=await service.current(buyer,s.baseId);expect(afterReturnCurrent.trips).toEqual([]);
 capture.starter.selected={original,sidecar,current,returnedOriginal,returnedSidecar,afterReturnCurrent};
});

it('distinguishes actual captured off and unavailable without extending existing starter DTOs',async()=>{
 for(const state of ['default','unavailable'] as const){
  vi.useRealTimers();flags();const at=new Date(Date.now()-86400000);clock(at);const f=await createStarterExpeditionFixture(conn.db,{now:at});
  if(state==='default')await f.dispatch();else await conn.db.transaction(async tx=>{
   await tx.execute(sql`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`);
   await dispatchStarterExpedition(tx,f.wallet,f.command,f.authority,{reader:f.reader,clock:()=>f.now});
   await tx.execute(sql`alter table bound_cosmetic_wake_preferences enable trigger bound_cosmetic_wake_preference_guard`);
  });
  const workflow=createStarterExpeditionWorkflow(conn.db),view=await workflow.view(f.wallet,{baseId:f.baseId}),original=await workflow.read(f.wallet,f.command.id);accepted(original);
  const current=await views().current(f.wallet,f.baseId),sidecar=known(await views().original(f.wallet,'starter',f.command.id)),expected=state==='default'?plain:unavailable;
  expect(sidecar.presentation.wake).toEqual(expected);expect(current.trips[0]!.wake).toEqual(expected);
  expect(view.flight).not.toHaveProperty('boundCosmeticWake');expect(original.receipt).not.toHaveProperty('boundCosmeticWake');capture.starter[state]={view,original,current,sidecar};
 }
});

it('redacts advanced active presentation while private sidecar remains paired through transfer, outage and actual return',async()=>{
 const f=await advanced(),ornament=await earned(f.actor),at=new Date(+ornament.job.readyAt+1000),{trip}=await f.dispatch(at),service=views();
 const workflow=createAdvancedExpeditionWorkflow(conn.db),original=AdvancedExpeditionEnvelopeSchema.parse(await workflow.read(f.actor,trip.id));accepted(original);
 const fleet=AdvancedFleetEnvelopeSchema.parse(await createAdvancedFleetView(conn.db).read(f.actor,f.baseId));expect(fleet.vehicles[0]).not.toHaveProperty('flight');
 const current=await service.current(f.actor,f.baseId),sidecar=known(await service.original(f.actor,'advanced',trip.id));
 expect(current.trips[0]!.wake).toEqual(ornament.selected.visual);expect(Object.keys(current.trips[0]!).sort()).toEqual(tripKeys);
 for(const value of [trip.termId,trip.termHash,ornament.job.id,f.identity.assetId])expect(JSON.stringify(current.trips)).not.toContain(value);
 expect(original.receipt).not.toHaveProperty('boundCosmeticWake');await off(f.actor,new Date(+at+1));vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');f.setOnline(false);
 const proofBefore=await conn.sql`select * from bound_cosmetic_advanced_wakes where expedition_id=${trip.id}`;
 await conn.sql`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`;
 try{
  expect((await service.current(f.actor,f.baseId)).trips[0]!.wake).toEqual(unavailable);
  await expect(service.original(f.actor,'advanced',trip.id)).rejects.toMatchObject({statusCode:503});
  expect((await workflow.read(f.actor,trip.id)).receipt).toEqual(original.receipt);
  expect(await service.original(Keypair.generate().publicKey.toBase58(),'advanced',trip.id)).toMatchObject({status:'unknown',presentation:null});
  expect(await conn.sql`select * from bound_cosmetic_advanced_wakes where expedition_id=${trip.id}`).toEqual(proofBefore);
 }finally{await conn.sql`alter table bound_cosmetic_wake_preferences enable trigger bound_cosmetic_wake_preference_guard`;}
 expect(known(await service.original(f.actor,'advanced',trip.id)).presentation).toEqual(sidecar.presentation);
 const buyer=await custody(f.baseId,f.actor),buyerCurrent=await service.current(buyer,f.baseId);expect(buyerCurrent.trips).toEqual(current.trips);expect(JSON.stringify(buyerCurrent)).not.toContain(f.actor);
 expect(await service.original(buyer,'advanced',trip.id)).toMatchObject({status:'unknown',presentation:null});await expect(service.current(f.actor,f.baseId)).rejects.toMatchObject({statusCode:404});
 expect((await workflow.dispatch(f.actor,original.status==='accepted'?original.receipt.request:neverRequest())).receipt).toEqual(original.receipt);
 clock(new Date(+trip.returnsAt+1000));expect((await service.current(buyer,f.baseId)).trips).toEqual(current.trips);expect((await service.original(f.actor,'advanced',trip.id)).returnedAt).toBeNull();
 expect(await conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,trip.returnsAt))).toHaveLength(1);
 const returnedOriginal=await workflow.read(f.actor,trip.id),returnedSidecar=known(await service.original(f.actor,'advanced',trip.id)),afterReturnCurrent=await service.current(buyer,f.baseId);
 expect(returnedOriginal.receipt).toEqual(original.receipt);expect(returnedSidecar.presentation).toEqual(sidecar.presentation);expect(returnedSidecar.returnedAt).toBe(returnedOriginal.return?.returnedAt);expect(afterReturnCurrent.trips).toEqual([]);
 capture.advanced.selected={fleet,original,current,sidecar,returnedOriginal,returnedSidecar,afterReturnCurrent};
},120000);

it('keeps default and explicit unavailable advanced captures distinct from absent history',async()=>{
 const f=await advanced(),service=views(),workflow=createAdvancedExpeditionWorkflow(conn.db),first=await f.dispatch(f.initial);
 const original=await workflow.read(f.actor,first.trip.id),sidecar=known(await service.original(f.actor,'advanced',first.trip.id)),current=await service.current(f.actor,f.baseId);
 expect(sidecar.presentation.wake).toEqual(plain);expect(current.trips[0]!.wake).toEqual(plain);capture.advanced.default={original,sidecar,current};
 await conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,first.trip.returnsAt));
 vi.useRealTimers();await conn.sql`select public.shardkeep_bound_cosmetic_wake_preference(${f.actor},false,0,clock_timestamp())`;
 // Historical local departure predates the newly recorded preference; its actual hook cannot reconstruct it.
 const second=await f.dispatch(new Date(+first.trip.returnsAt+1000)),held=known(await service.original(f.actor,'advanced',second.trip.id)),heldCurrent=await service.current(f.actor,f.baseId),heldOriginal=await workflow.read(f.actor,second.trip.id);
 expect(held.presentation.wake).toEqual(unavailable);expect(heldCurrent.trips[0]!.wake).toEqual(unavailable);capture.advanced.unavailable={original:heldOriginal,sidecar:held,current:heldCurrent};
},120000);

it('reports a real pre-capture legacy sidecar without backfilling or altering its original bytes',async()=>{
 flags();const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),name='wake_legacy_'+randomUUID().replaceAll('-','')+'_test',url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 const old=createDb(url.toString(),{max:4}),folder=await mkdtemp(join(tmpdir(),'wake-sidecar-legacy-'));
 try{
  const migrations=fileURLToPath(new URL('../drizzle',import.meta.url));await cp(migrations,folder,{recursive:true});const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8')) as {entries:{tag:string}[]};
  const index=journal.entries.findIndex(e=>e.tag==='0281_bound_cosmetic_visual_source');if(index<0)throw Error('Missing predecessor');await writeFile(path,JSON.stringify({...journal,entries:journal.entries.slice(0,index+1)}));
  await admin.unsafe(`create database ${name}`);await runMigrations(old.db,{migrationsFolder:folder});await bootstrapSystemAccounts(old.db);
  const at=new Date(Date.now()-86400000);clock(at);const f=await createStarterExpeditionFixture(old.db,{now:at}),trip=await f.dispatch(),workflow=createStarterExpeditionWorkflow(old.db),before=await workflow.read(f.wallet,trip.id);
  // 2026-10-10 (CI 37503885235): the real upgrade applies the WHOLE current journal; 287 was its length when written.
  await runMigrations(old.db);expect((await old.sql`select count(*)::integer count from drizzle.__drizzle_migrations`)[0]!.count).toBe(journal.entries.length);
  const original=await workflow.read(f.wallet,trip.id);expect(original).toEqual(before);
  const service=createBoundCosmeticWakeViews(old.db),sidecar=known(await service.original(f.wallet,'starter',trip.id)),current=await service.current(f.wallet,f.baseId);
  expect(sidecar.presentation.wake).toEqual({state:'legacy',visual:null});expect(current.trips[0]!.wake).toEqual({state:'legacy',visual:null});expect(await old.sql`select * from bound_cosmetic_starter_wakes where expedition_id=${trip.id}`).toHaveLength(0);
  capture.legacy.starter={original,sidecar,current};
 }finally{await old.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120000);

it('refuses a missing capture or source validator with a typed original hold',async()=>{
 flags();const at=new Date(Date.now()-86400000);clock(at);const starter=await createStarterExpeditionFixture(conn.db,{now:at}),first=await starter.dispatch();
 vi.useRealTimers();const fleet=await advanced(),second=await fleet.dispatch(fleet.initial),ids={starter:first.id,advanced:second.trip.id};
 for(const kind of ['starter','advanced'] as const)for(const mutation of [`alter table public.bound_cosmetic_${kind}_wakes rename to held_wake_capture`,'alter function public.shardkeep_bound_cosmetic_wake_sources_valid() rename to held_wake_source'])
  await expect(conn.db.transaction(async tx=>{await tx.execute(sql.raw(mutation));await boundCosmeticOriginalWakeFields(tx,kind,ids[kind]);}),mutation).rejects.toMatchObject({statusCode:503,code:'BOUND_COSMETIC_WAKE_ORIGINAL_UNAVAILABLE'});
});
it('serves sidecars through normal private startup and authenticated restricted LOGIN without changing old receipts',async()=>{
 const f=await earned(),at=new Date(+f.job.readyAt+1000);clock(at);const s=await createStarterExpeditionFixture(conn.db,{wallet:f.wallet,now:at}),trip=await s.dispatch();
 const fleet=await advanced(),advancedTrip=(await fleet.dispatch(fleet.initial)).trip;clock(at);
 const [database]=await conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;
 const suffix=randomUUID().replaceAll('-',''),role='wake_api_'+suffix,worker='wake_worker_'+suffix,password=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex');
 execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,
  PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),POSTGRES_USER:decodeURIComponent(url.username),POSTGRES_PASSWORD:decodeURIComponent(url.password)||'owned-loopback-trust-fixture',
  DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:workerPassword}});
 const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password=password;const request=createDb(runtimeUrl.toString(),{max:4});
 const workerUrl=new URL(url);workerUrl.username=worker;workerUrl.password=workerPassword;const workerRequest=createDb(workerUrl.toString(),{max:1});
 try{
  const [grants]=await request.sql`select has_table_privilege(current_user,'public.bound_cosmetic_starter_wakes','SELECT') table_read,
   has_table_privilege(current_user,'public.bound_cosmetic_advanced_wakes','SELECT') advanced_table_read,
   has_table_privilege(current_user,'public.bound_cosmetic_wake_preferences','SELECT') preferences_read,
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_starter_wake(uuid)','EXECUTE') starter_reader,
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_advanced_wake(uuid)','EXECUTE') advanced_reader,
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_wake_sources_valid()','EXECUTE') source_helper,
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_wake_preference(text,boolean,bigint,timestamptz)','EXECUTE') writer`;
  expect(grants).toEqual({table_read:false,advanced_table_read:false,preferences_read:false,starter_reader:true,advanced_reader:true,source_helper:false,writer:false});
  // Only the API LOGIN receives immutable redacted readers. Private capture
  // tables, source helpers and preference writes remain unavailable to it.
  expect(await boundCosmeticOriginalWakeFields(request.db,'starter',trip.id)).toEqual({boundCosmeticWake:f.selected.visual});
  expect(await boundCosmeticOriginalWakeFields(request.db,'advanced',advancedTrip.id)).toEqual({boundCosmeticWake:plain});
  await expect(request.sql`select * from bound_cosmetic_starter_wakes`).rejects.toMatchObject({code:'42501'});
  await expect(request.sql`select * from bound_cosmetic_advanced_wakes`).rejects.toMatchObject({code:'42501'});
  const [workerGrants]=await workerRequest.sql`select
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_starter_wake(uuid)','EXECUTE') starter_reader,
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_advanced_wake(uuid)','EXECUTE') advanced_reader,
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_wake_sources_valid()','EXECUTE') source_helper,
   has_function_privilege(current_user,'public.shardkeep_bound_cosmetic_wake_preference(text,boolean,bigint,timestamptz)','EXECUTE') writer,
   has_table_privilege(current_user,'public.bound_cosmetic_starter_wakes','SELECT') table_read`;
  expect(workerGrants).toEqual({starter_reader:false,advanced_reader:false,source_helper:false,writer:false,table_read:false});
  await expect(workerRequest.sql`select public.shardkeep_bound_cosmetic_starter_wake(${trip.id}::uuid)`).rejects.toMatchObject({code:'42501'});
  await expect(workerRequest.sql`select public.shardkeep_bound_cosmetic_advanced_wake(${advancedTrip.id}::uuid)`).rejects.toMatchObject({code:'42501'});
  const fallback=createUnfittedStarterExpeditionWorkflow(request.db),original=await fallback.read(f.wallet,trip.id);accepted(original);expect(original.receipt).not.toHaveProperty('boundCosmeticWake');
  const config={...TEST_CONFIG,DATABASE_URL:runtimeUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:url.toString()};
  const services=await createPhaseEServices(config,request.db),app=await buildApp(config,request.db,services!.deps),absent=await buildApp(config,request.db);
  try{
   const [session]=await conn.sql`insert into sessions(wallet,expires_at) values(${f.wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;
   const cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.wallet,session!.id)},path='/bound-cosmetics/wakes/v1/originals/starter/'+trip.id,currentPath='/bound-cosmetics/wakes/v1/current?baseId='+s.baseId;
   for(const endpoint of [path,currentPath]){
    expect((await absent.inject({url:endpoint})).statusCode).toBe(401);expect((await absent.inject({url:endpoint,cookies})).statusCode).toBe(503);
    const response=await app.inject({url:endpoint,cookies});expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
   }
   const response=await app.inject({url:path,cookies});expect(known(BoundCosmeticWakeOriginalEnvelopeSchema.parse(response.json())).presentation.wake).toEqual(f.selected.visual);
   for(const endpoint of [path+'?wallet='+f.wallet,currentPath+'&wallet='+f.wallet,path.replace('/starter/','/other/'),path.replace(trip.id,'bad')])expect((await app.inject({url:endpoint,cookies})).statusCode).toBe(400);
   expect((await app.inject({url:path.replace('/v1/','/v2/'),cookies})).statusCode).toBe(404);
   capture.provenance.actualAuthenticatedRuntime=true;
  }finally{await app.close();await absent.close();await services!.close();}

  vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');const replay=await fallback.start(f.wallet,original.status==='accepted'?original.receipt.request:neverRequest());
  expect(replay.created).toBe(false);expect(replay.envelope.receipt).toEqual(original.receipt);
  const current=await fallback.view(f.wallet,{baseId:s.baseId});expect(current.flight).not.toHaveProperty('boundCosmeticWake');
  await conn.sql`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`;
  try{expect((await fallback.read(f.wallet,trip.id)).receipt).toEqual(original.receipt);
   const foreign=Keypair.generate().publicKey.toBase58();expect(await fallback.read(foreign,trip.id)).toMatchObject({status:'unknown',receipt:null});
  }finally{await conn.sql`alter table bound_cosmetic_wake_preferences enable trigger bound_cosmetic_wake_preference_guard`;}
  const recovered=await fallback.read(f.wallet,trip.id);expect(recovered.receipt).toEqual(original.receipt);
  capture.provenance.restrictedUnfittedOriginal=true;
 }finally{await request.sql.end();await workerRequest.sql.end();for(const name of [role,worker]){await conn.sql.unsafe(`drop owned by ${name}`);await conn.sql.unsafe(`drop role ${name}`);}}
},120000);
