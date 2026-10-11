/** Pure D-153.103 obstacle evidence consistency, never source authentication.
 * Job/custody statements and historical certificates require independent durable
 * and finalized-chain verification before a future adapter may post money. The
 * generic attribution kernel deliberately still holds obstacle_reward. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {hashExpeditionTermSnapshot,parseExpeditionTermSnapshot} from '../game/expeditionTerms';

const instant=z.string().length(24).datetime({precision:3}).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const u64=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<=(1n<<64n)-1n);
const quantity=z.bigint().positive().max(RAW_RESOURCE_STORAGE_MAX);
const flags=Object.freeze({sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false} as const);
function need(v:unknown,message:string):asserts v{if(!v)throw Error(`Invalid obstacle earning evidence: ${message}`);}
/** Refuse accessors/symbols/non-JSON object identities before schema reads; this
 * parser accepts bigint quantities, but never executes an evidence getter. */
function plain(value:unknown,depth=0):void{
 need(depth<=32,'evidence nesting');
 if(value===null||typeof value!=='object')return;
 const keys=Reflect.ownKeys(value);
 if(Array.isArray(value)){
  need(keys.length===value.length+1&&keys.every(k=>k==='length'||typeof k==='string'&&/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<value.length),'array fields');
 }else need(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null,'plain evidence object');
 for(const name of keys){
  need(typeof name==='string','symbol fields');const descriptor=Object.getOwnPropertyDescriptor(value,name)!;
  need('value' in descriptor&&(descriptor.enumerable||Array.isArray(value)&&name==='length'),'accessor or hidden field');if(name!=='length'||!Array.isArray(value))plain(descriptor.value,depth+1);
 }
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
const historicalTerm=z.object({
 version:z.literal(1),purpose:z.literal('historical_shards_attribution'),
 snapshot:z.unknown().transform(v=>{
  const snapshot=parseExpeditionTermSnapshot(v);
  // The shared historical snapshot codec normalizes UUID case. This new
  // certificate grammar is canonical at its input boundary as well.
  need((v as {termId:unknown}).termId===snapshot.termId,'canonical term identity');return snapshot;
 }),
 termHash:hash,completedAt:instant,completedSlot:u64,
 deployment:z.object({programDataAddress:key,programDataSha256:hash,deployedSlot:u64,upgradeAuthority:key.nullable()}).strict(),
 finality:z.object({commitment:z.literal('finalized'),contextSlot:u64,observedAt:instant}).strict(),
 operatingAdmissionAuthorized:z.literal(false),
}).strict();
export type HistoricalShardsTermCertificate=z.infer<typeof historicalTerm>;
/** A hash binds a supplied snapshot; neither it nor these supplied deployment
 * keys establish trust. Preserve actual observation time, including after expiry.
 * Current expedition admission continues to use its different strict parser. */
export function parseHistoricalShardsTermCertificate(raw:unknown):HistoricalShardsTermCertificate{
 plain(raw);const term=historicalTerm.parse(raw);
 need(hashExpeditionTermSnapshot(term.snapshot)===term.termHash,'original term hash');
 need(term.completedAt>=term.snapshot.startsAt&&term.completedAt<=term.finality.observedAt,'term completion time');
 const deployed=BigInt(term.deployment.deployedSlot),completed=BigInt(term.completedSlot),context=BigInt(term.finality.contextSlot);
 need(deployed<=completed&&completed<=context,'term completion slot');
 const settlementSlots=term.snapshot.spots.map(spot=>BigInt(spot.settlementSlot));
 need(settlementSlots.every(slot=>slot>=deployed&&slot<=completed)
  &&settlementSlots.reduce((highest,slot)=>slot>highest?slot:highest,0n)===completed,'original settlement slots');
 return freeze(term);
}
/** Canonical full historical certificate identity. JSONB key order cannot
 * alter this encoding, while completion, deployment and observation remain
 * distinct from the shared original snapshot/pool identity. */
export function serializeHistoricalShardsTermCertificate(raw:unknown):string{
 return JSON.stringify(parseHistoricalShardsTermCertificate(raw));
}
export function hashHistoricalShardsTermCertificate(raw:unknown):string{
 return createHash('sha256').update('shardkeep:historical-shards-term-certificate:v1\n')
  .update(serializeHistoricalShardsTermCertificate(raw),'utf8').digest('hex');
}
const job=z.object({jobId:uuid,baseId:uuid,obstacleId:uuid,capturedAt:instant,scheduledFinishAt:instant,finishesAt:instant,gross:quantity,evidenceSha256:hash}).strict()
 .refine(v=>v.scheduledFinishAt>v.capturedAt,'A prospective capture must precede the unfinished schedule');
const acceleration=z.object({key:uuid,kind:z.enum(['item','gems']),acceptedAt:instant,beforeFinishAt:instant,afterFinishAt:instant,evidenceSha256:hash}).strict();
const custody=z.discriminatedUnion('status',[
 z.object({status:z.literal('unresolved')}).strict(),
 z.object({status:z.literal('confirmed'),baseId:uuid,wallet:key,startsAt:instant,endsAt:instant.nullable(),evidenceSha256:hash}).strict()
  .refine(v=>v.endsAt===null||v.endsAt>v.startsAt,'Custody interval must be nonempty'),
]);
const input=z.object({version:z.literal(1),job,accelerations:z.array(acceleration).nullable(),custody,term:z.unknown().refine(v=>v!==undefined,'Use explicit null for missing term authority'),processedAt:instant}).strict();
type HoldReason='SCHEDULE_UNRESOLVED'|'NOT_DUE'|'CUSTODY_UNRESOLVED'|'TERM_AUTHORITY_REQUIRED'|'ORIGINAL_TERM_REQUIRED'|'TERM_NOT_COMPLETE_AT_EARNING';
type ConfirmedCustody=Extract<z.infer<typeof custody>,{status:'confirmed'}>;
export interface ObstacleEarningEvidence{
 readonly version:1;readonly job:z.infer<typeof job>;readonly capturedSchedule:readonly z.infer<typeof acceleration>[];
 readonly custody:ConfirmedCustody;readonly earnedAt:string;readonly processedAt:string;readonly gross:bigint;
 readonly term:HistoricalShardsTermCertificate;readonly winnerCount:number;readonly poolDisposition:'original_winning_spots'|'held_zero_winners';
}
export type ObstacleEarningEvaluation=(
 {readonly status:'held';readonly reason:HoldReason;readonly evidence:null}
 |{readonly status:'consistent';readonly evidence:ObstacleEarningEvidence})&typeof flags;

/** No provider, database, clock, mutable carry or present owner is consulted. */
export function evaluateObstacleEarningEvidence(raw:unknown):ObstacleEarningEvaluation{
 plain(raw);const facts=input.parse(raw),held=(reason:HoldReason):ObstacleEarningEvaluation=>freeze({status:'held',reason,evidence:null,...flags});
 if(facts.accelerations===null)return held('SCHEDULE_UNRESOLVED');
 let finish=facts.job.scheduledFinishAt,previousAccepted=facts.job.capturedAt;const seen=new Set<string>();
 for(const event of facts.accelerations){
  need(!seen.has(event.key),'duplicate acceleration');seen.add(event.key);
  need(event.acceptedAt>=previousAccepted&&event.acceptedAt<finish,'acceleration acceptance time');
  need(event.beforeFinishAt===finish&&event.afterFinishAt>=event.acceptedAt&&event.afterFinishAt<=finish,'acceleration schedule');
  previousAccepted=event.acceptedAt;finish=event.afterFinishAt;
 }
 if(finish!==facts.job.finishesAt)return held('SCHEDULE_UNRESOLVED');
 if(facts.processedAt<finish)return held('NOT_DUE');
 // A raw custody timestamp cannot order a transfer against a due completion
 // at that same millisecond. Existing transfer code settles due work first;
 // require separate ordered evidence before admitting either boundary wallet.
 if(facts.custody.status!=='confirmed'||facts.custody.baseId!==facts.job.baseId||facts.custody.startsAt>=finish
  ||facts.custody.endsAt!==null&&facts.custody.endsAt<=finish)return held('CUSTODY_UNRESOLVED');
 if(facts.term===null||facts.term===undefined)return held('TERM_AUTHORITY_REQUIRED');
 const term=parseHistoricalShardsTermCertificate(facts.term);
 need(term.finality.observedAt<=facts.processedAt,'observation after processing');
 if(finish<term.snapshot.startsAt||finish>=term.snapshot.endsAt)return held('ORIGINAL_TERM_REQUIRED');
 if(term.completedAt>finish)return held('TERM_NOT_COMPLETE_AT_EARNING');
 const winnerCount=term.snapshot.spots.filter(spot=>spot.ownerWallet!==null).length;
 return freeze({status:'consistent',evidence:{version:1,job:facts.job,capturedSchedule:facts.accelerations,custody:facts.custody,
  earnedAt:finish,processedAt:facts.processedAt,gross:facts.job.gross,term,winnerCount,
  poolDisposition:winnerCount?'original_winning_spots':'held_zero_winners'},...flags});
}
