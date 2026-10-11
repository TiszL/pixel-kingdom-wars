import {seedHistoricalTaxedCache} from './fixtures/historicalTaxedCache';
import {issueShardsCache} from '../src/mining/shardsTaxCacheSource';
/** D153.196 full-value rewards coexist with original immutable taxed history. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {DAILY_CACHE,MINING,PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,getMiningQuota} from '@shardkeep/shared';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {createTestPlayer} from './helpers';
import {baseStreaks,bases,baseSlots,buildings,builderJobs,mineAccrualStates} from '../src/db/schema';
import {claimBaseDailyCache,collectBaseMines,reanchorBaseMineAccrual,MINE_DAY_MS} from '../src/game/baseMining';
import {claimDailyCache} from '../src/game/emission';
import type {ExpeditionTermReader} from '../src/game/expeditionTerms';
import {readCompleteShardsTaxPool} from '../src/mining/shardsTaxHistory';
import {claimSeekerShardsTax} from '../src/mining/seekerShardsClaims';
import * as ledger from '../src/ledger';
import * as mineSources from '../src/mining/shardsTaxMineSources';

const conn=resourceClaimsDatabase(),db=conn.db;
const gross=BigInt(DAILY_CACHE.firstWeekStepShards),bps=BigInt(PHASE_E_POLICY.basisPoints);
const taxBps=BigInt(PHASE_E_POLICY.taxes.resources.islandPoolBps),tax=gross*taxBps/bps;
const admission={assertAdmission(){}};
beforeAll(()=>conn.setup());
afterAll(()=>conn.close());
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
function enable(){vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
async function fixture(options:{zeroWinners?:boolean}={}){enable();return createShardsHistoryFixture(db,options);}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function source(f:Fixture,at=f.start,reader?:ExpeditionTermReader){
 return {...f.context,shardsCacheSource:{clock:()=>at,prefetch:async()=>reader??{
  readOperatingTerm:async()=>({...f.observation,finality:{...f.observation.finality,observedAt:at.toISOString()}}),
 }}};
}
const key=(f:Fixture,at=f.start)=>`cache.claim:${f.base.id}:${at.toISOString().slice(0,10)}`;
async function balance(kind:string,baseId?:string){const rows=baseId
 ?await conn.sql`select balance::text from accounts where kind=${kind} and base_id=${baseId}`
 :await conn.sql`select balance::text from accounts where kind=${kind} and owner_wallet is null and base_id is null`;
 return BigInt(rows[0]?.balance??0);}
async function rows(f:Fixture){return conn.sql`select s.*,a.net,a.tax,a.wallet_sequence,a.lineage,a.carry_before,a.carry_after,a.receipt from shards_cache_sources s left join shards_cache_assessments a using(operation_key) where s.base_id=${f.base.id} order by s.earned_at`;}
async function assertUnclaimed(f:Fixture){
 expect(await rows(f)).toHaveLength(0);
 expect(await conn.sql`select id from ledger_transactions where idempotency_key like ${`cache.claim:${f.base.id}:%`}`).toHaveLength(0);
 const [streak]=await db.select().from(baseStreaks).where(eq(baseStreaks.baseId,f.base.id));
 expect(streak?.cacheClaimedDay??null).toBeNull();expect(streak?.currentDays??0).toBe(0);
 expect(await balance('base_shards',f.base.id)).toBe(0n);
}

describe.sequential('daily-cache exemption and original tax history',()=>{
 it('pays the full exempt cache with no term read, assessment, tax or carry movement',async()=>{
  const f=await fixture(),escrow=await balance('shards_tax_escrow'),genesis=await balance('shard_genesis');
  const read=vi.fn(async()=>{throw Error('Exempt cache must not read a term');});
  const result=await claimBaseDailyCache(db,f.player.wallet,source(f,f.start,{readOperatingTerm:read}),f.start);
  expect(result).toEqual({amount:gross,streakDays:1,everCompletedWeek1:false});expect(read).not.toHaveBeenCalled();
  expect(await balance('base_shards',f.base.id)).toBe(gross);expect(await rows(f)).toHaveLength(0);
  expect(await balance('shards_tax_escrow')).toBe(escrow);expect(await balance('shard_genesis')).toBe(genesis-gross);
  expect(await conn.sql`select * from shards_tax_all_assessments where wallet=${f.player.wallet}`).toHaveLength(0);
  const entries=await conn.sql`select a.kind,e.delta::text from ledger_entries e join accounts a on a.id=e.account_id join ledger_transactions t on t.id=e.txn_id where t.idempotency_key=${key(f)} order by a.kind::text`;
  expect(entries).toEqual([{kind:'base_shards',delta:gross.toString()},{kind:'shard_genesis',delta:(-gross).toString()}]);
 });
 it('preserves the historical Mine/cache/Mine carry prefix after the reward exemption',async()=>{
  const f=await fixture(),firstAt=new Date(+f.start+Math.ceil(3*MINE_DAY_MS/Number(f.quota)));
  const nextAt=new Date(+firstAt+Math.ceil(2*MINE_DAY_MS/Number(f.quota)));
  expect((await f.collect(firstAt)).amount).toBe(3n);
  await seedHistoricalTaxedCache(db,f.player.wallet,source(f,firstAt),firstAt);
  expect((await f.collect(nextAt)).amount).toBe(1n);
  const history=await conn.sql`select * from shards_tax_all_assessments where wallet=${f.player.wallet} order by wallet_sequence`;
  expect(history.map(r=>BigInt(r.wallet_sequence))).toEqual([1n,2n,3n]);
  expect(history.map(r=>BigInt(r.gross))).toEqual([3n,gross,2n]);
  expect(history.map(r=>BigInt(r.tax))).toEqual([0n,tax,1n]);
  expect(history.map(r=>BigInt(r.carry_before))).toEqual([0n,3n*taxBps,3n*taxBps]);
  expect(history.map(r=>BigInt(r.carry_after))).toEqual([3n*taxBps,3n*taxBps,0n]);
  expect(await readCompleteShardsTaxPool(db,f.termId,f.termHash)).toBe(tax+1n);
 });
 it('needs no provider for a new cache but preserves an original zero-winner cache pool',async()=>{
  const missing=await fixture(),escrow=await balance('shards_tax_escrow');
  expect((await claimBaseDailyCache(db,missing.player.wallet,missing.context,missing.start)).amount).toBe(gross);
  expect(await rows(missing)).toHaveLength(0);expect(await balance('shards_tax_escrow')).toBe(escrow);
  const zero=await fixture({zeroWinners:true});await seedHistoricalTaxedCache(db,zero.player.wallet,source(zero),zero.start);
  expect(await readCompleteShardsTaxPool(db,zero.termId,zero.termHash)).toBe(tax);
  const [row]=await rows(zero);expect(row!.receipt.pool.disposition).toBe('held_zero_winners');
  await expect(claimSeekerShardsTax(db,zero.player.wallet,{idempotencyKey:randomUUID(),baseId:zero.base.id,termId:zero.termId,spotId:0},zero.context,admission)).rejects.toMatchObject({code:'SEEKER_SHARDS_NOT_OWNER'});
 });
 it('never prefetches and chooses the accepted UTC day using the final injected clock',async()=>{
  const f=await fixture(),beforeMidnight=new Date(+f.start+MINE_DAY_MS-1),accepted=new Date(+beforeMidnight+1);
  const prefetch=vi.fn(async()=>{throw Error('No term required');});let at=beforeMidnight;
  const context={...f.context,assertAuthority:async()=>{at=accepted;},shardsCacheSource:{clock:()=>at,prefetch}};
  await claimBaseDailyCache(db,f.player.wallet,context,beforeMidnight);
  expect(prefetch).not.toHaveBeenCalled();expect(await rows(f)).toHaveLength(0);
  expect(await conn.sql`select id from ledger_transactions where idempotency_key=${key(f,accepted)}`).toHaveLength(1);
  const [streak]=await db.select().from(baseStreaks).where(eq(baseStreaks.baseId,f.base.id));expect(streak!.cacheClaimedDay).toBe(accepted.toISOString().slice(0,10));
 });
 it('does not make an exempt reward depend on term expiry',async()=>{
  const f=await fixture(),expiry=new Date(f.observation.snapshot.endsAt),requested=new Date(+expiry-1);let at=requested;
  const context={...source(f,requested),assertAuthority:async()=>{at=expiry;}};
  context.shardsCacheSource.clock=()=>at;
  expect((await claimBaseDailyCache(db,f.player.wallet,context,requested)).amount).toBe(gross);
  expect(await rows(f)).toHaveLength(0);expect(await conn.sql`select id from ledger_transactions where idempotency_key=${key(f,expiry)}`).toHaveLength(1);
 });
 it('pays full cache when mining pauses during the posting without a second reward',async()=>{
  const f=await fixture(),escrow=await balance('shards_tax_escrow'),original=ledger.postTransaction;
  vi.spyOn(ledger,'postTransaction').mockImplementationOnce(async(...args)=>{
   const result=await original(...args);vi.stubEnv('PHASE_E_MINING_ENABLED','false');return result;
  });
  expect((await claimBaseDailyCache(db,f.player.wallet,source(f),f.start)).amount).toBe(gross);
  expect(await rows(f)).toHaveLength(0);expect(await balance('shards_tax_escrow')).toBe(escrow);
  await expect(claimBaseDailyCache(db,f.player.wallet,source(f),f.start)).rejects.toThrow('already claimed today');
  expect(await balance('base_shards',f.base.id)).toBe(gross);
 });
 it('preserves an old net reward without top-up and pays next-day gross even after mining pauses',async()=>{
  const f=await fixture();await seedHistoricalTaxedCache(db,f.player.wallet,source(f),f.start);const original=await rows(f);
  await expect(claimBaseDailyCache(db,f.player.wallet,f.context,f.start)).rejects.toThrow('already claimed today');
  expect(await balance('base_shards',f.base.id)).toBe(gross-tax);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const next=new Date(+f.start+MINE_DAY_MS),before=await balance('base_shards',f.base.id);
  const result=await claimBaseDailyCache(db,f.player.wallet,f.context,next);
  expect(result.amount).toBe(2n*gross);expect(await balance('base_shards',f.base.id)).toBe(before+result.amount);
  expect(await rows(f)).toEqual(original);expect(await readCompleteShardsTaxPool(db,f.termId,f.termHash)).toBe(tax);
 });
 it('retains original wallet, deed, day and winning term after deed transfer and provider loss',async()=>{
  const f=await fixture();await seedHistoricalTaxedCache(db,f.player.wallet,source(f),f.start);const original=await rows(f),buyer=await createTestPlayer(db);
  await db.update(bases).set({ownerWallet:buyer.wallet}).where(eq(bases.id,f.base.id));
  await db.update(baseSlots).set({wallet:buyer.wallet}).where(eq(baseSlots.baseId,f.base.id));vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  expect(await rows(f)).toEqual(original);expect(await readCompleteShardsTaxPool(db,f.termId,f.termHash)).toBe(tax);
  expect(original[0]!.receipt.source.wallet).toBe(f.player.wallet);expect(original[0]!.receipt.term.snapshot.spots[0].ownerWallet).toBe(f.player.wallet);
 });
 it('survives a discarded response, restart and concurrent duplicate claims with only one credit and no tax receipt',async()=>{
  const f=await fixture(),calls=await Promise.allSettled(Array.from({length:3},()=>claimBaseDailyCache(db,f.player.wallet,source(f),f.start)));
  expect(calls.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  for(const result of calls)if(result.status==='rejected')expect(String(result.reason)).toMatch(/already claimed today/);
  const reopened=conn.reopen();try{await expect(claimBaseDailyCache(reopened.db,f.player.wallet,source(f),f.start)).rejects.toThrow('already claimed today');}finally{await reopened.sql.end();}
  expect(await rows(f)).toHaveLength(0);expect(await conn.sql`select id from ledger_transactions where idempotency_key=${key(f)}`).toHaveLength(1);
  expect(await balance('base_shards',f.base.id)).toBe(gross);expect(await readCompleteShardsTaxPool(db,f.termId,f.termHash)).toBe(0n);
 });
 it('pays the exact original cache pool once without minting or another source assessment',async()=>{
  const f=await fixture();await seedHistoricalTaxedCache(db,f.player.wallet,source(f),f.start);
  const before=await balance('base_shards',f.base.id),genesis=await balance('shard_genesis'),escrow=await balance('shards_tax_escrow');
  const command={idempotencyKey:randomUUID(),baseId:f.base.id,termId:f.termId,spotId:0};
  const receipt=await claimSeekerShardsTax(db,f.player.wallet,command,f.context,admission);
  expect(BigInt(receipt.quantity)).toBe(tax/2n);expect(await claimSeekerShardsTax(db,f.player.wallet,command,f.context,admission)).toEqual(receipt);
  expect(await balance('base_shards',f.base.id)).toBe(before+tax/2n);expect(await balance('shards_tax_escrow')).toBe(escrow-tax/2n);
  expect(await balance('shard_genesis')).toBe(genesis);expect(await rows(f)).toHaveLength(1);
  expect(await readCompleteShardsTaxPool(db,f.termId,f.termHash)).toBe(tax);
 });
 it('does not hold a new exempt cache behind an earlier lazy Mine term',async()=>{
  const f=await fixture(),next=new Date(f.observation.snapshot.endsAt);
  expect((await claimBaseDailyCache(db,f.player.wallet,f.context,next)).amount).toBe(gross);
  expect(await rows(f)).toHaveLength(0);expect(await conn.sql`select * from shards_tax_all_assessments where wallet=${f.player.wallet}`).toHaveLength(0);
 });
 it('retains the separate cutover fence on legacy wallet claims and refuses changes to the durable accepted cache source',async()=>{
  const f=await fixture(),legacy=await createTestPlayer(db);
  // This owned fixture DB has the cutover legacy-writer fence enabled. Seed
  // the historical Mine explicitly, then exercise the ordinary runtime path.
  await db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role='replica'`);
   await tx.insert(buildings).values({playerWallet:legacy.wallet,type:'mine',level:1,tx:1,ty:1});});
  await expect(claimDailyCache(db,legacy.wallet,f.start)).rejects.toMatchObject({code:'DEED_AUTHORITY_UNAVAILABLE'});
  expect(await conn.sql`select id from ledger_transactions where idempotency_key=${`cache.claim:${legacy.wallet}:${f.start.toISOString().slice(0,10)}`}`).toHaveLength(0);
  await seedHistoricalTaxedCache(db,f.player.wallet,source(f),f.start);
  await expect(conn.sql`update shards_cache_sources set wallet=${legacy.wallet} where operation_key=${key(f)}`).rejects.toThrow();
  await expect(conn.sql`delete from shards_cache_sources where operation_key=${key(f)}`).rejects.toThrow();
  await expect(db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role='replica'`);
   await tx.execute(sql`update shards_cache_sources set gross=gross+1 where operation_key=${key(f)}`);
   await expect(readCompleteShardsTaxPool(tx,f.termId,f.termHash)).rejects.toThrow();throw Error('rollback corrupt fixture');
  })).rejects.toThrow('rollback corrupt fixture');
  await expect(db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role='replica'`);
   await tx.execute(sql`delete from shards_cache_assessments where operation_key=${key(f)}`);
   await expect(readCompleteShardsTaxPool(tx,f.termId,f.termHash)).rejects.toThrow();throw Error('rollback missing assessment');
  })).rejects.toThrow('rollback missing assessment');
  expect(await readCompleteShardsTaxPool(db,f.termId,f.termHash)).toBe(tax);
 });
 it('serializes simultaneous Mine and cache issuance across two connections without charging the exempt reward or changing Mine carry',async()=>{
  const f=await fixture(),other=conn.reopen(),initialUnits=bps/taxBps-2n,concurrentUnits=2n;
  const firstAt=new Date(+f.start+Math.ceil(Number(initialUnits)*MINE_DAY_MS/Number(f.quota)));
  const raceAt=new Date(+firstAt+Math.ceil(Number(concurrentUnits)*MINE_DAY_MS/Number(f.quota)));
  const genesisBefore=await balance('shard_genesis'),escrowBefore=await balance('shards_tax_escrow');
  const initial=await f.collect(firstAt);
  let release!:()=>void,locked!:()=>void,enter!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>locked=resolve),entered=new Promise<void>(resolve=>enter=resolve);
  const holding=conn.sql.begin(async tx=>{await tx`select wallet from shards_tax_wallet_locks where wallet=${f.player.wallet} for update`;locked();await gate;});
  let both:Promise<unknown>|undefined;
  try{
   await ready;const original=mineSources.lockPhysicalMineTaxActors;
   vi.spyOn(mineSources,'lockPhysicalMineTaxActors').mockImplementation(async(tx,wallets)=>{if(wallets.includes(f.player.wallet))enter();await original(tx,wallets);});
   // Both real transactions begin while the original-wallet mutex is held.
   // Their player/base locks may decide the order; no ordering is assumed.
   const mine=collectBaseMines(db,f.player.wallet,f.context,raceAt);
   const cache=claimBaseDailyCache(other.db,f.player.wallet,source(f,raceAt),raceAt);
   const issued=Promise.all([mine,cache]);issued.catch(()=>{});
   both=issued;
   await Promise.race([entered,issued.then(()=>{throw Error('issuance bypassed the held carry mutex');})]);
   release();await holding;const [mined,cached]=await issued;
   const history=await conn.sql`select * from shards_tax_all_assessments where wallet=${f.player.wallet} order by wallet_sequence`;
   expect(history.map(r=>BigInt(r.wallet_sequence))).toEqual([1n,2n]);
   expect(history.filter(r=>r.source_kind==='physical_mine')).toHaveLength(2);expect(history.filter(r=>r.source_kind==='daily_cache')).toHaveLength(0);
   let carry=0n,totalGross=0n,totalTax=0n,totalNet=0n;
   for(const row of history){const amount=BigInt(row.gross),numerator=amount*taxBps+carry,assessed=numerator/bps;
    expect(BigInt(row.carry_before)).toBe(carry);expect(BigInt(row.tax)).toBe(assessed);expect(BigInt(row.net)).toBe(amount-assessed);
    carry=numerator%bps;expect(BigInt(row.carry_after)).toBe(carry);totalGross+=amount;totalTax+=assessed;totalNet+=amount-assessed;
   }
   expect(totalGross).toBe(initialUnits+concurrentUnits);expect(totalTax).toBe(totalGross*taxBps/bps);expect(carry).toBe(totalGross*taxBps%bps);
   expect(initial.amount+mined.amount).toBe(totalNet);expect(cached.amount).toBe(gross);expect(await balance('base_shards',f.base.id)).toBe(totalNet+gross);
   expect(await balance('shard_genesis')).toBe(genesisBefore-totalGross-gross);expect(await balance('shards_tax_escrow')).toBe(escrowBefore+totalTax);
   expect(await readCompleteShardsTaxPool(db,f.termId,f.termHash)).toBe(totalTax);
  }finally{release();await Promise.allSettled([holding,...(both?[both]:[])]);await other.sql.end();}
 });
 it('locks unfinished Mine parents before waiting and starts a newly finished clock only at its authoritative finish',async()=>{
  const f=await fixture(),probe=conn.reopen(),keepLevel=MINING.KEEP_MULT_BPS.length,mineLevel=MINING.MINE_MULT_BPS.length;
  const streakBefore=MINING.CONSISTENCY_STREAK_DAYS-1;
  // A high-level fixture makes an observable whole unit fit inside the real
  // finalized-observation freshness budget, without sleeps or a long clock gap.
  await db.update(bases).set({keepLevel}).where(eq(bases.id,f.base.id));await db.update(buildings).set({level:mineLevel}).where(eq(buildings.id,f.mine.id));
  await mineSources.admitPhysicalMineTaxSources(db,f.player.wallet,{idempotencyKey:randomUUID(),baseId:f.base.id},f.context,{clock:()=>f.start,reader:{readOperatingTerm:async()=>f.observation}});
  const oldQuota=BigInt(getMiningQuota(keepLevel,[mineLevel],streakBefore,MINING.EPOCH_RATE_BPS));
  const oneUnitMs=Number((BigInt(MINE_DAY_MS)+oldQuota-1n)/oldQuota),finishesAt=new Date(+f.start+MINE_DAY_MS);
  const requested=new Date(+finishesAt-oneUnitMs),accepted=new Date(+finishesAt+oneUnitMs);expect(+accepted-+requested).toBeLessThanOrEqual(PHASE_E_SEEKER_AUCTION.observationMaxAgeMs);
  const [future]=await db.insert(buildings).values({playerWallet:f.player.wallet,baseId:f.base.id,type:'mine',level:mineLevel,tx:2,ty:1}).returning();
  await db.insert(builderJobs).values({playerWallet:f.player.wallet,baseId:f.base.id,kind:'build',buildingId:future!.id,startedAt:f.start,finishesAt});
  await db.insert(baseStreaks).values({baseId:f.base.id,currentDays:streakBefore,cacheClaimedDay:f.start.toISOString().slice(0,10),lastActiveDate:f.start.toISOString().slice(0,10),everCompletedWeek1:false});
  let at=requested,crossed=false;const original=mineSources.lockPhysicalMineTaxActors;
  vi.spyOn(mineSources,'lockPhysicalMineTaxActors').mockImplementation(async(tx,wallets)=>{
   if(!crossed&&wallets.includes(f.player.wallet)){
    crossed=true;
    await expect(probe.sql`select id from bases where id=${f.base.id} for update nowait`).rejects.toMatchObject({code:'55P03'});
    for(const id of [f.mine.id,future!.id])await expect(probe.sql`select id from buildings where id=${id} for update nowait`).rejects.toMatchObject({code:'55P03'});
    await expect(probe.sql`select mine_building_id from mine_accrual_states where mine_building_id=${f.mine.id} for update nowait`).rejects.toMatchObject({code:'55P03'});
    expect(await tx.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId,future!.id))).toHaveLength(0);
    expect(await probe.sql`select mine_building_id from mine_accrual_states where mine_building_id=${future!.id}`).toHaveLength(0);
    at=accepted;
   }
   await original(tx,wallets);
  });
  try{
   const context={...source(f,requested),shardsCacheSource:{...source(f,requested).shardsCacheSource,clock:()=>at}};
   const result=await claimBaseDailyCache(db,f.player.wallet,context,requested);expect(crossed).toBe(true);
   expect(result.streakDays).toBe(MINING.CONSISTENCY_STREAK_DAYS);expect(result.everCompletedWeek1).toBe(result.streakDays>=DAILY_CACHE.consistencyStreakDays);
   expect(await rows(f)).toHaveLength(0);expect(await conn.sql`select id from ledger_transactions where idempotency_key=${key(f,accepted)}`).toHaveLength(1);
   const [state]=await db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId,future!.id));
   const earnedAfterFinish=oldQuota*BigInt(+accepted-+finishesAt)/BigInt(MINE_DAY_MS),earlyMint=oldQuota*BigInt(+accepted-+requested)/BigInt(MINE_DAY_MS);
   expect(earnedAfterFinish).toBeGreaterThan(0n);expect(earlyMint).toBeGreaterThan(earnedAfterFinish);
   expect(state!.accruedShards).toBe(earnedAfterFinish);expect(state!.lastAccrualAt.toISOString()).toBe(accepted.toISOString());
   // Claiming a cache does not implicitly admit this new Mine's earning source.
   expect(await conn.sql`select mine_id from shards_mine_eras where mine_id=${future!.id}`).toHaveLength(0);
  }finally{await probe.sql.end();}
 });
 it('preserves flag-off legacy cache gross when only a Mine era has been admitted',async()=>{
  const f=await fixture();expect(await conn.sql`select mine_id from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(1);expect(await rows(f)).toHaveLength(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const escrow=await balance('shards_tax_escrow'),genesis=await balance('shard_genesis');
  const result=await claimBaseDailyCache(db,f.player.wallet,f.context,f.start);
  expect(result).toEqual({amount:gross,streakDays:1,everCompletedWeek1:false});expect(await balance('base_shards',f.base.id)).toBe(gross);
  expect(await balance('shards_tax_escrow')).toBe(escrow);expect(await balance('shard_genesis')).toBe(genesis-gross);
  expect(await rows(f)).toHaveLength(0);expect(await conn.sql`select * from shards_tax_all_assessments where wallet=${f.player.wallet}`).toHaveLength(0);
 }); it('refuses stale direct tax issuance even with complete former source authority',async()=>{
  const f=await fixture();await expect(issueShardsCache(db,{baseId:f.base.id,wallet:f.player.wallet,earnedAt:f.start.toISOString(),day:f.start.toISOString().slice(0,10),streakDays:1,everCompletedWeek1Before:false,gross:gross.toString()},f.observation)).rejects.toMatchObject({code:'SOURCE_TAX_EXEMPT'});
  await assertUnclaimed(f);
 });

});
