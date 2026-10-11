import {seedHistoricalTaxedCache} from './fixtures/historicalTaxedCache';
/** Unmounted item acceleration owns its real receipt, inventory debit and timer. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {ITEMS,OBSTACLES,speedupCostKeep} from '@shardkeep/shared';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer,fundTestKeep} from './helpers';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {baseItems,bases,baseSlots,builderJobs,obstacles,itemUses,referrals} from '../src/db/schema';
import {admitShardsObstacleObligation,readShardsObstacleObligation} from '../src/mining/shardsTaxObstacleObligations';
import {convertKeepToGems} from '../src/game/gems';
import {spendGameCurrency} from '../src/game/spend';
import {builderJobPaidQuote,builderJobSpeedupLedgerKey} from '../src/game/builderJobSpeedupReceipt';
import {prepareShardsObstacleGemsAcceleration} from '../src/mining/shardsTaxObstacleGemsAcceleration';
import {accelerateShardsObstacleWithItem,readShardsObstacleItemAcceleration} from '../src/mining/shardsTaxObstacleItemAcceleration';

const conn=resourceClaimsDatabase(),db=conn.db,start=new Date('2038-01-01T00:00:00.000Z'),accepted=new Date(+start+1000);
const itemId='keg_of_haste' as const;
beforeAll(()=>conn.setup());afterAll(()=>conn.close());afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(options:{finish?:Date;qty?:number}={}){
 for(const name of ['MULTI_BASE_ENABLED','PHASE_E_MINING_ENABLED','GEMS_ENABLED'])vi.stubEnv(name,'true');
 const player=await createTestPlayer(db),wallet=player.wallet;
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
 await db.insert(baseSlots).values({wallet,baseId:base!.id,slot:1});
 const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,
  finishesAt:options.finish??new Date(+start+OBSTACLES.tiers.small.clearSec*1000)}).returning();
 const [inventory]=await db.insert(baseItems).values({baseId:base!.id,itemId,qty:options.qty??2,acquiredVia:'grant'}).returning();
 const context={baseId:base!.id,assertAuthority:async()=>{}},command={baseId:base!.id,jobId:job!.id,itemId:String(itemId),idempotencyKey:String(randomUUID())};
 const obligation=await admitShardsObstacleObligation(db,wallet,{baseId:base!.id,jobId:job!.id,idempotencyKey:randomUUID()},context,{clock:()=>start});
 return {wallet,base:base!,job:job!,obstacle:obstacle!,inventory:inventory!,context,command,obligation};
}
const snapshot=async()=>({
 inventory:await conn.sql`select to_jsonb(i) value from base_items i order by id`,
 uses:await conn.sql`select to_jsonb(u) value from item_uses u order by id`,
 jobs:await conn.sql`select to_jsonb(j) value from builder_jobs j order by id`,
 obstacles:await conn.sql`select to_jsonb(o) value from obstacles o order by id`,
 accounts:await conn.sql`select to_jsonb(a) value from accounts a order by id`,
 ledger:await conn.sql`select to_jsonb(t) value from ledger_transactions t order by id`,
 actions:await conn.sql`select to_jsonb(a) value from player_action_events a order by id`,
 activity:await conn.sql`select to_jsonb(d) value from player_activity_days d order by wallet,day`,
});

describe.sequential('original obstacle item acceleration',()=>{
 it('consumes one actual item, records its use and shortens only the timer without changing original capture or posting SHARDS',async()=>{
  const f=await fixture(),before=await snapshot();vi.stubEnv('GEMS_ENABLED','false');
  const receipt=await accelerateShardsObstacleWithItem(db,f.wallet,f.command,f.context,{clock:()=>accepted});
  expect(receipt).toMatchObject({idempotencyKey:f.command.idempotencyKey,obligationId:f.obligation.idempotencyKey,jobId:f.job.id,baseId:f.base.id,
   obstacleId:f.obstacle.id,wallet:f.wallet,kind:'item',acceptedAt:accepted.toISOString(),beforeFinishAt:f.job.finishesAt.toISOString(),afterFinishAt:accepted.toISOString(),
   itemId,quantityBefore:2,quantityAfter:1,consumed:1,maxRemainingSec:ITEMS[itemId].effect.maxRemainingSec,earningWalletConfirmed:false,postingAuthorized:false});
  expect(Object.isFrozen(receipt)).toBe(true);expect(receipt.key).toMatch(/^[0-9a-f-]{36}$/);expect(receipt.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
  expect(await readShardsObstacleObligation(db,f.wallet,f.obligation.idempotencyKey)).toEqual(f.obligation);
  expect((await db.select().from(baseItems).where(eq(baseItems.id,f.inventory.id)))[0]).toEqual({...f.inventory,qty:1});
  expect((await db.select().from(builderJobs).where(eq(builderJobs.id,f.job.id)))[0]).toEqual({...f.job,finishesAt:accepted});
  expect(await conn.sql`select player_wallet,item_id,idempotency_key,used_at=${accepted.toISOString()}::timestamptz at_acceptance from item_uses where id=${receipt.key}`)
   .toEqual([{player_wallet:f.wallet,item_id:itemId,idempotency_key:`use:${f.wallet}:${f.base.id}:${f.command.idempotencyKey}`,at_acceptance:true}]);
  expect(await conn.sql`select source_key,source_id from player_action_events where source_table='item_uses' and source_id=${receipt.key}`)
   .toEqual([{source_key:'item_used',source_id:receipt.key}]);
  const after=await snapshot();expect(after.accounts).toEqual(before.accounts);expect(after.ledger).toEqual(before.ledger);expect(after.obstacles).toEqual(before.obstacles);
 });
 it('rolls back actual use, exact decrement, timer, action history and activity projection when the outer transaction fails',async()=>{
  const f=await fixture(),referrer=await createTestPlayer(db);
  await db.update(bases).set({landPaidAt:new Date('2020-01-01T00:00:00.000Z')}).where(eq(bases.id,f.base.id));
  await db.insert(referrals).values({referrerWallet:referrer.wallet,refereeWallet:f.wallet,qualifiedAt:new Date('2020-01-01T00:00:00.000Z')});
  const before=await snapshot();let applied=false;
  await expect(db.transaction(async tx=>{
   const receipt=await accelerateShardsObstacleWithItem(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   expect((await tx.select().from(baseItems).where(eq(baseItems.id,f.inventory.id)))[0]!.qty).toBe(1);
   expect(await tx.execute(sql`select source_id from player_action_events where source_table='item_uses' and source_id=${receipt.key}`)).toHaveLength(1);
   expect(await tx.execute(sql`select id from player_action_events where wallet=${referrer.wallet} and metadata->>'refereeWallet'=${f.wallet}`)).toHaveLength(1);
   applied=true;throw Error('fixture after real item and action writes');
  })).rejects.toThrow('fixture after real item and action writes');
  expect(applied).toBe(true);expect(await snapshot()).toEqual(before);
  expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
 });
 it('recovers concurrent and lost responses after pause, catalog changes and reconnect without consuming twice',async()=>{
  const f=await fixture(),results=await Promise.all([1,2].map(()=>accelerateShardsObstacleWithItem(db,f.wallet,f.command,f.context,{clock:()=>accepted})));
  expect(results[1]).toEqual(results[0]);expect((await db.select().from(baseItems).where(eq(baseItems.id,f.inventory.id)))[0]!.qty).toBe(1);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const originalEffect=ITEMS[itemId].effect,reopened=conn.reopen();
  Reflect.set(ITEMS[itemId],'effect',undefined);
  try{
   expect(await accelerateShardsObstacleWithItem(reopened.db,f.wallet,f.command,{...f.context,assertAuthority:async()=>{throw Error('saved reply must not reauthorize');}},{clock:()=>f.job.finishesAt})).toEqual(results[0]);
  }finally{Reflect.set(ITEMS[itemId],'effect',originalEffect);await reopened.sql.end();}
  const other=await createTestPlayer(db);expect(await readShardsObstacleItemAcceleration(db,other.wallet,f.command.idempotencyKey)).toBeNull();
  expect(await conn.sql`select id from item_uses where idempotency_key=${`use:${f.wallet}:${f.base.id}:${f.command.idempotencyKey}`}`).toHaveLength(1);
 });
 it('uses the catalog bound inclusively and refuses one millisecond beyond it without consumption',async()=>{
  const bound=ITEMS[itemId].effect.maxRemainingSec;
  const exact=await fixture({finish:new Date(+accepted+bound*1000)});
  expect(await accelerateShardsObstacleWithItem(db,exact.wallet,exact.command,exact.context,{clock:()=>accepted})).toMatchObject({maxRemainingSec:bound});
  const beyond=await fixture({finish:new Date(+accepted+bound*1000+1)}),before=await snapshot();
  await expect(accelerateShardsObstacleWithItem(db,beyond.wallet,beyond.command,beyond.context,{clock:()=>accepted})).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });
 it.each(['due','empty','unsupported item'] as const)('holds %s instead of burning a unit',async bad=>{
  const f=await fixture({qty:bad==='empty'?0:2});
  if(bad==='unsupported item')await db.insert(baseItems).values({baseId:f.base.id,itemId:'powder_charge',qty:1,acquiredVia:'grant'});
  const before=await snapshot(),command=bad==='unsupported item'?{...f.command,itemId:'powder_charge'}:f.command;
  const result=accelerateShardsObstacleWithItem(db,f.wallet,command,f.context,{clock:()=>bad==='due'?f.job.finishesAt:accepted});
  if(bad==='unsupported item')await expect(result).rejects.toThrow('finish item required');else await expect(result).rejects.toThrow();
  expect(await snapshot()).toEqual(before);expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
 });
 it('refuses unsupported cancellation of an enrolled obstacle without consuming inventory',async()=>{
  const f=await fixture(),before=await snapshot();
  // clear_obstacle has no valid canceled state today: the enrolled transition
  // fence must reject cancellation, rather than fabricate a state barred by the
  // existing paid-upgrade cancellation constraint.
  await expect(conn.sql`update builder_jobs set cancelled_at=${accepted.toISOString()} where id=${f.job.id}`)
   .rejects.toThrow('SHARDS_OBSTACLE_TRANSITION_HELD');
  expect(await snapshot()).toEqual(before);expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
 });
 it('does not adopt an old committed use or no-op tuple laundering as fresh consumption',async()=>{
  const f=await fixture(),[use]=await db.insert(itemUses).values({playerWallet:f.wallet,itemId,
   idempotencyKey:`use:${f.wallet}:${f.base.id}:${f.command.idempotencyKey}`,usedAt:accepted}).returning();
  const before=await snapshot();let touched=false;
  await expect(db.transaction(async tx=>{
   await tx.execute(sql`update item_uses set used_at=used_at where id=${use!.id}::uuid`);
   await tx.execute(sql`update base_items set qty=qty where id=${f.inventory.id}::uuid`);touched=true;
   await accelerateShardsObstacleWithItem(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
  })).rejects.toThrow();expect(touched).toBe(true);expect(await snapshot()).toEqual(before);
  expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
 });
 it('preserves historical quantity and provenance snapshots while later legitimate inventory fields change',async()=>{
  const f=await fixture(),receipt=await accelerateShardsObstacleWithItem(db,f.wallet,f.command,f.context,{clock:()=>accepted});
  await db.update(baseItems).set({qty:7,seenAt:new Date(+accepted+1),acquiredAt:new Date(+accepted+2),acquiredVia:'shop_gems'}).where(eq(baseItems.id,f.inventory.id));
  expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
  expect(await accelerateShardsObstacleWithItem(db,f.wallet,f.command,f.context,{clock:()=>f.job.finishesAt})).toEqual(receipt);
  expect((await db.select().from(baseItems).where(eq(baseItems.id,f.inventory.id)))[0]!.qty).toBe(7);
 });
 it('serializes two distinct obstacle uses of the same stack and retains each exact decrement',async()=>{
  const f=await fixture(),[secondObstacle]=await db.insert(obstacles).values({playerWallet:f.wallet,baseId:f.base.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:2,ty:0}).returning();
  const [secondJob]=await db.insert(builderJobs).values({playerWallet:f.wallet,baseId:f.base.id,kind:'clear_obstacle',obstacleId:secondObstacle!.id,startedAt:start,finishesAt:f.job.finishesAt}).returning();
  await admitShardsObstacleObligation(db,f.wallet,{baseId:f.base.id,jobId:secondJob!.id,idempotencyKey:randomUUID()},f.context,{clock:()=>start});
  const commands=[f.command,{...f.command,jobId:secondJob!.id,idempotencyKey:randomUUID()}];
  const results=await Promise.all(commands.map(command=>accelerateShardsObstacleWithItem(db,f.wallet,command,f.context,{clock:()=>accepted})));
  expect(results.map(r=>[r.quantityBefore,r.quantityAfter]).sort((a,b)=>a[0]!-b[0]!)).toEqual([[1,0],[2,1]]);
  expect(new Set(results.map(r=>r.key)).size).toBe(2);expect((await db.select().from(baseItems).where(eq(baseItems.id,f.inventory.id)))[0]!.qty).toBe(0);
  for(let i=0;i<commands.length;i++)expect(await readShardsObstacleItemAcceleration(db,f.wallet,commands[i]!.idempotencyKey)).toEqual(results[i]);
 });
 it.each(['item first','Gems first'] as const)('permits only one acceleration source for an obligation: %s',async first=>{
  const f=await fixture(),cost=BigInt(speedupCostKeep(Math.ceil((+f.job.finishesAt-+accepted)/1000)));
  await fundTestKeep(db,f.wallet,cost,'test.item.gems.exclusion',randomUUID());await convertKeepToGems(db,f.wallet,cost,randomUUID());
  const gemsCommand={baseId:f.base.id,jobId:f.job.id,idempotencyKey:randomUUID()};
  const gems=()=>db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,gemsCommand,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected Gems replay');
   const request={...gemsCommand,expectedCurrency:'GEMS' as const,consent:builderJobPaidQuote(f.job,cost)!};
   await spendGameCurrency(tx,f.wallet,cost,'build.speedup',builderJobSpeedupLedgerKey(f.wallet,gemsCommand.idempotencyKey),{
    baseId:f.base.id,jobId:f.job.id,remSec:Math.ceil((+f.job.finishesAt-+accepted)/1000),builderJobSpeedup:{version:1,request,
     result:{jobId:f.job.id,kind:'clear_obstacle',buildingId:null,obstacleId:f.obstacle.id,completedAt:accepted.toISOString()}},
   },{context:{currency:'GEMS',expectedCurrency:'GEMS'}});return prepared.apply();
  });
  const item=()=>accelerateShardsObstacleWithItem(db,f.wallet,f.command,f.context,{clock:()=>accepted});
  await (first==='item first'?item():gems());const before=await snapshot();
  await expect(first==='item first'?gems():item()).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });

 it.each(['pause','authority lost'] as const)('rolls back a real item-use/decrement/action when %s occurs in final authority',async failure=>{
  const f=await fixture(),before=await snapshot();let observed=false;
  await expect(accelerateShardsObstacleWithItem(db,f.wallet,f.command,{...f.context,assertAuthority:async tx=>{
   const [inventory]=await tx.select().from(baseItems).where(eq(baseItems.id,f.inventory.id));
   if(inventory!.qty===f.inventory.qty-1){
    expect(await tx.execute(sql`select id from item_uses where idempotency_key=${`use:${f.wallet}:${f.base.id}:${f.command.idempotencyKey}`}`)).toHaveLength(1);
    expect(await tx.execute(sql`select id from player_action_events where wallet=${f.wallet} and source_table='item_uses'`)).toHaveLength(1);
    observed=true;if(failure==='pause')vi.stubEnv('PHASE_E_MINING_ENABLED','false');else throw Error('fixture authority lost after actual consumption');
   }
  }},{clock:()=>accepted})).rejects.toThrow();
  expect(observed).toBe(true);expect(await snapshot()).toEqual(before);expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
 });
 it('accepts existing builder key grammar and rejects changed identity under the original saved key',async()=>{
  const f=await fixture();f.command.idempotencyKey='item-speedup-'+randomUUID();
  const receipt=await accelerateShardsObstacleWithItem(db,f.wallet,f.command,f.context,{clock:()=>accepted});
  expect(receipt.idempotencyKey).toBe(f.command.idempotencyKey);
  for(const change of [{jobId:randomUUID()},{baseId:randomUUID()},{itemId:'finishers_seal'}])
   await expect(accelerateShardsObstacleWithItem(db,f.wallet,{...f.command,...change},f.context,{clock:()=>accepted})).rejects.toMatchObject({statusCode:409});
 });

 it.each(['restore quantity','change seen time','delete and reinsert','truncate'] as const)(
  'refuses inventory %s after deferred checks were explicitly flushed in the same transaction',async change=>{
   const f=await fixture(),before=await snapshot();let applied=false,flushed=false;
   await expect(db.transaction(async tx=>{
    const receipt=await accelerateShardsObstacleWithItem(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
    expect(receipt.quantityAfter).toBe(f.inventory.qty-1);applied=true;
    await tx.execute(sql`set constraints all immediate`);flushed=true;
    if(change==='restore quantity')await tx.execute(sql`update base_items set qty=${f.inventory.qty} where id=${f.inventory.id}::uuid`);
    if(change==='change seen time')await tx.execute(sql`update base_items set seen_at=${accepted.toISOString()}::timestamptz where id=${f.inventory.id}::uuid`);
    if(change==='delete and reinsert'){
     const [deleted]=await tx.execute(sql`delete from base_items where id=${f.inventory.id}::uuid returning to_jsonb(base_items) original`);
     await tx.execute(sql`insert into base_items select * from jsonb_populate_record(null::base_items,${JSON.stringify(deleted!.original)}::jsonb)`);
    }
    if(change==='truncate')await tx.execute(sql`truncate base_items cascade`);
   })).rejects.toThrow();
   expect(applied).toBe(true);expect(flushed).toBe(true);expect(await snapshot()).toEqual(before);
   expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
  });
 it.each(['update','delete'] as const)('refuses source item-use %s after its deferred evidence checks were flushed',async change=>{
  const f=await fixture(),before=await snapshot();let applied=false,flushed=false;
  await expect(db.transaction(async tx=>{
   const receipt=await accelerateShardsObstacleWithItem(tx,f.wallet,f.command,f.context,{clock:()=>accepted});applied=true;
   await tx.execute(sql`set constraints all immediate`);flushed=true;
   if(change==='update')await tx.execute(sql`update item_uses set used_at=used_at+interval '1 millisecond' where id=${receipt.key}::uuid`);
   else await tx.execute(sql`delete from item_uses where id=${receipt.key}::uuid`);
  })).rejects.toThrow();
  expect(applied).toBe(true);expect(flushed).toBe(true);expect(await snapshot()).toEqual(before);
  expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
 });

 it('refuses an acceleration behind a committed real cache term floor before any use or decrement',async()=>{
  for(const name of ['MULTI_BASE_ENABLED','PHASE_E_MINING_ENABLED'])vi.stubEnv(name,'true');
  const history=await createShardsHistoryFixture(db),wallet=history.player.wallet,baseId=history.base.id;
  const capturedAt=new Date(+history.start-2000),at=new Date(+history.start-1000);
  const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
  const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId,kind:'clear_obstacle',obstacleId:obstacle!.id,
   startedAt:capturedAt,finishesAt:new Date(+history.start+OBSTACLES.tiers.small.clearSec*1000)}).returning();
  await db.insert(baseItems).values({baseId,itemId,qty:1,acquiredVia:'grant'});
  const command={baseId,jobId:job!.id,itemId,idempotencyKey:randomUUID()};
  await admitShardsObstacleObligation(db,wallet,{baseId,jobId:job!.id,idempotencyKey:randomUUID()},history.context,{clock:()=>capturedAt});
  await seedHistoricalTaxedCache(db,wallet,{...history.context,shardsCacheSource:{clock:()=>history.start,
   prefetch:async()=>({readOperatingTerm:async()=>history.observation})}},history.start);
  expect(await conn.sql`select term_id from shards_cache_assessments where wallet=${wallet}`).toEqual([{term_id:history.termId}]);
  const before=await snapshot();
  await expect(accelerateShardsObstacleWithItem(db,wallet,command,history.context,{clock:()=>at})).rejects.toThrow('term floor');
  expect(await snapshot()).toEqual(before);expect(await readShardsObstacleItemAcceleration(db,wallet,command.idempotencyKey)).toBeNull();
 });
 it('uses the clock after a real second-connection wallet wait and refuses a now-due job without consumption',async()=>{
  const f=await fixture(),before=await snapshot(),other=conn.reopen();let release=()=>{},ready!:(pid:number)=>void;
  const locked=new Promise<number>(resolve=>{ready=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
  const holder=other.sql.begin(async tx=>{
   await tx`select wallet from shards_tax_wallet_locks where wallet=${f.wallet} for update`;
   const [row]=await tx`select pg_backend_pid() pid`;ready(Number(row!.pid));await barrier;
  });
  const holderPid=await locked;let now=accepted;
  const clock=vi.fn(()=>now),attempt=accelerateShardsObstacleWithItem(db,f.wallet,f.command,f.context,{clock})
   .then(value=>({value,error:null}),error=>({value:null,error}));
  try{
   let blocked=false;const deadline=Date.now()+10000;
   while(!blocked&&Date.now()<deadline){
    const [row]=await conn.sql`select exists(select 1 from pg_stat_activity where datname=current_database()
     and ${holderPid}::integer=any(pg_blocking_pids(pid))) blocked`;blocked=row!.blocked;
   }
   expect(blocked).toBe(true);expect(clock).not.toHaveBeenCalled();now=new Date(+f.job.finishesAt+1);
   release();await holder;const result=await attempt;
   expect(result.value).toBeNull();expect(result.error).toBeInstanceOf(Error);expect(result.error.message).toContain('unfinished captured schedule');
   expect(clock).toHaveBeenCalled();expect(await snapshot()).toEqual(before);
   expect(await readShardsObstacleItemAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
  }finally{release();await Promise.allSettled([holder,attempt]);await other.sql.end();}
 });

});
