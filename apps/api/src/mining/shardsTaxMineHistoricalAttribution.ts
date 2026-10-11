import { mineProductionClockSchema, mineProductionRemainder, mineUnitCompletion } from './shardsTaxMineProduction';
/** Pure historical Mine receipt integrity. The source writer must independently
 * prove the original quantity, custody and finalized term before posting money. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PHASE_E_HARVESTER,PHASE_E_POLICY} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {splitResourceEarnings} from '@shardkeep/shared/phaseEResourceTax';
import {MINE_DAY_MS} from '../game/baseMining';
import {parseShardsTaxSource,SHARDS_TAX_LINEAGE,type ShardsTaxSource,type ShardsTaxCarry} from './shardsTaxAttribution';
import {parseHistoricalShardsTermCertificate,hashHistoricalShardsTermCertificate,serializeHistoricalShardsTermCertificate,type HistoricalShardsTermCertificate} from './shardsTaxObstacleEvidence';
export const HISTORICAL_MINE_SOURCE_DECISION='physical-mine-historical-source-v1' as const;
const v1=PHASE_E_HARVESTER.v1,policy=Object.freeze({lineage:SHARDS_TAX_LINEAGE,version:v1.taxPolicyVersion,basisPoints:v1.taxBasisPoints,islandPoolBps:v1.islandPoolBps});
const flags=Object.freeze({sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false} as const);
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),hash=z.string().regex(/^[0-9a-f]{64}$/);
const quantity=z.bigint().min(0n).max(RAW_RESOURCE_STORAGE_MAX);
const rawQuantity=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=RAW_RESOURCE_STORAGE_MAX);
const instant=z.string().length(24).datetime({precision:3}).refine(v=>Number.isSafeInteger(Date.parse(v))&&new Date(v).toISOString()===v);
const originalSchema=z.object({parentId:uuid,childId:uuid,mineId:uuid,baseId:uuid,wallet:z.string(),recoveryHash:hash,custodyHash:hash,
 sourceKey:z.string(),anchorAt:instant,quota:rawQuantity,firstUnit:rawQuantity,lastUnit:rawQuantity,gross:rawQuantity,startsAt:instant,endsAt:instant,resolvedAt:instant,productionClock:mineProductionClockSchema.optional()}).strict();
export type HistoricalMineTaxOriginal=z.infer<typeof originalSchema>;
const carrySchema=z.object({wallet:z.string(),currency:z.literal('SHARDS'),lineage:z.literal(SHARDS_TAX_LINEAGE),sequence:quantity,
 value:z.bigint().min(0n).max(BigInt(policy.basisPoints)-1n)}).strict();
function need(v:unknown,message:string):asserts v{if(!v)throw Error(`Invalid historical Mine attribution: ${message}`);}
function plain(v:unknown,depth=0):void{
 need(depth<=32,'input nesting');if(v===null||typeof v!=='object')return;
 const keys=Reflect.ownKeys(v);if(Array.isArray(v))need(keys.length===v.length+1&&keys.every(k=>k==='length'||typeof k==='string'&&/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length),'array fields');
 else need(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null,'plain object');
 for(const k of keys){need(typeof k==='string','symbol fields');const d=Object.getOwnPropertyDescriptor(v,k)!;need('value' in d&&(d.enumerable||Array.isArray(v)&&k==='length'),'accessor or hidden field');if(k!=='length'||!Array.isArray(v))plain(d.value,depth+1);}
}
function exact(v:unknown,names:string):Record<string,unknown>{need(v&&typeof v==='object'&&!Array.isArray(v),'object fields');const keys=Reflect.ownKeys(v),fields=names.split(' ');need(keys.length===fields.length&&keys.every(k=>typeof k==='string'&&fields.includes(k)),'exact fields');return v as Record<string,unknown>;}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x);
function evidence(raw:unknown,certificate:unknown){
 plain(raw);plain(certificate);const original=originalSchema.parse(raw),term=parseHistoricalShardsTermCertificate(certificate);
 const first=BigInt(original.firstUnit),last=BigInt(original.lastUnit),quota=BigInt(original.quota),gross=BigInt(original.gross);
 need(original.parentId!==original.childId&&first>0n&&last>=first&&gross===last-first+1n&&quota>0n,'original unit range');
 need(original.sourceKey===`mine-recovered:${original.parentId}:u${first}${original.productionClock?':p'+original.productionClock.settlementId:''}`,'child source key');
 const completion=(u:bigint)=>mineUnitCompletion(BigInt(Date.parse(original.anchorAt)),quota,BigInt(MINE_DAY_MS),u,mineProductionRemainder(original.productionClock,BigInt(MINE_DAY_MS)));
 need(completion(first)===BigInt(Date.parse(original.startsAt))&&completion(last)===BigInt(Date.parse(original.endsAt)),'original unit completion');
 need(original.startsAt>=term.snapshot.startsAt&&original.endsAt<term.snapshot.endsAt&&original.startsAt>=term.completedAt,'original term eligibility');
 need(original.endsAt<=term.finality.observedAt&&term.finality.observedAt<=original.resolvedAt,'historical observation');
 return {original:freeze(original),term};
}
function evidenceHash(original:HistoricalMineTaxOriginal,term:HistoricalShardsTermCertificate){return createHash('sha256').update(original.productionClock?'shardkeep:physical-mine-historical-source:v2\n':'shardkeep:physical-mine-historical-source:v1\n').update(canonical({original,term})).digest('hex');}
export function hashHistoricalMineTaxEvidence(original:unknown,term:unknown){const e=evidence(original,term);return evidenceHash(e.original,e.term);}
function bind(raw:unknown,original:HistoricalMineTaxOriginal,term:HistoricalShardsTermCertificate):ShardsTaxSource{
 const s=parseShardsTaxSource(raw),endsAt=new Date(Date.parse(original.endsAt)+1).toISOString();
 need(s.kind==='physical_mine'&&s.baseId===original.baseId&&s.wallet===original.wallet&&s.gross>0n&&s.gross<=BigInt(original.gross),'original source identity');
 need(s.key===original.sourceKey+':'+s.ledger.idempotencyKey&&s.authority?.classification==='new_earning'
  &&s.authority.decisionRef===HISTORICAL_MINE_SOURCE_DECISION&&s.authority.evidenceSha256===evidenceHash(original,term),'original source evidence');
 need(original.startsAt===original.endsAt?s.earning.kind==='instant'&&s.earning.at===original.startsAt:
  s.earning.kind==='interval'&&s.earning.startsAt===original.startsAt&&s.earning.endsAt===endsAt,'original earning interval');return s;
}
function carry(raw:unknown,wallet:string):ShardsTaxCarry{const c=carrySchema.parse(exact(raw,'wallet currency lineage sequence value'));need(c.wallet===wallet,'original wallet carry');return freeze(c);}
export interface HistoricalMineTaxReceipt{
 readonly version:2;readonly purpose:'historical_physical_mine';readonly source:ShardsTaxSource;readonly term:HistoricalShardsTermCertificate;
 readonly termHash:string;readonly historicalCertificateHash:string;readonly policy:typeof policy;readonly carryBefore:ShardsTaxCarry;readonly carryAfter:ShardsTaxCarry;
 readonly net:bigint;readonly tax:bigint;readonly pool:Readonly<{termId:string;termHash:string;winnerCount:number;amount:bigint;disposition:'original_winning_spots'|'held_zero_winners'}>;
 readonly sourceVerified:false;readonly postingAuthorized:false;readonly payoutAuthorized:false;readonly operatingAdmissionAuthorized:false;
}
function receipt(source:ShardsTaxSource,term:HistoricalShardsTermCertificate,before:ShardsTaxCarry,net:bigint,tax:bigint,nextCarry:bigint):HistoricalMineTaxReceipt{
 const winnerCount=term.snapshot.spots.filter(s=>s.ownerWallet!==null).length;
 return freeze({version:2,purpose:'historical_physical_mine',source,term,termHash:term.termHash,historicalCertificateHash:hashHistoricalShardsTermCertificate(term),
  policy:{...policy},carryBefore:before,carryAfter:{...before,sequence:before.sequence+1n,value:nextCarry},net,tax,
  pool:{termId:term.snapshot.termId,termHash:term.termHash,winnerCount,amount:tax,disposition:winnerCount?'original_winning_spots':'held_zero_winners'},...flags});
}
export function attributeHistoricalMineTax(input:unknown):HistoricalMineTaxReceipt{
 plain(input);const r=exact(input,'source original term carry'),e=evidence(r.original,r.term),s=bind(r.source,e.original,e.term),before=carry(r.carry,s.wallet);
 need(before.sequence<RAW_RESOURCE_STORAGE_MAX,'carry sequence overflow');
 need(PHASE_E_POLICY.basisPoints===policy.basisPoints&&PHASE_E_POLICY.taxes.resources.islandPoolBps===policy.islandPoolBps,'current policy differs from frozen lineage');
 const amounts=splitResourceEarnings(s.gross,before.value);return receipt(s,e.term,before,amounts.net,amounts.tax,amounts.nextCarry);
}
/** Source, original child and certificate must come from independent immutable
 * history. Receipt JSON cannot authenticate its own earning or grant authority. */
export function replayHistoricalMineTax(raw:unknown,expectedSource:unknown,original:unknown,certificate:unknown):HistoricalMineTaxReceipt{
 plain(raw);plain(expectedSource);const r=exact(raw,'version purpose source term termHash historicalCertificateHash policy carryBefore carryAfter net tax pool sourceVerified postingAuthorized payoutAuthorized operatingAdmissionAuthorized');
 const e=evidence(original,certificate),s=bind(r.source,e.original,e.term),expected=bind(expectedSource,e.original,e.term);
 need(canonical(s)===canonical(expected),'original source differs');need(r.version===2&&r.purpose==='historical_physical_mine'&&Object.entries(flags).every(([k,v])=>r[k]===v),'receipt authority');
 const p=exact(r.policy,'lineage version basisPoints islandPoolBps');need(Object.entries(policy).every(([k,v])=>p[k]===v),'frozen policy');
 const term=parseHistoricalShardsTermCertificate(r.term);need(serializeHistoricalShardsTermCertificate(term)===serializeHistoricalShardsTermCertificate(e.term),'original certificate');
 need(r.termHash===term.termHash&&r.historicalCertificateHash===hashHistoricalShardsTermCertificate(term),'historical identity');
 const before=carry(r.carryBefore,s.wallet),after=carry(r.carryAfter,s.wallet);need(before.sequence<RAW_RESOURCE_STORAGE_MAX,'carry sequence overflow');
 const numerator=s.gross*BigInt(policy.islandPoolBps)+before.value,tax=numerator/BigInt(policy.basisPoints),net=s.gross-tax,next=numerator%BigInt(policy.basisPoints);
 need(after.sequence===before.sequence+1n&&after.value===next&&quantity.parse(r.tax)===tax&&quantity.parse(r.net)===net,'original arithmetic');
 const pool=exact(r.pool,'termId termHash winnerCount amount disposition'),result=receipt(s,term,before,net,tax,next);
 need(Object.entries(result.pool).every(([k,v])=>pool[k]===v),'original pool');return result;
}
