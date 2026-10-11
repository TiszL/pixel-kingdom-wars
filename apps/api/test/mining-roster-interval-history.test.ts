/** Subday Mine facts require uninterrupted captured state, never first-mutation timestamps as commit time. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {initializeMiningRosterHistory,readMiningRosterHistory} from '../src/mining/rosterHistory';
import {readMiningRosterInterval,validateMiningRosterIntervalEvidence} from '../src/mining/rosterIntervalHistory';
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{vi.unstubAllEnvs();await f.conn.close();}}
async function setup(){
 const conn=resourceClaimsDatabase();await conn.setup();vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const wallet=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58(),base=randomUUID(),other=randomUUID();
 await conn.sql`insert into players(wallet) values(${wallet}),(${buyer})`;
 await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet}),(${other},${wallet})`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base}),(${wallet},2,${other})`;
 const clock=async(value:string)=>{if(!/^2035-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value))throw Error('fixture clock');await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);};
 await clock('2035-01-01T12:00:00.000000Z');
 const init=()=>initializeMiningRosterHistory(conn.db,wallet),input={wallet,baseId:base,startsAt:'2035-01-01T12:00:00.001Z',endsAt:'2035-01-01T13:00:00.001Z'},read=()=>readMiningRosterInterval(conn.db,input);
 return {conn,wallet,buyer,base,other,clock,init,input,read};
}
// 2026-10-10 (release/phase-e-20261010): 'bounds all committed history through the read barrier' timed out at its
// 30 s budget in CI run 38043546234 (API shard 10). At d080b2405 (CI run 37503885235) the file took 195 s for 10 cases
// (~19.5 s each on the runner). On a dev Mac each case measured 15-21 s on d080b2405 and 11-15 s on this branch, so the
// merge did not slow it; the runner is just near the edge. The ten identical 30 s budgets become one 90 s budget.
// The assertions are unchanged.
const CASE_BUDGET_MS=90_000;
describe('conservative registered-base interval history',()=>{
 it('proves the captured same-day active slot while full-day qualification still refuses and grants no authority',async()=>fixture(async f=>{
  const baseline=await f.init();await f.clock('2035-01-01T14:00:00.000000Z');const proof=await f.read();
  expect(proof).toMatchObject({version:1,purpose:'registered_base_unchanged_interval',baseline,base:{id:f.base},slot:{slot:1,base_id:f.base},events:[],sourceUniverse:'registered-stable-bases',historicalBirth:'unknown',externalDeedOwnership:'unknown',eligibilityAuthorized:false,replacementAuthorized:false});
  expect(validateMiningRosterIntervalEvidence(JSON.parse(JSON.stringify(proof)))).toEqual(proof);
  await f.clock('2035-01-02T00:00:00.000000Z');await expect(readMiningRosterHistory(f.conn.db,{wallet:f.wallet,day:'2035-01-01',policyVersion:1})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect((await f.read()).base.id).toBe(f.base);
 }),CASE_BUDGET_MS);
 it('requires a strictly earlier microsecond baseline, never Date truncation or equal-time coverage',async()=>fixture(async f=>{
  await f.clock('2035-01-01T12:00:00.000999Z');await f.init();await f.clock('2035-01-01T14:00:00.000000Z');expect((await f.read()).baseline.observedAt).toBe('2035-01-01T12:00:00.000999Z');
  const proof=await f.read();for(const observedAt of ['2035-01-01T12:00:00.001000Z','2035-01-01T12:00:00.001001Z'])expect(()=>validateMiningRosterIntervalEvidence({...proof,baseline:{...proof.baseline,observedAt}})).toThrow();
  await expect(readMiningRosterInterval(f.conn.db,{...f.input,startsAt:'2035-01-01T12:00:00.000Z'})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),CASE_BUDGET_MS);
 it('refuses a first-mutation-before-interval transaction that transfers the target out and back later',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-01T12:00:00.000500Z');
  await f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.other}`;
   await tx.unsafe("create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '2035-01-01T12:30:00.000000Z'::timestamptz $$");
   await tx`update bases set owner_wallet=${f.buyer} where id=${f.base}`;await tx`update bases set owner_wallet=${f.wallet} where id=${f.base}`;});
  const events=await f.conn.sql`select distinct observed_at::text from mining_roster_events`;expect(events).toHaveLength(1);
  await f.clock('2035-01-01T14:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),CASE_BUDGET_MS);
 it('refuses target changes after the interval too, because commit time is not retained',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-01T13:30:00.000000Z');await f.conn.sql`update base_slots set active=false where base_id=${f.base}`;
  await f.conn.sql`update base_slots set active=true where base_id=${f.base}`;await f.clock('2035-01-01T14:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),CASE_BUDGET_MS);
 it('retains complete unrelated transaction groups and ignores rollback/navigation changes',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-01T12:30:00.123456Z');await f.conn.sql.begin(async tx=>{await tx`update base_slots set active=false where base_id=${f.other}`;await tx`update bases set status='inactive' where id=${f.other}`;});
  await expect(f.conn.sql.begin(async tx=>{await tx`update bases set owner_wallet=${f.buyer} where id=${f.base}`;throw Error('rollback');})).rejects.toThrow('rollback');
  await f.conn.sql`update base_slots set selected_at=now() where base_id=${f.base}`;await f.conn.sql`update bases set keep_level=2 where id=${f.base}`;
  await f.clock('2035-01-01T14:00:00.000000Z');const proof=await f.read();expect(proof.events).toHaveLength(2);expect(new Set(proof.events.map(e=>e.txKey)).size).toBe(1);expect(proof.events.every(e=>e.markerObservedAt===e.observedAt)).toBe(true);
  expect(validateMiningRosterIntervalEvidence(JSON.parse(JSON.stringify(proof)))).toEqual(proof);
 }),CASE_BUDGET_MS);
 it('refuses a writer barrier immediately and stale repeatable-read snapshots',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-01T14:00:00.000000Z');let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`update bases set keep_level=2 where id=${f.other}`;ready();await gate;});
  try{await started;await expect(f.read()).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql`set transaction isolation level repeatable read`);await tx.execute(sql`select count(*) from accounts`);return readMiningRosterInterval(tx,f.input);})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),CASE_BUDGET_MS);
 it('rejects missing capture, an open interval, malformed/imprecise input and a target absent from the captured baseline',async()=>fixture(async f=>{
  await f.clock('2035-01-01T14:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await f.clock('2035-01-01T12:00:00.000000Z');await f.init();await expect(f.read()).rejects.toMatchObject({code:'DAY_OPEN'});
  await f.clock('2035-01-01T14:00:00.000000Z');for(const input of [{...f.input,startsAt:'2035-01-01T12:00:00Z'},{...f.input,endsAt:f.input.startsAt},{...f.input,extra:true},{...f.input,startsAt:'2035-02-30T00:00:00.000Z'}])await expect(readMiningRosterInterval(f.conn.db,input)).rejects.toMatchObject({code:'INVALID_INPUT'});
  const newBase=randomUUID();await f.conn.sql`insert into bases(id,owner_wallet) values(${newBase},${f.wallet})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},3,${newBase})`;
  await expect(readMiningRosterInterval(f.conn.db,{...f.input,baseId:newBase})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),CASE_BUDGET_MS);
 it('independently rejects malformed groups, future timestamps, duplicate identities and invented derived facts',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-01T12:30:00.000000Z');await f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.other}`;await tx`update bases set status='active' where id=${f.other}`;});await f.clock('2035-01-01T14:00:00.000000Z');const p=await f.read(),e=p.events[0]!;
  const invalid:unknown[]=[{...p,extra:true},{...p,observedAt:'2035-01-01T14:00:00.000Z'},{...p,eligibilityAuthorized:true},{...p,base:{...p.base,id:f.other}},{...p,slot:{...p.slot,slot:2}},
   {...p,baseline:{...p.baseline,bases:[...p.baseline.bases,p.base]}},{...p,baseline:{...p.baseline,slots:[...p.baseline.slots,p.slot]}},
   {...p,events:[{...e,markerObservedAt:null},p.events[1]]},{...p,events:[{...e,observedAt:'2035-01-01T15:00:00.000000Z',markerObservedAt:'2035-01-01T15:00:00.000000Z'},p.events[1]]},
   {...p,events:[e,e]},{...p,events:[p.events[1]]},{...p,events:[{...e,sourceId:randomUUID()},p.events[1]]},{...p,events:[{...e,txKey:'00'},p.events[1]]}];
  for(const value of invalid)expect(()=>validateMiningRosterIntervalEvidence(value)).toThrow();
 }),CASE_BUDGET_MS);
 it('refuses ambiguous captured deed identity and a later unrelated-base event touching the target deed',async()=>fixture(async f=>{
  const asset=Keypair.generate().publicKey.toBase58();await f.conn.sql`update bases set land_paid_at='2035-01-01',deed_asset_id=${asset} where id=${f.base}`;await f.init();await f.clock('2035-01-01T14:00:00.000000Z');const p=await f.read();
  const duplicate={...p,baseline:{...p.baseline,bases:p.baseline.bases.map(b=>b.id===f.other?{...b,deed_asset_id:asset}:b)}};expect(()=>validateMiningRosterIntervalEvidence(duplicate)).toThrow();
  // A real unrelated mutation with a conflicting retained identity must also refuse; pure proof mutation models corrupt owner storage, not chain authority.
  await f.conn.sql`update bases set status='inactive' where id=${f.other}`;const q=await f.read(),e=q.events[0]!;
  expect(()=>validateMiningRosterIntervalEvidence({...q,events:[{...e,afterState:{...e.afterState,deed_asset_id:asset}}]})).toThrow();
 }),CASE_BUDGET_MS);
 it('bounds all committed history through the read barrier, including events after the earning interval',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-01T13:30:00.000000Z');await f.conn.sql`insert into bases(id,owner_wallet,status) select gen_random_uuid(),${f.wallet},'inactive' from generate_series(1,10001)`;
  await f.clock('2035-01-01T14:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'TOO_LARGE'});
 }),CASE_BUDGET_MS);
});
