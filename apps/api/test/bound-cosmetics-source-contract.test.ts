/** Prospective source admission preserves the old evidence, refuses unrelated
 * drift, and keeps cosmetic custody private. Every database is loopback-only. */
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {expect,it} from 'vitest';
import {Keypair} from '@solana/web3.js';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {ADMIN_DATABASE_URL} from './db-url';

const migrations=fileURLToPath(new URL('../drizzle',import.meta.url));
const predecessor='0277_mining_gems_zero_opening';
const custody='0278_bound_cosmetics';
const extension='0279_bound_cosmetic_source_contract';
const seal='divine_fragment_bound_cosmetics_contract';
const tables=['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions',
 'ordinary_equipment_jobs','ordinary_equipment_completions','bound_cosmetic_return_contract',seal];
async function fixture(run:(f:{conn:ReturnType<typeof createDb>;through:(tag:string)=>Promise<void>;extensionSql:string})=>Promise<void>){
 const url=new URL(ADMIN_DATABASE_URL);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Owned loopback source-contract fixture required');
 const name=`bound_source_${randomUUID().replaceAll('-','')}_test`,admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});
 const folder=await mkdtemp(join(tmpdir(),'shardkeep-bound-source-'));let conn:ReturnType<typeof createDb>|undefined;
 try{
  await cp(migrations,folder,{recursive:true});
  const journalPath=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(journalPath,'utf8')) as {entries:{tag:string}[]};
  await admin.unsafe(`create database ${name}`);url.pathname=`/${name}`;conn=createDb(url.toString(),{max:1});
  const through=async(tag:string)=>{const index=journal.entries.findIndex(entry=>entry.tag===tag);if(index<0)throw Error(`Missing frozen migration ${tag}`);
   await writeFile(journalPath,JSON.stringify({...journal,entries:journal.entries.slice(0,index+1)}));
   await runMigrations(conn!.db,{migrationsFolder:folder});};
  await through(predecessor);
  await run({conn,through,extensionSql:await readFile(join(folder,`${extension}.sql`),'utf8')});
 }finally{await conn?.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);await admin.end();await rm(folder,{recursive:true,force:true});}
}
async function priorSeals(conn:ReturnType<typeof createDb>){
 const rows=await conn.sql<{name:string}[]>`select relname name from pg_class where relnamespace='public'::regnamespace
  and (relname='divine_fragment_contract' or relname like 'divine_fragment_%_contract') order by relname`;
 const seals:Record<string,unknown>={};
 for(const {name} of rows)seals[name]=await conn.sql.unsafe(`select * from public.${name} order by singleton`);
 return seals;
}
const applySql=async(tx:postgres.TransactionSql,body:string)=>{for(const statement of body.split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);};

it('extends only the new trigger identity and preserves every historical seal and current mining sources',()=>fixture(async({conn,through})=>{
 await conn.sql`select public.shardkeep_divine_fragment_source()`;
 const previous=await priorSeals(conn);
 const [independentBefore]=await conn.sql`select public.shardkeep_mining_gems_zero_sources_valid() gems,public.shardkeep_mining_existing_wallet_sources_valid() wallet`;
 const returns=await conn.sql`select 'advanced' kind,source_sha256 from advanced_return_capability_seal union all select 'starter',source_sha256 from ordinary_equipment_starter_return_seal order by kind`;
 await through(custody);
 await expect(conn.sql`select public.shardkeep_divine_fragment_source()`).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 await through(extension);
 await conn.sql`select public.shardkeep_divine_fragment_source()`;
 const after=await priorSeals(conn);delete after[seal];expect(after).toEqual(previous);
 expect(await conn.sql`select 'advanced' kind,source_sha256 from advanced_return_capability_seal union all select 'starter',source_sha256 from ordinary_equipment_starter_return_seal order by kind`).toEqual(returns);
 const [current]=await conn.sql`select record=public.shardkeep_divine_fragment_contract() intact,record
  from public.divine_fragment_bound_cosmetics_contract where singleton`;
 expect(current!.intact).toBe(true);
 const record=current!.record as {tables:Record<string,unknown>;functions:Record<string,{securityDefiner:boolean}>;boundCosmeticTables:Record<string,unknown>;triggers:unknown[][]};
 for(const table of tables){expect(record.tables).toHaveProperty(table);expect(record.boundCosmeticTables[table]).toMatchObject({kind:'r',persistence:'p',rls:false,forceRls:false,hasSubclass:false,inheritance:null});}
 for(const fn of ['shardkeep_bound_cosmetic_recipe(text)','shardkeep_bound_cosmetic_appearance(text)',
  'shardkeep_bound_cosmetic_blueprint_source(uuid,text,timestamp with time zone)','shardkeep_bound_cosmetic_guard()',
  'shardkeep_bound_cosmetic_blueprint_complete()','shardkeep_bound_cosmetic_debit()',
  'shardkeep_bound_cosmetic_workshop_guard()','shardkeep_bound_cosmetics_seal_guard()'])expect(record.functions[fn]).toBeDefined();
 expect(record.functions['shardkeep_bound_cosmetic_workshop_guard()']!.securityDefiner).toBe(true);
 expect(record.triggers.filter(row=>row[1]==='bound_cosmetic_workshop_guard').map(row=>row[0]).sort()).toEqual(['bound_cosmetic_jobs','ordinary_crafting_jobs','ordinary_equipment_jobs']);
 const [independent]=await conn.sql`select public.shardkeep_mining_gems_zero_sources_valid() gems,public.shardkeep_mining_existing_wallet_sources_valid() wallet`;
 // Capture readiness before the extension: this migration admits no source
 // coverage and must neither repair nor invalidate an existing inventory seal.
 expect(independent).toEqual(independentBefore);
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_return_sources_valid() valid`)[0]!.valid).toBe(true);
 const wallet=Keypair.generate().publicKey.toBase58(),base=randomUUID();
 await conn.sql`insert into players(wallet) values(${wallet})`;await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet})`;
 expect((await conn.sql`select public.shardkeep_equipment_idle(${base}) idle,public.shardkeep_settle_due_equipment(${base},clock_timestamp()) equipment,public.shardkeep_settle_advanced_returns(${base},clock_timestamp()) advanced`)[0]).toEqual({idle:true,equipment:0,advanced:0});
 await through(extension);await conn.sql`select public.shardkeep_divine_fragment_source()`;
}),180_000);

it('refuses unrelated predecessor drift or unsafe new dependencies instead of blessing a fresh baseline',()=>fixture(async({conn,through,extensionSql})=>{
 await through(custody);
 for(const mutation of [
  'alter table ordinary_crafting_jobs disable trigger bound_cosmetic_workshop_guard',
  'alter table ordinary_crafting_jobs disable trigger ordinary_crafting_jobs_guard',
  'alter table divine_fragment_awards alter column record drop not null',
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await applySql(tx,extensionSql);})).rejects.toThrow('BOUND_COSMETIC_PREDECESSOR_SOURCE');
 for(const mutation of [
  'alter table ordinary_equipment_jobs disable trigger bound_cosmetic_workshop_guard',
  'alter function public.shardkeep_settle_due_equipment(uuid,timestamptz) security invoker',
  'alter function public.shardkeep_finish_starter_equipment(uuid) security invoker',
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await applySql(tx,extensionSql);})).rejects.toThrow('BOUND_COSMETIC_RETURN_PREDECESSOR');
 for(const mutation of [
  'grant select on bound_cosmetic_jobs to public',
  'grant select(output_id) on bound_cosmetic_jobs to public',
  'alter table bound_cosmetic_jobs enable row level security',
  'alter function public.shardkeep_bound_cosmetic_workshop_guard() security invoker',
  'grant execute on function public.shardkeep_bound_cosmetic_recipe(text) to public',
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await applySql(tx,extensionSql);})).rejects.toThrow('BOUND_COSMETIC_SEAL_PRIVATE_SOURCE');
 expect((await conn.sql`select to_regclass('public.divine_fragment_bound_cosmetics_contract') relation`)[0]!.relation).toBeNull();
 await through(extension);await conn.sql`select public.shardkeep_divine_fragment_source()`;
}),180_000);

it('detects changed cosmetic effects, queue hooks, private permissions and table shapes after admission',()=>fixture(async({conn,through})=>{
 await through(extension);
 const body=await readFile(join(migrations,`${predecessor}.sql`),'utf8');
 const oldContract=body.slice(body.indexOf('CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_contract()'),body.indexOf('\n--> statement-breakpoint\nCREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source()'));
 const oldSource=body.slice(body.indexOf('CREATE OR REPLACE FUNCTION public.shardkeep_divine_fragment_source()'),body.indexOf('\n--> statement-breakpoint\nCREATE OR REPLACE FUNCTION public.shardkeep_mining_gems_zero_publication_seal_guard()'));
 for(const mutation of [
  ...['ordinary_crafting_jobs','ordinary_equipment_jobs','bound_cosmetic_jobs'].map(table=>`alter table ${table} disable trigger bound_cosmetic_workshop_guard`),
  'alter table bound_cosmetic_jobs disable trigger bound_cosmetic_debit',
  'alter table bound_cosmetic_blueprints disable trigger bound_cosmetic_blueprint_complete',
  'alter function public.shardkeep_bound_cosmetic_workshop_guard() security invoker',
  'alter function public.shardkeep_bound_cosmetic_workshop_guard() set search_path=pg_catalog,pg_temp,public',
  "create or replace function public.shardkeep_bound_cosmetic_debit() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$begin return NEW;end$$",
  'grant select on bound_cosmetic_jobs to public',
  'grant select(output_id) on bound_cosmetic_jobs to public',
  'grant execute on function public.shardkeep_bound_cosmetic_appearance(text) to public',
  'alter table bound_cosmetic_completions alter column completed_at drop not null',
  'alter table bound_cosmetic_jobs enable row level security',
  'alter table ordinary_equipment_completions force row level security',
  'alter table bound_cosmetic_completions set unlogged',
  oldContract+'\n'+oldSource,
 ]){
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);expect((await tx`select public.shardkeep_bound_cosmetic_return_sources_valid() valid`)[0]!.valid).toBe(false);await tx`select public.shardkeep_divine_fragment_source()`;}),mutation).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
  await conn.sql`select public.shardkeep_divine_fragment_source()`;
 }
 for(const table of ['advanced_return_capability_seal','ordinary_equipment_starter_return_seal'])await expect(conn.sql.begin(async tx=>{await tx.unsafe(`update ${table} set source_sha256=repeat('0',64)`);expect((await tx`select public.shardkeep_bound_cosmetic_return_sources_valid() valid`)[0]!.valid).toBe(false);throw Error('rollback old seal mutation');})).rejects.toThrow('rollback old seal mutation');
 // PostgreSQL may retain relhassubclass after rollback. Keep this final probe
 // isolated in this disposable DB rather than repairing/resealing its source.
 await expect(conn.sql.begin(async tx=>{await tx`create table public.forged_cosmetic_child() inherits(public.bound_cosmetic_completions)`;await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
}),180_000);

it('keeps the new seal immutable, owner-only and read-committed even with accidental grants',()=>fixture(async({conn,through})=>{
 await through(extension);
 for(const query of [
  `update ${seal} set record=record`, `delete from ${seal}`, `truncate ${seal}`,
  `insert into ${seal}(record) select record from ${seal} on conflict do nothing`,
 ])await expect(conn.sql.unsafe(query)).rejects.toThrow('BOUND_COSMETIC_SEAL_IMMUTABLE');
 for(const query of ['update bound_cosmetic_return_contract set record=record','delete from bound_cosmetic_return_contract',
  'truncate bound_cosmetic_return_contract','insert into bound_cosmetic_return_contract(record) select record from bound_cosmetic_return_contract on conflict do nothing'])await expect(conn.sql.unsafe(query)).rejects.toThrow('BOUND_COSMETIC_RETURN_SEAL_IMMUTABLE');
 for(const isolation of ['repeatable read','serializable'])await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set transaction isolation level ${isolation}`);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_OWNER_ISOLATION');
 await expect(conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_OWNER_ISOLATION');
 const role='bound_seal_'+randomUUID().replaceAll('-','');await conn.sql.unsafe(`create role ${role} noinherit`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to ${role}`);
  for(const table of tables)await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(`select * from public.${table}`);})).rejects.toMatchObject({code:'42501'});
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(`grant execute on function public.shardkeep_divine_fragment_source() to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_OWNER_ISOLATION');
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(`grant select,insert on public.${seal} to ${role}`);await tx.unsafe(`set local role ${role}`);await tx.unsafe(`insert into public.${seal}(record) select record from public.${seal} on conflict do nothing`);})).rejects.toThrow('BOUND_COSMETIC_SEAL_IMMUTABLE');
 }finally{await conn.sql.unsafe(`drop owned by ${role}`);await conn.sql.unsafe(`drop role ${role}`);}
 await conn.sql`select public.shardkeep_divine_fragment_source()`;
}),180_000);
