/** Original registered-free custody is local evidence, never wallet deedlessness. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {OBSTACLES} from '@shardkeep/shared';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer} from './helpers';
import {bases,baseSlots,builderJobs,obstacles,baseItems} from '../src/db/schema';
import {admitShardsObstacleObligation} from '../src/mining/shardsTaxObstacleObligations';
import {accelerateShardsObstacleWithItem} from '../src/mining/shardsTaxObstacleItemAcceleration';
import {readShardsObstacleFreeCustody} from '../src/mining/shardsTaxObstacleFreeCustody';

const conn=resourceClaimsDatabase(),db=conn.db,start=new Date('2038-01-01T00:00:00.125Z');
beforeAll(()=>conn.setup());afterAll(()=>conn.close());afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(metadata:Pick<typeof bases.$inferInsert,'landPaidAt'|'deedAssetId'|'deedMintAssetId'|'deedMintingAt'>={}){
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const player=await createTestPlayer(db),wallet=player.wallet;
 const [base]=await db.transaction(async tx=>{
  if(metadata.deedMintingAt)await tx.execute(sql`select set_config('shardkeep.fixed_deed_mint_claim','on',true)`);
  return tx.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1,
   landPaidAt:null,deedAssetId:null,deedMintAssetId:null,deedMintingAt:null,...metadata}).returning();
 });
 await db.insert(baseSlots).values({wallet,baseId:base!.id,slot:1});
 const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const finish=new Date(+start+OBSTACLES.tiers.small.clearSec*1000),[job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,finishesAt:finish}).returning();
 const context={baseId:base!.id,assertAuthority:async()=>{}},id=randomUUID();
 const obligation=await admitShardsObstacleObligation(db,wallet,{baseId:base!.id,jobId:job!.id,idempotencyKey:id},context,{clock:()=>new Date(+start+1)});
 return {wallet,base:base!,obstacle:obstacle!,job:job!,finish,context,id,obligation};
}
const state=async()=>({
 bases:await conn.sql`select to_jsonb(b) value from bases b order by id`,
 jobs:await conn.sql`select to_jsonb(j) value from builder_jobs j order by id`,
 obstacles:await conn.sql`select to_jsonb(o) value from obstacles o order by id`,
 headers:await conn.sql`select to_jsonb(h) value from shards_obstacle_obligations h order by id`,
 accounts:await conn.sql`select to_jsonb(a) value from accounts a order by id`,
 ledger:await conn.sql`select to_jsonb(t) value from ledger_transactions t order by id`,
 origins:await conn.sql`select to_jsonb(o) value from shards_obstacle_base_origins o order by obligation_id`,
 changes:await conn.sql`select to_jsonb(c) value from shards_obstacle_base_changes c order by obligation_id`,
 inventory:await conn.sql`select to_jsonb(i) value from base_items i order by id`,
 uses:await conn.sql`select to_jsonb(u) value from item_uses u order by id`,
});
function frozen(value:unknown):void{if(value&&typeof value==='object'){expect(Object.isFrozen(value)).toBe(true);expect(value).not.toBeInstanceOf(Date);for(const child of Object.values(value))frozen(child);}}

describe.sequential('original registered-free obstacle custody',()=>{
 it('proves one original free base through the exact checked horizon while paused without money or completion changes',async()=>{
  const f=await fixture(),checkedAt=new Date(+f.finish+1),before=await state();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const result=await readShardsObstacleFreeCustody(db,f.id,{clock:()=>checkedAt});
  expect(result).toMatchObject({obligation:f.obligation,accelerations:[],earnedAt:f.finish.toISOString(),
   custody:{status:'confirmed',baseId:f.base.id,wallet:f.wallet,startsAt:f.obligation.capturedAt,endsAt:checkedAt.toISOString()},
   source:{kind:'registered_free_base',origin:{obligationId:f.id,originalObligation:{id:f.id},originalBase:{id:f.base.id,
    land_paid_at:null,deed_asset_id:null,deed_mint_asset_id:null,deed_minting_at:null}}},
   sourceVerified:true,walletDeedlessnessAuthorized:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
  expect(result.custody.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.source.origin.originalObligation.gross).toBe(f.obligation.gross);frozen(result);expect(await state()).toEqual(before);
 });
 it('allows the same wallet to own another deed without claiming wallet-wide deedlessness',async()=>{
  const f=await fixture(),asset=Keypair.generate().publicKey.toBase58();
  const [deeded]=await db.insert(bases).values({ownerWallet:f.wallet,status:'active',keepLevel:1,
   landPaidAt:start,deedAssetId:asset,deedMintAssetId:asset}).returning();
  await db.insert(baseSlots).values({wallet:f.wallet,baseId:deeded!.id,slot:2});
  const before=await state(),result=await readShardsObstacleFreeCustody(db,f.id,{clock:()=>new Date(+f.finish+1)});
  expect(result.custody.baseId).toBe(f.base.id);expect(result.sourceVerified).toBe(true);
  expect(result.walletDeedlessnessAuthorized).toBe(false);expect(await state()).toEqual(before);
 });
 it.each(['paid unminted','reserved deed','mint in progress'] as const)('holds an originally %s base despite its null final deed',async kind=>{
  const reservation=Keypair.generate().publicKey.toBase58(),metadata=kind==='paid unminted'?{landPaidAt:start}:
   kind==='reserved deed'?{deedMintAssetId:reservation}:{deedMintAssetId:reservation,deedMintingAt:start};
  const f=await fixture(metadata),before=await state();
  await expect(readShardsObstacleFreeCustody(db,f.id,{clock:()=>new Date(+f.finish+1)})).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('retains a first metadata transition after free→paid→free and cannot restore eligibility from equal endpoints',async()=>{
  const f=await fixture(),checkedAt=new Date(+f.finish+1),saved=await readShardsObstacleFreeCustody(db,f.id,{clock:()=>checkedAt}),serialized=JSON.stringify(saved);
  await conn.sql`update bases set land_paid_at=${new Date(+checkedAt+1000).toISOString()}::timestamptz where id=${f.base.id}`;
  await conn.sql`update bases set land_paid_at=null where id=${f.base.id}`;
  expect(await conn.sql`select land_paid_at,deed_asset_id,deed_mint_asset_id,deed_minting_at from bases where id=${f.base.id}`)
   .toEqual([{land_paid_at:null,deed_asset_id:null,deed_mint_asset_id:null,deed_minting_at:null}]);
  expect(await conn.sql`select obligation_id from shards_obstacle_base_changes where obligation_id=${f.id}`).toHaveLength(1);
  const before=await state();await expect(readShardsObstacleFreeCustody(db,f.id,{clock:()=>new Date(+checkedAt+2000)})).rejects.toThrow();
  expect(await state()).toEqual(before);expect(JSON.stringify(saved)).toBe(serialized);expect(saved.custody.endsAt).toBe(checkedAt.toISOString());
 });
 it.each(['missing','altered'] as const)('holds %s actual INSERT origin evidence without manufacturing a replacement',async damage=>{
  const f=await fixture();
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
   if(damage==='missing')await tx`delete from shards_obstacle_base_origins where obligation_id=${f.id}`;
   else await tx`update shards_obstacle_base_origins set original_base=original_base||' {"land_paid_at":"2038-01-01T00:00:00.000Z"}'::jsonb where obligation_id=${f.id}`;
  });
  const before=await state();await expect(readShardsObstacleFreeCustody(db,f.id,{clock:()=>new Date(+f.finish+1)})).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('uses a real saved item acceleration as the effective earning without consuming or completing again',async()=>{
  const f=await fixture(),at=new Date(+start+1000),checkedAt=new Date(+at+1);
  await db.insert(baseItems).values({baseId:f.base.id,itemId:'keg_of_haste',qty:1,acquiredVia:'grant'});
  const receipt=await accelerateShardsObstacleWithItem(db,f.wallet,{baseId:f.base.id,jobId:f.job.id,itemId:'keg_of_haste',idempotencyKey:randomUUID()},f.context,{clock:()=>at});
  const before=await state();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const result=await readShardsObstacleFreeCustody(db,f.id,{clock:()=>checkedAt});
  expect(result.accelerations).toEqual([receipt]);expect(result.obligation).toEqual(f.obligation);expect(result.earnedAt).toBe(at.toISOString());
  expect(result.custody.endsAt).toBe(checkedAt.toISOString());expect(await state()).toEqual(before);
 });
 it('requires a strictly later checked horizon and holds due or future earning instead of backdating it',async()=>{
  const f=await fixture(),before=await state();
  for(const at of [new Date(f.obligation.capturedAt),new Date(+f.finish-1),f.finish])
   await expect(readShardsObstacleFreeCustody(db,f.id,{clock:()=>at})).rejects.toThrow();
  expect(await state()).toEqual(before);
  expect((await readShardsObstacleFreeCustody(db,f.id,{clock:()=>new Date(+f.finish+1)})).custody.endsAt).toBe(new Date(+f.finish+1).toISOString());
 });
 it('samples the checked horizon only after an actual second-connection base lock wait',async()=>{
  const f=await fixture(),other=conn.reopen(),before=await state();let enter!:(pid:number)=>void,release=()=>{};
  const entered=new Promise<number>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const holding=other.sql.begin(async tx=>{
   await tx`select id from bases where id=${f.base.id} for update`;const [row]=await tx`select pg_backend_pid() pid`;enter(Number(row!.pid));await gate;
  });
  const holder=await entered;let at=f.finish;const clock=vi.fn(()=>at),pending=readShardsObstacleFreeCustody(db,f.id,{clock});
  try{
   let blocked=false;const deadline=Date.now()+10000;
   while(!blocked&&Date.now()<deadline){const [row]=await conn.sql`select exists(select 1 from pg_stat_activity where datname=current_database()
    and ${holder}::integer=any(pg_blocking_pids(pid))) blocked`;blocked=row!.blocked;}
   expect(blocked).toBe(true);expect(clock).not.toHaveBeenCalled();at=new Date(+f.finish+1);release();await holding;
   expect((await pending).custody.endsAt).toBe(at.toISOString());expect(clock).toHaveBeenCalledTimes(1);expect(await state()).toEqual(before);
  }finally{release();await Promise.allSettled([holding,pending]);await other.sql.end();}
 });
 it('holds original SQL precision that a millisecond custody DTO cannot faithfully represent',async()=>{
  const f=await fixture();
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
   await tx`update shards_obstacle_obligations set captured_at=captured_at+interval '100 microseconds' where id=${f.id}`;
  });
  const before=await state();await expect(readShardsObstacleFreeCustody(db,f.id,{clock:()=>new Date(+f.finish+1)})).rejects.toThrow();expect(await state()).toEqual(before);
 });
});
