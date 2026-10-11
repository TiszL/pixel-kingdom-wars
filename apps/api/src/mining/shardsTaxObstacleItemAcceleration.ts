/** Unmounted finish-item source. Own the new use, actual inventory decrement,
 * witnesses and timer in one transaction; completion/custody remain held. */
import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {ITEMS,type ItemId,type ItemSpec} from '@shardkeep/shared';
import {BuilderJobSpeedupLookupSchema} from '@shardkeep/shared/builderJobSpeedup';
import type {DbOrTx,DbTx} from '../db/client';
import {players,builderJobs,obstacles,baseItems,itemUses} from '../db/schema';
import {phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from '../game/stableBasePrerequisites';
import {readStoredExpeditionTerm} from '../game/expeditionTermStore';
import {readShardsObstacleObligation,type ShardsObstacleObligation} from './shardsTaxObstacleObligations';
import {lockPhysicalMineTaxActors} from './shardsTaxMineSources';
import {SHARDS_TAX_LINEAGE} from './shardsTaxAttribution';

const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const instant=z.string().length(24).datetime({precision:3}).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const key=BuilderJobSpeedupLookupSchema.shape.idempotencyKey;
const command=z.object({baseId:uuid,jobId:uuid,itemId:z.string().min(1).max(128),idempotencyKey:key}).strict();
const fields=z.object({idempotencyKey:key,obligationId:uuid,jobId:uuid,baseId:uuid,obstacleId:uuid,wallet:z.string().min(1),
 kind:z.literal('item'),key:uuid,acceptedAt:instant,beforeFinishAt:instant,afterFinishAt:instant,itemId:z.string().min(1).max(128),
 quantityBefore:z.number().int().positive(),quantityAfter:z.number().int().nonnegative(),consumed:z.literal(1),maxRemainingSec:z.number().int().positive()}).strict();
type Facts=z.infer<typeof fields>;
export type ShardsObstacleItemAcceleration=Readonly<Facts&{evidenceSha256:string;earningWalletConfirmed:false;postingAuthorized:false}>;
const hash=(facts:Facts,obligation:ShardsObstacleObligation,inventoryId:string)=>createHash('sha256')
 .update(JSON.stringify({version:1,kind:'obstacle_item_acceleration',obligationHash:obligation.evidenceSha256,inventoryId,facts:fields.parse(facts)})).digest('hex');
function held(message:string):never{throw new HttpError(503,`Obstacle item acceleration held: ${message}`,'SHARDS_OBSTACLE_ITEM_UNAVAILABLE');}
function conflict():never{throw new HttpError(409,'Obstacle item acceleration conflicts with its original identity','SHARDS_OBSTACLE_ITEM_CONFLICT');}
function enabled(){if(!phaseEMiningEnabled())throw new HttpError(503,'Obstacle item acceleration is paused','PHASE_E_DISABLED');}

/** Saved consumption survives later inventory grants/uses, catalogue tuning and
 * custody/flag changes. Immutable INSERT/decrement witnesses prove the old use. */
export async function readShardsObstacleItemAcceleration(db:DbOrTx,wallet:string,idempotencyKey:string):Promise<ShardsObstacleItemAcceleration|null>{
 key.parse(idempotencyKey);
 const [row]=await db.execute<{use_id:string;obligation_id:string;inventory_id:string;wallet:string;item_id:string;idempotency_key:string;
  before_finish_at:string;after_finish_at:string;quantity_before:number;quantity_after:number;max_remaining_sec:number;evidence_sha256:string;valid:boolean}>(sql`
  select a.use_id,a.obligation_id,a.inventory_id,a.wallet,a.item_id,a.idempotency_key,a.quantity_before,a.quantity_after,a.max_remaining_sec,a.evidence_sha256,
   to_char(a.before_finish_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') before_finish_at,
   to_char(a.after_finish_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') after_finish_at,
   public.shardkeep_shards_obstacle_item_valid(a,false) valid
  from shards_obstacle_item_accelerations a where a.wallet=${wallet} and a.idempotency_key=${idempotencyKey}`);
 if(!row)return null;if(!row.valid)held('original item-use or decrement witnesses are inconsistent');
 const obligation=await readShardsObstacleObligation(db,wallet,row.obligation_id);if(!obligation)held('original capture missing');
 const facts=fields.parse({idempotencyKey:row.idempotency_key,obligationId:row.obligation_id,jobId:obligation.jobId,baseId:obligation.baseId,
  obstacleId:obligation.obstacleId,wallet:row.wallet,kind:'item',key:row.use_id,acceptedAt:row.after_finish_at,beforeFinishAt:row.before_finish_at,
  afterFinishAt:row.after_finish_at,itemId:row.item_id,quantityBefore:row.quantity_before,quantityAfter:row.quantity_after,consumed:1,maxRemainingSec:row.max_remaining_sec});
 if(facts.beforeFinishAt!==obligation.scheduledFinishAt||facts.acceptedAt<obligation.capturedAt||facts.acceptedAt>=facts.beforeFinishAt
 ||facts.quantityBefore-facts.quantityAfter!==facts.consumed||hash(facts,obligation,row.inventory_id)!==row.evidence_sha256)held('original item event is inconsistent');
 return Object.freeze({...facts,evidenceSha256:row.evidence_sha256,earningWalletConfirmed:false,postingAuthorized:false});
}
async function assertFloor(tx:DbTx,wallet:string,at:string){
 const [floor]=await tx.execute<{term_id:string;term_hash:string}>(sql`select term_id,term_hash from shards_tax_all_assessments
  where wallet=${wallet} and lineage=${SHARDS_TAX_LINEAGE} order by wallet_sequence desc limit 1`);
 if(floor){const term=await readStoredExpeditionTerm(tx,floor.term_id,floor.term_hash);
  if(!term||at<term.snapshot.startsAt)held('accelerated earning precedes committed term floor');}
}
export async function accelerateShardsObstacleWithItem(db:DbOrTx,wallet:string,value:unknown,context:StableBaseMutationContext,
 deps:{clock?:()=>Date}={}):Promise<ShardsObstacleItemAcceleration>{
 const cmd=command.parse(value),clock=deps.clock??(()=>new Date());
 const matches=(receipt:ShardsObstacleItemAcceleration)=>{if(receipt.baseId!==cmd.baseId||receipt.jobId!==cmd.jobId||receipt.itemId!==cmd.itemId)conflict();return receipt;};
 const prior=await readShardsObstacleItemAcceleration(db,wallet,cmd.idempotencyKey);if(prior)return matches(prior);
 enabled();if(context.baseId!==cmd.baseId)conflict();
 const stable={baseId:cmd.baseId,assertAuthority:context.assertAuthority};
 return db.transaction(async tx=>{
  const [transaction]=await tx.execute<{id:string;isolation:string}>(sql`select pg_current_xact_id()::text id,current_setting('transaction_isolation') isolation`);
  if(!transaction||transaction.isolation!=='read committed')held('READ COMMITTED outer transaction required');
  const [player]=await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,wallet)).for('update');
  if(!player)throw new HttpError(404,'player not found');
  const existing=await readShardsObstacleItemAcceleration(tx,wallet,cmd.idempotencyKey);if(existing)return matches(existing);
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
  const events=await tx.execute(sql`select obligation_id from shards_obstacle_gems_accelerations where obligation_id=${header.id}
   union all select obligation_id from shards_obstacle_item_accelerations where obligation_id=${header.id}`);
  if(events.length)conflict();
  // Every local source row, including the consumable stack, precedes tax carry.
  // Later inventory/activity triggers remain part of this same transaction.
  const [inventory]=await tx.select().from(baseItems).where(and(eq(baseItems.baseId,cmd.baseId),eq(baseItems.itemId,cmd.itemId))).for('update');
  if(!inventory||inventory.qty<=0)held('owned item required');
  await lockPhysicalMineTaxActors(tx,[wallet]);
  await stable.assertAuthority(tx,wallet,cmd.baseId);enabled();
  const acceptedAt=instant.parse(new Date(clock().getTime()).toISOString());
  if(acceptedAt<obligation.capturedAt||acceptedAt>=obligation.scheduledFinishAt)held('unfinished captured schedule required');
  // Catalogue is consulted only for a NEW consumption. Saved receipts retain
  // their admitted bound even when today's catalogue later changes.
  const definition:ItemSpec|undefined=Object.hasOwn(ITEMS,cmd.itemId)?ITEMS[cmd.itemId as ItemId]:undefined;
  const effect=definition?.effect;
  if(effect?.type!=='finish_job')held('finish item required');
  const remaining=Math.ceil((Date.parse(obligation.scheduledFinishAt)-Date.parse(acceptedAt))/1000);
  if(remaining<=0||remaining>effect.maxRemainingSec)held('item cannot finish the original remaining schedule');
  await assertFloor(tx,wallet,acceptedAt);
  const useId=randomUUID(),facts=fields.parse({idempotencyKey:cmd.idempotencyKey,obligationId:obligation.idempotencyKey,jobId:cmd.jobId,baseId:cmd.baseId,
   obstacleId:obligation.obstacleId,wallet,kind:'item',key:useId,acceptedAt,beforeFinishAt:obligation.scheduledFinishAt,afterFinishAt:acceptedAt,
   itemId:cmd.itemId,quantityBefore:inventory.qty,quantityAfter:inventory.qty-1,consumed:1,maxRemainingSec:effect.maxRemainingSec});
  await tx.execute(sql`insert into shards_obstacle_item_accelerations(use_id,obligation_id,wallet,item_id,idempotency_key,inventory_id,
   before_finish_at,after_finish_at,quantity_before,quantity_after,max_remaining_sec,tx_key,evidence_sha256)
   values(${useId},${obligation.idempotencyKey},${wallet},${cmd.itemId},${cmd.idempotencyKey},${inventory.id},
   ${facts.beforeFinishAt}::timestamptz,${acceptedAt}::timestamptz,${facts.quantityBefore},${facts.quantityAfter},${facts.maxRemainingSec},
   ${transaction.id},${hash(facts,obligation,inventory.id)})`);
  await tx.insert(itemUses).values({id:useId,playerWallet:wallet,itemId:cmd.itemId,idempotencyKey:`use:${wallet}:${cmd.baseId}:${cmd.idempotencyKey}`,usedAt:new Date(acceptedAt)});
  const took=await tx.update(baseItems).set({qty:inventory.qty-1}).where(and(eq(baseItems.id,inventory.id),eq(baseItems.qty,inventory.qty))).returning({id:baseItems.id});
  if(took.length!==1)held('inventory transition lost');
  await stable.assertAuthority(tx,wallet,cmd.baseId);enabled();await assertFloor(tx,wallet,acceptedAt);
  const changed=await tx.execute(sql`update builder_jobs set finishes_at=${acceptedAt}::timestamptz
   where id=${cmd.jobId} and finishes_at=${facts.beforeFinishAt}::timestamptz and completed_at is null and cancelled_at is null returning id`);
  if(changed.length!==1)held('timer transition lost');
  const receipt=await readShardsObstacleItemAcceleration(tx,wallet,cmd.idempotencyKey);
  if(!receipt)held('event was not retained');enabled();return receipt;
 });
}
