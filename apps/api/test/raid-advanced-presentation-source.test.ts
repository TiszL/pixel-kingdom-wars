/** Owned loopback fixture. Encoded chain/facility/time inputs are synthetic;
 * private install/service, dispatch, raid and archive operations are real. */
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import postgres from 'postgres';
import {Keypair} from '@solana/web3.js';
import {eq,sql} from 'drizzle-orm';
import {BuildingType,RAID_RULES,pvpAttackShardCostForKeepLevel} from '@shardkeep/shared';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {getOrCreateBaseAccount} from '../src/ledger';
import {baseArmy,bases,buildings,players,raids,raidReplayTimelines,sessions} from '../src/db/schema';
import {createRaid,createCampaignRaid,getPendingRaidResume,getReplay,getRaidEnergy,recoverDueStartedLiveRaids} from '../src/game/raids';
import {retreatLiveRaid,getLiveRaidCommands,acceptLiveRaidCommand,startLiveRaid,getRaidClock} from '../src/game/liveRaids';
import {getBaseBattleReplay} from '../src/game/baseBattleHistory';
import {transferStableBase,assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {rewardBaseShards} from '../src/game/baseEconomy';
import {decodeReplayTimeline} from '../src/game/raidReplayArchive';
import * as advanced from '../src/game/raidAdvancedPresentation';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {createVehicleServiceApplications} from '../src/game/vehicleServiceApplications';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {vehicleServiceConsentFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceExpeditions,vehicleServiceInstallation} from './fixtures/vehicleService';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {ADMIN_DATABASE_URL} from './db-url';
const conn=resourceClaimsDatabase(),db=conn.db,migrations=fileURLToPath(new URL('../drizzle',import.meta.url));
const apply=async(tx:postgres.TransactionSql,body:string)=>{for(const part of body.split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);};
const flags=()=>{for(const key of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED','STARTER_EXPEDITIONS_ENABLED','FREE_ONBOARDING'])vi.stubEnv(key,'true');};
const oldTables=['raid_starter_presentation_contract','bound_cosmetic_return_contract','bound_cosmetic_charter_contract','bound_cosmetic_wake_contract','charter_retirement_contract'];
const seals=async()=>{const result:Record<string,unknown>={};for(const table of oldTables)result[table]=await conn.sql.unsafe(`select * from public.${table}`);return result;};
let before:Record<string,unknown>,captureSql:string,sourceSql:string,legacyId:string;
beforeAll(async()=>{
 const folder=await mkdtemp(join(tmpdir(),'raid-advanced-journal-')),real=runMigrations;
 try{await cp(migrations,folder,{recursive:true});const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,JSON.stringify({...journal,entries:journal.entries.filter((e:{idx:number})=>e.idx<289)}));
  const mod=await import('../src/db/migrate'),spy=vi.spyOn(mod,'runMigrations').mockImplementationOnce(db=>real(db,{migrationsFolder:folder}));
  try{await conn.setup();}finally{spy.mockRestore();}
 }finally{await rm(folder,{recursive:true,force:true});}
 const legacyWallet=Keypair.generate().publicKey.toBase58(),legacyBase=randomUUID();
 await db.insert(players).values({wallet:legacyWallet});await conn.sql`insert into bases(id,owner_wallet) values(${legacyBase},${legacyWallet})`;await conn.sql`insert into base_slots(wallet,slot,base_id) values(${legacyWallet},1,${legacyBase})`;
 const [legacy]=await db.insert(raids).values({attackerWallet:legacyWallet,defenderWallet:legacyWallet,defenderBaseId:legacyBase,seed:1n,snapshot:{buildings:[]},armySnapshot:{},ordersDeadlineAt:new Date()}).returning();legacyId=legacy!.id;
 before=await seals();captureSql=await readFile(join(migrations,'0286_raid_advanced_presentations.sql'),'utf8');sourceSql=await readFile(join(migrations,'0287_raid_advanced_presentation_source.sql'),'utf8');
},180000);
beforeEach(async context=>{if(!context.task.name.startsWith('admits exactly'))await runMigrations(db);});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(()=>conn.close());
it('admits exactly two helper successors and preserves previous seals and validators',async()=>{
 for(const mutation of ["create or replace function public.shardkeep_raid_starter_sources_valid() returns boolean language sql stable set search_path=pg_catalog,public,pg_temp as $$select true$$",
 'alter table raids disable trigger raid_starter_capture'])await expect(conn.sql.begin(async tx=>{await apply(tx,captureSql);await tx.unsafe(mutation);await apply(tx,sourceSql);})).rejects.toThrow('RAID_ADVANCED_PREDECESSOR');
 for(const mutation of ['alter table raids disable trigger raid_advanced_capture','alter function public.shardkeep_raid_advanced_candidate(uuid,jsonb,timestamptz) security invoker',
 'grant select(facts) on raid_advanced_presentations to public'])await expect(conn.sql.begin(async tx=>{await apply(tx,captureSql);await tx.unsafe(mutation);await apply(tx,sourceSql);})).rejects.toThrow('RAID_ADVANCED_SEAL_SOURCE');
 await runMigrations(db);expect(await seals()).toEqual(before);
 expect((await conn.sql`select public.shardkeep_raid_advanced_sources_valid() advanced,public.shardkeep_raid_starter_sources_valid() starter,public.shardkeep_bound_cosmetic_visual_sources_valid() visual,public.shardkeep_bound_cosmetic_wake_sources_valid() wake`)[0]).toEqual({advanced:true,starter:true,visual:true,wake:true});
},180000);
type Fixture=Awaited<ReturnType<typeof vehicleBurnDatabase>>;
async function installation(){
 flags();const f=await vehicleBurnDatabase('survey_balloon',1,{}, {connection:conn,completedAt:new Date(Date.now()-8*86400000)});
 f.finalizeBurn();await createVehicleInstallations(db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 // Explicit synthetic historical clock placement, not a claimed original timestamp.
 // Restore every trigger immediately; all lifecycle identity/proof bytes stay intact.
 await conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;
  await tx`update vehicle_activation_reservations set reserved_at=reserved_at-interval '7 days' where id=${f.reservation.id}`;
  await tx`update vehicle_burn_consumptions set recorded_at=recorded_at-interval '7 days' where reservation_id=${f.reservation.id}`;
  await tx`update advanced_vehicle_installations set installed_at=installed_at-interval '7 days' where reservation_id=${f.reservation.id}`;
 });return f;
}
async function battle(){
 const defender=await installation(),attacker=Keypair.generate().publicKey.toBase58(),attackerBase=randomUUID();
 await db.insert(players).values({wallet:attacker});await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${attackerBase},${attacker},5)`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${attacker},1,${attackerBase})`;
 await db.update(bases).set({keepLevel:5}).where(eq(bases.id,defender.baseId));
 for(const [baseId,wallet] of [[defender.baseId,defender.actor],[attackerBase,attacker]] as const)await db.insert(buildings).values({baseId,playerWallet:wallet,type:BuildingType.Keep,level:5,tx:10,ty:10});
 await db.insert(baseArmy).values({baseId:attackerBase,troop:'highlander',count:2});
 await rewardBaseShards(db,attackerBase,BigInt(pvpAttackShardCostForKeepLevel(5))*4n,'test.raid.advanced.ante',randomUUID());
 const authorize=async(wallet:string,baseId:string,tx?:Parameters<typeof assertFreshLockedBaseAuthority>[0])=>{if(tx)await assertFreshLockedBaseAuthority(tx,wallet,baseId);};
 const options={attackerBaseId:attackerBase,defenderBaseId:defender.baseId,defenderWallet:defender.actor,authorizeAttackerBase:authorize,authorizeDefenderBase:authorize,idempotencyKey:randomUUID(),raidProtocolVersion:2 as const,allowRaidProtocolV2:true};
 return {defender,attacker,attackerBase,options,create:()=>createRaid(db,attacker,options,()=>new Date())};
}
const shape=(f:Fixture,presence:'occupied'|'away'|'exhausted',tier=1)=>({version:1,berths:[{buildingId:f.berthId,installation:{family:'survey_balloon',tier,presence}}]});
const snapshot=(f:Fixture)=>({buildings:[{id:f.berthId,type:'berth',level:1}]});
it('freezes real installed away source through return retry live resume and original archive',async()=>{
 const f=await battle(),trips=await vehicleServiceExpeditions(f.defender),trip=await trips.depart(),now=new Date(),raid=await f.create();
 expect(raid.advancedServicePresentation).toEqual(shape(f.defender,'away'));
 expect((await getPendingRaidResume(db,f.attacker,raid.id,now))!.advancedServicePresentation).toEqual(raid.advancedServicePresentation);
 expect((await getLiveRaidCommands(db,f.attacker,raid.id,-1,now)).advancedServicePresentation).toEqual(raid.advancedServicePresentation);
 await trips.complete(trip);expect((await f.create()).advancedServicePresentation).toEqual(raid.advancedServicePresentation);
 await retreatLiveRaid(db,f.attacker,raid.id,randomUUID(),trip.returnsAt);
 const [archive]=await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId,raid.id));
 expect(decodeReplayTimeline(archive!).advancedServicePresentation).toEqual(raid.advancedServicePresentation);
 expect((await getReplay(db,f.attacker,raid.id)).advancedServicePresentation).toEqual(raid.advancedServicePresentation);
});
it('settles a genuine due advanced return before capture and closes multiple applied families',async()=>{
 const f=await battle(),other=await vehicleServiceInstallation(f.defender,'cargo_cutter');
 // This extra installation is created at database wall time; capture this case
 // at wall time after a historical original trip, not at its old deadline.
 const trips=await vehicleServiceExpeditions(f.defender);await trips.depart();vi.useRealTimers();
 const raid=await f.create(),berths=raid.advancedServicePresentation!.berths;
 expect(berths).toHaveLength(2);expect(berths).toContainEqual(shape(f.defender,'occupied').berths[0]);
 expect(berths).toContainEqual({buildingId:other.reservation.berthId,installation:{family:'cargo_cutter',tier:1,presence:'occupied'}});
 expect(await conn.sql`select * from advanced_expedition_returns where expedition_id in(select id from advanced_expeditions where base_id=${f.defender.baseId})`).toHaveLength(1);
});
it('keeps frozen applied tier after real upgrade and captures the newer application only for a new boundary',async()=>{
 const f=await battle(),raid=await f.create();await retreatLiveRaid(db,f.attacker,raid.id,randomUUID(),new Date());
 const consent=await vehicleServiceConsentFixture(f.defender),prepared=await consent.preparations.prepare(f.defender.actor,consent.intent.id);
 consent.finalizeService(prepared);await createVehicleServiceApplications(db,{verifyBurn:consent.reader.verify}).recover(f.defender.actor,consent.intent.id);
 expect((await f.create()).advancedServicePresentation).toEqual(shape(f.defender,'occupied'));
 const current=await db.transaction(tx=>advanced.readRaidAdvancedCandidate(tx,f.defender.baseId,snapshot(f.defender),new Date()));
 expect(current.presentation).toEqual(shape(f.defender,'occupied',2));
 expect(raid.advancedServicePresentation).toEqual(shape(f.defender,'occupied'));
});
it('refuses missing flight, future service and broken build originals without converting corruption to absence',async()=>{
 const f=await battle(),trips=await vehicleServiceExpeditions(f.defender);await trips.depart();
 const rollback=Error('rollback corrupted fixture');
 for(const mutation of [sql`delete from advanced_expedition_inflight where installation_id=${f.defender.reservation.id}`,
  sql`update builder_jobs set completed_at=completed_at+interval '1 millisecond' where id=${f.defender.jobId}`])await expect(db.transaction(async tx=>{
  await tx.execute(sql`set local session_replication_role=replica`);await tx.execute(mutation);await tx.execute(sql`set local session_replication_role=origin`);
  await expect(advanced.readRaidAdvancedCandidate(tx,f.defender.baseId,snapshot(f.defender),new Date())).rejects.toMatchObject({cause:{message:expect.stringMatching(/^RAID_ADVANCED_(FLIGHT|INSTALLATION)_SOURCE$/)}});throw rollback;
 })).rejects.toBe(rollback);
});
it('rolls back both captures ante and energy on a post-insert source-digest disagreement',async()=>{
 const f=await battle(),balance=(await getOrCreateBaseAccount(db,f.attackerBase,'base_shards')).balance,now=new Date(),energy=await getRaidEnergy(db,f.attacker,now,f.attackerBase);
 const original=advanced.readRaidAdvancedCandidate;vi.spyOn(advanced,'readRaidAdvancedCandidate').mockImplementation(async(...args)=>({...await original(...args),sourceSha256:'0'.repeat(64)}));
 await expect(f.create()).rejects.toMatchObject({code:'RAID_ADVANCED_CAPTURE_MISMATCH'});
 expect((await getOrCreateBaseAccount(db,f.attackerBase,'base_shards')).balance).toBe(balance);expect(await getRaidEnergy(db,f.attacker,now,f.attackerBase)).toEqual(energy);
 expect(await db.select().from(raids).where(eq(raids.idempotencyKey,f.options.idempotencyKey))).toHaveLength(0);
 for(const table of ['raid_starter_presentations','raid_advanced_presentations'])expect(await conn.sql.unsafe(`select * from ${table} where defender_base_id=$1`,[f.defender.baseId])).toHaveLength(0);
});
it('captures explicit unavailable separately from legacy and detects direct writes and source drift',async()=>{
 const f=await battle(),raid=await f.create();expect(await advanced.readRaidAdvancedCapture(db,randomUUID(),raid.snapshot)).toBeUndefined();
 const [unknown]=await db.insert(raids).values({attackerWallet:f.attacker,defenderWallet:f.defender.actor,defenderBaseId:f.defender.baseId,seed:1n,snapshot:{buildings:[]},armySnapshot:{},createdAt:new Date(),ordersDeadlineAt:new Date()}).returning();
 expect((await advanced.raidAdvancedFields(db,unknown!.id,unknown!.snapshot)).advancedServicePresentation).toBeNull();
 for(const statement of [`insert into raid_advanced_presentations select * from raid_advanced_presentations where raid_id='${raid.id}'`,`update raid_advanced_presentations set facts='null' where raid_id='${raid.id}'`,`delete from raid_advanced_presentations where raid_id='${raid.id}'`,'truncate raid_advanced_presentations'])await expect(conn.sql.unsafe(statement)).rejects.toThrow('RAID_ADVANCED_IMMUTABLE');
 for(const mutation of ['alter table raids disable trigger raid_advanced_capture','grant select(facts) on raid_advanced_presentations to public',"create or replace function public.shardkeep_raid_starter_retirement_predecessor() returns text language sql stable set search_path=pg_catalog,public,pg_temp as $$select 'invalid'$$"])
 await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await tx`select public.shardkeep_raid_advanced_presentation(${raid.id})`;})).rejects.toThrow('RAID_ADVANCED_SOURCE');
});
it('serializes service on the installation lock and refuses a service committed after the sampled cutoff',async()=>{
 const f=await installation(),consent=await vehicleServiceConsentFixture(f),prepared=await consent.preparations.prepare(f.actor,consent.intent.id);
 consent.finalizeService(prepared);const applications=createVehicleServiceApplications(db,{verifyBurn:consent.reader.verify});
 const cutoffRow=await conn.sql`select clock_timestamp()::text cutoff`;const cutoff=String(cutoffRow[0]!.cutoff);
 let entered!:()=>void,release!:()=>void;const locked=new Promise<void>(r=>{entered=r;}),released=new Promise<void>(r=>{release=r;});
 const holder=db.transaction(async tx=>{await advanced.readRaidAdvancedCandidate(tx,f.baseId,snapshot(f),new Date());entered();await released;});
 await locked;
 const service=applications.recover(f.actor,consent.intent.id);
 try{
  let blocked=false;
  for(let attempt=0;attempt<60&&!blocked;attempt++){
   const [observed]=await conn.sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select reservation_id from public.advanced_vehicle_installations%') blocked`;blocked=observed!.blocked;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,50));
  }
  expect(blocked).toBe(true);expect(await conn.sql`select * from vehicle_service_applications where intent_id=${consent.intent.id}`).toHaveLength(0);
 }finally{release();await holder;}
 await service;
 await expect(db.transaction(tx=>advanced.readRaidAdvancedCandidate(tx,f.baseId,snapshot(f),new Date(cutoff)))).rejects.toMatchObject({cause:{message:'RAID_ADVANCED_CUTOFF'}});
 expect((await db.transaction(tx=>advanced.readRaidAdvancedCandidate(tx,f.baseId,snapshot(f),new Date()))).presentation).toEqual(shape(f,'occupied',2));
});
it('keeps private originals inaccessible under actual provisioned runtime login and removes stale column grants',async()=>{
 const f=await battle(),raid=await f.create(),role='raapi_'+randomBytes(8).toString('hex'),worker='raworker_'+randomBytes(8).toString('hex');
 const password=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex'),adminUrl=new URL(ADMIN_DATABASE_URL);const name=String((await conn.sql`select current_database() name`)[0]!.name);
 const provision=()=>execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{
  PATH:'/opt/homebrew/opt/postgresql@16/bin:'+process.env.PATH,PGHOST:adminUrl.hostname,PGPORT:adminUrl.port,PGDATABASE:name,
  PGUSER:decodeURIComponent(adminUrl.username),PGPASSWORD:decodeURIComponent(adminUrl.password),POSTGRES_USER:decodeURIComponent(adminUrl.username),POSTGRES_PASSWORD:decodeURIComponent(adminUrl.password)||'owned-loopback-trust-fixture',
  DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:workerPassword}});
 let request:ReturnType<typeof createDb>|undefined;
 try{
  provision();await conn.sql`grant select(facts) on raid_advanced_presentations to shardkeep_api_runtime`;
  await conn.sql`grant select(record) on raid_advanced_presentation_contract to shardkeep_worker_runtime`;provision();
  const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;url.username=role;url.password=password;request=createDb(url.toString(),{max:2});
  expect((await request.sql`select has_any_column_privilege(current_user,'raid_advanced_presentations','SELECT,INSERT,UPDATE') facts,
   has_any_column_privilege(current_user,'raid_advanced_presentation_contract','SELECT,INSERT,UPDATE') seal,
   has_table_privilege(current_user,'advanced_vehicle_installations','SELECT,INSERT,UPDATE') originals,
   has_function_privilege(current_user,'shardkeep_vehicle_lifecycle(uuid)','EXECUTE') lifecycle,
   has_function_privilege(current_user,'shardkeep_raid_advanced_candidate(uuid,jsonb,timestamptz)','EXECUTE') candidate,
   has_function_privilege(current_user,'shardkeep_raid_advanced_presentation(uuid)','EXECUTE') reader`)[0]).toEqual({facts:false,seal:false,originals:false,lifecycle:false,candidate:true,reader:true});
  expect((await advanced.raidAdvancedFields(request.db,raid.id,raid.snapshot)).advancedServicePresentation).toEqual(shape(f.defender,'occupied'));
  expect((await request.db.transaction(tx=>advanced.readRaidAdvancedCandidate(tx,f.defender.baseId,snapshot(f.defender),new Date()))).presentation).toEqual(shape(f.defender,'occupied'));
  await expect(request.sql`select * from raid_advanced_presentations`).rejects.toMatchObject({code:'42501'});
 }finally{await request?.sql.end();for(const login of [role,worker]){await conn.sql.unsafe(`drop owned by ${login}`);await conn.sql.unsafe(`drop role ${login}`);}}
},60000);
it('exports normal HTTP originals through return and custody transfer with actual archived protocol-two pages',async()=>{
 const f=await battle(),trips=await vehicleServiceExpeditions(f.defender),trip=await trips.depart(),now=new Date(),raid=await f.create();
 const config={...TEST_CONFIG,FREE_ONBOARDING:'true',MULTI_BASE_ENABLED:'true',NATIVE_PRESENTATION_ENABLED:'true',NATIVE_PRESENTATION_OPEN:'true'} as typeof TEST_CONFIG;
 const app=await buildApp(config,db);await app.ready();
 try{
  const [session]=await db.insert(sessions).values({wallet:f.attacker,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.attacker,session!.id)},path=`/raids/${raid.id}/presentation`;
  expect((await app.inject({url:path})).statusCode).toBe(401);
  const read=async(url:string)=>{const response=await app.inject({url,cookies});expect(response.statusCode,response.body).toBe(200);return response.body;};
  const live=await read(path),livePage=await read(path+'?protocolVersion=2');
  await acceptLiveRaidCommand(db,f.attacker,raid.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:-1,ty:14}},now);
  {const clock=await getRaidClock(db,raid.id,now);if(!clock.live.startedAt)await startLiveRaid(db,f.attacker,raid.id,randomUUID(),clock.clock.revision,now);}
  await retreatLiveRaid(db,f.attacker,raid.id,randomUUID(),new Date(+now+1000));
  expect(await recoverDueStartedLiveRaids(db,new Date(+now+RAID_RULES.battleDurationSec*1000+1),undefined,raid.id)).toEqual({resolved:1,raced:0});
  await trips.complete(trip);
  const buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();await db.insert(players).values({wallet:buyer});
  await db.update(bases).set({deedAssetId:deed,deedMintAssetId:deed,landPaidAt:now}).where(eq(bases.id,f.defender.baseId));
  await transferStableBase(db,f.defender.baseId,f.defender.actor,buyer,deed,{owner:buyer,collection,frozen:false,delegate:null,slot:100,observedAtMs:Date.now()},()=>new Date());
  expect((await getBaseBattleReplay(db,buyer,f.defender.baseId,raid.id)).advancedServicePresentation).toEqual(shape(f.defender,'away'));
  const archive=await read(path),archivePage=await read(path+'?protocolVersion=2');expect(JSON.parse(archive).source).toBe('archive');
  for(const body of [live,archive])expect(JSON.parse(body).advancedServicePresentation).toEqual(shape(f.defender,'away'));
  for(const body of [livePage,archivePage])expect(JSON.parse(body).state.advancedServicePresentation).toEqual(shape(f.defender,'away'));
  const original=raid.snapshot;await db.update(raids).set({snapshot:{...(original as object),buildings:[]}}).where(eq(raids.id,raid.id));
  try{await expect(getReplay(db,f.attacker,raid.id)).rejects.toMatchObject({statusCode:409});}finally{await db.update(raids).set({snapshot:original}).where(eq(raids.id,raid.id));}
  await writeFile('/tmp/raid-advanced-primary-http-pair.json',JSON.stringify({provenance:{kind:'normal-buildApp-authenticated-inject-response-bodies',
   authority:'Synthetic encoded Core/finality/facilities/time fixtures; actual installation, dispatch, raid, return, started-retreat archive and custody transfer services.',
   clock:'Initial original timestamps placed seven days earlier only in this owned fixture, with replica mode restored before lifecycle operations.',
   limits:'No listening socket/native HTTP/Android/rendering/application readiness/release proof.',wallet:f.attacker,raidId:raid.id,berthId:f.defender.berthId},live,livePage,archive,archivePage},null,2)+'\n');
 }finally{await app.close();}
},60000);
it('omits old wallet, PvE and campaign captures and rejects replica-mode or an extra raid trigger',async()=>{
 const f=await battle();
 expect(await advanced.readRaidAdvancedCapture(db,legacyId,{buildings:[]})).toBeUndefined();
 expect(await conn.sql`select * from raid_advanced_presentations where raid_id=${legacyId}`).toHaveLength(0);
 for(const extra of [{defenderBaseId:null},{defenderBaseId:f.defender.baseId,campaignStage:1}]){
  const [row]=await db.insert(raids).values({attackerWallet:f.attacker,defenderWallet:f.defender.actor,seed:1n,snapshot:snapshot(f.defender),armySnapshot:{},ordersDeadlineAt:new Date(),...extra}).returning();
  expect(await advanced.readRaidAdvancedCapture(db,row!.id,row!.snapshot)).toBeUndefined();
 }
 // PvE origin exclusion is independent of an absent wallet/base, as real camp raids use.
 const [valley]=await conn.sql`insert into valleys(name,site_id) select 'advanced frozen fixture',coalesce(max(site_id),-1)+1 from valleys returning id`;
 const [camp]=await conn.sql`insert into pve_camps(valley_id,x,y,tier,snapshot,loot_keep) values(${valley!.id},1,1,1,'{}',0) returning id`;
 const [pve]=await db.insert(raids).values({attackerWallet:f.attacker,defenderWallet:f.defender.actor,defenderBaseId:f.defender.baseId,pveCampId:camp!.id,seed:1n,snapshot:snapshot(f.defender),armySnapshot:{},ordersDeadlineAt:new Date()}).returning();
 expect(await advanced.readRaidAdvancedCapture(db,pve!.id,pve!.snapshot)).toBeUndefined();
 const raid=await f.create();
 for(const mutation of ["set local session_replication_role=replica",'create trigger advanced_extra after insert on raids for each row execute function public.shardkeep_raid_advanced_capture()'])
 await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await tx`select public.shardkeep_raid_advanced_presentation(${raid.id})`;})).rejects.toThrow('RAID_ADVANCED_SOURCE');
});
it('rejects a committed service half-pair instead of returning the old applied appearance',async()=>{
 const f=await installation(),consent=await vehicleServiceConsentFixture(f),prepared=await consent.preparations.prepare(f.actor,consent.intent.id);
 consent.finalizeService(prepared);await createVehicleServiceApplications(db,{verifyBurn:consent.reader.verify}).recover(f.actor,consent.intent.id);
 const rollback=Error('rollback impossible service half-pair');
 await expect(db.transaction(async tx=>{
  await tx.execute(sql`set local session_replication_role=replica`);await tx.execute(sql`delete from vehicle_service_applications where intent_id=${consent.intent.id}`);await tx.execute(sql`set local session_replication_role=origin`);
  await expect(advanced.readRaidAdvancedCandidate(tx,f.baseId,snapshot(f),new Date())).rejects.toMatchObject({cause:{message:'RAID_ADVANCED_SERVICE_SOURCE'}});throw rollback;
 })).rejects.toBe(rollback);
});

it('creates a genuine campaign raid without consulting advanced capture or inventing a sibling',async()=>{
 const f=await battle(),candidate=vi.spyOn(advanced,'readRaidAdvancedCandidate');
 const raid=await createCampaignRaid(db,f.attacker,1,randomUUID(),new Date(),{attackerBaseId:f.attackerBase,authorizeAttackerBase:async(wallet,id,tx)=>{if(tx)await assertFreshLockedBaseAuthority(tx,wallet,id);},raidProtocolVersion:2,allowRaidProtocolV2:true});
 expect(raid.campaignStage).toBe(1);expect(candidate).not.toHaveBeenCalled();expect(raid).not.toHaveProperty('advancedServicePresentation');
 expect(await advanced.readRaidAdvancedCapture(db,raid.id,raid.snapshot)).toBeUndefined();
 expect(await conn.sql`select * from raid_advanced_presentations where raid_id=${raid.id}`).toHaveLength(0);
});
