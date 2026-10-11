/** Measured free-wallet inputs only: no scores, awards or inventory effects. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { collectMiningActivityEvidence } from './activityEvidence';
import { readFreeCohortInterval } from './freeCohort';

const policyVersion='free-shadow-v1' as const, MAX_SOURCES=1_000;
const unavailable=['scoring','progression','source-attribution','funding'] as const;
const timestamp=z.string().datetime(), uuid=z.string().uuid(), count=z.number().int().nonnegative().safe();
const wallet=z.string().min(32).max(44).refine(value=>{try{return new PublicKey(value).toBase58()===value;}catch{return false;}});
const inputSchema=z.object({wallet,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(policyVersion)}).strict();
const enrollmentSchema=z.object({wallet,baseId:uuid,enrolledAt:timestamp,effectiveFrom:timestamp,baseline:z.record(z.string(),z.unknown())}).strict();
const cohortSchema=z.object({wallet,baseId:uuid,day:z.string(),enrollment:enrollmentSchema,observedAt:timestamp,valid:z.boolean(),
  reason:z.enum(['valid','not-effective','invalidated']),events:z.array(z.object({id:z.string().regex(/^\d+$/),observedAt:timestamp,
    sourceTable:z.string(),sourceId:z.string(),operation:z.string(),beforeState:z.unknown(),afterState:z.unknown()}).strict()).max(10_000)}).strict();
const reservationSchema=z.object({id:uuid,epochId:uuid,epochKey:z.string(),baseId:uuid,actorWallet:wallet,idempotencyKey:z.string(),
  ingots:count.positive(),createdAt:timestamp,epochCreatedAt:timestamp,abortedAt:timestamp.nullable(),releasedAt:timestamp.nullable()}).strict();
const evidenceSchema=z.object({cohort:cohortSchema,battle:z.object({journalHash:z.string().regex(/^[0-9a-f]{64}$/),sealedAt:timestamp,
  playedRaidIds:z.array(uuid).max(2_000),lastActionAt:timestamp.nullable()}).strict(),reservations:z.array(reservationSchema).max(MAX_SOURCES),
  workshopReceipts:z.array(z.object({jobId:uuid,debitReceiptId:uuid,baseId:uuid,ingots:count.positive(),collectedAt:timestamp}).strict()).max(MAX_SOURCES)}).strict();
const resultSchema=z.object({wallet,day:z.string(),policyVersion:z.literal(policyVersion),observedAt:timestamp,baseId:uuid,
  publicationAuthorized:z.literal(false),allocationReady:z.literal(false),unavailable:z.tuple([z.literal(unavailable[0]),z.literal(unavailable[1]),z.literal(unavailable[2]),z.literal(unavailable[3])]),
  cohortValid:z.boolean(),cohortReason:z.enum(['valid','not-effective','invalidated']),freshBattleEvidence:z.boolean(),playedRaidIds:z.array(uuid),lastActionAt:timestamp.nullable(),
  capacityUnits:count,reservedUnits:count,pendingUnits:count,releasedUnits:count,eligibleUnits:count,projectedReturnUnits:count,reservationIds:z.array(uuid),
  reason:z.enum(['qualified_inputs','cohort_invalid','no_fresh_battle','no_contribution','released_contribution'])}).strict();
export type FreeWalletShadowResult=z.infer<typeof resultSchema>;
type Evidence=z.infer<typeof evidenceSchema>;
type Input=z.infer<typeof inputSchema>;
type Code='INVALID_INPUT'|'SOURCE_BUSY'|'SOURCE_CONFLICT'|'TOO_LARGE'|'JOURNAL_CONFLICT';
export class FreeWalletShadowError extends Error {constructor(readonly code:Code){super(`Free-wallet shadow refused: ${code}`);this.name='FreeWalletShadowError';}}
function fail(code:Code):never {throw new FreeWalletShadowError(code);}
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object') return `{${Object.entries(value).sort(([a],[b])=>lexical(a,b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function iso(value:unknown):string {const at=new Date(String(value));if(!Number.isFinite(+at))fail('SOURCE_CONFLICT');return at.toISOString();}
const digest=(input:Input,observedAt:string,evidence:Evidence,result:FreeWalletShadowResult)=>createHash('sha256').update(canonical({input,observedAt,evidence,result})).digest('hex');
function derive(input:Input,observedAt:string,evidence:Evidence):FreeWalletShadowResult {
  const start=`${input.day}T00:00:00.000Z`,end=new Date(Date.parse(start)+86_400_000).toISOString(),c=evidence.cohort;
  if(observedAt<end||observedAt<evidence.battle.sealedAt||c.observedAt>observedAt||c.observedAt<end
    ||c.wallet!==input.wallet||c.day!==input.day||c.enrollment.wallet!==input.wallet||c.enrollment.baseId!==c.baseId) fail('SOURCE_CONFLICT');
  const cohortReason=c.enrollment.effectiveFrom>start?'not-effective':c.events.length?'invalidated':'valid';
  if(c.reason!==cohortReason||c.valid!==(cohortReason==='valid')||c.events.some(e=>e.observedAt>=end||e.observedAt<c.enrollment.enrolledAt)) fail('SOURCE_CONFLICT');
  const raidIds=evidence.battle.playedRaidIds;
  if(new Set(raidIds).size!==raidIds.length||canonical([...raidIds].sort(lexical))!==canonical(raidIds)
    ||(raidIds.length===0)!==(evidence.battle.lastActionAt===null)
    ||(evidence.battle.lastActionAt!==null&&(evidence.battle.lastActionAt<start||evidence.battle.lastActionAt>=end))) fail('SOURCE_CONFLICT');
  let reservedUnits=0,releasedUnits=0;
  const ids=new Set<string>();
  for(const r of evidence.reservations) {
    if(ids.has(r.id)||r.baseId!==c.baseId||r.actorWallet!==input.wallet||r.epochKey!==`${policyVersion}:${input.day}`
      ||r.createdAt<start||r.createdAt>=end||r.createdAt>observedAt||r.epochCreatedAt>r.createdAt
      ||(r.abortedAt===null)!==(r.releasedAt===null)||r.abortedAt!==r.releasedAt
      ||(r.releasedAt!==null&&(r.releasedAt<r.createdAt||r.releasedAt>observedAt))) fail('SOURCE_CONFLICT');
    ids.add(r.id);reservedUnits+=r.ingots;if(r.releasedAt!==null)releasedUnits+=r.ingots;
  }
  if(!Number.isSafeInteger(reservedUnits)) fail('SOURCE_CONFLICT');
  const jobs=new Set<string>();
  for(const j of evidence.workshopReceipts) {if(j.baseId!==c.baseId||j.collectedAt>observedAt||jobs.has(j.jobId))fail('SOURCE_CONFLICT');jobs.add(j.jobId);}
  const pendingUnits=reservedUnits-releasedUnits,freshBattleEvidence=raidIds.length>0,capacityUnits=PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay;
  const eligibleUnits=c.valid&&freshBattleEvidence?Math.min(capacityUnits,pendingUnits):0;
  return {wallet:input.wallet,day:input.day,policyVersion,observedAt,baseId:c.baseId,publicationAuthorized:false,allocationReady:false,unavailable:[...unavailable],
    cohortValid:c.valid,cohortReason:c.reason,freshBattleEvidence,playedRaidIds:raidIds,lastActionAt:evidence.battle.lastActionAt,
    capacityUnits,reservedUnits,pendingUnits,releasedUnits,eligibleUnits,projectedReturnUnits:pendingUnits-eligibleUnits,reservationIds:[...ids].sort(lexical),
    reason:!c.valid?'cohort_invalid':!freshBattleEvidence?'no_fresh_battle':pendingUnits===0?(releasedUnits?'released_contribution':'no_contribution'):'qualified_inputs'};
}
async function replay(db:DbOrTx,input:Input):Promise<FreeWalletShadowResult|null> {
  const [row]=await db.execute<{observed_at:unknown;evidence:unknown;result:unknown;evidence_hash:string}>(sql`select observed_at,evidence,result,evidence_hash from mining_free_wallet_shadows
    where wallet=${input.wallet} and day=${input.day}::date and policy_version=${policyVersion}`);
  if(!row)return null;
  try {const observedAt=iso(row.observed_at),evidence=evidenceSchema.parse(row.evidence),result=resultSchema.parse(row.result);
    if(digest(input,observedAt,evidence,result)!==row.evidence_hash||canonical(derive(input,observedAt,evidence))!==canonical(result))fail('JOURNAL_CONFLICT');return result;
  }catch{return fail('JOURNAL_CONFLICT');}
}
export async function collectFreeWalletShadow(db:Db,value:unknown):Promise<FreeWalletShadowResult> {
  const parsed=inputSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');const input=parsed.data;
  const start=new Date(`${input.day}T00:00:00.000Z`);if(!Number.isFinite(+start)||start.toISOString().slice(0,10)!==input.day)fail('INVALID_INPUT');
  const prior=await replay(db,input);if(prior)return prior;
  // The collector owns its short source transaction. Its immutable result is
  // verified before the consumer snapshots the other independent sources.
  const activity=await collectMiningActivityEvidence(db,{day:input.day,policyVersion:'battle-evidence-v1'});
  try {return await db.transaction(async tx=>{
    await tx.execute(sql`lock table mining_free_coverage,mining_free_cohorts,mining_free_cohort_events,
      mining_activity_evidence,mining_ingot_epochs,mining_ingot_admissions,mining_ingot_reservations,mining_ingot_aborts,mining_ingot_releases,
      workshop_jobs,base_items,accounts,ledger_transactions,ledger_entries in share mode nowait`);
    const [lock]=await tx.execute<{locked:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`free-shadow:${input.wallet}:${input.day}`},0)) locked`);
    if(!lock?.locked)fail('SOURCE_BUSY');const duplicate=await replay(tx,input);if(duplicate)return duplicate;
    const cohort=cohortSchema.parse(await readFreeCohortInterval(tx,input.wallet,input.day));
    const [clock]=await tx.execute<{now:unknown}>(sql`select public.shardkeep_mining_free_clock() now`);const observedAt=iso(clock?.now);
    const [journal]=await tx.execute<{evidence_hash:string;sealed_at:unknown;evidence:{raids:Array<{raid:{id:string;wallet:string;baseId:string};events:Array<{sourceKey:string;occurredAt:string;invalidatedAt:string|null}>}>}}>(sql`
      select evidence_hash,sealed_at,evidence from mining_activity_evidence where day=${input.day}::date and policy_version='battle-evidence-v1'`);
    if(!journal)fail('SOURCE_CONFLICT');const played=new Set(activity.wallets.find(w=>w.wallet===input.wallet)?.playedRaidIds??[]);
    const raids=journal.evidence.raids.filter(r=>played.has(r.raid.id)&&r.raid.wallet===input.wallet&&r.raid.baseId===cohort.baseId);
    const times=raids.flatMap(r=>r.events.filter(e=>e.sourceKey==='battle_fought'&&e.invalidatedAt===null&&e.occurredAt.slice(0,10)===input.day).map(e=>e.occurredAt)).sort(lexical);
    const rows=await tx.execute<Record<string,unknown>>(sql`select r.*,e.epoch_key,e.created_at epoch_created_at,a.created_at aborted_at,x.created_at released_at
      from mining_ingot_reservations r join mining_ingot_epochs e on e.id=r.epoch_id left join mining_ingot_aborts a on a.epoch_id=e.id
      left join mining_ingot_releases x on x.reservation_id=r.id where e.epoch_key=${`${policyVersion}:${input.day}`} and (r.actor_wallet=${input.wallet} or r.base_id=${cohort.baseId}::uuid)
      order by r.id limit ${MAX_SOURCES+1}`);
    const jobs=await tx.execute<Record<string,unknown>>(sql`select id,debit_ledger_txn_id,base_id,ingots,collected_at from workshop_jobs
      where base_id=${cohort.baseId}::uuid and collected_at is not null order by id limit ${MAX_SOURCES+1}`);
    const allReservations=await tx.execute<{created_at:unknown}>(sql`select created_at from mining_ingot_reservations where base_id=${cohort.baseId}::uuid limit ${MAX_SOURCES+1}`);
    if(rows.length>MAX_SOURCES||jobs.length>MAX_SOURCES||allReservations.length>MAX_SOURCES)fail('TOO_LARGE');
    if(allReservations.some(r=>iso(r.created_at)>observedAt))fail('SOURCE_CONFLICT');
    await tx.execute(sql`select public.shardkeep_assert_mining_ingot_stock(${cohort.baseId}::uuid)`);
    const evidence=evidenceSchema.parse({cohort,battle:{journalHash:journal.evidence_hash,sealedAt:iso(journal.sealed_at),playedRaidIds:raids.map(r=>r.raid.id).sort(lexical),lastActionAt:times.at(-1)??null},
      reservations:rows.map(r=>({id:r.id,epochId:r.epoch_id,epochKey:r.epoch_key,baseId:r.base_id,actorWallet:r.actor_wallet,idempotencyKey:r.idempotency_key,ingots:r.qty,
        createdAt:iso(r.created_at),epochCreatedAt:iso(r.epoch_created_at),abortedAt:r.aborted_at===null?null:iso(r.aborted_at),releasedAt:r.released_at===null?null:iso(r.released_at)})),
      workshopReceipts:jobs.map(j=>({jobId:j.id,debitReceiptId:j.debit_ledger_txn_id,baseId:j.base_id,ingots:j.ingots,collectedAt:iso(j.collected_at)}))});
    const result=derive(input,observedAt,evidence),hash=digest(input,observedAt,evidence,result);
    await tx.execute(sql`insert into mining_free_wallet_shadows(wallet,day,policy_version,observed_at,evidence_hash,evidence,result)
      values(${input.wallet},${input.day}::date,${policyVersion},${observedAt}::timestamptz,${hash},${JSON.stringify(evidence)}::jsonb,${JSON.stringify(result)}::jsonb)
      on conflict(wallet,day,policy_version) do nothing`);
    return (await replay(tx,input))??fail('JOURNAL_CONFLICT');
  });}catch(error){if(error instanceof z.ZodError)fail('SOURCE_CONFLICT');const e=error as {code?:string;cause?:{code?:string}};
    if(e.code==='55P03'||e.cause?.code==='55P03')fail('SOURCE_BUSY');throw error;}
}
