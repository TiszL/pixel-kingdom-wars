/** Failure evidence is additive: existing money and original success stay exact. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {ADMIN_DATABASE_URL} from './db-url';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {retainRealmSaleSettlementFixture} from './fixtures/realmSaleSettlement';
import {createRealmSaleSettlement,getRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
import {createRealmSaleFailure,getRealmSaleFailure} from '../src/seeker/realmSaleFailure';
it('upgrades funded sources and a settled signed realm purchase without changing money, original receipt or custody',async()=>{
 const name=`realm_failure_upgrade_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),root=fileURLToPath(new URL('../drizzle',import.meta.url)),folder=await mkdtemp(path.join(tmpdir(),'phase-e-realm-failure-migration-'));let conn:ReturnType<typeof createDb>|undefined;
 try{
  const fullJournal=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string;when:number}[]},index=fullJournal.entries.findIndex(e=>e.tag==='0194_seeker_realm_sale_failures');expect(index).toBeGreaterThan(0);const journal={...fullJournal,entries:fullJournal.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const entry of journal.entries)await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  // This historical frontier has no obstacle captures. Supply only the absent
  // pending predicate for today's Mine writer, then drop it before the snapshot.
  await conn.sql.unsafe(`CREATE FUNCTION public.shardkeep_shards_obstacle_pending(text,timestamptz) RETURNS boolean LANGUAGE sql VOLATILE AS 'SELECT false'`);
  // Temporary compatibility only; remove before the historical schema snapshot.
  await conn.sql.unsafe(`CREATE VIEW shards_mine_policy_boundary AS SELECT 1::integer id,NULL::timestamptz effective_at WHERE false`);
  await conn.sql.unsafe('ALTER TABLE shards_mine_eras ADD COLUMN policy_boundary_id integer');
  // Current Drizzle/source reads name the later0232 remainder column. NULL
  // preserves legacy accrual; remove it before testing the actual old schema.
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states ADD COLUMN production_remainder bigint');

  // Fixture-only Mine view lets today's source writer seed the historical
  // frontier. Drop it before the schema snapshot; current full-history readers
  // intentionally require the later cache schema and are not used here.
  await conn.sql.unsafe(`CREATE VIEW shards_tax_all_assessments AS SELECT operation_key,segment_id::text AS segment_id,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,term_id,term_hash,ledger_id,receipt,'physical_mine'::text AS source_kind FROM shards_tax_assessments`);
  vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');const source=await createShardsHistoryFixture(conn.db,{legacy:7n});await source.collect();
  await conn.sql.unsafe('DROP VIEW shards_tax_all_assessments');await conn.sql.unsafe('DROP FUNCTION public.shardkeep_shards_obstacle_pending(text,timestamptz)');await conn.sql.unsafe('DROP VIEW shards_mine_policy_boundary');await conn.sql.unsafe('ALTER TABLE shards_mine_eras DROP COLUMN policy_boundary_id');
  expect(await conn.sql`select production_remainder from mine_accrual_states`).toEqual([{production_remainder:null}]);
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states DROP COLUMN production_remainder');
  const readPool=async()=>BigInt((await conn!.sql`select sum(tax)::text amount from shards_tax_assessments where term_id=${source.termId}`)[0]!.amount),pool=await readPool();
  const realm=await retainRealmSaleSettlementFixture(conn.db),settled=await createRealmSaleSettlement(conn.db,{connect:()=>realm.chain.rpc,trust:realm.chain.trust})(realm.key),sql=conn.sql;
  const tables=['accounts','deposits','withdrawals','ledger_transactions','ledger_entries','mine_accrual_states','shards_mine_eras','shards_mine_segments','shards_mine_deliveries','shards_tax_assessments','seeker_shards_claims','seeker_realm_sale_preparations','seeker_realm_sale_signed_wires','seeker_realm_sale_receipts'];
  const remainderColumns=()=>sql`select column_name from information_schema.columns where table_schema='public' and table_name='mine_accrual_states' and column_name='production_remainder'`;
  expect(await remainderColumns()).toEqual([]);
  const snapshot=async()=>({types:await sql`select typname,oid::text from pg_type where typname in ('account_kind','currency') order by typname`,tables:Object.fromEntries(await Promise.all(tables.map(async table=>[table,{oid:(await sql`select ${table}::regclass::oid::text oid`)[0]!.oid,rows:await sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`)}])))});
  const before=await snapshot();await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  for(let pass=0;pass<2;pass++)for(const statement of (await readFile(path.join(root,'0194_seeker_realm_sale_failures.sql'),'utf8')).split('--> statement-breakpoint').filter(s=>s.trim()))await sql.unsafe(statement);
  expect(await snapshot()).toEqual(before);expect(await remainderColumns()).toEqual([]);expect(await readPool()).toBe(pool);expect(await sql`select count(*)::int n from seeker_realm_sale_failures`).toEqual([{n:0}]);
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');vi.stubEnv('PHASE_E_MINING_ENABLED','false');const down=vi.fn(()=>{throw Error('provider unavailable');});
  expect(await getRealmSaleSettlement(conn.db,realm.key)).toEqual(settled);expect(await createRealmSaleSettlement(conn.db,{connect:down,trust:realm.chain.trust})(realm.key)).toEqual(settled);
  expect(await getRealmSaleFailure(conn.db,realm.key)).toBeNull();await expect(createRealmSaleFailure(conn.db,{connect:down,trust:realm.chain.trust})(realm.key)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});expect(down).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
 }finally{vi.unstubAllEnvs();await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();}
},120_000);
