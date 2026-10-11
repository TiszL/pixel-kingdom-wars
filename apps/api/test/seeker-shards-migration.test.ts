/** Adding payout history must preserve previously funded source obligations. */
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
it('upgrades the funded source frontier without rewriting source, money or prior receipt identities',async()=>{
 const name=`shards_claim_upgrade_${randomUUID().replaceAll('-','')}_test`,admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 const root=fileURLToPath(new URL('../drizzle',import.meta.url)),folder=await mkdtemp(path.join(tmpdir(),'phase-e-shards-claim-migration-'));let conn:ReturnType<typeof createDb>|undefined;
 try{
  const fullJournal=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string;when:number}[]},index=fullJournal.entries.findIndex(entry=>entry.tag==='0193_seeker_shards_claims');expect(index).toBeGreaterThan(0);const journal={...fullJournal,entries:fullJournal.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const e of journal.entries)await copyFile(path.join(root,e.tag+'.sql'),path.join(folder,e.tag+'.sql'));await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
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

  // Fixture-only compatibility lets the current source writer seed a real
  // pre-cache Mine receipt. Remove it before the historical upgrade boundary;
  // current complete-history readers also require the later cache schema.
  await conn.sql.unsafe(`CREATE VIEW shards_tax_all_assessments AS SELECT operation_key,segment_id::text AS segment_id,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,term_id,term_hash,ledger_id,receipt,'physical_mine'::text AS source_kind FROM shards_tax_assessments`);
  vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');const f=await createShardsHistoryFixture(conn.db,{legacy:7n});await f.collect();const sql=conn.sql;
  await sql.unsafe('DROP VIEW shards_tax_all_assessments');await conn.sql.unsafe('DROP FUNCTION public.shardkeep_shards_obstacle_pending(text,timestamptz)');await conn.sql.unsafe('DROP VIEW shards_mine_policy_boundary');await conn.sql.unsafe('ALTER TABLE shards_mine_eras DROP COLUMN policy_boundary_id');
  expect(await sql`select production_remainder from mine_accrual_states`).toEqual([{production_remainder:null}]);
  await sql.unsafe('ALTER TABLE mine_accrual_states DROP COLUMN production_remainder');
  const readPool=async()=>BigInt((await sql`select sum(tax)::text amount from shards_tax_assessments where term_id=${f.termId}`)[0]!.amount),pool=await readPool();
  const tables=['accounts','deposits','withdrawals','ledger_transactions','ledger_entries','mine_accrual_states','shards_mine_eras','shards_mine_segments','shards_mine_deliveries','shards_tax_assessments'];
  const remainderColumns=()=>sql`select column_name from information_schema.columns where table_schema='public' and table_name='mine_accrual_states' and column_name='production_remainder'`;
  expect(await remainderColumns()).toEqual([]);
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,{oid:(await sql`select ${t}::regclass::oid::text oid`)[0]!.oid,rows:await sql.unsafe(`select to_jsonb(t)::text value from ${t} t order by to_jsonb(t)::text`)}])));
  const before=await snapshot();await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  for(let pass=0;pass<2;pass++)for(const statement of (await readFile(path.join(root,'0193_seeker_shards_claims.sql'),'utf8')).split('--> statement-breakpoint').filter(s=>s.trim()))await sql.unsafe(statement);
  expect(await snapshot()).toEqual(before);expect(await remainderColumns()).toEqual([]);expect(await readPool()).toBe(pool);expect(await sql`select count(*)::int n from seeker_shards_claims`).toEqual([{n:0}]);
 }finally{vi.unstubAllEnvs();await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();}
},120_000);
