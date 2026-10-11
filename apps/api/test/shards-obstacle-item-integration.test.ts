/** New item evidence preserves prior money/history and existing ingot guards. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {expect,it,vi} from 'vitest';
import {OBSTACLES,FORGE_INGOT,ITEMS} from '@shardkeep/shared';
import {sql} from 'drizzle-orm';
import {createDb,type Db} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bases,baseSlots,baseItems,itemUses,builderJobs,obstacles,buildings} from '../src/db/schema';
import {admitShardsObstacleObligation,assertShardsObstacleTermPrefix} from '../src/mining/shardsTaxObstacleObligations';
import {prepareShardsObstacleGemsAcceleration,readShardsObstacleGemsAcceleration} from '../src/mining/shardsTaxObstacleGemsAcceleration';
import {accelerateShardsObstacleWithItem,readShardsObstacleItemAcceleration} from '../src/mining/shardsTaxObstacleItemAcceleration';
import {builderJobFinishCostKeep} from '../src/game/base';
import {builderJobPaidQuote,builderJobSpeedupLedgerKey} from '../src/game/builderJobSpeedupReceipt';
import {convertKeepToGems} from '../src/game/gems';
import {spendGameCurrency} from '../src/game/spend';
import {rewardBaseShards} from '../src/game/baseEconomy';
import {startRefine,collectRefine} from '../src/game/workshop';
import {reservePendingMiningIngots} from '../src/game/miningIngotReservations';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer,fundTestKeep} from './helpers';

const start=new Date('2038-01-01T00:00:00.000Z'),at=new Date(+start+1000);
function flags(){for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_MINING_ENABLED','GEMS_ENABLED','PHASE_E_BUILDINGS_ENABLED','FORGE_INGOTS_ENABLED'])vi.stubEnv(flag,'true');}
async function obstacleFixture(db:Db){
 const player=await createTestPlayer(db),wallet=player.wallet;
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
 await db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});
 const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,
  startedAt:start,finishesAt:new Date(+start+OBSTACLES.tiers.small.clearSec*1000)}).returning();
 const context={baseId:base!.id,assertAuthority:async()=>{}},command={baseId:base!.id,jobId:job!.id,idempotencyKey:randomUUID()};
  const obligation=await admitShardsObstacleObligation(db,wallet,{...command,idempotencyKey:randomUUID()},context,{clock:()=>start});
 await db.insert(baseItems).values({baseId:base!.id,itemId:'keg_of_haste',qty:3,acquiredVia:'grant'});
 return {wallet,base:base!,job:job!,obstacle:obstacle!,context,command,obligation};
}

it('upgrades and repeats without inventing old item evidence or invalidating accepted Gems history',async()=>{
 const root=fileURLToPath(new URL('../drizzle',import.meta.url)),name=`obstacle_item_upgrade_${randomUUID().replaceAll('-','')}_test`;
 const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),folder=await mkdtemp(path.join(tmpdir(),'phase-e-obstacle-item-'));
 let conn:ReturnType<typeof createDb>|undefined;
 try{
  const full=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string;when:number}[]};
  const index=full.entries.findIndex(e=>e.tag==='0198_shards_obstacle_item_accelerations');expect(index).toBeGreaterThan(0);
  const journal={...full,entries:full.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const entry of journal.entries)await copyFile(path.join(root,entry.tag+'.sql'),path.join(folder,entry.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});flags();
  const f=await obstacleFixture(conn.db),cost=builderJobFinishCostKeep(f.job,at);
  await fundTestKeep(conn.db,f.wallet,cost,'test.item.upgrade.fund',randomUUID());await convertKeepToGems(conn.db,f.wallet,cost,randomUUID());
  const receipt=await conn.db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>at});
   if(prepared.status!=='prepared')throw Error('unexpected replay');
   await spendGameCurrency(tx,f.wallet,cost,'build.speedup',builderJobSpeedupLedgerKey(f.wallet,f.command.idempotencyKey),{
    baseId:f.base.id,jobId:f.job.id,remSec:Math.ceil((+f.job.finishesAt-+at)/1000),builderJobSpeedup:{version:1,
     request:{...f.command,expectedCurrency:'GEMS',consent:builderJobPaidQuote(f.job,cost)},
     result:{jobId:f.job.id,kind:'clear_obstacle',buildingId:null,obstacleId:f.obstacle.id,completedAt:at.toISOString()}},
   },{context:{currency:'GEMS',expectedCurrency:'GEMS'}});
   return prepared.apply();
  });
  const oldKey=randomUUID();await conn.db.insert(itemUses).values({playerWallet:f.wallet,itemId:'keg_of_haste',idempotencyKey:`use:${f.wallet}:${f.base.id}:${oldKey}`,usedAt:at});
  await conn.sql`update base_items set qty=qty-1 where base_id=${f.base.id} and item_id='keg_of_haste'`;
  const sql=conn.sql,tables=['players','bases','base_slots','base_items','item_uses','player_action_events','player_activity_days','builder_jobs','obstacles',
   'accounts','ledger_transactions','ledger_entries','deposits','withdrawals','shards_obstacle_obligations','shards_obstacle_gems_accelerations','shards_obstacle_gems_posts','shards_obstacle_gems_entries'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,{
   oid:(await sql`select ${table}::regclass::oid::text oid`)[0]!.oid,rows:await sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`),
  }])));
  const before=await snapshot();
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  const migration=await readFile(path.join(root,'0198_shards_obstacle_item_accelerations.sql'),'utf8');
  for(let pass=0;pass<2;pass++)for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await sql.unsafe(statement);
  for(const table of ['shards_obstacle_item_accelerations','shards_obstacle_item_uses','shards_obstacle_item_consumptions'])expect(await sql.unsafe(`select * from ${table}`)).toHaveLength(0);
  expect(await snapshot()).toEqual(before);
  expect(await readShardsObstacleGemsAcceleration(conn.db,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
  expect(await readShardsObstacleItemAcceleration(conn.db,f.wallet,oldKey)).toBeNull();
 }finally{
  vi.unstubAllEnvs();await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(folder,{recursive:true,force:true});
 }
},120_000);

it.each(['decrement','timer'] as const)('rejects a raw new use missing its %s and rolls every effect back',async missing=>{
 const conn=resourceClaimsDatabase();
 try{
  await conn.setup();flags();const f=await obstacleFixture(conn.db),useId=randomUUID();
  const snapshot=async()=>Object.fromEntries(await Promise.all(['base_items','item_uses','player_action_events','player_activity_days','builder_jobs',
   'shards_obstacle_item_accelerations','shards_obstacle_item_uses','shards_obstacle_item_consumptions'].map(async table=>[table,
    await conn.sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`)])));
  const before=await snapshot();let reached=false;
  await expect(conn.sql.begin(async tx=>{
   const [inventory]=await tx`select id from base_items where base_id=${f.base.id} and item_id='keg_of_haste'`;
   await tx`insert into shards_obstacle_item_accelerations(use_id,obligation_id,wallet,item_id,idempotency_key,inventory_id,
    before_finish_at,after_finish_at,quantity_before,quantity_after,max_remaining_sec,tx_key,evidence_sha256)
    values(${useId},${f.obligation.idempotencyKey},${f.wallet},'keg_of_haste',${f.command.idempotencyKey},${inventory!.id},
    ${f.job.finishesAt.toISOString()},${at.toISOString()},3,2,${ITEMS.keg_of_haste.effect.maxRemainingSec},pg_current_xact_id()::text,${'ab'.repeat(32)})`;
   await tx`insert into item_uses(id,player_wallet,item_id,idempotency_key,used_at)
    values(${useId},${f.wallet},'keg_of_haste',${`use:${f.wallet}:${f.base.id}:${f.command.idempotencyKey}`},${at.toISOString()})`;
   if(missing==='timer')await tx`update base_items set qty=qty-1 where id=${inventory!.id}`;
   expect(await tx`select use_id from shards_obstacle_item_uses where use_id=${useId}`).toHaveLength(1);
   expect(await tx`select use_id from shards_obstacle_item_consumptions where use_id=${useId}`).toHaveLength(missing==='timer'?1:0);
   reached=true;
   if(missing==='decrement')await tx`update builder_jobs set finishes_at=${at.toISOString()} where id=${f.job.id}`;
  })).rejects.toThrow(missing==='decrement'?'SHARDS_OBSTACLE_TRANSITION_HELD':'SHARDS_OBSTACLE_ITEM_EVIDENCE');
  expect(reached).toBe(true);expect(await snapshot()).toEqual(before);
 }finally{vi.unstubAllEnvs();await conn.close();}
},120_000);

it('accepts and replays witnesses across different non-UTC sessions without binding current inventory',async()=>{
 const conn=resourceClaimsDatabase();
 try{
  await conn.setup();flags();const f=await obstacleFixture(conn.db);
  const receipt=await conn.db.transaction(async tx=>{
   await tx.execute(sql`set local time zone 'Asia/Tbilisi'`);
   return accelerateShardsObstacleWithItem(tx,f.wallet,{...f.command,itemId:'keg_of_haste'},f.context,{clock:()=>at});
  });
  await conn.db.transaction(async tx=>{
   await tx.execute(sql`set local time zone 'America/New_York'`);
   expect(await readShardsObstacleItemAcceleration(tx,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
   await assertShardsObstacleTermPrefix(tx,f.wallet,at.toISOString());
   await expect(assertShardsObstacleTermPrefix(tx,f.wallet,new Date(+at+1).toISOString())).rejects.toThrow();
  });
  await conn.sql`update base_items set qty=qty+1,seen_at=now() where base_id=${f.base.id} and item_id='keg_of_haste'`;
  expect(await readShardsObstacleItemAcceleration(conn.db,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
 }finally{vi.unstubAllEnvs();await conn.close();}
},120_000);

it('consumes a finish item on a base with real admitted ingots while preserving their guarded reservation and money',async()=>{
 const conn=resourceClaimsDatabase();
 try{
  await conn.setup();flags();const f=await obstacleFixture(conn.db);
  await conn.db.insert(buildings).values({playerWallet:f.wallet,baseId:f.base.id,type:'workshop',level:1,tx:20,ty:20});
  await rewardBaseShards(conn.db,f.base.id,BigInt(FORGE_INGOT.shardsPerIngot)*3n,'test.item.ingot.fund',randomUUID());
  const refined=await startRefine(conn.db,f.wallet,f.base.id,1,FORGE_INGOT.recipeVersion,randomUUID(),start,f.context),ready=new Date(refined.readyAt);
  await collectRefine(conn.db,f.wallet,f.base.id,refined.jobId,randomUUID(),ready,f.context);
  const reservation=await reservePendingMiningIngots(conn.db,f.wallet,{epochKey:randomUUID(),baseId:f.base.id,ingots:1,idempotencyKey:randomUUID()},f.context,ready);
  expect(await conn.sql`select base_id from mining_ingot_admissions where base_id=${f.base.id}`).toHaveLength(1);
  const inventory=await conn.sql`select to_jsonb(i) value from base_items i where base_id=${f.base.id} and item_id='forge_ingot'`;
  const balances=await conn.sql`select id,balance::text from accounts order by id`;
  const receipt=await accelerateShardsObstacleWithItem(conn.db,f.wallet,{...f.command,itemId:'keg_of_haste'},f.context,{clock:()=>at});
  expect(receipt.consumed).toBe(1);
  expect(await conn.sql`select to_jsonb(i) value from base_items i where base_id=${f.base.id} and item_id='forge_ingot'`).toEqual(inventory);
  expect(await conn.sql`select id,balance::text from accounts order by id`).toEqual(balances);
  expect(await conn.sql`select id from mining_ingot_reservations where id=${reservation.id}`).toHaveLength(1);
  await expect(conn.sql`update base_items set qty=qty+1 where base_id=${f.base.id} and item_id='forge_ingot'`).rejects.toThrow();
 }finally{vi.unstubAllEnvs();await conn.close();}
},120_000);
