import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {charterSalesFixture,type CharterSalesFixture} from './fixtures/charterSales';
import {postgresLeaf} from './fixtures/charterPermitInventory';
import {createDb} from '../src/db/client';
import {createClanCharterSalesStore} from '../src/db/charterSales';
import {getBaseShardBalance,spendBaseShards} from '../src/game/baseEconomy';
let f:CharterSalesFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesFixture();});
afterEach(async()=>{const closing=f;f=undefined;try{await closing?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}});
async function refusal(work:Promise<unknown>,message:string,code='P0001'){
 const error=await work.then(()=>{throw Error('Expected protected SQL refusal');},error=>error);
 expect(postgresLeaf(error)).toEqual({code,message});
}

it('keeps actual birth, structural zero and authority head immutable against raw owner and caller-GUC attempts',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth(),draft=await c.draft(birth),before=await c.salesSnapshot();
 expect(draft.state.original.expectedRevision).toBe(0);
 expect(await c.sql`select count(*)::int n from charter_sale_births where clan_id=${birth.consent.clanId}`).toEqual([{n:1}]);
 for(const command of [
  'update charter_sale_epochs set domain=domain || \'{"treasury":"forged"}\'::jsonb',
  'delete from charter_sale_births',
  'update charter_sale_heads set revision=revision+1',
  'truncate charter_sale_births cascade',
 ])await refusal(c.sql.begin(async tx=>{
  await tx`select set_config('shardkeep.charter_sale_verified','true',true)`;await tx.unsafe(command);
 }),'CLAN_CHARTER_SALE_IMMUTABLE');
 await refusal(c.sql.begin(async tx=>{
  await tx`create temporary table charter_sale_clan_inserts (like public.charter_sale_clan_inserts including all)`;
  await tx`create trigger charter_sale_clan_inserts_guard before insert on pg_temp.charter_sale_clan_inserts
   for each row execute function public.shardkeep_charter_sale_private()`;
  await tx`insert into pg_temp.charter_sale_clan_inserts select * from public.charter_sale_clan_inserts`;
 }),'CLAN_CHARTER_SALE_TRIGGER');
 expect(await c.salesSnapshot()).toBe(before);
 expect(await c.store().read(birth.actor.wallet,draft.state.original.id)).toEqual(draft.state);
 // A legacy runtime role can still spend unreserved gameplay funds, without
 // receiving any of the new private source-table grants.
 const role='sale_runtime_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await c.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await c.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};
   grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
  const privateTables=await c.sql`select tablename from pg_tables where schemaname='public' and (tablename like 'charter_sale_%' or tablename='charter_sales')`;
  for(const row of privateTables)await c.sql.unsafe(`revoke all on public.${row.tablename} from ${role}`);
  const url=await c.ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(createClanCharterSalesStore(runtime.db).read(birth.actor.wallet,draft.state.original.id)).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_OWNER'});
  const balance=await getBaseShardBalance(c.db,birth.actor.baseId);
  await spendBaseShards(runtime.db,birth.actor.baseId,1n,'test.charter_sale.unreserved',randomUUID());
  expect(await getBaseShardBalance(c.db,birth.actor.baseId)).toBe(balance-1n);
  expect(await c.store().read(birth.actor.wallet,draft.state.original.id)).toEqual(draft.state);
 }finally{await runtime?.sql.end();await c.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('detects a disabled or condition-narrowed birth hook before trusting an unchanged saved source',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth(),draft=await c.draft(birth);
 for(const condition of ['disabled','when-false','update-of']){
  const error=await c.db.transaction(async tx=>{
   const {sql}=await import('drizzle-orm');
   if(condition==='disabled')await tx.execute(sql`alter table charter_creation_terminals disable trigger charter_creation_terminals_charter_sale_capture`);
   else if(condition==='when-false'){
    await tx.execute(sql`drop trigger charter_creation_terminals_charter_sale_capture on charter_creation_terminals`);
    await tx.execute(sql`create trigger charter_creation_terminals_charter_sale_capture after insert on charter_creation_terminals
     for each row when(false) execute function public.shardkeep_charter_sale_capture()`);
   }else{
    await tx.execute(sql`drop trigger clans_charter_sale_source on clans`);
    await tx.execute(sql`create trigger clans_charter_sale_source before insert or update of name or delete on clans
     for each row execute function public.shardkeep_charter_sale_source()`);
   }
   await tx.execute(sql`select public.shardkeep_charter_sale_read(${birth.actor.wallet},${draft.state.original.id}::uuid)`);
  }).then(()=>{throw Error('Expected hook-integrity refusal');},error=>error);
  expect(postgresLeaf(error)).toEqual({code:'P0001',message:'CLAN_CHARTER_SALE_SOURCE'});
 }
 expect(await c.store().read(birth.actor.wallet,draft.state.original.id)).toEqual(draft.state);
});

it('refuses a writer whose repeatable-read snapshot predates epoch enrollment and preserves its attempted source post',async()=>{
 const c=f!,other=await c.dedicatedOwner(),key='raid-ante:'+randomUUID();let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const work=other.sql.begin('isolation level repeatable read',async tx=>{
  expect(await tx`select id from charter_sale_epochs`).toHaveLength(0);entered();await gate;
  // The committed enrollment remains invisible to this original snapshot.
  expect(await tx`select id from charter_sale_epochs`).toHaveLength(0);
  await tx`insert into ledger_transactions(type,idempotency_key,metadata) values('raid.ante',${key},'{}'::jsonb)`;
 }).then(()=>({error:null}),error=>({error}));
 try{
  await Promise.race([ready,work.then(result=>{throw result.error??Error('Source writer completed before readiness');})]);
  await c.initialize();const before=await c.salesSnapshot();release();
  // The earlier custody league guard rejects the stale ledger writer first.
  expect(postgresLeaf((await work).error)).toEqual({code:'P0001',message:'CUSTODY_LEAGUE_READ_COMMITTED_REQUIRED'});
  expect(await c.sql`select id from ledger_transactions where idempotency_key=${key}`).toHaveLength(0);
  expect(await c.salesSnapshot()).toBe(before);
 }finally{release();await work;await other.sql.end();}
});


it('retains the exact sealed source on migration replay and refuses a marked table with an incompatible constraint',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth(),draft=await c.draft(birth),before=await c.salesSnapshot();
 const statements=(await readFile(new URL('../drizzle/0231_charter_sales.sql',import.meta.url),'utf8')).split('--> statement-breakpoint');
 // 2026-10-10 (CI 37503885235): 0264 (existing-clan migrations, f080124dc) extended charter_sale_births
 // (nullable reservation/terminal, migration_id, birth-origin check). 0231's rerun validates its exact v1 shape
 // and never adopts a changed table, so even an untampered replay now refuses; the sealed source and saved
 // drafts must stay exact either way.
 await refusal(c.sql.begin(async tx=>{for(const statement of statements)if(statement.trim())await tx.unsafe(statement);}),'CLAN_CHARTER_SALE_SCHEMA');
 expect(await c.salesSnapshot()).toBe(before);expect(await c.store().read(birth.actor.wallet,draft.state.original.id)).toEqual(draft.state);
 await refusal(c.sql.begin(async tx=>{
  await tx`alter table charter_sale_heads drop constraint charter_sale_heads_revision_check`;
  for(const statement of statements)if(statement.trim())await tx.unsafe(statement);
 }),'CLAN_CHARTER_SALE_SCHEMA');
 expect(await c.salesSnapshot()).toBe(before);expect(await c.store().read(birth.actor.wallet,draft.state.original.id)).toEqual(draft.state);
});
