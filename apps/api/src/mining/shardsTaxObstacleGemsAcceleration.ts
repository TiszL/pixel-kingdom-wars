/** Unmounted, timer-only Gems acceleration. The caller owns one outer
 * transaction: prepare before the real debit, apply after it, then commit.
 * Completion, custody and SHARDS issuance remain held by the source fences. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {speedupCostKeep} from '@shardkeep/shared';
import {BuilderJobSpeedupLookupSchema,type BuilderJobSpeedupProof} from '@shardkeep/shared/builderJobSpeedup';
import type {DbOrTx,DbTx} from '../db/client';
import {players,builderJobs,obstacles} from '../db/schema';
import {gemsEnabled,phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from '../game/stableBasePrerequisites';
import {getBuilderJobSpeedupReceipt} from '../game/builderJobSpeedupReceipt';
import {readStoredExpeditionTerm} from '../game/expeditionTermStore';
import {readShardsObstacleObligation,type ShardsObstacleObligation} from './shardsTaxObstacleObligations';
import {lockPhysicalMineTaxActors} from './shardsTaxMineSources';
import {SHARDS_TAX_LINEAGE} from './shardsTaxAttribution';

const command=BuilderJobSpeedupLookupSchema.extend({baseId:z.uuid().refine(v=>v===v.toLowerCase())}).strict();
type Command=z.infer<typeof command>;
type Paid=Extract<BuilderJobSpeedupProof,{status:'accepted'}>;
interface Facts {idempotencyKey:string;obligationId:string;jobId:string;baseId:string;obstacleId:string;wallet:string;
 kind:'gems';key:string;acceptedAt:string;beforeFinishAt:string;afterFinishAt:string;gemsAmount:string}
export type ShardsObstacleGemsAcceleration=Readonly<Facts&{evidenceSha256:string;earningWalletConfirmed:false;postingAuthorized:false}>;
function held(message:string):never{throw new HttpError(503,`Obstacle Gems acceleration held: ${message}`,'SHARDS_OBSTACLE_GEMS_UNAVAILABLE');}
function conflict():never{throw new HttpError(409,'Obstacle Gems acceleration conflicts with its original identity','SHARDS_OBSTACLE_GEMS_CONFLICT');}
function enabled(){if(!phaseEMiningEnabled()||!gemsEnabled())throw new HttpError(503,'Obstacle Gems acceleration is paused','PHASE_E_DISABLED');}
const instant=(date:Date)=>new Date(date.getTime()).toISOString();
const hash=(facts:Facts,obligation:ShardsObstacleObligation,proof:Paid)=>createHash('sha256')
 .update(JSON.stringify({version:1,kind:'obstacle_gems_acceleration',obligationHash:obligation.evidenceSha256,facts,proof})).digest('hex');
function paidFacts(obligation:ShardsObstacleObligation,proof:Paid):Facts{
 const {request,result,funding}=proof;
 if(proof.wallet!==obligation.wallet||request.baseId!==obligation.baseId||request.jobId!==obligation.jobId
 ||request.expectedCurrency!=='GEMS'||funding.currency!=='GEMS'||request.consent.kind!=='clear_obstacle'
 ||request.consent.obstacleId!==obligation.obstacleId||request.consent.buildingId!==null
 ||request.consent.startedAt!==obligation.startedAt||request.consent.finishesAt!==obligation.scheduledFinishAt
 ||result.completedAt<obligation.capturedAt||result.completedAt>=obligation.scheduledFinishAt)held('payment differs from original obligation');
 return {idempotencyKey:request.idempotencyKey,obligationId:obligation.idempotencyKey,jobId:obligation.jobId,baseId:obligation.baseId,
  obstacleId:obligation.obstacleId,wallet:obligation.wallet,kind:'gems',key:proof.receiptId,acceptedAt:result.completedAt,
  beforeFinishAt:obligation.scheduledFinishAt,afterFinishAt:result.completedAt,gemsAmount:funding.amount};
}
/** No current job, custody, flags or price are authority for a saved outcome. */
export async function readShardsObstacleGemsAcceleration(db:DbOrTx,wallet:string,key:string):Promise<ShardsObstacleGemsAcceleration|null>{
 BuilderJobSpeedupLookupSchema.shape.idempotencyKey.parse(key);
 const [row]=await db.execute<{obligation_id:string;ledger_id:string;idempotency_key:string;wallet:string;before_finish_at:string;
  after_finish_at:string;gems_amount:string;evidence_sha256:string;valid:boolean}>(sql`
  select a.obligation_id,a.ledger_id,a.wallet,a.idempotency_key,a.gems_amount::text,a.evidence_sha256,
   to_char(a.before_finish_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') before_finish_at,
   to_char(a.after_finish_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') after_finish_at,
   public.shardkeep_shards_obstacle_gems_valid(a,false) valid
  from shards_obstacle_gems_accelerations a where a.wallet=${wallet} and a.idempotency_key=${key}`);
 if(!row)return null;
 if(!row.valid)held('original INSERT witnesses are inconsistent');
 const obligation=await readShardsObstacleObligation(db,wallet,row.obligation_id);if(!obligation)held('original obligation missing');
 const proof=await getBuilderJobSpeedupReceipt(db,wallet,{jobId:obligation.jobId,baseId:obligation.baseId,idempotencyKey:key});
 if(proof.status!=='accepted')held('original payment missing');
 const facts=paidFacts(obligation,proof);
 if(facts.key!==row.ledger_id||facts.beforeFinishAt!==row.before_finish_at||facts.afterFinishAt!==row.after_finish_at
 ||facts.gemsAmount!==row.gems_amount||hash(facts,obligation,proof)!==row.evidence_sha256)held('original event is inconsistent');
 return Object.freeze({...facts,evidenceSha256:row.evidence_sha256,earningWalletConfirmed:false,postingAuthorized:false});
}
async function assertFloor(tx:DbTx,wallet:string,at:string){
 const [floor]=await tx.execute<{term_id:string;term_hash:string}>(sql`select term_id,term_hash from shards_tax_all_assessments
  where wallet=${wallet} and lineage=${SHARDS_TAX_LINEAGE} order by wallet_sequence desc limit 1`);
 if(floor){const term=await readStoredExpeditionTerm(tx,floor.term_id,floor.term_hash);
  if(!term||at<term.snapshot.startsAt)held('accelerated earning precedes committed term floor');}
}
export async function prepareShardsObstacleGemsAcceleration(tx:DbTx,wallet:string,value:Command,context:StableBaseMutationContext,
 deps:{clock?:()=>Date}={}):Promise<{status:'replay';receipt:ShardsObstacleGemsAcceleration}|{status:'prepared';apply:()=>Promise<ShardsObstacleGemsAcceleration>}>{
 const cmd=command.parse(value),clock=deps.clock??(()=>new Date());
 const matches=(receipt:ShardsObstacleGemsAcceleration)=>{if(receipt.baseId!==cmd.baseId||receipt.jobId!==cmd.jobId)conflict();return receipt;};
 const prior=await readShardsObstacleGemsAcceleration(tx,wallet,cmd.idempotencyKey);if(prior)return {status:'replay',receipt:matches(prior)};
 enabled();if(context.baseId!==cmd.baseId)conflict();
 const stable={baseId:cmd.baseId,assertAuthority:context.assertAuthority};
 const [transaction]=await tx.execute<{id:string;isolation:string}>(sql`select pg_current_xact_id()::text id,current_setting('transaction_isolation') isolation`);
 if(!transaction||transaction.isolation!=='read committed')held('READ COMMITTED outer transaction required');
 const [player]=await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,wallet)).for('update');
 if(!player)throw new HttpError(404,'player not found');
 const replay=await readShardsObstacleGemsAcceleration(tx,wallet,cmd.idempotencyKey);if(replay)return {status:'replay',receipt:matches(replay)};
 const base=await lockStablePrerequisiteBase(tx,wallet,stable);
 const [job]=await tx.select().from(builderJobs).where(and(eq(builderJobs.id,cmd.jobId),eq(builderJobs.baseId,cmd.baseId))).for('update');
 if(!job||job.kind!=='clear_obstacle'||!job.obstacleId||job.buildingId||job.playerWallet!==wallet||job.completedAt||job.cancelledAt)held('unfinished original obstacle job required');
 const [obstacle]=await tx.select().from(obstacles).where(and(eq(obstacles.id,job.obstacleId),eq(obstacles.baseId,cmd.baseId))).for('update');
 if(!obstacle||obstacle.playerWallet!==wallet||obstacle.clearedAt)held('original uncleared obstacle required');
 const [header]=await tx.execute<{id:string;exact:boolean}>(sql`select id,
  started_at=date_trunc('milliseconds',started_at) and scheduled_finish_at=date_trunc('milliseconds',scheduled_finish_at) exact
  from shards_obstacle_obligations where job_id=${cmd.jobId}`);
 if(!header||!header.exact)held('exact prospective schedule required');
 const obligation=await readShardsObstacleObligation(tx,wallet,header.id);if(!obligation)held('original wallet capture required');
 if(obligation.baseId!==cmd.baseId||obligation.obstacleId!==job.obstacleId||obligation.startedAt!==job.startedAt.toISOString()
 ||obligation.scheduledFinishAt!==job.finishesAt.toISOString()||obligation.deedAssetId!==base.deedAssetId)held('original custody or schedule changed');
 const [existing]=await tx.execute(sql`select obligation_id from shards_obstacle_gems_accelerations where obligation_id=${header.id}`);if(existing)conflict();
 // This unmounted operation never completes jobs or acquires Mine parents.
 // Every parent needed for its timer-only change is locked before the wallet.
 await lockPhysicalMineTaxActors(tx,[wallet]);
 await stable.assertAuthority(tx,wallet,cmd.baseId);enabled();
 const preparedAt=instant(clock());
 if(preparedAt<obligation.capturedAt||preparedAt>=obligation.scheduledFinishAt)held('unfinished captured schedule required');
 await assertFloor(tx,wallet,preparedAt);
 return {status:'prepared',apply:async()=>{
  const [current]=await tx.execute<{id:string}>(sql`select pg_current_xact_id()::text id`);
  if(current?.id!==transaction.id)held('prepared outer transaction ended');
  const applied=await readShardsObstacleGemsAcceleration(tx,wallet,cmd.idempotencyKey);if(applied)return matches(applied);
  const proof=await getBuilderJobSpeedupReceipt(tx,wallet,cmd);if(proof.status!=='accepted')held('new Gems debit required');
  const facts=paidFacts(obligation,proof),appliedAt=instant(clock());
  if(facts.acceptedAt<preparedAt||facts.acceptedAt>appliedAt)held('payment time outside prepared interval');
  const cost=BigInt(speedupCostKeep(Math.ceil((Date.parse(facts.beforeFinishAt)-Date.parse(facts.afterFinishAt))/1000)));
  if(BigInt(facts.gemsAmount)!==cost)held('payment differs from server quote');
  const [witness]=await tx.execute<{current:boolean}>(sql`select tx_key=${transaction.id} as current
   from shards_obstacle_gems_posts where ledger_id=${facts.key} and obligation_id=${obligation.idempotencyKey}`);
  if(!witness?.current)held('payment was not inserted in this transaction');
  await stable.assertAuthority(tx,wallet,cmd.baseId);enabled();await assertFloor(tx,wallet,facts.acceptedAt);
  await tx.execute(sql`insert into shards_obstacle_gems_accelerations(obligation_id,ledger_id,wallet,idempotency_key,before_finish_at,after_finish_at,gems_amount,evidence_sha256)
   values(${obligation.idempotencyKey},${facts.key},${wallet},${cmd.idempotencyKey},${facts.beforeFinishAt}::timestamptz,
   ${facts.afterFinishAt}::timestamptz,${facts.gemsAmount}::bigint,${hash(facts,obligation,proof)})`);
  const changed=await tx.execute(sql`update builder_jobs set finishes_at=${facts.afterFinishAt}::timestamptz
   where id=${cmd.jobId} and finishes_at=${facts.beforeFinishAt}::timestamptz and completed_at is null and cancelled_at is null returning id`);
  if(changed.length!==1)held('timer transition lost');
  enabled();const receipt=await readShardsObstacleGemsAcceleration(tx,wallet,cmd.idempotencyKey);
  if(!receipt)held('event was not retained');return receipt;
 }};
}
