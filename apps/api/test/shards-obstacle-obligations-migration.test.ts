import {seedHistoricalTaxedCache} from './fixtures/historicalTaxedCache';
/** Prospective obligation retention must not invent old earning or rewrite money. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {afterEach,expect,it,vi} from 'vitest';
import {OBSTACLES} from '@shardkeep/shared';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bases,baseSlots,builderJobs,obstacles} from '../src/db/schema';
import {MINE_DAY_MS} from '../src/game/baseMining';
import {readCompleteShardsTaxPool} from '../src/mining/shardsTaxHistory';
import {ADMIN_DATABASE_URL} from './db-url';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer} from './helpers';

const root=fileURLToPath(new URL('../drizzle',import.meta.url));
afterEach(()=>vi.unstubAllEnvs());

it('upgrades funded Mine/cache history and an unfinished old obstacle job without backfill or changing identities, then repeats',async()=>{
 const name=`shards_obstacle_upgrade_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),folder=await mkdtemp(path.join(tmpdir(),'phase-e-obstacle-upgrade-'));
 let conn:ReturnType<typeof createDb>|undefined;
 try{
  const full=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string;when:number}[]};
  const index=full.entries.findIndex(e=>e.tag==='0196_shards_obstacle_obligations');expect(index).toBeGreaterThan(0);
  const journal={...full,entries:full.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const entry of journal.entries)await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  // Today's Mine/cache writer checks prospective obligations. At this historical
  // frontier none exist. The fixture-only compatibility function is removed
  // before the snapshot and upgrade; it supplies no fake historical headers.
  await conn.sql.unsafe(`CREATE FUNCTION public.shardkeep_shards_obstacle_pending(wallet text,term_start timestamptz)
   RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT false $$`);
  // Temporary compatibility for today's writer; remove both before snapshot.
  await conn.sql.unsafe(`CREATE VIEW shards_mine_policy_boundary AS SELECT 1::integer id,NULL::timestamptz effective_at WHERE false`);
  await conn.sql.unsafe('ALTER TABLE shards_mine_eras ADD COLUMN policy_boundary_id integer');
  // NULL keeps today's source writer on the legacy accrual path. Remove this
  // later0232 column before snapshotting the actual historical schema.
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states ADD COLUMN production_remainder bigint');
  const f=await createShardsHistoryFixture(conn.db,{legacy:7n}),at=new Date(+f.start+Math.ceil(3*MINE_DAY_MS/Number(f.quota)));
  await f.collect(at);
  await seedHistoricalTaxedCache(conn.db,f.player.wallet,{...f.context,shardsCacheSource:{clock:()=>at,prefetch:async()=>({readOperatingTerm:async()=>({...f.observation,finality:{...f.observation.finality,observedAt:at.toISOString()}})})}},at);
  const [obstacle]=await conn.db.insert(obstacles).values({playerWallet:f.player.wallet,baseId:f.base.id,spriteKey:'obs_bush_1',tx:0,ty:0}).returning();
  await conn.db.insert(builderJobs).values({playerWallet:f.player.wallet,baseId:f.base.id,kind:'clear_obstacle',obstacleId:obstacle!.id,
   startedAt:at,finishesAt:new Date(+at+OBSTACLES.tiers.small.clearSec*1000)});
  await conn.sql.unsafe('DROP FUNCTION public.shardkeep_shards_obstacle_pending(text,timestamptz)');
  await conn.sql.unsafe('DROP VIEW shards_mine_policy_boundary');
  await conn.sql.unsafe('ALTER TABLE shards_mine_eras DROP COLUMN policy_boundary_id');
  expect(await conn.sql`select production_remainder from mine_accrual_states`).toEqual([{production_remainder:null}]);
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states DROP COLUMN production_remainder');
  const sql=conn.sql,tables=['players','bases','base_slots','buildings','mine_accrual_states','obstacles','builder_jobs',
   'accounts','deposits','withdrawals','ledger_transactions','ledger_entries','expedition_term_snapshots',
   'shards_mine_admissions','shards_mine_eras','shards_mine_segments','shards_mine_deliveries','shards_tax_assessments',
   'shards_cache_sources','shards_cache_assessments','shards_tax_all_assessments','seeker_shards_claims'];
  const remainderColumns=()=>sql`select column_name from information_schema.columns where table_schema='public' and table_name='mine_accrual_states' and column_name='production_remainder'`;
  expect(await remainderColumns()).toEqual([]);
  const snapshot=async()=>({
   enums:await sql`select t.typname,t.oid::text type_oid,e.oid::text label_oid,e.enumlabel,e.enumsortorder
    from pg_type t join pg_enum e on e.enumtypid=t.oid where t.typname in ('account_kind','currency') order by t.typname,e.enumsortorder`,
   tables:Object.fromEntries(await Promise.all(tables.map(async table=>[table,{
    oid:(await sql`select ${table}::regclass::oid::text oid`)[0]!.oid,
    rows:await sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`),
   }]))),
  });
  expect(await sql`select source_kind from shards_tax_all_assessments where wallet=${f.player.wallet} order by source_kind`).toEqual([{source_kind:'daily_cache'},{source_kind:'physical_mine'}]);
  expect(await sql`select id from ledger_transactions`).not.toHaveLength(0);
  expect(await sql`select to_regclass('public.shards_obstacle_obligations') relation`).toEqual([{relation:null}]);
  const before=await snapshot(),pool=await readCompleteShardsTaxPool(conn.db,f.termId,f.termHash);
  expect(pool).toBeGreaterThan(0n);
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  const migration=await readFile(path.join(root,'0196_shards_obstacle_obligations.sql'),'utf8');
  for(let pass=0;pass<2;pass++)for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await sql.unsafe(statement);
  expect(await sql`select count(*)::int n from shards_obstacle_obligations`).toEqual([{n:0}]);
  expect(await sql`select shardkeep_shards_obstacle_pending(${f.player.wallet},${f.start.toISOString()}::timestamptz) pending`).toEqual([{pending:false}]);
  expect(await snapshot()).toEqual(before);
  expect(await remainderColumns()).toEqual([]);
  expect(await readCompleteShardsTaxPool(conn.db,f.termId,f.termHash)).toBe(pool);
 }finally{await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120_000);

it('allows restricted history reads but refuses raw capture even with an accidental INSERT grant',async()=>{
 const owner=resourceClaimsDatabase(),role=`obstacle_reader_${randomUUID().replaceAll('-','')}`,password=randomUUID();
 let runtime:ReturnType<typeof createDb>|undefined,roleCreated=false;
 try{
  await owner.setup();
  const player=await createTestPlayer(owner.db),[base]=await owner.db.insert(bases).values({ownerWallet:player.wallet,status:'active',keepLevel:1}).returning();
  await owner.db.insert(baseSlots).values({wallet:player.wallet,slot:1,baseId:base!.id});
  const start=new Date('2038-01-01T00:00:00.000Z'),finish=new Date(+start+OBSTACLES.tiers.small.clearSec*1000);
  const [obstacle]=await owner.db.insert(obstacles).values({playerWallet:player.wallet,baseId:base!.id,spriteKey:'obs_bush_1',tx:0,ty:0}).returning();
  const [job]=await owner.db.insert(builderJobs).values({playerWallet:player.wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,finishesAt:finish}).returning();
  const header={id:randomUUID(),job_id:job!.id,base_id:base!.id,obstacle_id:obstacle!.id,wallet:player.wallet,deed_asset_id:null,
   captured_at:new Date(+start+1).toISOString(),started_at:start.toISOString(),scheduled_finish_at:finish.toISOString(),gross:String(OBSTACLES.clearRewardShards),evidence_sha256:'ab'.repeat(32)};
  await owner.sql`insert into shards_obstacle_obligations select * from jsonb_populate_record(null::shards_obstacle_obligations,${JSON.stringify(header)}::jsonb)`;
  const [database]=await owner.sql`select current_database() name`;
  await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
  await owner.sql.unsafe(`GRANT CONNECT ON DATABASE ${database!.name} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT ON public.shards_obstacle_obligations TO ${role}`);
  const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
  expect(await runtime.sql`select id,wallet from shards_obstacle_obligations`).toEqual([{id:header.id,wallet:player.wallet}]);
  expect(await runtime.sql`select has_table_privilege(current_user,'public.shards_obstacle_obligations','INSERT') can_insert,
   has_table_privilege(current_user,'public.accounts','SELECT') can_read_accounts,
   has_table_privilege(current_user,'public.accounts','UPDATE') can_update_accounts`).toEqual([{can_insert:true,can_read_accounts:false,can_update_accounts:false}]);
  await expect(runtime.sql`insert into shards_obstacle_obligations select * from jsonb_populate_record(null::shards_obstacle_obligations,${JSON.stringify({...header,id:randomUUID()})}::jsonb)`)
   .rejects.toMatchObject({code:'42501',message:'SHARDS_OBSTACLE_OWNER_REQUIRED'});
  await expect(runtime.sql`select * from accounts`).rejects.toMatchObject({code:'42501'});
  expect(await owner.sql`select id,wallet from shards_obstacle_obligations`).toEqual([{id:header.id,wallet:player.wallet}]);
 }finally{
  await runtime?.sql.end();
  if(roleCreated){await owner.sql.unsafe(`DROP OWNED BY ${role}`);await owner.sql.unsafe(`DROP ROLE ${role}`);}
  await owner.close();
 }
},120_000);
