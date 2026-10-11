/** Pure original obstacle arithmetic only. Independently reconstructed source,
 * custody and finalized term evidence remain mandatory before any future issuer.
 * This receipt grants no source, posting, payout or operating capability. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PHASE_E_HARVESTER,PHASE_E_POLICY} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {splitResourceEarnings} from '@shardkeep/shared/phaseEResourceTax';
import {parseShardsTaxSource,SHARDS_TAX_LINEAGE,type ShardsTaxSource,type ShardsTaxCarry} from './shardsTaxAttribution';
import {evaluateObstacleEarningEvidence,hashHistoricalShardsTermCertificate,parseHistoricalShardsTermCertificate,
 serializeHistoricalShardsTermCertificate,type ObstacleEarningEvidence,type ObstacleEarningEvaluation,type HistoricalShardsTermCertificate} from './shardsTaxObstacleEvidence';

export const SHARDS_OBSTACLE_SOURCE_DECISION='obstacle-reward-source-v1' as const;
const V1=PHASE_E_HARVESTER.v1;
const policy=Object.freeze({lineage:SHARDS_TAX_LINEAGE,version:V1.taxPolicyVersion,basisPoints:V1.taxBasisPoints,islandPoolBps:V1.islandPoolBps});
const flags=Object.freeze({sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false} as const);
const quantity=z.bigint().min(0n).max(RAW_RESOURCE_STORAGE_MAX);
const carrySchema=z.object({wallet:z.string(),currency:z.literal('SHARDS'),lineage:z.literal(SHARDS_TAX_LINEAGE),sequence:quantity,
 value:z.bigint().min(0n).max(BigInt(policy.basisPoints)-1n)}).strict();
function need(value:unknown,message:string):asserts value{if(!value)throw Error(`Invalid obstacle SHARDS attribution: ${message}`);}
/** Check descriptors before any schema or discriminant can invoke a getter. */
function plain(value:unknown,depth=0):void{
 need(depth<=32,'input nesting');if(value===null||typeof value!=='object')return;
 const keys=Reflect.ownKeys(value);
 if(Array.isArray(value))need(keys.length===value.length+1&&keys.every(k=>k==='length'||typeof k==='string'&&/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<value.length),'array fields');
 else need(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null,'plain object');
 for(const key of keys){need(typeof key==='string','symbol fields');const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
  need('value' in descriptor&&(descriptor.enumerable||Array.isArray(value)&&key==='length'),'accessor or hidden field');if(key!=='length'||!Array.isArray(value))plain(descriptor.value,depth+1);}
}
function exact(value:unknown,names:string):Record<string,unknown>{
 need(value&&typeof value==='object'&&!Array.isArray(value),'object fields');const fields=names.split(' '),keys=Reflect.ownKeys(value);
 need(keys.length===fields.length&&keys.every(key=>typeof key==='string'&&fields.includes(key)),'exact fields');return value as Record<string,unknown>;
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const canonical=(value:unknown)=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v);
function evidenceHash(evidence:ObstacleEarningEvidence):string{
 return createHash('sha256').update('shardkeep:obstacle-reward-source:v1\n').update(canonical(evidence),'utf8').digest('hex');
}
/** Re-evaluate raw evidence; a caller-supplied status or consistency flag is not
 * accepted. Complete normalized original evidence is bound, including processing
 * and observation times; the shared pool still uses only the snapshot hash. */
export function hashShardsObstacleSourceEvidence(rawEvidence:unknown):string{
 const evaluated=evaluateObstacleEarningEvidence(rawEvidence);need(evaluated.status==='consistent','consistent original evidence required');
 return evidenceHash(evaluated.evidence);
}
function carry(raw:unknown,wallet:string):ShardsTaxCarry{
 const result=carrySchema.parse(exact(raw,'wallet currency lineage sequence value'));need(result.wallet===wallet,'original carry wallet');return freeze(result);
}
function source(raw:unknown):ShardsTaxSource{
 const result=parseShardsTaxSource(raw);
 need(result.kind==='obstacle_reward'&&result.earning.kind==='instant'&&result.baseId!==null
  &&result.authority?.classification==='new_earning'&&result.authority.decisionRef===SHARDS_OBSTACLE_SOURCE_DECISION,'obstacle source classification');
 need(result.key===result.ledger.idempotencyKey,'original ledger key');return result;
}
function bind(source:ShardsTaxSource,evidence:ObstacleEarningEvidence):void{
 need(source.key===`obstacle-reward:${evidence.job.jobId}`&&source.wallet===evidence.custody.wallet
  &&source.baseId===evidence.job.baseId&&source.gross===evidence.gross&&source.earning.kind==='instant'&&source.earning.at===evidence.earnedAt
  &&source.authority?.classification==='new_earning'&&source.authority.evidenceSha256===evidenceHash(evidence),'original source evidence differs');
}
export interface ShardsObstacleTaxAttributionReceipt{
 readonly version:2;readonly source:ShardsTaxSource;readonly term:HistoricalShardsTermCertificate;
 readonly termHash:string;readonly historicalCertificateHash:string;readonly policy:typeof policy;
 readonly carryBefore:ShardsTaxCarry;readonly carryAfter:ShardsTaxCarry;readonly net:bigint;readonly tax:bigint;
 readonly pool:Readonly<{termId:string;termHash:string;winnerCount:number;amount:bigint;disposition:'original_winning_spots'|'held_zero_winners'}>;
 readonly sourceVerified:false;readonly postingAuthorized:false;readonly payoutAuthorized:false;readonly operatingAdmissionAuthorized:false;
}
type HoldReason=Extract<ObstacleEarningEvaluation,{status:'held'}>['reason'];
export type ShardsObstacleTaxAttribution=(
 {readonly status:'held';readonly reason:HoldReason;readonly carry:ShardsTaxCarry;readonly receipt:null}
 |{readonly status:'attributed';readonly receipt:ShardsObstacleTaxAttributionReceipt})&typeof flags;
function receipt(source:ShardsTaxSource,evidence:ObstacleEarningEvidence,before:ShardsTaxCarry,net:bigint,tax:bigint,nextCarry:bigint):ShardsObstacleTaxAttributionReceipt{
 return freeze({version:2,source,term:evidence.term,termHash:evidence.term.termHash,
  historicalCertificateHash:hashHistoricalShardsTermCertificate(evidence.term),policy:{...policy},carryBefore:before,
  carryAfter:{...before,sequence:before.sequence+1n,value:nextCarry},net,tax,
  pool:{termId:evidence.term.snapshot.termId,termHash:evidence.term.termHash,winnerCount:evidence.winnerCount,amount:tax,disposition:evidence.poolDisposition},...flags});
}
export function evaluateShardsObstacleTaxAttribution(input:unknown):ShardsObstacleTaxAttribution{
 plain(input);const r=exact(input,'source evidence carry'),original=source(r.source),before=carry(r.carry,original.wallet);
 const evaluation=evaluateObstacleEarningEvidence(r.evidence);
 if(evaluation.status==='held')return freeze({status:'held',reason:evaluation.reason,carry:before,receipt:null,...flags});
 bind(original,evaluation.evidence);need(before.sequence<RAW_RESOURCE_STORAGE_MAX,'carry sequence overflow');
 need(PHASE_E_POLICY.basisPoints===policy.basisPoints&&PHASE_E_POLICY.taxes.resources.islandPoolBps===policy.islandPoolBps,'current policy differs from frozen lineage');
 const amounts=splitResourceEarnings(original.gross,before.value);
 return freeze({status:'attributed',receipt:receipt(original,evaluation.evidence,before,amounts.net,amounts.tax,amounts.nextCarry),...flags});
}
/** Bigint-domain integrity replay only. Source and raw evidence must be obtained
 * independently; no current clock, policy, provider or mutable carry is read. */
export function replayShardsObstacleTaxAttribution(raw:unknown,independentlyReconstructedSource:unknown,independentlyReconstructedEvidence:unknown):ShardsObstacleTaxAttributionReceipt{
 plain(raw);plain(independentlyReconstructedSource);
 const r=exact(raw,'version source term termHash historicalCertificateHash policy carryBefore carryAfter net tax pool sourceVerified postingAuthorized payoutAuthorized operatingAdmissionAuthorized');
 const original=source(r.source),expected=source(independentlyReconstructedSource),evaluation=evaluateObstacleEarningEvidence(independentlyReconstructedEvidence);
 need(evaluation.status==='consistent','consistent original evidence required');bind(original,evaluation.evidence);bind(expected,evaluation.evidence);
 need(canonical(original)===canonical(expected),'original source differs');
 need(r.version===2&&Object.entries(flags).every(([key,value])=>r[key]===value),'receipt authority');
 const p=exact(r.policy,'lineage version basisPoints islandPoolBps');need(Object.entries(policy).every(([key,value])=>p[key]===value),'frozen policy');
 const term=parseHistoricalShardsTermCertificate(r.term);
 need(serializeHistoricalShardsTermCertificate(term)===serializeHistoricalShardsTermCertificate(evaluation.evidence.term),'original historical certificate differs');
 need(r.termHash===term.termHash&&r.historicalCertificateHash===hashHistoricalShardsTermCertificate(term),'original historical identity');
 const before=carry(r.carryBefore,original.wallet),after=carry(r.carryAfter,original.wallet);
 need(before.sequence<RAW_RESOURCE_STORAGE_MAX,'carry sequence overflow');
 const numerator=original.gross*BigInt(policy.islandPoolBps)+before.value,tax=numerator/BigInt(policy.basisPoints),net=original.gross-tax,next=numerator%BigInt(policy.basisPoints);
 need(after.sequence===before.sequence+1n&&after.value===next&&quantity.parse(r.net)===net&&quantity.parse(r.tax)===tax,'original arithmetic');
 const pool=exact(r.pool,'termId termHash winnerCount amount disposition');
 need(pool.termId===term.snapshot.termId&&pool.termHash===term.termHash&&pool.winnerCount===evaluation.evidence.winnerCount
  &&pool.amount===tax&&pool.disposition===evaluation.evidence.poolDisposition,'original pool');
 return receipt(original,evaluation.evidence,before,net,tax,next);
}
