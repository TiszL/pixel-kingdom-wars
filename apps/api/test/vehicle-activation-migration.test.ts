/** D-153.124: existing starter receipts survive the additive S5-held contract. */
import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {Keypair} from '@solana/web3.js';
import {expect,it} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {ADMIN_DATABASE_URL} from './db-url';
it('upgrades real0203 with a committed starter and preserves old table identities, rows and guards without seeding advanced assets',async()=>{
 const root=fileURLToPath(new URL('../drizzle',import.meta.url)),folder=await mkdtemp(path.join(tmpdir(),'vehicle-upgrade-'));
 const name='vehicle_upgrade_'+randomUUID().replaceAll('-','')+'_test',url=new URL(ADMIN_DATABASE_URL);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Owned local fixture required');url.pathname='/'+name;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});let conn:ReturnType<typeof createDb>|undefined;
 try{
  const all=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]},index=all.entries.findIndex(e=>e.tag==='0204_vehicle_activation_reservations');expect(index).toBeGreaterThan(0);
  await mkdir(path.join(folder,'meta'));for(const entry of all.entries)await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...all,entries:all.entries.slice(0,index)}));await admin.unsafe(`create database ${name}`);conn=createDb(url.toString());await runMigrations(conn.db,{migrationsFolder:folder});
  const wallet=Keypair.generate().publicKey.toBase58(),base=randomUUID(),berth=randomUUID(),job=randomUUID();
  await conn.sql`insert into players(wallet) values(${wallet})`;await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet})`;await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base})`;
  await conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berth},${wallet},${base},'berth',2,2)`;
  await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${job},${wallet},${base},${berth},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
  await conn.sql`insert into fleet_installations(base_id,berth_id,family,installed_wallet,completed_build_job_id,berth_completed_at) select ${base},${berth},'starter',${wallet},${job},completed_at from builder_jobs where id=${job}`;
  const snapshot=async()=>Object.fromEntries(await Promise.all(['players','bases','base_slots','buildings','builder_jobs','fleet_installations'].map(async table=>[table,{oid:(await conn!.sql`select ${table}::regclass::oid::text oid`)[0]!.oid,rows:await conn!.sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`)}])));
  const oldHook=()=>conn!.sql`select oid::text,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='fleet_installations'::regclass and tgname='starter_fleet_guard'`;
  const before=await snapshot(),hook=await oldHook();await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(all));await runMigrations(conn.db,{migrationsFolder:folder});await runMigrations(conn.db,{migrationsFolder:folder});
  expect(await snapshot()).toEqual(before);expect(await oldHook()).toEqual(hook);expect(await conn.sql`select * from vehicle_mint_registry`).toHaveLength(0);expect(await conn.sql`select * from vehicle_activation_reservations`).toHaveLength(0);
  const asset=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();await conn.sql`insert into vehicle_mint_registry(asset_id,collection,family,tier,owner_attestation) values(${asset},${collection},'survey_balloon',1,'{}')`;
  await expect(conn.sql`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${wallet},${randomUUID()},${asset},${base},${berth})`).rejects.toThrow('VEHICLE_BERTH_OCCUPIED');expect(await snapshot()).toEqual(before);
 }finally{await conn?.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120_000);
