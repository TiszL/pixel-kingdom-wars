/** Shared locked obstacle source inspection only; each custody adapter must
 * independently prove its original deeded or registered-free custody class. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DbTx} from '../db/client';
import {players,bases,baseSlots,baseRaidLocks,builderJobs,obstacles} from '../db/schema';
import {HttpError} from '../lib/errors';
import {readShardsObstacleObligation,type ShardsObstacleObligation} from './shardsTaxObstacleObligations';
import {readShardsObstacleGemsAcceleration,type ShardsObstacleGemsAcceleration} from './shardsTaxObstacleGemsAcceleration';
import {readShardsObstacleItemAcceleration,type ShardsObstacleItemAcceleration} from './shardsTaxObstacleItemAcceleration';
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function held(message:string):never{throw new HttpError(503,`Obstacle custody held: ${message}`,'SHARDS_OBSTACLE_CUSTODY_UNAVAILABLE');}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export interface ShardsObstacleSource{
 readonly obligation:ShardsObstacleObligation;
 readonly accelerations:readonly (ShardsObstacleGemsAcceleration|ShardsObstacleItemAcceleration)[];
 readonly earnedAt:string;readonly fingerprint:string;
}

/** No provider callbacks, flags, carry or ledger locks. This is source inspection,
 * not current mutation admission. Local custody remains continuously fenced by
 * the prospective obligation's existing immutable-parent transition guards. */
export async function readLockedShardsObstacleSource(tx:DbTx,id:string):Promise<ShardsObstacleSource>{
 const [mode]=await tx.execute<{isolation:string}>(sql`select current_setting('transaction_isolation') isolation`);
 if(mode?.isolation!=='read committed')held('READ COMMITTED source inspection required');
 const [identity]=await tx.execute<{wallet:string;base_id:string;job_id:string;obstacle_id:string}>(sql`
  select wallet,base_id,job_id,obstacle_id from shards_obstacle_obligations where id=${id}`);
 if(!identity)held('original capture missing');
 const [player]=await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,identity.wallet)).for('update');
 if(!player)held('original player missing');
 const [base]=await tx.select({id:bases.id,ownerWallet:bases.ownerWallet,status:bases.status,deedAssetId:bases.deedAssetId})
  .from(bases).where(eq(bases.id,identity.base_id)).for('update');
 if(!base||base.ownerWallet!==identity.wallet||base.status!=='active')held('registered custody changed');
 const slots=await tx.select({wallet:baseSlots.wallet,slot:baseSlots.slot,baseId:baseSlots.baseId,active:baseSlots.active})
  .from(baseSlots).where(eq(baseSlots.baseId,base.id)).for('update');
 if(slots.length!==1||slots[0]!.wallet!==identity.wallet||!slots[0]!.active)held('original active slot unavailable');
 // Preserve the established local lock order. A current raid is not evidence
 // about historical ownership and grants no mutation permission here.
 await tx.select({raidId:baseRaidLocks.raidId}).from(baseRaidLocks).where(eq(baseRaidLocks.baseId,base.id)).for('update');
 const [job]=await tx.select().from(builderJobs).where(and(eq(builderJobs.id,identity.job_id),eq(builderJobs.baseId,base.id))).for('update');
 if(!job||job.playerWallet!==identity.wallet||job.kind!=='clear_obstacle'||job.buildingId!==null
  ||job.obstacleId!==identity.obstacle_id||job.completedAt||job.cancelledAt)held('unfinished original job unavailable');
 const [obstacle]=await tx.select().from(obstacles).where(and(eq(obstacles.id,identity.obstacle_id),eq(obstacles.baseId,base.id))).for('update');
 if(!obstacle||obstacle.playerWallet!==identity.wallet||obstacle.clearedAt)held('original uncleared obstacle unavailable');
 const [precision]=await tx.execute<{exact:boolean}>(sql`select
  h.captured_at=date_trunc('milliseconds',h.captured_at) and h.started_at=date_trunc('milliseconds',h.started_at)
  and h.scheduled_finish_at=date_trunc('milliseconds',h.scheduled_finish_at)
  and j.started_at=date_trunc('milliseconds',j.started_at) and j.finishes_at=date_trunc('milliseconds',j.finishes_at) exact
  from shards_obstacle_obligations h join builder_jobs j on j.id=h.job_id where h.id=${id}`);
 if(!precision?.exact)held('exact captured schedule required');
 const obligation=await readShardsObstacleObligation(tx,identity.wallet,id);
 if(!obligation||obligation.baseId!==base.id||obligation.jobId!==job.id||obligation.obstacleId!==obstacle.id
  ||obligation.deedAssetId!==base.deedAssetId||obligation.startedAt!==job.startedAt.toISOString())held('original capture differs from parents');
 if(!key.safeParse(obligation.wallet).success||obligation.deedAssetId!==null&&!key.safeParse(obligation.deedAssetId).success)held('canonical original custody required');
 const events=await tx.execute<{kind:'gems'|'item';idempotency_key:string}>(sql`
  select 'gems' kind,idempotency_key from shards_obstacle_gems_accelerations where obligation_id=${id}
  union all select 'item' kind,idempotency_key from shards_obstacle_item_accelerations where obligation_id=${id}`);
 if(events.length>1)held('ambiguous original acceleration');
 const accelerations:(ShardsObstacleGemsAcceleration|ShardsObstacleItemAcceleration)[]=[];
 if(events[0]){
  const event=events[0],receipt=event.kind==='gems'
   ?await readShardsObstacleGemsAcceleration(tx,obligation.wallet,event.idempotency_key)
   :await readShardsObstacleItemAcceleration(tx,obligation.wallet,event.idempotency_key);
  if(!receipt||receipt.obligationId!==id)held('original acceleration missing');accelerations.push(receipt);
 }
 const earnedAt=accelerations[0]?.afterFinishAt??obligation.scheduledFinishAt;
 if(earnedAt!==job.finishesAt.toISOString()||obligation.capturedAt>=earnedAt)held('effective earning schedule unresolved');
 const parents={base,slots,job:{id:job.id,playerWallet:job.playerWallet,baseId:job.baseId,kind:job.kind,buildingId:job.buildingId,
  obstacleId:job.obstacleId,startedAt:job.startedAt.toISOString(),finishesAt:job.finishesAt.toISOString(),completedAt:null,cancelledAt:null},
  obstacle:{id:obstacle.id,playerWallet:obstacle.playerWallet,baseId:obstacle.baseId,spriteKey:obstacle.spriteKey,tx:obstacle.tx,ty:obstacle.ty,clearedAt:null}};
 return freeze({obligation,accelerations,earnedAt,fingerprint:hash({obligation,accelerations,parents})});
}

