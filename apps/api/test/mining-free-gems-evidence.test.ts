import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { describe,it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapSystemAccounts,getOrCreatePlayerAccount,postTransaction } from '../src/ledger';
import { grantGems,fundGemsRewardBudget } from '../src/game/gemsGrants';
import { initializeFreeCohortCoverage } from '../src/mining/freeCohort';
import { initializeFreeGemsEvidence,readFreeGemsEvidence } from '../src/mining/freeGemsEvidence';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,initialize=true,cohort=true){const f=await setup(initialize,cohort);try{await run(f);}finally{vi.unstubAllEnvs();await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}}
async function setup(initialize:boolean,cohort:boolean){
 const name=`free_gems_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('local fixture required');url.pathname=`/${name}`;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await createMigratedDatabase(admin, name);const conn=createDb(url.toString(),{max:4});
 try{await runMigrations(conn.db);vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  const clock=async(at:string)=>conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '${at}'::timestamptz $$`);
  await clock('2035-01-01T00:00:00Z');if(cohort)await initializeFreeCohortCoverage(conn.db);if(initialize)await initializeFreeGemsEvidence(conn.db);
  const wallet=Keypair.generate().publicKey.toBase58();await conn.sql`insert into players(wallet,created_at) values(${wallet},'2035-01-01T00:00:00Z')`;
  const sys=await bootstrapSystemAccounts(conn.db),gems=await getOrCreatePlayerAccount(conn.db,wallet,'player_gems'),keep=await getOrCreatePlayerAccount(conn.db,wallet,'player_keep');
  await postTransaction(conn.db,{idempotencyKey:randomUUID(),type:'fixture.keep',entries:[{account:sys.keep_genesis,delta:-100n},{account:keep.id,delta:100n}]});
  const mint=async(type:string)=>postTransaction(conn.db,{idempotencyKey:randomUUID(),type,metadata:{wallet,reason:'keep_conversion',gems:'10'},entries:[{account:keep.id,delta:-10n},{account:sys.emission_pool,delta:10n},{account:sys.gems_mint,delta:-10n},{account:gems.id,delta:10n}]});
  const read=()=>readFreeGemsEvidence(conn.db,{wallet,day:'2035-01-01'});
  return {name,url,admin,conn,wallet,sys,gems,keep,clock,mint,read};
 }catch(error){vi.unstubAllEnvs();await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw error;}
}
describe('prospective all-origin Gems evidence',()=>{
 it('rejects a fake TEMP players birth trigger before and after migration retry',async()=>fixture(async f=>{
  await f.mint('gems.late_credit'); // Real legacy credit exists before either coverage boundary.
  await f.clock('2035-01-01T12:00:00Z');await initializeFreeCohortCoverage(f.conn.db);await initializeFreeGemsEvidence(f.conn.db);
  const role=`free_birth_${randomUUID().replaceAll('-','')}`;await f.admin.unsafe(`create role ${role}`);
  try{
   await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}; grant all on all sequences in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
   const forge=()=>f.conn.sql.begin(async tx=>{
    await tx.unsafe(`set local role ${role}`);
    await tx`create temporary table players(wallet text,created_at timestamptz) on commit drop`;
    await tx`create trigger players_mining_free_capture after insert on pg_temp.players for each row execute function public.shardkeep_capture_mining_free()`;
    await tx`insert into pg_temp.players(wallet,created_at) values(${f.wallet},'2035-01-01T12:00:00Z')`;
   });
   await expect(forge()).rejects.toThrow('MINING_FREE_SOURCE_INVALID');
   expect(await f.conn.sql`select id from mining_free_cohort_events where wallet=${f.wallet} and source_table='players'`).toHaveLength(0);
   await f.conn.sql.unsafe(readFileSync(new URL('../drizzle/0166_mining_free_gems_origin_evidence.sql',import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
   await expect(forge()).rejects.toThrow('MINING_FREE_SOURCE_INVALID');
   await f.clock('2035-01-03T00:00:00Z');await expect(readFreeGemsEvidence(f.conn.db,{wallet:f.wallet,day:'2035-01-02'})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  }finally{await f.conn.sql.unsafe(`drop owned by ${role}`);await f.admin.unsafe(`drop role ${role}`);}
 },false,false),30_000);
 it('refuses a birth preceding origin coverage within the same millisecond',async()=>fixture(async f=>{
  const wallet=Keypair.generate().publicKey.toBase58();await f.clock('2035-01-01T00:00:00.000001Z');
  await f.conn.sql`insert into players(wallet,created_at) values(${wallet},'2035-01-01T00:00:00.000001Z')`;
  await f.clock('2035-01-01T00:00:00.000999Z');await initializeFreeGemsEvidence(f.conn.db);
  await f.clock('2035-01-03T00:00:00Z');await expect(readFreeGemsEvidence(f.conn.db,{wallet,day:'2035-01-02'})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 },false),30_000);
 it('refuses missing or inactive cohort authority without coverage or partial capture activation',async()=>fixture(async f=>{
  const assertDormant=async()=>{
   expect(await f.conn.sql`select * from mining_free_gems_coverage`).toHaveLength(0);
   expect((await f.conn.sql`select tgenabled from pg_trigger where tgrelid='public.ledger_entries'::regclass and tgname='ledger_entries_mining_free_gems_capture'`)[0]?.tgenabled).toBe('D');
  };
  await assertDormant();
  await expect(initializeFreeGemsEvidence(f.conn.db)).rejects.toMatchObject({cause:{message:'MINING_FREE_GEMS_COHORT_COVERAGE_REQUIRED'}});
  await assertDormant();
  await initializeFreeCohortCoverage(f.conn.db);
  await f.conn.sql`alter table accounts disable trigger accounts_mining_free_attribution`;
  await expect(initializeFreeGemsEvidence(f.conn.db)).rejects.toMatchObject({cause:{message:'MINING_FREE_GEMS_COHORT_COVERAGE_REQUIRED'}});
  await assertDormant();
 },false,false),30_000);
 it('retains a positive origin inserted and erased in the same committed transaction',async()=>fixture(async f=>{
  let sourceId='';
  // Owner edit with plain DELETEs and no trigger paused: 0302 (K-night-E1) stopped the 0267 crafting guard swallowing them.
  await f.conn.db.transaction(async tx=>{
   const original=await postTransaction(tx,{idempotencyKey:randomUUID(),type:'gems.late_credit',metadata:{wallet:f.wallet,reason:'keep_conversion',gems:'10'},entries:[
    {account:f.keep.id,delta:-10n},{account:f.sys.emission_pool,delta:10n},{account:f.sys.gems_mint,delta:-10n},{account:f.gems.id,delta:10n},
   ]});sourceId=original.transaction.id;
   await tx.execute(sql`delete from ledger_entries where txn_id=${sourceId}::uuid`);
   await tx.execute(sql`delete from ledger_transactions where id=${sourceId}::uuid`);
  });
  expect(await f.conn.sql`select id from ledger_entries where txn_id=${sourceId}`).toHaveLength(0);
  expect(await f.conn.sql`select id from ledger_transactions where id=${sourceId}`).toHaveLength(0);
  await f.clock('2035-01-02T00:00:00Z');const evidence=await f.read();
  expect(evidence.zeroQualifyingCredit).toBe(false);expect(evidence.reason).toBe('paid-origin');expect(evidence.originIds).toHaveLength(1);
 }),30_000);
 it.each(['gems.from_keep','gems.buy','gems.late_credit'])('retains %s after spending and deleting original source rows',async type=>fixture(async f=>{
  const paid=await f.mint(type);await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'hero.recruit',entries:[{account:f.gems.id,delta:-10n},{account:f.sys.gems_sink,delta:10n}]});
  await f.clock('2035-01-02T00:00:00Z');const before=await f.read();expect(before.zeroQualifyingCredit).toBe(false);expect(before.reason).toBe('paid-origin');
  // The stronger 0161 rule stands: the origin transaction cannot go while its positive Gems entry exists.
  await expect(f.conn.sql`delete from ledger_transactions where id=${paid.transaction.id}`).rejects.toThrow('MINING_FREE_ATTRIBUTION_IMMUTABLE');
  await f.conn.sql.begin(async tx=>{await tx`delete from ledger_entries where txn_id=${paid.transaction.id}`;await tx`delete from ledger_transactions where id=${paid.transaction.id}`;});
  expect(await f.conn.sql`select id from ledger_transactions where id=${paid.transaction.id}`).toHaveLength(0);
  expect(await f.read()).toEqual(before);
 }),30_000);
 it('proves grant-only zero from canonical backing and preserves its copied receipt after erasure, pause and reconnect',async()=>fixture(async f=>{
  await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'fixture.budget',entries:[{account:f.sys.keep_genesis,delta:-10n},{account:f.sys.emission_pool,delta:10n}]});
  await fundGemsRewardBudget(f.conn.db,10n,randomUUID());const grant=await grantGems(f.conn.db,{wallet:f.wallet,gems:10n,reason:'welcome'});
  await f.clock('2035-01-02T00:00:00Z');const original=await f.read();expect(original.zeroQualifyingCredit).toBe(true);expect(original.originIds).toHaveLength(1);
  await f.conn.sql.begin(async tx=>{await tx`delete from ledger_entries where txn_id=${grant.transaction.id}`;await tx`delete from ledger_transactions where id=${grant.transaction.id}`;});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reopened=createDb(f.url.toString());try{expect(await readFreeGemsEvidence(reopened.db,{wallet:f.wallet,day:'2035-01-01'})).toEqual(original);}finally{await reopened.sql.end();}
  await f.conn.sql.unsafe(readFileSync(new URL('../drizzle/0166_mining_free_gems_origin_evidence.sql',import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
  await f.clock('2035-01-02T00:00:00Z');expect(await f.read()).toEqual(original);
 }),30_000);
 it.each(['unknown.credit','raid.buffs.system_refund','gems.grant'])('refuses unproven %s even after its positive entry becomes negative',async type=>fixture(async f=>{
  const original=await f.mint(type);const entry=original.entries.find(e=>e.accountId===f.gems.id)!;
  await f.conn.sql`update ledger_entries set delta=-10 where id=${String(entry.id)}`;await f.conn.sql.begin(tx=>tx`delete from ledger_entries where txn_id=${original.transaction.id}`);
  await f.clock('2035-01-02T00:00:00Z');await expect(f.read()).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),30_000);
 it('stays dormant and refuses wallets born before its independent coverage boundary',async()=>fixture(async f=>{
  await f.mint('gems.late_credit');expect(await f.conn.sql`select * from mining_free_gems_origins`).toHaveLength(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(initializeFreeGemsEvidence(f.conn.db)).rejects.toMatchObject({code:'DISABLED'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');await f.clock('2035-01-01T01:00:00Z');await initializeFreeGemsEvidence(f.conn.db);
  await f.clock('2035-01-02T00:00:00Z');await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 },false),30_000);
 it('captures the complete grant receipt even when the positive Gems leg is first in its posting batch',async()=>fixture(async f=>{
  await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'fixture.budget',entries:[{account:f.sys.keep_genesis,delta:-10n},{account:f.sys.emission_pool,delta:10n}]});
  await fundGemsRewardBudget(f.conn.db,10n,randomUUID());
  await postTransaction(f.conn.db,{idempotencyKey:`grant:dev:${f.wallet}`,type:'gems.grant',metadata:{wallet:f.wallet,reason:'dev',gems:'10'},entries:[
   {account:f.gems.id,delta:10n},{account:f.sys.gems_reward_budget,delta:-10n},{account:f.sys.emission_pool,delta:10n},{account:f.sys.gems_mint,delta:-10n},
  ]});
  await f.clock('2035-01-02T00:00:00Z');expect((await f.read()).zeroQualifyingCredit).toBe(true);
 }),30_000);
 it('rejects caller authority, open days, source contention, stale snapshots and forged runtime history',async()=>fixture(async f=>{
  await expect(f.read()).rejects.toMatchObject({code:'DAY_OPEN'});await f.clock('2035-01-02T00:00:00Z');
  await expect(readFreeGemsEvidence(f.conn.db,{wallet:f.wallet,day:'2035-01-01',zero:true})).rejects.toMatchObject({code:'INVALID_INPUT'});
  let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r);
  const writer=f.conn.sql.begin(async tx=>{await tx`lock table ledger_entries in row exclusive mode`;ready();await gate;});try{await started;await expect(f.read()).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  const beforeEntries=await f.conn.sql`select * from ledger_entries where account_id=${f.keep.id} order by id`;
  expect(beforeEntries.length).toBeGreaterThan(0);
  const beforeOrigins=await f.conn.sql`select * from mining_free_gems_origins order by id`;
  // The newer custody league source guard runs first on ledger entries.
  // Its exact RC refusal preserves the same no-stale-writer invariant.
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`update ledger_entries set delta=delta where account_id=${f.keep.id}`;}))
   .rejects.toMatchObject({code:'P0001',message:'CUSTODY_LEAGUE_READ_COMMITTED_REQUIRED'});
  const updated=await f.conn.sql.begin('isolation level read committed',async tx=>tx`update ledger_entries set delta=delta where account_id=${f.keep.id} returning id`);
  expect(updated.map(row=>row.id).sort()).toEqual(beforeEntries.map(row=>row.id).sort());
  expect(await f.conn.sql`select * from ledger_entries where account_id=${f.keep.id} order by id`).toEqual(beforeEntries);
  expect(await f.conn.sql`select * from mining_free_gems_origins order by id`).toEqual(beforeOrigins);
  // Exercise Gems' own initialization guard without disabling earlier source guards.
  const beforeCoverage=await f.conn.sql`select * from mining_free_gems_coverage`;
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_free_gems_coverage(id) values(true)`;}))
   .rejects.toMatchObject({code:'P0001',message:'MINING_FREE_GEMS_READ_COMMITTED_REQUIRED'});
  expect(await f.conn.sql`select * from mining_free_gems_coverage`).toEqual(beforeCoverage);
  const role=`free_gems_${randomUUID().replaceAll('-','')}`;await f.admin.unsafe(`create role ${role}`);
  try{
   await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}; grant all on all sequences in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`select set_config('shardkeep.mining_free_gems_owner','on',true)`;await tx`insert into mining_free_gems_coverage(id) values(true)`;})).rejects.toThrow('MINING_FREE_GEMS_IMMUTABLE');
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_free_gems_origins(ledger_entry_id,origin_hash,wallet,observed_at,operation,source,receipt) values(1,'fake',${f.wallet},now(),'INSERT','{}','[]')`;})).rejects.toThrow('MINING_FREE_GEMS_IMMUTABLE');
   await expect(f.conn.sql`delete from mining_free_gems_coverage`).rejects.toThrow('MINING_FREE_GEMS_IMMUTABLE');
  }finally{await f.conn.sql.unsafe(`drop owned by ${role}`);await f.admin.unsafe(`drop role ${role}`);}
 }),30_000);
});
