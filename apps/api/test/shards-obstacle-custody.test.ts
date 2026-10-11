/** Archival custody joins real Core evidence to immutable original obstacle facts. */
import {randomUUID} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {OBSTACLES} from '@shardkeep/shared';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import type {DeedMiningWalletReader} from '@shardkeep/chain/mining-wallet';
import type {DeedMiningRosterSource} from '../src/mining/deedRosterQualification';
import {fixture as walletFixture,tx as coreTx,collection,genesis,other} from '../../../packages/chain/src/testFixtures/deedMiningWallet';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer,fundTestKeep} from './helpers';
import type {Db} from '../src/db/client';
import {bases,baseSlots,builderJobs,obstacles,baseItems} from '../src/db/schema';
import {admitShardsObstacleObligation} from '../src/mining/shardsTaxObstacleObligations';
import {accelerateShardsObstacleWithItem,readShardsObstacleItemAcceleration} from '../src/mining/shardsTaxObstacleItemAcceleration';
import {prepareShardsObstacleGemsAcceleration} from '../src/mining/shardsTaxObstacleGemsAcceleration';
import {builderJobFinishCostKeep} from '../src/game/base';
import {builderJobPaidQuote,builderJobSpeedupLedgerKey} from '../src/game/builderJobSpeedupReceipt';
import {convertKeepToGems} from '../src/game/gems';
import {spendGameCurrency} from '../src/game/spend';
import {prefetchShardsObstacleCustody} from '../src/mining/shardsTaxObstacleCustody';

const conn=resourceClaimsDatabase(),db=conn.db,start=new Date('2038-01-01T00:00:00.125Z');
beforeAll(()=>conn.setup());afterAll(()=>conn.close());afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(deeded=true){
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const player=await createTestPlayer(db),wallet=player.wallet,assetId=Keypair.generate().publicKey.toBase58();
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1,
  deedAssetId:deeded?assetId:null,deedMintAssetId:deeded?assetId:null,landPaidAt:new Date(+start-1000)}).returning();
 await db.insert(baseSlots).values({wallet,baseId:base!.id,slot:1});
 const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const finish=new Date(+start+OBSTACLES.tiers.small.clearSec*1000+125);
 const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,finishesAt:finish}).returning();
 const context={baseId:base!.id,assertAuthority:async()=>{}},id=randomUUID();
 const obligation=await admitShardsObstacleObligation(db,wallet,{baseId:base!.id,jobId:job!.id,idempotencyKey:id},context,{clock:()=>new Date(+start+1)});
 return {wallet,assetId,base:base!,obstacle:obstacle!,job:job!,finish,context,id,obligation};
}
type Scenario='continuous'|'other owner'|'out and back'|'mint at start'|'acquire at start'|'transfer at earning'|'transfer at coverage end';
function chain(f:Awaited<ReturnType<typeof fixture>>,earnedAt=f.finish,scenario:Scenario='continuous'){
 const beginning=Math.floor(+start/1000),end=Math.ceil(+earnedAt/1000)+1,target=new PublicKey(f.wallet),asset=new PublicKey(f.assetId);
 const original=scenario==='other owner'||scenario==='acquire at start'?other:target;
 const transactions=[coreTx('collection',1),coreTx('mint',scenario==='mint at start'?11:10,original,asset)];let owner=original;
 if(scenario==='acquire at start'){transactions.push(coreTx('transfer',11,target,asset,other));owner=target;}
 if(scenario==='out and back')transactions.push(coreTx('transfer',12,other,asset,target),coreTx('transfer',13,target,asset,other));
 if(scenario==='transfer at earning'||scenario==='transfer at coverage end'){
  transactions.push(coreTx('transfer',scenario==='transfer at earning'?18:19,other,asset,target));owner=other;
 }
 const raw=walletFixture(transactions,[{id:asset,owner}]);
 const times:Record<number,number>={1:beginning-100,10:beginning-1,11:beginning,12:beginning+1,13:beginning+2,18:Math.floor(+earnedAt/1000),19:end,20:end+1,21:end+2,25:end+3};
 for(const item of transactions)item.blockTime=times[item.slot]!;
 raw.reader.getBlockTime.mockImplementation(async slot=>times[slot]??null);
 raw.reader.getBlockSignatures.mockImplementation(async slot=>({blockTime:times[slot]!,signatures:transactions.filter(t=>t.slot===slot).map(t=>t.transaction.signatures[0])}));
 const source:DeedMiningRosterSource={source:raw.reader as unknown as DeedMiningWalletReader,collection:collection.toBase58(),expectedGenesisHash:genesis};
 return {...raw,source,times,beginning,end,target,asset};
}
const state=async()=>({
 parents:await conn.sql`select to_jsonb(b) value from bases b order by id`,
 jobs:await conn.sql`select to_jsonb(j) value from builder_jobs j order by id`,
 obstacles:await conn.sql`select to_jsonb(o) value from obstacles o order by id`,
 headers:await conn.sql`select to_jsonb(h) value from shards_obstacle_obligations h order by id`,
 accounts:await conn.sql`select to_jsonb(a) value from accounts a order by id`,
 ledger:await conn.sql`select to_jsonb(t) value from ledger_transactions t order by id`,
 uses:await conn.sql`select to_jsonb(u) value from item_uses u order by id`,
 inventory:await conn.sql`select to_jsonb(i) value from base_items i order by id`,
});
function frozen(value:unknown):void{if(value&&typeof value==='object'){expect(Object.isFrozen(value)).toBe(true);expect(value).not.toBeInstanceOf(Date);for(const child of Object.values(value))frozen(child);}}

describe.sequential('original obstacle archival deed custody',()=>{
 it('confirms continuous original custody after delayed processing and pause without moving money or completing work',async()=>{
  const f=await fixture(),c=chain(f),before=await state();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const result=await prefetchShardsObstacleCustody(db,f.id,c.source);
  expect(result).toMatchObject({version:1,purpose:'historical_obstacle_custody',obligation:f.obligation,accelerations:[],earnedAt:f.finish.toISOString(),
   custody:{status:'confirmed',baseId:f.base.id,wallet:f.wallet},sourceVerified:true,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false,
   source:{targetWallet:f.wallet,collection:collection.toBase58(),genesisHash:genesis,startAt:new Date(c.beginning*1000).toISOString(),endAt:new Date(c.end*1000).toISOString(),
    continuouslyHeldAssetIds:[f.assetId],evidence:{trust:'trusted-finalized-rpc',addressIndexCompleteness:'configured-provider-trust'}}});
  expect(result.custody.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);frozen(result);expect(await state()).toEqual(before);
 });
 it.each(['other owner','out and back','mint at start','acquire at start','transfer at earning'] as const)(
  'holds %s instead of inferring continuous custody from a final owner snapshot',async scenario=>{
   const f=await fixture(),c=chain(f,f.finish,scenario),before=await state();
   await expect(prefetchShardsObstacleCustody(db,f.id,c.source)).rejects.toThrow();expect(await state()).toEqual(before);
  });
 it('allows a transfer at the conservative coverage end while preserving original earning custody',async()=>{
  const f=await fixture(),c=chain(f,f.finish,'transfer at coverage end');
  const result=await prefetchShardsObstacleCustody(db,f.id,c.source);
  expect(result.custody.wallet).toBe(f.wallet);expect(result.source.evidence.assets[0]!.ownerAtHorizon).toBe(other.toBase58());
  expect(result.source.endAt).toBe(new Date(c.end*1000).toISOString());expect(result.earnedAt).toBe(f.finish.toISOString());
 });
 it.each(['missing transaction','unclosed horizon'] as const)('holds %s without turning unavailable evidence into custody',async missing=>{
  const f=await fixture(),c=chain(f),before=await state();
  if(missing==='missing transaction')c.reader.getTransaction.mockResolvedValue(null);
  else c.reader.getBlockTime.mockImplementation(async slot=>slot>=19?c.end-1:c.times[slot]??null);
  await expect(prefetchShardsObstacleCustody(db,f.id,c.source)).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it.each(['captured','started','scheduled'] as const)('rejects sub-millisecond %s evidence that the portable original hash cannot represent',async field=>{
  const f=await fixture(),c=chain(f);
  // Test-only damaged evidence retains its millisecond hash while exposing the
  // PostgreSQL precision that a portable custody interval must not round away.
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
   if(field==='captured')await tx`update shards_obstacle_obligations set captured_at=captured_at+interval '100 microseconds' where id=${f.id}`;
   if(field==='started'){
    await tx`update builder_jobs set started_at=started_at+interval '100 microseconds' where id=${f.job.id}`;
    await tx`update shards_obstacle_obligations set started_at=started_at+interval '100 microseconds' where id=${f.id}`;
   }
   if(field==='scheduled'){
    await tx`update builder_jobs set finishes_at=finishes_at+interval '100 microseconds' where id=${f.job.id}`;
    await tx`update shards_obstacle_obligations set scheduled_finish_at=scheduled_finish_at+interval '100 microseconds' where id=${f.id}`;
   }
  });
  const before=await state();await expect(prefetchShardsObstacleCustody(db,f.id,c.source)).rejects.toThrow();
  expect(c.reader.getGenesisHash).not.toHaveBeenCalled();expect(await state()).toEqual(before);
 });
 it('holds null deed identity rather than substituting an owned or configured collection asset',async()=>{
  const f=await fixture(false),c=chain(f);
  await expect(prefetchShardsObstacleCustody(db,f.id,c.source)).rejects.toThrow();expect(c.reader.getGenesisHash).not.toHaveBeenCalled();
 });
 it('requires capture strictly before effective earning even when a valid item receipt finishes at the capture instant',async()=>{
  const f=await fixture(),at=new Date(f.obligation.capturedAt);
  await db.insert(baseItems).values({baseId:f.base.id,itemId:'keg_of_haste',qty:1,acquiredVia:'grant'});
  const receipt=await accelerateShardsObstacleWithItem(db,f.wallet,{baseId:f.base.id,jobId:f.job.id,itemId:'keg_of_haste',idempotencyKey:randomUUID()},f.context,{clock:()=>at});
  expect(receipt.afterFinishAt).toBe(f.obligation.capturedAt);const c=chain(f,at),before=await state();
  await expect(prefetchShardsObstacleCustody(db,f.id,c.source)).rejects.toThrow();
  expect(c.reader.getGenesisHash).not.toHaveBeenCalled();expect(await state()).toEqual(before);
 });
 it('rejects a tampered original capture hash before asking the archival provider',async()=>{
  const f=await fixture(),c=chain(f);
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
   await tx`update shards_obstacle_obligations set evidence_sha256=${'ab'.repeat(32)} where id=${f.id}`;
  });
  const before=await state();await expect(prefetchShardsObstacleCustody(db,f.id,c.source)).rejects.toThrow();
  expect(c.reader.getGenesisHash).not.toHaveBeenCalled();expect(await state()).toEqual(before);
 });
 it.each(['item','gems'] as const)('derives effective earning from the actual immutable %s acceleration receipt without consuming again',async kind=>{
  const f=await fixture(),at=new Date(+start+1000),key=randomUUID(),command={baseId:f.base.id,jobId:f.job.id,idempotencyKey:key};
  let receipt;
  if(kind==='item'){
   await db.insert(baseItems).values({baseId:f.base.id,itemId:'keg_of_haste',qty:1,acquiredVia:'grant'});
   receipt=await accelerateShardsObstacleWithItem(db,f.wallet,{...command,itemId:'keg_of_haste'},f.context,{clock:()=>at});
  }else{
   vi.stubEnv('GEMS_ENABLED','true');const cost=builderJobFinishCostKeep(f.job,at);
   await fundTestKeep(db,f.wallet,cost,'test.obstacle.custody',randomUUID());await convertKeepToGems(db,f.wallet,cost,randomUUID());
   receipt=await db.transaction(async tx=>{
    const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,command,f.context,{clock:()=>at});
    if(prepared.status!=='prepared')throw Error('unexpected fixture replay');
    await spendGameCurrency(tx,f.wallet,cost,'build.speedup',builderJobSpeedupLedgerKey(f.wallet,key),{
     baseId:f.base.id,jobId:f.job.id,remSec:Math.ceil((+f.finish-+at)/1000),builderJobSpeedup:{version:1,
      request:{...command,expectedCurrency:'GEMS',consent:builderJobPaidQuote(f.job,cost)},
      result:{jobId:f.job.id,kind:'clear_obstacle',buildingId:null,obstacleId:f.obstacle.id,completedAt:at.toISOString()}},
    },{context:{currency:'GEMS',expectedCurrency:'GEMS'}});return prepared.apply();
   });
  }
  const c=chain(f,at),before=await state();vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.stubEnv('GEMS_ENABLED','false');
  const result=await prefetchShardsObstacleCustody(db,f.id,c.source);
  expect(result.accelerations).toEqual([receipt]);expect(result.obligation).toEqual(f.obligation);expect(result.earnedAt).toBe(at.toISOString());
  expect(result.source.endAt).toBe(new Date(c.end*1000).toISOString());expect(await state()).toEqual(before);frozen(result);
 });
 it('releases all local parent locks before provider work and copies source configuration before waiting',async()=>{
  const f=await fixture(),c=chain(f),otherConn=conn.reopen();let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let first=true;
  c.reader.getGenesisHash.mockImplementation(async()=>{if(first){first=false;enter();await gate;}return genesis;});
  const pending=prefetchShardsObstacleCustody(db,f.id,c.source);await entered;
  try{
   await otherConn.sql.begin(async tx=>{
    await tx`select wallet from players where wallet=${f.wallet} for update nowait`;
    await tx`select id from bases where id=${f.base.id} for update nowait`;
    await tx`select base_id from base_slots where base_id=${f.base.id} for update nowait`;
    await tx`select id from builder_jobs where id=${f.job.id} for update nowait`;
    await tx`select id from obstacles where id=${f.obstacle.id} for update nowait`;
   });
   c.source.collection=Keypair.generate().publicKey.toBase58();c.source.expectedGenesisHash=Keypair.generate().publicKey.toBase58();
   release();expect((await pending).source).toMatchObject({collection:collection.toBase58(),genesisHash:genesis});
  }finally{release();await Promise.allSettled([pending]);await otherConn.sql.end();}
 });
 it.each(['schedule','custody'] as const)('holds local %s changes committed during archival provider work',async change=>{
  const f=await fixture(),c=chain(f),otherConn=conn.reopen(),buyer=await createTestPlayer(db);let enter!:()=>void,release!:()=>void,first=true;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  c.reader.getGenesisHash.mockImplementation(async()=>{if(first){first=false;enter();await gate;}return genesis;});
  const pending=prefetchShardsObstacleCustody(db,f.id,c.source).then(value=>({value,error:null}),error=>({value:null,error}));await entered;
  try{
   await otherConn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
    if(change==='schedule')await tx`update builder_jobs set finishes_at=finishes_at-interval '1 millisecond' where id=${f.job.id}`;
    else await tx`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;
   });
   const before=await state();release();const result=await pending;expect(result.value).toBeNull();expect(result.error).toBeInstanceOf(Error);
   expect(await state()).toEqual(before);
  }finally{release();await Promise.allSettled([pending]);await otherConn.sql.end();}
 });
 it('rejects a valid item acceleration committed during archival prefetch while preserving the other transaction consumption',async()=>{
  const f=await fixture(),c=chain(f),otherConn=conn.reopen(),at=new Date(+start+1000),key=randomUUID();
  await db.insert(baseItems).values({baseId:f.base.id,itemId:'keg_of_haste',qty:1,acquiredVia:'grant'});
  let enter!:()=>void,release!:()=>void,first=true;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  c.reader.getGenesisHash.mockImplementation(async()=>{if(first){first=false;enter();await gate;}return genesis;});
  const pending=prefetchShardsObstacleCustody(db,f.id,c.source).then(value=>({value,error:null}),error=>({value:null,error}));await entered;
  try{
   const receipt=await accelerateShardsObstacleWithItem(otherConn.db,f.wallet,
    {baseId:f.base.id,jobId:f.job.id,itemId:'keg_of_haste',idempotencyKey:key},f.context,{clock:()=>at});
   expect(receipt.afterFinishAt).toBe(at.toISOString());expect(receipt.quantityAfter).toBe(0);
   expect(await readShardsObstacleItemAcceleration(db,f.wallet,key)).toEqual(receipt);
   const committed=await state();release();const result=await pending;
   expect(result.value).toBeNull();expect(result.error).toMatchObject({code:'SHARDS_OBSTACLE_CUSTODY_UNAVAILABLE'});
   expect(result.error.message).toContain('source changed during archival prefetch');expect(await state()).toEqual(committed);
   // A fresh complete read accepts this new state, proving the failed read was
   // stopped by its source fingerprint comparison, not invalid current parents.
   const current=await prefetchShardsObstacleCustody(db,f.id,chain(f,at).source);
   expect(current.accelerations).toEqual([receipt]);expect(current.earnedAt).toBe(at.toISOString());
   expect(await readShardsObstacleItemAcceleration(db,f.wallet,key)).toEqual(receipt);expect(await state()).toEqual(committed);
  }finally{release();await Promise.allSettled([pending]);await otherConn.sql.end();}
 });
 it('refuses an existing transaction handle so provider reads cannot inherit caller-held database locks',async()=>{
  const f=await fixture(),c=chain(f);
  await db.transaction(async tx=>{await tx.execute(sql`select id from bases where id=${f.base.id} for update`);
   await expect(prefetchShardsObstacleCustody(tx as unknown as Db,f.id,c.source)).rejects.toThrow();
  });expect(c.reader.getGenesisHash).not.toHaveBeenCalled();
 });
});
