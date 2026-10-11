/** Additive installation must preserve both dormant gameplay and already
 * captured money/history; installing a table supplies no historical custody. */
import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {Keypair} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bootstrapSystemAccounts,getOrCreateBaseAccount,postTransaction} from '../src/ledger';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {captureMiningRosterCheckpoint} from '../src/mining/rosterCheckpoints';
import {ADMIN_DATABASE_URL} from './db-url';

it.each([false,true])('upgrades the real0202 frontier with enrollment=%s without rewriting money, history or source activation',async enrolled=>{
 const root=fileURLToPath(new URL('../drizzle',import.meta.url)),folder=await mkdtemp(path.join(tmpdir(),'roster-checkpoint-upgrade-'));
 const name='roster_checkpoint_upgrade_'+randomUUID().replaceAll('-','')+'_test',url=new URL(ADMIN_DATABASE_URL);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Owned local fixture required');url.pathname='/'+name;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});let conn:ReturnType<typeof createDb>|undefined;
 try{
  const all=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
  const index=all.entries.findIndex(e=>e.tag==='0203_mining_roster_checkpoints');expect(index).toBeGreaterThan(0);
  const journal={...all,entries:all.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const entry of journal.entries)await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`create database ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  const wallet=Keypair.generate().publicKey.toBase58(),base=randomUUID();
  await conn.sql`insert into players(wallet) values(${wallet})`;await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base})`;
  const sys=await bootstrapSystemAccounts(conn.db),account=await getOrCreateBaseAccount(conn.db,base,'base_shards');
  await postTransaction(conn.db,{idempotencyKey:randomUUID(),type:'test.roster.checkpoint.upgrade',entries:[{account:sys.shard_genesis,delta:-7n},{account:account.id,delta:7n}]});
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  if(enrolled){await initializeMiningRosterHistory(conn.db,wallet);await conn.sql`update bases set status='inactive' where id=${base}`;await conn.sql`update bases set status='active' where id=${base}`;}
  const tables=['players','bases','base_slots','accounts','ledger_transactions','ledger_entries','mining_roster_baselines','mining_roster_events','mining_roster_transactions'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,{
   oid:(await conn!.sql`select ${table}::regclass::oid::text oid`)[0]!.oid,
   rows:await conn!.sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`)}])));
  const hooks=()=>conn!.sql`select tgrelid::regclass::text relation,tgname,tgenabled from pg_trigger where tgname like '%mining_roster%' order by relation,tgname`;
  const before=await snapshot(),beforeHooks=await hooks();
  expect(await conn.sql`select to_regclass('public.mining_roster_checkpoints') relation`).toEqual([{relation:null}]);
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  const migration=await readFile(path.join(root,'0203_mining_roster_checkpoints.sql'),'utf8');
  for(let pass=0;pass<2;pass++)await conn.sql.begin(async tx=>{for(const statement of migration.split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});
  expect(await snapshot()).toEqual(before);expect((await hooks()).filter(h=>h.relation!=='mining_roster_checkpoints')).toEqual(beforeHooks);
  expect(await conn.sql`select * from mining_roster_checkpoints`).toHaveLength(0);
  expect(await conn.sql`select count(*)::integer n from drizzle.__drizzle_migrations`).toEqual([{n:journal.entries.length}]);
  if(enrolled){await captureMiningRosterCheckpoint(conn.db,wallet);expect(await conn.sql`select wallet from mining_roster_checkpoints`).toEqual([{wallet}]);expect(await snapshot()).toEqual(before);}
  else{
   // The additive migration cannot silently activate the preexisting source fence.
   await conn.sql.begin('isolation level repeatable read',async tx=>{await tx`update bases set status='inactive' where id=${base}`;});
   expect(await conn.sql`select * from mining_roster_baselines`).toHaveLength(0);expect(await conn.sql`select * from mining_roster_events`).toHaveLength(0);
   await expect(captureMiningRosterCheckpoint(conn.db,wallet)).rejects.toMatchObject({cause:{message:'MINING_ROSTER_CHECKPOINT_BASELINE_REQUIRED'}});
   expect(await conn.sql`select * from mining_roster_checkpoints`).toHaveLength(0);
  }
 }finally{vi.unstubAllEnvs();await conn?.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120000);
