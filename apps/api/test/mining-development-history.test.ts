/** Prospective source capture, never lazy completion or retrospective scoring. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { initializeMiningDevelopmentHistory } from '../src/mining/developmentHistory';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>) {
 const f=await setup();try{await run(f);}finally{vi.unstubAllEnvs();await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}
}
async function setup(){
 const name=`mining_development_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('fixture host required');url.pathname=`/${name}`;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await createMigratedDatabase(admin, name);const conn=createDb(url.toString(),{max:4});
 try{await runMigrations(conn.db);vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const clock=async(value:string)=>{if(!/^2035-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))throw new Error('fixture clock');await conn.sql.unsafe(`create or replace function public.shardkeep_mining_development_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);};
 await clock('2035-01-01T12:00:00Z');
 const wallet=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58(),base=randomUUID(),other=randomUUID(),keep=randomUUID(),workshop=randomUUID(),job=randomUUID();
 await conn.sql`insert into players(wallet) values(${wallet}),(${buyer})`;
 await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${base},${wallet},4),(${other},${buyer},1)`;
 await conn.sql`insert into buildings(id,player_wallet,base_id,type,level,tx,ty) values(${keep},${wallet},${base},'keep',4,10,10),(${workshop},${wallet},${base},'workshop',1,20,20)`;
 await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${job},${wallet},${base},${workshop},'build','2035-01-01T11:00:00Z','2035-01-01T11:30:00Z')`;
 const init=()=>initializeMiningDevelopmentHistory(conn.db,base);
 return {name,url,admin,conn,wallet,buyer,base,other,keep,workshop,job,clock,init};
 }catch(e){vi.unstubAllEnvs();await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw e;}
}
describe('prospective mining development capture',()=>{
 it('freezes pending initial construction and completed levels without completing overdue jobs',async()=>fixture(async f=>{
  const baseline=await f.init();expect(baseline.effectiveFrom).toBe('2035-01-02T00:00:00.000Z');
  expect(baseline.buildings).toContainEqual({id:f.workshop,base_id:f.base,type:'workshop',level:1});
  expect(baseline.jobs).toContainEqual(expect.objectContaining({id:f.job,kind:'build',completed_at:null,cancelled_at:null}));
  await f.conn.sql`update buildings set tx=21 where id=${f.workshop}`;expect(await f.conn.sql`select * from mining_development_events`).toHaveLength(0);
  await f.clock('2035-01-02T12:00:00Z');await f.conn.sql.begin(async tx=>{
   await tx`update builder_jobs set completed_at='2035-01-02T11:59:00Z' where id=${f.job}`;
   await tx`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${f.wallet},${f.base},${f.keep},'upgrade','2035-01-02T12:00:00Z','2035-01-03T00:00:00Z')`;
  });
  const events=await f.conn.sql`select * from mining_development_events order by id`;expect(events).toHaveLength(2);
  expect(events[0]!.after_state).toMatchObject({completed_at:'2035-01-02T11:59:00+00:00'});
  expect(events[1]!.after_state).toMatchObject({kind:'upgrade',completed_at:null});
  expect(await f.init()).toEqual(baseline);vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await f.init()).toEqual(baseline);
  await expect(initializeMiningDevelopmentHistory(f.conn.db,f.other)).rejects.toMatchObject({code:'DISABLED'});
 }),30_000);
 it('groups completion changes across midnight and retains rolled-back or cancelled distinctions',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-02T23:59:59Z');
  await f.conn.sql.begin(async tx=>{
   await tx`update builder_jobs set completed_at='2035-01-02T23:59:59Z' where id=${f.job}`;
   await tx.unsafe("create or replace function public.shardkeep_mining_development_clock() returns timestamptz language sql volatile as $$ select '2035-01-03T00:00:01Z'::timestamptz $$");
   await tx`update buildings set level=5 where id=${f.keep}`;await tx`update bases set keep_level=5 where id=${f.base}`;
  });
  const rows=await f.conn.sql`select tx_key,observed_at from mining_development_events`;expect(rows).toHaveLength(3);
  expect(new Set(rows.map(r=>r.tx_key)).size).toBe(1);expect(new Set(rows.map(r=>new Date(r.observed_at).toISOString()))).toEqual(new Set(['2035-01-02T23:59:59.000Z']));
  await expect(f.conn.sql.begin(async tx=>{await tx`update buildings set level=9 where id=${f.keep}`;throw new Error('rollback');})).rejects.toThrow('rollback');
  expect(await f.conn.sql`select * from mining_development_events`).toHaveLength(3);
  // Cancellation shape is distinct even though completed_at is populated. The
  // fixture bypasses only the pre-existing refund-state check to isolate capture.
  await f.conn.sql`alter table builder_jobs drop constraint builder_jobs_cancel_state_ck`;
  await f.conn.sql`update builder_jobs set kind='upgrade',cancelled_at='2035-01-03T00:00:02Z' where id=${f.job}`;
  expect((await f.conn.sql`select after_state from mining_development_events order by id desc limit 1`)[0]!.after_state).toMatchObject({kind:'upgrade',cancelled_at:'2035-01-03T00:00:02+00:00'});
 }),30_000);
 it('captures both sides of reassignment and preserves history after source deletion',async()=>fixture(async f=>{
  const original=await f.init();await initializeMiningDevelopmentHistory(f.conn.db,f.other);await f.clock('2035-01-02T12:00:00Z');
  await f.conn.sql`update buildings set base_id=${f.other} where id=${f.keep}`;
  const moved=await f.conn.sql`select * from mining_development_events order by base_id`;expect(moved).toHaveLength(2);expect(new Set(moved.map(r=>r.base_id))).toEqual(new Set([f.base,f.other]));
  await f.conn.sql`update bases set owner_wallet=${f.buyer} where id=${f.base}`;
  await f.conn.sql`delete from builder_jobs where base_id=${f.base}`;await f.conn.sql`delete from buildings where base_id=${f.base}`;
  await f.conn.sql`delete from bases where id=${f.base}`;expect(await f.init()).toEqual(original);
  expect((await f.conn.sql`select * from mining_development_events where source_table='bases' and after_state is null`)).toHaveLength(1);
 }),30_000);
 it('stays dormant under RC before explicit activation while global custody rejects stale base snapshots',async()=>fixture(async f=>{
  // 0218 now guards base writes before development enrollment, just as 0205
  // guards building provenance. Both stale writes must leave the source intact.
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`update bases set keep_level=5 where id=${f.base}`;}))
   .rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_CUSTODY_READ_COMMITTED'});
  expect((await f.conn.sql`select keep_level from bases where id=${f.base}`)[0]!.keep_level).toBe(4);
  await f.conn.sql`update bases set keep_level=5 where id=${f.base}`;
  expect((await f.conn.sql`select keep_level from bases where id=${f.base}`)[0]!.keep_level).toBe(5);
  expect(await f.conn.sql`select * from mining_development_events`).toHaveLength(0);
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const old=f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select count(*) from players`;ready();await gate;await tx`update bases set keep_level=6 where id=${f.base}`;});
  await started;await f.init();release();await expect(old).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_CUSTODY_READ_COMMITTED'});
  expect(await f.conn.sql`select * from mining_development_events`).toHaveLength(0);
  expect((await f.conn.sql`select keep_level from bases where id=${f.base}`)[0]!.keep_level).toBe(5);
 }),30_000);
 it('uses first captured mutation time for old transactions and rejects a clock before baseline',async()=>fixture(async f=>{
  await f.init();let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const old=f.conn.sql.begin(async tx=>{await tx`select count(*) from players`;ready();await gate;await tx`update buildings set level=5 where id=${f.keep}`;});
  await started;await f.clock('2035-01-03T12:00:00Z');release();await old;
  expect(new Date((await f.conn.sql`select observed_at from mining_development_events`)[0]!.observed_at).toISOString()).toBe('2035-01-03T12:00:00.000Z');
  await f.conn.sql.unsafe("create or replace function public.shardkeep_mining_development_clock() returns timestamptz language sql volatile as $$ select '2034-12-31T12:00:00Z'::timestamptz $$");
  await expect(f.conn.sql`update buildings set level=6 where id=${f.keep}`).rejects.toThrow('MINING_DEVELOPMENT_CLOCK_BEFORE_BASELINE');
 }),30_000);
 it('rejects runtime forgery, keeps journals immutable and preserves activation on migration retry',async()=>fixture(async f=>{
  await f.init();const role=`mining_dev_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role}`);
  try{await f.conn.sql.unsafe(`grant usage on schema public to ${role}; grant all on all tables in schema public to ${role}; grant all on all sequences in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
   for(const table of ['mining_development_baselines','mining_development_transactions','mining_development_events'])await expect(f.conn.sql.begin(async tx=>{
    await tx.unsafe(`set local role ${role}`);await tx`select set_config('shardkeep.mining_development_owner','true',true)`;
    if(table==='mining_development_baselines')await tx`insert into mining_development_baselines(base_id) values(${f.other})`;
    else if(table==='mining_development_transactions')await tx`insert into mining_development_transactions(tx_key) values('forged')`;
    else await tx`insert into mining_development_events(base_id) values(${f.base})`;
   })).rejects.toThrow('MINING_DEVELOPMENT_HISTORY_IMMUTABLE');
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`create temporary table forged (id uuid)`;
    await tx`create trigger bases_mining_development_capture after insert on forged for each row execute function public.shardkeep_capture_mining_development()`;
    await tx`insert into forged values(${f.base})`;
   })).rejects.toThrow('MINING_DEVELOPMENT_SOURCE_INVALID');
   await f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`update buildings set level=5 where id=${f.keep}`;});
  }finally{await f.conn.sql.unsafe(`drop owned by ${role}`);await f.conn.sql.unsafe(`drop role ${role}`);}
  expect(await f.conn.sql`select * from mining_development_events`).toHaveLength(1);
  for(const table of ['mining_development_baselines','mining_development_events','mining_development_transactions']){
   await expect(f.conn.sql.unsafe(`delete from ${table}`)).rejects.toThrow('MINING_DEVELOPMENT_HISTORY_IMMUTABLE');
   await expect(f.conn.sql.unsafe(`truncate ${table}`)).rejects.toThrow('MINING_DEVELOPMENT_HISTORY_IMMUTABLE');
  }
  const migration=readFileSync(new URL('../drizzle/0165_mining_development_history.sql',import.meta.url),'utf8');
  for(const statement of migration.split('--> statement-breakpoint'))if(statement.trim())await f.conn.sql.unsafe(statement);
  await f.clock('2035-01-02T12:00:00Z');
  await f.conn.sql`update buildings set level=6 where id=${f.keep}`;expect(await f.conn.sql`select * from mining_development_events`).toHaveLength(2);
 }),30_000);
 it('refuses busy source snapshots and new baselines inside an already marked transaction',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-02T12:00:00Z');
  await expect(f.conn.sql.begin(async tx=>{
   await tx`update buildings set level=5 where id=${f.keep}`;
   await tx`insert into mining_development_baselines(base_id) values(${f.other})`;
  })).rejects.toThrow('MINING_DEVELOPMENT_BASELINE_REQUIRES_FRESH_TRANSACTION');
  expect(await f.conn.sql`select * from mining_development_events`).toHaveLength(0);
  let ready!:()=>void,release!:()=>void;const held=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`update buildings set level=5 where id=${f.keep}`;ready();await gate;});
  try{await held;await expect(initializeMiningDevelopmentHistory(f.conn.db,f.other)).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  expect(await f.conn.sql`select * from mining_development_baselines where base_id=${f.other}`).toHaveLength(0);
 }),30_000);

 it('refuses a baseline that would omit a pending job retained on the previous base',async()=>fixture(async f=>{
  await f.init();await f.conn.sql`update buildings set base_id=${f.other} where id=${f.workshop}`;
  await expect(initializeMiningDevelopmentHistory(f.conn.db,f.other)).rejects.toMatchObject({cause:{message:'MINING_DEVELOPMENT_SOURCE_CONFLICT'}});
  expect(await f.conn.sql`select * from mining_development_baselines where base_id=${f.other}`).toHaveLength(0);
 }),30_000);

 it('records a foreign-base job on the actual building base as conflicting provenance',async()=>fixture(async f=>{
  await f.init();await initializeMiningDevelopmentHistory(f.conn.db,f.other);const foreignJob=randomUUID();
  await f.conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at)
   values(${foreignJob},${f.buyer},${f.other},${f.workshop},'build',now(),now())`;
  const rows=await f.conn.sql`select base_id,after_state from mining_development_events where source_id=${foreignJob}`;
  expect(rows).toHaveLength(2);expect(new Set(rows.map(r=>r.base_id))).toEqual(new Set([f.base,f.other]));
  expect(rows.every(r=>r.after_state.base_id===f.other&&r.after_state.building_id===f.workshop)).toBe(true);
 }),30_000);

});
