/** Complete post-zero Gems source. The account existed before coverage; its
 * committed empty inventory is authenticated without inventing an account birth. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {readGemsZeroOpeningIntervalInTransaction,replayGemsZeroOpening,type GemsZeroOpeningEvidence} from './gemsZeroOpening';
import {replayExistingMiningWalletInterval,type ExistingMiningWalletIntervalEvidence} from './existingMiningWallet';
import {attributePostZeroGemsFlowEvidence} from './gemsFlowAttribution';
import type {GemsFlowFact} from './gemsFlowEvidence';
import {derivePostZeroGemsSinkUseEvidence,type PostZeroGemsSinkUseEvidence} from './gemsSinkUseEvidence';
import {createPostZeroGemsFinalizedOriginReader,replayPostZeroGemsFinalizedOrigins,type GemsFinalizedOriginWiring,type PostZeroFinalizedGemsOrigins} from './gemsFinalizedOrigins';
import {composePostZeroGemsContribution} from './gemsContribution';
const MAX_ROWS=10_000,MAX_BYTES=16_777_216,MAX_ROW_BYTES=1_048_576,MAX_AMOUNT=9_223_372_036_854_775_807n,DAY_MS=86_400_000;
type Code='INVALID_INPUT'|'DAY_OPEN'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'COVERAGE_UNAVAILABLE'|'TOO_LARGE'|'BUSY';
export class GemsPostZeroError extends Error{constructor(readonly code:Code){super(`Gems post-zero source refused: ${code}`);this.name='GemsPostZeroError';}}
function fail(code:Code):never{throw new GemsPostZeroError(code);}
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const positive=z.string().regex(/^[1-9]\d{0,19}$/),integer=z.string().regex(/^-?(0|[1-9]\d{0,18})$/);
function canonical(value:string,digits:3|6){const pattern=digits===3?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;if(!pattern.test(value))return false;const ms=value.slice(0,23)+'Z',n=Date.parse(ms);return Number.isFinite(n)&&new Date(n).toISOString()===ms;}
const timestamp=z.string().refine(v=>canonical(v,6)),instant=z.string().refine(v=>canonical(v,3));
const requestSchema=z.object({wallet:key,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),openingId:z.uuid()}).strict();
const receiptLegSchema=z.object({id:positive,accountId:z.uuid(),delta:integer,kind:z.string(),currency:z.string(),wallet:key.nullable(),baseId:z.uuid().nullable()}).strict();
const receiptSchema=z.array(receiptLegSchema).max(32);
const postingSchema=z.object({
 entry:z.object({id:positive,txnId:z.uuid(),accountId:z.uuid(),delta:integer}).strict(),
 account:z.object({id:z.uuid(),kind:z.literal('player_gems'),currency:z.literal('GEMS'),wallet:key,baseId:z.null()}).strict(),
 transaction:z.object({id:z.uuid(),key:z.string().min(1),type:z.string().min(1),metadata:z.record(z.string(),z.unknown()),createdAt:timestamp}).strict(),
}).strict();
const eventSchema=z.object({id:positive,wallet:key,observedAt:timestamp,transactionMarker:positive,sourceTable:z.enum(['accounts','ledger_transactions','ledger_entries']),sourceId:z.string().min(1),operation:z.enum(['INSERT','UPDATE','DELETE']),accountId:z.uuid().nullable(),transactionId:z.uuid().nullable(),before:z.unknown(),source:z.unknown(),receipt:receiptSchema,receiptComplete:z.literal(true)}).strict();
const groupRowSchema=z.object({id:positive,wallet:key,observedAt:timestamp,transactionMarker:positive,receiptComplete:z.literal(true)}).strict();

const evidenceSchema=requestSchema.extend({version:z.literal(2),sourcePolicyVersion:z.literal(2),sourceKind:z.literal('committed-zero-inventory-fifo'),transactionVisibility:z.literal('whole-db-transaction-at-last-observation'),opening:z.unknown(),identity:z.unknown(),startsAt:instant,endsAt:instant,coverageStartedAt:timestamp,accountId:z.uuid(),events:z.array(eventSchema).max(MAX_ROWS),groupRows:z.array(groupRowSchema).max(MAX_ROWS),facts:z.array(z.unknown()).max(MAX_ROWS),netGems:z.string().regex(/^(0|[1-9]\d{0,18})$/),sourceDigest:z.string().regex(/^[0-9a-f]{64}$/),eligibilityAuthorized:z.literal(false),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type GemsPostZeroFlow=Omit<z.infer<typeof evidenceSchema>,'opening'|'identity'|'facts'>&{opening:GemsZeroOpeningEvidence;identity:ExistingMiningWalletIntervalEvidence;facts:GemsFlowFact[]};
const micros=(v:string)=>v.replace('Z','000Z');
function range(day:string){const startsAt=`${day}T00:00:00.000Z`,n=Date.parse(startsAt);if(!Number.isFinite(n)||new Date(n).toISOString()!==startsAt)fail('INVALID_INPUT');return {startsAt,endsAt:new Date(n+DAY_MS).toISOString()};}
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const p=schema.safeParse(value);return p.success?p.data:fail(code);}
function amount(value:string){const n=BigInt(value);if(n< -MAX_AMOUNT||n>MAX_AMOUNT||value==='-0')fail('SOURCE_CONFLICT');return n;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** Bound and copy ordinary JSON before parsing; no accessors, prototypes, cycles
 * or retained caller references may become a trusted immutable source record. */
function copy(value:unknown):unknown{
 let bytes=0,nodes=0;const seen=new WeakSet<object>();
 function visit(v:unknown,depth:number):unknown{
  if(++nodes>1_000_000||depth>32)fail('TOO_LARGE');
  if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(v.length>MAX_ROW_BYTES)fail('TOO_LARGE');}
  else if(typeof v==='number'){if(!Number.isFinite(v))fail('SOURCE_CONFLICT');bytes+=24;}
  else if(v===null||typeof v==='boolean')bytes+=5;
  else if(typeof v==='object'){
   if(seen.has(v))fail('SOURCE_CONFLICT');seen.add(v);
   if(Object.getOwnPropertySymbols(v).length)fail('SOURCE_CONFLICT');
   if(Array.isArray(v)){if(v.length>MAX_ROWS)fail('TOO_LARGE');const descriptors=Object.getOwnPropertyDescriptors(v);if(Object.keys(descriptors).length!==v.length+1)fail('SOURCE_CONFLICT');const result:unknown[]=[];for(let i=0;i<v.length;i++){const d=descriptors[String(i)];if(!d||!d.enumerable||!('value'in d))fail('SOURCE_CONFLICT');result.push(visit(d.value,depth+1));}seen.delete(v);return result;}
   if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)fail('SOURCE_CONFLICT');
   const result:Record<string,unknown>={};for(const [name,d] of Object.entries(Object.getOwnPropertyDescriptors(v))){if(!d.enumerable||!('value'in d))fail('SOURCE_CONFLICT');bytes+=Buffer.byteLength(name);Object.defineProperty(result,name,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});}seen.delete(v);return result;
  }else fail('SOURCE_CONFLICT');
  if(bytes>MAX_BYTES)fail('TOO_LARGE');return v;
 }const result=visit(value,0);if(bytes>MAX_BYTES)fail('TOO_LARGE');return result;
}

function canonicalJson(v:unknown):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonicalJson).join(',')+']';const r=v as Record<string,unknown>;return '{'+Object.keys(r).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(r[k])).join(',')+'}';}
function digest(p:Omit<GemsPostZeroFlow,'sourceDigest'>){return createHash('sha256').update('SHARDKEEP:MINING:GEMS:POST-ZERO:1\n').update(canonicalJson(p)).digest('hex');}
function derive(p:Omit<z.infer<typeof evidenceSchema>,'sourceDigest'>){
 const opening=replayGemsZeroOpening(p.opening),identity=replayExistingMiningWalletInterval(p.identity),expected=range(p.day),end=micros(p.endsAt),frontier=BigInt(opening.flowEventFrontier);
 if(p.wallet!==opening.wallet||p.openingId!==opening.id||p.accountId!==opening.account.id||p.coverageStartedAt!==opening.observedAt||p.day<opening.firstEligibleDay||identity.wallet!==p.wallet||identity.day!==p.day||identity.baselineId!==opening.baselineId||canonicalJson(identity.baseline)!==canonicalJson(opening.baseline)||p.startsAt!==expected.startsAt||p.endsAt!==expected.endsAt||p.startsAt!==identity.startsAt||p.endsAt!==identity.endsAt)fail('SOURCE_CONFLICT');
 if(identity.observedAt<end)fail('DAY_OPEN');
 const events=new Map(p.events.map(e=>[e.id,e])),markers=new Set(p.events.map(e=>e.transactionMarker)),groups=new Map<string,string>(),matched=new Set<string>();
 if(events.size!==p.events.length)fail('SOURCE_CONFLICT');let prior=frontier;
 for(const e of p.events){if(BigInt(e.id)<=prior||e.wallet!==p.wallet||e.observedAt<opening.observedAt||e.observedAt>identity.observedAt||e.sourceTable!=='ledger_entries'||e.operation!=='INSERT'||e.before!==null||e.accountId!==p.accountId)fail('SOURCE_CONFLICT');prior=BigInt(e.id);}
 prior=0n;for(const g of p.groupRows){if(BigInt(g.id)<=prior||BigInt(g.id)<=frontier||!markers.has(g.transactionMarker)||g.observedAt<opening.observedAt||g.observedAt>identity.observedAt)fail('SOURCE_CONFLICT');prior=BigInt(g.id);
  const previous=groups.get(g.transactionMarker);if(previous&&g.observedAt<previous)fail('SOURCE_CONFLICT');groups.set(g.transactionMarker,g.observedAt);
  if(g.wallet===p.wallet){const e=events.get(g.id);if(!e||e.observedAt!==g.observedAt||e.transactionMarker!==g.transactionMarker)fail('SOURCE_CONFLICT');matched.add(g.id);}
 }
 if(matched.size!==events.size||groups.size!==markers.size)fail('SOURCE_CONFLICT');
 let net=0n;const facts:GemsFlowFact[]=[];
 for(const e of p.events){const effective=groups.get(e.transactionMarker)!;
  if(e.observedAt<end&&effective>=end)fail('SOURCE_CONFLICT');
  const s=parse(postingSchema,e.source),delta=amount(s.entry.delta),receipt=e.receipt;
  if(s.entry.id!==e.sourceId||s.entry.accountId!==p.accountId||s.entry.txnId!==e.transactionId||s.account.id!==p.accountId||s.account.wallet!==p.wallet||s.transaction.id!==e.transactionId||BigInt(s.entry.id)<=BigInt(opening.ledgerEntryFrontier)||receipt.some(r=>BigInt(r.id)<=BigInt(opening.ledgerEntryFrontier)))fail('SOURCE_CONFLICT');
  // Even later source records must have intact accounting; unsupported origin
  // classifications are interpreted only when their complete group is visible.
  let rp=0n;const accounts=new Set<string>(),sums=new Map<string,bigint>();for(const r of receipt){if(BigInt(r.id)<=rp||accounts.has(r.accountId)||amount(r.delta)===0n)fail('SOURCE_CONFLICT');rp=BigInt(r.id);accounts.add(r.accountId);sums.set(r.currency,(sums.get(r.currency)??0n)+amount(r.delta));}
  const own=receipt.find(r=>r.id===s.entry.id);if(receipt.length<2||!own||own.accountId!==p.accountId||own.delta!==s.entry.delta||own.kind!=='player_gems'||own.currency!=='GEMS'||own.wallet!==p.wallet||own.baseId!==null||[...sums.values()].some(n=>n!==0n)||delta===0n)fail('SOURCE_CONFLICT');
  if(effective>=end)continue;
  const classification:GemsFlowFact['classification']=delta>0n?s.transaction.type==='gems.grant'?'grant':s.transaction.type==='gems.from_keep'?'custodial-conversion':s.transaction.type==='gems.buy'?'wallet-conversion-ledger':s.transaction.type.endsWith('.system_refund')?'sink-refund':'unclassified':s.transaction.type==='gems.to_shards'?'excluded-gems-to-shards':'system-spend';
  net+=delta;facts.push({id:e.id,observedAt:e.observedAt,effectiveObservedAt:effective,transactionMarker:e.transactionMarker,sourceTable:e.sourceTable,sourceId:e.sourceId,operation:e.operation,accountId:e.accountId,transactionId:e.transactionId,classification,source:s,before:null,receipt});
 }
 facts.sort((a,b)=>a.effectiveObservedAt.localeCompare(b.effectiveObservedAt)||(BigInt(a.transactionMarker)<BigInt(b.transactionMarker)?-1:BigInt(a.transactionMarker)>BigInt(b.transactionMarker)?1:BigInt(a.id)<BigInt(b.id)?-1:1));
 const result={...p,opening,identity,facts,netGems:net.toString()};attributePostZeroGemsFlowEvidence(result);return result;
}
/** Pure retained replay authenticates no database on its own. It rebuilds every
 * visible fact, source binding and FIFO input from the admitted copied source. */
export function replayGemsPostZeroFlow(value:unknown):GemsPostZeroFlow{
 const p=parse(evidenceSchema,copy(value)),{sourceDigest,...source}=p,derived=derive(source);
 if(canonicalJson(p.facts)!==canonicalJson(derived.facts)||p.netGems!==derived.netGems||sourceDigest!==digest(derived))fail('SOURCE_CONFLICT');return freeze({...derived,sourceDigest});
}
function mapError(error:unknown):never{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){if('code'in e){if(e.code==='55P03')fail('BUSY');if(e.code==='57014'||e.code==='42501')fail('SOURCE_UNAVAILABLE');}e='cause'in e?e.cause:undefined;}throw error;}
export async function readGemsPostZeroFlow(db:Db,input:unknown):Promise<GemsPostZeroFlow>{
 if('rollback'in db)fail('INVALID_INPUT');const request=parse(requestSchema,input,'INVALID_INPUT');range(request.day);
 try{return await db.transaction(async tx=>{
  const {opening,identity}=await readGemsZeroOpeningIntervalInTransaction(tx,request),frontier=opening.flowEventFrontier;
  const [size]=await tx.execute<{n:number;bytes:string;largest:string}>(sql`select count(*)::int n,coalesce(sum(bytes),0)::text bytes,coalesce(max(bytes),0)::text largest from(select octet_length(to_jsonb(e)::text) bytes from public.mining_gems_flow_events e where wallet=${request.wallet} and id>${frontier}::bigint order by id limit ${MAX_ROWS+1}) bounded_wallet`);
  if(!size)fail('SOURCE_UNAVAILABLE');if(size.n>MAX_ROWS||BigInt(size.bytes)>BigInt(MAX_BYTES)||BigInt(size.largest)>BigInt(MAX_ROW_BYTES))fail('TOO_LARGE');
  const [groupSize]=await tx.execute<{n:number}>(sql`with markers as(select distinct transaction_marker from public.mining_gems_flow_events where wallet=${request.wallet} and id>${frontier}::bigint) select count(*)::int n from(select e.id from public.mining_gems_flow_events e join markers m using(transaction_marker) order by e.id limit ${MAX_ROWS+1}) bounded_groups`);
  if(!groupSize)fail('SOURCE_UNAVAILABLE');if(groupSize.n>MAX_ROWS)fail('TOO_LARGE');
  const rows=await tx.execute<{value:unknown}>(sql`select jsonb_build_object('id',id::text,'wallet',wallet,'observedAt',to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'transactionMarker',transaction_marker::text,'sourceTable',source_table,'sourceId',source_id,'operation',operation,'accountId',account_id,'transactionId',transaction_id,'before',before_state,'source',after_state,'receipt',receipt,'receiptComplete',receipt_complete) value from public.mining_gems_flow_events where wallet=${request.wallet} and id>${frontier}::bigint order by id limit ${MAX_ROWS+1}`);
  const groupRows=await tx.execute<{value:unknown}>(sql`with markers as(select distinct transaction_marker from public.mining_gems_flow_events where wallet=${request.wallet} and id>${frontier}::bigint) select jsonb_build_object('id',e.id::text,'wallet',e.wallet,'observedAt',to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'transactionMarker',e.transaction_marker::text,'receiptComplete',e.receipt_complete) value from public.mining_gems_flow_events e join markers m using(transaction_marker) order by e.id limit ${MAX_ROWS+1}`);
  if(rows.length!==size.n||groupRows.length!==groupSize.n)fail('SOURCE_CONFLICT');
  const source=derive({...request,...range(request.day),version:2,sourcePolicyVersion:2,sourceKind:'committed-zero-inventory-fifo',transactionVisibility:'whole-db-transaction-at-last-observation',opening,identity,accountId:opening.account.id,coverageStartedAt:opening.observedAt,events:parse(z.array(eventSchema).max(MAX_ROWS),rows.map(r=>r.value)),groupRows:parse(z.array(groupRowSchema).max(MAX_ROWS),groupRows.map(r=>r.value)),facts:[],netGems:'0',eligibilityAuthorized:false,allocationAuthorized:false,publicationAuthorized:false});
  return replayGemsPostZeroFlow({...source,sourceDigest:digest(source)});
 });}catch(e){return mapError(e);}
}
const bundleSchema=requestSchema.extend({version:z.literal(1),sourceKind:z.literal('committed-zero-inventory-fifo'),flow:z.unknown(),use:z.unknown(),origins:z.unknown(),result:z.unknown(),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type GemsPostZeroContribution=Omit<z.infer<typeof bundleSchema>,'flow'|'use'|'origins'|'result'>&{flow:GemsPostZeroFlow;use:PostZeroGemsSinkUseEvidence;origins:PostZeroFinalizedGemsOrigins;result:ReturnType<typeof composePostZeroGemsContribution>};
export function replayGemsPostZeroContribution(value:unknown):GemsPostZeroContribution{
 const p=parse(bundleSchema,copy(value)),flow=replayGemsPostZeroFlow(p.flow);
 if(p.wallet!==flow.wallet||p.day!==flow.day||p.openingId!==flow.openingId)fail('SOURCE_CONFLICT');
 const use=derivePostZeroGemsSinkUseEvidence(flow,flow.sourceDigest),origins=replayPostZeroGemsFinalizedOrigins(p.origins,flow,flow.sourceDigest),result=composePostZeroGemsContribution(use,origins);
 if(canonicalJson(p.use)!==canonicalJson(use)||canonicalJson(p.result)!==canonicalJson(result))fail('SOURCE_CONFLICT');return freeze({...p,flow,use,origins,result});
}
export function createGemsPostZeroContributionReader(db:Db,wiring:GemsFinalizedOriginWiring){
 const readOrigins=createPostZeroGemsFinalizedOriginReader(db,wiring);
 return async(input:unknown):Promise<GemsPostZeroContribution>=>{
  const flow=await readGemsPostZeroFlow(db,input),use=derivePostZeroGemsSinkUseEvidence(flow,flow.sourceDigest),origins=await readOrigins(flow,flow.sourceDigest),result=composePostZeroGemsContribution(use,origins);
  return replayGemsPostZeroContribution({version:1,sourceKind:'committed-zero-inventory-fifo',wallet:flow.wallet,day:flow.day,openingId:flow.openingId,flow,use,origins,result,allocationAuthorized:false,publicationAuthorized:false});
 };
}
