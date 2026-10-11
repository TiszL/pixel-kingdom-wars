/** Adversarial HTTP acceptance over actual Core installation and signed Seeker
 * fixtures. Corruption cases explicitly model damaged owner storage. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {BASE_OWNERSHIP} from '@shardkeep/shared';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {createAdvancedExpeditionWorkflow,type AdvancedExpeditionWorkflowDependencies} from '../src/game/advancedExpeditionWorkflow';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {createDb,type Db} from '../src/db/client';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions,players,deedOwnershipObservations} from '../src/db/schema';
import {ADMIN_DATABASE_URL} from './db-url';
import {TEST_CONFIG} from './helpers';

let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,bank:Awaited<ReturnType<typeof createMiningTermFixture>>,now:Date,cookies:Record<string,string>;
const apps:FastifyInstance[]=[],flags=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'];
beforeEach(async()=>{
 // 2026-10-10: 0256/0279 refuse a settlement cutoff later than Postgres clock_timestamp(), which no test can fake, so this
 // calendar sits in the real past (the 790271776 convention) and the berth and Lodge complete an hour before it.
 now=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000);
 f=await vehicleBurnDatabase('survey_balloon',1,{},{completedAt:new Date(+now-3600000)});f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const lodge=randomUUID();await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${lodge},${f.actor},${f.baseId},'lodge',8,2)`;
 await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${lodge},'build',${new Date(+now-7200000).toISOString()},${new Date(+now-3600000).toISOString()},${new Date(+now-3600000).toISOString()})`;
 await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},'rough_prism',1000,0)`;
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});syncBank();cookies=await session(f.actor);
},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
function syncBank(){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now/1000)),32);}
function time(at:Date){now=at;vi.setSystemTime(now);}
async function session(wallet:string){const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(+now+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
function capability(extra:AdvancedExpeditionWorkflowDependencies={}){return createAdvancedExpeditionWorkflow(f.conn.db,{term:{connect:bank.connect,policy:bank.policy},...extra});}
async function open(provider:ReturnType<typeof capability>,db:Db=f.conn.db){vi.stubEnv('MULTI_BASE_ENABLED','false');const app=await buildApp(TEST_CONFIG,db,{advancedExpeditionWorkflowProvider:provider});apps.push(app);await app.ready();for(const flag of flags)vi.stubEnv(flag,'true');return app;}
const command=()=>({idempotencyKey:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'coastal_survey',policyVersion:1});
const post=(app:FastifyInstance,url:string,payload:Record<string,unknown>,auth=cookies)=>app.inject({method:'POST',url,cookies:auth,payload});
const history=(app:FastifyInstance,key:string,auth=cookies)=>app.inject({url:'/advanced-expeditions/by-key/'+key,cookies:auth});
// This helper sends a new key through the normal committed-result capability.
async function depart(app:FastifyInstance,input=command()){const result=await post(app,'/advanced-expeditions',input);expect(result.statusCode,result.body).toBe(201);return {input,receipt:result.json().receipt};}
async function money(){return {stock:await f.conn.sql`select base_id,resource_id,available,reserved from resource_stocks order by base_id,resource_id`,returns:await f.conn.sql`select * from advanced_expedition_returns order by id`,entries:await f.conn.sql`select * from advanced_expedition_entries order by return_id,bucket`,flight:await f.conn.sql`select * from advanced_expedition_inflight order by expedition_id`};}
async function noAdmission(){expect(await f.conn.sql`select id from advanced_expeditions`).toHaveLength(0);expect(await f.conn.sql`select id from resource_stock_operations`).toHaveLength(0);expect(await f.conn.sql`select term_id from expedition_term_snapshots`).toHaveLength(0);}
async function deed(){const mint=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:now,status:'owned',source:'rpc-finalized',auditHash:randomUUID()});return mint;}
async function paid(kind='valid'){
 const a=await createSeekerRealmAccessFixture(),wallet=new PublicKey(f.actor),realm=0,expiry=BigInt(+now/1000)+(kind==='expired'?0n:60n);
 const BN=a.accessModel.expires_at.constructor as new(v:string)=>typeof a.accessModel.expires_at;
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),wallet.toBuffer(),Buffer.of(realm)],a.programId);
 Object.assign(a.accessModel,{wallet,realm,bump,expires_at:new BN(String(expiry))});a.rows[3]!.address=address;await a.encode('access');a.rows[4]!.data.writeBigInt64LE(BigInt(+now/1000),32);
 if(kind!=='cross-source')bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:a.genesis,programId:a.programId});syncBank();
 if(kind==='failed')a.rpc.getGenesisHash=async()=>{throw Error('Actual access transport failed');};
 return a;
}

it('collects for a transferred buyer while retaining providerless seller history without buyer identity',async()=>{
 // 2026-10-10: since 0256 (790271776) a known transfer settles due work for the seller first (D-153.103: due work is
 // done, an unfinished trip follows the base), so the buyer's trip must still be away at the transfer; it lands after.
 const app=await open(capability()),{input,receipt}=await depart(app);time(new Date(Date.parse(receipt.returnsAt)-1));const mint=await deed(),buyer=Keypair.generate().publicKey.toBase58();
 await f.conn.db.insert(players).values({wallet:buyer});await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:+now});
 time(new Date(receipt.returnsAt));const buyerAuth=await session(buyer),offline=await open(createAdvancedExpeditionWorkflow(f.conn.db));for(const flag of flags)vi.stubEnv(flag,'false');
 expect((await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId})).statusCode).toBe(404);
 const collected=await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId},buyerAuth);expect(collected.statusCode,collected.body).toBe(200);expect(collected.json()).toEqual({baseId:f.baseId,serverNow:now.toISOString(),returned:1});
 const saved=await history(offline,input.idempotencyKey);expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().return.completedTotal).toBe('1');expect(saved.body).not.toContain(buyer);
 expect((await post(offline,'/advanced-expeditions',input)).json()).toEqual(saved.json());expect((await history(offline,input.idempotencyKey,buyerAuth)).json()).toMatchObject({status:'unknown',receipt:null,return:null});
 expect((await f.conn.sql`select custody_wallet from advanced_expedition_returns`)[0]!.custody_wallet).toBe(buyer);expect((await f.conn.sql`select actor_wallet from advanced_expeditions`)[0]!.actor_wallet).toBe(f.actor);
 expect((await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId},buyerAuth)).json().returned).toBe(0);
});

it('rolls back collection when the real player lock outlasts its paid deed proof',async()=>{
 const app=await open(capability()),{receipt}=await depart(app);time(new Date(receipt.returnsAt));await deed();const before=await money(),blocker=f.conn.reopen();
 let ready!:()=>void,release!:()=>void,pid=0;const start=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const holder=blocker.sql.begin(async tx=>{await tx`select wallet from players where wallet=${f.actor} for update`;pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;ready();await gate;});let pending:ReturnType<typeof post>|undefined;
 try{await start;pending=post(app,'/advanced-expeditions/collect',{baseId:f.baseId});const resultPromise=Promise.resolve(pending);
  await expect.poll(async()=>(await f.conn.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and query like '%players%') waiting`)[0]!.waiting).toBe(true);
  time(new Date(+now+BASE_OWNERSHIP.mutationFreshnessMs+1));release();const result=await resultPromise;expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('DEED_AUTHORITY_UNAVAILABLE');expect(await money()).toEqual(before);
 }finally{release();await holder;await pending;await blocker.sql.end();}
});

it('uses authentic paid coverage once and preserves expired paid earnings during paused offline replay',async()=>{
 const a=await paid(),app=await open(capability({access:{connect:()=>a.rpc,trust:a.trust}})),input={...command(),routeId:'paid_frostveil'},{receipt}=await depart(app,input);
 expect((await f.conn.sql`select access_evidence from advanced_expeditions`)[0]!.access_evidence.wallet).toBe(f.actor);time(new Date(receipt.returnsAt));expect(+now).toBeGreaterThan(Number(a.accessModel.expires_at.toString())*1000);
 const offline=await open(createAdvancedExpeditionWorkflow(f.conn.db));vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');expect((await history(offline,input.idempotencyKey)).json().return).toBeNull();expect((await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId})).json().returned).toBe(1);
 const original=await history(offline,input.idempotencyKey);expect(original.statusCode,original.body).toBe(200);expect((await post(offline,'/advanced-expeditions',input)).json()).toEqual(original.json());
});

it.each(['failed','expired','cross-source'])('refuses %s genuine paid access without admission or provision spending',async kind=>{
 const a=await paid(kind),app=await open(capability({access:{connect:()=>a.rpc,trust:a.trust}})),before=await money(),result=await post(app,'/advanced-expeditions',{...command(),routeId:'paid_frostveil'});
 expect(result.statusCode,result.body).toBe(kind==='expired'?409:503);await noAdmission();expect(await money()).toEqual(before);
});

it('holds a real term transport outage without committing home, source, provisions or flight',async()=>{
 const app=await open(capability({term:{policy:bank.policy,connect:()=>{throw Error('Term RPC offline');}}})),before=await money(),result=await post(app,'/advanced-expeditions',command());expect(result.statusCode,result.body).toBeGreaterThanOrEqual(500);await noAdmission();expect(await money()).toEqual(before);expect(await f.conn.sql`select * from expedition_free_homes`).toHaveLength(0);
});

it.each(['orphan-flight','supply','return'])('holds %s corrupted original proof and never adds another stock credit or completed use',async kind=>{
 const app=await open(capability()),{input,receipt}=await depart(app);time(new Date(receipt.returnsAt));if(kind==='return')expect((await post(app,'/advanced-expeditions/collect',{baseId:f.baseId})).json().returned).toBe(1);
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;if(kind==='orphan-flight')await tx`delete from advanced_expedition_inflight`;if(kind==='supply')await tx`delete from resource_stock_entries`;if(kind==='return')await tx`delete from advanced_expedition_entries where bucket='issued'`;});const before=await money();
 const read=await history(app,input.idempotencyKey);expect(read.statusCode,read.body).toBeGreaterThanOrEqual(500);
 const replay=await post(app,'/advanced-expeditions',input);expect(replay.statusCode,replay.body).toBeGreaterThanOrEqual(500);
 if(kind!=='return'){const result=await post(app,'/advanced-expeditions/collect',{baseId:f.baseId});expect(result.statusCode,result.body).toBeGreaterThanOrEqual(500);}expect(await money()).toEqual(before);
});

it('keeps all advanced tables private from the authenticated HTTP runtime role',async()=>{
 const role='advanced_http_'+randomUUID().replaceAll('-',''),password=randomUUID(),provider=capability();let runtime:ReturnType<typeof createDb>|undefined;
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant select on sessions,players,alpha_access to ${role}`);const [database]=await f.conn.sql`select current_database() name`;const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  for(const table of ['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_supplies','advanced_expedition_returns','advanced_expedition_entries','advanced_vehicle_installations'])await expect(runtime.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});
  const app=await open(provider,runtime.db),{input,receipt}=await depart(app);time(new Date(receipt.returnsAt));const result=await post(app,'/advanced-expeditions/collect',{baseId:f.baseId});expect(result.statusCode,result.body).toBe(200);expect(result.json().returned).toBe(1);expect((await history(app,input.idempotencyKey)).json().return.completedTotal).toBe('1');
  await expect(createAdvancedExpeditionWorkflow(runtime.db).read(f.actor,input.idempotencyKey)).rejects.toMatchObject({code:'ADVANCED_WORKFLOW_OWNER'});await app.close();apps.splice(apps.indexOf(app),1);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('checks every strict parent flag before consulting term or paid access transport',async()=>{
 const a=await paid(),termConnect=vi.fn(bank.connect),accessConnect=vi.fn(()=>a.rpc),app=await open(capability({term:{policy:bank.policy,connect:termConnect},access:{trust:a.trust,connect:accessConnect}}));
 for(const flag of flags){vi.stubEnv(flag,'false');const result=await post(app,'/advanced-expeditions',{...command(),routeId:'paid_frostveil'});expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('ADVANCED_DISABLED');vi.stubEnv(flag,'true');}expect(termConnect).not.toHaveBeenCalled();expect(accessConnect).not.toHaveBeenCalled();await noAdmission();
});

it('owns copied term and access policy keys before later caller mutations',async()=>{
 const a=await paid(),policy={...bank.policy,deployment:{...bank.policy.deployment}},trust={...a.trust};
 for(const name of ['programId','config','mint','prizeOwner','prizeAta','genesisHash'] as const)policy[name]=new PublicKey(policy[name].toBytes());
 trust.programId=new PublicKey(trust.programId.toBytes());trust.developer=new PublicKey(trust.developer.toBytes());trust.upgradeAuthority=new PublicKey(trust.upgradeAuthority!.toBytes());
 const provider=capability({term:{policy,connect:bank.connect},access:{trust,connect:()=>a.rpc}});
 for(const name of ['programId','config','mint','prizeOwner','prizeAta','genesisHash'] as const)Reflect.set(policy[name],'_bn',Reflect.get(Keypair.generate().publicKey,'_bn'));
 for(const key of [trust.programId,trust.developer,trust.upgradeAuthority])Reflect.set(key,'_bn',Reflect.get(Keypair.generate().publicKey,'_bn'));
 policy.deployment.programDataSha256='0'.repeat(64);trust.reviewedProgramDataSha256='0'.repeat(64);trust.expectedGenesisHash=Keypair.generate().publicKey.toBase58();
 const app=await open(provider);await depart(app,{...command(),routeId:'paid_frostveil'});expect(await f.conn.sql`select id from advanced_expeditions`).toHaveLength(1);
});
