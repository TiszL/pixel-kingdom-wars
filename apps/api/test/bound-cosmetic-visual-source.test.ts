/** A prospective visual hook must preserve retained Charter evidence rather than
 * bless unrelated drift. These fixtures own disposable loopback databases. */
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {expect,it} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {ADMIN_DATABASE_URL} from './db-url';

const migrations=fileURLToPath(new URL('../drizzle',import.meta.url));
const predecessor='0279_bound_cosmetic_source_contract';
const visuals='0280_bound_cosmetic_visuals';
const extension='0281_bound_cosmetic_visual_source';
const seal='bound_cosmetic_charter_contract';
const apply=async(tx:postgres.TransactionSql,body:string)=>{
 for(const statement of body.split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);
};
async function fixture(run:(f:{conn:ReturnType<typeof createDb>;visualSql:string;extensionSql:string})=>Promise<void>){
 const url=new URL(ADMIN_DATABASE_URL);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Owned loopback visual-source fixture required');
 const name=`bound_visual_source_${randomUUID().replaceAll('-','')}_test`;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),folder=await mkdtemp(join(tmpdir(),'shardkeep-bound-visual-source-'));
 let conn:ReturnType<typeof createDb>|undefined;
 try{
  await cp(migrations,folder,{recursive:true});
  const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8')) as {entries:{tag:string}[]};
  const index=journal.entries.findIndex(entry=>entry.tag===predecessor);if(index<0)throw Error('Missing visual source predecessor');
  await writeFile(path,JSON.stringify({...journal,entries:journal.entries.slice(0,index+1)}));
  await admin.unsafe(`create database ${name}`);url.pathname=`/${name}`;conn=createDb(url.toString(),{max:1});
  await runMigrations(conn.db,{migrationsFolder:folder});
  await run({conn,visualSql:await readFile(join(folder,`${visuals}.sql`),'utf8'),extensionSql:await readFile(join(folder,`${extension}.sql`),'utf8')});
 }finally{
  await conn?.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);await admin.end();await rm(folder,{recursive:true,force:true});
 }
}
async function oldSeals(conn:ReturnType<typeof createDb>){
 const result:Record<string,unknown>={};
 for(const name of ['charter_retirement_contract','charter_retirement_projection_contract','charter_retirement_draft_contract',
  'charter_migration_contract','charter_tournament_source_contract','bound_cosmetic_return_contract','divine_fragment_bound_cosmetics_contract']){
  result[name]=await conn.sql.unsafe(`select * from public.${name} order by singleton`);
 }
 return result;
}

it('admits the exact new capture hook while retaining every predecessor and both current Charter sources',()=>fixture(async({conn,visualSql,extensionSql})=>{
 // Accepted 0267 added ledger hooks without extending the 0264 Charter seal.
 // Preserve this real failed readiness as the predecessor, not a fabricated green baseline.
 await expect(conn.sql`select public.shardkeep_charter_retirement_source()`).rejects.toThrow('CLAN_CHARTER_MIGRATION_SOURCE');
 await conn.sql`select public.shardkeep_charter_tournament_source_check()`;
 const prior=await oldSeals(conn);
 await conn.sql.begin(tx=>apply(tx,visualSql));
 await expect(conn.sql`select public.shardkeep_charter_retirement_source()`).rejects.toThrow('CLAN_CHARTER_MIGRATION_SOURCE');
 await conn.sql.begin(tx=>apply(tx,extensionSql));
 expect(await oldSeals(conn)).toEqual(prior);
 await conn.sql`select public.shardkeep_charter_retirement_source(),public.shardkeep_charter_tournament_source_check(),public.shardkeep_divine_fragment_source()`;
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_visual_sources_valid() valid`)[0]!.valid).toBe(true);
 const [row]=await conn.sql`select previous_sha256=(select source_sha256 from charter_migration_contract where singleton) linked,
  record=public.shardkeep_bound_cosmetic_visual_contract() intact from bound_cosmetic_charter_contract where singleton`;
 expect(row).toEqual({linked:true,intact:true});
}),180_000);

it('refuses unrelated predecessor drift and unsafe new sources before accepting any successor',()=>fixture(async({conn,visualSql,extensionSql})=>{
 await conn.sql.begin(tx=>apply(tx,visualSql));
 for(const mutation of [
  'alter table raids disable trigger raids_migration_boundary',
  'alter table ledger_entries disable trigger ordinary_crafting_shards_guard',
  'alter table ledger_transactions disable trigger ordinary_crafting_shards_complete',
  'alter table raids disable trigger bound_cosmetic_raid_capture',
  'alter table raids alter column snapshot drop not null',
  'alter function public.shardkeep_charter_sale_birth(uuid) set search_path=pg_catalog,pg_temp,public',
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await apply(tx,extensionSql);})).rejects.toThrow('BOUND_COSMETIC_VISUAL_PREDECESSOR');
 for(const mutation of [
  'alter table bound_cosmetic_preferences disable trigger bound_cosmetic_preference_guard',
  'alter table bound_cosmetic_raid_visuals disable trigger bound_cosmetic_raid_no_truncate',
  'create trigger extra_cosmetic_hook before insert on bound_cosmetic_preferences for each row execute function shardkeep_bound_cosmetic_preference_guard()',
  'create index extra_cosmetic_index on bound_cosmetic_preferences(revision)',
  'alter table bound_cosmetic_preferences alter column awning_enabled set default true',
  'grant select on bound_cosmetic_preferences to public',
  'grant select(visual) on bound_cosmetic_raid_visuals to public',
  'alter table bound_cosmetic_raid_visuals set unlogged',
  'alter table bound_cosmetic_preferences alter column awning_enabled drop not null',
  'alter function public.shardkeep_bound_cosmetic_base_visual(uuid,text) security invoker',
  "create or replace function public.shardkeep_bound_cosmetic_raid_capture() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin return NULL;end$$",
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await apply(tx,extensionSql);})).rejects.toThrow('BOUND_COSMETIC_VISUAL_PRIVATE_SOURCE');
 expect((await conn.sql`select to_regclass('public.bound_cosmetic_charter_contract') relation`)[0]!.relation).toBeNull();
 await conn.sql.begin(tx=>apply(tx,extensionSql));
 await conn.sql`select public.shardkeep_charter_retirement_source()`;
}),180_000);

it('detects visual hook, body, shape and ACL drift while allowing only the two documented reader groups',()=>fixture(async({conn,visualSql,extensionSql})=>{
 await conn.sql.begin(tx=>apply(tx,visualSql));await conn.sql.begin(tx=>apply(tx,extensionSql));
 for(const mutation of [
  'alter table raids disable trigger bound_cosmetic_raid_capture',
  'alter table bound_cosmetic_preferences disable trigger bound_cosmetic_preference_guard',
  'alter table bound_cosmetic_raid_visuals disable trigger bound_cosmetic_raid_guard',
  'alter function public.shardkeep_bound_cosmetic_raid_capture() security invoker',
  'alter function public.shardkeep_bound_cosmetic_base_visual(uuid,text) set search_path=pg_catalog,pg_temp,public',
  "create or replace function public.shardkeep_bound_cosmetic_raid_capture() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin return NULL;end$$",
  'grant select on bound_cosmetic_preferences to public',
  'grant select(visual) on bound_cosmetic_raid_visuals to public',
  'grant execute on function public.shardkeep_bound_cosmetic_base_visual(uuid,text) to public',
  'grant execute on function public.shardkeep_bound_cosmetic_market_awnings(uuid,text) to public',
  'alter table bound_cosmetic_raid_visuals alter column visual drop not null',
  'alter table bound_cosmetic_preferences enable row level security',
  'alter table bound_cosmetic_raid_visuals set unlogged',
 ]){
  await expect(conn.sql.begin(async tx=>{
   await tx.unsafe(mutation);
   expect((await tx`select public.shardkeep_bound_cosmetic_visual_sources_valid() valid`)[0]!.valid).toBe(false);
   await tx`select public.shardkeep_charter_retirement_source()`;
  }),mutation).rejects.toThrow('CLAN_CHARTER_MIGRATION_SOURCE');
 }
 for(const group of ['shardkeep_api_runtime','shardkeep_worker_runtime']){
  await expect(conn.sql.begin(async tx=>{
   if(!(await tx`select 1 from pg_roles where rolname=${group}`).length)await tx.unsafe(`create role ${group} nologin`);
   await tx.unsafe(`grant execute on function public.shardkeep_bound_cosmetic_base_visual(uuid,text),public.shardkeep_bound_cosmetic_raid_visual(uuid) to ${group}`);
   expect((await tx`select public.shardkeep_bound_cosmetic_visual_sources_valid() valid`)[0]!.valid).toBe(true);
   await tx`select public.shardkeep_charter_retirement_source(),public.shardkeep_charter_tournament_source_check()`;
   await tx.unsafe(`grant execute on function public.shardkeep_bound_cosmetic_base_visual(uuid,text) to ${group} with grant option`);
   expect((await tx`select public.shardkeep_bound_cosmetic_visual_sources_valid() valid`)[0]!.valid).toBe(false);
   throw Error('rollback allowed group fixture');
  })).rejects.toThrow('rollback allowed group fixture');
 }
 const role=`visual_reader_${randomUUID().replaceAll('-','')}`;
 await expect(conn.sql.begin(async tx=>{
  await tx.unsafe(`create role ${role} nologin`);
  await tx.unsafe(`grant execute on function public.shardkeep_bound_cosmetic_raid_visual(uuid) to ${role}`);
  expect((await tx`select public.shardkeep_bound_cosmetic_visual_sources_valid() valid`)[0]!.valid).toBe(false);
  await tx`select public.shardkeep_charter_retirement_source()`;
 })).rejects.toThrow('CLAN_CHARTER_MIGRATION_SOURCE');
 await conn.sql`select public.shardkeep_charter_retirement_source(),public.shardkeep_charter_tournament_source_check()`;
}),180_000);

it('keeps the successor immutable and private, including attempted accidental grants',()=>fixture(async({conn,visualSql,extensionSql})=>{
 await conn.sql.begin(tx=>apply(tx,visualSql));await conn.sql.begin(tx=>apply(tx,extensionSql));
 for(const query of [`update ${seal} set record=record`,`delete from ${seal}`,`truncate ${seal}`,
  `insert into ${seal} select * from ${seal} on conflict do nothing`]){
  await expect(conn.sql.unsafe(query)).rejects.toThrow('BOUND_COSMETIC_VISUAL_SEAL_IMMUTABLE');
 }
 const role=`visual_seal_${randomUUID().replaceAll('-','')}`;await conn.sql.unsafe(`create role ${role} noinherit`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to ${role}`);
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(`select * from ${seal}`);})).rejects.toMatchObject({code:'42501'});
  await expect(conn.sql.begin(async tx=>{
   await tx.unsafe(`grant select,insert on ${seal} to ${role}`);await tx.unsafe(`set local role ${role}`);
   await tx.unsafe(`insert into ${seal} select * from ${seal} on conflict do nothing`);
  })).rejects.toThrow('BOUND_COSMETIC_VISUAL_SEAL_IMMUTABLE');
 }finally{await conn.sql.unsafe(`drop owned by ${role}`);await conn.sql.unsafe(`drop role ${role}`);}
 await conn.sql`select public.shardkeep_charter_retirement_source()`;
}),180_000);
