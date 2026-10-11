/** Original-term repair intent, using actual native-permit settlements and roster custody. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createTestPlayer } from './helpers';
import { readPhysicalMineResolution, resolvePhysicalMineTaxSource } from '../src/mining/shardsTaxMineResolution';
import { createMineResolutionTermBank, createHistoricalMineResolutionFixture, createBufferedMineResolutionFixture,
 setMineResolutionRosterClock, mineResolutionFixtureTimes } from './fixtures/historicalMineResolution';
const conn=resourceClaimsDatabase(),db=conn.db,{verified}=mineResolutionFixtureTimes;
let original:Awaited<ReturnType<typeof createMineResolutionTermBank>>['original'],rpc:SeekerTermRpc;
const connect=vi.fn((signal:AbortSignal)=>{signal.throwIfAborted();return rpc;});
beforeAll(async()=>{
 await conn.setup();
 const fixture=await createHistoricalMineResolutionFixture(conn);({original,rpc}=fixture.bank);
},120_000);
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(verified);vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');connect.mockClear();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();});afterAll(()=>conn.close());
const fixture=()=>createBufferedMineResolutionFixture(conn);
const rosterClock=(at:string)=>setMineResolutionRosterClock(conn,at);
const deps=()=>({historicalTerm:{connect,policy:original.policy},clock:()=>new Date(verified)});
const rows=async(id:string)=>({parent:await conn.sql`select * from shards_mine_segments where id=${id}`,
 headers:await conn.sql`select * from shards_mine_resolutions where parent_id=${id}`,
 children:await conn.sql`select * from shards_mine_segments where recovery_parent_id=${id}`});
describe.sequential('original physical Mine resolution service',()=>{
 it('uses delayed historical finality and exact original ordinals across a half-open term boundary, without RPC under locks or money writes',async()=>{
  const f=await fixture(),transaction=db.transaction.bind(db);let locked=0;
  vi.spyOn(db,'transaction').mockImplementation(async(...args)=>{const [work,options]=args;return transaction(async tx=>{locked++;try{return await work(tx);}finally{locked--; }},options);});
  connect.mockImplementation(signal=>{signal.throwIfAborted();expect(locked).toBe(0);return rpc;});
  const result=await resolvePhysicalMineTaxSource(db,f.parent.id,deps());
  expect(result).toMatchObject({parentId:f.parent.id,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
  expect(result.children.map(c=>[c.segment.first_unit,c.segment.last_unit])).toEqual([['5','5'],['6','8']]);
  expect(result.children.map(c=>c.segment.source_key)).toEqual([`mine-recovered:${f.parent.id}:u5`,`mine-recovered:${f.parent.id}:u6`]);
  expect(result.children.map(c=>c.certificate.snapshot.source.round)).toEqual(['0','1']);
  expect(result.children.every(c=>c.certificate.finality.observedAt===verified.toISOString())).toBe(true);
  expect(result.header.custody.evidence.segment.wallet).toBe(f.wallet);
  expect(await conn.sql`select id from shards_mine_admissions where wallet=${f.wallet}`).toHaveLength(0);
  expect(await conn.sql`select wallet from shards_tax_assessments where wallet=${f.wallet}`).toHaveLength(0);
  expect((await rows(f.parent.id)).parent[0]).toMatchObject({buffer:'0',resolved:'4',issued:'0'});
 });
 it('replays immutable resolution after pause and database reopen with no providers',async()=>{
  const f=await fixture(),accepted=await resolvePhysicalMineTaxSource(db,f.parent.id,deps()),reads=connect.mock.calls.length;
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reopened=conn.reopen();
  try{expect(await resolvePhysicalMineTaxSource(reopened.db,f.parent.id)).toEqual(accepted);expect(await readPhysicalMineResolution(reopened.db,f.parent.id)).toEqual(accepted);}
  finally{await reopened.sql.end();}expect(connect).toHaveBeenCalledTimes(reads);
 });
 it('converges concurrent repair requests without duplicate child quantities',async()=>{
  const f=await fixture();const [a,b]=await Promise.all([resolvePhysicalMineTaxSource(db,f.parent.id,deps()),resolvePhysicalMineTaxSource(db,f.parent.id,deps())]);
  expect(a).toEqual(b);const state=await rows(f.parent.id);expect(state.headers).toHaveLength(1);expect(state.children).toHaveLength(2);
  expect(state.children.reduce((n,c)=>n+BigInt(c.buffer),0n)).toBe(4n);
 });
 it('refuses a busy transferred base without waiting behind its current owner, then retries the original-wallet repair',async()=>{
  const f=await fixture(),buyer=await createTestPlayer(db),other=conn.reopen(),before=await rows(f.parent.id);
  await conn.sql`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;
  let ready!:()=>void,release!:()=>void,timer:ReturnType<typeof setTimeout>|undefined;
  const entered=new Promise<void>(resolve=>{ready=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
  const blocker=other.sql.begin(async tx=>{await tx`select id from bases where id=${f.base.id} for update`;ready();await barrier;});
  await entered;
  const outcome=resolvePhysicalMineTaxSource(db,f.parent.id,deps()).then(result=>({result}),error=>({error}));
  try{
   const result=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),5000);})]);
   expect(result).toMatchObject({error:{code:'SHARDS_MINE_RESOLUTION_HELD'}});
   expect(await rows(f.parent.id)).toEqual(before);
  }finally{if(timer)clearTimeout(timer);release();await blocker;await outcome;await other.sql.end();}
  const accepted=await resolvePhysicalMineTaxSource(db,f.parent.id,deps());
  expect(accepted.children.every(c=>c.segment.wallet===f.wallet)).toBe(true);
 });
 it('replays a repair committed between its initial graph lookup and parent read',async()=>{
  const f=await fixture(),execute=db.execute.bind(db);let first=true,committed:Awaited<ReturnType<typeof resolvePhysicalMineTaxSource>>|undefined;
  // Only the awaited PgRaw result is used here; preserve its actual rows.
  vi.spyOn(db,'execute').mockImplementation((async(...args:Parameters<typeof db.execute>)=>{
   const result=await execute(...args);
   if(first){first=false;committed=await resolvePhysicalMineTaxSource(db,f.parent.id,deps());}
   return result;
  }) as unknown as typeof db.execute);
  expect(await resolvePhysicalMineTaxSource(db,f.parent.id,deps())).toEqual(committed);
  expect(connect).toHaveBeenCalledTimes(2);
 });
 it('keeps an unresolved source untouched while paused without consulting providers',async()=>{
  const f=await fixture(),before=await rows(f.parent.id);vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  await expect(resolvePhysicalMineTaxSource(db,f.parent.id,deps())).rejects.toMatchObject({code:'PHASE_E_DISABLED'});
  expect(await rows(f.parent.id)).toEqual(before);expect(connect).not.toHaveBeenCalled();
 });
 it('rolls back pinned terms, header, children and parent conservation on a later certificate insert failure',async()=>{
  const f=await fixture(),before=await rows(f.parent.id),fresh=await createMineResolutionTermBank();
  const termsBefore=await conn.sql`select count(*) from expedition_term_snapshots`;
  await conn.sql.unsafe(`create function mine_resolution_fixture_fail() returns trigger language plpgsql as $$begin if exists(select 1 from shards_mine_resolution_terms where parent_id=NEW.parent_id) then raise exception 'fixture second certificate';end if;return NEW;end$$;create trigger mine_resolution_fixture_fail before insert on shards_mine_resolution_terms for each row execute function mine_resolution_fixture_fail()`);
  try{await expect(resolvePhysicalMineTaxSource(db,f.parent.id,{...deps(),historicalTerm:{connect:()=>fresh.rpc,policy:fresh.original.policy}})).rejects.toMatchObject({cause:{message:'fixture second certificate'}});}finally{await conn.sql.unsafe('drop trigger mine_resolution_fixture_fail on shards_mine_resolution_terms;drop function mine_resolution_fixture_fail()');}
  expect(await rows(f.parent.id)).toEqual(before);expect(await readPhysicalMineResolution(db,f.parent.id)).toBeNull();
  expect(await conn.sql`select count(*) from expedition_term_snapshots`).toEqual(termsBefore);
 });
 it('holds provider failure and an unobserved original interval instead of inventing authority',async()=>{
  const f=await fixture(),before=await rows(f.parent.id);connect.mockImplementationOnce(()=>{throw Error('Fixture outage');});
  await expect(resolvePhysicalMineTaxSource(db,f.parent.id,deps())).rejects.toThrow();expect(await rows(f.parent.id)).toEqual(before);
  // Full-day closure is no longer necessary when interval evidence exists;
  // a read before the original last unit still cannot authenticate earning.
  await rosterClock('2035-01-08T00:00:00Z');const count=connect.mock.calls.length;
  await expect(resolvePhysicalMineTaxSource(db,f.parent.id,deps())).rejects.toThrow();expect(connect).toHaveBeenCalledTimes(count);
 });
 it.each(['issued','reserved','discarded'] as const)('refuses an already %s parent before network reads',async counter=>{
  const f=await fixture();await conn.sql.unsafe(`update shards_mine_segments set buffer=3,${counter}=1 where id='${f.parent.id}'`);
  await expect(resolvePhysicalMineTaxSource(db,f.parent.id,deps())).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
 });
 it('rechecks the full original parent after provider work and rolls back if quantity moved meanwhile',async()=>{
  const f=await fixture();connect.mockImplementationOnce(()=>({...rpc,getGenesisHash:async()=>{
   await conn.sql`update shards_mine_segments set buffer=3,reserved=1 where id=${f.parent.id}`;return rpc.getGenesisHash();
  }}));
  await expect(resolvePhysicalMineTaxSource(db,f.parent.id,deps())).rejects.toThrow();
  const after=await rows(f.parent.id);expect(after.headers).toHaveLength(0);expect(after.children).toHaveLength(0);expect(after.parent[0]).toMatchObject({buffer:'3',reserved:'1',resolved:'0'});
 });
 it('retains the original wallet after a later transfer and refuses a caller transaction',async()=>{
  const f=await fixture(),buyer=await createTestPlayer(db);await conn.sql`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;await conn.sql`delete from base_slots where base_id=${f.base.id}`;
  const result=await resolvePhysicalMineTaxSource(db,f.parent.id,deps());expect(result.children.every(c=>c.segment.wallet===f.wallet)).toBe(true);
  const count=connect.mock.calls.length;await db.transaction(async tx=>{await expect(resolvePhysicalMineTaxSource(tx as unknown as typeof db,f.parent.id,deps())).rejects.toThrow('top-level');});expect(connect).toHaveBeenCalledTimes(count);
 });
 it('copies the provider policy before awaits and refuses a server verification time preceding the actual observation',async()=>{
  const f=await fixture(),input=deps(),policy={...input.historicalTerm.policy,deployment:{...input.historicalTerm.policy.deployment}};
  connect.mockImplementationOnce(()=>({...rpc,getGenesisHash:async()=>{policy.deployment.programDataSha256='00'.repeat(32);return rpc.getGenesisHash();}}));
  expect((await resolvePhysicalMineTaxSource(db,f.parent.id,{...input,historicalTerm:{connect,policy}})).children).toHaveLength(2);
  const other=await fixture();await expect(resolvePhysicalMineTaxSource(db,other.parent.id,{...deps(),clock:()=>new Date(+verified-1)})).rejects.toThrow();expect((await rows(other.parent.id)).headers).toHaveLength(0);
 });
});
