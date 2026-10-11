/** Each immutable resource-claim suite owns its database. Its receipts must not
 * reach the shared deed-cutover reset or depend on the order of test files. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {createDb} from '../../src/db/client';
import {runMigrations} from '../../src/db/migrate';
import {bootstrapSystemAccounts} from '../../src/ledger';
import {ADMIN_DATABASE_URL} from '../db-url';
import {createMigratedDatabase} from '../migratedTemplate';
export function resourceClaimsDatabase(){
 const name=`resource_claims_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${name}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Resource fixture requires local owned database');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),conn=createDb(url.toString(),{max:4});let created=false;
 return {...conn,reopen:()=>createDb(url.toString(),{max:4}),async setup(){await createMigratedDatabase(admin,name);created=true;
  // A setup that throws after the clone drops it here: not every caller closes a fixture
  // whose setup failed, and a leaked clone keeps GRANTs to the shared runtime groups, so a
  // later file's DROP ROLE fails (K-night-R3b).
  try{await runMigrations(conn.db);await bootstrapSystemAccounts(conn.db);}
  catch(error){await admin.unsafe(`drop database if exists ${name} with (force)`);created=false;throw error;}},async close(){await conn.sql.end();try{if(created)await admin.unsafe(`drop database ${name} with (force)`);}finally{await admin.end();}}};
}
