/** Enrollment observes committed gameplay through a separate owner capability;
 * it never turns late capture into historical ownership or exposes SQL authority. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {BuildingType,MINING,OBSTACLES,getMiningQuota} from '@shardkeep/shared';
import {eq} from 'drizzle-orm';
import type {FastifyInstance} from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {buildApp,type AppDeps} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createDb,type Db} from '../src/db/client';
import {bases,baseSlots,buildings,builderJobs,obstacles,players,sessions} from '../src/db/schema';
import {createMiningRosterEnrollmentProvider} from '../src/mining/rosterEnrollmentGameplay';
import {prefetchPhysicalMineCustody} from '../src/mining/shardsTaxMineCustody';
import {MINE_DAY_MS,reanchorBaseMineAccrual} from '../src/game/baseMining';
import {claimRect,footprintOf,overlaps} from '../src/game/footprints';
import {provisionApiRuntimeLogin} from './fixtures/apiRuntimeLogin';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {TEST_CONFIG} from './helpers';
let conn:ReturnType<typeof resourceClaimsDatabase>;const servers:FastifyInstance[]=[];
const start=new Date('2035-01-01T12:00:00.000Z');
type Enrollment={enroll(wallet:string):Promise<void>};
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(start);vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('FREE_ONBOARDING','true');
 conn=resourceClaimsDatabase();await conn.setup();await time(start);
},120000);
afterEach(async()=>{await Promise.all(servers.splice(0).map(app=>app.close()));vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function time(at:Date){vi.setSystemTime(at);const value=at.toISOString();if(!/^2035-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))throw Error('fixture clock');await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);}
async function actor(){const wallet=Keypair.generate().publicKey.toBase58();await conn.db.insert(players).values({wallet});const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(+start+SESSION_TTL_SEC*1000)}).returning();return {wallet,cookies:{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)}};}
const ownerProvider=()=>{const provider=createMiningRosterEnrollmentProvider(conn.db);return {enroll:vi.fn(provider.enroll)};};
async function open(provider?:Enrollment,db:Db=conn.db){
 vi.stubEnv('MULTI_BASE_ENABLED','false');try{
  const deps:AppDeps={...(provider?{miningRosterEnrollmentProvider:provider}:{})};
  const app=await buildApp(TEST_CONFIG,db,deps);servers.push(app);await app.ready();return app;
 }finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}
}
const baseline=(wallet:string)=>conn.sql`select to_jsonb(b) value from mining_roster_baselines b where wallet=${wallet}`;
const read=(app:FastifyInstance,f:Awaited<ReturnType<typeof actor>>,query='')=>app.inject({method:'GET',url:'/base'+query,cookies:f.cookies});
async function mineSource(app:FastifyInstance,f:Awaited<ReturnType<typeof actor>>,baseId:string){
 const [bs,os]=await Promise.all([conn.db.select().from(buildings).where(eq(buildings.baseId,baseId)),conn.db.select().from(obstacles).where(eq(obstacles.baseId,baseId))]);
 const occupied=[...bs.map(b=>({tx:b.tx,ty:b.ty,...footprintOf(b.type as BuildingType)})),...os.filter(o=>!o.clearedAt).map(o=>{const tier=Object.values(OBSTACLES.tiers).find(t=>(t.kinds as readonly string[]).includes(o.spriteKey))!;return {tx:o.tx,ty:o.ty,fw:tier.sizeTiles,fh:tier.sizeTiles};})];
 const {min,max}=claimRect(0),fp=footprintOf(BuildingType.Mine);let position:{tx:number;ty:number}|undefined;
 for(let ty=min;ty+fp.fh<=max&&!position;ty++)for(let tx=min;tx+fp.fw<=max;tx++)if(!occupied.some(o=>overlaps({tx,ty,...fp},o))){position={tx,ty};break;}
 if(!position)throw Error('fixture has no Mine site');
 const placement=await app.inject({method:'POST',url:'/base/buildings',cookies:f.cookies,payload:{type:'mine',baseId,...position,idempotencyKey:randomUUID()}});
 expect(placement.statusCode,placement.body).toBe(201);const mine=placement.json().building;
 const [job]=await conn.db.select().from(builderJobs).where(eq(builderJobs.buildingId,mine.id));expect(job?.kind).toBe('build');
 const quota=getMiningQuota(1,[1],0,MINING.EPOCH_RATE_BPS),at=new Date(+job!.finishesAt+Math.ceil(2*MINE_DAY_MS/quota)+1);await time(at);
 const completion=await read(app,f,`?baseId=${baseId}`);expect(completion.statusCode,completion.body).toBe(200);
 expect((await conn.db.select().from(builderJobs).where(eq(builderJobs.id,job!.id)))[0]!.completedAt).not.toBeNull();
 expect(await conn.sql`select initialization_kind,build_job_id,production_started_at=${job!.finishesAt.toISOString()}::timestamptz production_started_at_matches from shards_mine_eras where mine_id=${mine.id}`).toEqual([{initialization_kind:'fresh_scheduled_build',build_job_id:job!.id,production_started_at_matches:true}]);
 // Source materialization is the ordinary core writer, after real HTTP placement
 // and lazy completion. No term, ownership certificate or segment is fabricated.
 await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,baseId,at));
 const parents=await conn.sql`select id,starts_at,ends_at,gross from shards_mine_segments where mine_id=${mine.id} and wallet=${f.wallet} and admission_id is null`;
 expect(parents).toHaveLength(1);expect(parents[0]!.gross).toBe('2');return {mine,job:job!,at,parent:parents[0]!};
}
async function policy(){await conn.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at) values(1,1,1,1,${start.toISOString()})`;}
describe.sequential('prospective roster enrollment in normal gameplay',()=>{
 it('enrolls only after the actual authenticated first base has committed its stable slot and Keep',async()=>{
  const f=await actor(),provider=ownerProvider(),app=await open(provider);
  const response=await read(app,f);expect(response.statusCode,response.body).toBe(200);
  const state=response.json();expect(state.baseId).toEqual(expect.any(String));expect(state.buildings).toEqual(expect.arrayContaining([expect.objectContaining({type:'keep'})]));
  const saved=await baseline(f.wallet);expect(saved).toHaveLength(1);
  expect(saved[0]!.value).toMatchObject({wallet:f.wallet,bases:[{id:state.baseId,owner_wallet:f.wallet,status:'active'}],slots:[{wallet:f.wallet,base_id:state.baseId,slot:1,active:true}]});
  expect(provider.enroll).toHaveBeenCalledWith(f.wallet);expect(state).not.toHaveProperty('miningRosterBaseline');
 });
 it('captures before a real ordinary Mine build and lazy completion, making its first same-day units provable',async()=>{
  await policy();const f=await actor(),provider=ownerProvider(),app=await open(provider),first=await read(app,f);expect(first.statusCode,first.body).toBe(200);
  const captured=await baseline(f.wallet);await time(new Date(+start+1));const source=await mineSource(app,f,first.json().baseId);
  expect(await baseline(f.wallet)).toEqual(captured);const proof=await prefetchPhysicalMineCustody(conn.db,source.parent.id);
  expect(proof.version).toBe(2);if(proof.version!==2)throw Error('baseline interval proof required');expect(proof.custody).toMatchObject({wallet:f.wallet,baseId:first.json().baseId,classification:'registered_free'});
  expect(proof.rosters[0]!.baseline.observedAt<new Date(source.parent.starts_at).toISOString().replace('Z','000Z')).toBe(true);
  expect(proof).toMatchObject({postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
 });
 it('concurrent and repeated first reads retain one baseline and one starter, including after restart',async()=>{
  const f=await actor(),provider=ownerProvider(),app=await open(provider),responses=await Promise.all([read(app,f),read(app,f),read(app,f)]);
  expect(responses.every(r=>r.statusCode===200||r.statusCode===503)).toBe(true);for(const r of responses.filter(r=>r.statusCode===503))expect(r.json().error.code).toBe('MINING_ROSTER_ENROLLMENT_HELD');
  const retry=await read(app,f);expect(retry.statusCode,retry.body).toBe(200);const original=await baseline(f.wallet);expect(original).toHaveLength(1);
  expect(await conn.sql`select id from bases where owner_wallet=${f.wallet}`).toHaveLength(1);expect(await conn.sql`select id from buildings where player_wallet=${f.wallet} and type='keep'`).toHaveLength(1);
  expect(await conn.sql`select id from ledger_transactions where idempotency_key=${'starter:base:'+retry.json().baseId}`).toHaveLength(1);
  await time(new Date(+start+1000));vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reopened=conn.reopen();
  try{const restarted=await open(undefined,reopened.db),response=await read(restarted,f);expect(response.statusCode,response.body).toBe(200);expect(await baseline(f.wallet)).toEqual(original);await restarted.close();servers.splice(servers.indexOf(restarted),1);}finally{await reopened.sql.end();}
 });
 it('does not enroll unauthenticated, failed, HEAD, OPTIONS or unrelated-route requests',async()=>{
  const f=await actor(),provider=ownerProvider(),app=await open(provider);
  expect((await app.inject({method:'GET',url:'/base'})).statusCode).toBe(401);
  expect((await read(app,f,'?baseId=invalid')).statusCode).toBe(400);
  const head=await app.inject({method:'HEAD',url:'/base',cookies:f.cookies});expect(head.statusCode,head.body).toBe(200);expect(head.body).toBe('');
  await app.inject({method:'OPTIONS',url:'/base',cookies:f.cookies});expect((await app.inject({method:'GET',url:'/bases',cookies:f.cookies})).statusCode).toBe(200);
  expect(provider.enroll).not.toHaveBeenCalled();expect(await baseline(f.wallet)).toHaveLength(0);
 });
 it('keeps both rollout flags and an absent owner capability dark without changing the base response',async()=>{
  for(const mode of ['mining-off','multi-off','no-provider']){const f=await actor(),provider=ownerProvider(),app=await open(mode==='no-provider'?undefined:provider);
   vi.stubEnv('PHASE_E_MINING_ENABLED',mode==='mining-off'?'false':'true');vi.stubEnv('MULTI_BASE_ENABLED',mode==='multi-off'?'false':'true');
   const response=await read(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json().buildings).toEqual(expect.arrayContaining([expect.objectContaining({type:'keep'})]));
   expect(provider.enroll).not.toHaveBeenCalled();expect(await baseline(f.wallet)).toHaveLength(0);
  }
 });
 it('maps a real capture barrier conflict once, preserves committed gameplay, and enrolls on retry',async()=>{
  const f=await actor(),owner=ownerProvider();let first=true,attempts=0;
  const provider={enroll:async(wallet:string)=>{attempts++;if(!first)return owner.enroll(wallet);first=false;
   let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
   const writer=conn.sql.begin(async tx=>{await tx`select wallet from players where wallet=${wallet} for update`;ready();await gate;});
   try{await started;await owner.enroll(wallet);}finally{release();await writer;}
  }},app=await open(provider);
  const held=await read(app,f);expect(held.statusCode,held.body).toBe(503);expect(held.json().error.code).toBe('MINING_ROSTER_ENROLLMENT_HELD');expect(attempts).toBe(1);expect(await baseline(f.wallet)).toHaveLength(0);
  const keeps=await conn.sql`select id from buildings where player_wallet=${f.wallet} and type='keep'`;expect(keeps).toHaveLength(1);
  const retry=await read(app,f);expect(retry.statusCode,retry.body).toBe(200);expect(attempts).toBe(2);expect(await baseline(f.wallet)).toHaveLength(1);expect(await conn.sql`select id from buildings where player_wallet=${f.wallet} and type='keep'`).toEqual(keeps);
 });
 it('does not retroactively prove output that completed before first enrollment',async()=>{
  await policy();const f=await actor(),unenrolled=await open(),response=await read(unenrolled,f);expect(response.statusCode,response.body).toBe(200);
  const source=await mineSource(unenrolled,f,response.json().baseId);expect(await baseline(f.wallet)).toHaveLength(0);
  await time(new Date(+source.at+1000));const app=await open(ownerProvider()),enrolled=await read(app,f);expect(enrolled.statusCode,enrolled.body).toBe(200);
  expect(await baseline(f.wallet)).toHaveLength(1);await expect(prefetchPhysicalMineCustody(conn.db,source.parent.id)).rejects.toThrow();
  expect(await conn.sql`select gross,buffer,resolved from shards_mine_segments where id=${source.parent.id}`).toEqual([{gross:'2',buffer:'2',resolved:'0'}]);
 });
 it('uses a non-owner gameplay LOGIN and a separate owner capability without granting baseline forgery',async()=>{
  const f=await actor();let runtime:ReturnType<typeof createDb>|undefined;
  // 2026-10-10: the actual provisioned API runtime LOGIN (fixtures/apiRuntimeLogin.ts), not hand
  // grants on every table: the private-source seals read a direct session_user grant
  // as tampering, and the base read needs the provisioner's function EXECUTE grants.
  const login=await provisionApiRuntimeLogin(conn.sql,'roster_gameplay'),role=login.login;
  try{runtime=createDb(login.url,{max:4});
   expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);
   expect(await runtime.sql`select has_table_privilege(current_user,'mining_roster_baselines','SELECT') r,has_table_privilege(current_user,'mining_roster_baselines','INSERT') w`).toEqual([{r:false,w:false}]);
   const cap=createMiningRosterEnrollmentProvider(conn.db);expect(Object.isFrozen(cap)).toBe(true);expect(Object.keys(cap)).toEqual(['enroll']);
   const app=await open(cap,runtime.db),response=await read(app,f);expect(response.statusCode,response.body).toBe(200);expect(await baseline(f.wallet)).toHaveLength(1);
   await expect(cap.enroll(f.wallet)).resolves.toBeUndefined();await expect(conn.db.transaction(async tx=>createMiningRosterEnrollmentProvider(tx as unknown as Db))).rejects.toThrow();
   const original=await baseline(f.wallet);await conn.sql.unsafe(`grant all on mining_roster_baselines,mining_roster_transactions,mining_roster_events to ${role}`);
   await expect(runtime.sql`insert into mining_roster_baselines(wallet) values(${f.wallet})`).rejects.toThrow('MINING_ROSTER_HISTORY_IMMUTABLE');
   await expect(runtime.sql`update mining_roster_baselines set observed_at=observed_at where wallet=${f.wallet}`).rejects.toThrow('MINING_ROSTER_HISTORY_IMMUTABLE');expect(await baseline(f.wallet)).toEqual(original);
   await app.close();servers.splice(servers.indexOf(app),1);
  }finally{await runtime?.sql.end();await login.close();}
 },120_000);
 it('preserves the successful base response when enrollment pauses after the hook starts',async()=>{
  const f=await actor(),owner=createMiningRosterEnrollmentProvider(conn.db),provider={enroll:vi.fn(async(wallet:string)=>{vi.stubEnv('PHASE_E_MINING_ENABLED','false');await owner.enroll(wallet);})},app=await open(provider);
  const response=await read(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json().buildings).toEqual(expect.arrayContaining([expect.objectContaining({type:'keep'})]));
  expect(provider.enroll).toHaveBeenCalledOnce();expect(await baseline(f.wallet)).toHaveLength(0);
  const repeat=await read(app,f);expect(repeat.statusCode,repeat.body).toBe(200);expect(repeat.json().baseId).toBe(response.json().baseId);expect(provider.enroll).toHaveBeenCalledOnce();
  expect(await conn.sql`select id from ledger_transactions where idempotency_key=${'starter:base:'+response.json().baseId}`).toHaveLength(1);
 });
});
