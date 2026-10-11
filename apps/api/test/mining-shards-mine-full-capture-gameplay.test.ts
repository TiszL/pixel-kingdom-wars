/** Fully saturated original Mine output can be captured independently of current operating admission. */
import {randomUUID} from 'node:crypto';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {createDb,type Db} from '../src/db/client';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {admitPhysicalMineTaxSources} from '../src/mining/shardsTaxMineSources';
import {readHistoricalMineTaxSource} from '../src/mining/shardsTaxMineRecoveryHistory';
import {ADMIN_DATABASE_URL} from './db-url';
import {eq} from 'drizzle-orm';
import type {FastifyInstance} from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import {buildApp,type AppDeps} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {bases,baseSlots,buildings,mineAccrualStates,sessions} from '../src/db/schema';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {createPhysicalMineRecoveryProvider} from '../src/mining/shardsTaxMineRecoveryProvider';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
import {createTestPlayer,TEST_CONFIG} from './helpers';
let conn:ReturnType<typeof resourceClaimsDatabase>,fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
const servers:FastifyInstance[]=[];
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);
 vi.stubEnv('FREE_ONBOARDING','true');vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 conn=resourceClaimsDatabase();await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);
},120000);
afterEach(async()=>{await Promise.all(servers.splice(0).map(app=>app.close()));vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function cookies(wallet:string){const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
async function unmaterialized(anchor=fixture.anchor){
 await fixture.rosterClock('2035-01-01T00:00:00Z');const {wallet}=await createTestPlayer(conn.db);
 const [base]=await conn.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();await conn.db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});
 const [mine]=await conn.db.insert(buildings).values({playerWallet:wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();await conn.db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:anchor});
 await initializeMiningRosterHistory(conn.db,wallet);await fixture.rosterClock(fixture.verified.toISOString());
 const gross=BigInt(fixture.quota),tax=(gross-4n)*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
 return {wallet,base:base!,mine:mine!,cookies:await cookies(wallet),net:gross-tax};
}
async function open(overrides:AppDeps={},db:Db=conn.db){
 const fullOnly=createPhysicalMineRecoveryProvider(conn.db,{...fixture.deps,clock:()=>new Date()});
 // This accepted bank proves full-only compatibility; new ordinary capability
 // and real round2 partial earnings have their own integration suite.
 vi.stubEnv('MULTI_BASE_ENABLED','false');try{const app=await buildApp(TEST_CONFIG,db,{physicalMineRecoveryProvider:{recover:fullOnly.recover,captureFull:fullOnly.captureFull!},...overrides});servers.push(app);await app.ready();return app;}finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}
}
async function time(at:Date){vi.setSystemTime(at);await fixture.rosterClock(at.toISOString());}
async function currentBank(){const old=fixture.bank.original;return createMiningTermFixture({day:'2035-01-16',round:2n,firstOperatingStart:BigInt(Date.parse('2035-01-01T00:00:00Z')/1000),genesisHash:old.policy.genesisHash,programId:old.policy.programId,mint:old.policy.mint,prizeOwner:old.policy.prizeOwner,programData:old.programData,programDataAddress:old.programDataAddress,upgradeAuthority:old.upgradeAuthority});}
const collect=(app:FastifyInstance,f:Awaited<ReturnType<typeof unmaterialized>>)=>app.inject({method:'POST',url:'/mine/collect',payload:{baseId:f.base.id},cookies:f.cookies});
const footprint=async(f:Awaited<ReturnType<typeof unmaterialized>>)=>({
 state:await conn.db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId,f.mine.id)),
 segments:await conn.sql`select to_jsonb(s) value from shards_mine_segments s where mine_id=${f.mine.id} order by id`,
 headers:await conn.sql`select r.parent_id,r.custody from shards_mine_resolutions r join shards_mine_segments s on s.id=r.parent_id where s.mine_id=${f.mine.id} order by r.parent_id`,
 terms:await conn.sql`select t.certificate from shards_mine_resolution_terms t join shards_mine_segments s on s.id=t.segment_id where s.mine_id=${f.mine.id} order by s.first_unit`,
 admissions:await conn.sql`select id from shards_mine_admissions where base_id=${f.base.id}`,heads:await conn.sql`select admission_id from shards_mine_heads where mine_id=${f.mine.id}`,
 ledger:await conn.sql`select id from ledger_transactions where type='mine.collect' and metadata->>'baseId'=${f.base.id}`,assessments:await conn.sql`select to_jsonb(a) value from shards_tax_assessments a where wallet=${f.wallet}`,
});
describe.sequential('normal collection captures only full original Mine output',()=>{
 it('collects saturated unmaterialized history through the actual owner capability with no current provider or invented admission',async()=>{
  const f=await unmaterialized(),app=await open();expect((await footprint(f)).segments).toHaveLength(0);
  const response=await collect(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:f.net.toString()});
  const saved=await footprint(f);expect(saved.headers).toHaveLength(1);expect(saved.terms.map(t=>t.certificate.snapshot.source.round)).toEqual(['0','1']);expect(saved.ledger).toHaveLength(1);expect(saved.admissions).toHaveLength(0);expect(saved.heads).toHaveLength(0);
  expect((await collect(app,f)).json()).toEqual({amount:'0'});expect((await footprint(f)).ledger).toEqual(saved.ledger);
 });
 it('uses the same full capture when the actual current-term connection is unavailable',async()=>{
  const f=await unmaterialized(),current=await currentBank(),connect=vi.fn(()=>{throw Error('current source outage');}),app=await open({physicalMineSourceProvider:{policy:current.policy,connect}});
  const response=await collect(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:f.net.toString()});expect(connect).toHaveBeenCalledOnce();
  const saved=await footprint(f);expect(saved.ledger).toHaveLength(1);expect(saved.headers).toHaveLength(1);expect(saved.admissions).toHaveLength(0);expect(saved.heads).toHaveLength(0);
 });
 it('keeps partially filled output held and preserves its fractional clock across repeated taps',async()=>{
  const f=await unmaterialized(new Date(+fixture.verified-Math.floor(fixture.unit*7/4))),app=await open(),before=await footprint(f);
  for(let i=0;i<2;i++){const response=await collect(app,f);expect(response.statusCode,response.body).toBe(503);expect(response.json().error.code).toBe('SHARDS_SOURCE_HELD');}
  const after=await footprint(f);expect(after.state).toEqual(before.state);expect(after.segments).toHaveLength(0);expect(after.ledger).toHaveLength(0);expect(after.admissions).toHaveLength(0);
 });
 it('captures the full missing Mine without resetting a covered sibling fractional clock or empty taps',async()=>{
  const f=await unmaterialized(fixture.verified),current=await currentBank(),reader=await prefetchExpeditionTermReader(current.connect,current.policy);
  await admitPhysicalMineTaxSources(conn.db,f.wallet,{baseId:f.base.id,idempotencyKey:randomUUID()},{baseId:f.base.id,assertAuthority:async(tx,w,b)=>{await assertFreshLockedBaseAuthority(tx,w,b);}},{reader,clock:()=>fixture.verified});
  const before=(await footprint(f)).state;await time(new Date(+fixture.verified+Math.floor(fixture.unit*3/4)));
  const [missing]=await conn.db.insert(buildings).values({playerWallet:f.wallet,baseId:f.base.id,type:'mine',level:1,tx:3,ty:3}).returning();await conn.db.insert(mineAccrualStates).values({mineBuildingId:missing!.id,lastAccrualAt:fixture.anchor});
  const app=await open(),response=await collect(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:f.net.toString()});expect((await footprint(f)).state).toEqual(before);
  await time(new Date(+fixture.verified+Math.floor(fixture.unit*9/10)));expect((await collect(app,f)).json()).toEqual({amount:'0'});expect((await footprint(f)).state).toEqual(before);
  await time(new Date(+fixture.verified+Math.ceil(fixture.unit*5/4)));expect((await collect(app,f)).json()).toEqual({amount:'1'});
  expect(await conn.sql`select id from shards_mine_admissions where base_id=${f.base.id}`).toHaveLength(1);expect(await conn.sql`select admission_id from shards_mine_heads where mine_id=${missing!.id}`).toHaveLength(0);
 });
 it('retains one saturated capture through historical outage and retries without tax or duplicate issuance',async()=>{
  const f=await unmaterialized();let unavailable=true;
  const provider=createPhysicalMineRecoveryProvider(conn.db,{...fixture.deps,historicalTerm:{...fixture.deps.historicalTerm,connect:signal=>{if(unavailable)throw Error('historical archive outage');return fixture.deps.historicalTerm.connect(signal);}},clock:()=>new Date()});
  const app=await open({physicalMineRecoveryProvider:provider}),response=await collect(app,f);expect(response.statusCode,response.body).toBe(503);expect(response.json().error.code).toBe('SHARDS_MINE_RESOLUTION_HELD');
  const held=await footprint(f);expect(held.state[0]!.accruedShards).toBe(BigInt(fixture.quota));expect(held.state[0]!.lastAccrualAt).toEqual(fixture.verified);expect(held.headers).toHaveLength(0);expect(held.ledger).toHaveLength(0);expect(held.assessments).toHaveLength(0);expect(held.heads).toHaveLength(0);
  const again=await collect(app,f);expect(again.statusCode,again.body).toBe(503);expect(await footprint(f)).toEqual(held);
  unavailable=false;const retry=await collect(app,f);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual({amount:f.net.toString()});const paid=await footprint(f);expect(paid.headers).toHaveLength(1);expect(paid.ledger).toHaveLength(1);expect(paid.admissions).toHaveLength(0);
  expect((await collect(app,f)).json()).toEqual({amount:'0'});expect((await footprint(f)).ledger).toEqual(paid.ledger);
 });
 it('waits until the millisecond after a full buffer final completion before historical repair',async()=>{
  const f=await unmaterialized(),at=new Date(+fixture.anchor+fixture.quota*fixture.unit);await time(at);f.cookies=await cookies(f.wallet);
  const app=await open(),response=await collect(app,f);expect(response.statusCode,response.body).toBe(503);expect(response.json().error.code).toBe('SHARDS_SOURCE_HELD');
  const held=await footprint(f);expect(held.state[0]!.accruedShards).toBe(BigInt(fixture.quota));expect(held.headers).toHaveLength(0);expect(held.ledger).toHaveLength(0);
  await time(new Date(+at+1));const retry=await collect(app,f);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual({amount:f.net.toString()});expect((await footprint(f)).ledger).toHaveLength(1);
 });
 it('rejects the old base caller after transfer before capturing any original quantity',async()=>{
  const f=await unmaterialized(),buyer=await createTestPlayer(conn.db);await conn.sql.begin(async tx=>{await tx`delete from base_slots where base_id=${f.base.id}`;await tx`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;await tx`insert into base_slots(wallet,slot,base_id) values(${buyer.wallet},1,${f.base.id})`;});
  const before=await footprint(f),app=await open(),response=await collect(app,f);expect([403,404]).toContain(response.statusCode);expect(await footprint(f)).toEqual(before);
 });
 it('converges concurrent capture and recovery attempts to one original graph and one collection',async()=>{
  const f=await unmaterialized(),app=await open(),responses=await Promise.all([collect(app,f),collect(app,f)]);
  for(const response of responses)expect([200,503],response.body).toContain(response.statusCode);
  const retry=await collect(app,f);expect(retry.statusCode,retry.body).toBe(200);
  const total=[...responses,retry].filter(r=>r.statusCode===200).reduce((n,r)=>n+BigInt(r.json().amount),0n);expect(total).toBe(f.net);
  const saved=await footprint(f);expect(saved.headers).toHaveLength(1);expect(saved.terms).toHaveLength(2);expect(saved.ledger).toHaveLength(1);expect(saved.admissions).toHaveLength(0);
 });
 it('keeps committed historical collection readable after paused providerless reconnect',async()=>{
  const f=await unmaterialized(),app=await open(),response=await collect(app,f);expect(response.statusCode,response.body).toBe(200);const before=await footprint(f);
  const reopened=conn.reopen();vi.stubEnv('PHASE_E_MINING_ENABLED','false');try{const restarted=await open({physicalMineRecoveryProvider:null},reopened.db),retry=await collect(restarted,f);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual({amount:'0'});
   const children=await conn.sql`select t.segment_id from shards_mine_resolution_terms t join shards_mine_segments s on s.id=t.segment_id where s.mine_id=${f.mine.id}`;
   for(const child of children)await expect(readHistoricalMineTaxSource(reopened.db,child.segment_id)).resolves.toMatchObject({postingAuthorized:false});expect(await footprint(f)).toEqual(before);
   await restarted.close();servers.splice(servers.indexOf(restarted),1);
  }finally{await reopened.sql.end();}
 });

 it('requires the actual table-owner connection even when a non-owner LOGIN constructs the server capability',async()=>{
  const f=await unmaterialized(),before=await footprint(f),role='mine_full_capture_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{const [database]=await conn.sql`select current_database() name`;await conn.sql.unsafe(`grant connect on database ${database!.name} to ${role};grant usage on schema public to ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:2});expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);
   const cap=createPhysicalMineRecoveryProvider(runtime.db,fixture.deps);await expect(cap.captureFull!(f.wallet,f.base.id)).rejects.toMatchObject({code:'SHARDS_MINE_CAPTURE_HELD'});expect(await footprint(f)).toEqual(before);
  }finally{await runtime?.sql.end();await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });

 it('rolls back an owner capture paused after locked preparation, then retries without losing original quantity',async()=>{
  const f=await unmaterialized(),before=await footprint(f),eras=await conn.sql`select mine_id from shards_mine_eras where base_id=${f.base.id}`;let pause=true;
  const cap=createPhysicalMineRecoveryProvider(conn.db,{...fixture.deps,clock:()=>{if(pause)vi.stubEnv('PHASE_E_MINING_ENABLED','false');return new Date();}});
  await expect(cap.captureFull!(f.wallet,f.base.id)).rejects.toMatchObject({code:'PHASE_E_DISABLED'});expect(await footprint(f)).toEqual(before);expect(await conn.sql`select mine_id from shards_mine_eras where base_id=${f.base.id}`).toEqual(eras);
  pause=false;vi.stubEnv('PHASE_E_MINING_ENABLED','true');await expect(cap.captureFull!(f.wallet,f.base.id)).resolves.toBeUndefined();
  const after=await footprint(f);expect(after.state[0]!.accruedShards).toBe(BigInt(fixture.quota));expect(after.segments.reduce((sum,row)=>sum+BigInt(row.value.buffer),0n)).toBe(BigInt(fixture.quota));expect(after.admissions).toHaveLength(0);expect(after.ledger).toHaveLength(0);
 });
 it('refuses actual provenance contention from an independent connection and captures only after release',async()=>{
  const f=await unmaterialized(),before=await footprint(f),cap=createPhysicalMineRecoveryProvider(conn.db,fixture.deps),other=conn.reopen();
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=other.sql.begin(async tx=>{await tx`select mine_building_id from mine_accrual_states where mine_building_id=${f.mine.id} for update`;ready();await gate;});
  try{await started;await expect(cap.captureFull!(f.wallet,f.base.id)).rejects.toMatchObject({code:'SHARDS_MINE_CAPTURE_HELD'});expect(await footprint(f)).toEqual(before);}finally{release();await writer;await other.sql.end();}
  await expect(cap.captureFull!(f.wallet,f.base.id)).resolves.toBeUndefined();const after=await footprint(f);expect(after.state[0]!.accruedShards).toBe(BigInt(fixture.quota));expect(after.ledger).toHaveLength(0);expect(after.admissions).toHaveLength(0);
 });

});
