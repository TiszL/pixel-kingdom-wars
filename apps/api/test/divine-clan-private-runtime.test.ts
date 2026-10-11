/** Normal private composition + true restricted LOGIN/HTTP. The existing
 * typed issuer/finality banks and explicit simulator clock are local fixtures. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach,expect,it,vi} from 'vitest';
import {RAID_RULES} from '@shardkeep/shared';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {createDb} from '../src/db/client';
import {baseArmy} from '../src/db/schema';
import {createPhaseEServices} from '../src/phaseEServices';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {assertFreshLockedBaseAuthority,refreshBaseOwnership} from '../src/game/baseOwnership';
import {acceptLiveRaidCommand} from '../src/game/liveRaids';
import {recoverDueStartedLiveRaids} from '../src/game/raids';
import {joinClan,leaveClan} from '../src/game/clans';
import {TEST_CONFIG} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {divineClanFragmentFixture,type DivineClanFragmentFixture} from './fixtures/divineClanFragments';

afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
const path='/clans/charter/tournaments';
const funding=(f:DivineClanFragmentFixture)=>({id:f.event.id,baseId:f.source.baseId,weekStart:f.event.entryStartsAt,budget:f.event.budget});
async function fixture(run:(f:DivineClanFragmentFixture,r:Awaited<ReturnType<typeof runtime>>)=>Promise<void>){
 const f=await divineClanFragmentFixture();try{const r=await runtime(f);try{await run(f,r);}finally{await r.close();}}finally{await f.dispose();}
}
async function runtime(f:DivineClanFragmentFixture){
 const time=(at:string|Date)=>{f.setTime(new Date(at));vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.clock());};time(f.clock());
 const [database]=await f.sql`select current_database() name`,ownerUrl=new URL(ADMIN_DATABASE_URL);ownerUrl.pathname='/'+database!.name;
 const suffix=randomUUID().replaceAll('-',''),role='clan_api_'+suffix,worker='clan_worker_'+suffix,password=randomBytes(32).toString('hex');
 const provision=()=>execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 provision();const requestUrl=new URL(ownerUrl);requestUrl.username=role;requestUrl.password=password;const request=createDb(requestUrl.toString(),{max:3});
 // 2026-10-10 (CI cluster E): a failure between provisioning and the returned close()
 // used to leak both LOGINs and their shared-group edges, so every later guarded
 // role fixture refused ('Shared runtime roles are not idle'). Drop them here too.
 try{
 const config={...TEST_CONFIG,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:ownerUrl.toString(),CHARTER_TOURNAMENT_SPONSOR_WALLET:f.source.wallet,CHARTER_TOURNAMENT_TREASURY:f.domain.treasury};
 const access=await createSeekerRealmAccessFixture();let termReads=0,accessReads=0,lockReads=0;
 const sources={term:{policy:f.fragmentBank.policy,connect:(signal:AbortSignal)=>{termReads++;return f.fragmentBank.connect(signal);}},access:{trust:access.trust,connect:(_signal:AbortSignal)=>{accessReads++;return access.rpc;}}};
 const connect=(signal:AbortSignal)=>{lockReads++;return f.lockChain.connect(signal);},recovery={trust:f.lockChain.trust,connect},locks={chain:{...f.lockChain,connect},issuer:f.lockIssuer};
 const ownership={finalizedDeedReader:f.reader,deedCollection:f.source.collection};
 // This fixture advances the calendar after the genuine deed births. Refresh
 // actual owned observations at that clock before normal startup preflight.
 const refresh=async()=>{for(const base of await f.sql`select id from bases where status='active' and deed_asset_id is not null`)expect(await refreshBaseOwnership(f.db,base.id,f.reader,f.source.collection)).toBe('owned');};await refresh();
 let services=await createPhaseEServices(config,request.db,ownership,undefined,undefined,undefined,undefined,sources,recovery,undefined,undefined,locks),app=await buildApp(config,request.db,services!.deps);
 const cookies=new Map<string,Record<string,string>>();
 for(const wallet of [...f.members.map(m=>m.wallet),f.buyer.wallet]){const [session]=await f.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;cookies.set(wallet,{[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)});}
 const http=(wallet:string,url:string,payload?:Record<string,unknown>)=>app.inject({method:payload?'POST':'GET',url,cookies:cookies.get(wallet)!,headers:{origin:config.WEB_ORIGIN[0]!},...payload?{payload}:{}});
 async function restart(){await app.close();await services!.close();await refresh();const held={...config,CHARTER_TOURNAMENT_SPONSOR_WALLET:undefined,CHARTER_TOURNAMENT_TREASURY:undefined};services=await createPhaseEServices(held,request.db,ownership);app=await buildApp(held,request.db,services!.deps);}
 return {request,provision,time,http,restart,get app(){return app;},get services(){return services!;},reads:()=>({termReads,accessReads,lockReads}),
  async close(){await app.close();await services!.close();await request.sql.end();for(const name of [role,worker])await f.sql.unsafe(`drop owned by ${name};drop role ${name}`);}};
 }catch(error){await request.sql.end();for(const name of [role,worker])await f.sql.unsafe(`drop owned by ${name};drop role if exists ${name}`);throw error;}
}
async function complete(f:DivineClanFragmentFixture,r:Awaited<ReturnType<typeof runtime>>,id:string){
 const prepared=await f.prepare(id),before=r.reads();
 const wrong=await r.http(f.buyer.wallet,`${path}/operations/${id}/recover`,{});expect(wrong.statusCode,wrong.body).toBe(404);expect(r.reads()).toEqual(before);
 const saved=await r.http(f.source.wallet,`${path}/operations/${id}/signed`,{signedTransaction:f.signed(prepared).toString('base64')});expect(saved.statusCode,saved.body).toBe(200);
 await f.finalizeLock(id);const recovered=await r.http(f.source.wallet,`${path}/operations/${id}/recover`,{});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().terminal.outcome).toBe('completed');
}
it('normal private clan factory earns through HTTP and preserves original roster rights under paused providerless recovery',()=>fixture(async(f,r)=>{
 const operator=r.services.clanOperator;expect(operator).not.toBeNull();expect(Object.keys(operator!).sort()).toEqual(['closeAndSettle','enroll','fundAndEnroll','initializeEpoch']);
 for(const key of ['clanOperator','fundAndEnroll','enroll','closeAndSettle','initializeEpoch','db'])expect(r.services.deps).not.toHaveProperty(key);
 const before=r.reads();expect((await r.app.inject({method:'POST',url:`${path}/entries`,payload:f.request()})).statusCode).toBe(401);expect(r.reads()).toEqual(before);
 const opening=await f.sql`select * from crafting_stocks order by base_id,item_id`;await operator!.fundAndEnroll(f.source.wallet,funding(f));await operator!.fundAndEnroll(f.source.wallet,funding(f));expect(await f.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(opening);
 r.time(new Date(Date.parse(f.event.entryStartsAt)+3_600_000));const command=f.request(),entry=await r.http(f.source.wallet,`${path}/entries`,command);expect(entry.statusCode,entry.body).toBe(201);const entered=entry.json();await complete(f,r,entered.set.original.operation.id);
 r.time(new Date(Date.parse(f.event.playStartsAt)+3_600_000));await f.db.insert(baseArmy).values({baseId:f.source.baseId,troop:'highlander',count:5}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:5}});
 const started=await r.http(f.source.wallet,`${path}/events/${f.event.id}/raids`,{baseId:f.source.baseId,idempotencyKey:randomUUID()});expect(started.statusCode,started.body).toBe(200);const raid=started.json().raid;
 // Real ordinary simulator with the accepted historical fixture clock. This
 // test does not claim a separate live-command wall-clock transport acceptance.
 await acceptLiveRaidCommand(f.db,f.source.wallet,raid.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:6,ty:10}},f.clock());
 r.time(new Date(f.clock().getTime()+RAID_RULES.battleDurationSec*1000+1));expect((await recoverDueStartedLiveRaids(f.db,f.clock(),undefined,raid.id)).resolved).toBe(1);
 const result=await f.withSourceClock(()=>operator!.closeAndSettle(f.event.id));r.time(f.clock());expect(result.settlement.awards.map(a=>a.wallet).sort()).toEqual(f.members.map(m=>m.wallet).sort());
 const clearing=await r.http(f.source.wallet,`${path}/entries/${entered.id}/clear`,{idempotencyKey:randomUUID()});expect(clearing.statusCode,clearing.body).toBe(200);await complete(f,r,clearing.json().original.operation.id);
 const member=f.members[1]!;expect(await refreshBaseOwnership(f.db,member.baseId,f.reader,f.source.collection)).toBe('owned');await leaveClan(f.db,member.wallet,{baseId:member.baseId,assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id);}});await joinClan(f.db,f.buyer.wallet,f.birth.consent.clanId);
 const oldAward=await r.http(member.wallet,`/divine-fragments/events/${f.event.id}`);expect(oldAward.statusCode,oldAward.body).toBe(200);expect(oldAward.json().award).toEqual(result.settlement.awards.find(a=>a.wallet===member.wallet));expect((await r.http(f.buyer.wallet,`/divine-fragments/events/${f.event.id}`)).json().award).toBeNull();
 const delivery={baseId:member.baseId,idempotencyKey:randomUUID()},delivered=await r.http(member.wallet,`/divine-fragments/events/${f.event.id}/delivery`,delivery);expect(delivered.statusCode,delivered.body).toBe(200);
 const claim={termId:result.settlement.term.snapshot.termId,spotId:0,baseId:f.source.baseId,idempotencyKey:randomUUID()},claimed=await r.http(f.source.wallet,'/divine-fragments/seeker/claims',claim);expect(claimed.statusCode,claimed.body).toBe(200);
 const prize=await r.http(f.source.wallet,`${path}/events/${f.event.id}/prize`,{baseId:f.source.baseId});expect(prize.statusCode,prize.body).toBe(200);
 const original=(await r.http(f.source.wallet,`${path}/entries/${entered.id}`)).json(),stock=await f.sql`select * from crystal_fragment_stocks order by base_id`,crafting=await f.sql`select * from crafting_stocks order by base_id,item_id`,reads=r.reads();
 for(const flag of ['PHASE_E_CHARTER_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_SEEKER_ENABLED'])vi.stubEnv(flag,'false');await r.restart();expect(r.services.clanOperator).toBeNull();
 const recovered=await r.http(f.source.wallet,`${path}/entries`,command);expect(recovered.statusCode,recovered.body).toBe(201);expect(recovered.json()).toEqual(original);
 expect((await r.http(f.source.wallet,`${path}/entries`,{...command,clanId:randomUUID()})).statusCode).toBe(409);
 expect((await r.http(f.source.wallet,`${path}/events`,funding(f))).statusCode).toBe(201);expect((await r.http(f.source.wallet,`${path}/events/${f.event.id}/prize`,{baseId:f.source.baseId})).json()).toEqual(prize.json());
 expect((await r.http(member.wallet,`/divine-fragments/events/${f.event.id}/delivery`,delivery)).json()).toEqual(delivered.json());expect((await r.http(f.source.wallet,'/divine-fragments/seeker/claims',claim)).json()).toEqual(claimed.json());
 expect((await r.http(f.buyer.wallet,`/divine-fragments/deliveries/${delivery.idempotencyKey}`)).json().receipt).toBeNull();
 expect(await f.sql`select * from crystal_fragment_stocks order by base_id`).toEqual(stock);expect(await f.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(crafting);expect(r.reads()).toEqual(reads);expect(reads.accessReads).toBe(0);
 expect(f.sent).toHaveLength(0);
}),120000);

it('normal startup preserves source seals/private ACLs, blocks unenrolled entries and grants no public new funding',()=>fixture(async(f,r)=>{
 const tables=await f.sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (left(c.relname,19)='charter_tournament_' or left(c.relname,16)='divine_fragment_' or c.relname in ('crystal_fragment_stocks','seeker_fragment_claims')) order by c.relname`;
 expect(tables.length).toBeGreaterThan(10);for(const {relname} of tables){const [acl]=await r.request.sql`select has_table_privilege(current_user,${'public.'+relname},'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') table_acl,has_any_column_privilege(current_user,${'public.'+relname},'SELECT,INSERT,UPDATE,REFERENCES') column_acl`;expect(acl).toEqual({table_acl:false,column_acl:false});}
 await expect(r.request.sql`select original from charter_tournament_entries`).rejects.toMatchObject({code:'42501'});await expect(r.request.sql`select certificate_json from divine_fragment_settlements`).rejects.toMatchObject({code:'42501'});
 await f.sql`select shardkeep_charter_tournament_source_check(),shardkeep_divine_fragment_source()`;r.provision();await f.sql`select shardkeep_charter_tournament_source_check(),shardkeep_divine_fragment_source()`;
 r.time(f.event.entryStartsAt);const reads=r.reads(),entry=await r.http(f.source.wallet,`${path}/entries`,f.request());expect(entry.statusCode,entry.body).toBe(503);expect(entry.json().error.code).toBe('DIVINE_FRAGMENT_NOT_ENROLLED');expect(await f.sql`select * from charter_tournament_entries`).toHaveLength(0);
 const held=await r.http(f.source.wallet,`${path}/events`,{...funding(f),id:randomUUID()});expect(held.statusCode,held.body).toBe(503);expect(held.json().error.code).toBe('CLAN_CHARTER_TOURNAMENT_FUNDING_HELD');
 for(const url of [`${path}/events/${f.event.id}/enroll`,`/divine-fragments/events/${f.event.id}/settle`])expect((await r.http(f.source.wallet,url,{})).statusCode).toBe(404);
 await r.restart();expect(r.services.clanOperator).toBeNull();expect((await r.http(f.source.wallet,`${path}/events/${f.event.id}`)).statusCode).toBe(200);expect(r.reads()).toEqual(reads);expect(f.sent).toHaveLength(0);
}),120000);
