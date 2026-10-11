/** Disposable PG16 owner fixture. Facility rows and finalized term authority
 * are synthetic; install/dispatch/raid/return/archive services are genuine. */
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Keypair} from '@solana/web3.js';
import postgres from 'postgres';
import {eq,sql} from 'drizzle-orm';
import {BuildingType,RAID_RULES,pvpAttackShardCostForKeepLevel} from '@shardkeep/shared';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bootstrapSystemAccounts,getOrCreateBaseAccount} from '../src/ledger';
import {baseArmy,bases,buildings,players,raids,raidReplayTimelines,sessions,starterExpeditionReturns} from '../src/db/schema';
import {createRaid,getPendingRaidResume,getReplay,getRaidEnergy,recoverDueStartedLiveRaids} from '../src/game/raids';
import {retreatLiveRaid,getLiveRaidCommands,acceptLiveRaidCommand,startLiveRaid,getRaidClock} from '../src/game/liveRaids';
import {getBaseBattleReplay} from '../src/game/baseBattleHistory';
import {transferStableBase} from '../src/game/baseOwnership';
import * as starterPresentation from '../src/game/starterServicePresentation';
import {readStarterFleetView} from '../src/game/starterFleetView';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {getBaseState} from '../src/game/base';
import {rewardBaseShards} from '../src/game/baseEconomy';
import {decodeReplayTimeline} from '../src/game/raidReplayArchive';
import {readRaidStarterPresentation} from '../src/game/raidStarterPresentation';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {ADMIN_DATABASE_URL} from './db-url';

const migrations=fileURLToPath(new URL('../drizzle',import.meta.url));
const url=new URL(ADMIN_DATABASE_URL);
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Owned loopback raid fixture required');
const name=`raid_starter_${randomUUID().replaceAll('-','')}_test`;url.pathname='/'+name;
const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),conn=createDb(url.toString(),{max:6}),db=conn.db;
const apply=async(tx:postgres.TransactionSql,body:string)=>{for(const part of body.split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);};
const flags=()=>{for(const key of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','STARTER_EXPEDITIONS_ENABLED','FREE_ONBOARDING'])vi.stubEnv(key,'true');};
const oldTables=['charter_retirement_contract','charter_retirement_projection_contract','charter_retirement_draft_contract','charter_migration_contract',
 'bound_cosmetic_return_contract','divine_fragment_bound_cosmetics_contract','bound_cosmetic_charter_contract','bound_cosmetic_wake_contract'];
const seals=async()=>{const result:Record<string,unknown>={};for(const table of oldTables)result[table]=await conn.sql.unsafe(`select * from public.${table}`);return result;};
let before:Record<string,unknown>,captureSql:string,sourceSql:string,legacy:{id:string;snapshot:unknown};
beforeAll(async()=>{
 await admin.unsafe(`create database ${name}`);const folder=await mkdtemp(join(tmpdir(),'raid-starter-journal-'));
 try{await cp(migrations,folder,{recursive:true});const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8'));
  await writeFile(path,JSON.stringify({...journal,entries:journal.entries.filter((e:{idx:number})=>e.idx<287)}));await runMigrations(db,{migrationsFolder:folder});
 }finally{await rm(folder,{recursive:true,force:true});}
 await bootstrapSystemAccounts(db);before=await seals();flags();
 const f=await createStarterExpeditionFixture(db,{now:new Date()});
 const [old]=await db.insert(raids).values({attackerWallet:f.wallet,defenderWallet:f.wallet,defenderBaseId:f.baseId,seed:1n,
  snapshot:{buildings:[{id:f.berthId,type:'berth',level:1}]},armySnapshot:{},ordersDeadlineAt:new Date()}).returning();legacy=old!;
 captureSql=await readFile(join(migrations,'0284_raid_starter_presentations.sql'),'utf8');sourceSql=await readFile(join(migrations,'0285_raid_starter_presentation_source.sql'),'utf8');
},180000);
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await conn.sql.end();await admin.unsafe(`drop database if exists ${name} with(force)`);await admin.end();});

it('admits only the new hook and exact source, preserving all eight prior immutable seals',async()=>{
 for(const mutation of ['alter table raids disable trigger bound_cosmetic_raid_capture',
  'alter table starter_expeditions disable trigger bound_cosmetic_starter_wake_capture',
  'alter table raids alter column snapshot drop not null',
  ...['shardkeep_bound_cosmetic_visual_sources_valid','shardkeep_bound_cosmetic_wake_predecessor_valid','shardkeep_bound_cosmetic_wake_sources_valid'].map(fn=>
   `create or replace function public.${fn}() returns boolean language sql stable set search_path=pg_catalog,public,pg_temp as $$select true$$`)]){
  await expect(conn.sql.begin(async tx=>{await apply(tx,captureSql);await tx.unsafe(mutation);await apply(tx,sourceSql);})).rejects.toThrow('RAID_STARTER_PREDECESSOR');
 }
 for(const mutation of ['alter table raids disable trigger raid_starter_capture',
  'alter function public.shardkeep_raid_starter_capture() security invoker',
  'grant select(presentation) on public.raid_starter_presentations to public',
  'alter table raid_starter_presentations alter column presentation drop not null']){
  await expect(conn.sql.begin(async tx=>{await apply(tx,captureSql);await tx.unsafe(mutation);await apply(tx,sourceSql);})).rejects.toThrow('RAID_STARTER_SEAL_SOURCE');
 }
 await runMigrations(db);expect(await seals()).toEqual(before);
 expect(await readRaidStarterPresentation(db,legacy.id,legacy.snapshot)).toBeUndefined();
 expect(await conn.sql`select * from raid_starter_presentations where raid_id=${legacy.id}`).toHaveLength(0);
 expect((await conn.sql`select public.shardkeep_raid_starter_sources_valid() starter,public.shardkeep_bound_cosmetic_visual_sources_valid() visual,
  public.shardkeep_bound_cosmetic_wake_sources_valid() wake`)[0]).toEqual({starter:true,visual:true,wake:true});
 await conn.sql`select public.shardkeep_charter_retirement_source(),public.shardkeep_divine_fragment_source()`;
},180000);

type Fixture=Awaited<ReturnType<typeof createStarterExpeditionFixture>>;
async function battle(){
 flags();const now=new Date(Date.now()-3*86400000);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 const defender=await createStarterExpeditionFixture(db,{now}),attacker=await createStarterExpeditionFixture(db,{now});
 for(const f of [attacker,defender]){
  await db.update(bases).set({keepLevel:5}).where(eq(bases.id,f.baseId));
  await db.insert(buildings).values({baseId:f.baseId,playerWallet:f.wallet,type:BuildingType.Keep,level:5,tx:10,ty:10});
 }
 await db.insert(baseArmy).values({baseId:attacker.baseId,troop:'highlander',count:2});
 await rewardBaseShards(db,attacker.baseId,BigInt(pvpAttackShardCostForKeepLevel(5))*4n,'test.raid.starter.ante',randomUUID());
 const authorize=async(wallet:string,baseId:string,tx?:Parameters<Fixture['authority']['assertAuthority']>[0])=>{
  const f=wallet===attacker.wallet?attacker:defender;expect(baseId).toBe(f.baseId);if(tx)await f.authority.assertAuthority(tx,wallet,baseId);
 };
 const options={attackerBaseId:attacker.baseId,defenderBaseId:defender.baseId,defenderWallet:defender.wallet,
  authorizeAttackerBase:authorize,authorizeDefenderBase:authorize,idempotencyKey:randomUUID(),raidProtocolVersion:2 as const,allowRaidProtocolV2:true};
 return {attacker,defender,now,options,create:()=>createRaid(db,attacker.wallet,options,()=>new Date())};
}
const shape=(f:Fixture,presence:'occupied'|'away')=>({version:1,berths:[{buildingId:f.berthId,installation:{family:'starter',presence}}]});

it('freezes one real dispatched original through return, retry, resume, live state and immutable retreat archive',async()=>{
 const f=await battle(),trip=await f.defender.dispatch(),raid=await f.create();expect(raid.servicePresentation).toEqual(shape(f.defender,'away'));
 expect((await f.create()).servicePresentation).toEqual(raid.servicePresentation);
 expect((await getPendingRaidResume(db,f.attacker.wallet,raid.id,f.now))!.servicePresentation).toEqual(raid.servicePresentation);
 expect((await getLiveRaidCommands(db,f.attacker.wallet,raid.id,-1,f.now)).servicePresentation).toEqual(raid.servicePresentation);
 vi.setSystemTime(trip.returnsAt);
 const returned=await getBaseState(db,f.defender.wallet,trip.returnsAt,f.defender.baseId,f.defender.authority.assertAuthority,()=>trip.returnsAt);
 expect(returned.servicePresentation).toEqual(shape(f.defender,'occupied'));
 expect(await db.select().from(starterExpeditionReturns).where(eq(starterExpeditionReturns.expeditionId,trip.id))).toHaveLength(1);
 expect((await f.create()).servicePresentation).toEqual(raid.servicePresentation);
 await retreatLiveRaid(db,f.attacker.wallet,raid.id,randomUUID(),trip.returnsAt);
 const [stored]=await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId,raid.id));
 expect(decodeReplayTimeline(stored!).servicePresentation).toEqual(raid.servicePresentation);
 expect((await getReplay(db,f.attacker.wallet,raid.id)).servicePresentation).toEqual(raid.servicePresentation);
});

it('captures occupied only after actual due-return settlement at the admission boundary',async()=>{
 const f=await battle(),trip=await f.defender.dispatch();vi.setSystemTime(trip.returnsAt);
 const raid=await f.create();expect(raid.servicePresentation).toEqual(shape(f.defender,'occupied'));
 expect(await db.select().from(starterExpeditionReturns).where(eq(starterExpeditionReturns.expeditionId,trip.id))).toHaveLength(1);
 expect((await f.create()).servicePresentation).toEqual(raid.servicePresentation);
});

it('keeps a missing active pointer unknown while a broken completed-build proof aborts admission',async()=>{
 const f=await battle();await f.defender.dispatch();
 await expect(conn.sql`delete from starter_expedition_inflight where installation_id=${f.defender.installationId}`).rejects.toThrow('starter expedition must be in flight XOR returned');
 const rollback=new Error('rollback impossible missing-pointer fixture');
 await expect(db.transaction(async tx=>{
  await tx.execute(sql`set local session_replication_role=replica`);
  await tx.execute(sql`delete from starter_expedition_inflight where installation_id=${f.defender.installationId}`);
  await tx.execute(sql`set local session_replication_role=origin`);
  const snapshot={buildings:[{id:f.defender.berthId,type:'berth',level:1,underConstruction:false}]};
  expect(await starterPresentation.readStarterServicePresentation(tx,f.defender.baseId,snapshot.buildings,await readStarterFleetView(tx,f.defender.baseId),f.now)).toBeNull();
  const [result]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_raid_starter_projection(${f.defender.baseId}::uuid,${JSON.stringify(snapshot)}::jsonb,${f.now.toISOString()}::timestamptz) value`);
  expect(result!.value).toBeNull();throw rollback;
 })).rejects.toBe(rollback);
 const broken=await battle();
 await conn.sql`update builder_jobs set completed_at=completed_at+interval '1 millisecond' where id=(select completed_build_job_id from fleet_installations where id=${broken.defender.installationId})`;
 await expect(broken.create()).rejects.toThrow('Invalid current starter berth proof');
 expect(await db.select().from(raids).where(eq(raids.idempotencyKey,broken.options.idempotencyKey))).toHaveLength(0);
 expect(await conn.sql`select * from raid_starter_presentations where defender_base_id=${broken.defender.baseId}`).toHaveLength(0);
});

it('refuses direct historical writes and retains captured-null separately from absence',async()=>{
 const f=await battle(),raid=await f.create();
 for(const statement of [
  `insert into raid_starter_presentations select * from raid_starter_presentations where raid_id='${raid.id}'`,
  `update raid_starter_presentations set presentation='null' where raid_id='${raid.id}'`,
  `delete from raid_starter_presentations where raid_id='${raid.id}'`,
  'truncate raid_starter_presentations',
 ])await expect(conn.sql.unsafe(statement)).rejects.toThrow('RAID_STARTER_IMMUTABLE');
 expect(await readRaidStarterPresentation(db,randomUUID(),raid.snapshot)).toBeUndefined();
 // Deliberate malformed snapshot on a newly inserted owner fixture: the hook
 // derives null itself; it never receives a proposed public presentation.
 const [unavailable]=await db.insert(raids).values({attackerWallet:f.attacker.wallet,defenderWallet:f.defender.wallet,
  attackerBaseId:f.attacker.baseId,defenderBaseId:f.defender.baseId,seed:1n,snapshot:{buildings:[]},armySnapshot:{},
  createdAt:f.now,ordersDeadlineAt:f.now}).returning();
 expect(await readRaidStarterPresentation(db,unavailable!.id,unavailable!.snapshot)).toBeNull();
});

it('detects hook/body/table/ACL drift and refuses original reads without replacing saved facts',async()=>{
 const f=await battle(),raid=await f.create();const saved=await conn.sql`select * from raid_starter_presentations where raid_id=${raid.id}`;
 for(const mutation of ['alter table raids disable trigger raid_starter_capture',
  'alter table raid_starter_presentations disable trigger raid_starter_guard',
  'grant select(presentation) on raid_starter_presentations to public',
  'alter function public.shardkeep_raid_starter_presentation(uuid) security invoker',
  'alter table raid_starter_presentations enable row level security',
  "create or replace function public.shardkeep_bound_cosmetic_wake_predecessor_valid() returns boolean language sql stable set search_path=pg_catalog,public,pg_temp as $$select true$$",
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);
  expect((await tx`select public.shardkeep_raid_starter_sources_valid() valid`)[0]!.valid).toBe(false);
  await tx`select public.shardkeep_raid_starter_presentation(${raid.id})`;
 })).rejects.toThrow('RAID_STARTER_SOURCE');
 expect(await conn.sql`select * from raid_starter_presentations where raid_id=${raid.id}`).toEqual(saved);
 expect(await readRaidStarterPresentation(db,raid.id,raid.snapshot)).toEqual(shape(f.defender,'occupied'));
});

it('rolls back raid, immutable capture, ante and energy when the post-INSERT independent result disagrees',async()=>{
 const f=await battle(),balance=(await getOrCreateBaseAccount(db,f.attacker.baseId,'base_shards')).balance;
 const energy=await getRaidEnergy(db,f.attacker.wallet,f.now,f.attacker.baseId),original=starterPresentation.readStarterServicePresentation;
 // Exercise the admission comparison after genuine proof and SQL INSERT, not
 // a mocked proof bypass or a source error which occurred before charging.
 vi.spyOn(starterPresentation,'readStarterServicePresentation').mockImplementation(async(...args)=>{await original(...args);return null;});
 await expect(f.create()).rejects.toMatchObject({code:'RAID_STARTER_CAPTURE_MISMATCH'});
 expect((await getOrCreateBaseAccount(db,f.attacker.baseId,'base_shards')).balance).toBe(balance);
 expect(await getRaidEnergy(db,f.attacker.wallet,f.now,f.attacker.baseId)).toEqual(energy);
 expect(await db.select().from(raids).where(eq(raids.idempotencyKey,f.options.idempotencyKey))).toHaveLength(0);
 expect(await conn.sql`select * from raid_starter_presentations where defender_base_id=${f.defender.baseId}`).toHaveLength(0);
});

it('preserves original away facts through actual custody transfer and refuses mismatched mutable replay input',async()=>{
 const f=await battle(),trip=await f.defender.dispatch(),raid=await f.create();
 // Staging one genuine order creates ordinary deed history on pre-start retreat.
 await acceptLiveRaidCommand(db,f.attacker.wallet,raid.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:-1,ty:14}},f.now);
 {const clock=await getRaidClock(db,raid.id,f.now);if(!clock.live.startedAt)await startLiveRaid(db,f.attacker.wallet,raid.id,randomUUID(),clock.clock.revision,f.now);}
 await retreatLiveRaid(db,f.attacker.wallet,raid.id,randomUUID(),new Date(+f.now+1000));
 expect(await recoverDueStartedLiveRaids(db,new Date(+f.now+RAID_RULES.battleDurationSec*1000+1),undefined,raid.id)).toEqual({resolved:1,raced:0});
 const buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();
 await db.insert(players).values({wallet:buyer});
 // Deed identity is explicitly synthetic; custody movement uses the real service.
 await db.update(bases).set({deedAssetId:deed,deedMintAssetId:deed,landPaidAt:f.now}).where(eq(bases.id,f.defender.baseId));
 await transferStableBase(db,f.defender.baseId,f.defender.wallet,buyer,deed,{owner:buyer,collection,frozen:false,delegate:null,slot:100,observedAtMs:Date.now()},()=>new Date());
 const inherited=await getBaseBattleReplay(db,buyer,f.defender.baseId,raid.id);
 expect(inherited.servicePresentation).toEqual(shape(f.defender,'away'));expect(inherited.result).toMatchObject({lootShards:null,lootRedacted:true});
 expect((await getReplay(db,f.attacker.wallet,raid.id)).servicePresentation).toEqual(inherited.servicePresentation);
 const original=raid.snapshot;
 await db.update(raids).set({snapshot:{...(original as object),buildings:[]}}).where(eq(raids.id,raid.id));
 try{await expect(getReplay(db,f.attacker.wallet,raid.id)).rejects.toMatchObject({statusCode:409});}
 finally{await db.update(raids).set({snapshot:original}).where(eq(raids.id,raid.id));}
 expect(await readRaidStarterPresentation(db,raid.id,original)).toEqual(shape(f.defender,'away'));
 expect(trip.installationId).toBe(f.defender.installationId);
});

it('grants only the private reader to real runtime logins and removes stale column privileges on reprovision',async()=>{
 const f=await battle(),raid=await f.create(),role='rsapi_'+randomBytes(8).toString('hex'),worker='rsworker_'+randomBytes(8).toString('hex');
 const password=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex'),adminUrl=new URL(ADMIN_DATABASE_URL);
 const provision=()=>execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{
  PATH:'/opt/homebrew/opt/postgresql@16/bin:'+process.env.PATH,PGHOST:adminUrl.hostname,PGPORT:adminUrl.port,PGDATABASE:name,
  PGUSER:decodeURIComponent(adminUrl.username),PGPASSWORD:decodeURIComponent(adminUrl.password),POSTGRES_USER:decodeURIComponent(adminUrl.username),
  POSTGRES_PASSWORD:decodeURIComponent(adminUrl.password)||'owned-loopback-trust-fixture',DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',
  API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:workerPassword}});
 let request:ReturnType<typeof createDb>|undefined;
 try{
  provision();await conn.sql`grant select(presentation) on raid_starter_presentations to shardkeep_api_runtime`;
  await conn.sql`grant select(record) on raid_starter_presentation_contract to shardkeep_worker_runtime`;provision();
  const requestUrl=new URL(url);requestUrl.username=role;requestUrl.password=password;request=createDb(requestUrl.toString(),{max:2});
  const [privileges]=await request.sql`select has_table_privilege(current_user,'raid_starter_presentations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') data,
   has_any_column_privilege(current_user,'raid_starter_presentations','SELECT,INSERT,UPDATE') columns,
   has_any_column_privilege(current_user,'raid_starter_presentation_contract','SELECT,INSERT,UPDATE') seal,
   has_function_privilege(current_user,'shardkeep_raid_starter_presentation(uuid)','EXECUTE') reader,
   has_function_privilege(current_user,'shardkeep_raid_starter_projection(uuid,jsonb,timestamptz)','EXECUTE') derive`;
  expect(privileges).toEqual({data:false,columns:false,seal:false,reader:true,derive:false});
  expect(await readRaidStarterPresentation(request.db,raid.id,raid.snapshot)).toEqual(shape(f.defender,'occupied'));
  await expect(request.sql`select * from raid_starter_presentations`).rejects.toThrow('permission denied');
  expect((await conn.sql`select public.shardkeep_raid_starter_sources_valid() valid`)[0]!.valid).toBe(true);
 }finally{await request?.sql.end();for(const login of [role,worker]){await conn.sql.unsafe(`drop owned by ${login}`);await conn.sql.unsafe(`drop role ${login}`);}}
},60000);

it('exports actual authenticated normal HTTP live/archive and protocol-two bodies with the same frozen capture',async()=>{
 const f=await battle(),trip=await f.defender.dispatch(),raid=await f.create();
 const config={...TEST_CONFIG,FREE_ONBOARDING:'true',MULTI_BASE_ENABLED:'true',NATIVE_PRESENTATION_ENABLED:'true',NATIVE_PRESENTATION_OPEN:'true'} as typeof TEST_CONFIG;
 const app=await buildApp(config,db);await app.ready();
 try{
  const [session]=await db.insert(sessions).values({wallet:f.attacker.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.attacker.wallet,session!.id)},path=`/raids/${raid.id}/presentation`;
  expect((await app.inject({url:path})).statusCode).toBe(401);
  const read=async(url:string)=>{const response=await app.inject({url,cookies});expect(response.statusCode,response.body).toBe(200);return response.body;};
  const live=await read(path),livePage=await read(path+'?protocolVersion=2');
  await acceptLiveRaidCommand(db,f.attacker.wallet,raid.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:-1,ty:14}},f.now);
  {const clock=await getRaidClock(db,raid.id,f.now);if(!clock.live.startedAt)await startLiveRaid(db,f.attacker.wallet,raid.id,randomUUID(),clock.clock.revision,f.now);}
  await retreatLiveRaid(db,f.attacker.wallet,raid.id,randomUUID(),new Date(+f.now+1000));
  expect(await recoverDueStartedLiveRaids(db,new Date(+f.now+RAID_RULES.battleDurationSec*1000+1),undefined,raid.id)).toEqual({resolved:1,raced:0});
  vi.setSystemTime(trip.returnsAt);await getBaseState(db,f.defender.wallet,trip.returnsAt,f.defender.baseId,f.defender.authority.assertAuthority,()=>trip.returnsAt);
  const archive=await read(path),archivePage=await read(path+'?protocolVersion=2');
  expect(JSON.parse(archive).source).toBe('archive');expect(JSON.parse(archivePage).state.source).toBe('archive');
  for(const body of [live,archive])expect(JSON.parse(body).servicePresentation).toEqual(shape(f.defender,'away'));
  for(const body of [livePage,archivePage])expect(JSON.parse(body).state.servicePresentation).toEqual(shape(f.defender,'away'));
  await writeFile('/tmp/raid-starter-primary-http-pair.json',JSON.stringify({provenance:{kind:'normal-buildApp-authenticated-inject-response-bodies',
   authority:'Synthetic facility/deedless base and finalized-term fixture; genuine install, dispatch, raid admission, return and started-retreat canonical battle archive.',
   clock:'Date-only historical local fixture; SQL captured_at remains before actual database wall time.',
   limits:'No listening socket, native HTTP, native rendering, art readiness, Android or release claim.',wallet:f.attacker.wallet,raidId:raid.id,berthId:f.defender.berthId},
   live,livePage,archive,archivePage},null,2)+'\n');
 }finally{await app.close();}
},60000);
