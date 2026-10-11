/** Normal private composition over real funded mining/Renown, simulator outcomes
 * and historical Seeker fixture bytes. Fixture banks are not live RPC/SBF proof;
 * the independent unused realm-access fixture proves no paid-access behavior. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PublicKey} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {withDivineFragmentFixture,type DivineFragmentFixture} from './fixtures/divineFragments';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {createDb} from '../src/db/client';
import {createPhaseEServices} from '../src/phaseEServices';
import {buildApp} from '../src/app';
import {TEST_CONFIG} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import type {MiningClaimsProvider} from '../src/mining/claimRoutes';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(run:(f:DivineFragmentFixture,r:Awaited<ReturnType<typeof runtime>>)=>Promise<void>){
 await withDivineFragmentFixture(async f=>{const r=await runtime(f);try{await run(f,r);}finally{await r.close();}});
}
async function runtime(f:DivineFragmentFixture){
 const time=(at:string|Date)=>{f.setTime(at);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.clock());};time(f.clock());
 const [database]=await f.sql`select current_database() name`;const ownerUrl=new URL(ADMIN_DATABASE_URL);ownerUrl.pathname='/'+database!.name;
 const suffix=randomUUID().replaceAll('-',''),role='divine_api_'+suffix,worker='divine_worker_'+suffix,password=randomBytes(32).toString('hex');
 const provision=()=>execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 provision();const requestUrl=new URL(ownerUrl);requestUrl.username=role;requestUrl.password=password;const request=createDb(requestUrl.toString(),{max:3});
 const config={...TEST_CONFIG,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:ownerUrl.toString(),DIVINE_TRIAL_SPONSOR_WALLET:f.wallet};
 const access=await createSeekerRealmAccessFixture();let qualificationReads=0,termConnections=0,accessConnections=0;
 f.beforeRead(async()=>{qualificationReads++;});
 const sources={term:{policy:f.fragmentBank.policy,connect:(signal:AbortSignal)=>{termConnections++;return f.fragmentBank.connect(signal);}},access:{trust:access.trust,connect:(_signal:AbortSignal)=>{accessConnections++;return access.rpc;}}};
 const ownership={finalizedDeedReader:f.options.finalizedDeedReader??null,deedCollection:f.options.deedCollection??null};
 let services=await createPhaseEServices(config,request.db,ownership,undefined,undefined,undefined,undefined,sources,undefined,f.options.qualificationSource),app=await buildApp(config,request.db,services!.deps);
 const cookies=new Map<string,Record<string,string>>();
 for(const wallet of [f.wallet,f.buyer]){const [session]=await f.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;cookies.set(wallet,{[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)});}
 const http=(wallet:string,url:string,payload?:Record<string,unknown>)=>app.inject({method:payload?'POST':'GET',url,cookies:cookies.get(wallet)!,headers:{origin:config.WEB_ORIGIN[0]!},...payload?{payload}:{}});
 async function restart(qualification?:Pick<MiningClaimsProvider,'reader'|'trust'>,sponsor?:string,term=false){
  await app.close();await services!.close();
  services=await createPhaseEServices({...config,DIVINE_TRIAL_SPONSOR_WALLET:sponsor},request.db,ownership,undefined,undefined,undefined,undefined,term?sources:undefined,undefined,qualification);
  app=await buildApp({...config,DIVINE_TRIAL_SPONSOR_WALLET:sponsor},request.db,services!.deps);
 }
 return {request,role,worker,config,time,provision,http,restart,get app(){return app;},get services(){return services!;},reads:()=>({qualificationReads,termConnections,accessConnections}),
  async close(){await app.close();await services?.close();await request.sql.end();for(const name of [role,worker])await f.sql.unsafe(`drop owned by ${name};drop role ${name}`);}};
}
const entryUrl=(id:string)=>`/divine-trials/events/${id}/entries`,attemptUrl=(id:string)=>`/divine-trials/events/${id}/attempts`;
it('normal owner factory funds/enrolls, runs authentic attempts and settles/delivers both rights through restricted HTTP',()=>fixture(async(f,r)=>{
 const {divineTrialProvider:trial,divineFragmentProvider:fragments}=r.services.deps,operator=r.services.divineOperator;
 expect(Object.keys(trial!).sort()).toEqual(['abandon','admit','claim','enter','events','participant','read','submit']);
 expect(Object.keys(fragments!.fragments).sort()).toEqual(['award','awards','deliver','deliveryRead','policy','stock']);
 expect(Object.keys(fragments!.seeker).sort()).toEqual(['claim','claimRead','term','terms']);
 expect(Object.keys(operator!).sort()).toEqual(['closeAndSettle','enroll','fundAndEnroll']);expect(r.services.deps).not.toHaveProperty('divineOperator');
 const before=r.reads();expect((await r.app.inject({url:'/divine-trials/events'})).statusCode).toBe(401);expect(r.reads()).toEqual(before);
 const stockBefore=await f.sql`select item_id,available from crafting_stocks where base_id=${f.baseId} order by item_id`;
 const funding={id:f.event.id,baseId:f.baseId,weekStart:f.event.entryStartsAt,budget:f.budget};
 await operator!.fundAndEnroll(f.wallet,funding);await operator!.fundAndEnroll(f.wallet,funding);
 expect(await f.sql`select item_id,available from crafting_stocks where base_id=${f.baseId} order by item_id`).toEqual(stockBefore);
 expect(await f.sql`select event_id from divine_fragment_enrollments`).toEqual([{event_id:f.event.id}]);
 const discovered=await r.http(f.wallet,'/divine-trials/events');expect(discovered.statusCode,discovered.body).toBe(200);
 const entries=new Map<string,{baseId:string;idempotencyKey:string}>(),attempts=new Map<string,{command:{baseId:string;idempotencyKey:string};record:{id:string};result:unknown}>();
 r.time(f.event.entryStartsAt);
 for(const [wallet,baseId] of [[f.wallet,f.baseId],[f.buyer,f.buyerBaseId]]){const command={baseId:baseId!,idempotencyKey:randomUUID()};entries.set(wallet!,command);const response=await r.http(wallet!,entryUrl(f.event.id),command);expect(response.statusCode,response.body).toBe(200);expect(response.json().qualification.renown).toBe('1');}
 r.time(f.event.playStartsAt);
 for(const [wallet,baseId] of [[f.wallet,f.baseId],[f.buyer,f.buyerBaseId]]){
  const command={baseId:baseId!,idempotencyKey:randomUUID()},admitted=await r.http(wallet!,attemptUrl(f.event.id),command);expect(admitted.statusCode,admitted.body).toBe(200);const record=admitted.json();
  const response=await r.http(wallet!,`/divine-trials/attempts/${record.id}/submit`,{orders:f.orders(wallet===f.wallet?'north':'south')});expect(response.statusCode,response.body).toBe(200);expect(response.json().status).toBe('completed');expect(response.json().result).not.toBeNull();attempts.set(wallet!,{command,record,result:response.json()});
 }
 const closed=await f.withSourceClock(()=>operator!.closeAndSettle(f.event.id));r.time(f.clock());
 expect(closed.event.terminal).not.toBeNull();expect(closed.settlement.awards).toHaveLength(2);const termId=closed.settlement.term.snapshot.termId;
 for(const a of closed.settlement.awards)expect(BigInt(a.net)+BigInt(a.tax)).toBe(BigInt(a.gross));
 const delivery={idempotencyKey:randomUUID(),baseId:f.baseId},seeker={...delivery,idempotencyKey:randomUUID(),termId,spotId:0};
 const delivered=await r.http(f.wallet,`/divine-fragments/events/${f.event.id}/delivery`,delivery);expect(delivered.statusCode,delivered.body).toBe(200);
 const claimed=await r.http(f.wallet,'/divine-fragments/seeker/claims',seeker);expect(claimed.statusCode,claimed.body).toBe(200);expect(BigInt(claimed.json().quantity)).toBeGreaterThan(0n);
 const prize=await r.http(f.wallet,`/divine-trials/events/${f.event.id}/prize`,{baseId:f.baseId});expect(prize.statusCode,prize.body).toBe(200);
 const savedStock=await f.sql`select base_id,available from crystal_fragment_stocks order by base_id`,savedCrafting=await f.sql`select base_id,item_id,available from crafting_stocks order by base_id,item_id`;
 for(const flag of ['PHASE_E_CATALOG_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED'])vi.stubEnv(flag,'false');
 f.setOnline(false);await r.restart();expect(r.services.divineOperator).toBeNull();const count=r.reads();
 const oldEntry=await r.http(f.wallet,entryUrl(f.event.id),entries.get(f.wallet)!);expect(oldEntry.statusCode,oldEntry.body).toBe(200);
 const savedAttempt=attempts.get(f.wallet)!;const oldAttempt=await r.http(f.wallet,attemptUrl(f.event.id),savedAttempt.command);expect(oldAttempt.statusCode,oldAttempt.body).toBe(200);expect(oldAttempt.json().id).toBe(savedAttempt.record.id);
 expect((await r.http(f.wallet,`/divine-trials/attempts/${savedAttempt.record.id}`)).json()).toEqual(savedAttempt.result);
 expect((await r.http(f.wallet,`/divine-fragments/events/${f.event.id}/delivery`,delivery)).json()).toEqual(delivered.json());
 expect((await r.http(f.wallet,'/divine-fragments/seeker/claims',seeker)).json()).toEqual(claimed.json());
 expect((await r.http(f.wallet,`/divine-trials/events/${f.event.id}/prize`,{baseId:f.baseId})).json()).toEqual(prize.json());
 expect((await r.http(f.buyer,`/divine-trials/attempts/${savedAttempt.record.id}`)).statusCode).toBe(404);
 expect((await r.http(f.buyer,`/divine-fragments/deliveries/${delivery.idempotencyKey}`)).json().receipt).toBeNull();
 expect((await r.http(f.wallet,`/divine-fragments/seeker/terms/${termId}`)).json().rows[0].claimable).toBe('0');
 expect(await f.sql`select base_id,available from crystal_fragment_stocks order by base_id`).toEqual(savedStock);expect(await f.sql`select base_id,item_id,available from crafting_stocks order by base_id,item_id`).toEqual(savedCrafting);expect(r.reads()).toEqual(count);expect(count.accessConnections).toBe(0);
}),120000);
it('funds an explicit new event once and holds missing enrollment, source-less or mismatched qualification',()=>fixture(async(f,r)=>{
 const newFunding={id:randomUUID(),baseId:f.baseId,weekStart:'2020-01-11T00:00:00.000Z',budget:Object.fromEntries(Object.keys(f.budget).map(key=>[key,'1']))};
 const opening=await f.sql`select item_id,available from crafting_stocks where base_id=${f.baseId} order by item_id`;
 const funded=await r.services.divineOperator!.fundAndEnroll(f.wallet,newFunding);expect(funded.id).toBe(newFunding.id);
 const after=await f.sql`select item_id,available from crafting_stocks where base_id=${f.baseId} order by item_id`;
 expect(after).toEqual(opening.map(row=>({...row,available:(BigInt(row.available)-BigInt(newFunding.budget[row.item_id]??'0')).toString()})));
 await r.services.divineOperator!.fundAndEnroll(f.wallet,newFunding);expect(await f.sql`select item_id,available from crafting_stocks where base_id=${f.baseId} order by item_id`).toEqual(after);
 r.time(f.event.entryStartsAt);const command={baseId:f.baseId,idempotencyKey:randomUUID()},before=r.reads();
 const missing=await r.http(f.wallet,entryUrl(f.event.id),command);expect(missing.statusCode,missing.body).toBe(503);expect(missing.json().error.code).toBe('DIVINE_FRAGMENT_NOT_ENROLLED');expect(r.reads()).toEqual(before);
 // This fixture owns historical clock control, never backfills a real played event.
 r.time('2020-01-03T00:00:00.000Z');await r.services.divineOperator!.enroll(f.event.id);r.time(f.event.entryStartsAt);
 await r.restart();const held=await r.http(f.wallet,entryUrl(f.event.id),command);expect(held.statusCode,held.body).toBe(503);expect(held.json().error.code).toBe('DIVINE_TRIAL_CONFIGURATION');expect(r.services.divineOperator).toBeNull();
 await r.restart({...f.options.qualificationSource,trust:{...f.options.qualificationSource.trust,expectedGenesisHash:new PublicKey(Buffer.alloc(32,211)).toBase58()}},f.wallet,true);
 const wrong=await r.http(f.wallet,entryUrl(f.event.id),command);expect(wrong.statusCode,wrong.body).toBe(503);
 expect(await f.sql`select id from divine_trial_entries`).toHaveLength(0);expect(await f.sql`select id from divine_trial_attempts`).toHaveLength(0);
}),120000);
it('provisioning keeps every private Divine table and column inaccessible and preserves canonical source seals',()=>fixture(async(f,r)=>{
 const relations=await f.sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (left(c.relname,13)='divine_trial_' or left(c.relname,16)='divine_fragment_' or c.relname in ('crystal_fragment_stocks','seeker_fragment_claims')) order by c.relname`;
 expect(relations.length).toBeGreaterThan(10);
 for(const {relname} of relations){const [allowed]=await r.request.sql`select has_table_privilege(current_user,${'public.'+relname},'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') table_acl,has_any_column_privilege(current_user,${'public.'+relname},'SELECT,INSERT,UPDATE,REFERENCES') column_acl`;expect(allowed).toEqual({table_acl:false,column_acl:false});}
 await expect(r.request.sql`select source_json from divine_trial_entries`).rejects.toMatchObject({code:'42501'});
 await expect(r.request.sql`select certificate_json from divine_fragment_settlements`).rejects.toMatchObject({code:'42501'});
 await f.sql`select shardkeep_divine_trial_event_source()`;await f.sql`select shardkeep_divine_fragment_source()`;await r.provision();await f.sql`select shardkeep_divine_trial_event_source()`;await f.sql`select shardkeep_divine_fragment_source()`;
 for(const url of [`/divine-trials/events/${f.event.id}/fund`,`/divine-trials/events/${f.event.id}/close`,`/divine-fragments/events/${f.event.id}/enroll`,`/divine-fragments/events/${f.event.id}/settle`])expect((await r.http(f.wallet,url,{})).statusCode).toBe(404);
}),120000);
