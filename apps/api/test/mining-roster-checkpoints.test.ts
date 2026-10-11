/** A later snapshot records only locked, committed registered facts; it never backfills the original baseline. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Keypair} from '@solana/web3.js';
import {describe,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {captureMiningRosterCheckpoint} from '../src/mining/rosterCheckpoints';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {FRESH_DB_CASE_MS} from './freshDbCaseBudgets';
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{vi.unstubAllEnvs();await f.conn.close();}}
async function setup(){
 const conn=resourceClaimsDatabase();await conn.setup();vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const wallet=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58(),base=randomUUID();
 await conn.sql`insert into players(wallet) values(${wallet}),(${buyer})`;await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet})`;await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base})`;
 const clock=async(value:string)=>{if(!/^2035-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value))throw Error('fixture clock');await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);};
 await clock('2035-01-01T12:00:00.000001Z');const init=()=>initializeMiningRosterHistory(conn.db,wallet);
 const capture=()=>conn.sql`insert into mining_roster_checkpoints(wallet) values(${wallet}) on conflict(wallet,event_frontier) do nothing`;
 const rows=()=>conn.sql`select id,wallet,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,event_frontier::text,bases,slots from mining_roster_checkpoints where wallet=${wallet} order by event_frontier`;
 return {conn,wallet,buyer,base,clock,init,capture,rows};
}
describe('prospective immutable registered-roster checkpoints',()=>{
 it('captures a later base and complete wallet facts at microsecond precision without changing the original baseline',async()=>fixture(async f=>{
  const baseline=await f.init(),added=randomUUID();await f.clock('2035-01-01T12:01:00.123456Z');
  await f.conn.sql.begin(async tx=>{await tx`insert into bases(id,owner_wallet,status) values(${added},${f.wallet},'inactive')`;await tx`insert into base_slots(wallet,slot,base_id) values(${f.wallet},2,${added})`;});
  await f.clock('2035-01-01T12:02:00.234567Z');await f.capture();const [checkpoint]=await f.rows();
  const [frontier]=await f.conn.sql`select max(id)::text id from mining_roster_events where wallet=${f.wallet}`;
  expect(checkpoint).toMatchObject({wallet:f.wallet,observed_at:'2035-01-01T12:02:00.234567Z',event_frontier:frontier!.id});
  expect(checkpoint!.bases).toHaveLength(2);expect(checkpoint!.slots).toHaveLength(2);expect(checkpoint!.bases).toContainEqual(expect.objectContaining({id:added,status:'inactive'}));
  expect(await f.init()).toEqual(baseline);expect(baseline.bases).toHaveLength(1);
 }),FRESH_DB_CASE_MS);
 it('retains the earliest unchanged snapshot and advances the frontier for out-and-back facts even when final state is identical',async()=>fixture(async f=>{
  await f.init();await f.capture();const original=await f.rows();await f.clock('2035-01-01T12:03:00.000000Z');
  await f.conn.sql`update bases set keep_level=2 where id=${f.base}`;await f.conn.sql`update base_slots set selected_at=now() where wallet=${f.wallet}`;
  await expect(f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.base}`;throw Error('rollback');})).rejects.toThrow('rollback');
  await f.capture();expect(await f.rows()).toEqual(original);
  await f.conn.sql.begin(async tx=>{await tx`update bases set owner_wallet=${f.buyer} where id=${f.base}`;await tx`update bases set owner_wallet=${f.wallet} where id=${f.base}`;});
  await f.capture();const rows=await f.rows();expect(rows).toHaveLength(2);expect(rows[1]!.bases).toEqual(original[0]!.bases);expect(rows[1]!.slots).toEqual(original[0]!.slots);
  expect(BigInt(rows[1]!.event_frontier)).toBeGreaterThan(BigInt(original[0]!.event_frontier));expect(rows[0]).toEqual(original[0]);
 }),FRESH_DB_CASE_MS);
 it('derives identity, canonical clock, wallet frontier and full facts despite forged caller fields and unrelated sequence growth',async()=>fixture(async f=>{
  await f.init();await initializeMiningRosterHistory(f.conn.db,f.buyer);await f.clock('2035-01-01T12:04:00.123456Z');
  await f.conn.sql`insert into bases(id,owner_wallet) values(${randomUUID()},${f.buyer})`;const invented=randomUUID();
  await f.conn.sql.begin(async tx=>{await tx`set local timezone='Asia/Tbilisi'`;await tx`insert into mining_roster_checkpoints(id,wallet,observed_at,event_frontier,bases,slots) values(${invented},${f.wallet},'1900-01-01',9223372036854775807,'[]','[]')`;});
  const [row]=await f.rows();expect(row!.id).not.toBe(invented);expect(row).toMatchObject({observed_at:'2035-01-01T12:04:00.123456Z',event_frontier:'0'});expect(row!.bases).toHaveLength(1);expect(row!.slots).toHaveLength(1);
  expect((await f.conn.sql`select max(id)::text n from mining_roster_events`)[0]!.n).not.toBeNull();
 }),FRESH_DB_CASE_MS);
 it('requires an existing enrollment and a fresh top-level roster transaction rather than blessing uncommitted writes',async()=>fixture(async f=>{
  await expect(f.capture()).rejects.toThrow(/MINING_ROSTER_/);expect(await f.rows()).toHaveLength(0);await f.init();
  await expect(f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.base}`;await tx`savepoint nested`;await tx`insert into mining_roster_checkpoints(wallet) values(${f.wallet})`;})).rejects.toThrow(/MINING_ROSTER_.*FRESH_TRANSACTION/);
  expect((await f.conn.sql`select status from bases where id=${f.base}`)[0]!.status).toBe('active');expect(await f.rows()).toHaveLength(0);await f.capture();expect(await f.rows()).toHaveLength(1);
 }),FRESH_DB_CASE_MS);
 it('refuses stale repeatable-read and serializable snapshots even if their visible baseline looks current',async()=>fixture(async f=>{
  await f.init();for(const isolation of ['repeatable read','serializable'])await expect(f.conn.sql.begin('isolation level '+isolation,async tx=>{
   await tx`select count(*) from accounts`;await f.conn.sql`update bases set keep_level=keep_level+1 where id=${f.base}`;
   await tx`insert into mining_roster_checkpoints(wallet) values(${f.wallet})`;
  })).rejects.toThrow('MINING_ROSTER_READ_COMMITTED_REQUIRED');expect(await f.rows()).toHaveLength(0);
 }),FRESH_DB_CASE_MS);
 it('cannot skip an uncommitted lower event id and includes its complete group after the actual source barrier clears',async()=>fixture(async f=>{
  await f.init();await initializeMiningRosterHistory(f.conn.db,f.buyer);await f.clock('2035-01-01T12:05:00.000000Z');
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.base}`;await tx`update bases set status='active' where id=${f.base}`;ready();await gate;});
  try{await started;await f.conn.sql`insert into bases(id,owner_wallet) values(${randomUUID()},${f.buyer})`;
   await expect(f.capture()).rejects.toMatchObject({code:'55P03'});expect(await f.rows()).toHaveLength(0);
  }finally{release();await writer;}
  await f.capture();const [row]=await f.rows(),events=await f.conn.sql`select id::text,tx_key from mining_roster_events where wallet=${f.wallet} order by id`;
  expect(events).toHaveLength(2);expect(events[0]!.tx_key).toBe(events[1]!.tx_key);expect(row!.event_frontier).toBe(events[1]!.id);
  expect(BigInt((await f.conn.sql`select max(id)::text id from mining_roster_events`)[0]!.id)).toBeGreaterThan(BigInt(row!.event_frontier));
 }),FRESH_DB_CASE_MS);
 it('holds clock regression against baseline, later committed events and prior checkpoints without rewriting history',async()=>fixture(async f=>{
  await f.init();await f.clock('2035-01-01T12:00:00.000000Z');await expect(f.capture()).rejects.toThrow(/MINING_ROSTER_/);
  await f.clock('2035-01-01T12:06:00.000000Z');await f.conn.sql`update bases set status='inactive' where id=${f.base}`;
  await f.clock('2035-01-01T12:05:59.999999Z');await expect(f.capture()).rejects.toThrow(/MINING_ROSTER_/);
  await f.clock('2035-01-01T12:07:00.000000Z');await f.capture();const prior=await f.rows();
  await f.clock('2035-01-01T12:06:00.000001Z');await f.conn.sql`update bases set status='active' where id=${f.base}`;
  await expect(f.capture()).rejects.toThrow(/MINING_ROSTER_/);expect(await f.rows()).toEqual(prior);
  await f.conn.sql.unsafe("create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select 'infinity'::timestamptz $$");
  await expect(f.capture()).rejects.toThrow(/MINING_ROSTER_/);expect(await f.rows()).toEqual(prior);
 }),FRESH_DB_CASE_MS);
 it('bounds the entire wallet snapshot rather than silently omitting newly registered bases',async()=>fixture(async f=>{
  await f.init();await f.conn.sql`insert into bases(id,owner_wallet,status) select gen_random_uuid(),${f.wallet},'inactive' from generate_series(1,10000)`;
  await expect(f.capture()).rejects.toThrow('MINING_ROSTER_TOO_LARGE');expect(await f.rows()).toHaveLength(0);
 }),FRESH_DB_CASE_MS);
 it('retains immutable checkpoints and existing capture behavior across two raw migration repeats',async()=>fixture(async f=>{
  await f.init();await f.capture();const rows=await f.rows(),baseline=await f.init();
  for(const command of ["update mining_roster_checkpoints set observed_at=observed_at","delete from mining_roster_checkpoints","truncate mining_roster_checkpoints"])
   await expect(f.conn.sql.unsafe(command)).rejects.toThrow(/MINING_ROSTER_.*IMMUTABLE/);
  const before=await f.conn.sql`select c.relname,c.oid::text from pg_class c where c.oid in ('mining_roster_baselines'::regclass,'mining_roster_events'::regclass,'mining_roster_checkpoints'::regclass) order by c.relname`;
  for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL('../drizzle/0203_mining_roster_checkpoints.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});
  expect(await f.rows()).toEqual(rows);expect(await f.init()).toEqual(baseline);expect(await f.conn.sql`select c.relname,c.oid::text from pg_class c where c.oid in ('mining_roster_baselines'::regclass,'mining_roster_events'::regclass,'mining_roster_checkpoints'::regclass) order by c.relname`).toEqual(before);
  await f.conn.sql`update bases set status='inactive' where id=${f.base}`;expect(await f.conn.sql`select id from mining_roster_events where wallet=${f.wallet}`).toHaveLength(1);
 }),FRESH_DB_CASE_MS);
 it('keeps a non-owner LOGIN private and rejects fabricated capture even after accidental broad grants',async()=>fixture(async f=>{
  await f.init();await f.capture();const original=await f.rows(),role='roster_checkpoint_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{const [database]=await f.conn.sql`select current_database() name`;await f.conn.sql.unsafe(`grant connect on database ${database!.name} to ${role};grant usage on schema public to ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:2});
   expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);
   expect(await runtime.sql`select has_table_privilege(current_user,'mining_roster_checkpoints','SELECT') r,has_table_privilege(current_user,'mining_roster_checkpoints','INSERT') w`).toEqual([{r:false,w:false}]);
   await expect(runtime.sql`select * from mining_roster_checkpoints`).rejects.toMatchObject({code:'42501'});
   await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role};grant all on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
   for(const statement of ["insert into mining_roster_checkpoints(wallet) values('forged')","update mining_roster_checkpoints set observed_at=observed_at","delete from mining_roster_checkpoints","truncate mining_roster_checkpoints"])
    await expect(runtime.sql.unsafe(statement)).rejects.toThrow(/MINING_ROSTER_.*IMMUTABLE/);
   await expect(runtime.sql.begin(async tx=>{await tx`create temporary table forged(wallet text)`;await tx`create trigger mining_roster_checkpoints_immutable before insert on forged for each row execute function public.shardkeep_mining_roster_checkpoint_guard()`;await tx`insert into forged values(${f.wallet})`;})).rejects.toThrow(/MINING_ROSTER_.*IMMUTABLE/);
   await runtime.sql`update bases set status='inactive' where id=${f.base}`;expect(await f.conn.sql`select id from mining_roster_events where wallet=${f.wallet}`).toHaveLength(1);expect(await f.rows()).toEqual(original);
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),FRESH_DB_CASE_MS);

 it('keeps the service dark while paused, rejects a caller transaction and exposes no snapshot authority',async()=>fixture(async f=>{
  await f.init();vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(captureMiningRosterCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'DISABLED'});expect(await f.rows()).toHaveLength(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');for(const value of ['', 'x'.repeat(129)])await expect(captureMiningRosterCheckpoint(f.conn.db,value)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.conn.db.transaction(tx=>captureMiningRosterCheckpoint(tx as unknown as Db,f.wallet))).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(captureMiningRosterCheckpoint(f.conn.db,f.wallet)).resolves.toBeUndefined();const original=await f.rows();
  await f.clock('2035-01-01T12:09:00.000000Z');await expect(captureMiningRosterCheckpoint(f.conn.db,f.wallet)).resolves.toBeUndefined();expect(await f.rows()).toEqual(original);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(captureMiningRosterCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'DISABLED'});expect(await f.rows()).toEqual(original);
 }),FRESH_DB_CASE_MS);
 it('maps a real source lock to retryable BUSY and succeeds after the source transaction rolls back',async()=>fixture(async f=>{
  await f.init();let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.base}`;ready();await gate;throw Error('intentional rollback');}).catch(error=>{if(error.message!=='intentional rollback')throw error;});
  try{await started;await expect(captureMiningRosterCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'BUSY'});expect(await f.rows()).toHaveLength(0);}finally{release();await writer;}
  await captureMiningRosterCheckpoint(f.conn.db,f.wallet);expect((await f.rows())[0]!.event_frontier).toBe('0');expect(await f.conn.sql`select id from mining_roster_events where wallet=${f.wallet}`).toHaveLength(0);
 }),FRESH_DB_CASE_MS);
 it('converges simultaneous owner attempts and explicit contention retries to one immutable observation',async()=>fixture(async f=>{
  await f.init();const attempts=await Promise.allSettled([captureMiningRosterCheckpoint(f.conn.db,f.wallet),captureMiningRosterCheckpoint(f.conn.db,f.wallet)]);
  for(const result of attempts)if(result.status==='rejected')expect(result.reason).toMatchObject({code:'BUSY'});else expect(result.value).toBeUndefined();
  await captureMiningRosterCheckpoint(f.conn.db,f.wallet);const rows=await f.rows();expect(rows).toHaveLength(1);
  await f.clock('2035-01-01T12:10:00.000000Z');await captureMiningRosterCheckpoint(f.conn.db,f.wallet);expect(await f.rows()).toEqual(rows);
 }),FRESH_DB_CASE_MS);

});
