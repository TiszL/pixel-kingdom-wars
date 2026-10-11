/** Committed real empty Gems inventory. Prior credit origins remain unknown;
 * this private boundary never spends, rewrites a balance or fabricates birth. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {readExistingMiningWalletBaseline,readExistingMiningWalletIntervalInTransaction,type ExistingMiningWalletBaseline,type ExistingMiningWalletIntervalEvidence,type ExistingMiningWalletTransaction} from './existingMiningWallet';
const MAX_ROWS=10_000,MAX_BYTES=16_777_216,MAX_ROW_BYTES=1_048_576,MAX_AMOUNT=9_223_372_036_854_775_807n,DAY_MS=86_400_000;
type Code='INVALID_INPUT'|'DISABLED'|'BUSY'|'DAY_OPEN'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'COVERAGE_UNAVAILABLE'|'NONZERO'|'TOO_LARGE';
export class GemsZeroOpeningError extends Error{constructor(readonly code:Code){super(`Gems zero opening refused: ${code}`);this.name='GemsZeroOpeningError';}}
function fail(code:Code):never{throw new GemsZeroOpeningError(code);}
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}}),ordinal=z.string().regex(/^(0|[1-9]\d{0,19})$/),positive=z.string().regex(/^[1-9]\d{0,19}$/),integer=z.string().regex(/^-?(0|[1-9]\d{0,18})$/),hash=z.string().regex(/^[0-9a-f]{64}$/);
const timestamp=z.string().refine(v=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.slice(0,23)+'Z');
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
const baselineSchema=z.object({id:z.uuid(),wallet:key,observedAt:timestamp,firstEligibleDay:day,firstActivityDay:day,identityCoverageStartedAt:timestamp,activityCoverageStartedAt:timestamp,flowCoverageStartedAt:timestamp,identityEventFrontier:ordinal,flowEventFrontier:ordinal,flowBirthEventFloor:ordinal,sourceSeal:hash,player:z.object({wallet:key,createdAt:timestamp}).strict()}).strict();
const leg=z.object({id:positive,accountId:z.uuid(),delta:integer,kind:z.string().min(1),currency:z.string().min(1),wallet:key.nullable(),baseId:z.uuid().nullable()}).strict();
const posting=z.object({entry:z.object({id:positive,txnId:z.uuid(),accountId:z.uuid(),delta:integer}).strict(),transaction:z.object({id:z.uuid(),key:z.string().min(1),type:z.string().min(1),metadata:z.record(z.string(),z.unknown()),createdAt:timestamp}).strict(),receipt:z.array(leg).min(2).max(32)}).strict();
const evidenceSchema=z.object({version:z.literal(1),purpose:z.literal('gems_zero_opening'),id:z.uuid(),wallet:key,baselineId:z.uuid(),baseline:baselineSchema,
 account:z.object({id:z.uuid(),kind:z.literal('player_gems'),currency:z.literal('GEMS'),wallet:key,baseId:z.null(),balance:z.literal('0')}).strict(),observedAt:timestamp,firstEligibleDay:day,
 flowCoverageStartedAt:timestamp,flowBirthEventFloor:ordinal,flowEventFrontier:ordinal,ledgerEntryFrontier:ordinal,sourceSeal:hash,ledger:z.array(posting).max(MAX_ROWS),eligibilityAuthorized:z.literal(false),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type GemsZeroOpeningEvidence=z.infer<typeof evidenceSchema>;
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const p=schema.safeParse(value);return p.success?p.data:fail(code);}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
function copy(value:unknown):unknown{let bytes=0,nodes=0;const seen=new WeakSet<object>();function visit(v:unknown,depth:number):unknown{
 if(++nodes>1_000_000||depth>32)fail('TOO_LARGE');if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(v.length>MAX_ROW_BYTES)fail('TOO_LARGE');}else if(typeof v==='number'){if(!Number.isFinite(v))fail('SOURCE_CONFLICT');bytes+=24;}else if(v===null||typeof v==='boolean')bytes+=5;
 else if(typeof v==='object'){if(seen.has(v)||Object.getOwnPropertySymbols(v).length)fail('SOURCE_CONFLICT');seen.add(v);const d=Object.getOwnPropertyDescriptors(v);
 if(Array.isArray(v)){if(v.length>MAX_ROWS||Object.keys(d).length!==v.length+1)fail('TOO_LARGE');return Array.from({length:v.length},(_,i)=>{const a=d[String(i)];if(!a||!a.enumerable||!('value'in a))fail('SOURCE_CONFLICT');return visit(a.value,depth+1);});}
 if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)fail('SOURCE_CONFLICT');const out:Record<string,unknown>={};for(const [k,a]of Object.entries(d)){if(!a.enumerable||!('value'in a))fail('SOURCE_CONFLICT');bytes+=Buffer.byteLength(k);Object.defineProperty(out,k,{value:visit(a.value,depth+1),enumerable:true,writable:true,configurable:true});}return out;
 }else fail('SOURCE_CONFLICT');if(bytes>MAX_BYTES)fail('TOO_LARGE');return v;}const result=visit(value,0);if(bytes>MAX_BYTES)fail('TOO_LARGE');return result;}
function amount(value:string){const n=BigInt(value);if(n>MAX_AMOUNT||n< -MAX_AMOUNT||value==='-0')fail('SOURCE_CONFLICT');return n;}
const nextDay=(v:string)=>new Date(Date.parse(v.slice(0,10)+'T00:00:00Z')+DAY_MS).toISOString().slice(0,10);
/** Copied replay proves internal consistency, never substitutes for DB admission. */
export function replayGemsZeroOpening(value:unknown):GemsZeroOpeningEvidence{
 const p=parse(evidenceSchema,copy(value)),b=p.baseline;
 if(p.wallet!==b.wallet||p.baselineId!==b.id||p.account.wallet!==p.wallet||b.player.wallet!==p.wallet||b.player.createdAt>=b.activityCoverageStartedAt||b.identityCoverageStartedAt>b.flowCoverageStartedAt
 ||[b.identityCoverageStartedAt,b.activityCoverageStartedAt,b.flowCoverageStartedAt].some(t=>t>b.observedAt)||p.observedAt<b.observedAt
 ||b.firstEligibleDay!==nextDay(b.observedAt)||b.firstActivityDay!==(b.activityCoverageStartedAt.endsWith('T00:00:00.000000Z')?b.activityCoverageStartedAt.slice(0,10):nextDay(b.activityCoverageStartedAt))
 ||p.firstEligibleDay!==[nextDay(p.observedAt),b.firstEligibleDay,b.firstActivityDay].sort().at(-1)||p.flowCoverageStartedAt!==b.flowCoverageStartedAt||p.flowBirthEventFloor!==b.flowBirthEventFloor
 ||BigInt(p.flowEventFrontier)<BigInt(b.flowEventFrontier)||BigInt(b.flowBirthEventFloor)>BigInt(b.identityEventFrontier))fail('SOURCE_CONFLICT');
 let prior=0n,total=0n;const txs=new Set<string>();
 for(const l of p.ledger){const e=l.entry;if(BigInt(e.id)<=prior||BigInt(e.id)>BigInt(p.ledgerEntryFrontier)||e.accountId!==p.account.id||e.txnId!==l.transaction.id||txs.has(e.txnId))fail('SOURCE_CONFLICT');prior=BigInt(e.id);txs.add(e.txnId);
 const delta=amount(e.delta);if(delta===0n)fail('SOURCE_CONFLICT');total+=delta;let receiptPrior=0n;const accounts=new Set<string>(),sums=new Map<string,bigint>();for(const r of l.receipt){if(BigInt(r.id)<=receiptPrior||BigInt(r.id)>BigInt(p.ledgerEntryFrontier)||accounts.has(r.accountId)||amount(r.delta)===0n)fail('SOURCE_CONFLICT');receiptPrior=BigInt(r.id);accounts.add(r.accountId);sums.set(r.currency,(sums.get(r.currency)??0n)+amount(r.delta));}
 const own=l.receipt.find(r=>r.id===e.id);if(!own||own.accountId!==e.accountId||own.delta!==e.delta||own.kind!=='player_gems'||own.currency!=='GEMS'||own.wallet!==p.wallet||own.baseId!==null||[...sums.values()].some(v=>v!==0n))fail('SOURCE_CONFLICT');
 }if(total!==0n)fail('NONZERO');return freeze(p);
}
function mapError(error:unknown):never{let e=error;for(let i=0;i<8&&e&&typeof e==='object';i++){if('code'in e){if(e.code==='55P03')fail('BUSY');if(e.code==='42501'||e.code==='57014')fail('SOURCE_UNAVAILABLE');}
 if('message'in e&&typeof e.message==='string'&&e.message.startsWith('MINING_GEMS_ZERO_')){if(/NONZERO/.test(e.message))fail('NONZERO');if(/TOO_LARGE/.test(e.message))fail('TOO_LARGE');if(/SOURCE_UNAVAILABLE|FRESH_TRANSACTION|READ_COMMITTED/.test(e.message))fail('SOURCE_UNAVAILABLE');fail('SOURCE_CONFLICT');}e='cause'in e?e.cause:undefined;}throw error;}
// Inherited children do not inherit the source capture/immutability triggers.
// Keep this canonical-relation check under the same locks as every source read;
// accepted SQL seals remain immutable and do not admit schema drift by themselves.
const SOURCE_RELATIONS=['players','accounts','ledger_transactions','ledger_entries','mining_free_coverage','mining_free_cohort_events',
 'mining_gems_flow_coverage','mining_gems_flow_events','mining_existing_wallet_baselines','mining_existing_wallet_contract',
 'playtest_activity_coverage','mining_activity_evidence','mining_wallet_experience_days','mining_wallet_experience_awards','mining_gems_zero_openings','mining_gems_zero_contract'] as const;
async function barrier(tx:ExistingMiningWalletTransaction){await tx.execute(sql`set local statement_timeout='2000ms'`);
 await tx.execute(sql`lock table public.players,public.accounts,public.ledger_transactions,public.ledger_entries,public.mining_free_coverage,public.mining_free_cohort_events,
 public.mining_gems_flow_coverage,public.mining_gems_flow_events,public.mining_existing_wallet_baselines,public.mining_existing_wallet_contract,public.playtest_activity_coverage,public.mining_activity_evidence,
 public.mining_wallet_experience_days,public.mining_wallet_experience_awards,public.mining_gems_zero_openings,public.mining_gems_zero_contract in share mode nowait`);
 const [s]=await tx.execute<{valid:boolean;fresh:boolean;canonical:boolean;at:string}>(sql`select public.shardkeep_mining_gems_zero_sources_valid() valid,
 (select count(*)=${sql.raw(String(SOURCE_RELATIONS.length))} from pg_class c where c.relnamespace='public'::regnamespace and c.relname in (select jsonb_array_elements_text(${JSON.stringify(SOURCE_RELATIONS)}::jsonb)) and c.relkind='r' and c.relpersistence='p' and not c.relrowsecurity and not c.relforcerowsecurity and not c.relhassubclass and not c.relhasrules) canonical,
 not exists(select 1 from pg_locks where pid=pg_backend_pid() and granted and mode='RowExclusiveLock' and relation in('public.players'::regclass,'public.accounts'::regclass,'public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,
 'public.mining_free_coverage'::regclass,'public.mining_free_cohort_events'::regclass,'public.mining_gems_flow_coverage'::regclass,'public.mining_gems_flow_events'::regclass,'public.mining_existing_wallet_baselines'::regclass,'public.mining_existing_wallet_contract'::regclass,
 'public.playtest_activity_coverage'::regclass,'public.mining_activity_evidence'::regclass,'public.mining_wallet_experience_days'::regclass,'public.mining_wallet_experience_awards'::regclass,'public.mining_gems_zero_openings'::regclass,'public.mining_gems_zero_contract'::regclass)) fresh,
 to_char(public.shardkeep_mining_free_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`);if(s?.valid!==true||s.fresh!==true||s.canonical!==true)fail('SOURCE_UNAVAILABLE');return parse(timestamp,s.at);}
const readSchema=z.object({wallet:key,openingId:z.uuid()}).strict();
async function retained(tx:ExistingMiningWalletTransaction,r:z.infer<typeof readSchema>,at:string){
 const [row]=await tx.execute<{evidence:unknown;valid:boolean}>(sql`select o.evidence,
 (o.id::text=o.evidence->>'id' and o.wallet=o.evidence->>'wallet' and o.baseline_id::text=o.evidence->>'baselineId'
 and o.evidence->>'sourceSeal'=(select encode(sha256(convert_to(record::text,'UTF8')),'hex') from public.mining_gems_zero_contract where singleton)
 and a.id::text=o.evidence->'account'->>'id' and a.owner_wallet=o.wallet and a.kind='player_gems' and a.currency='GEMS' and a.base_id is null
 and public.shardkeep_mining_gems_zero_ledger(a.id,(o.evidence->>'ledgerEntryFrontier')::bigint)=o.evidence->'ledger'
 and not exists(select 1 from public.mining_gems_flow_events e where e.wallet=o.wallet and (e.operation<>'INSERT' or e.before_state is not null or not e.receipt_complete or e.id>(o.evidence->>'flowEventFrontier')::bigint and e.observed_at<(o.evidence->>'observedAt')::timestamptz))) is true valid
 from public.mining_gems_zero_openings o left join public.accounts a on a.id=(o.evidence->'account'->>'id')::uuid where o.wallet=${r.wallet} and o.id=${r.openingId}::uuid`);
 if(!row)fail('COVERAGE_UNAVAILABLE');if(!row.valid)fail('SOURCE_CONFLICT');const opening=replayGemsZeroOpening(row.evidence);if(opening.observedAt>at)fail('COVERAGE_UNAVAILABLE');return opening;
}
function sameBaseline(a:ExistingMiningWalletBaseline,b:ExistingMiningWalletBaseline){for(const k of Object.keys(a) as (keyof ExistingMiningWalletBaseline)[]){if(k==='player'){if(a.player.wallet!==b.player.wallet||a.player.createdAt!==b.player.createdAt)fail('SOURCE_CONFLICT');}else if(a[k]!==b[k])fail('SOURCE_CONFLICT');}}
export async function captureGemsZeroOpening(db:Db,input:unknown):Promise<void>{if('rollback'in db)fail('INVALID_INPUT');const r=parse(z.object({wallet:key,baselineId:z.uuid()}).strict(),input,'INVALID_INPUT');if(!phaseEMiningEnabled())fail('DISABLED');
 // Authenticate the original identity before entering the guarded fresh insert;
 // the trigger repeats its committed source and identity checks under locks.
 await readExistingMiningWalletBaseline(db,r);
 try{await db.transaction(async tx=>{if(!phaseEMiningEnabled())fail('DISABLED');await barrier(tx);await tx.execute(sql`insert into public.mining_gems_zero_openings(wallet,baseline_id) values(${r.wallet},${r.baselineId}::uuid) on conflict(wallet) do nothing`);if(!phaseEMiningEnabled())fail('DISABLED');});}catch(e){mapError(e);}}
export async function readGemsZeroOpening(db:Db,input:unknown):Promise<GemsZeroOpeningEvidence>{if('rollback'in db)fail('INVALID_INPUT');const r=parse(readSchema,input,'INVALID_INPUT');
 try{return await db.transaction(async tx=>{const at=await barrier(tx),opening=await retained(tx,r,at);
 const [b]=await tx.execute<{valid:boolean}>(sql`select (b.wallet=${r.wallet} and b.source_seal=${opening.baseline.sourceSeal} and b.observed_at=${opening.baseline.observedAt}::timestamptz and p.created_at=(b.player->>'createdAt')::timestamptz
 and exists(select 1 from public.mining_free_coverage where id and started_at=b.identity_coverage_started_at)
 and exists(select 1 from public.playtest_activity_coverage where key='authoritative-v1' and started_at=b.activity_coverage_started_at)
 and exists(select 1 from public.mining_gems_flow_coverage where id and started_at=b.flow_coverage_started_at and birth_event_floor=b.flow_birth_event_floor)
 and not exists(select 1 from public.mining_free_cohort_events where wallet=b.wallet and source_table='players' and (id>b.identity_event_frontier or operation<>'INSERT'))) is true valid from public.mining_existing_wallet_baselines b left join public.players p on p.wallet=b.wallet where b.id=${opening.baselineId}::uuid`);
 if(b?.valid!==true)fail('SOURCE_CONFLICT');return opening;});}catch(e){return mapError(e);}}
/** Paired flow source retains these locks through complete flow/group sampling. */
export async function readGemsZeroOpeningIntervalInTransaction(tx:ExistingMiningWalletTransaction,input:unknown):Promise<{opening:GemsZeroOpeningEvidence;identity:ExistingMiningWalletIntervalEvidence}>{
 const r=parse(readSchema.extend({day}).strict(),input,'INVALID_INPUT');const at=await barrier(tx),opening=await retained(tx,r,at);
 if(r.day<opening.firstEligibleDay)fail('COVERAGE_UNAVAILABLE');const identity=await readExistingMiningWalletIntervalInTransaction(tx,{wallet:r.wallet,day:r.day,baselineId:opening.baselineId});sameBaseline(opening.baseline,identity.baseline);return {opening,identity};
}
