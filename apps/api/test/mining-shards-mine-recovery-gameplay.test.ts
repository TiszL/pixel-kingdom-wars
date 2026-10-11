/** Normal authenticated collection repairs private original provenance before
 * spending it. The API and owner verifier use separate database roles below. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import type {FastifyInstance} from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {buildApp,type AppDeps} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createDb,type Db} from '../src/db/client';
import {bases,baseSlots,buildings,mineAccrualStates,sessions} from '../src/db/schema';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {reanchorBaseMineAccrual} from '../src/game/baseMining';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {admitPhysicalMineTaxSources,physicalMinesNeedingTaxSource} from '../src/mining/shardsTaxMineSources';
import {resolvePhysicalMineTaxSource} from '../src/mining/shardsTaxMineResolution';
import {createPhysicalMineRecoveryProvider} from '../src/mining/shardsTaxMineRecoveryProvider';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
import {createTestPlayer,TEST_CONFIG} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
let conn:ReturnType<typeof resourceClaimsDatabase>,fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
let current:Awaited<ReturnType<typeof createMiningTermFixture>>;
const servers:FastifyInstance[]=[];
type Recovery={recover(segmentId:string):Promise<void>};
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);
 vi.stubEnv('FREE_ONBOARDING','true');vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 conn=resourceClaimsDatabase();await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);
 const old=fixture.bank.original;
 current=await createMiningTermFixture({day:'2035-01-16',round:2n,firstOperatingStart:BigInt(Date.parse('2035-01-01T00:00:00Z')/1000),
  genesisHash:old.policy.genesisHash,programId:old.policy.programId,mint:old.policy.mint,prizeOwner:old.policy.prizeOwner,
  programData:old.programData,programDataAddress:old.programDataAddress,upgradeAuthority:old.upgradeAuthority});
},120000);
afterEach(async()=>{await Promise.all(servers.splice(0).map(app=>app.close()));vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function cookies(wallet:string){const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
async function open(recovery?:Recovery,db:Db=conn.db,withCurrent=true){
 const currentConnect=vi.fn((signal:AbortSignal)=>current.connect(signal));
 // Startup's separate roster initialization is outside this route fixture.
 vi.stubEnv('MULTI_BASE_ENABLED','false');
 try{
  const deps:AppDeps&{physicalMineRecoveryProvider?:Recovery}={...(recovery?{physicalMineRecoveryProvider:recovery}:{}),
   ...(withCurrent?{physicalMineSourceProvider:{policy:current.policy,connect:currentConnect}}:{})};
  const app=await buildApp(TEST_CONFIG,db,deps);servers.push(app);await app.ready();return {app,currentConnect};
 }finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}
}
const privateRecovery=()=>{const source=createPhysicalMineRecoveryProvider(conn.db,fixture.deps);return {recover:vi.fn(source.recover)};};
async function admit(wallet:string,baseId:string,at=fixture.verified){
 const reader=await prefetchExpeditionTermReader(current.connect,current.policy);
 return admitPhysicalMineTaxSources(conn.db,wallet,{baseId,idempotencyKey:randomUUID()},{baseId,assertAuthority:async(tx,w,b)=>{await assertFreshLockedBaseAuthority(tx,w,b);}},{reader,clock:()=>at});
}
async function prepared(){
 const f=await fixture.createSource();await admit(f.wallet,f.base.id);
 const parents=await conn.sql`select id from shards_mine_segments where mine_id=${f.mine.id} and wallet is not null and admission_id is null and recovery_parent_id is null and buffer>0 order by starts_at,id`;
 expect(parents).toHaveLength(2);expect(await physicalMinesNeedingTaxSource(conn.db,f.wallet,f.base.id,fixture.verified)).toEqual([]);
 const gross=BigInt(fixture.quota),tax=(gross-4n)*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
 return {...f,parents,net:gross-tax,cookies:await cookies(f.wallet)};
}
async function unmaterialized(options:{anchor?:Date;baselineAt?:string}={}){
 await fixture.rosterClock(options.baselineAt??'2035-01-01T00:00:00Z');const {wallet}=await createTestPlayer(conn.db);
 const [base]=await conn.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
 await conn.db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});
 const [mine]=await conn.db.insert(buildings).values({playerWallet:wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
 await conn.db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:options.anchor??fixture.anchor});
 await initializeMiningRosterHistory(conn.db,wallet);await fixture.rosterClock(fixture.verified.toISOString());
 const gross=BigInt(fixture.quota),tax=(gross-4n)*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
 return {wallet,base:base!,mine:mine!,cookies:await cookies(wallet),net:gross-tax};
}
async function time(at:Date){vi.setSystemTime(at);current.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+at/1000)),32);await fixture.rosterClock(at.toISOString());}
type Source=Awaited<ReturnType<typeof prepared>>;
const collect=(app:FastifyInstance,f:Pick<Source,'base'|'cookies'>)=>app.inject({method:'POST',url:'/mine/collect',payload:{baseId:f.base.id},cookies:f.cookies});
const footprint=async(f:Pick<Source,'base'|'mine'|'wallet'>)=>({
 segments:await conn.sql`select to_jsonb(s) value from shards_mine_segments s where mine_id=${f.mine.id} order by id`,
 headers:await conn.sql`select to_jsonb(r) value from shards_mine_resolutions r join shards_mine_segments s on s.id=r.parent_id where s.mine_id=${f.mine.id} order by parent_id`,
 terms:await conn.sql`select to_jsonb(t) value from shards_mine_resolution_terms t join shards_mine_segments s on s.id=t.segment_id where s.mine_id=${f.mine.id} order by segment_id`,
 state:await conn.sql`select to_jsonb(s) value from mine_accrual_states s where mine_building_id=${f.mine.id}`,
 heads:await conn.sql`select to_jsonb(h) value from shards_mine_heads h where mine_id=${f.mine.id}`,
 assessments:await conn.sql`select to_jsonb(a) value from shards_tax_assessments a where wallet=${f.wallet} order by wallet_sequence`,
 ledger:await conn.sql`select to_jsonb(t) value from ledger_transactions t where metadata->>'baseId'=${f.base.id} order by id`,
 accounts:await conn.sql`select to_jsonb(a) value from accounts a where base_id=${f.base.id} or kind in ('shard_genesis','shards_tax_escrow') order by id`,
});
describe.sequential('normal collection of privately recovered original Mine output',()=>{
 it('repairs old closed-day parents even with a valid current head, without asking current winners or admitting again',async()=>{
  const f=await prepared(),recovery=privateRecovery(),{app,currentConnect}=await open(recovery),before=await footprint(f);
  const response=await collect(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:f.net.toString()});
  expect(recovery.recover.mock.calls.map(([id])=>id)).toEqual(f.parents.map(p=>p.id));expect(currentConnect).not.toHaveBeenCalled();
  const after=await footprint(f);expect(after.heads).toEqual(before.heads);expect(after.headers).toHaveLength(2);
  expect(after.assessments).toHaveLength(3);expect(after.assessments.every(r=>r.value.receipt.version===2&&r.value.wallet===f.wallet)).toBe(true);
  expect((await collect(app,f)).json()).toEqual({amount:'0'});expect(recovery.recover).toHaveBeenCalledTimes(2);
 });
 it('keeps the original source graph and money unchanged when the actual historical provider fails',async()=>{
  const f=await prepared(),before=await footprint(f);
  const recover=vi.fn(async(id:string)=>{await resolvePhysicalMineTaxSource(conn.db,id,{...fixture.deps,historicalTerm:{...fixture.deps.historicalTerm,connect:()=>{throw Error('fixture archive outage');}}});});
  const {app,currentConnect}=await open({recover});const response=await collect(app,f);
  expect(response.statusCode,response.body).toBe(503);expect(recover).toHaveBeenCalledOnce();expect(currentConnect).not.toHaveBeenCalled();expect(await footprint(f)).toEqual(before);
 });
 it('does not send an interval ending exactly now to the private verifier or mint while custody is unclosed',async()=>{
  await fixture.rosterClock('2035-01-15T00:00:00Z');const {wallet}=await createTestPlayer(conn.db);
  const [base]=await conn.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
  await conn.db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});
  const [mine]=await conn.db.insert(buildings).values({playerWallet:wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
  await conn.db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:new Date(+fixture.verified-2*fixture.unit)});
  await initializeMiningRosterHistory(conn.db,wallet);await fixture.rosterClock(fixture.verified.toISOString());
  await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,base!.id,fixture.verified));await admit(wallet,base!.id);
  const f={wallet,base:base!,mine:mine!,cookies:await cookies(wallet)},before=await footprint(f),recovery=privateRecovery(),{app}=await open(recovery);
  const response=await collect(app,f);expect(response.statusCode,response.body).toBe(503);expect(recovery.recover).not.toHaveBeenCalled();expect(await footprint(f)).toEqual(before);
 });
 it('concurrent requests converge on one original graph and one issuance after any retryable provenance hold',async()=>{
  const f=await prepared(),recovery=privateRecovery(),{app}=await open(recovery);
  const responses=await Promise.all([collect(app,f),collect(app,f)]);
  expect(responses.every(r=>r.statusCode===200||r.statusCode===503)).toBe(true);
  const retry=await collect(app,f);expect(retry.statusCode,retry.body).toBe(200);
  const amount=[...responses,retry].reduce((n,r)=>n+(r.statusCode===200?BigInt(r.json().amount):0n),0n);expect(amount).toBe(f.net);
  const saved=await footprint(f);expect(saved.headers).toHaveLength(2);expect(saved.assessments).toHaveLength(3);expect(saved.ledger).toHaveLength(1);
 });
 it('keeps committed collection readable after paused providerless API and database restart',async()=>{
  const f=await prepared(),recovery=privateRecovery(),first=await open(recovery);expect((await collect(first.app,f)).statusCode).toBe(200);
  const before=await footprint(f),reads=recovery.recover.mock.calls.length,reopened=conn.reopen();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  try{const restarted=await open(undefined,reopened.db,false),response=await collect(restarted.app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:'0'});expect(await footprint(f)).toEqual(before);expect(recovery.recover).toHaveBeenCalledTimes(reads);await restarted.app.close();servers.splice(servers.indexOf(restarted.app),1);}finally{await reopened.sql.end();}
 });
 it('requires the current base caller after transfer while repaired taxes keep the original seller',async()=>{
  const f=await prepared(),buyer=await createTestPlayer(conn.db);
  await conn.db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.base.id));await tx.update(bases).set({ownerWallet:buyer.wallet}).where(eq(bases.id,f.base.id));await tx.insert(baseSlots).values({wallet:buyer.wallet,slot:1,baseId:f.base.id});});
  const recovery=privateRecovery(),{app}=await open(recovery,conn.db,false);
  const foreign=await collect(app,f);expect([404,409]).toContain(foreign.statusCode);expect(recovery.recover).not.toHaveBeenCalled();
  const response=await collect(app,{...f,cookies:await cookies(buyer.wallet)});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:f.net.toString()});
  expect((await footprint(f)).assessments.every(r=>r.value.wallet===f.wallet)).toBe(true);expect(recovery.recover).toHaveBeenCalledTimes(2);
 });
 it('runs collection as a non-owner LOGIN with only SELECT on recovery evidence while the separate owner verifier alone repairs',async()=>{
  const f=await prepared(),role='mine_gameplay_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{
   const [database]=await conn.sql`select current_database() name`;
   await conn.sql.unsafe(`grant connect on database ${database!.name} to ${role};grant usage on schema public to ${role};grant usage,select on all sequences in schema public to ${role}`);
   // Existing gameplay permissions are fixture-local; the two new private
   // tables deliberately receive only explicit SELECT, never DML or ownership.
   const tables=await conn.sql`select tablename from pg_tables where schemaname='public' and tablename not in ('shards_mine_resolutions','shards_mine_resolution_terms')`;
   for(const t of tables)await conn.sql.unsafe(`grant select,insert,update,delete on public."${String(t.tablename).replaceAll('"','""')}" to ${role}`);
   await conn.sql.unsafe(`grant select on shards_mine_resolutions,shards_mine_resolution_terms to ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:4});
   expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);
   expect(await runtime.sql`select c.relname,has_table_privilege(current_user,c.oid,'SELECT') can_read,has_table_privilege(current_user,c.oid,'INSERT') can_insert,has_table_privilege(current_user,c.oid,'UPDATE') can_update,has_table_privilege(current_user,c.oid,'DELETE') can_delete,c.relowner=current_user::regrole::oid owns from pg_class c where c.oid in ('shards_mine_resolutions'::regclass,'shards_mine_resolution_terms'::regclass) order by c.relname`).toEqual([
    {relname:'shards_mine_resolution_terms',can_read:true,can_insert:false,can_update:false,can_delete:false,owns:false},
    {relname:'shards_mine_resolutions',can_read:true,can_insert:false,can_update:false,can_delete:false,owns:false}]);
   const recovery=privateRecovery(),{app}=await open(recovery,runtime.db),response=await collect(app,f);
   expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:f.net.toString()});expect(recovery.recover).toHaveBeenCalledTimes(2);
   await expect(runtime.sql`update shards_mine_resolutions set custody=custody where parent_id=${f.parent.id}`).rejects.toMatchObject({code:'42501'});
   const original=await footprint(f);
   await conn.sql.unsafe(`grant insert,update,delete on shards_mine_resolutions,shards_mine_resolution_terms to ${role}`);
   await expect(runtime.sql`insert into shards_mine_resolutions select * from shards_mine_resolutions where parent_id=${f.parent.id}`).rejects.toMatchObject({code:'42501',message:'MINE_RESOLUTION_OWNER_REQUIRED'});
   await expect(runtime.sql`insert into shards_mine_resolution_terms select * from shards_mine_resolution_terms where parent_id=${f.parent.id}`).rejects.toMatchObject({code:'42501',message:'MINE_RESOLUTION_OWNER_REQUIRED'});
   await expect(runtime.sql`update shards_mine_resolutions set custody=custody where parent_id=${f.parent.id}`).rejects.toThrow('MINE_RESOLUTION_IMMUTABLE');
   expect(await footprint(f)).toEqual(original);
   await app.close();servers.splice(servers.indexOf(app),1);
  }finally{await runtime?.sql.end();await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });
 it('repairs parents first materialized by admission and collects them in the same authenticated request',async()=>{
  const f=await unmaterialized(),recovery=privateRecovery(),{app,currentConnect}=await open(recovery);
  expect((await footprint(f)).segments).toHaveLength(0);
  const response=await collect(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:f.net.toString()});
  const saved=await footprint(f);expect(saved.headers).toHaveLength(1);expect(saved.terms).toHaveLength(2);expect(saved.ledger).toHaveLength(1);
  expect(recovery.recover).toHaveBeenCalledOnce();expect(currentConnect).toHaveBeenCalledOnce();
  expect(saved.terms.map(r=>r.value.certificate.snapshot.source.round).sort()).toEqual(['0','1']);
  expect((await collect(app,f)).json()).toEqual({amount:'0'});expect(recovery.recover).toHaveBeenCalledOnce();expect(currentConnect).toHaveBeenCalledOnce();
 });
 it('recovers a proven same-day v2 interval only after its final completion millisecond has closed',async()=>{
  const anchor=new Date(+fixture.verified+1),f=await unmaterialized({anchor,baselineAt:fixture.verified.toISOString()}),at=new Date(+anchor+2*fixture.unit);
  await time(at);await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,f.base.id,at));await admit(f.wallet,f.base.id,at);
  const owner=createPhysicalMineRecoveryProvider(conn.db,{historicalTerm:{connect:current.connect,policy:current.policy},clock:()=>new Date()});
  const recovery={recover:vi.fn(owner.recover)},{app,currentConnect}=await open(recovery),before=await footprint(f);
  const unclosed=await collect(app,f);expect(unclosed.statusCode,unclosed.body).toBe(503);expect(recovery.recover).not.toHaveBeenCalled();expect(await footprint(f)).toEqual(before);
  await time(new Date(+at+1));const response=await collect(app,f);expect(response.statusCode,response.body).toBe(200);
  const net=2n-2n*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);expect(response.json()).toEqual({amount:net.toString()});
  expect(recovery.recover).toHaveBeenCalledOnce();expect(currentConnect).not.toHaveBeenCalled();
  const saved=await footprint(f);expect(saved.headers).toHaveLength(1);expect(saved.headers[0]!.value.custody.evidence.version).toBe(2);
  expect(saved.headers[0]!.value.custody.evidence.rosters[0].baseline.observedAt).toBe(fixture.verified.toISOString().replace('Z','000Z'));
  expect(saved.terms[0]!.value.certificate.snapshot.source.round).toBe('2');expect(saved.ledger).toHaveLength(1);
 });
 it('retains newly materialized original parents without issuance after a post-admission archive outage, then retries without readmission',async()=>{
  const f=await unmaterialized();let unavailable=true;
  const recovery={recover:vi.fn(async(id:string)=>{await resolvePhysicalMineTaxSource(conn.db,id,{...fixture.deps,historicalTerm:{...fixture.deps.historicalTerm,connect:signal=>{if(unavailable)throw Error('post-admission archive outage');return fixture.deps.historicalTerm.connect(signal);}}});})};
  const {app,currentConnect}=await open(recovery),response=await collect(app,f);expect(response.statusCode,response.body).toBe(503);expect(response.json().error.code).toBe('SHARDS_MINE_RESOLUTION_HELD');
  const held=await footprint(f);expect(held.heads).toHaveLength(1);expect(held.headers).toHaveLength(0);expect(held.ledger).toHaveLength(0);expect(held.assessments).toHaveLength(0);
  const original=held.segments.find(r=>r.value.wallet!==null)!;expect([original.value.buffer,original.value.gross,original.value.resolved].map(v=>BigInt(v))).toEqual([BigInt(fixture.quota-4),BigInt(fixture.quota-4),0n]);
  expect(currentConnect).toHaveBeenCalledOnce();unavailable=false;
  const retry=await collect(app,f);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual({amount:f.net.toString()});
  const paid=await footprint(f);expect(paid.heads).toEqual(held.heads);expect(paid.headers[0]!.value.parent_id).toBe(original.value.id);expect(paid.ledger).toHaveLength(1);expect(currentConnect).toHaveBeenCalledOnce();
  expect((await collect(app,f)).json()).toEqual({amount:'0'});expect(recovery.recover).toHaveBeenCalledTimes(2);
 });
 it('repairs a missing Mine while preserving a covered sibling fractional clock and later empty taps',async()=>{
  const covered=await unmaterialized({anchor:fixture.verified});await admit(covered.wallet,covered.base.id);
  const before=await conn.sql`select to_jsonb(s) value from mine_accrual_states s where mine_building_id=${covered.mine.id}`;
  await time(new Date(+fixture.verified+Math.floor(fixture.unit*3/4)));
  const [missing]=await conn.db.insert(buildings).values({playerWallet:covered.wallet,baseId:covered.base.id,type:'mine',level:1,tx:3,ty:3}).returning();
  await conn.db.insert(mineAccrualStates).values({mineBuildingId:missing!.id,lastAccrualAt:fixture.anchor});
  const owner=createPhysicalMineRecoveryProvider(conn.db,{...fixture.deps,clock:()=>new Date()}),recovery={recover:vi.fn(owner.recover)},{app,currentConnect}=await open(recovery);
  const response=await collect(app,covered);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:covered.net.toString()});
  expect(await conn.sql`select to_jsonb(s) value from mine_accrual_states s where mine_building_id=${covered.mine.id}`).toEqual(before);
  await time(new Date(+fixture.verified+Math.floor(fixture.unit*9/10)));expect((await collect(app,covered)).json()).toEqual({amount:'0'});
  expect(await conn.sql`select to_jsonb(s) value from mine_accrual_states s where mine_building_id=${covered.mine.id}`).toEqual(before);
  await time(new Date(+fixture.verified+Math.ceil(fixture.unit*5/4)));expect((await collect(app,covered)).json()).toEqual({amount:'1'});
  expect(currentConnect).toHaveBeenCalledOnce();expect(recovery.recover).toHaveBeenCalledOnce();
 });
 it('shares the sixteen-parent work limit across both passes and resumes the remaining original parent on retry',async()=>{
  const f=await unmaterialized();
  // Sixteen distinct real source intervals precede the first pass. Admission
  // materializes the remainder only after those intervals have been repaired.
  for(let unit=5;unit<=20;unit++)await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,f.base.id,new Date(+fixture.anchor+unit*fixture.unit)));
  expect(await conn.sql`select id from shards_mine_segments where mine_id=${f.mine.id} and wallet is not null`).toHaveLength(16);
  const recovery=privateRecovery(),{app,currentConnect}=await open(recovery),response=await collect(app,f);
  expect(response.statusCode,response.body).toBe(503);expect(response.json().error.code).toBe('SHARDS_SOURCE_HELD');expect(recovery.recover).toHaveBeenCalledTimes(16);
  const held=await footprint(f);expect(held.headers).toHaveLength(16);expect(held.ledger).toHaveLength(0);expect(held.assessments).toHaveLength(0);expect(currentConnect).toHaveBeenCalledOnce();
  const pending=held.segments.filter(r=>r.value.wallet!==null&&r.value.recovery_parent_id===null&&r.value.buffer===r.value.gross&&BigInt(r.value.resolved)===0n);expect(pending).toHaveLength(1);
  const retry=await collect(app,f);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual({amount:f.net.toString()});
  const paid=await footprint(f);expect(paid.headers).toHaveLength(17);expect(paid.ledger).toHaveLength(1);expect(recovery.recover).toHaveBeenCalledTimes(17);expect(currentConnect).toHaveBeenCalledOnce();
 },120000);
 it('concurrent first requests converge on one newly materialized parent graph and one conserved collection',async()=>{
  const f=await unmaterialized(),recovery=privateRecovery(),{app}=await open(recovery),responses=await Promise.all([collect(app,f),collect(app,f)]);
  expect(responses.every(r=>r.statusCode===200||r.statusCode===503)).toBe(true);
  const retry=await collect(app,f);expect(retry.statusCode,retry.body).toBe(200);const amount=[...responses,retry].reduce((n,r)=>n+(r.statusCode===200?BigInt(r.json().amount):0n),0n);expect(amount).toBe(f.net);
  const saved=await footprint(f);expect(saved.headers).toHaveLength(1);expect(saved.terms).toHaveLength(2);expect(saved.ledger).toHaveLength(1);
  expect(await conn.sql`select id from shards_mine_admissions where base_id=${f.base.id}`).toHaveLength(1);
 });
});
