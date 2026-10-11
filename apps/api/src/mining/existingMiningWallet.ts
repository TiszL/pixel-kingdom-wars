/** Explicit present identity and future interval; no historical birth, Gems origin
 * or XP is manufactured. Live DB authority is separate from copied replay. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
const DAY_MS=86_400_000,MAX_BYTES=1_048_576;
type Code='DISABLED'|'INVALID_INPUT'|'DAY_OPEN'|'COVERAGE_UNAVAILABLE'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'BUSY'|'TOO_LARGE';
export class ExistingMiningWalletError extends Error{constructor(readonly code:Code){super(`Existing mining wallet refused: ${code}`);this.name='ExistingMiningWalletError';}}
function fail(code:Code):never{throw new ExistingMiningWalletError(code);}
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
function canonical(v:string,digits:3|6){const re=digits===3?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;if(!re.test(v))return false;const ms=v.slice(0,23)+'Z';return Number.isFinite(Date.parse(ms))&&new Date(ms).toISOString()===ms;}
const timestamp=z.string().refine(v=>canonical(v,6)),instant=z.string().refine(v=>canonical(v,3));
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const t=Date.parse(v+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;});
const ordinal=z.string().regex(/^(0|[1-9]\d{0,19})$/),positive=z.string().regex(/^[1-9]\d{0,19}$/);
const player=z.object({wallet:key,createdAt:timestamp}).strict();
const baselineSchema=z.object({id:z.uuid(),wallet:key,observedAt:timestamp,firstEligibleDay:day,firstActivityDay:day,identityCoverageStartedAt:timestamp,activityCoverageStartedAt:timestamp,flowCoverageStartedAt:timestamp,identityEventFrontier:ordinal,flowEventFrontier:ordinal,flowBirthEventFloor:ordinal,sourceSeal:z.string().regex(/^[0-9a-f]{64}$/),player}).strict();
export type ExistingMiningWalletBaseline=z.infer<typeof baselineSchema>;
const eventState=z.object({wallet:key,created_at:timestamp}).strict();
const eventSchema=z.object({id:positive,wallet:key,observedAt:timestamp,sourceTable:z.literal('players'),sourceId:key,operation:z.enum(['INSERT','UPDATE','DELETE']),beforeState:eventState.nullable(),afterState:eventState.nullable()}).strict();
const requestSchema=z.object({wallet:key,day,baselineId:z.uuid()}).strict();
const authority={historicalBirth:'unknown' as const,openingGems:'unknown' as const,eligibilityAuthorized:false as const,allocationAuthorized:false as const,publicationAuthorized:false as const};
const evidenceSchema=requestSchema.extend({version:z.literal(1),purpose:z.literal('existing_mining_wallet_interval'),startsAt:instant,endsAt:instant,observedAt:timestamp,baseline:baselineSchema,identityEvents:z.array(eventSchema).max(1),historicalBirth:z.literal('unknown'),openingGems:z.literal('unknown'),eligibilityAuthorized:z.literal(false),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type ExistingMiningWalletIntervalEvidence=z.infer<typeof evidenceSchema>;
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const p=schema.safeParse(value);if(!p.success)fail(code);return p.data;}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
const micros=(v:string)=>v.slice(0,-1)+'000Z';
function nextDay(v:string){return new Date(Date.parse(v.slice(0,10)+'T00:00:00Z')+DAY_MS).toISOString().slice(0,10);}
function range(v:string){return {startsAt:v+'T00:00:00.000Z',endsAt:nextDay(v)+'T00:00:00.000Z'};}
function baseline(value:unknown){const b=parse(baselineSchema,value);
 if(b.player.wallet!==b.wallet||b.player.createdAt>=b.activityCoverageStartedAt||b.identityCoverageStartedAt>b.flowCoverageStartedAt
 ||[b.identityCoverageStartedAt,b.activityCoverageStartedAt,b.flowCoverageStartedAt].some(at=>at>b.observedAt)
 ||b.firstEligibleDay!==nextDay(b.observedAt)||b.firstActivityDay!==(b.activityCoverageStartedAt.endsWith('T00:00:00.000000Z')?b.activityCoverageStartedAt.slice(0,10):nextDay(b.activityCoverageStartedAt))
 ||BigInt(b.flowBirthEventFloor)>BigInt(b.identityEventFrontier))fail('SOURCE_CONFLICT');return b;
}
export function replayExistingMiningWalletInterval(value:unknown):ExistingMiningWalletIntervalEvidence{
 const p=parse(evidenceSchema,value),b=baseline(p.baseline),r=range(p.day);
 if(p.wallet!==b.wallet||p.baselineId!==b.id||p.startsAt!==r.startsAt||p.endsAt!==r.endsAt||p.day<b.firstEligibleDay||p.day<b.firstActivityDay
 ||p.observedAt<micros(r.endsAt)||p.observedAt<b.observedAt)fail('SOURCE_CONFLICT');
 for(const e of p.identityEvents){if(BigInt(e.id)>BigInt(b.identityEventFrontier)||e.wallet!==p.wallet||e.sourceId!==p.wallet||e.operation!=='INSERT'||e.beforeState!==null
 ||e.afterState?.wallet!==p.wallet||e.afterState.created_at!==b.player.createdAt||e.observedAt<b.identityCoverageStartedAt||e.observedAt>b.observedAt)fail('SOURCE_CONFLICT');}
 return freeze(p);
}
function mapError(error:unknown):never{let e=error;for(let i=0;i<8&&e&&typeof e==='object';i++){
 if('code'in e){if(e.code==='55P03')fail('BUSY');if(e.code==='57014'||e.code==='42501')fail('SOURCE_UNAVAILABLE');if(e.code==='22007'||e.code==='22008')fail('SOURCE_CONFLICT');}
 if('message'in e&&typeof e.message==='string'&&e.message.startsWith('MINING_EXISTING_WALLET_')){if(/SOURCE_UNAVAILABLE|FRESH_TRANSACTION|READ_COMMITTED/.test(e.message))fail('SOURCE_UNAVAILABLE');if(/COVERAGE_UNAVAILABLE|IDENTITY_UNAVAILABLE/.test(e.message))fail('COVERAGE_UNAVAILABLE');}
 e='cause'in e?e.cause:undefined;
 }throw error;}
export type ExistingMiningWalletTransaction=Parameters<Parameters<Db['transaction']>[0]>[0];
async function barrier(tx:ExistingMiningWalletTransaction){
 await tx.execute(sql`set local statement_timeout='2000ms'`);
 await tx.execute(sql`lock table public.players,public.accounts,public.ledger_transactions,public.ledger_entries,
 public.mining_free_coverage,public.mining_free_cohort_events,public.mining_gems_flow_coverage,public.mining_gems_flow_events,
 public.playtest_activity_coverage,public.mining_activity_evidence,public.mining_wallet_experience_days,public.mining_wallet_experience_awards,
 public.mining_existing_wallet_baselines,public.mining_existing_wallet_contract in share mode nowait`);
 const [row]=await tx.execute<{at:string;valid:boolean;fresh:boolean}>(sql`select to_char(public.shardkeep_mining_free_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,
 public.shardkeep_mining_existing_wallet_sources_valid() valid,not exists(select 1 from pg_locks where pid=pg_backend_pid() and granted and mode='RowExclusiveLock' and relation in
 ('public.players'::regclass,'public.accounts'::regclass,'public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,
 'public.mining_free_coverage'::regclass,'public.mining_free_cohort_events'::regclass,'public.mining_gems_flow_coverage'::regclass,'public.mining_gems_flow_events'::regclass,
 'public.playtest_activity_coverage'::regclass,'public.mining_activity_evidence'::regclass,'public.mining_wallet_experience_days'::regclass,'public.mining_wallet_experience_awards'::regclass,
 'public.mining_existing_wallet_baselines'::regclass,'public.mining_existing_wallet_contract'::regclass)) fresh`);
 if(row?.valid!==true||row.fresh!==true)fail('SOURCE_UNAVAILABLE');return parse(timestamp,row.at);
}
const baselineRequest=z.object({wallet:key,baselineId:z.uuid().optional()}).strict();
async function retained(tx:ExistingMiningWalletTransaction,input:z.infer<typeof baselineRequest>):Promise<ExistingMiningWalletBaseline|null>{
 const [row]=await tx.execute<{value:unknown;valid:boolean}>(sql`select jsonb_build_object('id',b.id,'wallet',b.wallet,
 'observedAt',to_char(b.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'firstEligibleDay',b.first_eligible_day::text,'firstActivityDay',b.first_activity_day::text,
 'identityCoverageStartedAt',to_char(b.identity_coverage_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'activityCoverageStartedAt',to_char(b.activity_coverage_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'flowCoverageStartedAt',to_char(b.flow_coverage_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'identityEventFrontier',b.identity_event_frontier::text,'flowEventFrontier',b.flow_event_frontier::text,'flowBirthEventFloor',b.flow_birth_event_floor::text,'sourceSeal',b.source_seal,'player',b.player) value,
 (b.identity_coverage_started_at=i.started_at and b.activity_coverage_started_at=a.started_at and b.flow_coverage_started_at=g.started_at and b.flow_birth_event_floor=g.birth_event_floor
 and p.created_at=(b.player->>'createdAt')::timestamptz and b.source_seal=encode(sha256(convert_to(c.record::text,'UTF8')),'hex')) is true valid
 from public.mining_existing_wallet_baselines b left join public.players p on p.wallet=b.wallet left join public.mining_free_coverage i on i.id left join public.playtest_activity_coverage a on a.key='authoritative-v1'
 left join public.mining_gems_flow_coverage g on g.id left join public.mining_existing_wallet_contract c on c.singleton where b.wallet=${input.wallet}
 and ${input.baselineId?sql`b.id=${input.baselineId}::uuid`:sql`true`}`);
 if(!row)return null;if(!row.valid)fail('COVERAGE_UNAVAILABLE');return baseline(row.value);
}
function normalize(field:'before_state'|'after_state'){const c=sql.raw(`e.${field}`);return sql`case when ${c} is null then null else ${c}||jsonb_build_object('created_at',to_char((${c}->>'created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end`;}
async function identityEvents(tx:ExistingMiningWalletTransaction,b:ExistingMiningWalletBaseline){
 const [size]=await tx.execute<{n:number;bytes:string}>(sql`select count(*)::int n,coalesce(sum(octet_length(to_jsonb(e)::text)),0)::text bytes from
 (select * from public.mining_free_cohort_events where wallet=${b.wallet} and source_table='players' order by id limit 2) e`);
 if(!size)fail('SOURCE_UNAVAILABLE');if(size.n>1)fail('COVERAGE_UNAVAILABLE');if(BigInt(size.bytes)>BigInt(MAX_BYTES))fail('TOO_LARGE');
 const rows=await tx.execute<{value:unknown}>(sql`select jsonb_build_object('id',e.id::text,'wallet',e.wallet,'observedAt',to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'sourceTable',e.source_table,'sourceId',e.source_id,'operation',e.operation,'beforeState',${normalize('before_state')},'afterState',${normalize('after_state')}) value
 from public.mining_free_cohort_events e where e.wallet=${b.wallet} and e.source_table='players' order by e.id limit 2`);
 if(rows.length!==size.n)fail('SOURCE_CONFLICT');const events=rows.map(r=>parse(eventSchema,r.value));
 for(const e of events)if(BigInt(e.id)>BigInt(b.identityEventFrontier)||e.operation!=='INSERT'||e.beforeState!==null||e.afterState?.wallet!==b.wallet||e.afterState.created_at!==b.player.createdAt||e.sourceId!==b.wallet||e.observedAt<b.identityCoverageStartedAt||e.observedAt>b.observedAt)fail('COVERAGE_UNAVAILABLE');return events;
}
export async function captureExistingMiningWallet(db:Db,wallet:string):Promise<void>{
 if('rollback'in db||!key.safeParse(wallet).success)fail('INVALID_INPUT');if(!phaseEMiningEnabled())fail('DISABLED');
 try{await db.transaction(async tx=>{if(!phaseEMiningEnabled())fail('DISABLED');await tx.execute(sql`insert into public.mining_existing_wallet_baselines(wallet) values(${wallet}) on conflict(wallet) do nothing`);if(!phaseEMiningEnabled())fail('DISABLED');});}catch(e){mapError(e);}
}
export async function readExistingMiningWalletBaseline(db:Db,input:unknown):Promise<ExistingMiningWalletBaseline>{
 if('rollback'in db)fail('INVALID_INPUT');const r=parse(baselineRequest,input,'INVALID_INPUT');
 try{return await db.transaction(async tx=>{const at=await barrier(tx),b=await retained(tx,r);if(!b||b.observedAt>at)fail('COVERAGE_UNAVAILABLE');await identityEvents(tx,b);return freeze(b);});}catch(e){return mapError(e);}
}
/** Private locator: an existing but invalid source never degrades to absence. */
export async function lookupExistingMiningWalletBaseline(db:Db,input:unknown):Promise<string|null>{
 if('rollback'in db)fail('INVALID_INPUT');const r=parse(z.object({wallet:key,day}).strict(),input,'INVALID_INPUT');
 try{return await db.transaction(async tx=>{const at=await barrier(tx),b=await retained(tx,r);if(!b)return null;if(b.observedAt>at)fail('COVERAGE_UNAVAILABLE');await identityEvents(tx,b);return r.day<b.firstEligibleDay?null:b.id;});}catch(e){return mapError(e);}
}
/** Internal paired source reader. Caller must preserve this same transaction's
 * barriers through its Gems/activity sampling; copied evidence is not admission. */
export async function readExistingMiningWalletIntervalInTransaction(tx:ExistingMiningWalletTransaction,input:unknown):Promise<ExistingMiningWalletIntervalEvidence>{
 const r=parse(requestSchema,input,'INVALID_INPUT'),at=await barrier(tx),b=await retained(tx,r);if(!b)fail('COVERAGE_UNAVAILABLE');const bounds=range(r.day);
 if(at<micros(bounds.endsAt))fail('DAY_OPEN');if(r.day<b.firstEligibleDay||r.day<b.firstActivityDay||b.observedAt>at)fail('COVERAGE_UNAVAILABLE');
 return replayExistingMiningWalletInterval({...r,...bounds,version:1,purpose:'existing_mining_wallet_interval',observedAt:at,baseline:b,identityEvents:await identityEvents(tx,b),...authority});
}
export async function readExistingMiningWalletInterval(db:Db,input:unknown):Promise<ExistingMiningWalletIntervalEvidence>{
 if('rollback'in db)fail('INVALID_INPUT');try{return await db.transaction(tx=>readExistingMiningWalletIntervalInTransaction(tx,input));}catch(e){return mapError(e);}
}
