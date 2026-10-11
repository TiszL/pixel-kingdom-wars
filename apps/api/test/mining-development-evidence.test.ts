import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { describe,it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { initializeMiningDevelopmentHistory } from '../src/mining/developmentHistory';
import { readMiningDevelopmentEvidence } from '../src/mining/developmentEvidence';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
const input=(baseId:string,day='2020-01-01')=>({baseId,day,policyVersion:1});
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{vi.unstubAllEnvs();await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}}
async function setup(){
 const name=`mining_development_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('fixture host required');url.pathname=`/${name}`;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await createMigratedDatabase(admin, name);const conn=createDb(url.toString(),{max:4});
 try{await runMigrations(conn.db);vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const clock=async(at:string)=>conn.sql.unsafe(`create or replace function public.shardkeep_mining_development_clock() returns timestamptz language sql volatile as $$ select '${at}'::timestamptz $$`);
 const wallet=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();await conn.sql`insert into players(wallet) values(${wallet}),(${buyer})`;
 const baseId=randomUUID(),keep=randomUUID(),workshop=randomUUID(),forge=randomUUID();
 await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${wallet},3)`;
 await conn.sql`insert into buildings(id,player_wallet,base_id,type,level,tx,ty) values(${keep},${wallet},${baseId},'keep',3,10,10),(${workshop},${wallet},${baseId},'workshop',2,20,20),(${forge},${wallet},${baseId},'goldforge',1,30,30)`;
 await clock('2019-12-31T12:00:00Z');await initializeMiningDevelopmentHistory(conn.db,baseId);
 const job=async(buildingId:string,kind='upgrade',day='2020-01-01')=>{const id=randomUUID();await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${id},${wallet},${baseId},${buildingId},${kind},${`${day}T10:00:00Z`},${`${day}T11:00:00Z`})`;return id;};
 return {name,url,admin,conn,wallet,buyer,baseId,keep,workshop,forge,clock,job,read:(day='2020-01-01')=>readMiningDevelopmentEvidence(conn.db,input(baseId,day))};
 }catch(error){vi.unstubAllEnvs();await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw error;}
}
describe('closed-day completed development authority',()=>{
 it('equates captured timezone representations while preserving microsecond continuity distinctions',async()=>fixture(async f=>{
  const base=randomUUID(),building=randomUUID(),job=randomUUID();
  await f.conn.sql.begin(async tx=>{
   await tx`set local time zone 'UTC'`;
   await tx`insert into bases(id,owner_wallet,land_paid_at) values(${base},${f.wallet},'2019-12-31T10:00:00.123456Z')`;
   await tx`insert into buildings(id,player_wallet,base_id,type,level,tx,ty) values(${building},${f.wallet},${base},'workshop',2,20,20)`;
   await tx`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${job},${f.wallet},${base},${building},'upgrade','2019-12-31T10:00:00.123456Z','2020-01-01T11:00:00.654321Z')`;
   // Finish deferred source setup before the baseline enables capture triggers.
   // Restore deferred timing for the baseline and later authoritative mutations.
   await tx`set constraints all immediate`;
   await tx`set constraints all deferred`;
   // Same authoritative baseline trigger used by the initializer; this pins
   // its session zone while preserving its source-derived JSON and clock.
   await tx`insert into mining_development_baselines(base_id) values(${base})`;
  });
  await f.clock('2020-01-01T10:00:00Z');
  await f.conn.sql.begin(async tx=>{
   await tx`set local time zone 'America/New_York'`;
   await tx`update builder_jobs set finishes_at='2020-01-01T11:30:00.654321Z' where id=${job}`;
   await tx`update bases set owner_wallet=${f.buyer} where id=${base}`;
  });
  await f.clock('2020-01-02T00:00:00Z');const past=await readMiningDevelopmentEvidence(f.conn.db,input(base));
  expect(past.completed.workshop).toEqual([{id:building,level:2}]);
  expect(past.base?.land_paid_at).toBe('2019-12-31T10:00:00.123456Z');expect(past.base?.owner_wallet).toBe(f.buyer);
  // Only the microsecond changes. Reversing their authoritative observation
  // order must fail; millisecond truncation would incorrectly accept both.
  await f.clock('2020-01-02T12:00:00Z');await f.conn.sql`update builder_jobs set started_at='2019-12-31T10:00:00.123457Z' where id=${job}`;
  await f.clock('2020-01-02T11:00:00Z');await f.conn.sql`update builder_jobs set started_at='2019-12-31T10:00:00.123458Z' where id=${job}`;
  await f.clock('2020-01-03T00:00:00Z');await expect(readMiningDevelopmentEvidence(f.conn.db,input(base,'2020-01-02'))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  expect(await readMiningDevelopmentEvidence(f.conn.db,input(base))).toEqual(past);
 }),30_000);
 it('suppresses pending initial construction, retains old upgrade level and never lazily completes a past day',async()=>fixture(async f=>{
  await f.clock('2020-01-01T10:00:00Z');const build=await f.job(f.forge,'build'),upgrade=await f.job(f.workshop);
  await f.clock('2020-01-02T12:00:00Z');const past=await f.read();expect(past.completed).toEqual({keep:[{id:f.keep,level:3}],workshop:[{id:f.workshop,level:2}],goldforge:[]});
  expect((await f.conn.sql`select completed_at from builder_jobs where id=${build}`)[0]!.completed_at).toBeNull();
  await f.conn.sql.begin(async tx=>{await tx`update builder_jobs set completed_at='2020-01-02T12:00:00Z' where id in (${build},${upgrade})`;await tx`update buildings set level=3 where id=${f.workshop}`;});
  await f.clock('2020-01-03T00:00:00Z');expect(await f.read()).toEqual(past);expect((await f.read('2020-01-02')).completed).toEqual({keep:[{id:f.keep,level:3}],workshop:[{id:f.workshop,level:3}],goldforge:[{id:f.forge,level:1}]});
 }),30_000);
 it('treats completed plus cancelled as cancellation without awarding an upgrade',async()=>fixture(async f=>{
  await f.clock('2020-01-01T10:00:00Z');const job=await f.job(f.workshop);
  const [debit]=await f.conn.sql`insert into ledger_transactions(idempotency_key,type) values(${randomUUID()},'fixture.development') returning id`;
  const [refund]=await f.conn.sql`insert into ledger_transactions(idempotency_key,type) values(${randomUUID()},'fixture.development') returning id`;
  await f.conn.sql`update builder_jobs set paid_shard_cost=1,debit_ledger_txn_id=${debit!.id},refund_ledger_txn_id=${refund!.id},cancel_idempotency_key=${randomUUID()},completed_at='2020-01-01T10:01:00Z',cancelled_at='2020-01-01T10:01:00Z' where id=${job}`;
  await f.clock('2020-01-02T00:00:00Z');expect((await f.read()).completed.workshop).toEqual([{id:f.workshop,level:2}]);
 }),30_000);
 it('keeps all same-transaction changes on its first mutation day across midnight and ignores rollback sequence gaps',async()=>fixture(async f=>{
  await f.clock('2020-01-01T10:00:00Z');const job=await f.job(f.workshop);
  await f.clock('2020-01-01T23:59:59Z');await f.conn.sql.begin(async tx=>{
   await tx`update buildings set level=3 where id=${f.workshop}`;
   await tx.unsafe("create or replace function public.shardkeep_mining_development_clock() returns timestamptz language sql volatile as $$ select '2020-01-02T00:00:01Z'::timestamptz $$");
   await tx`update builder_jobs set completed_at='2020-01-02T00:00:01Z' where id=${job}`;
  });
  const rejected=Error('fixture rollback');await expect(f.conn.sql.begin(async tx=>{await tx`update buildings set level=7 where id=${f.workshop}`;throw rejected;})).rejects.toBe(rejected);
  await f.clock('2020-01-02T12:00:00Z');const read=await f.read();expect(read.completed.workshop).toEqual([{id:f.workshop,level:3}]);
  expect(read.coverage.transactions.some(t=>t.eventIds.length===2&&t.observedAt==='2020-01-01T23:59:59.000Z')).toBe(true);
 }),30_000);
 it('preserves outgoing moves, transfer and deletion while refusing unproven incoming job context',async()=>fixture(async f=>{
  const target=randomUUID();await f.conn.sql`insert into bases(id,owner_wallet) values(${target},${f.buyer})`;
  await initializeMiningDevelopmentHistory(f.conn.db,target);await f.clock('2020-01-01T10:00:00Z');const job=await f.job(f.workshop);
  await f.conn.sql.begin(async tx=>{await tx`update bases set owner_wallet=${f.buyer} where id=${f.baseId}`;await tx`update buildings set base_id=${target} where id=${f.workshop}`;await tx`update builder_jobs set base_id=${target} where id=${job}`;await tx`delete from buildings where id=${f.forge}`;});
  await f.clock('2020-01-02T00:00:00Z');const old=await f.read();
  expect(old.base?.owner_wallet).toBe(f.buyer);expect(old.completed.workshop).toEqual([]);expect(old.completed.goldforge).toEqual([]);
  await expect(readMiningDevelopmentEvidence(f.conn.db,input(target))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  await f.clock('2020-01-02T10:00:00Z');await f.conn.sql`update buildings set level=4 where id=${f.workshop}`;await f.clock('2020-01-03T00:00:00Z');expect(await f.read()).toEqual(old);
 }),30_000);
 it('groups interleaved committed transaction IDs without requiring contiguous sequence numbers',async()=>fixture(async f=>{
  await f.clock('2020-01-01T10:00:00Z');
  let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{ready=r});
  const first=f.conn.sql.begin(async tx=>{await tx`update buildings set level=3 where id=${f.workshop}`;ready();await gate;await tx`update buildings set level=4 where id=${f.workshop}`;});
  try{await started;await f.conn.sql`update buildings set level=2 where id=${f.forge}`;}finally{release();await first;}
  await f.clock('2020-01-02T00:00:00Z');const result=await f.read();
  expect(result.completed.workshop).toEqual([{id:f.workshop,level:4}]);expect(result.completed.goldforge).toEqual([{id:f.forge,level:2}]);
  const interleaved=result.coverage.transactions.find(t=>t.eventIds.length===2)!;expect(BigInt(interleaved.eventIds[1]!)-BigInt(interleaved.eventIds[0]!)).toBeGreaterThan(1n);
 }),30_000);
 it('does not turn deletion of a pending initial-build job into completed development',async()=>fixture(async f=>{
  await f.clock('2020-01-01T10:00:00Z');const pending=await f.job(f.forge,'build');await f.conn.sql`delete from builder_jobs where id=${pending}`;
  await f.clock('2020-01-02T00:00:00Z');await expect(f.read()).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),30_000);
 it('refuses missing coverage, open days, caller authority and source writer contention',async()=>fixture(async f=>{
  await expect(f.read()).rejects.toMatchObject({code:'DAY_OPEN'});await f.clock('2020-01-02T00:00:00Z');
  await expect(readMiningDevelopmentEvidence(f.conn.db,input(randomUUID()))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});await expect(f.read('2019-12-31')).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  for(const extra of [{clock:'2020-01-02'},{level:20},{eligible:true}])await expect(readMiningDevelopmentEvidence(f.conn.db,{...input(f.baseId),...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r}),locked=new Promise<void>(r=>{ready=r});const writer=f.conn.sql.begin(async tx=>{await tx`lock table buildings in row exclusive mode`;ready();await gate;});
  try{await locked;await expect(f.read()).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
 }),30_000);
 it('refuses contradictory before-state order and oversized observed history instead of fabricating progress',async()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.conn.sql`update buildings set level=3 where id=${f.workshop}`;
  await f.clock('2020-01-01T11:00:00Z');await f.conn.sql`update buildings set level=4 where id=${f.workshop}`;
  await f.clock('2020-01-02T00:00:00Z');await expect(f.read()).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await f.clock('2020-01-02T12:00:00Z');await f.conn.sql.unsafe(`do $$ begin for i in 1..10001 loop update buildings set level=case when level=4 then 5 else 4 end where id='${f.workshop}'; end loop; end $$`);
  await f.clock('2020-01-03T00:00:00Z');await expect(f.read('2020-01-02')).rejects.toMatchObject({code:'TOO_LARGE'});
 }),60_000);
});
