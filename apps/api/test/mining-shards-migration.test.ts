/** A prospective source boundary cannot rewrite existing money or Mine state. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {expect,it} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {ADMIN_DATABASE_URL} from './db-url';

it('upgrades the pre-SHARDS-source frontier additively, preserves money identities and repeats without backfill',async()=>{
 const name=`shards_source_upgrade_${randomUUID().replaceAll('-','')}_test`,admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});
 const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 const root=fileURLToPath(new URL('../drizzle',import.meta.url)),folder=await mkdtemp(path.join(tmpdir(),'phase-e-shards-migration-'));
 let conn:ReturnType<typeof createDb>|undefined;
 try{
  const journal=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string;when:number}[]};
  expect(journal.entries.slice(journal.entries.findIndex(e=>e.tag==='0191_shards_tax_account'),journal.entries.findIndex(e=>e.tag==='0191_shards_tax_account')+2).map(e=>e.tag)).toEqual(['0191_shards_tax_account','0192_shards_mine_sources']);
  const parent=journal.entries.findIndex(e=>e.tag==='0190_mining_tax_claim_continuations');expect(parent).toBeGreaterThan(0);
  await mkdir(path.join(folder,'meta'));await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,parent+1)}));
  for(const entry of journal.entries)await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:1});const {db,sql}=conn;await runMigrations(db,{migrationsFolder:folder});
  const wallet='shards_upgrade_'+randomUUID();await sql`insert into players(wallet) values(${wallet})`;const [base]=await sql`insert into bases(owner_wallet) values(${wallet}) returning id`;
  const [receipt]=await sql`insert into ledger_transactions(idempotency_key,type) values(${randomUUID()},'fixture.shards') returning id`;
  for(const [kind,baseId,balance] of [['shard_genesis',null,-13],['base_shards',base!.id,13]] as const){
   const [account]=await sql`insert into accounts(kind,currency,base_id,balance) values(${kind},'SHARDS',${baseId},${balance}) returning id`;
   await sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${receipt!.id},${account!.id},${balance},${balance})`;
  }
  const [mine]=await sql`insert into buildings(player_wallet,base_id,type,tx,ty) values(${wallet},${base!.id},'mine',1,1) returning id`;
  await sql`insert into mine_accrual_states(mine_building_id,accrued_shards,last_accrual_at,version) values(${mine!.id},17,'2026-09-01T00:00:00Z',4)`;
  const tables=['accounts','deposits','withdrawals','ledger_transactions','ledger_entries','bases','buildings','mine_accrual_states'];
  // The full upgrade later adds0232's nullable remainder. Compare all original
  // Mine fields exactly and check the new field independently for no backfill.
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,{
   oid:(await sql`select ${table}::regclass::oid::text oid`)[0]!.oid,
   rows:await sql.unsafe(`select ${table==='mine_accrual_states'?"(to_jsonb(t)-'production_remainder')":'to_jsonb(t)'}::text value from ${table} t order by value`),
  }])));
  expect(await sql`select column_name from information_schema.columns where table_schema='public' and table_name='mine_accrual_states' and column_name='production_remainder'`).toEqual([]);
  const before=await snapshot(),enumBefore=await sql`select oid::text from pg_type where typname='account_kind'`;
  const labelsBefore=await sql`select e.oid::text,e.enumlabel,e.enumsortorder from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='account_kind' order by e.enumsortorder`;
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(db,{migrationsFolder:folder});
  expect(await snapshot()).toEqual(before);expect(await sql`select oid::text from pg_type where typname='account_kind'`).toEqual(enumBefore);
  expect(await sql`select production_remainder from mine_accrual_states`).toEqual([{production_remainder:null}]);
  expect(await sql`select count(*)::int n from shards_mine_eras`).toEqual([{n:0}]);expect(await sql`select count(*)::int n from shards_tax_assessments`).toEqual([{n:0}]);
  for(let pass=0;pass<2;pass++)for(const tag of ['0191_shards_tax_account','0192_shards_mine_sources'])for(const statement of (await readFile(path.join(root,tag+'.sql'),'utf8')).split('--> statement-breakpoint').filter(s=>s.trim()))await sql.unsafe(statement);
  expect(await snapshot()).toEqual(before);expect(await sql`select count(*)::int n from shards_mine_eras`).toEqual([{n:0}]);
  expect(await sql`select production_remainder from mine_accrual_states`).toEqual([{production_remainder:null}]);
  // Later additive kinds may follow this migration; every old label identity
  // must survive, and the SHARDS source kind must still exist exactly once.
  const labelsAfter=await sql`select e.oid::text,e.enumlabel,e.enumsortorder from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='account_kind' order by e.enumsortorder`;
  expect(labelsAfter.filter(row=>labelsBefore.some(old=>old.enumlabel===row.enumlabel))).toEqual(labelsBefore);
  expect(labelsAfter.filter(row=>row.enumlabel==='shards_tax_escrow').map(row=>({enumlabel:row.enumlabel}))).toEqual([{enumlabel:'shards_tax_escrow'}]);
 }finally{await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();}
},120_000);
