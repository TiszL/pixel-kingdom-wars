/** A later captured roster can prove only subsequent unchanged registered custody. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {describe,expect,it,vi} from 'vitest';
import type {Db} from '../src/db/client';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {FRESH_DB_CASE_MS} from './freshDbCaseBudgets';
import {initializeMiningRosterHistory,readMiningRosterHistory} from '../src/mining/rosterHistory';
import {captureMiningRosterCheckpoint} from '../src/mining/rosterCheckpoints';
import {readMiningRosterInterval} from '../src/mining/rosterIntervalHistory';
import {readMiningRosterCheckpointInterval,validateMiningRosterCheckpointIntervalEvidence} from '../src/mining/rosterCheckpointHistory';
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{vi.unstubAllEnvs();await f.conn.close();}}
async function setup(){
 const conn=resourceClaimsDatabase();await conn.setup();vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const wallet=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58(),original=randomUUID(),base=randomUUID();
 await conn.sql`insert into players(wallet) values(${wallet}),(${buyer})`;await conn.sql`insert into bases(id,owner_wallet) values(${original},${wallet})`;await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${original})`;
 const clock=async(value:string)=>{if(!/^2035-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value))throw Error('fixture clock');await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);};
 await clock('2035-01-01T09:00:00.000000Z');const baseline=await initializeMiningRosterHistory(conn.db,wallet);
 await clock('2035-01-01T09:01:00.000000Z');await conn.sql.begin(async tx=>{await tx`insert into bases(id,owner_wallet) values(${base},${wallet})`;await tx`insert into base_slots(wallet,slot,base_id) values(${wallet},2,${base})`;});
 const capture=()=>captureMiningRosterCheckpoint(conn.db,wallet),input={wallet,baseId:base,startsAt:'2035-01-01T10:00:00.124Z',endsAt:'2035-01-01T11:00:00.000Z'},read=()=>readMiningRosterCheckpointInterval(conn.db,input);
 return {conn,wallet,buyer,original,base,baseline,clock,capture,input,read};
}
describe('prospective roster checkpoint interval proof',()=>{
 it('proves a later registered base only after its real checkpoint without changing the original baseline or day qualification',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T12:00:00.000000Z');const proof=await f.read();
  expect(proof).toMatchObject({version:1,purpose:'registered_base_checkpoint_interval',checkpoint:{wallet:f.wallet,observedAt:'2035-01-01T10:00:00.123456Z'},base:{id:f.base},slot:{base_id:f.base,active:true},events:[],eligibilityAuthorized:false,replacementAuthorized:false});
  expect(await initializeMiningRosterHistory(f.conn.db,f.wallet)).toEqual(f.baseline);
  await f.clock('2035-01-02T00:00:00.000000Z');await expect(readMiningRosterHistory(f.conn.db,{wallet:f.wallet,day:'2035-01-01',policyVersion:1})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),FRESH_DB_CASE_MS);
 it('selects the latest strictly earlier microsecond checkpoint and refuses equality without falling back to late snapshots',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.conn.sql`update bases set keep_level=2 where id=${f.original}`;
  await f.conn.sql`update base_slots set active=false where base_id=${f.original}`;await f.conn.sql`update bases set status='inactive' where id=${f.original}`;
  await f.clock('2035-01-01T10:00:00.123999Z');await f.capture();await f.clock('2035-01-01T12:00:00.000000Z');const p=await f.read();
  expect(p.checkpoint.observedAt).toBe('2035-01-01T10:00:00.123999Z');expect(p.events).toHaveLength(0);
  for(const observedAt of ['2035-01-01T10:00:00.124000Z','2035-01-01T10:00:00.124001Z'])expect(()=>validateMiningRosterCheckpointIntervalEvidence({...p,checkpoint:{...p.checkpoint,observedAt}})).toThrow();
  await expect(readMiningRosterCheckpointInterval(f.conn.db,{...f.input,startsAt:'2035-01-01T10:00:00.123Z'})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),FRESH_DB_CASE_MS);
 it('does not let a later out-and-back checkpoint erase relevant changes during or after earning',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T11:30:00.000000Z');
  await f.conn.sql.begin(async tx=>{await tx`update bases set owner_wallet=${f.buyer} where id=${f.base}`;await tx`update bases set owner_wallet=${f.wallet} where id=${f.base}`;});
  await f.capture();await f.clock('2035-01-01T12:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  // The later checkpoint is usable only for a genuinely later interval.
  const later=await readMiningRosterCheckpointInterval(f.conn.db,{...f.input,startsAt:'2035-01-01T11:30:00.001Z',endsAt:'2035-01-01T11:31:00.000Z'});
  expect(later.checkpoint.observedAt).toBe('2035-01-01T11:30:00.000000Z');expect(later.events).toHaveLength(0);
 }),FRESH_DB_CASE_MS);
 it('includes higher-ID target changes even when their real first-mutation time precedes the checkpoint',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T09:30:00.000000Z');
  await f.conn.sql.begin(async tx=>{await tx`update base_slots set active=false where base_id=${f.base}`;await tx`update base_slots set active=true where base_id=${f.base}`;});
  const rows=await f.conn.sql`select e.id::text,e.observed_at<c.observed_at predates,e.id>c.event_frontier newer from mining_roster_events e cross join mining_roster_checkpoints c where e.wallet=${f.wallet} and e.id>c.event_frontier`;
  expect(rows).toHaveLength(2);expect(rows.every(r=>r.predates&&r.newer)).toBe(true);await f.clock('2035-01-01T12:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),FRESH_DB_CASE_MS);
 it('replays complete interleaved transaction groups in ID order with holes and nonmonotone clocks',async()=>fixture(async f=>{
  const other=randomUUID();await f.conn.sql.begin(async tx=>{await tx`insert into bases(id,owner_wallet) values(${other},${f.wallet})`;await tx`insert into base_slots(wallet,slot,base_id) values(${f.wallet},3,${other})`;});
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T10:20:00.000000Z');
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.original}`;ready();await gate;await tx`update bases set status='active' where id=${f.original}`;});
  try{await started;await f.clock('2035-01-01T10:10:00.000000Z');await expect(f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${other}`;throw Error('rollback');})).rejects.toThrow('rollback');
   await f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${other}`;await tx`update bases set status='active' where id=${other}`;});
  }finally{release();await writer;}
  await f.conn.sql`update base_slots set selected_at=now() where base_id=${f.base}`;await f.clock('2035-01-01T12:00:00.000000Z');const p=await f.read();
  expect(p.events).toHaveLength(4);expect(p.events[0]!.txKey).toBe(p.events[3]!.txKey);expect(p.events[1]!.txKey).toBe(p.events[2]!.txKey);
  expect(p.events[1]!.observedAt<p.events[0]!.observedAt).toBe(true);expect(BigInt(p.events[1]!.id)-BigInt(p.events[0]!.id)).toBeGreaterThan(1n);
  expect(validateMiningRosterCheckpointIntervalEvidence(JSON.parse(JSON.stringify(p)))).toEqual(p);
  const missing={...p,events:p.events.slice(1)};expect(()=>validateMiningRosterCheckpointIntervalEvidence(missing)).toThrow();
 }),FRESH_DB_CASE_MS);
 it('holds a real source writer and rejects a stale outer transaction while retaining paused read-only history',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T12:00:00.000000Z');let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`update bases set keep_level=2 where id=${f.original}`;ready();await gate;});
  try{await started;await expect(f.read()).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql`set transaction isolation level repeatable read`);await tx.execute(sql`select count(*) from accounts`);return readMiningRosterCheckpointInterval(tx as unknown as Db,f.input);})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect((await f.read()).base.id).toBe(f.base);
 }),FRESH_DB_CASE_MS);
 it('rejects absent or too-late capture, open intervals and malformed input without substituting baseline history',async()=>fixture(async f=>{
  await f.clock('2035-01-01T12:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});await f.capture();await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  for(const input of [{...f.input,extra:true},{...f.input,startsAt:'2035-01-01T10:00:00Z'},{...f.input,endsAt:f.input.startsAt},{...f.input,startsAt:'2035-02-30T00:00:00.000Z'}])await expect(readMiningRosterCheckpointInterval(f.conn.db,input)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(readMiningRosterCheckpointInterval(f.conn.db,{...f.input,startsAt:'2035-01-01T12:00:00.001Z',endsAt:'2035-01-01T13:00:00.000Z'})).rejects.toMatchObject({code:'DAY_OPEN'});
  await expect(readMiningRosterInterval(f.conn.db,f.input)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),FRESH_DB_CASE_MS);
 it('independently validates snapshot identity, frontier, complete replay and marker bounds without accepting a renamed old variant',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T10:30:00.000000Z');await f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.original}`;await tx`update bases set status='active' where id=${f.original}`;});
  await f.clock('2035-01-01T12:00:00.000000Z');const p=await f.read(),e=p.events[0]!;
  for(const value of [{...p,extra:true},{...p,eligibilityAuthorized:true},{...p,purpose:'registered_base_unchanged_interval'},
   {...p,checkpoint:{...p.checkpoint,observedAt:'2035-01-01T10:00:00.123Z'}},{...p,checkpoint:{...p.checkpoint,eventFrontier:e.id}},
   {...p,checkpoint:{...p.checkpoint,bases:[...p.checkpoint.bases,p.base]}},{...p,checkpoint:{...p.checkpoint,slots:[...p.checkpoint.slots,p.slot]}},
   {...p,base:{...p.base,id:f.original}},{...p,slot:{...p.slot,active:false}},
   {...p,events:[e,e]},{...p,events:[{...e,markerObservedAt:null},p.events[1]]},
   {...p,events:[{...e,observedAt:'2035-01-01T13:00:00.000000Z',markerObservedAt:'2035-01-01T13:00:00.000000Z'},p.events[1]]},
   {...p,events:[e,{...p.events[1],observedAt:'2035-01-01T10:30:00.000001Z',markerObservedAt:'2035-01-01T10:30:00.000001Z'}]},
   {...p,events:[{...e,sourceId:randomUUID()},p.events[1]]}])expect(()=>validateMiningRosterCheckpointIntervalEvidence(value)).toThrow();
 }),FRESH_DB_CASE_MS);
 it('rejects duplicate checkpoint deed identities and later unrelated-base aliases of the target asset',async()=>fixture(async f=>{
  const asset=Keypair.generate().publicKey.toBase58();await f.conn.sql`update bases set land_paid_at='2035-01-01',deed_asset_id=${asset} where id=${f.base}`;
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T10:30:00.000000Z');await f.conn.sql`update bases set status='inactive' where id=${f.original}`;await f.clock('2035-01-01T12:00:00.000000Z');const p=await f.read(),e=p.events[0]!;
  expect(()=>validateMiningRosterCheckpointIntervalEvidence({...p,checkpoint:{...p.checkpoint,bases:p.checkpoint.bases.map(b=>b.id===f.original?{...b,deed_asset_id:asset}:b)}})).toThrow();
  expect(()=>validateMiningRosterCheckpointIntervalEvidence({...p,events:[{...e,afterState:{...e.afterState,deed_asset_id:asset}}]})).toThrow();
 }),FRESH_DB_CASE_MS);
 it('bounds all higher-ID history including changes after the earning interval rather than truncating a group',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');await f.capture();await f.clock('2035-01-01T11:30:00.000000Z');await f.conn.sql`insert into bases(id,owner_wallet,status) select gen_random_uuid(),${f.wallet},'inactive' from generate_series(1,10001)`;
  await f.clock('2035-01-01T12:00:00.000000Z');await expect(f.read()).rejects.toMatchObject({code:'TOO_LARGE'});
 }),FRESH_DB_CASE_MS);

 it('refuses an owner outer transaction that can see its own uncommitted checkpoint and leaves no proof after rollback',async()=>fixture(async f=>{
  await f.clock('2035-01-01T10:00:00.123456Z');
  await expect(f.conn.db.transaction(async tx=>{
   await tx.execute(sql`insert into mining_roster_checkpoints(wallet) values(${f.wallet})`);
   await tx.execute(sql.raw("create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '2035-01-01T12:00:00.000000Z'::timestamptz $$"));
   await expect(readMiningRosterCheckpointInterval(tx as unknown as Db,f.input)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
   throw Error('intentional owner rollback');
  })).rejects.toThrow('intentional owner rollback');
  expect(await f.conn.sql`select id from mining_roster_checkpoints where wallet=${f.wallet}`).toHaveLength(0);
 }),FRESH_DB_CASE_MS);

});
