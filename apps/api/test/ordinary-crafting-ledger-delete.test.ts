/** K-night-E1 regression (2026-10-10, migration 0302). 0267's
 * shardkeep_ordinary_crafting_shards_guard() is a BEFORE row trigger on both
 * ledger tables that always ended `RETURN NEW`. NEW is NULL for DELETE, and a
 * BEFORE row trigger returning NULL cancels the row, so every ledger DELETE
 * reported success, deleted nothing, and the AFTER DELETE mining capture never
 * saw it. Its deferred sibling shardkeep_ordinary_crafting_shards_complete()
 * re-read the transaction with SELECT ... STRICT, so once a delete is real a
 * ledger row inserted and deleted in one database transaction aborted COMMIT.
 * These tests pin the rule: a delete that every other ledger guard permits
 * really deletes, also inside the inserting transaction; an ordinary-crafting
 * Shards ledger row still can never be deleted, updated or made to vanish
 * unproven (now loudly); and the re-sealed source graph still fails closed on
 * any drift of the four replaced bodies or of the new seal, while every older
 * seal row stays byte-exact. Each database here is owned by this file and
 * dropped at the end. */
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {afterAll,expect,it} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bootstrapSystemAccounts,postTransaction} from '../src/ledger';
import {ADMIN_DATABASE_URL} from './db-url';

type Conn=ReturnType<typeof createDb>;
type Sql=Conn['sql']|postgres.TransactionSql;
const MIGRATIONS=fileURLToPath(new URL('../drizzle',import.meta.url));
const FIX='0302_ordinary_crafting_ledger_delete';
const SEAL='divine_fragment_ledger_delete_contract';
const rollback=new Error('ledger delete attack rolled back');

const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});
const owned:{name:string;conn:Conn}[]=[];
async function ownedDatabase():Promise<Conn>{
 const name=`ledger_delete_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${name}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('ledger delete fixture requires a local owned database');
 await admin.unsafe(`create database ${name}`);const conn=createDb(url.toString(),{max:2});owned.push({name,conn});return conn;
}
afterAll(async()=>{
 for(const {name,conn} of owned){await conn.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);}
 await admin.end();
});

// One exact SQL statement from a reviewed migration, used to restore a predecessor body.
async function statement(file:string,start:string,end:string){
 const text=await readFile(join(MIGRATIONS,file),'utf8'),from=text.indexOf(start);
 expect(from,`${file}: ${start}`).toBeGreaterThanOrEqual(0);
 const to=text.indexOf(end,from);expect(to,`${file}: ${end}`).toBeGreaterThan(from);
 return text.slice(from,to+end.length);
}
// Every existing record/source hash, byte for byte (the new seal is listed separately).
async function originals(sql:Sql){
 const relations=await sql`select c.relname from pg_class c join pg_attribute a on a.attrelid=c.oid
  where c.relnamespace='public'::regnamespace and c.relkind='r' and a.attname in ('record','source_sha256')
  and a.attnum>0 and not a.attisdropped and (right(c.relname,9)='_contract' or right(c.relname,5)='_seal')
  and c.relname<>${SEAL} order by c.relname`;
 const rows:Record<string,unknown>={};
 for(const relation of relations)rows[relation.relname]=await sql.unsafe(`select row_to_json(t)::text row from public.${relation.relname} t order by row_to_json(t)::text`);
 return rows;
}
const ALL_VALID={ledger:true,crafting:true,wake:true,ret:true,visual:true,starter:true,advanced:true,service:true,current:true,identity:true,coverage:true};
async function sources(sql:Sql){
 return (await sql`select public.shardkeep_ledger_delete_sources_valid() ledger,public.shardkeep_crafting_runtime_sources_valid() crafting,
  public.shardkeep_bound_cosmetic_wake_sources_valid() wake,public.shardkeep_bound_cosmetic_return_sources_valid() ret,
  public.shardkeep_bound_cosmetic_visual_sources_valid() visual,public.shardkeep_raid_starter_sources_valid() starter,
  public.shardkeep_raid_advanced_sources_valid() advanced,public.shardkeep_service_activity_sources_valid() service,
  public.shardkeep_current_advanced_sources_valid() current,public.shardkeep_advanced_identity_sources_valid() identity,
  public.shardkeep_retirement_coverage_sources_valid() coverage`)[0];
}
async function sourceGraph(sql:Sql){
 expect(await sources(sql)).toEqual(ALL_VALID);
 await sql`select public.shardkeep_divine_fragment_source(),public.shardkeep_charter_retirement_source()`;
}
// An ordinary, balanced system posting that no Phase E guard owns.
async function plainPosting(c:Conn){
 const sys=await bootstrapSystemAccounts(c.db);
 const posted=await postTransaction(c.db,{idempotencyKey:`k-night-e1:${randomUUID()}`,type:'test.k_night_e1',
  entries:[{account:sys.shard_genesis,delta:-5n},{account:sys.shard_burn,delta:5n}]});
 return posted.transaction.id;
}
const rowsOf=async(sql:Sql,txn:string)=>({
 entries:Number((await sql`select count(*) n from ledger_entries where txn_id=${txn}`)[0]!.n),
 transactions:Number((await sql`select count(*) n from ledger_transactions where id=${txn}`)[0]!.n)});

let head:Conn;
it('before 0302 a ledger delete reports success and keeps the row; 0302 makes it real and keeps every old seal row byte-exact',async()=>{
 head=await ownedDatabase();const folder=await mkdtemp(join(tmpdir(),'ledger-delete-journal-'));
 try{
  await cp(MIGRATIONS,folder,{recursive:true});const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8'));
  const fix=journal.entries.findIndex((e:{tag:string})=>e.tag===FIX);expect(fix).toBeGreaterThan(0);
  await writeFile(path,JSON.stringify({...journal,entries:journal.entries.slice(0,fix)}));
  await runMigrations(head.db,{migrationsFolder:folder});
 }finally{await rm(folder,{recursive:true,force:true});}
 // The production defect: zero rows deleted, no error, and the posting is still there.
 const kept=await plainPosting(head);
 expect((await head.sql`delete from ledger_entries where txn_id=${kept}`).count).toBe(0);
 expect((await head.sql`delete from ledger_transactions where id=${kept}`).count).toBe(0);
 expect(await rowsOf(head.sql,kept)).toEqual({entries:2,transactions:1});
 const before=await originals(head.sql);
 await runMigrations(head.db);
 expect(await originals(head.sql)).toEqual(before);
 expect((await head.sql`select count(*)::int n from public.divine_fragment_ledger_delete_contract`)[0]!.n).toBe(1);
 await sourceGraph(head.sql);
 // After 0302 the same deletes happen, in the order the foreign key requires.
 const posted=await plainPosting(head);
 for(const txn of [kept,posted]){
  expect((await head.sql`delete from ledger_entries where txn_id=${txn}`).count).toBe(2);
  expect((await head.sql`delete from ledger_transactions where id=${txn}`).count).toBe(1);
  expect(await rowsOf(head.sql,txn)).toEqual({entries:0,transactions:0});
 }
 // Inside the inserting transaction too: the deferred hook must not abort COMMIT
 // because the row it would re-read is already gone ('query returned no rows').
 const sys=await bootstrapSystemAccounts(head.db);let same='';
 await head.db.transaction(async tx=>{
  same=(await postTransaction(tx,{idempotencyKey:`k-night-e1:${randomUUID()}`,type:'test.k_night_e1',
   entries:[{account:sys.shard_genesis,delta:-3n},{account:sys.shard_burn,delta:3n}]})).transaction.id;
  await tx.execute(sql`delete from ledger_entries where txn_id=${same}::uuid`);await tx.execute(sql`delete from ledger_transactions where id=${same}::uuid`);
 });
 expect(await rowsOf(head.sql,same)).toEqual({entries:0,transactions:0});
 await sourceGraph(head.sql);
},600_000);

it('never deletes, updates or drops unproven an ordinary-crafting Shards ledger row; the delete 0267 silently dropped now fails loudly',async()=>{
 const sys=await bootstrapSystemAccounts(head.db);
 await expect(head.sql.begin(async tx=>{
  // Owner INSERT is the one operation the guard admits (its deferred proof never runs: rolled back).
  const [txn]=await tx`insert into ledger_transactions(idempotency_key,type)
   values(${`ordinary-crafting:${randomUUID()}:shards`},'ordinary.crafting.shards') returning id`;
  const [entry]=await tx`insert into ledger_entries(txn_id,account_id,delta,balance_after)
   values(${txn!.id},${sys.shard_genesis},-1,0) returning id`;
  for(const mutation of [(sp:Sql)=>sp`delete from ledger_transactions where id=${txn!.id}`,(sp:Sql)=>sp`update ledger_transactions set metadata='{"moved":true}' where id=${txn!.id}`,
   (sp:Sql)=>sp`delete from ledger_entries where id=${entry!.id}`,(sp:Sql)=>sp`update ledger_entries set delta=-2 where id=${entry!.id}`])
   await expect(tx.savepoint(async sp=>{await mutation(sp);})).rejects.toMatchObject({message:'ORDINARY_CRAFTING_OWNER',code:'42501'});
  expect(Number((await tx`select count(*) n from ledger_transactions where id=${txn!.id}`)[0]!.n)).toBe(1);
  expect(Number((await tx`select count(*) n from ledger_entries where id=${entry!.id}`)[0]!.n)).toBe(1);
  throw rollback;
 })).rejects.toBe(rollback);
 // A crafting transaction that vanishes behind the guard (replica mode skips it)
 // still cannot commit unproven: the deferred hook checks the row as inserted.
 await expect(head.sql.begin(async tx=>{
  const [txn]=await tx`insert into ledger_transactions(idempotency_key,type) values(${`ordinary-crafting:${randomUUID()}:shards`},'ordinary.crafting.shards') returning id`;
  await tx`set local session_replication_role=replica`;
  expect((await tx`delete from ledger_transactions where id=${txn!.id}`).count).toBe(1);
  await tx`set local session_replication_role=origin`;
 })).rejects.toMatchObject({message:'ORDINARY_CRAFTING_SHARDS_UNBOUND',code:'23514'});
 await sourceGraph(head.sql);
},300_000);

it('fails closed when the fixed guard, a replaced body, the ledger hooks or the new seal drift, without touching an old seal row',async()=>{
 const old=await originals(head.sql);
 const attacks=[
  // The defective 0267 bodies themselves must not be restorable behind the seal.
  await statement('0267_ordinary_kits.sql','CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_shards_guard()','END $$;'),
  await statement('0267_ordinary_kits.sql','CREATE OR REPLACE FUNCTION public.shardkeep_ordinary_crafting_shards_complete()','END $$;'),
  // The predecessor validator and projection without the new seal requirement.
  (await statement('0298_ordinary_crafting_runtime.sql','CREATE FUNCTION public.shardkeep_crafting_runtime_sources_valid()','\n$$;')).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'),
  await statement('0298_ordinary_crafting_runtime.sql','CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract()','\n$$;'),
  'alter function public.shardkeep_ordinary_crafting_shards_guard() security definer',
  'alter function public.shardkeep_ordinary_crafting_shards_guard() set search_path=public,pg_catalog',
  'grant execute on function public.shardkeep_ordinary_crafting_shards_guard() to public',
  // Dropping DELETE from the hook would silently remove the refusal above.
  'create or replace trigger ordinary_crafting_shards_guard before insert or update on public.ledger_transactions for each row execute function public.shardkeep_ordinary_crafting_shards_guard()',
  'alter table public.ledger_entries disable trigger ordinary_crafting_shards_guard',
  `grant select(record) on public.${SEAL} to public`,
  `alter table public.${SEAL} disable trigger ledger_delete_seal_guard`,
  `alter table public.${SEAL} add column unexpected boolean`,
  `alter table public.${SEAL} enable row level security`,
  `create rule unexpected as on update to public.${SEAL} do instead nothing`,
  `create function public.shardkeep_ledger_delete_extra() returns boolean language sql as 'select true'`,
  `set local session_replication_role=replica;update public.${SEAL} set record=record||'{"unexpected":true}';set local session_replication_role=origin`,
 ];
 for(const attack of attacks){
  await expect(head.sql.begin(async tx=>{
   await tx.unsafe(attack);
   expect((await tx`select public.shardkeep_crafting_runtime_sources_valid() valid`)[0]!.valid,attack).toBe(false);
   expect((await tx`select public.shardkeep_divine_fragment_contract() value`)[0]!.value,attack).toBeNull();
   await expect(tx.savepoint(async sp=>{await sp`select public.shardkeep_divine_fragment_source()`;}),attack).rejects.toMatchObject({message:'DIVINE_FRAGMENT_SOURCE'});
   throw rollback;
  }),attack).rejects.toBe(rollback);
  expect(await originals(head.sql)).toEqual(old);
 }
 for(const mutation of [`insert into public.${SEAL}(record) select record from public.${SEAL}`,`update public.${SEAL} set record=record`,
  `delete from public.${SEAL}`,`truncate public.${SEAL}`])
  await expect(head.sql.unsafe(mutation),mutation).rejects.toThrow('LEDGER_DELETE_SEAL_IMMUTABLE');
 expect(await originals(head.sql)).toEqual(old);
 await sourceGraph(head.sql);
},300_000);
