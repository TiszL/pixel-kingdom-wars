/** Actual old-rights LOGIN cannot manufacture item acceleration evidence. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {OBSTACLES} from '@shardkeep/shared';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {createDb} from '../src/db/client';
import {baseItems,bases,baseSlots,builderJobs,obstacles,referrals} from '../src/db/schema';
import {admitShardsObstacleObligation} from '../src/mining/shardsTaxObstacleObligations';
import {accelerateShardsObstacleWithItem} from '../src/mining/shardsTaxObstacleItemAcceleration';

const owner=resourceClaimsDatabase(),role=`obstacle_item_${randomUUID().replaceAll('-','')}`,password=randomUUID();
const start=new Date('2038-01-01T00:00:00.000Z'),accepted=new Date(+start+1000),itemId='keg_of_haste';
const evidence=['shards_obstacle_item_accelerations','shards_obstacle_item_uses','shards_obstacle_item_consumptions'] as const;
const hooks=['shardkeep_shards_obstacle_item_use_insert','shardkeep_shards_obstacle_item_inventory_update','shardkeep_shards_obstacle_item_source_guard'] as const;
let runtime:ReturnType<typeof createDb>,roleCreated=false;
beforeAll(async()=>{
 await owner.setup();for(const name of ['MULTI_BASE_ENABLED','PHASE_E_MINING_ENABLED'])vi.stubEnv(name,'true');
 const [database]=await owner.sql`select current_database() name`;
 await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
 await owner.sql.unsafe(`GRANT CONNECT ON DATABASE ${database!.name} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}`);
 // Only the pre-existing item action and activity projection rights. The UUID
 // and text primary keys used here need no sequence permission.
 await owner.sql.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.item_uses,public.base_items TO ${role};
  GRANT SELECT,INSERT ON public.player_action_events TO ${role};
  GRANT SELECT,INSERT,DELETE ON public.player_activity_days TO ${role};
  GRANT SELECT ON public.referrals,public.bases TO ${role}`);
 const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;
 runtime=createDb(url.toString(),{max:1});
});
afterAll(async()=>{
 vi.unstubAllEnvs();await runtime?.sql.end();
 if(roleCreated){await owner.sql.unsafe(`DROP OWNED BY ${role}`);await owner.sql.unsafe(`DROP ROLE ${role}`);}
 await owner.close();
});
async function fixture(enrolled:boolean){
 const player=await createTestPlayer(owner.db),wallet=player.wallet;
 const [base]=await owner.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1,landPaidAt:new Date('2020-01-01T00:00:00.000Z')}).returning();
 await owner.db.insert(baseSlots).values({wallet,baseId:base!.id,slot:1});
 const [obstacle]=await owner.db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const [job]=await owner.db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,
  finishesAt:new Date(+start+OBSTACLES.tiers.small.clearSec*1000)}).returning();
 const [inventory]=await owner.db.insert(baseItems).values({baseId:base!.id,itemId,qty:2,acquiredVia:'grant'}).returning();
 const context={baseId:base!.id,assertAuthority:async()=>{}},command={baseId:base!.id,jobId:job!.id,itemId,idempotencyKey:randomUUID()};
 const obligation=enrolled?await admitShardsObstacleObligation(owner.db,wallet,{baseId:base!.id,jobId:job!.id,idempotencyKey:randomUUID()},context,{clock:()=>start}):null;
 return {wallet,base:base!,job:job!,obstacle:obstacle!,inventory:inventory!,context,command,obligation};
}
const snapshot=async()=>({
 items:await owner.sql`select to_jsonb(i) value from base_items i order by id`,uses:await owner.sql`select to_jsonb(u) value from item_uses u order by id`,
 events:await owner.sql`select to_jsonb(a) value from shards_obstacle_item_accelerations a order by use_id`,
 witnesses:await owner.sql`select to_jsonb(u) value from shards_obstacle_item_uses u order by use_id`,
 consumptions:await owner.sql`select to_jsonb(c) value from shards_obstacle_item_consumptions c order by use_id`,
 jobs:await owner.sql`select to_jsonb(j) value from builder_jobs j order by id`,
 actions:await owner.sql`select to_jsonb(a) value from player_action_events a order by id`,activity:await owner.sql`select to_jsonb(d) value from player_activity_days d order by wallet,day`,
});
function pgError(error:unknown):unknown{let e=error;while(e&&typeof e==='object'&&'cause' in e&&e.cause)e=e.cause;return e;}

describe.sequential('0198 restricted LOGIN boundary',()=>{
 it('keeps ordinary item use, inventory changes and item/activity/referral effects working without evidence rights',async()=>{
  expect(await runtime.sql`select current_user current_role,session_user login_role`).toEqual([{current_role:role,login_role:role}]);
  expect(await runtime.sql`select rolsuper,rolcreaterole,rolcreatedb,rolbypassrls from pg_roles where rolname=current_user`)
   .toEqual([{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false}]);
  expect(await runtime.sql`select has_schema_privilege(current_user,'public','CREATE') allowed`).toEqual([{allowed:false}]);
  for(const table of evidence){
   expect(await runtime.sql`select has_table_privilege(current_user,${'public.'+table},'SELECT') allowed`).toEqual([{allowed:false}]);
   await expect(runtime.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
  }
  for(const hook of hooks){
   expect(await runtime.sql`select has_function_privilege(current_user,${'public.'+hook+'()'},'EXECUTE') allowed`).toEqual([{allowed:false}]);
   await expect(runtime.sql.unsafe(`select public.${hook}()`)).rejects.toMatchObject({code:'42501'});
  }
  const f=await fixture(false),referrer=await createTestPlayer(owner.db),useId=randomUUID();
  await owner.db.insert(referrals).values({referrerWallet:referrer.wallet,refereeWallet:f.wallet,qualifiedAt:new Date('2020-01-01T00:00:00.000Z')});
  await runtime.sql`insert into item_uses(id,player_wallet,item_id,idempotency_key,used_at)
   values(${useId},${f.wallet},${itemId},${`use:${f.wallet}:${f.base.id}:${randomUUID()}`},${accepted.toISOString()})`;
  await runtime.sql`update base_items set qty=qty-1 where id=${f.inventory.id}`;
  await runtime.sql`update base_items set seen_at=${accepted.toISOString()} where id=${f.inventory.id}`;
  expect(await runtime.sql`select qty,seen_at=${accepted.toISOString()}::timestamptz seen from base_items where id=${f.inventory.id}`).toEqual([{qty:1,seen:true}]);
  const actions=await owner.sql`select id from player_action_events where source_table='item_uses' and source_id=${useId} and source_key='item_used'`;
  expect(actions).toHaveLength(1);
  expect(await owner.sql`select wallet from player_activity_days where wallet=${f.wallet}`).toHaveLength(1);
  expect(await owner.sql`select wallet from player_action_events where source_table='player_action_events' and source_id=${actions[0]!.id} and source_key='referral_active'`)
   .toEqual([{wallet:referrer.wallet}]);
  expect(await owner.sql`select use_id from shards_obstacle_item_accelerations where use_id=${useId}`).toHaveLength(0);
 });
 it('cannot fabricate any journal even after accidental INSERT grants and with real accepted parent/source rows',async()=>{
  const f=await fixture(true),receipt=await accelerateShardsObstacleWithItem(owner.db,f.wallet,f.command,f.context,{clock:()=>accepted});
  const before=await snapshot();
  for(const table of evidence){
   const [row]=await owner.sql.unsafe(`select to_jsonb(t) value from public.${table} t where use_id=$1`,[receipt.key]);
   expect(row).toBeDefined();await owner.sql.unsafe(`GRANT INSERT ON public.${table} TO ${role}`);
   expect(await runtime.sql`select has_table_privilege(current_user,${'public.'+table},'INSERT') can_insert,
    has_table_privilege(current_user,${'public.'+table},'SELECT') can_read`).toEqual([{can_insert:true,can_read:false}]);
   await expect(runtime.sql.unsafe(`insert into public.${table} select * from jsonb_populate_record(null::public.${table},$1::jsonb)`,[JSON.stringify(row!.value)]))
    .rejects.toMatchObject({code:'42501',message:table==='shards_obstacle_item_accelerations'?'SHARDS_OBSTACLE_OWNER_REQUIRED':'SHARDS_OBSTACLE_ITEM_WITNESS_ORIGIN'});
  }
  expect(await snapshot()).toEqual(before);
 });
 it.each(['restore quantity','change seen time','delete inventory','edit use','delete use'] as const)
 ('retains the same-transaction %s fence after the owner accepts and changes to restricted current_user',async action=>{
  const f=await fixture(true),before=await snapshot();let restricted=false;
  // The login cannot create an owner-only acceptance. Switch only current_user
  // after a real owner acceptance to test its already-installed source guards.
  const error=await owner.db.transaction(async tx=>{
   const receipt=await accelerateShardsObstacleWithItem(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   await tx.execute(sql`set constraints all immediate`);
   await tx.execute(sql.raw(`set local role ${role}`));
   const [identity]=await tx.execute(sql`select current_user current_role,session_user login_role,
    has_table_privilege(current_user,'public.shards_obstacle_item_accelerations','SELECT') can_read`);
   expect(identity).toMatchObject({current_role:role,can_read:false});expect(identity!.login_role).not.toBe(role);restricted=true;
   if(action==='restore quantity')await tx.execute(sql`update base_items set qty=qty+1 where id=${f.inventory.id}::uuid`);
   if(action==='change seen time')await tx.execute(sql`update base_items set seen_at=${accepted.toISOString()}::timestamptz where id=${f.inventory.id}::uuid`);
   if(action==='delete inventory')await tx.execute(sql`delete from base_items where id=${f.inventory.id}::uuid`);
   if(action==='edit use')await tx.execute(sql`update item_uses set used_at=used_at where id=${receipt.key}::uuid`);
   if(action==='delete use')await tx.execute(sql`delete from item_uses where id=${receipt.key}::uuid`);
  }).then(()=>null,pgError);
  expect(restricted).toBe(true);expect(error).toMatchObject({code:'P0001',message:'SHARDS_OBSTACLE_ITEM_SOURCE_HELD'});
  expect(await snapshot()).toEqual(before);
 });
});
