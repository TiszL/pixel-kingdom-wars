/** The legacy-capture test must retain a real pre-0280 raid after the journal
 * advances. Other visual tests exercise normal current startup. */
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {createDb} from '../../src/db/client';
import {runMigrations} from '../../src/db/migrate';
import {bootstrapSystemAccounts} from '../../src/ledger';
import {ADMIN_DATABASE_URL} from '../db-url';
import {createMigratedDatabase} from '../migratedTemplate';
export function cosmeticVisualDatabase(legacyPrefix=false){
 const name=`cosmetic_visual_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${name}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Visual fixture requires owned loopback database');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),conn=createDb(url.toString(),{max:4});let created=false;
 return {...conn,reopen:()=>createDb(url.toString(),{max:4}),async setup(){
  // The legacy prefix replays a truncated chain into an empty database.
  await (legacyPrefix?admin.unsafe(`create database ${name}`):createMigratedDatabase(admin,name));created=true;let folder:string|undefined;
  try{
   if(legacyPrefix){
    folder=await mkdtemp(join(tmpdir(),'bound-visual-prefix-'));
    await cp(fileURLToPath(new URL('../../drizzle',import.meta.url)),folder,{recursive:true});
    const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8')) as {entries:{tag:string}[]};
    const index=journal.entries.findIndex(entry=>entry.tag==='0279_bound_cosmetic_source_contract');if(index<0)throw Error('Missing exact visual predecessor');
    await writeFile(path,JSON.stringify({...journal,entries:journal.entries.slice(0,index+1)}));
   }
   await runMigrations(conn.db,folder?{migrationsFolder:folder}:undefined);await bootstrapSystemAccounts(conn.db);
  }finally{if(folder)await rm(folder,{recursive:true,force:true});}
 },async close(){await conn.sql.end();try{if(created)await admin.unsafe(`drop database ${name} with (force)`);}finally{await admin.end();}}};
}
