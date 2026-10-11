import {seedHistoricalTaxedCache} from './fixtures/historicalTaxedCache';
/** Owned PostgreSQL fixtures. xmin status is rejected as debit provenance: updates launder old rows. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {OBSTACLES} from '@shardkeep/shared';
import {bases,baseSlots,builderJobs,obstacles} from '../src/db/schema';
import {builderJobFinishCostKeep} from '../src/game/base';
import {builderJobPaidQuote,builderJobSpeedupLedgerKey} from '../src/game/builderJobSpeedupReceipt';
import {admitShardsObstacleObligation,readShardsObstacleObligation,assertShardsObstacleTermPrefix} from '../src/mining/shardsTaxObstacleObligations';
import {prepareShardsObstacleGemsAcceleration,readShardsObstacleGemsAcceleration} from '../src/mining/shardsTaxObstacleGemsAcceleration';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer,fundTestKeep} from './helpers';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {convertKeepToGems} from '../src/game/gems';
import {spendGameCurrency} from '../src/game/spend';
import type {DbOrTx} from '../src/db/client';

const conn=resourceClaimsDatabase(),db=conn.db;
beforeAll(()=>conn.setup());afterAll(()=>conn.close());afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
async function transactionStatus(tx:DbOrTx,id:string){
 const [row]=await tx.execute(sql`select xmin::text as xmin,pg_current_xact_id()::text as top,
  pg_xact_status(xmin::text::xid8) as status from ledger_transactions where id=${id}::uuid`);
 return row;
}

const start=new Date('2038-01-01T00:00:00.000Z'),accepted=new Date(+start+1000);
async function fixture(capture=true){
 for(const name of ['GEMS_ENABLED','PHASE_E_MINING_ENABLED','MULTI_BASE_ENABLED'])vi.stubEnv(name,'true');
 const player=await createTestPlayer(db),wallet=player.wallet;
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
 await db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});
 const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base!.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,
  startedAt:start,finishesAt:new Date(+start+OBSTACLES.tiers.small.clearSec*1000)}).returning();
 const context={baseId:base!.id,assertAuthority:async()=>{}},command={baseId:base!.id,jobId:job!.id,idempotencyKey:String(randomUUID())};
 const obligation= capture?await admitShardsObstacleObligation(db,wallet,{...command,idempotencyKey:randomUUID()},context,{clock:()=>start}):null;
 const cost=builderJobFinishCostKeep(job!,accepted),request={...command,expectedCurrency:'GEMS' as const,consent:builderJobPaidQuote(job!,cost)!};
 await fundTestKeep(db,wallet,cost*3n,'test.obstacle.gems.fund',randomUUID());await convertKeepToGems(db,wallet,cost*2n,randomUUID());
 return {wallet,base:base!,obstacle:obstacle!,job:job!,context,command,obligation,cost,request};
}
async function debit(tx:DbOrTx,f:Awaited<ReturnType<typeof fixture>>,at=accepted,change:Record<string,unknown>={}){
 return spendGameCurrency(tx,f.wallet,f.cost,'build.speedup',builderJobSpeedupLedgerKey(f.wallet,f.command.idempotencyKey),{
  baseId:f.base.id,jobId:f.job.id,remSec:Math.ceil((+f.job.finishesAt-+at)/1000),builderJobSpeedup:{version:1,request:f.request,
   result:{jobId:f.job.id,kind:f.job.kind,buildingId:null,obstacleId:f.obstacle.id,completedAt:at.toISOString()}},...change,
 },{context:{currency:'GEMS',expectedCurrency:'GEMS'}});
}
const state=async(f:Awaited<ReturnType<typeof fixture>>)=>({
 balances:await conn.sql`select id,balance::text from accounts order by id`,
 job:(await db.select().from(builderJobs).where(eq(builderJobs.id,f.job.id)))[0],
 obstacle:(await db.select().from(obstacles).where(eq(obstacles.id,f.obstacle.id)))[0],
 ledger:await conn.sql`select id from ledger_transactions order by id`,
});
async function cacheRaceFixture(){
 for(const name of ['GEMS_ENABLED','PHASE_E_MINING_ENABLED','MULTI_BASE_ENABLED'])vi.stubEnv(name,'true');
 const history=await createShardsHistoryFixture(db),wallet=history.player.wallet,base=history.base,context=history.context;
 const began=new Date(+history.start-2000),at=new Date(+history.start-1000);
 const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
 const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:began,
  finishesAt:new Date(+history.start+OBSTACLES.tiers.small.clearSec*1000)}).returning();
 const command={baseId:base.id,jobId:job!.id,idempotencyKey:String(randomUUID())};
 const obligation=await admitShardsObstacleObligation(db,wallet,{...command,idempotencyKey:randomUUID()},context,{clock:()=>began});
 const cost=builderJobFinishCostKeep(job!,at),request={...command,expectedCurrency:'GEMS' as const,consent:builderJobPaidQuote(job!,cost)!};
 await fundTestKeep(db,wallet,cost*2n,'test.obstacle.race.fund',randomUUID());await convertKeepToGems(db,wallet,cost*2n,randomUUID());
 return {history,at,f:{wallet,base,obstacle:obstacle!,job:job!,command,context,obligation,cost,request}};
}

describe.sequential('unmounted Gems acceleration journal',()=>{
 it('binds one real Gems debit to a shorter timer while retaining original capture and no SHARDS completion',async()=>{
  const f=await fixture(),before=await state(f);let ledgerId='';
  const receipt=await db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   expect(prepared.status).toBe('prepared');if(prepared.status!=='prepared')throw Error('new fixture unexpectedly replayed');
   const posted=await debit(tx,f);expect(posted.duplicate).toBe(false);ledgerId=posted.transaction.id;
   return prepared.apply();
  });
  expect(receipt).toMatchObject({idempotencyKey:f.command.idempotencyKey,obligationId:f.obligation!.idempotencyKey,jobId:f.job.id,baseId:f.base.id,
   obstacleId:f.obstacle.id,wallet:f.wallet,kind:'gems',key:ledgerId,acceptedAt:accepted.toISOString(),beforeFinishAt:f.job.finishesAt.toISOString(),
   afterFinishAt:accepted.toISOString(),gemsAmount:f.cost.toString(),earningWalletConfirmed:false,postingAuthorized:false});
  expect(receipt.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await readShardsObstacleGemsAcceleration(db,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
  expect(await readShardsObstacleObligation(db,f.wallet,f.obligation!.idempotencyKey)).toEqual(f.obligation);
  const after=await state(f);expect(after.job).toEqual({...before.job,finishesAt:accepted});expect(after.obstacle).toEqual(before.obstacle);
  expect(after.ledger.length).toBe(before.ledger.length+1);
  expect(await conn.sql`select id from ledger_transactions where idempotency_key=${'obstacle-reward:'+f.job.id}`).toHaveLength(0);
  expect(await conn.sql`select ledger_id from shards_obstacle_gems_accelerations where obligation_id=${f.obligation!.idempotencyKey}`).toEqual([{ledger_id:ledgerId}]);
 });
});

async function accelerate(f:Awaited<ReturnType<typeof fixture>>){
 return db.transaction(async tx=>{
  const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
  if(prepared.status==='replay')return prepared.receipt;
  await debit(tx,f);return prepared.apply();
 });
}
async function noEvent(f:Awaited<ReturnType<typeof fixture>>){
 expect(await readShardsObstacleGemsAcceleration(db,f.wallet,f.command.idempotencyKey)).toBeNull();
 expect(await conn.sql`select ledger_id from shards_obstacle_gems_posts where obligation_id=${f.obligation!.idempotencyKey}`).toHaveLength(0);
}

describe.sequential('same-transaction Gems witnesses and atomicity',()=>{
 it('retains full top-transaction INSERT witnesses across nested caller and ledger SAVEPOINT RELEASE',async()=>{
  const f=await fixture();let id='';
  await db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected replay');
   await tx.transaction(async nested=>{
    const posted=await debit(nested,f);id=posted.transaction.id;
    expect(await transactionStatus(nested,id)).toMatchObject({status:'in progress'});
   });
   const status=await transactionStatus(tx,id);expect(status).toMatchObject({status:'in progress'});expect(status!.xmin).not.toBe(status!.top);
   const posts=await tx.execute(sql`select tx_key from shards_obstacle_gems_posts where ledger_id=${id}::uuid`);
   expect(posts).toEqual([{tx_key:status!.top}]);
   const entries=await tx.execute(sql`select tx_key from shards_obstacle_gems_entries where ledger_id=${id}::uuid`);
   expect(entries).toHaveLength(2);expect(entries.every(row=>row.tx_key===status!.top)).toBe(true);
   expect(await conn.sql`select id from ledger_transactions where id=${id}`).toHaveLength(0);
   await prepared.apply();
  });
  expect(await transactionStatus(db,id)).toMatchObject({status:'committed'});
  expect(await readShardsObstacleGemsAcceleration(db,f.wallet,f.command.idempotencyKey)).not.toBeNull();
 });
 it('rejects a committed old debit even after no-op UPDATE launders header and entry xmin values',async()=>{
  const f=await fixture(false),paid=await debit(db,f),id=paid.transaction.id;
  f.obligation=await admitShardsObstacleObligation(db,f.wallet,{...f.command,idempotencyKey:randomUUID()},f.context,{clock:()=>start});
  const before=await state(f);expect(await transactionStatus(db,id)).toMatchObject({status:'committed'});
  await expect(db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('old debit must not become replay');
   await tx.execute(sql`update ledger_transactions set metadata=metadata where id=${id}::uuid`);
   await tx.execute(sql`update ledger_entries set delta=delta where txn_id=${id}::uuid`);
   expect(await transactionStatus(tx,id)).toMatchObject({status:'in progress'});
   const statuses=await tx.execute(sql`select pg_xact_status(xmin::text::xid8) status from ledger_entries where txn_id=${id}::uuid`);
   expect(statuses).toHaveLength(2);expect(statuses.every(row=>row.status==='in progress')).toBe(true);
   expect(await tx.execute(sql`select ledger_id from shards_obstacle_gems_posts where ledger_id=${id}::uuid`)).toHaveLength(0);
   await prepared.apply();
  })).rejects.toThrow();
  await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it('rolls back debit, both witnesses, journal and shortened timer after an actual applied transition fails',async()=>{
  const f=await fixture(),before=await state(f);let applied=false;
  await expect(db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected replay');await debit(tx,f);await prepared.apply();
   expect((await tx.select().from(builderJobs).where(eq(builderJobs.id,f.job.id)))[0]!.finishesAt).toEqual(accepted);
   applied=true;throw Error('fixture after journal and timer');
  })).rejects.toThrow('fixture after journal and timer');
  expect(applied).toBe(true);await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it('refuses an orphan enrolled-job debit at commit even when the caller never applies the prepared event',async()=>{
  const f=await fixture(),before=await state(f);
  await expect(db.transaction(async tx=>{await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});await debit(tx,f);})).rejects.toThrow();
  await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it('requires an actual debit and refuses a prepared closure after its original transaction ends',async()=>{
  const f=await fixture(),before=await state(f);let apply:(()=>Promise<unknown>)|undefined;
  await expect(db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected replay');await prepared.apply();
  })).rejects.toThrow();
  await db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected replay');apply=prepared.apply;
  });
  await expect(apply!()).rejects.toThrow();await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it.each(['KEEP','changed consent','changed acceptance'] as const)('atomically refuses %s proof instead of legitimizing a real but unrelated payment',async bad=>{
  const f=await fixture(),before=await state(f);
  await expect(db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected replay');
   if(bad==='KEEP'){
    const request={...f.request,expectedCurrency:'KEEP'};
    await spendGameCurrency(tx,f.wallet,f.cost,'build.speedup',builderJobSpeedupLedgerKey(f.wallet,f.command.idempotencyKey),{
     baseId:f.base.id,jobId:f.job.id,remSec:Math.ceil((+f.job.finishesAt-+accepted)/1000),builderJobSpeedup:{version:1,request,
      result:{jobId:f.job.id,kind:f.job.kind,buildingId:null,obstacleId:f.obstacle.id,completedAt:accepted.toISOString()}},
    },{context:{currency:'KEEP',expectedCurrency:'KEEP'}});
   }else if(bad==='changed consent'){
    const original=f.request;f.request={...original,consent:{...original.consent,finishesAt:new Date(+f.job.finishesAt+1000).toISOString()}};
    await debit(tx,f);f.request=original;
   }else await debit(tx,f,new Date(+accepted+1));
   await prepared.apply();
  })).rejects.toThrow();
  await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it('checks pause again after a real debit and rolls every monetary and journal effect back',async()=>{
  const f=await fixture(),before=await state(f);
  await expect(db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected replay');await debit(tx,f);vi.stubEnv('PHASE_E_MINING_ENABLED','false');await prepared.apply();
  })).rejects.toThrow();await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it('replays concurrent/lost responses after pause and reconnect without consulting current authority or paying twice',async()=>{
  const f=await fixture(),before=await state(f),receipts=await Promise.all([accelerate(f),accelerate(f)]);
  expect(receipts[0]).toEqual(receipts[1]);const after=await state(f);expect(after.ledger.length).toBe(before.ledger.length+1);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.stubEnv('GEMS_ENABLED','false');const reopened=conn.reopen();
  try{
   const replay=await reopened.db.transaction(tx=>prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,
    {...f.context,assertAuthority:async()=>{throw Error('historical replay must not reauthorize');}},{clock:()=>f.job.finishesAt}));
   expect(replay).toEqual({status:'replay',receipt:receipts[0]});
   expect(await readShardsObstacleGemsAcceleration(reopened.db,f.wallet,f.command.idempotencyKey)).toEqual(receipts[0]);
  }finally{await reopened.sql.end();}
  const other=await createTestPlayer(db);expect(await readShardsObstacleGemsAcceleration(db,other.wallet,f.command.idempotencyKey)).toBeNull();
  expect((await state(f)).job).toEqual(after.job);
 });
 it('keeps one event per obligation and preserves raw completion, obstacle and schedule fences',async()=>{
  const f=await fixture();await accelerate(f);
  await expect(db.transaction(tx=>prepareShardsObstacleGemsAcceleration(tx,f.wallet,{...f.command,idempotencyKey:randomUUID()},f.context,{clock:()=>accepted}))).rejects.toThrow();
  for(const statement of [conn.sql`update builder_jobs set finishes_at=finishes_at-interval '1 millisecond' where id=${f.job.id}`,
   conn.sql`update builder_jobs set completed_at=${accepted.toISOString()} where id=${f.job.id}`,
   conn.sql`update obstacles set cleared_at=${accepted.toISOString()} where id=${f.obstacle.id}`])await expect(statement).rejects.toThrow();
  await expect(assertShardsObstacleTermPrefix(db,f.wallet,new Date(+accepted+1).toISOString())).rejects.toThrow();
  await assertShardsObstacleTermPrefix(db,f.wallet,accepted.toISOString());
 });
 it('refuses direct witness insertion and all witness/event updates, deletes and truncation',async()=>{
  const f=await fixture(),receipt=await accelerate(f);
  for(const table of ['shards_obstacle_gems_posts','shards_obstacle_gems_entries','shards_obstacle_gems_accelerations']){
   for(const query of [`update ${table} set ledger_id=ledger_id`,`delete from ${table}`,`truncate ${table} cascade`])await expect(conn.sql.unsafe(query)).rejects.toThrow();
  }
  const [row]=await conn.sql`select to_jsonb(p) value from shards_obstacle_gems_posts p where ledger_id=${receipt.key}`;
  await expect(conn.sql`insert into shards_obstacle_gems_posts select * from jsonb_populate_record(null::shards_obstacle_gems_posts,${JSON.stringify({...row!.value,ledger_id:randomUUID(),obligation_id:randomUUID()})}::jsonb)`).rejects.toThrow();
 });
 it('refuses an accelerated earning behind a real committed cache term without another debit or timer change',async()=>{
  for(const name of ['GEMS_ENABLED','PHASE_E_MINING_ENABLED','MULTI_BASE_ENABLED'])vi.stubEnv(name,'true');
  const history=await createShardsHistoryFixture(db),wallet=history.player.wallet,base=history.base;
  const began=new Date(+history.start-2000),at=new Date(+history.start-1000),finish=new Date(+history.start+OBSTACLES.tiers.small.clearSec*1000);
  const [obstacle]=await db.insert(obstacles).values({playerWallet:wallet,baseId:base.id,spriteKey:OBSTACLES.tiers.small.kinds[0],tx:0,ty:0}).returning();
  const [job]=await db.insert(builderJobs).values({playerWallet:wallet,baseId:base.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:began,finishesAt:finish}).returning();
  const command={baseId:base.id,jobId:job!.id,idempotencyKey:randomUUID()},context=history.context;
  const obligation=await admitShardsObstacleObligation(db,wallet,{...command,idempotencyKey:randomUUID()},context,{clock:()=>began});
  const cost=builderJobFinishCostKeep(job!,at),request={...command,expectedCurrency:'GEMS' as const,consent:builderJobPaidQuote(job!,cost)!};
  await fundTestKeep(db,wallet,cost*2n,'test.obstacle.floor.fund',randomUUID());await convertKeepToGems(db,wallet,cost*2n,randomUUID());
  await seedHistoricalTaxedCache(db,wallet,{...context,shardsCacheSource:{clock:()=>history.start,prefetch:async()=>({readOperatingTerm:async()=>history.observation})}},history.start);
  const f={wallet,base,obstacle:obstacle!,job:job!,command,context,obligation,cost,request},before=await state(f);
  await expect(db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,wallet,command,context,{clock:()=>at});
   if(prepared.status!=='prepared')throw Error('unexpected replay');await debit(tx,f,at);await prepared.apply();
  })).rejects.toThrow();await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it('samples accepted time only after a real second-connection wallet mutex wait',async()=>{
  const f=await fixture(),other=conn.reopen();let release=()=>{},ready!:(pid:number)=>void;
  const locked=new Promise<number>(resolve=>{ready=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const holding=conn.sql.begin(async tx=>{
   await tx`select wallet from shards_tax_wallet_locks where wallet=${f.wallet} for update`;
   const [row]=await tx`select pg_backend_pid() pid`;ready(row!.pid);await held;
  });
  const holder=await locked;let at=accepted,pid=0,done=false;
  const executing=other.db.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,{...f.context,assertAuthority:async authorityTx=>{
    const [row]=await authorityTx.execute(sql`select pg_backend_pid() pid`);pid=Number(row!.pid);
   }},{clock:()=>at});
   if(prepared.status!=='prepared')throw Error('unexpected replay');await debit(tx,f,at);return prepared.apply();
  }).then(result=>{done=true;return result;},error=>{done=true;throw error;});
  try{
   let blocked=false;const deadline=Date.now()+10000;
   while(!blocked&&!done&&Date.now()<deadline){const [row]=await conn.sql`select ${holder}::integer=any(pg_blocking_pids(${pid}::integer)) blocked`;blocked=row!.blocked;}
   expect(blocked).toBe(true);at=new Date(+accepted+1);release();await holding;
   expect(await executing).toMatchObject({acceptedAt:at.toISOString(),afterFinishAt:at.toISOString()});
  }finally{release();await Promise.allSettled([holding,executing]);await other.sql.end();}
 });

 it.each(['started_at','finishes_at'] as const)('holds %s microsecond precision that millisecond consent cannot faithfully identify',async column=>{
  const f=await fixture(false);
  await conn.sql.unsafe(`update builder_jobs set ${column}=${column}+interval '100 microseconds' where id=$1`,[f.job.id]);
  f.obligation=await admitShardsObstacleObligation(db,f.wallet,{...f.command,idempotencyKey:randomUUID()},f.context,{clock:()=>new Date(+start+1)});
  const before=await state(f);await expect(accelerate(f)).rejects.toThrow();await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it('accepts existing non-UUID builder idempotency keys and rejects changed identity under the saved key',async()=>{
  const f=await fixture();f.command.idempotencyKey='builder-gems-'+randomUUID();f.request={...f.request,idempotencyKey:f.command.idempotencyKey};
  const receipt=await accelerate(f);expect(receipt.idempotencyKey).toBe(f.command.idempotencyKey);
  await expect(db.transaction(tx=>prepareShardsObstacleGemsAcceleration(tx,f.wallet,{...f.command,jobId:randomUUID()},f.context,{clock:()=>accepted}))).rejects.toThrow();
 });
 it('holds historical replay and pending order if original ledger evidence is later damaged',async()=>{
  const f=await fixture(),receipt=await accelerate(f);
  await conn.sql`update ledger_transactions set metadata=metadata || '{"fixtureDamaged":true}'::jsonb where id=${receipt.key}`;
  await expect(readShardsObstacleGemsAcceleration(db,f.wallet,f.command.idempotencyKey)).rejects.toThrow();
  await expect(assertShardsObstacleTermPrefix(db,f.wallet,start.toISOString())).rejects.toThrow();
 });

 it('does not let uppercase enrolled job metadata escape the mandatory same-transaction witness',async()=>{
  const f=await fixture(),before=await state(f);
  await expect(db.transaction(async tx=>{await debit(tx,f,accepted,{jobId:f.job.id.toUpperCase()});})).rejects.toThrow();
  await noEvent(f);expect(await state(f)).toEqual(before);
 });

 it.each(['started_at','finishes_at'] as const)('rejects raw SQL journal/timer insertion with fractional original %s, bypassing the TS prepare helper',async column=>{
  const f=await fixture(false);
  await conn.sql.unsafe(`update builder_jobs set ${column}=${column}+interval '100 microseconds' where id=$1`,[f.job.id]);
  f.obligation=await admitShardsObstacleObligation(db,f.wallet,{...f.command,idempotencyKey:randomUUID()},f.context,{clock:()=>new Date(+start+1)});
  const before=await state(f);
  await expect(db.transaction(async tx=>{
   // Calculate exact SQL seconds so finish precision cannot fail merely because
   // this raw fixture happened to carry a truncated remSec value.
   const [row]=await tx.execute(sql`select ceil(extract(epoch from (scheduled_finish_at-${accepted.toISOString()}::timestamptz))) rem_sec
    from shards_obstacle_obligations where id=${f.obligation!.idempotencyKey}::uuid`);
   const posted=await debit(tx,f,accepted,{remSec:Number(row!.rem_sec)});
   await tx.execute(sql`insert into shards_obstacle_gems_accelerations(obligation_id,ledger_id,wallet,idempotency_key,
    before_finish_at,after_finish_at,gems_amount,evidence_sha256)
    select h.id,${posted.transaction.id}::uuid,h.wallet,${f.command.idempotencyKey},h.scheduled_finish_at,
     ${accepted.toISOString()}::timestamptz,${f.cost.toString()}::bigint,${'ab'.repeat(32)}
    from shards_obstacle_obligations h where h.id=${f.obligation!.idempotencyKey}::uuid`);
   // Without the SQL precision guard, this otherwise complete raw transition
   // could commit; deferred missing-timer rejection cannot satisfy this test.
   await tx.execute(sql`update builder_jobs set finishes_at=${accepted.toISOString()}::timestamptz where id=${f.job.id}::uuid`);
  })).rejects.toThrow();await noEvent(f);expect(await state(f)).toEqual(before);
 });

 it('replays the same receipt and pending boundary independently of the caller session TimeZone',async()=>{
  const f=await fixture(),receipt=await accelerate(f);
  await db.transaction(async tx=>{
   await tx.execute(sql`set local time zone 'Asia/Tbilisi'`);
   expect(await readShardsObstacleGemsAcceleration(tx,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
   await assertShardsObstacleTermPrefix(tx,f.wallet,accepted.toISOString());
   await expect(assertShardsObstacleTermPrefix(tx,f.wallet,new Date(+accepted+1).toISOString())).rejects.toThrow();
  });
 });

 it('commits prospective capture, actual Gems payment, journal and timer together through nested savepoints',async()=>{
  const f=await fixture(false);
  const receipt=await db.transaction(async tx=>{
   f.obligation=await admitShardsObstacleObligation(tx,f.wallet,{...f.command,idempotencyKey:randomUUID()},f.context,{clock:()=>start});
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,f.context,{clock:()=>accepted});
   if(prepared.status!=='prepared')throw Error('unexpected replay');
   await debit(tx,f);return prepared.apply();
  });
  expect(await readShardsObstacleGemsAcceleration(db,f.wallet,f.command.idempotencyKey)).toEqual(receipt);
  expect(await readShardsObstacleObligation(db,f.wallet,f.obligation!.idempotencyKey)).toEqual(f.obligation);
 });
 it('rejects an event with real debit but no timer transition at deferred commit',async()=>{
  const f=await fixture(),before=await state(f);let eventInserted=false;
  await expect(db.transaction(async tx=>{
   const posted=await debit(tx,f);
   await tx.execute(sql`insert into shards_obstacle_gems_accelerations(obligation_id,ledger_id,wallet,idempotency_key,before_finish_at,after_finish_at,gems_amount,evidence_sha256)
    values(${f.obligation!.idempotencyKey},${posted.transaction.id},${f.wallet},${f.command.idempotencyKey},${f.job.finishesAt.toISOString()}::timestamptz,
    ${accepted.toISOString()}::timestamptz,${f.cost.toString()}::bigint,${'ab'.repeat(32)})`);
   eventInserted=true;
  })).rejects.toThrow('SHARDS_OBSTACLE_GEMS_EVIDENCE');
  expect(eventInserted).toBe(true);await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it.each([-1n,1n])('rejects a real consented payment differing from the server quote by %s Gems',async difference=>{
  const f=await fixture(),before=await state(f);f.cost+=difference;
  f.request={...f.request,consent:{...f.request.consent,maxCostKeep:(f.cost+1n).toString()}};
  await expect(accelerate(f)).rejects.toThrow('server quote');await noEvent(f);expect(await state(f)).toEqual(before);
 });
 it.each(['missing witness','extra entry'] as const)('holds historical evidence after %s corruption instead of accepting an incomplete set',async damage=>{
  const f=await fixture(),receipt=await accelerate(f);
  await conn.sql.begin(async tx=>{
   // Fixture-only simulated storage damage; runtime has no replication bypass.
   await tx`set local session_replication_role='replica'`;
   if(damage==='missing witness')await tx`delete from shards_obstacle_gems_entries where entry_id=(select min(entry_id) from shards_obstacle_gems_entries where ledger_id=${receipt.key})`;
   else await tx`insert into ledger_entries(txn_id,account_id,delta,balance_after) select txn_id,account_id,delta,balance_after from ledger_entries where txn_id=${receipt.key} limit 1`;
  });
  await expect(readShardsObstacleGemsAcceleration(db,f.wallet,f.command.idempotencyKey)).rejects.toThrow();
  await expect(assertShardsObstacleTermPrefix(db,f.wallet,start.toISOString())).rejects.toThrow();
 });
 it.each(['cache','acceleration'] as const)('serializes actual cache assessment versus accelerated earning when %s holds the parent first',async first=>{
  const {history,at,f}=await cacheRaceFixture(),other=conn.reopen();let release=()=>{},ready!:(pid:number)=>void,latched=false;
  const readyPromise=new Promise<number>(resolve=>{ready=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
  const firstAuthority=async(tx:Parameters<typeof prepareShardsObstacleGemsAcceleration>[0])=>{
   if(latched)return;latched=true;const [row]=await tx.execute(sql`select pg_backend_pid() pid`);ready(Number(row!.pid));await barrier;
  };
  const cache=(database:typeof db,blocked:boolean)=>seedHistoricalTaxedCache(database,f.wallet,{...f.context,
   assertAuthority:blocked?firstAuthority:f.context.assertAuthority,
   shardsCacheSource:{clock:()=>history.start,prefetch:async()=>({readOperatingTerm:async()=>history.observation})}},history.start);
  const speed=(database:typeof db,blocked:boolean)=>database.transaction(async tx=>{
   const prepared=await prepareShardsObstacleGemsAcceleration(tx,f.wallet,f.command,{...f.context,assertAuthority:blocked?firstAuthority:f.context.assertAuthority},{clock:()=>at});
   if(prepared.status!=='prepared')throw Error('unexpected replay');await debit(tx,f,at);return prepared.apply();
  });
  const before=await state(f),firstRun=first==='cache'?cache(db,true):speed(db,true);
  const holder=await readyPromise;
  const secondRun=(first==='cache'?speed(other.db,false):cache(other.db,false)).then(value=>({value,error:null}),error=>({value:null,error}));
  try{
   let blocked=false;const deadline=Date.now()+10000;
   while(!blocked&&Date.now()<deadline){const [row]=await conn.sql`select exists(select 1 from pg_stat_activity where datname=current_database() and ${holder}::integer=any(pg_blocking_pids(pid))) blocked`;blocked=row!.blocked;}
   expect(blocked).toBe(true);release();await firstRun;
   const losing=await secondRun;expect(losing.error).toBeInstanceOf(Error);expect(losing.value).toBeNull();
   const cacheRows=await conn.sql`select wallet from shards_cache_assessments where wallet=${f.wallet}`;
   const after=await state(f);
   if(first==='cache'){
    expect(cacheRows).toHaveLength(1);await noEvent(f);expect(after.job).toEqual(before.job);
    expect(losing.error.message).toContain('term floor');
   }else{
    expect(cacheRows).toHaveLength(0);expect(await readShardsObstacleGemsAcceleration(db,f.wallet,f.command.idempotencyKey)).not.toBeNull();
    expect(after.job!.finishesAt).toEqual(at);expect(losing.error.message).toContain('pending obstacle');
    expect(await conn.sql`select base_id from base_streaks where base_id=${f.base.id}`).toHaveLength(0);
   }
   expect(after.obstacle).toEqual(before.obstacle);
   expect(after.ledger.length).toBe(before.ledger.length+1);
  }finally{release();await Promise.allSettled([firstRun,secondRun]);await other.sql.end();}
 });

});
