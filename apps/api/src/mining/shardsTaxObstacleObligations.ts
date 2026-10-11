/** Prospective obstacle capture only. No route/job caller admits these records
 * yet: enrolled transitions remain fenced until their ordered journal exists.
 * Captured wallet is a pending-order participant, never proof of the earner. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {OBSTACLES} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import type {DbOrTx} from '../db/client';
import {players,builderJobs,obstacles} from '../db/schema';
import {phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from '../game/stableBasePrerequisites';
import {readStoredExpeditionTerm} from '../game/expeditionTermStore';
import {lockPhysicalMineTaxActors} from './shardsTaxMineSources';
import {SHARDS_TAX_LINEAGE} from './shardsTaxAttribution';
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const instant=z.string().length(24).datetime({precision:3}).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const command=z.object({idempotencyKey:uuid,baseId:uuid,jobId:uuid}).strict();
const fields=z.object({idempotencyKey:uuid,jobId:uuid,baseId:uuid,obstacleId:uuid,wallet:z.string().min(1),deedAssetId:z.string().nullable(),
 capturedAt:instant,startedAt:instant,scheduledFinishAt:instant,gross:z.string().regex(/^[1-9][0-9]*$/).refine(v=>BigInt(v)<=RAW_RESOURCE_STORAGE_MAX)}).strict();
type Facts=z.infer<typeof fields>;
export type ShardsObstacleObligation=Readonly<Facts&{evidenceSha256:string;earningWalletConfirmed:false;postingAuthorized:false}>;
const fingerprint=(facts:Facts)=>createHash('sha256').update(JSON.stringify({version:1,kind:'obstacle_obligation',...fields.parse(facts)})).digest('hex');
function unavailable(message:string):never{throw new HttpError(503,`Obstacle source held: ${message}`,'SHARDS_OBSTACLE_UNAVAILABLE');}
function conflict():never{throw new HttpError(409,'Obstacle capture conflicts with its original identity','SHARDS_OBSTACLE_CONFLICT');}
const enabled=()=>{if(!phaseEMiningEnabled())throw new HttpError(503,'Obstacle source capture is paused','PHASE_E_DISABLED');};
/** Historical capture recovery is independent of current custody/flags/jobs.
 * Its hash checks integrity, not chain provenance or a future earning wallet. */
export async function readShardsObstacleObligation(db:DbOrTx,wallet:string,key:string):Promise<ShardsObstacleObligation|null>{
 uuid.parse(key);
 const [row]=await db.execute<{id:string;job_id:string;base_id:string;obstacle_id:string;wallet:string;deed_asset_id:string|null;captured_at:string;started_at:string;scheduled_finish_at:string;gross:string;evidence_sha256:string}>(sql`
  select id,job_id,base_id,obstacle_id,wallet,deed_asset_id,
   to_char(captured_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') captured_at,
   to_char(started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') started_at,
   to_char(scheduled_finish_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') scheduled_finish_at,
   gross::text,evidence_sha256 from shards_obstacle_obligations where id=${key}`);
 if(!row||row.wallet!==wallet)return null;
 const facts=fields.parse({idempotencyKey:row.id,jobId:row.job_id,baseId:row.base_id,obstacleId:row.obstacle_id,wallet:row.wallet,deedAssetId:row.deed_asset_id,
  capturedAt:row.captured_at,startedAt:row.started_at,scheduledFinishAt:row.scheduled_finish_at,gross:row.gross});
 if(facts.startedAt>facts.capturedAt||facts.capturedAt>=facts.scheduledFinishAt||fingerprint(facts)!==row.evidence_sha256)unavailable('original capture is inconsistent');
 return Object.freeze({...facts,evidenceSha256:row.evidence_sha256,earningWalletConfirmed:false,postingAuthorized:false});
}
/** Ordinary committed reads only. Both assessment-table guards call this same
 * invoker predicate after their wallet mutex, so direct inserts cannot bypass it. */
export async function assertShardsObstacleTermPrefix(db:DbOrTx,wallet:string,termStart:string):Promise<void>{
 instant.parse(termStart);
 const [row]=await db.execute<{held:boolean}>(sql`select public.shardkeep_shards_obstacle_pending(${wallet},${termStart}::timestamptz) held`);
 if(!row||row.held)throw new HttpError(503,'SHARDS tax held for pending obstacle evidence','SHARDS_TAX_ORDER_HELD');
}
export async function admitShardsObstacleObligation(db:DbOrTx,wallet:string,value:unknown,context:StableBaseMutationContext,deps:{clock?:()=>Date}={}):Promise<ShardsObstacleObligation>{
 const cmd=command.parse(value),clock=deps.clock??(()=>new Date());
 const matches=(prior:ShardsObstacleObligation)=>{if(prior.baseId!==cmd.baseId||prior.jobId!==cmd.jobId)conflict();return prior;};
 const prior=await readShardsObstacleObligation(db,wallet,cmd.idempotencyKey);if(prior)return matches(prior);
 enabled();if(context.baseId!==cmd.baseId)conflict();
 return db.transaction(async tx=>{
  const [player]=await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,wallet)).for('update');
  if(!player)throw new HttpError(404,'player not found');
  const existing=await readShardsObstacleObligation(tx,wallet,cmd.idempotencyKey);if(existing)return matches(existing);
  const base=await lockStablePrerequisiteBase(tx,wallet,context);
  const [job]=await tx.select().from(builderJobs).where(and(eq(builderJobs.id,cmd.jobId),eq(builderJobs.baseId,cmd.baseId))).for('update');
  if(!job||job.kind!=='clear_obstacle'||!job.obstacleId||job.completedAt||job.cancelledAt)unavailable('unfinished obstacle job required');
  const [obstacle]=await tx.select().from(obstacles).where(and(eq(obstacles.id,job.obstacleId),eq(obstacles.baseId,cmd.baseId))).for('update');
  if(!obstacle||obstacle.clearedAt)unavailable('uncleared original obstacle required');
  // Lock all required parents before this boundary and ledger/accounts after it.
  // This standalone service starts unlocked and takes no foreign parent locks.
  await lockPhysicalMineTaxActors(tx,[wallet]);
  await context.assertAuthority(tx,wallet,cmd.baseId);enabled();
  const capturedAt=instant.parse(new Date(clock().getTime()).toISOString());
  if(+job.startedAt>Date.parse(capturedAt)||+job.finishesAt<=Date.parse(capturedAt))unavailable('capture must precede earning');
  const [duplicate]=await tx.execute(sql`select id from shards_obstacle_obligations where job_id=${job.id}`);if(duplicate)conflict();
  const [floor]=await tx.execute<{term_id:string;term_hash:string}>(sql`select term_id,term_hash from shards_tax_all_assessments where wallet=${wallet} and lineage=${SHARDS_TAX_LINEAGE} order by wallet_sequence desc limit 1`);
  if(floor){const term=await readStoredExpeditionTerm(tx,floor.term_id,floor.term_hash);if(!term||+job.finishesAt<Date.parse(term.snapshot.startsAt))unavailable('earning precedes committed term floor');}
  const facts=fields.parse({idempotencyKey:cmd.idempotencyKey,jobId:job.id,baseId:cmd.baseId,obstacleId:obstacle.id,wallet,deedAssetId:base.deedAssetId,
   capturedAt,startedAt:job.startedAt.toISOString(),scheduledFinishAt:job.finishesAt.toISOString(),gross:String(OBSTACLES.clearRewardShards)});
  // Copy original SQL timestamps, including sub-millisecond precision. The
  // portable receipt/hash has the established canonical UTC millisecond grammar.
  const inserted=await tx.execute(sql`insert into shards_obstacle_obligations(id,job_id,base_id,obstacle_id,wallet,deed_asset_id,captured_at,started_at,scheduled_finish_at,gross,evidence_sha256)
   select ${cmd.idempotencyKey},j.id,j.base_id,j.obstacle_id,${wallet},${base.deedAssetId},${capturedAt}::timestamptz,j.started_at,j.finishes_at,${facts.gross}::bigint,${fingerprint(facts)}
   from builder_jobs j where j.id=${job.id} on conflict do nothing returning id`);
  if(!inserted.length)conflict();
  const result=await readShardsObstacleObligation(tx,wallet,cmd.idempotencyKey);if(!result)unavailable('capture not retained');
  enabled();return result;
 });
}
