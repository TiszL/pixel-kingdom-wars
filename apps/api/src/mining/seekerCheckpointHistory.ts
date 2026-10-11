/** A committed checkpoint proves only an unchanged recorded link after its
 * barrier. Chain holding and mint birth require independent authenticated proof. */
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_MINING_SCORE_POLICY as POLICY} from '@shardkeep/shared';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
const MAX_ROWS=10_000,MAX_BYTES=8_388_608,DAY_MS=86_400_000;
type Code='DISABLED'|'INVALID_INPUT'|'DAY_OPEN'|'COVERAGE_UNAVAILABLE'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'TOO_LARGE'|'BUSY';
export class MiningSeekerCheckpointError extends Error{constructor(readonly code:Code){super(`Mining Seeker checkpoint refused: ${code}`);this.name='MiningSeekerCheckpointError';}}
function fail(code:Code):never{throw new MiningSeekerCheckpointError(code);}
const key=z.string().min(32).max(44).refine(value=>{try{return new PublicKey(value).toBase58()===value;}catch{return false;}});
const positive=z.string().regex(/^[1-9]\d{0,19}$/),ordinal=z.string().regex(/^(0|[1-9]\d{0,19})$/);
function canonical(value:string,digits:3|6){const pattern=digits===3?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;if(!pattern.test(value))return false;const ms=value.slice(0,23)+'Z',at=Date.parse(ms);return Number.isFinite(at)&&new Date(at).toISOString()===ms;}
const timestamp=z.string().refine(value=>canonical(value,6)),instant=z.string().refine(value=>canonical(value,3));
const birthSchema=z.object({wallet:key,created_at:timestamp}).strict();
const linkSchema=z.object({wallet:key,seeker_wallet:key,sgt_mint:key,revoked_at:timestamp.nullable()}).strict();
const activeLinkSchema=linkSchema.extend({revoked_at:z.null()});
const stateSchema=z.union([birthSchema,linkSchema]);
const requestSchema=z.object({wallet:key,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(POLICY.version)}).strict();
const eventSchema=z.object({id:positive,wallet:key,observedAt:timestamp,sourceTable:z.enum(['players','seeker_links']),sourceId:key,operation:z.enum(['INSERT','UPDATE','DELETE']),beforeState:stateSchema.nullable(),afterState:stateSchema.nullable()}).strict();
const checkpointSchema=z.object({id:z.uuid(),wallet:key,observedAt:timestamp,eventFrontier:ordinal,birth:birthSchema,link:activeLinkSchema}).strict();
const unknownAuthority={uniqueMintSinceCoverage:true as const,historicalChainOwnership:'unknown' as const,bonusAuthorized:false as const,eligibilityAuthorized:false as const,allocationAuthorized:false as const,publicationAuthorized:false as const};
const evidenceSchema=requestSchema.extend({version:z.literal(1),purpose:z.literal('seeker_link_checkpoint_interval'),startsAt:instant,endsAt:instant,observedAt:timestamp,coverageStartedAt:timestamp,recordedHistoryStartedAt:timestamp,birthEventFloor:ordinal,checkpoint:checkpointSchema,events:z.array(eventSchema).max(MAX_ROWS),link:z.object({wallet:key,seekerWallet:key,sgtMint:key,revokedAt:z.null()}).strict(),uniqueMintSinceCoverage:z.literal(true),historicalChainOwnership:z.literal('unknown'),bonusAuthorized:z.literal(false),eligibilityAuthorized:z.literal(false),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type MiningSeekerCheckpointIntervalEvidence=z.infer<typeof evidenceSchema>;
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const p=schema.safeParse(value);return p.success?p.data:fail(code);}
const micros=(value:string)=>value.replace('Z','000Z');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function interval(day:string){const startsAt=`${day}T00:00:00.000Z`,n=Date.parse(startsAt);if(!Number.isFinite(n)||new Date(n).toISOString()!==startsAt)fail('INVALID_INPUT');return {startsAt,endsAt:new Date(n+DAY_MS).toISOString()};}
/** Replays the retained original source history. A shape-valid transcript does
 * not authenticate a DB/provider; callers must obtain it from the owned reader. */
export function validateMiningSeekerCheckpointIntervalEvidence(value:unknown):MiningSeekerCheckpointIntervalEvidence{
 const p=parse(evidenceSchema,value);if(Buffer.byteLength(JSON.stringify(p),'utf8')>MAX_BYTES)fail('TOO_LARGE');
 const expected=interval(p.day),c=p.checkpoint,frontier=BigInt(c.eventFrontier),floor=BigInt(p.birthEventFloor);
 if(p.startsAt!==expected.startsAt||p.endsAt!==expected.endsAt||c.wallet!==p.wallet||c.birth.wallet!==p.wallet||c.link.wallet!==p.wallet
  ||p.recordedHistoryStartedAt>p.coverageStartedAt||p.coverageStartedAt>c.observedAt||c.observedAt>p.observedAt||frontier<floor)fail('SOURCE_CONFLICT');
 if(micros(p.endsAt)>p.observedAt)fail('DAY_OPEN');
 if(c.observedAt>=micros(p.startsAt)||c.birth.created_at<p.coverageStartedAt)fail('COVERAGE_UNAVAILABLE');
 let prior=0n,births=0,birthObservedAt='',current:z.infer<typeof linkSchema>|null=null;
 for(const event of p.events){
  const id=BigInt(event.id);if(id<=prior||id<=floor||event.observedAt<p.coverageStartedAt||event.observedAt>p.observedAt)fail('SOURCE_CONFLICT');prior=id;
  // Include even post-end and backdated mutations. Their commit time was not
  // observed independently, so matching endpoint rows cannot restore continuity.
  if(id>frontier)fail('COVERAGE_UNAVAILABLE');
  if(event.observedAt>c.observedAt)fail('SOURCE_CONFLICT');
  const before=event.beforeState,after=event.afterState;
  if(event.operation==='INSERT'?before!==null||after===null:event.operation==='DELETE'?before===null||after!==null:before===null||after===null||same(before,after))fail('SOURCE_CONFLICT');
  if(event.sourceTable==='players'){
   births++;
   if(births!==1||event.wallet!==p.wallet||event.sourceId!==p.wallet||event.operation!=='INSERT'||before!==null||!same(after,c.birth)
    ||!after||!('created_at'in after)||after.created_at>event.observedAt)fail('COVERAGE_UNAVAILABLE');
   birthObservedAt=event.observedAt;
  }else{
   const states=[before,after].filter((s):s is z.infer<typeof linkSchema>=>s!==null&&'sgt_mint'in s);
   if(states.length!==Number(before!==null)+Number(after!==null)||!states.some(s=>s.wallet===event.wallet)||event.sourceId!==(after??before)?.wallet)fail('SOURCE_CONFLICT');
   if(!states.some(s=>s.wallet===p.wallet||s.sgt_mint===c.link.sgt_mint))fail('SOURCE_CONFLICT');
   if(states.some(s=>s.sgt_mint===c.link.sgt_mint&&s.wallet!==p.wallet))fail('COVERAGE_UNAVAILABLE');
   if(event.wallet===p.wallet){
    if(births!==1||event.observedAt<birthObservedAt)fail('SOURCE_CONFLICT');
    const prev=before?.wallet===p.wallet?before:null,next=after?.wallet===p.wallet?after:null;
    if(!same(current,prev))fail('SOURCE_CONFLICT');current=next as z.infer<typeof linkSchema>|null;
   }
  }
 }
 if(births!==1||!same(current,c.link)||!same(p.link,{wallet:c.link.wallet,seekerWallet:c.link.seeker_wallet,sgtMint:c.link.sgt_mint,revokedAt:null}))fail('SOURCE_CONFLICT');
 return freeze(p);
}
function mapError(error:unknown):never{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){
 if('code'in e){if(e.code==='55P03')fail('BUSY');if(e.code==='57014'||e.code==='42501')fail('SOURCE_UNAVAILABLE');if(e.code==='22007'||e.code==='22008')fail('SOURCE_CONFLICT');}
 if('message'in e&&typeof e.message==='string'&&e.message.startsWith('MINING_SEEKER_CHECKPOINT_')){
  if(e.message.includes('SOURCE_UNAVAILABLE')||e.message.includes('FRESH_TRANSACTION')||e.message.includes('READ_COMMITTED'))fail('SOURCE_UNAVAILABLE');
  if(e.message.includes('UNAVAILABLE')||e.message.includes('CLOCK_REGRESSION'))fail('COVERAGE_UNAVAILABLE');
 }
 e='cause'in e?e.cause:undefined;
 }throw error;}
/** Explicit owner operation, in a transaction which must commit before use. */
export async function captureMiningSeekerCheckpoint(db:Db,wallet:string):Promise<void>{
 if('rollback'in db||!key.safeParse(wallet).success)fail('INVALID_INPUT');if(!phaseEMiningEnabled())fail('DISABLED');
 try{await db.transaction(async tx=>{if(!phaseEMiningEnabled())fail('DISABLED');await tx.execute(sql`lock table public.mining_seeker_checkpoints in row exclusive mode nowait`);await tx.execute(sql`insert into public.mining_seeker_checkpoints(wallet) values(${wallet}) on conflict(wallet,event_frontier) do nothing`);if(!phaseEMiningEnabled())fail('DISABLED');});}catch(error){mapError(error);}
}
function normalized(column:'before_state'|'after_state'){
 const field=sql.raw(`e.${column}`);
 return sql`case when ${field} is null then null when e.source_table='players' then ${field}||jsonb_build_object('created_at',to_char((${field}->>'created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) else ${field}||jsonb_build_object('revoked_at',to_char((${field}->>'revoked_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end`;
}
/** Closed original evidence remains readable paused. All reads share the source
 * barrier; there is no second unlocked credential query or timestamp-only cut. */
export async function readMiningSeekerCheckpointInterval(db:Db,input:unknown):Promise<MiningSeekerCheckpointIntervalEvidence>{
 if('rollback'in db)fail('INVALID_INPUT');const request=parse(requestSchema,input,'INVALID_INPUT'),range=interval(request.day);
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`set local statement_timeout='2000ms'`);
  await tx.execute(sql`lock table public.players,public.seeker_links,public.mining_free_coverage,public.mining_seeker_link_coverage,public.mining_free_cohort_events,public.mining_seeker_checkpoints in share mode nowait`);
  const [authority]=await tx.execute<{observed_at:string;isolation:string;valid:boolean}>(sql`select to_char(public.shardkeep_mining_free_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,current_setting('transaction_isolation') isolation,public.shardkeep_mining_seeker_checkpoint_sources_valid() valid`);
  if(authority?.isolation!=='read committed'||authority.valid!==true)fail('SOURCE_UNAVAILABLE');const observedAt=parse(timestamp,authority.observed_at);if(observedAt<micros(range.endsAt))fail('DAY_OPEN');
  const [row]=await tx.execute<{id:string;wallet:string;observed_at:string;event_frontier:string;coverage_started_at:string;recorded_history_started_at:string;birth_event_floor:string;birth:unknown;link:unknown}>(sql`select id,wallet,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,event_frontier::text,to_char(coverage_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') coverage_started_at,to_char(recorded_history_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') recorded_history_started_at,birth_event_floor::text,birth,link from public.mining_seeker_checkpoints where wallet=${request.wallet} and observed_at<${range.startsAt}::timestamptz order by observed_at desc,event_frontier desc limit 1`);
  if(!row)fail('COVERAGE_UNAVAILABLE');const checkpoint=parse(checkpointSchema,{id:row.id,wallet:row.wallet,observedAt:row.observed_at,eventFrontier:row.event_frontier,birth:row.birth,link:row.link});
  const [bindings]=await tx.execute<{valid:boolean}>(sql`select (sc.started_at=${row.coverage_started_at}::timestamptz and sc.birth_event_floor=${row.birth_event_floor}::bigint and c.started_at=${row.recorded_history_started_at}::timestamptz and p.created_at=${checkpoint.birth.created_at}::timestamptz and s.seeker_wallet=${checkpoint.link.seeker_wallet} and s.sgt_mint=${checkpoint.link.sgt_mint} and s.revoked_at is null) is true valid from public.mining_seeker_link_coverage sc cross join public.mining_free_coverage c join public.players p on p.wallet=${request.wallet} join public.seeker_links s on s.wallet=p.wallet where sc.id and c.id`);
  if(bindings?.valid!==true)fail('COVERAGE_UNAVAILABLE');
  const where=sql`(e.wallet=${request.wallet} and e.source_table in ('players','seeker_links') or e.source_table='seeker_links' and e.id>${row.birth_event_floor}::bigint and (e.before_state->>'sgt_mint'=${checkpoint.link.sgt_mint} or e.after_state->>'sgt_mint'=${checkpoint.link.sgt_mint}))`;
  const [size]=await tx.execute<{n:number;bytes:string}>(sql`select count(*)::int n,coalesce(sum(octet_length(to_jsonb(e)::text)),0)::text bytes from (select * from public.mining_free_cohort_events e where ${where} order by e.id limit ${MAX_ROWS+1}) e`);
  if(!size)fail('SOURCE_UNAVAILABLE');if(size.n>MAX_ROWS||BigInt(size.bytes)>BigInt(MAX_BYTES))fail('TOO_LARGE');
  const rows=await tx.execute<{id:string;wallet:string;observed_at:string;source_table:string;source_id:string;operation:string;before_state:unknown;after_state:unknown}>(sql`select e.id::text,e.wallet,to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,e.source_table,e.source_id,e.operation,${normalized('before_state')} before_state,${normalized('after_state')} after_state from public.mining_free_cohort_events e where ${where} order by e.id limit ${MAX_ROWS+1}`);
  if(rows.length!==size.n)fail('SOURCE_CONFLICT');
  const events=rows.map(e=>({id:e.id,wallet:e.wallet,observedAt:e.observed_at,sourceTable:e.source_table,sourceId:e.source_id,operation:e.operation,beforeState:e.before_state,afterState:e.after_state}));
  return validateMiningSeekerCheckpointIntervalEvidence({...request,...range,version:1,purpose:'seeker_link_checkpoint_interval',observedAt,coverageStartedAt:row.coverage_started_at,recordedHistoryStartedAt:row.recorded_history_started_at,birthEventFloor:row.birth_event_floor,checkpoint,events,link:{wallet:checkpoint.link.wallet,seekerWallet:checkpoint.link.seeker_wallet,sgtMint:checkpoint.link.sgt_mint,revokedAt:null},...unknownAuthority});
 });}catch(error){return mapError(error);}
}

const CHALLENGE_PREFIX='SHARDKEEP:MINING:SEEKER:COVERAGE:v1:';
const challengeSchema=z.object({version:z.literal(1),purpose:z.literal('seeker_coverage_challenge'),coverageStartedAt:timestamp,recordedHistoryStartedAt:timestamp,birthEventFloor:ordinal,createdAt:timestamp,nonce:z.string().regex(/^[0-9a-f]{64}$/),memo:z.string().length(CHALLENGE_PREFIX.length+64)}).strict();
export type MiningSeekerCoverageChallenge=z.infer<typeof challengeSchema>;
/** Structural replay only; the owned reader authenticates the DB nonce. A
 * finalized Memo plus a strictly later mint slot establishes chain causality. */
export function validateMiningSeekerCoverageChallenge(value:unknown):MiningSeekerCoverageChallenge{
 const p=parse(challengeSchema,value);
 if(p.memo!==CHALLENGE_PREFIX+p.nonce||p.recordedHistoryStartedAt>p.coverageStartedAt||p.createdAt<p.coverageStartedAt)fail('SOURCE_CONFLICT');
 return freeze(p);
}
/** Generates no chain transaction. The owner must explicitly initialize after
 * coverage commits; retries retain the original unpredictable database nonce. */
export async function initializeMiningSeekerCoverageChallenge(db:Db):Promise<void>{
 if('rollback'in db)fail('INVALID_INPUT');if(!phaseEMiningEnabled())fail('DISABLED');
 try{await db.transaction(async tx=>{if(!phaseEMiningEnabled())fail('DISABLED');await tx.execute(sql`lock table public.mining_seeker_coverage_challenges in row exclusive mode nowait`);await tx.execute(sql`insert into public.mining_seeker_coverage_challenges(id) values(true) on conflict(id) do nothing`);if(!phaseEMiningEnabled())fail('DISABLED');});}catch(error){mapError(error);}
}
/** Retained original challenge remains available while new admission is paused.
 * Reads also require the actual table owner, even after accidental broad grants. */
export async function readMiningSeekerCoverageChallenge(db:Db):Promise<MiningSeekerCoverageChallenge>{
 if('rollback'in db)fail('INVALID_INPUT');
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`lock table public.players,public.seeker_links,public.mining_free_cohort_events,public.mining_free_coverage,public.mining_seeker_link_coverage,public.mining_seeker_checkpoints,public.mining_seeker_coverage_challenges in share mode nowait`);
  const [authority]=await tx.execute<{valid:boolean;owner:boolean;fresh:boolean;isolation:string}>(sql`select public.shardkeep_mining_seeker_checkpoint_sources_valid() valid,current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_seeker_coverage_challenges'::regclass) owner,current_setting('transaction_isolation') isolation,not exists(select 1 from pg_locks where pid=pg_backend_pid() and granted and mode='RowExclusiveLock' and relation in ('public.mining_free_coverage'::regclass,'public.mining_seeker_link_coverage'::regclass,'public.mining_seeker_coverage_challenges'::regclass)) fresh`);
  if(authority?.valid!==true||authority.owner!==true||authority.fresh!==true||authority.isolation!=='read committed')fail('SOURCE_UNAVAILABLE');
  const [row]=await tx.execute<{nonce:string;created_at:string;coverage_started_at:string;recorded_history_started_at:string;birth_event_floor:string;valid:boolean}>(sql`select ch.nonce,to_char(ch.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,to_char(ch.coverage_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') coverage_started_at,to_char(ch.recorded_history_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') recorded_history_started_at,ch.birth_event_floor::text,(ch.coverage_started_at=sc.started_at and ch.birth_event_floor=sc.birth_event_floor and ch.recorded_history_started_at=c.started_at) is true valid from public.mining_seeker_coverage_challenges ch cross join public.mining_seeker_link_coverage sc cross join public.mining_free_coverage c where ch.id and sc.id and c.id`);
  if(!row||row.valid!==true)fail('COVERAGE_UNAVAILABLE');
  return validateMiningSeekerCoverageChallenge({version:1,purpose:'seeker_coverage_challenge',coverageStartedAt:row.coverage_started_at,recordedHistoryStartedAt:row.recorded_history_started_at,birthEventFloor:row.birth_event_floor,createdAt:row.created_at,nonce:row.nonce,memo:CHALLENGE_PREFIX+row.nonce});
 });}catch(error){return mapError(error);}
}
