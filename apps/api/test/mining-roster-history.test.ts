/** Historical roster facts must never imply paid replacement or deedlessness. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { initializeMiningRosterHistory, readMiningRosterHistory } from '../src/mining/rosterHistory';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){
 const f=await setup();try{await run(f);}finally{vi.unstubAllEnvs();await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}
}
async function setup(){
 const name=`mining_roster_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('fixture host required');url.pathname=`/${name}`;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await createMigratedDatabase(admin, name);const conn=createDb(url.toString(),{max:4});
 try{await runMigrations(conn.db);vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const clock=async(value:string)=>{if(!/^2035-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?Z$/.test(value))throw new Error('fixture clock');await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);};
 await clock('2035-01-01T12:00:00Z');const wallet=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58(),base=randomUUID(),other=randomUUID();
 await conn.sql`insert into players(wallet) values(${wallet}),(${buyer})`;
 await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet}),(${other},${buyer})`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base}),(${buyer},1,${other})`;
 const init=()=>initializeMiningRosterHistory(conn.db,wallet),read=(day='2035-01-02')=>readMiningRosterHistory(conn.db,{wallet,day,policyVersion:1});
 return {name,admin,conn,wallet,buyer,base,other,clock,init,read};
 }catch(e){vi.unstubAllEnvs();await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw e;}
}
describe('prospective registered-base roster history',()=>{
 it('captures all owned bases including inactive/pending, five slots and two free facts without granting eligibility',async()=>fixture(async f=>{
  for(let slot=2;slot<=5;slot++){const id=randomUUID();await f.conn.sql`insert into bases(id,owner_wallet,land_paid_at) values(${id},${f.wallet},${slot>2?'2035-01-01T00:00:00.123456Z':null})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},${slot},${id})`;}
  const pending=randomUUID();await f.conn.sql`insert into bases(id,owner_wallet,status,deed_mint_asset_id) values(${pending},${f.wallet},'inactive',${Keypair.generate().publicKey.toBase58()})`;
  const baseline=await f.init();expect(baseline.bases).toHaveLength(6);expect(baseline.slots).toHaveLength(5);expect(baseline.effectiveFrom).toBe('2035-01-02T00:00:00.000000Z');
  await expect(f.read()).rejects.toMatchObject({code:'DAY_OPEN'});
  await f.clock('2035-01-03T00:00:00Z');const result=await f.read();expect(result.close.bases).toHaveLength(6);expect(result.close.facts).toMatchObject({activeSlots:5,freeOwnedBases:2});
  await expect(f.read('2035-01-01')).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  expect(result).toMatchObject({eligibilityAuthorized:false,externalDeedOwnership:'unknown',historicalBirth:'unknown'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await f.init()).toEqual(baseline);
  await expect(initializeMiningRosterHistory(f.conn.db,f.buyer)).rejects.toMatchObject({code:'DISABLED'});
 }),30_000);
 it('keeps navigation/cosmetics out and records vacancy, replacement, transfer-out/back without restoring continuity',async()=>fixture(async f=>{
  await f.init();await initializeMiningRosterHistory(f.conn.db,f.buyer);await f.clock('2035-01-02T12:00:00.123456Z');
  await f.conn.sql`update base_slots set selected_at=now() where wallet=${f.wallet}`;await f.conn.sql`update bases set keep_level=2 where id=${f.base}`;
  expect(await f.conn.sql`select * from mining_roster_events`).toHaveLength(0);
  const added=randomUUID();await f.conn.sql.begin(async tx=>{await tx`insert into bases(id,owner_wallet) values(${added},${f.wallet})`;await tx`insert into base_slots(wallet,slot,base_id) values(${f.wallet},2,${added})`;});
  await f.conn.sql.begin(async tx=>{await tx`delete from base_slots where wallet=${f.wallet} and slot=2`;await tx`update base_slots set base_id=${added} where wallet=${f.wallet} and slot=1`;});
  await f.conn.sql`update bases set owner_wallet=${f.buyer} where id=${f.base}`;await f.conn.sql`update bases set owner_wallet=${f.wallet} where id=${f.base}`;
  await f.clock('2035-01-03T00:00:00Z');const r=await f.read();expect(r.open.bases).toHaveLength(1);expect(r.close.bases).toHaveLength(2);
  expect(r.continuityBrokenBaseIds).toContain(f.base);expect(r.changes.some(e=>e.sourceTable==='base_slots'&&e.beforeState===null)).toBe(true);
  expect(r.changes.some(e=>e.sourceTable==='base_slots'&&e.beforeState!==null&&e.afterState!==null)).toBe(true);
  expect(r.replacementAuthorized).toBe(false);
 }),30_000);
 it('uses first mutation time across midnight, ignores rollback and canonicalizes session zones/microseconds',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-02T23:59:59.123456Z');
  await f.conn.sql.begin(async tx=>{await tx`set local timezone='Asia/Tbilisi'`;await tx`update bases set land_paid_at='2035-01-02T14:00:00.123456Z' where id=${f.base}`;
   await tx.unsafe("create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '2035-01-03T00:00:01Z'::timestamptz $$");
   await tx`update bases set land_paid_at='2035-01-02T14:00:00.123457Z' where id=${f.base}`;});
  await expect(f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.base}`;throw new Error('rollback');})).rejects.toThrow('rollback');
  const r=await f.read();expect(r.changes).toHaveLength(2);expect(new Set(r.changes.map(e=>e.txKey)).size).toBe(1);
  expect(r.changes[0]!.observedAt).toBe('2035-01-02T23:59:59.123456Z');expect(r.close.bases[0]!.land_paid_at).toBe('2035-01-02T14:00:00.123457Z');
 }),30_000);
 it('stays dormant under RC, rejects stale roster writes after activation, and dates an old untouched transaction at its first mutation',async()=>fixture(async f=>{
  // Global Charter custody now fences base writers even before roster capture.
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`update bases set keep_level=2 where id=${f.base}`;}))
   .rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_CUSTODY_READ_COMMITTED'});
  expect((await f.conn.sql`select keep_level from bases where id=${f.base}`)[0]!.keep_level).toBe(1);
  await f.conn.sql`update bases set keep_level=2 where id=${f.base}`;
  expect(await f.conn.sql`select * from mining_roster_events`).toHaveLength(0);
  let release!:()=>void,ready!:()=>void;let gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{ready=r});
  const old=f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select count(*) from accounts`;ready();await gate;await tx`update base_slots set active=false where wallet=${f.wallet}`;});
  await started;try{await f.init();}finally{release();}await expect(old).rejects.toMatchObject({code:'P0001',message:'MINING_ROSTER_READ_COMMITTED_REQUIRED'});
  expect((await f.conn.sql`select active from base_slots where wallet=${f.wallet}`)[0]!.active).toBe(true);
  gate=new Promise<void>(r=>{release=r});started=new Promise<void>(r=>{ready=r});
  const untouched=f.conn.sql.begin(async tx=>{await tx`select count(*) from players`;ready();await gate;await tx`update bases set status='inactive' where id=${f.base}`;});
  await started;await f.clock('2035-01-03T12:00:00Z');release();await untouched;expect((await f.read()).changes).toHaveLength(0);
  await f.clock('2035-01-04T00:00:00Z');expect((await f.read('2035-01-03')).changes).toHaveLength(1);
 }),30_000);
 it('refuses marked baseline transactions, busy readers and clocks before coverage',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-02T12:00:00Z');
  await expect(f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.base}`;await tx`insert into mining_roster_baselines(wallet) values(${f.buyer})`;})).rejects.toThrow('MINING_ROSTER_BASELINE_REQUIRES_FRESH_TRANSACTION');
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.base}`;ready();await gate;});
  try{await started;await expect(f.read()).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  await f.conn.sql.unsafe("create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '2034-12-31T00:00:00Z'::timestamptz $$");
  await expect(f.conn.sql`update bases set status='active' where id=${f.base}`).rejects.toThrow('MINING_ROSTER_CLOCK_BEFORE_BASELINE');
 }),30_000);
 it('rejects broad-grant runtime journal/trigger forgery while admitting real writes, and preserves migration retries',async()=>fixture(async f=>{
  await f.init();const role=`mining_roster_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role}`);
  try{await f.conn.sql.unsafe(`grant usage on schema public to ${role}; grant all on all tables in schema public to ${role}; grant all on all sequences in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
   for(const table of ['mining_roster_baselines','mining_roster_events','mining_roster_transactions'])await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(`insert into ${table} default values`);})).rejects.toThrow('MINING_ROSTER_HISTORY_IMMUTABLE');
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`create temporary table forged(wallet text)`;await tx`create trigger bases_mining_roster_capture after insert on forged for each row execute function public.shardkeep_capture_mining_roster()`;await tx`insert into forged values(${f.wallet})`;})).rejects.toThrow('MINING_ROSTER_SOURCE_INVALID');
   await f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`update bases set status='inactive' where id=${f.base}`;});
  }finally{await f.conn.sql.unsafe(`drop owned by ${role}`);await f.conn.sql.unsafe(`drop role ${role}`);}
  for(const t of ['mining_roster_baselines','mining_roster_events','mining_roster_transactions']){await expect(f.conn.sql.unsafe(`delete from ${t}`)).rejects.toThrow('MINING_ROSTER_HISTORY_IMMUTABLE');await expect(f.conn.sql.unsafe(`truncate ${t}`)).rejects.toThrow('MINING_ROSTER_HISTORY_IMMUTABLE');}
  for(const statement of readFileSync(new URL('../drizzle/0167_mining_roster_history.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await f.conn.sql.unsafe(statement);
  await f.clock('2035-01-02T12:00:00Z');await f.conn.sql`delete from base_slots where wallet=${f.wallet}`;await f.conn.sql`delete from bases where id=${f.base}`;
  await f.clock('2035-01-03T00:00:00Z');expect((await f.read()).close.bases).toHaveLength(0);
 }),30_000);
});
