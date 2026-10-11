/** Private committed prospective baseline. Enrollment alone establishes no chain
 * holding, birth history, eligibility or bonus authority. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
const MAX_ROWS=10_000,MAX_BYTES=8_388_608,DAY_MS=86_400_000;
type Code='DISABLED'|'INVALID_INPUT'|'DAY_OPEN'|'COVERAGE_UNAVAILABLE'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'TOO_LARGE'|'BUSY';
export class MiningSeekerEnrollmentError extends Error{constructor(readonly code:Code){super(`Mining Seeker enrollment refused: ${code}`);this.name='MiningSeekerEnrollmentError';}}
function fail(code:Code):never{throw new MiningSeekerEnrollmentError(code);}
const key=z.string().min(32).max(44).refine(value=>{try{return new PublicKey(value).toBase58()===value;}catch{return false;}});
const positive=z.string().regex(/^[1-9]\d{0,19}$/),ordinal=z.string().regex(/^(0|[1-9]\d{0,19})$/);
function canonical(value:string,digits:3|6){const pattern=digits===3?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;if(!pattern.test(value))return false;const ms=value.slice(0,23)+'Z',at=Date.parse(ms);return Number.isFinite(at)&&new Date(at).toISOString()===ms;}
const timestamp=z.string().refine(value=>canonical(value,6)),instant=z.string().refine(value=>canonical(value,3));
const birthSchema=z.object({wallet:key,created_at:timestamp}).strict();
const linkSchema=z.object({wallet:key,seeker_wallet:key,sgt_mint:key,revoked_at:timestamp.nullable()}).strict();
const activeLinkSchema=linkSchema.extend({revoked_at:z.null()});
const stateSchema=z.union([birthSchema,linkSchema]);
const requestSchema=z.object({wallet:key,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),enrollmentId:z.uuid()}).strict();
const eventSchema=z.object({id:positive,wallet:key,observedAt:timestamp,sourceTable:z.enum(['players','seeker_links']),sourceId:key,operation:z.enum(['INSERT','UPDATE','DELETE']),beforeState:stateSchema.nullable(),afterState:stateSchema.nullable()}).strict();
const enrollmentSchema=z.object({id:z.uuid(),wallet:key,observedAt:timestamp,nonce:z.string().regex(/^[0-9a-f]{64}$/),eventFrontier:ordinal,coverageStartedAt:timestamp,recordedHistoryStartedAt:timestamp,birthEventFloor:ordinal,sourceSeal:z.string().regex(/^[0-9a-f]{64}$/),player:birthSchema,link:activeLinkSchema}).strict();
export type MiningSeekerEnrollment=z.infer<typeof enrollmentSchema>;
const unknownAuthority={uniqueMintSinceCoverage:true as const,historicalChainOwnership:'unknown' as const,bonusAuthorized:false as const,eligibilityAuthorized:false as const,allocationAuthorized:false as const,publicationAuthorized:false as const};
const evidenceSchema=requestSchema.extend({version:z.literal(1),purpose:z.literal('seeker_enrollment_interval'),startsAt:instant,endsAt:instant,observedAt:timestamp,enrollment:enrollmentSchema,events:z.array(eventSchema).max(MAX_ROWS),link:z.object({wallet:key,seekerWallet:key,sgtMint:key,revokedAt:z.null()}).strict(),uniqueMintSinceCoverage:z.literal(true),historicalChainOwnership:z.literal('unknown'),bonusAuthorized:z.literal(false),eligibilityAuthorized:z.literal(false),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type MiningSeekerEnrollmentIntervalEvidence=z.infer<typeof evidenceSchema>;
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const p=schema.safeParse(value);return p.success?p.data:fail(code);}
const micros=(value:string)=>value.replace('Z','000Z');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function interval(day:string){const startsAt=`${day}T00:00:00.000Z`,n=Date.parse(startsAt);if(!Number.isFinite(n)||new Date(n).toISOString()!==startsAt)fail('INVALID_INPUT');return {startsAt,endsAt:new Date(n+DAY_MS).toISOString()};}
function validateEnrollment(value:unknown):MiningSeekerEnrollment{
 const p=parse(enrollmentSchema,value);
 if(p.wallet!==p.player.wallet||p.wallet!==p.link.wallet||p.recordedHistoryStartedAt>p.coverageStartedAt||p.coverageStartedAt>p.observedAt||p.player.created_at>p.observedAt||BigInt(p.eventFrontier)<BigInt(p.birthEventFloor))fail('SOURCE_CONFLICT');
 return p;
}
/** Shape replay authenticates no DB by itself. The owned reader binds this
 * prospective snapshot to immutable source custody, not an invented birth. */
export function validateMiningSeekerEnrollmentIntervalEvidence(value:unknown):MiningSeekerEnrollmentIntervalEvidence{
 const p=parse(evidenceSchema,value);if(Buffer.byteLength(JSON.stringify(p),'utf8')>MAX_BYTES)fail('TOO_LARGE');
 const c=validateEnrollment(p.enrollment),expected=interval(p.day),frontier=BigInt(c.eventFrontier),floor=BigInt(c.birthEventFloor);
 if(p.startsAt!==expected.startsAt||p.endsAt!==expected.endsAt||c.wallet!==p.wallet||c.id!==p.enrollmentId||c.observedAt>p.observedAt)fail('SOURCE_CONFLICT');
 if(micros(p.endsAt)>p.observedAt)fail('DAY_OPEN');if(c.observedAt>=micros(p.startsAt))fail('COVERAGE_UNAVAILABLE');
 let prior=floor,currentLink:unknown=undefined,currentPlayer:unknown=undefined;
 for(const e of p.events){
  const id=BigInt(e.id);if(id<=prior||e.observedAt<c.coverageStartedAt||e.observedAt>p.observedAt)fail('SOURCE_CONFLICT');prior=id;
  // Commit order, not claimed timestamps, excludes post-frontier out-and-back.
  if(id>frontier)fail('COVERAGE_UNAVAILABLE');if(e.observedAt>c.observedAt)fail('SOURCE_CONFLICT');
  const before=e.beforeState,after=e.afterState;
  if(e.operation==='INSERT'?before!==null||after===null:e.operation==='DELETE'?before===null||after!==null:before===null||after===null||same(before,after))fail('SOURCE_CONFLICT');
  if(e.sourceId!==(after??before)?.wallet)fail('SOURCE_CONFLICT');
  if(e.sourceTable==='players'){
   if(e.wallet!==p.wallet||[before,after].some(s=>s!==null&&(!('created_at'in s)||s.created_at>e.observedAt)))fail('SOURCE_CONFLICT');
   if(currentPlayer!==undefined&&!same(currentPlayer,before))fail('SOURCE_CONFLICT');currentPlayer=after;
  }else{
   const states=[before,after].filter((v):v is z.infer<typeof linkSchema>=>v!==null&&'sgt_mint'in v);
   if(states.length!==Number(before!==null)+Number(after!==null)||!states.some(v=>v.wallet===e.wallet)||!states.some(v=>v.wallet===p.wallet||v.sgt_mint===c.link.sgt_mint))fail('SOURCE_CONFLICT');
   if(states.some(v=>v.sgt_mint===c.link.sgt_mint&&v.wallet!==p.wallet||v.wallet===p.wallet&&v.sgt_mint!==c.link.sgt_mint))fail('COVERAGE_UNAVAILABLE');
   if(e.wallet===p.wallet){if(currentLink!==undefined&&!same(currentLink,before))fail('SOURCE_CONFLICT');currentLink=after;}
  }
 }
 if(currentPlayer!==undefined&&!same(currentPlayer,c.player)||currentLink!==undefined&&!same(currentLink,c.link)||!same(p.link,{wallet:c.link.wallet,seekerWallet:c.link.seeker_wallet,sgtMint:c.link.sgt_mint,revokedAt:null}))fail('SOURCE_CONFLICT');
 return freeze(p);
}
const CHALLENGE_PREFIX='SHARDKEEP:MINING:SEEKER:ENROLLMENT:v1:';
const challengeRequest=z.object({wallet:key,enrollmentId:z.uuid().optional()}).strict();
const challengeSchema=z.object({version:z.literal(1),purpose:z.literal('seeker_enrollment_challenge'),enrollment:enrollmentSchema,memo:z.string().length(CHALLENGE_PREFIX.length+64)}).strict();
export type MiningSeekerEnrollmentChallenge=z.infer<typeof challengeSchema>;
export function validateMiningSeekerEnrollmentChallenge(value:unknown):MiningSeekerEnrollmentChallenge{
 const p=parse(challengeSchema,value);validateEnrollment(p.enrollment);if(p.memo!==CHALLENGE_PREFIX+p.enrollment.nonce)fail('SOURCE_CONFLICT');return freeze(p);
}
function mapError(error:unknown):never{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){
 if('code'in e){if(e.code==='55P03')fail('BUSY');if(e.code==='57014'||e.code==='42501')fail('SOURCE_UNAVAILABLE');if(e.code==='22007'||e.code==='22008')fail('SOURCE_CONFLICT');}
 if('message'in e&&typeof e.message==='string'&&e.message.startsWith('MINING_SEEKER_ENROLLMENT_')){
  if(e.message.includes('SOURCE_UNAVAILABLE')||e.message.includes('FRESH_TRANSACTION')||e.message.includes('READ_COMMITTED'))fail('SOURCE_UNAVAILABLE');
  if(e.message.includes('UNAVAILABLE')||e.message.includes('CLOCK_REGRESSION'))fail('COVERAGE_UNAVAILABLE');
 }
 e='cause'in e?e.cause:undefined;
 }throw error;}
/** Explicit owner operation, in a transaction which must commit before use. */
export async function captureMiningSeekerEnrollment(db:Db,wallet:string):Promise<void>{
 if('rollback'in db||!key.safeParse(wallet).success)fail('INVALID_INPUT');if(!phaseEMiningEnabled())fail('DISABLED');
 try{await db.transaction(async tx=>{if(!phaseEMiningEnabled())fail('DISABLED');await tx.execute(sql`lock table public.mining_seeker_enrollments in row exclusive mode nowait`);await tx.execute(sql`insert into public.mining_seeker_enrollments(wallet) values(${wallet}) on conflict(wallet,event_frontier) do nothing`);if(!phaseEMiningEnabled())fail('DISABLED');});}catch(error){mapError(error);}
}
function normalized(column:'before_state'|'after_state'){
 const field=sql.raw(`e.${column}`);
 return sql`case when ${field} is null then null when e.source_table='players' then ${field}||jsonb_build_object('created_at',to_char((${field}->>'created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) else ${field}||jsonb_build_object('revoked_at',to_char((${field}->>'revoked_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end`;
}
type Transaction=Parameters<Parameters<Db['transaction']>[0]>[0];
async function barrier(tx:Transaction):Promise<string>{
 await tx.execute(sql`set local statement_timeout='2000ms'`);
 await tx.execute(sql`lock table public.players,public.seeker_links,public.mining_free_coverage,public.mining_seeker_link_coverage,public.mining_free_cohort_events,public.mining_seeker_enrollments,public.mining_seeker_enrollment_contract in share mode nowait`);
 const [a]=await tx.execute<{observed_at:string;valid:boolean;fresh:boolean}>(sql`select to_char(public.shardkeep_mining_free_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,public.shardkeep_mining_seeker_enrollment_sources_valid() valid,not exists(select 1 from pg_locks where pid=pg_backend_pid() and granted and mode='RowExclusiveLock' and relation in('public.players'::regclass,'public.seeker_links'::regclass,'public.mining_free_coverage'::regclass,'public.mining_seeker_link_coverage'::regclass,'public.mining_free_cohort_events'::regclass,'public.mining_seeker_enrollments'::regclass,'public.mining_seeker_enrollment_contract'::regclass)) fresh`);
 if(a?.valid!==true||a.fresh!==true)fail('SOURCE_UNAVAILABLE');return parse(timestamp,a.observed_at);
}
async function retained(tx:Transaction,request:z.infer<typeof challengeRequest>):Promise<MiningSeekerEnrollment>{
 const [row]=await tx.execute<{value:unknown;valid:boolean}>(sql`select jsonb_build_object('id',e.id,'wallet',e.wallet,'nonce',e.nonce,'observedAt',to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'eventFrontier',e.event_frontier::text,'coverageStartedAt',to_char(e.coverage_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'recordedHistoryStartedAt',to_char(e.recorded_history_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'birthEventFloor',e.birth_event_floor::text,'sourceSeal',e.source_seal,'player',e.player,'link',e.link) value,(e.coverage_started_at=sc.started_at and e.birth_event_floor=sc.birth_event_floor and e.recorded_history_started_at=c.started_at and e.source_seal=encode(sha256(convert_to(seal.record::text,'UTF8')),'hex') and p.created_at=(e.player->>'created_at')::timestamptz and s.seeker_wallet=e.link->>'seeker_wallet' and s.sgt_mint=e.link->>'sgt_mint' and s.revoked_at is null) is true valid from public.mining_seeker_enrollments e cross join public.mining_seeker_link_coverage sc cross join public.mining_free_coverage c cross join public.mining_seeker_enrollment_contract seal join public.players p on p.wallet=${request.wallet} join public.seeker_links s on s.wallet=p.wallet where e.wallet=${request.wallet} and ${request.enrollmentId?sql`e.id=${request.enrollmentId}::uuid`:sql`true`} and sc.id and c.id and seal.singleton order by e.event_frontier desc limit 1`);
 if(!row||row.valid!==true)fail('COVERAGE_UNAVAILABLE');return validateEnrollment(row.value);
}
/** A nonce is exposed only after its capture transaction committed. Retained
 * challenges stay readable paused; callers cannot select a different wallet. */
export async function readMiningSeekerEnrollmentChallenge(db:Db,input:unknown):Promise<MiningSeekerEnrollmentChallenge>{
 if('rollback'in db)fail('INVALID_INPUT');const request=parse(challengeRequest,input,'INVALID_INPUT');
 try{return await db.transaction(async tx=>{const now=await barrier(tx),enrollment=await retained(tx,request);if(enrollment.observedAt>now)fail('COVERAGE_UNAVAILABLE');return validateMiningSeekerEnrollmentChallenge({version:1,purpose:'seeker_enrollment_challenge',enrollment,memo:CHALLENGE_PREFIX+enrollment.nonce});});}catch(error){return mapError(error);}
}
/** Every relevant journal mutation after the committed global frontier refuses
 * continuity, even if backdated or later than the requested closed interval. */
export async function readMiningSeekerEnrollmentInterval(db:Db,input:unknown):Promise<MiningSeekerEnrollmentIntervalEvidence>{
 if('rollback'in db)fail('INVALID_INPUT');const request=parse(requestSchema,input,'INVALID_INPUT'),range=interval(request.day);
 try{return await db.transaction(async tx=>{
  const observedAt=await barrier(tx);if(observedAt<micros(range.endsAt))fail('DAY_OPEN');const enrollment=await retained(tx,request);
  const where=sql`e.id>${enrollment.birthEventFloor}::bigint and (e.wallet=${request.wallet} and e.source_table in('players','seeker_links') or e.source_table='seeker_links' and (e.before_state->>'sgt_mint'=${enrollment.link.sgt_mint} or e.after_state->>'sgt_mint'=${enrollment.link.sgt_mint}))`;
  const [size]=await tx.execute<{n:number;bytes:string}>(sql`select count(*)::int n,coalesce(sum(octet_length(to_jsonb(e)::text)),0)::text bytes from(select * from public.mining_free_cohort_events e where ${where} order by e.id limit ${MAX_ROWS+1}) e`);
  if(!size)fail('SOURCE_UNAVAILABLE');if(size.n>MAX_ROWS||BigInt(size.bytes)>BigInt(MAX_BYTES))fail('TOO_LARGE');
  const rows=await tx.execute<{id:string;wallet:string;observed_at:string;source_table:string;source_id:string;operation:string;before_state:unknown;after_state:unknown}>(sql`select e.id::text,e.wallet,to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,e.source_table,e.source_id,e.operation,${normalized('before_state')} before_state,${normalized('after_state')} after_state from public.mining_free_cohort_events e where ${where} order by e.id limit ${MAX_ROWS+1}`);
  if(rows.length!==size.n)fail('SOURCE_CONFLICT');const events=rows.map(e=>({id:e.id,wallet:e.wallet,observedAt:e.observed_at,sourceTable:e.source_table,sourceId:e.source_id,operation:e.operation,beforeState:e.before_state,afterState:e.after_state}));
  return validateMiningSeekerEnrollmentIntervalEvidence({...request,...range,version:1,purpose:'seeker_enrollment_interval',observedAt,enrollment,events,link:{wallet:enrollment.link.wallet,seekerWallet:enrollment.link.seeker_wallet,sgtMint:enrollment.link.sgt_mint,revokedAt:null},...unknownAuthority});
 });}catch(error){return mapError(error);}
}
