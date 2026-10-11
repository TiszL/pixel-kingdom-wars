/** TEST ONLY: frozen pre-D153.196 cache admission. Historical SQL/replay and
 * payout tests need genuine old net/tax postings after new rewards are exempt.
 * No runtime module imports this fixture; no trigger or source guard is disabled. */
/** Daily-cache earning is accepted once under the original base/streak locks.
 * Finalized provider reads finish before transaction entry. Historical evidence
 * freezes the accepted gross; later tuning never reprices an old cache receipt. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {PHASE_E_SEEKER_AUCTION,PHASE_E_HARVESTER} from '@shardkeep/shared';
import type {DbOrTx} from '../../src/db/client';
import {phaseEMiningEnabled} from '../../src/config';
import {HttpError} from '../../src/lib/errors';
import {hashExpeditionTermSnapshot,parseExpeditionTermObservation,type ExpeditionTermReader,type ExpeditionTermObservation} from '../../src/game/expeditionTerms';
import {pinObservedOperatingExpeditionTerm} from '../../src/game/expeditionTermStore';
import {bootstrapSystemAccounts,getOrCreateBaseAccount,postTransaction} from '../../src/ledger';
import {replayShardsTaxAttribution,SHARDS_TAX_LINEAGE} from '../../src/mining/shardsTaxAttribution';
import {assertMineTaxTermPrefix} from '../../src/mining/shardsTaxMineOrder';

export interface ShardsCacheSourceDependencies {prefetch:()=>Promise<ExpeditionTermReader>;clock?:()=>Date}
export interface PreparedShardsCacheSource {readonly observation:ExpeditionTermObservation;readonly clock:()=>Date}
const need=(v:unknown,message:string):void=>{if(!v)throw new HttpError(503,`SHARDS cache source held: ${message}`,'SHARDS_SOURCE_UNAVAILABLE');};
export function assertShardsCacheEnabled(){if(!phaseEMiningEnabled())throw new HttpError(503,'SHARDS cache earning is paused','PHASE_E_DISABLED');}
export async function hasShardsCacheSource(db:DbOrTx,baseId:string){const [r]=await db.execute(sql`select operation_key from shards_cache_sources where base_id=${baseId} limit 1`);return !!r;}
export async function prepareShardsCacheSource(db:DbOrTx,baseId:string,deps?:ShardsCacheSourceDependencies):Promise<PreparedShardsCacheSource|null>{
 if(!phaseEMiningEnabled()){need(!await hasShardsCacheSource(db,baseId),'admitted earning is paused');return null;}
 need(deps,'finalized term provider required');const clock=deps!.clock??(()=>new Date());
 const reader=await deps!.prefetch(),at=new Date(clock().getTime()).toISOString(),raw=await reader.readOperatingTerm(at);
 need(raw,'finalized term required');const observation=parseExpeditionTermObservation(raw,at);
 return Object.freeze({observation,clock});
}
/** Pin the copied term before taking wallet carry locks. Call final validation
 * after every base/Mine/wallet lock, with a new clock sample. No RPC runs here. */
export async function pinShardsCacheSource(tx:DbOrTx,baseId:string,prepared:PreparedShardsCacheSource|null){
 if(!prepared){need(!phaseEMiningEnabled()&&!await hasShardsCacheSource(tx,baseId),'source admission required');return;}
 assertShardsCacheEnabled();const at=new Date(prepared.clock().getTime());
 validateShardsCacheSource(prepared,at);
 await pinObservedOperatingExpeditionTerm(tx,at,{readOperatingTerm:async()=>prepared.observation});
}
export function validateShardsCacheSource(prepared:PreparedShardsCacheSource,at:Date){
 assertShardsCacheEnabled();const observation=parseExpeditionTermObservation(prepared.observation,at.toISOString());
 need(+at-Date.parse(observation.finality.observedAt)<=PHASE_E_SEEKER_AUCTION.observationMaxAgeMs,'stale finalized term');return observation;
}
export interface ShardsCacheEarning {baseId:string;wallet:string;earnedAt:string;day:string;streakDays:number;everCompletedWeek1Before:boolean;gross:string}
export const shardsCacheSourceHash=(earning:ShardsCacheEarning)=>createHash('sha256').update(JSON.stringify(earning)).digest('hex');
export function shardsCacheSource(earning:ShardsCacheEarning,ledgerId:string){
 const key=`cache.claim:${earning.baseId}:${earning.day}`;
 return {version:1,kind:'daily_cache',key,wallet:earning.wallet,baseId:earning.baseId,gross:BigInt(earning.gross),earning:{kind:'instant',at:earning.earnedAt},
  authority:{classification:'new_earning',decisionRef:'daily-cache-source-v1',evidenceSha256:shardsCacheSourceHash(earning)},ledger:{transactionId:ledgerId,idempotencyKey:key}};
}
/** Caller holds base/streak/Mine locks followed by original-wallet carry lock. */
export async function issueHistoricalShardsCache(tx:DbOrTx,earning:ShardsCacheEarning,observation:ExpeditionTermObservation){
 assertShardsCacheEnabled();const source=shardsCacheSource(earning,randomUUID());
 const termHash=hashExpeditionTermSnapshot(observation.snapshot);
 await assertMineTaxTermPrefix(tx,earning.wallet,observation.snapshot.termId,termHash,new Map(),new Map());
 const [prior]=await tx.execute<{wallet_sequence:string;carry_after:string}>(sql`select wallet_sequence::text,carry_after::text from shards_tax_all_assessments where wallet=${earning.wallet} and lineage=${SHARDS_TAX_LINEAGE} order by wallet_sequence desc limit 1`);
 const evaluated=historicalAttribution({source,term:observation,carry:{wallet:earning.wallet,currency:'SHARDS',lineage:SHARDS_TAX_LINEAGE,sequence:prior?BigInt(prior.wallet_sequence):0n,value:prior?BigInt(prior.carry_after):0n}});
 need(evaluated.status==='attributed','original attribution');if(evaluated.status!=='attributed')throw Error('unavailable original attribution');
 const plan=evaluated.receipt,systems=await bootstrapSystemAccounts(tx),base=await getOrCreateBaseAccount(tx,earning.baseId,'base_shards');
 const posted=await postTransaction(tx,{idempotencyKey:source.key,type:'cache.claim',entries:[{account:systems.shard_genesis,delta:-source.gross},
  ...(plan.net?[{account:base.id,delta:plan.net}]:[]),...(plan.tax?[{account:systems.shards_tax_escrow,delta:plan.tax}]:[])],
  metadata:{baseId:earning.baseId,day:earning.day,streakDays:earning.streakDays}});
 need(!posted.duplicate,'unattributed old ledger posting');
 const receipt={...plan,source:{...plan.source,ledger:{transactionId:posted.transaction.id,idempotencyKey:source.key}}};
 replayShardsTaxAttribution(receipt,shardsCacheSource(earning,posted.transaction.id));
 const json=JSON.stringify(receipt,(_key,v)=>typeof v==='bigint'?v.toString():v);
 await tx.execute(sql`insert into shards_cache_sources(operation_key,base_id,wallet,earned_at,day,streak_days,ever_completed_week1_before,gross,term_id,term_hash,observation,ledger_id) values(${source.key},${earning.baseId},${earning.wallet},${earning.earnedAt},${earning.day},${earning.streakDays},${earning.everCompletedWeek1Before},${earning.gross},${observation.snapshot.termId},${termHash},${JSON.stringify(observation)}::jsonb,${posted.transaction.id})`);
 await tx.execute(sql`insert into shards_cache_assessments(operation_key,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,term_id,term_hash,ledger_id,receipt) values(${source.key},${earning.wallet},${receipt.carryAfter.sequence.toString()},${SHARDS_TAX_LINEAGE},${earning.gross},${receipt.net.toString()},${receipt.tax.toString()},${receipt.carryBefore.value.toString()},${receipt.carryAfter.value.toString()},${observation.snapshot.termId},${termHash},${posted.transaction.id},${json}::jsonb)`);
 assertShardsCacheEnabled();return receipt.net;
}

function historicalAttribution(input:{source:ReturnType<typeof shardsCacheSource>;term:ExpeditionTermObservation;carry:{wallet:string;currency:string;lineage:string;sequence:bigint;value:bigint}}){
 const {source,term,carry}=input,v1=PHASE_E_HARVESTER.v1;
 const termHash=hashExpeditionTermSnapshot(term.snapshot),winnerCount=term.snapshot.spots.filter(s=>s.ownerWallet!==null).length;
 const numerator=source.gross*BigInt(v1.islandPoolBps)+carry.value,tax=numerator/BigInt(v1.taxBasisPoints);
 const receipt={version:1,source,term,termHash,policy:{lineage:SHARDS_TAX_LINEAGE,version:v1.taxPolicyVersion,basisPoints:v1.taxBasisPoints,islandPoolBps:v1.islandPoolBps},
  carryBefore:carry,carryAfter:{...carry,sequence:carry.sequence+1n,value:numerator%BigInt(v1.taxBasisPoints)},net:source.gross-tax,tax,
  pool:{termId:term.snapshot.termId,termHash,winnerCount,amount:tax,disposition:winnerCount?'original_winning_spots':'held_zero_winners'},sourceVerified:false,postingAuthorized:false,payoutAuthorized:false};
 return {status:'attributed' as const,receipt:replayShardsTaxAttribution(receipt,source)};
}

import {and,eq,inArray} from 'drizzle-orm';
import {DAILY_CACHE} from '@shardkeep/shared';
import type {Db} from '../../src/db/client';
import {players,baseStreaks,buildings,mineAccrualStates} from '../../src/db/schema';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from '../../src/game/stableBasePrerequisites';
import {lockPhysicalMineTaxActors} from '../../src/mining/shardsTaxMineSources';
/** Seed the original first-day cache through its former lock/source/ledger path. */
export async function seedHistoricalTaxedCache(db:Db,wallet:string,context:StableBaseMutationContext,now=new Date()){
 const prepared=await prepareShardsCacheSource(db,context.baseId,context.shardsCacheSource);
 if(!prepared)throw Error('Historical taxed-cache fixture requires original term');
 return db.transaction(async tx=>{
  const [player]=await tx.select().from(players).where(eq(players.wallet,wallet)).for('update');if(!player)throw Error('Missing historical player');
  await lockStablePrerequisiteBase(tx,wallet,context);
  await tx.insert(baseStreaks).values({baseId:context.baseId}).onConflictDoNothing();
  const [streak]=await tx.select().from(baseStreaks).where(eq(baseStreaks.baseId,context.baseId)).for('update');
  if(!streak||streak.cacheClaimedDay!==null)throw Error('Historical fixture only seeds an unclaimed first day');
  await pinShardsCacheSource(tx,context.baseId,prepared);
  const mines=await tx.select({id:buildings.id}).from(buildings).where(and(eq(buildings.baseId,context.baseId),eq(buildings.type,'mine'))).orderBy(buildings.id).for('update');
  if(mines.length)await tx.select().from(mineAccrualStates).where(inArray(mineAccrualStates.mineBuildingId,mines.map(m=>m.id))).orderBy(mineAccrualStates.mineBuildingId).for('update');
  await lockPhysicalMineTaxActors(tx,[wallet]);await context.assertAuthority(tx,wallet,context.baseId);
  now=new Date(prepared.clock().getTime());validateShardsCacheSource(prepared,now);const day=now.toISOString().slice(0,10);
  await tx.update(baseStreaks).set({currentDays:1,lastActiveDate:day,cacheClaimedDay:day,everCompletedWeek1:false}).where(eq(baseStreaks.baseId,context.baseId));
  const amount=await issueHistoricalShardsCache(tx,{baseId:context.baseId,wallet,earnedAt:now.toISOString(),day,streakDays:1,everCompletedWeek1Before:false,gross:String(DAILY_CACHE.firstWeekStepShards)},prepared.observation);
  return {amount,streakDays:1,everCompletedWeek1:false};
 });
}
