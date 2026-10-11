/** A complete covered day with no Gems debit. Opening balances and all credit
 * origins remain unknown; this source never confers free-cohort authority. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {readExistingMiningWalletIntervalInTransaction,replayExistingMiningWalletInterval,type ExistingMiningWalletIntervalEvidence} from './existingMiningWallet';

// Source resource ceilings, not economy or eligibility values.
const MAX_ROWS=10_000,MAX_BYTES=16_777_216,MAX_ROW_BYTES=1_048_576,MAX_AMOUNT=9_223_372_036_854_775_807n,DAY_MS=86_400_000;
type Code='INVALID_INPUT'|'DAY_OPEN'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'COVERAGE_UNAVAILABLE'|'DEBIT_PRESENT'|'TOO_LARGE'|'BUSY';
export class GemsNoDebitEvidenceError extends Error{constructor(readonly code:Code){super(`Gems no-debit evidence refused: ${code}`);this.name='GemsNoDebitEvidenceError';}}
function fail(code:Code):never{throw new GemsNoDebitEvidenceError(code);}
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const positive=z.string().regex(/^[1-9]\d{0,19}$/),integer=z.string().regex(/^-?(0|[1-9]\d{0,18})$/);
function canonical(value:string,digits:3|6){const pattern=digits===3?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;if(!pattern.test(value))return false;const ms=value.slice(0,23)+'Z',n=Date.parse(ms);return Number.isFinite(n)&&new Date(n).toISOString()===ms;}
const timestamp=z.string().refine(v=>canonical(v,6)),instant=z.string().refine(v=>canonical(v,3));
const requestSchema=z.object({wallet:key,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),baselineId:z.uuid()}).strict();
const receiptLegSchema=z.object({id:positive,accountId:z.uuid(),delta:integer,kind:z.string(),currency:z.string(),wallet:key.nullable(),baseId:z.uuid().nullable()}).strict();
const receiptSchema=z.array(receiptLegSchema).max(32);
const postingSchema=z.object({
 entry:z.object({id:positive,txnId:z.uuid(),accountId:z.uuid(),delta:integer}).strict(),
 account:z.object({id:z.uuid(),kind:z.literal('player_gems'),currency:z.literal('GEMS'),wallet:key,baseId:z.null()}).strict(),
 transaction:z.object({id:z.uuid(),key:z.string().min(1),type:z.string().min(1),metadata:z.record(z.string(),z.unknown()),createdAt:timestamp}).strict(),
}).strict();
const accountSchema=z.object({id:z.uuid(),kind:z.literal('player_gems'),currency:z.literal('GEMS'),owner_wallet:key,base_id:z.null(),initialBalance:integer}).strict();
const factSchema=z.object({id:positive,wallet:key,observedAt:timestamp,transactionMarker:positive,sourceTable:z.enum(['accounts','ledger_transactions','ledger_entries']),sourceId:z.string().min(1),operation:z.enum(['INSERT','UPDATE','DELETE']),accountId:z.uuid().nullable(),transactionId:z.uuid().nullable(),before:z.unknown(),source:z.unknown(),receipt:receiptSchema,receiptComplete:z.literal(true)}).strict();
const groupRowSchema=z.object({id:positive,wallet:key,observedAt:timestamp,transactionMarker:positive,receiptComplete:z.literal(true)}).strict();
const evidenceSchema=requestSchema.extend({version:z.literal(1),sourceKind:z.literal('committed-existing-wallet-no-debit'),transactionVisibility:z.literal('whole-db-transaction-at-last-observation'),identity:z.unknown(),startsAt:instant,endsAt:instant,facts:z.array(factSchema).max(MAX_ROWS),groupRows:z.array(groupRowSchema).max(MAX_ROWS),sourceRowsSha256:z.string().regex(/^[0-9a-f]{64}$/),openingGems:z.literal('unknown'),creditOrigins:z.literal('unknown'),debitCount:z.literal(0),contribution:z.literal('0'),eligibilityAuthorized:z.literal(false),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type GemsNoDebitEvidence=Omit<z.infer<typeof evidenceSchema>,'identity'>&{identity:ExistingMiningWalletIntervalEvidence};
type Fact=z.infer<typeof factSchema>;type GroupRow=z.infer<typeof groupRowSchema>;
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
   if(Array.isArray(v)){if(v.length>MAX_ROWS)fail('TOO_LARGE');const descriptors=Object.getOwnPropertyDescriptors(v);if(Object.keys(descriptors).length!==v.length+1)fail('SOURCE_CONFLICT');const result:unknown[]=[];for(let i=0;i<v.length;i++){const d=descriptors[String(i)];if(!d||!d.enumerable||!('value'in d))fail('SOURCE_CONFLICT');result.push(visit(d.value,depth+1));}return result;}
   if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)fail('SOURCE_CONFLICT');
   const result:Record<string,unknown>={};for(const [name,d] of Object.entries(Object.getOwnPropertyDescriptors(v))){if(!d.enumerable||!('value'in d))fail('SOURCE_CONFLICT');bytes+=Buffer.byteLength(name);Object.defineProperty(result,name,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});}return result;
  }else fail('SOURCE_CONFLICT');
  if(bytes>MAX_BYTES)fail('TOO_LARGE');return v;
 }const result=visit(value,0);if(bytes>MAX_BYTES)fail('TOO_LARGE');return result;
}
function rowDigest(p:Pick<GemsNoDebitEvidence,'wallet'|'day'|'baselineId'|'facts'|'groupRows'>,identity:ExistingMiningWalletIntervalEvidence){return createHash('sha256').update('SHARDKEEP:MINING:GEMS:NO-DEBIT:1\n').update(JSON.stringify({wallet:p.wallet,day:p.day,baselineId:p.baselineId,sourceSeal:identity.baseline.sourceSeal,facts:p.facts,groupRows:p.groupRows})).digest('hex');}
function checkPosting(f:Fact,wallet:string):bigint{
 const p=parse(postingSchema,f.source),r=f.receipt;
 if(p.entry.id!==f.sourceId||p.entry.accountId!==f.accountId||p.entry.txnId!==f.transactionId||p.account.id!==f.accountId||p.account.wallet!==wallet||p.transaction.id!==f.transactionId)fail('SOURCE_CONFLICT');
 if(r.length<2||new Set(r.map(x=>x.id)).size!==r.length||new Set(r.map(x=>x.accountId)).size!==r.length)fail('SOURCE_CONFLICT');
 let prior=0n;const sums=new Map<string,bigint>();for(const e of r){if(BigInt(e.id)<=prior)fail('SOURCE_CONFLICT');prior=BigInt(e.id);sums.set(e.currency,(sums.get(e.currency)??0n)+amount(e.delta));}
 if([...sums.values()].some(n=>n!==0n))fail('SOURCE_CONFLICT');
 const own=r.find(e=>e.id===p.entry.id);if(!own||own.accountId!==f.accountId||own.delta!==p.entry.delta||own.kind!=='player_gems'||own.currency!=='GEMS'||own.wallet!==wallet||own.baseId!==null)fail('SOURCE_CONFLICT');
 const delta=amount(p.entry.delta);if(delta===0n)fail('SOURCE_CONFLICT');return delta;
}
/** Pure retained replay is not DB authentication. Only the private live reader
 * establishes source completeness under the committed baseline's sealed graph. */
export function replayGemsNoDebitEvidence(value:unknown):GemsNoDebitEvidence{
 const p=parse(evidenceSchema,copy(value)),identity=replayExistingMiningWalletInterval(p.identity),b=identity.baseline,expected=range(p.day),start=micros(p.startsAt),end=micros(p.endsAt);
 if(p.wallet!==identity.wallet||p.day!==identity.day||p.baselineId!==identity.baselineId||p.startsAt!==expected.startsAt||p.endsAt!==expected.endsAt||p.startsAt!==identity.startsAt||p.endsAt!==identity.endsAt)fail('SOURCE_CONFLICT');
 if(identity.observedAt<end)fail('DAY_OPEN');if(b.flowCoverageStartedAt>start)fail('COVERAGE_UNAVAILABLE');
 const facts=new Map(p.facts.map(f=>[f.id,f])),markers=new Set(p.facts.map(f=>f.transactionMarker)),groups=new Map<string,string>(),committedGroups=new Map<string,boolean>(),frontier=BigInt(b.flowEventFrontier);
 if(facts.size!==p.facts.length)fail('SOURCE_CONFLICT');let prior=0n;
 for(const f of p.facts){
  if(BigInt(f.id)<=prior||f.wallet!==p.wallet||f.observedAt<b.flowCoverageStartedAt||f.observedAt>identity.observedAt||(BigInt(f.id)>frontier?f.observedAt<b.observedAt:f.observedAt>b.observedAt))fail('SOURCE_CONFLICT');
  prior=BigInt(f.id);if(f.before!==null||f.operation!=='INSERT')fail('SOURCE_CONFLICT');
 }
 prior=0n;const matched=new Set<string>();for(const g of p.groupRows){
  if(BigInt(g.id)<=prior||!markers.has(g.transactionMarker)||g.observedAt<b.flowCoverageStartedAt||g.observedAt>identity.observedAt)fail('SOURCE_CONFLICT');prior=BigInt(g.id);
  const previous=groups.get(g.transactionMarker);if(previous&&g.observedAt<previous)fail('SOURCE_CONFLICT');groups.set(g.transactionMarker,g.observedAt);
  const committed=BigInt(g.id)<=frontier,priorCommit=committedGroups.get(g.transactionMarker);if(priorCommit!==undefined&&priorCommit!==committed||(committed?g.observedAt>b.observedAt:g.observedAt<b.observedAt))fail('SOURCE_CONFLICT');committedGroups.set(g.transactionMarker,committed);
  if(g.wallet===p.wallet){const f=facts.get(g.id);if(!f||f.observedAt!==g.observedAt||f.transactionMarker!==g.transactionMarker)fail('SOURCE_CONFLICT');matched.add(g.id);}
 }
 if(matched.size!==facts.size||groups.size!==markers.size)fail('SOURCE_CONFLICT');
 for(const f of p.facts){
  const effective=groups.get(f.transactionMarker)!;
  // A candidate touching the requested interval cannot be silently omitted when
  // a foreign-wallet event moves completion beyond its cutoff.
  if(f.observedAt<end&&effective>=end)fail('SOURCE_CONFLICT');
  if(f.sourceTable==='accounts'){
   const a=parse(accountSchema,f.source);if(a.id!==f.accountId||a.id!==f.sourceId||a.owner_wallet!==p.wallet||f.transactionId!==null||f.receipt.length!==0||amount(a.initialBalance)<0n)fail('SOURCE_CONFLICT');
  }else if(f.sourceTable==='ledger_entries'){
   const delta=checkPosting(f,p.wallet);if(delta<0n&&effective>=start&&effective<end)fail('DEBIT_PRESENT');
  }else fail('SOURCE_CONFLICT');
 }
 if(p.sourceRowsSha256!==rowDigest(p,identity))fail('SOURCE_CONFLICT');return freeze({...p,identity});
}
function mapError(error:unknown):never{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){if('code'in e){if(e.code==='55P03')fail('BUSY');if(e.code==='57014'||e.code==='42501')fail('SOURCE_UNAVAILABLE');}e='cause'in e?e.cause:undefined;}throw error;}
/** Owner-only, fresh transaction, sealed sources and explicit committed baseline.
 * Source rows are bounded before JSON decoding or cross-wallet group reads. */
export async function readGemsNoDebitEvidence(db:Db,input:unknown):Promise<GemsNoDebitEvidence>{
 if('rollback'in db)fail('INVALID_INPUT');const request=parse(requestSchema,input,'INVALID_INPUT');range(request.day);
 try{return await db.transaction(async tx=>{
  // This internal reader holds the complete identity/ledger/flow/source-seal
  // barrier and checks owner, origin, isolation and fresh-transaction custody.
  const identity=await readExistingMiningWalletIntervalInTransaction(tx,request);
  const [size]=await tx.execute<{n:number;bytes:string;largest:string}>(sql`select count(*)::int n,coalesce(sum(bytes),0)::text bytes,coalesce(max(bytes),0)::text largest from(select octet_length(to_jsonb(e)::text) bytes from public.mining_gems_flow_events e where wallet=${request.wallet} order by id limit ${MAX_ROWS+1}) bounded_wallet`);
  if(!size)fail('SOURCE_UNAVAILABLE');if(size.n>MAX_ROWS||BigInt(size.bytes)>BigInt(MAX_BYTES)||BigInt(size.largest)>BigInt(MAX_ROW_BYTES))fail('TOO_LARGE');
  const [groupSize]=await tx.execute<{n:number}>(sql`with markers as(select distinct transaction_marker from public.mining_gems_flow_events where wallet=${request.wallet}) select count(*)::int n from(select e.id from public.mining_gems_flow_events e join markers m using(transaction_marker) order by e.id limit ${MAX_ROWS+1}) bounded_groups`);
  if(!groupSize)fail('SOURCE_UNAVAILABLE');if(groupSize.n>MAX_ROWS)fail('TOO_LARGE');
  const rows=await tx.execute<{value:unknown}>(sql`select jsonb_build_object('id',id::text,'wallet',wallet,'observedAt',to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'transactionMarker',transaction_marker::text,'sourceTable',source_table,'sourceId',source_id,'operation',operation,'accountId',account_id,'transactionId',transaction_id,'before',before_state,'source',after_state,'receipt',receipt,'receiptComplete',receipt_complete) value from public.mining_gems_flow_events where wallet=${request.wallet} order by id limit ${MAX_ROWS+1}`);
  const groupRows=await tx.execute<{value:unknown}>(sql`with markers as(select distinct transaction_marker from public.mining_gems_flow_events where wallet=${request.wallet}) select jsonb_build_object('id',e.id::text,'wallet',e.wallet,'observedAt',to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'transactionMarker',e.transaction_marker::text,'receiptComplete',e.receipt_complete) value from public.mining_gems_flow_events e join markers m using(transaction_marker) order by e.id limit ${MAX_ROWS+1}`);
  if(rows.length!==size.n||groupRows.length!==groupSize.n)fail('SOURCE_CONFLICT');
  const facts=parse(z.array(factSchema).max(MAX_ROWS),rows.map(r=>r.value)),groups=parse(z.array(groupRowSchema).max(MAX_ROWS),groupRows.map(r=>r.value));
  const result={...request,...range(request.day),version:1 as const,sourceKind:'committed-existing-wallet-no-debit' as const,transactionVisibility:'whole-db-transaction-at-last-observation' as const,identity,facts,groupRows:groups,sourceRowsSha256:'',openingGems:'unknown' as const,creditOrigins:'unknown' as const,debitCount:0 as const,contribution:'0' as const,eligibilityAuthorized:false as const,allocationAuthorized:false as const,publicationAuthorized:false as const};
  result.sourceRowsSha256=rowDigest(result,identity);return replayGemsNoDebitEvidence(result);
 });}catch(error){return mapError(error);}
}
