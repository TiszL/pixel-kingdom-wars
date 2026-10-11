/** The new INSERT witnesses must not manufacture payment evidence for old rows. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {expect,it,vi} from 'vitest';
import {OBSTACLES} from '@shardkeep/shared';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {builderJobs,obstacles} from '../src/db/schema';
import {admitShardsObstacleObligation,readShardsObstacleObligation} from '../src/mining/shardsTaxObstacleObligations';
import {readShardsObstacleGemsAcceleration} from '../src/mining/shardsTaxObstacleGemsAcceleration';
import {builderJobFinishCostKeep} from '../src/game/base';
import {MINE_DAY_MS} from '../src/game/baseMining';
import {builderJobPaidQuote,builderJobSpeedupLedgerKey} from '../src/game/builderJobSpeedupReceipt';
import {convertKeepToGems} from '../src/game/gems';
import {spendGameCurrency} from '../src/game/spend';
import {ADMIN_DATABASE_URL} from './db-url';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {fundTestKeep} from './helpers';

it('preserves funded SHARDS, captured jobs and old Gems payments across upgrade/repeat without backfilling witnesses',async()=>{
 const root=fileURLToPath(new URL('../drizzle',import.meta.url)),name=`obstacle_gems_upgrade_${randomUUID().replaceAll('-','')}_test`;
 const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),folder=await mkdtemp(path.join(tmpdir(),'phase-e-obstacle-gems-'));
 let conn:ReturnType<typeof createDb>|undefined;
 try{
  const full=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string;when:number}[]};
  const index=full.entries.findIndex(e=>e.tag==='0197_shards_obstacle_gems_accelerations');expect(index).toBeGreaterThan(0);
  const journal={...full,entries:full.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const entry of journal.entries)await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_MINING_ENABLED','GEMS_ENABLED'])vi.stubEnv(flag,'true');
  // Today's Mine writer probes the later policy schema; remove this empty
  // fixture compatibility before measuring the actual historical frontier.
  await conn.sql.unsafe(`CREATE VIEW shards_mine_policy_boundary AS SELECT 1::integer id,NULL::timestamptz effective_at WHERE false`);
  await conn.sql.unsafe('ALTER TABLE shards_mine_eras ADD COLUMN policy_boundary_id integer');
  // NULL keeps today's source writer on the legacy accrual path. Remove this
  // later0232 column before snapshotting the actual historical schema.
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states ADD COLUMN production_remainder bigint');
  const f=await createShardsHistoryFixture(conn.db),collectedAt=new Date(+f.start+Math.ceil(3*MINE_DAY_MS/Number(f.quota)));await f.collect(collectedAt);
  const [obstacle]=await conn.db.insert(obstacles).values({playerWallet:f.player.wallet,baseId:f.base.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
  const [job]=await conn.db.insert(builderJobs).values({playerWallet:f.player.wallet,baseId:f.base.id,kind:'clear_obstacle',obstacleId:obstacle!.id,
   startedAt:collectedAt,finishesAt:new Date(+collectedAt+OBSTACLES.tiers.small.clearSec*1000)}).returning();
  const capture=await admitShardsObstacleObligation(conn.db,f.player.wallet,{idempotencyKey:randomUUID(),baseId:f.base.id,jobId:job!.id},f.context,{clock:()=>collectedAt});
  const at=new Date(+collectedAt+1000),cost=builderJobFinishCostKeep(job!,at),key=randomUUID();
  await fundTestKeep(conn.db,f.player.wallet,cost,'test.obstacle.gems.upgrade',randomUUID());await convertKeepToGems(conn.db,f.player.wallet,cost,randomUUID());
  await spendGameCurrency(conn.db,f.player.wallet,cost,'build.speedup',builderJobSpeedupLedgerKey(f.player.wallet,key),{
   baseId:f.base.id,jobId:job!.id,remSec:Math.ceil((+job!.finishesAt-+at)/1000),builderJobSpeedup:{version:1,
    request:{baseId:f.base.id,jobId:job!.id,idempotencyKey:key,expectedCurrency:'GEMS',consent:builderJobPaidQuote(job!,cost)},
    result:{jobId:job!.id,kind:'clear_obstacle',buildingId:null,obstacleId:obstacle!.id,completedAt:at.toISOString()}},
  },{context:{currency:'GEMS',expectedCurrency:'GEMS'}});
  await conn.sql.unsafe('DROP VIEW shards_mine_policy_boundary');
  await conn.sql.unsafe('ALTER TABLE shards_mine_eras DROP COLUMN policy_boundary_id');
  expect(await conn.sql`select production_remainder from mine_accrual_states`).toEqual([{production_remainder:null}]);
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states DROP COLUMN production_remainder');
  const sql=conn.sql,tables=['players','bases','base_slots','buildings','mine_accrual_states','obstacles','builder_jobs','accounts',
   'ledger_transactions','ledger_entries','deposits','withdrawals','expedition_term_snapshots','shards_tax_assessments','shards_obstacle_obligations'];
  const remainderColumns=()=>sql`select column_name from information_schema.columns where table_schema='public' and table_name='mine_accrual_states' and column_name='production_remainder'`;
  expect(await remainderColumns()).toEqual([]);
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,{
   oid:(await sql`select ${table}::regclass::oid::text oid`)[0]!.oid,
   rows:await sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`),
  }])));
  const before=await snapshot();expect(await sql`select id from ledger_transactions`).not.toHaveLength(0);
  expect(await sql`select wallet from shards_tax_assessments where wallet=${f.player.wallet}`).toHaveLength(1);
  expect(await sql`select to_regclass('public.shards_obstacle_gems_posts') relation`).toEqual([{relation:null}]);
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  const migration=await readFile(path.join(root,'0197_shards_obstacle_gems_accelerations.sql'),'utf8');
  for(let pass=0;pass<2;pass++)for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await sql.unsafe(statement);
  for(const table of ['shards_obstacle_gems_posts','shards_obstacle_gems_entries','shards_obstacle_gems_accelerations'])expect(await sql.unsafe(`select * from ${table}`)).toHaveLength(0);
  expect(await snapshot()).toEqual(before);
  expect(await remainderColumns()).toEqual([]);
  expect(await readShardsObstacleObligation(conn.db,f.player.wallet,capture.idempotencyKey)).toEqual(capture);
  expect(await readShardsObstacleGemsAcceleration(conn.db,f.player.wallet,key)).toBeNull();
 }finally{
  vi.unstubAllEnvs();await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(folder,{recursive:true,force:true});
 }
},120_000);
