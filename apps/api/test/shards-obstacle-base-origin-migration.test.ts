/** Base classification origin is prospective evidence, never a legacy backfill. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {OBSTACLES} from '@shardkeep/shared';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {createDb,type DbOrTx} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bases,baseSlots,builderJobs,obstacles} from '../src/db/schema';
import {admitShardsObstacleObligation} from '../src/mining/shardsTaxObstacleObligations';
const owner=resourceClaimsDatabase(),start=new Date('2038-01-01T00:00:00.000Z'),root=fileURLToPath(new URL('../drizzle',import.meta.url));
beforeAll(async()=>{await owner.setup();vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');});
afterAll(async()=>{vi.unstubAllEnvs();await owner.close();});
async function fixture(db:ReturnType<typeof createDb>['db']=owner.db){
 const player=await createTestPlayer(db),wallet=player.wallet;
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
 await db.insert(baseSlots).values({wallet,baseId:base!.id,slot:1});
 const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,
  finishesAt:new Date(+start+OBSTACLES.tiers.small.clearSec*1000)}).returning();
 const key=randomUUID(),command={baseId:base!.id,jobId:job!.id,idempotencyKey:key},context={baseId:base!.id,assertAuthority:async()=>{}};
 return {wallet,base:base!,job:job!,key,admit:(tx:DbOrTx=db)=>admitShardsObstacleObligation(tx,wallet,command,context,{clock:()=>start})};
}
it('installs immutable prospective base-origin and first-change journals',async()=>{
 expect(await owner.sql`select to_regclass('public.shards_obstacle_base_origins') origin,to_regclass('public.shards_obstacle_base_changes') changes`)
  .toEqual([{origin:'shards_obstacle_base_origins',changes:'shards_obstacle_base_changes'}]);
});
it('records full origin and first change with the original top XID across savepoints, UTC sessions and same-transaction out/back changes',async()=>{
 const f=await fixture();let top='';
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`set local timezone='Pacific/Kiritimati'`);
  const [id]=await tx.execute<{id:string}>(sql`select pg_current_xact_id()::text id`);top=id!.id;
  await tx.transaction(async nested=>{await f.admit(nested);});
  expect(await tx.execute(sql`select o.tx_key,o.original_obligation->>'evidence_sha256'=h.evidence_sha256 hash,
   public.shardkeep_shards_obstacle_base_origin_valid(o) valid from shards_obstacle_base_origins o
   join shards_obstacle_obligations h on h.id=o.obligation_id where o.obligation_id=${f.key}::uuid`)).toEqual([{tx_key:top,hash:true,valid:true}]);
  await tx.execute(sql`update bases set updated_at=updated_at where id=${f.base.id}::uuid`);
  expect(await tx.execute(sql`select * from shards_obstacle_base_changes where obligation_id=${f.key}::uuid`)).toHaveLength(0);
  await tx.execute(sql`update bases set land_paid_at=${start.toISOString()}::timestamptz where id=${f.base.id}::uuid`);
  const first=await tx.execute(sql`select * from shards_obstacle_base_changes where obligation_id=${f.key}::uuid`);
  expect(first).toHaveLength(1);expect(first[0]).toMatchObject({tx_key:top,before_base:{land_paid_at:null},after_base:{land_paid_at:'2038-01-01T00:00:00+00:00'}});
  await tx.execute(sql`update bases set land_paid_at=null where id=${f.base.id}::uuid`);
  expect(await tx.execute(sql`select * from shards_obstacle_base_changes where obligation_id=${f.key}::uuid`)).toEqual(first);
 });
 expect(await owner.sql`select o.tx_key,o.original_obligation=to_jsonb(h) exact_header,
  public.shardkeep_shards_obstacle_base_origin_valid(o) valid,
  o.original_base=public.shardkeep_shards_obstacle_base_state(b) current_matches from shards_obstacle_base_origins o
  join shards_obstacle_obligations h on h.id=o.obligation_id join bases b on b.id=h.base_id where o.obligation_id=${f.key}`)
  .toEqual([{tx_key:top,exact_header:true,valid:true,current_matches:true}]);
 // The restored current state cannot erase the first departure; the API must
 // separately require no change witness, not merely the matching origin state.
 expect(await owner.sql`select obligation_id from shards_obstacle_base_changes where obligation_id=${f.key}`).toHaveLength(1);
 for(const table of ['shards_obstacle_base_origins','shards_obstacle_base_changes']){
  const [row]=await owner.sql.unsafe(`select to_jsonb(t) value from ${table} t where obligation_id=$1`,[f.key]);
  await expect(owner.sql.unsafe(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,[JSON.stringify(row!.value)]))
   .rejects.toMatchObject({code:'42501',message:'SHARDS_OBSTACLE_BASE_WITNESS_ORIGIN'});
  for(const query of [`update ${table} set tx_key=tx_key where obligation_id=$1`,`delete from ${table} where obligation_id=$1`])
   await expect(owner.sql.unsafe(query,[f.key])).rejects.toMatchObject({message:'SHARDS_OBSTACLE_BASE_IMMUTABLE'});
  await expect(owner.sql.unsafe(`truncate ${table} cascade`)).rejects.toMatchObject({message:'SHARDS_OBSTACLE_BASE_IMMUTABLE'});
 }
});
it('rolls back origin and first-change evidence with their actual capture transaction',async()=>{
 const f=await fixture();
 await expect(owner.db.transaction(async tx=>{
  await f.admit(tx);await tx.execute(sql`update bases set land_paid_at=${start.toISOString()}::timestamptz where id=${f.base.id}::uuid`);
  expect(await tx.execute(sql`select * from shards_obstacle_base_changes where obligation_id=${f.key}::uuid`)).toHaveLength(1);
  throw Error('rollback origin and change');
 })).rejects.toThrow('rollback origin and change');
 for(const table of ['shards_obstacle_base_origins','shards_obstacle_base_changes'])expect(await owner.sql.unsafe(`select * from ${table} where obligation_id=$1`,[f.key])).toHaveLength(0);
 expect(await owner.sql`select id from shards_obstacle_obligations where id=${f.key}`).toHaveLength(0);
 expect(await owner.sql`select land_paid_at from bases where id=${f.base.id}`).toEqual([{land_paid_at:null}]);
});
it('serializes a pre-capture repeatable-read base writer instead of letting it miss the new origin',async()=>{
 const f=await fixture();let captured=false;
 await expect(owner.sql.begin(async stale=>{
  await stale.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await stale`select id from bases where id=${f.base.id}`;
  await f.admit();captured=true;
  await stale`update bases set land_paid_at=${start.toISOString()}::timestamptz where id=${f.base.id}`;
 })).rejects.toMatchObject({code:'40001'});
 expect(captured).toBe(true);
 expect(await owner.sql`select obligation_id from shards_obstacle_base_origins where obligation_id=${f.key}`).toHaveLength(1);
 expect(await owner.sql`select obligation_id from shards_obstacle_base_changes where obligation_id=${f.key}`).toHaveLength(0);
 expect(await owner.sql`select land_paid_at from bases where id=${f.base.id}`).toEqual([{land_paid_at:null}]);
});
it('upgrades 0198 without backfilling old headers, repeats unchanged and captures only a later real insert',async()=>{
 const name=`obstacle_origin_upgrade_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),folder=await mkdtemp(path.join(tmpdir(),'phase-e-origin-upgrade-'));let conn:ReturnType<typeof createDb>|undefined;
 try{
  const all=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
  const index=all.entries.findIndex(e=>e.tag==='0199_shards_obstacle_base_origins');expect(index).toBeGreaterThan(0);
  const journal={...all,entries:all.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const e of journal.entries)await copyFile(path.join(root,e.tag+'.sql'),path.join(folder,e.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  const f=await fixture(conn.db);await f.admit();
  const tables=['bases','builder_jobs','obstacles','shards_obstacle_obligations','player_action_events','player_activity_days','ledger_transactions','ledger_entries'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,await conn!.sql.unsafe(`select to_jsonb(t)::text value from ${t} t order by to_jsonb(t)::text`)])));
  const before=await snapshot();await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  const migration=await readFile(path.join(root,'0199_shards_obstacle_base_origins.sql'),'utf8');
  for(let pass=0;pass<2;pass++)for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(statement);
  expect(await snapshot()).toEqual(before);
  expect(await conn.sql`select * from shards_obstacle_base_origins`).toHaveLength(0);
  await conn.sql`update bases set land_paid_at=${start.toISOString()}::timestamptz where id=${f.base.id}`;
  expect(await conn.sql`select * from shards_obstacle_base_changes`).toHaveLength(0);
  const fresh=await fixture(conn.db);await fresh.admit();
  expect(await conn.sql`select obligation_id from shards_obstacle_base_origins`).toEqual([{obligation_id:fresh.key}]);
 }finally{await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120_000);
it('preserves normal base updates for an actual old-rights LOGIN while rejecting direct origin/change inserts',async()=>{
 const role=`base_origin_${randomUUID().replaceAll('-','')}`,password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined,created=false;
 try{
  const [database]=await owner.sql`select current_database() name`;
  await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);created=true;
  await owner.sql.unsafe(`GRANT CONNECT ON DATABASE ${database!.name} TO ${role};GRANT USAGE ON SCHEMA public TO ${role};
   GRANT SELECT,UPDATE ON public.bases TO ${role};GRANT SELECT ON public.league_reward_activations TO ${role};
   GRANT SELECT,INSERT ON public.player_action_events TO ${role}`);
  const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
  expect(await runtime.sql`select current_user as current_role,session_user as login_role`).toEqual([{current_role:role,login_role:role}]);
  for(const hook of ['shardkeep_shards_obstacle_base_origin_insert','shardkeep_shards_obstacle_base_change_update']){
   expect(await runtime.sql`select has_function_privilege(current_user,${'public.'+hook+'()'},'EXECUTE') allowed`).toEqual([{allowed:false}]);
   await expect(runtime.sql.unsafe(`select public.${hook}()`)).rejects.toMatchObject({code:'42501'});
  }
  const f=await fixture();
  await runtime.sql`update bases set land_paid_at=${start.toISOString()}::timestamptz where id=${f.base.id}`;
  await runtime.sql`update bases set land_paid_at=null where id=${f.base.id}`;
  await f.admit();
  await runtime.sql`update bases set updated_at=updated_at where id=${f.base.id}`;
  expect(await owner.sql`select obligation_id from shards_obstacle_base_changes where obligation_id=${f.key}`).toHaveLength(0);
  await runtime.sql`update bases set land_paid_at=${start.toISOString()}::timestamptz where id=${f.base.id}`;
  const first=await owner.sql`select * from shards_obstacle_base_changes where obligation_id=${f.key}`;expect(first).toHaveLength(1);
  await runtime.sql`update bases set land_paid_at=null where id=${f.base.id}`;
  await runtime.sql`update bases set deed_mint_asset_id=${randomUUID()} where id=${f.base.id}`;
  await runtime.sql`update bases set deed_mint_asset_id=null where id=${f.base.id}`;
  expect(await owner.sql`select * from shards_obstacle_base_changes where obligation_id=${f.key}`).toEqual(first);
  for(const table of ['shards_obstacle_base_origins','shards_obstacle_base_changes']){
   expect(await runtime.sql`select has_table_privilege(current_user,${'public.'+table},'SELECT') allowed`).toEqual([{allowed:false}]);
   await expect(runtime.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});
   const [row]=await owner.sql.unsafe(`select to_jsonb(t) value from ${table} t where obligation_id=$1`,[f.key]);
   await owner.sql.unsafe(`GRANT INSERT ON public.${table} TO ${role}`);
   await expect(runtime.sql.unsafe(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,[JSON.stringify(row!.value)]))
    .rejects.toMatchObject({code:'42501',message:'SHARDS_OBSTACLE_BASE_WITNESS_ORIGIN'});
  }
 }finally{await runtime?.sql.end();if(created){await owner.sql.unsafe(`DROP OWNED BY ${role}`);await owner.sql.unsafe(`DROP ROLE ${role}`);}}
});
