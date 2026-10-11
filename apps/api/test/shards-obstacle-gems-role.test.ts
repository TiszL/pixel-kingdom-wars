/** Existing login roles retain ordinary ledger access, never obstacle evidence authority. */
import {randomUUID} from 'node:crypto';
import {OBSTACLES} from '@shardkeep/shared';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer,fundTestKeep} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {createDb} from '../src/db/client';
import {bases,baseSlots,builderJobs,obstacles} from '../src/db/schema';
import {convertKeepToGems} from '../src/game/gems';
import {spendGameCurrency} from '../src/game/spend';
import {admitShardsObstacleObligation} from '../src/mining/shardsTaxObstacleObligations';

const owner=resourceClaimsDatabase(),role=`obstacle_gems_${randomUUID().replaceAll('-','')}`,password=randomUUID();
let runtime:ReturnType<typeof createDb>,roleCreated=false;
const evidence=['shards_obstacle_obligations','shards_obstacle_gems_posts','shards_obstacle_gems_entries','shards_obstacle_gems_accelerations'] as const;
beforeAll(async()=>{
 await owner.setup();for(const name of ['GEMS_ENABLED','MULTI_BASE_ENABLED','PHASE_E_MINING_ENABLED'])vi.stubEnv(name,'true');
 const [database]=await owner.sql`select current_database() name`;
 await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
 await owner.sql.unsafe(`GRANT CONNECT ON DATABASE ${database!.name} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}`);
 // Model the existing table-based runtime provisioning without giving this old
 // role any rights to the newly introduced prospective evidence journals.
 const tables=await owner.sql`select tablename from pg_tables where schemaname='public' and tablename not like 'shards_obstacle_%'`;
 for(const {tablename} of tables)await owner.sql.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON public."${tablename}" TO ${role}`);
 await owner.sql.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
 const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
});
afterAll(async()=>{
 vi.unstubAllEnvs();await runtime?.sql.end();
 if(roleCreated){await owner.sql.unsafe(`DROP OWNED BY ${role}`);await owner.sql.unsafe(`DROP ROLE ${role}`);}
 await owner.close();
});
async function fixture(enrolled:boolean){
 const player=await createTestPlayer(owner.db),wallet=player.wallet;
 await fundTestKeep(owner.db,wallet,10n,'test.obstacle.role.fund',randomUUID());await convertKeepToGems(owner.db,wallet,10n,randomUUID());
 const [base]=await owner.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
 await owner.db.insert(baseSlots).values({wallet,baseId:base!.id,slot:1});
 const [obstacle]=await owner.db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const start=new Date('2038-01-01T00:00:00.000Z'),finish=new Date(+start+OBSTACLES.tiers.small.clearSec*1000);
 const [job]=await owner.db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,finishesAt:finish}).returning();
 const obligation=enrolled?await admitShardsObstacleObligation(owner.db,wallet,{baseId:base!.id,jobId:job!.id,idempotencyKey:randomUUID()},
  {baseId:base!.id,assertAuthority:async()=>{}},{clock:()=>start}):null;
 return {wallet,base:base!,job:job!,obstacle:obstacle!,obligation,start,finish};
}
const oldMetadata=(f:Awaited<ReturnType<typeof fixture>>)=>({baseId:f.base.id,jobId:f.job.id,remSec:OBSTACLES.tiers.small.clearSec});
const snapshot=async()=>({accounts:await owner.sql`select to_jsonb(a) value from accounts a order by id`,
 transactions:await owner.sql`select to_jsonb(t) value from ledger_transactions t order by id`,entries:await owner.sql`select to_jsonb(e) value from ledger_entries e order by id`,
 posts:await owner.sql`select to_jsonb(p) value from shards_obstacle_gems_posts p order by ledger_id`,
 witnesses:await owner.sql`select to_jsonb(e) value from shards_obstacle_gems_entries e order by entry_id`,
 events:await owner.sql`select to_jsonb(e) value from shards_obstacle_gems_accelerations e order by obligation_id`});

describe.sequential('0197 restricted LOGIN boundary',()=>{
 it('preserves an ordinary unenrolled Gems debit with old table rights and no evidence SELECT or hook EXECUTE',async()=>{
  expect(await runtime.sql`select current_user as current_role,session_user as login_role`).toEqual([{current_role:role,login_role:role}]);
  for(const table of evidence){
   expect(await runtime.sql`select has_table_privilege(current_user,${'public.'+table},'SELECT') allowed`).toEqual([{allowed:false}]);
   await expect(runtime.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
  }
  expect(await runtime.sql`select has_function_privilege(current_user,'public.shardkeep_shards_obstacle_gems_witness_insert()','EXECUTE') allowed`).toEqual([{allowed:false}]);
  await expect(runtime.sql`select public.shardkeep_shards_obstacle_gems_witness_insert()`).rejects.toMatchObject({code:'42501'});
  const f=await fixture(false),before=await owner.sql`select balance::text from accounts where owner_wallet=${f.wallet} and kind='player_gems'`;
  const posted=await spendGameCurrency(runtime.db,f.wallet,1n,'build.speedup',`speedup:${f.wallet}:${randomUUID()}`,oldMetadata(f),{context:{currency:'GEMS',expectedCurrency:'GEMS'}});
  expect(posted.duplicate).toBe(false);expect(posted.currency).toBe('GEMS');expect(posted.entries).toHaveLength(2);
  expect(await owner.sql`select balance::text from accounts where owner_wallet=${f.wallet} and kind='player_gems'`).toEqual([{balance:(BigInt(before[0]!.balance)-1n).toString()}]);
  expect(await owner.sql`select ledger_id from shards_obstacle_gems_posts where ledger_id=${posted.transaction.id}`).toHaveLength(0);
 });
 it('rejects fabricated posts, entries and events even after accidental INSERT grants',async()=>{
  const f=await fixture(true),before=await snapshot();
  for(const table of evidence.slice(1)){
   await owner.sql.unsafe(`GRANT INSERT ON public.${table} TO ${role}`);
   expect(await runtime.sql`select has_table_privilege(current_user,${'public.'+table},'INSERT') can_insert,
    has_table_privilege(current_user,${'public.'+table},'SELECT') can_read`).toEqual([{can_insert:true,can_read:false}]);
  }
  await expect(runtime.sql`insert into shards_obstacle_gems_posts(ledger_id,obligation_id,tx_key,original_transaction)
   values(${randomUUID()},${f.obligation!.idempotencyKey},pg_current_xact_id()::text,'{}'::jsonb)`)
   .rejects.toMatchObject({code:'42501',message:'SHARDS_OBSTACLE_GEMS_WITNESS_ORIGIN'});
  await expect(runtime.sql`insert into shards_obstacle_gems_entries(entry_id,ledger_id,tx_key,original_entry,account_identity)
   values(1,${randomUUID()},pg_current_xact_id()::text,'{}'::jsonb,'{}'::jsonb)`)
   .rejects.toMatchObject({code:'42501',message:'SHARDS_OBSTACLE_GEMS_WITNESS_ORIGIN'});
  await expect(runtime.sql`insert into shards_obstacle_gems_accelerations(obligation_id,ledger_id,wallet,idempotency_key,before_finish_at,after_finish_at,gems_amount,evidence_sha256)
   values(${f.obligation!.idempotencyKey},${randomUUID()},${f.wallet},${randomUUID()},${f.finish.toISOString()},${f.start.toISOString()},1,${'ab'.repeat(32)})`)
   .rejects.toMatchObject({code:'42501',message:'SHARDS_OBSTACLE_OWNER_REQUIRED'});
  expect(await snapshot()).toEqual(before);
 });
 it('rolls back an enrolled legacy-role charge at commit without an orphan debit or witness',async()=>{
  const f=await fixture(true),before=await snapshot();let postedInside=false;
  await expect(runtime.db.transaction(async tx=>{
   const posted=await spendGameCurrency(tx,f.wallet,1n,'build.speedup',`speedup:${f.wallet}:${randomUUID()}`,oldMetadata(f),{context:{currency:'GEMS',expectedCurrency:'GEMS'}});
   expect(posted.duplicate).toBe(false);expect(posted.entries).toHaveLength(2);postedInside=true;
   // The old caller has no journal capability. Its newly witnessed ledger
   // posting must not survive the outer transaction's deferred commit checks.
  })).rejects.toThrow();
  expect(postedInside).toBe(true);expect(await snapshot()).toEqual(before);
  expect(await owner.sql`select completed_at is null and finishes_at=${f.finish.toISOString()}::timestamptz as original from builder_jobs where id=${f.job.id}`).toEqual([{original:true}]);
 });
});
