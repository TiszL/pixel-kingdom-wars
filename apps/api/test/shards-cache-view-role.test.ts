/** PUBLIC access to the combined view never replaces underlying table authority. */
import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';

it('requires invoker source-table privileges for public view reads without granting account or view writes',async()=>{
 const owner=resourceClaimsDatabase(),role=`cache_view_${randomUUID().replaceAll('-','')}`,password=randomUUID();
 let runtime:ReturnType<typeof createDb>|undefined,roleCreated=false;
 try{
  await owner.setup();vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  const f=await createShardsHistoryFixture(owner.db);await f.collect();
  const [database]=await owner.sql`select current_database() name`;
  await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await owner.sql.unsafe(`GRANT CONNECT ON DATABASE ${database!.name} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}`);
  const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
  expect((await owner.sql`select reloptions from pg_class where oid='public.shards_tax_all_assessments'::regclass`)[0]!.reloptions).toContain('security_invoker=true');
  const privileges=async()=>runtime!.sql`select
   has_table_privilege(current_user,'public.shards_tax_all_assessments','SELECT') can_read_view,
   has_table_privilege(current_user,'public.shards_tax_all_assessments','INSERT') can_insert_view,
   has_table_privilege(current_user,'public.shards_tax_all_assessments','UPDATE') can_update_view,
   has_table_privilege(current_user,'public.shards_tax_all_assessments','DELETE') can_delete_view,
   has_table_privilege(current_user,'public.accounts','SELECT') can_read_accounts,
   has_table_privilege(current_user,'public.accounts','UPDATE') can_update_accounts`;
  const expected=[{can_read_view:true,can_insert_view:false,can_update_view:false,can_delete_view:false,can_read_accounts:false,can_update_accounts:false}];
  expect(await privileges()).toEqual(expected);
  await expect(runtime.sql`select * from shards_tax_all_assessments`).rejects.toMatchObject({code:'42501'});
  // A Mine-only role cannot use UNION to bypass the cache table's permission.
  await owner.sql.unsafe(`GRANT SELECT ON public.shards_tax_assessments TO ${role}`);
  await expect(runtime.sql`select * from shards_tax_all_assessments where source_kind='physical_mine'`).rejects.toMatchObject({code:'42501'});
  await owner.sql.unsafe(`GRANT SELECT ON public.shards_cache_assessments TO ${role}`);
  const rows=await runtime.sql`select wallet,source_kind from shards_tax_all_assessments`;
  expect(rows).toEqual([{wallet:f.player.wallet,source_kind:'physical_mine'}]);expect(await privileges()).toEqual(expected);
  await expect(runtime.sql`update shards_tax_all_assessments set gross=gross`).rejects.toThrow();
  await expect(runtime.sql`select * from accounts`).rejects.toMatchObject({code:'42501'});
 }finally{
  vi.unstubAllEnvs();await runtime?.sql.end();
  if(roleCreated){await owner.sql.unsafe(`DROP OWNED BY ${role}`);await owner.sql.unsafe(`DROP ROLE ${role}`);}
  await owner.close();
 }
},120_000);
