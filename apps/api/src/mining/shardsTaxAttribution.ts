/** DARK structural source contract and pure D-150 amount attribution only.
 * Supplied source/term shapes and hashes do NOT authenticate earning, ownership,
 * chain finality or a ledger posting. The physical Mine adapter independently
 * validates its source segments, serializes wallet/SHARDS/lineage carry and
 * atomically persists these receipts with conserved ledger entries. Every other
 * source still requires its own independently authenticated production adapter.
 */
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {PHASE_E_HARVESTER,PHASE_E_POLICY} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {splitResourceEarnings} from '@shardkeep/shared/phaseEResourceTax';
import {hashExpeditionTermSnapshot,parseExpeditionTermObservation,type ExpeditionTermObservation} from '../game/expeditionTerms';
// Same frozen resource-tax v1 economics, not a Mine/source/base/day lineage.
export const SHARDS_TAX_LINEAGE='d150-resource-tax-v1' as const;
const V1=PHASE_E_HARVESTER.v1,policy=Object.freeze({lineage:SHARDS_TAX_LINEAGE,version:V1.taxPolicyVersion,basisPoints:V1.taxBasisPoints,islandPoolBps:V1.islandPoolBps});
const quantity=z.bigint().min(0n).max(RAW_RESOURCE_STORAGE_MAX),hash=z.string().regex(/^[0-9a-f]{64}$/),uuid=z.uuid().refine(v=>v===v.toLowerCase());
const text=z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/);
const wallet=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const instant=z.string().length(24).datetime({precision:3}).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const earning=z.discriminatedUnion('kind',[z.object({kind:z.literal('instant'),at:instant}).strict(),z.object({kind:z.literal('interval'),startsAt:instant,endsAt:instant}).strict().refine(v=>v.startsAt<v.endsAt)]);
const authority=z.discriminatedUnion('classification',[z.object({classification:z.literal('new_earning'),decisionRef:text,evidenceSha256:hash}).strict(),z.object({classification:z.literal('unresolved')}).strict()]).nullable();
const sourceSchema=z.object({version:z.literal(1),kind:z.enum(['physical_mine','legacy_mine','daily_cache','legacy_daily_cache','campaign_first_three_star','legacy_campaign_first_three_star','obstacle_reward','quest_reward','quest_daily_bonus','league_weekly_cache','starter_grant','starter_topup','development_funding','mail_reward_reserve','gems_conversion','keep_conversion','existing_value_transfer','refund','mail_claim','mail_expiry','tax_receipt','custody_cutover']),key:text,wallet,baseId:uuid.nullable(),gross:quantity,earning,authority,ledger:z.object({transactionId:uuid,idempotencyKey:text}).strict()}).strict();
const carrySchema=z.object({wallet,currency:z.literal('SHARDS'),lineage:z.literal(SHARDS_TAX_LINEAGE),sequence:quantity,value:z.bigint().min(0n).max(BigInt(V1.taxBasisPoints)-1n)}).strict();
export type ShardsTaxSource=z.infer<typeof sourceSchema>;
export type ShardsTaxCarry=z.infer<typeof carrySchema>;
// Bootstrap allocations, corrections of the original starter grant and guarded
// development funding are not gameplay earnings. Issuance alone cannot turn
// them into production or let caller-supplied authority opt them into tax.
const excluded=new Set<ShardsTaxSource['kind']>(['starter_grant','starter_topup','development_funding','gems_conversion','keep_conversion','existing_value_transfer','refund','mail_claim','mail_expiry','tax_receipt','custody_cutover']);
// Owner-exempt reward sources never enter the resource-tax lineage, even with
// caller-supplied new-earning authority. Mail delivery stays a value movement.
const taxExempt=new Set<ShardsTaxSource['kind']>(['campaign_first_three_star','legacy_campaign_first_three_star','quest_reward','quest_daily_bonus','mail_reward_reserve','daily_cache','legacy_daily_cache','obstacle_reward','league_weekly_cache']);
// Legacy Mine earning boundaries still lack independent source authority. A
// caller's arbitrary decisionRef cannot resolve that historical evidence gap.
const unresolved=new Set<ShardsTaxSource['kind']>(['legacy_mine']);
function need(value:unknown,message:string):asserts value{if(!value)throw Error(`Invalid SHARDS tax attribution: ${message}`);}
function exact(value:unknown,fields:string):Record<string,unknown>{need(value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'fields');const names=fields.split(' '),keys=Reflect.ownKeys(value);need(keys.length===names.length&&keys.every(k=>typeof k==='string'&&names.includes(k)&&'value' in Object.getOwnPropertyDescriptor(value,k)!),'fields');return value as Record<string,unknown>;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const canonical=(value:unknown):string=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);
/** A parsed source is an owned statement, never a verified earning capability. */
export function parseShardsTaxSource(raw:unknown):ShardsTaxSource{
 const value=exact(raw,'version kind key wallet baseId gross earning authority ledger');const e=value.earning as {kind?:unknown};exact(e,e?.kind==='instant'?'kind at':'kind startsAt endsAt');exact(value.ledger,'transactionId idempotencyKey');if(value.authority!==null){const a=value.authority as {classification?:unknown};exact(a,a?.classification==='new_earning'?'classification decisionRef evidenceSha256':'classification');}
 return freeze(sourceSchema.parse(value));
}
function carry(raw:unknown,w:string){const c=carrySchema.parse(exact(raw,'wallet currency lineage sequence value'));need(c.wallet===w,'carry original wallet');return freeze(c);}
function originalTerm(raw:unknown,source:ShardsTaxSource):ExpeditionTermObservation{
 const at=source.earning.kind==='instant'?source.earning.at:source.earning.startsAt,term=parseExpeditionTermObservation(raw,at);
 if(source.earning.kind==='interval')need(source.earning.endsAt<=term.snapshot.endsAt,'interval must be segmented at original term boundary');
 return term;
}
function amounts(gross:bigint,prior:bigint){
 // Current composition reuses the accepted kernel. Historical replay below
 // uses the frozen v1 numerator, so later tuning cannot reprice old receipts.
 need(PHASE_E_POLICY.basisPoints===V1.taxBasisPoints&&PHASE_E_POLICY.taxes.resources.islandPoolBps===V1.islandPoolBps,'current policy differs from frozen lineage');
 return splitResourceEarnings(gross,prior);
}
export interface ShardsTaxAttributionReceipt{
 version:1;source:ShardsTaxSource;term:ExpeditionTermObservation;termHash:string;policy:typeof policy;carryBefore:ShardsTaxCarry;carryAfter:ShardsTaxCarry;net:bigint;tax:bigint;
 pool:{termId:string;termHash:string;winnerCount:number;amount:bigint;disposition:'original_winning_spots'|'held_zero_winners'};
 sourceVerified:false;postingAuthorized:false;payoutAuthorized:false;
}
type HoldReason='SOURCE_AUTHORITY_REQUIRED'|'SOURCE_POLICY_UNRESOLVED'|'SOURCE_TAX_EXEMPT'|'NOT_NEW_EARNING'|'TERM_AUTHORITY_REQUIRED';
export type ShardsTaxAttribution={status:'held';reason:HoldReason;carry:ShardsTaxCarry;receipt:null;sourceVerified:false;postingAuthorized:false;payoutAuthorized:false}|{status:'attributed';receipt:ShardsTaxAttributionReceipt;sourceVerified:false;postingAuthorized:false;payoutAuthorized:false};
/** Pure composition of explicitly supplied fixture/internal facts. Physical
 * Mine candidates still need their own reviewed original
 * time/owner/term adapters; this function does not admit any issuer by kind. A
 * Mine segment is the earning once, regardless of later collect/raid delivery.
 * An interval must already have a single earner and original term; no inferred
 * proration of a legacy aggregate buffer or later-owner substitution occurs. */
export function evaluateShardsTaxAttribution(input:unknown):ShardsTaxAttribution{
 const r=exact(input,'source term carry'),source=parseShardsTaxSource(r.source),before=carry(r.carry,source.wallet);
 const held=(reason:HoldReason):ShardsTaxAttribution=>freeze({status:'held',reason,carry:before,receipt:null,sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});
 if(excluded.has(source.kind))return held('NOT_NEW_EARNING');
 if(taxExempt.has(source.kind))return held('SOURCE_TAX_EXEMPT');
 if(!source.authority||source.authority.classification!=='new_earning')return held('SOURCE_AUTHORITY_REQUIRED');
 if(unresolved.has(source.kind))return held('SOURCE_POLICY_UNRESOLVED');
 if(r.term===null||r.term===undefined)return held('TERM_AUTHORITY_REQUIRED');
 const term=originalTerm(r.term,source),termHash=hashExpeditionTermSnapshot(term.snapshot),winnerCount=term.snapshot.spots.filter(s=>s.ownerWallet!==null).length;
 need(before.sequence<RAW_RESOURCE_STORAGE_MAX,'carry sequence overflow');const split=amounts(source.gross,before.value),after={...before,sequence:before.sequence+1n,value:split.nextCarry};
 const receipt:ShardsTaxAttributionReceipt={version:1,source,term,termHash,policy:{...policy},carryBefore:before,carryAfter:after,net:split.net,tax:split.tax,pool:{termId:term.snapshot.termId,termHash,winnerCount,amount:split.tax,disposition:winnerCount?'original_winning_spots':'held_zero_winners'},sourceVerified:false,postingAuthorized:false,payoutAuthorized:false};
 return freeze({status:'attributed',receipt,sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});
}
/** Validate an existing exact source receipt, not a new event. No current carry,
 * winner reader, mutable owner, clock or posting callback is accepted. Caller
 * must obtain expectedSource and the stored receipt independently; this is an
 * integrity check, not authentication against maliciously supplied JSON. */
export function replayShardsTaxAttribution(raw:unknown,expectedSource:unknown):ShardsTaxAttributionReceipt{
 const r=exact(raw,'version source term termHash policy carryBefore carryAfter net tax pool sourceVerified postingAuthorized payoutAuthorized'),source=parseShardsTaxSource(r.source),expected=parseShardsTaxSource(expectedSource);
 need(canonical(source)===canonical(expected),'original source differs');need(r.version===1&&r.sourceVerified===false&&r.postingAuthorized===false&&r.payoutAuthorized===false,'receipt authority');
 // Frozen v1 historical admissions survive D-153.196's prospective cache exemption.
 // Independent history readers still authenticate the original source and posting.
 need((source.kind==='physical_mine'||source.kind==='daily_cache')&&source.authority?.classification==='new_earning','original source classification');
 const p=exact(r.policy,'lineage version basisPoints islandPoolBps');need(Object.entries(policy).every(([name,value])=>p[name]===value),'frozen policy');
 const before=carry(r.carryBefore,source.wallet),after=carry(r.carryAfter,source.wallet),term=originalTerm(r.term,source),termHash=hashExpeditionTermSnapshot(term.snapshot),winnerCount=term.snapshot.spots.filter(s=>s.ownerWallet!==null).length;
 const numerator=source.gross*BigInt(policy.islandPoolBps)+before.value,tax=numerator/BigInt(policy.basisPoints),net=source.gross-tax;
 need(hash.parse(r.termHash)===termHash&&before.sequence<RAW_RESOURCE_STORAGE_MAX&&after.sequence===before.sequence+1n&&after.value===numerator%BigInt(policy.basisPoints)&&quantity.parse(r.net)===net&&quantity.parse(r.tax)===tax,'original arithmetic or term');
 const pool=exact(r.pool,'termId termHash winnerCount amount disposition');need(pool.termId===term.snapshot.termId&&pool.termHash===termHash&&pool.winnerCount===winnerCount&&pool.amount===tax&&pool.disposition===(winnerCount?'original_winning_spots':'held_zero_winners'),'original pool');
 return freeze({version:1,source,term,termHash,policy:{...policy},carryBefore:before,carryAfter:after,net,tax,pool:{termId:term.snapshot.termId,termHash,winnerCount,amount:tax,disposition:winnerCount?'original_winning_spots':'held_zero_winners'},sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});
}
