/** Committed-marker Seeker-link ABSENCE source. Proves, from the owner-committed
 * Seeker-link marker, the ORIGINAL captured player birth and the complete recorded
 * journal, that a post-identity-coverage player held no Seeker link at any time
 * before the end of a closed day. It establishes no bonus, eligibility, allocation
 * or publication authority by itself; a precoverage identity has no captured
 * birth and can never masquerade as a current snapshot. Replay is pure and
 * providerless; the reader alone binds the evidence to live source custody. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
const MAX_ROWS=10_000,MAX_BYTES=8_388_608,DAY_MS=86_400_000;
type Code='INVALID_INPUT'|'DAY_OPEN'|'IDENTITY_COVERAGE_UNAVAILABLE'|'COVERAGE_UNAVAILABLE'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'TOO_LARGE'|'BUSY';
export class MiningSeekerAbsenceError extends Error{constructor(readonly code:Code,cause?:unknown){super(`Mining Seeker absence refused: ${code}`,cause===undefined?undefined:{cause});this.name='MiningSeekerAbsenceError';}}
function fail(code:Code,cause?:unknown):never{throw new MiningSeekerAbsenceError(code,cause);}
const key=z.string().min(32).max(44).refine(value=>{try{return new PublicKey(value).toBase58()===value;}catch{return false;}});
const positive=z.string().regex(/^[1-9]\d{0,19}$/),ordinal=z.string().regex(/^(0|[1-9]\d{0,19})$/);
function canonical(value:string,digits:3|6){const pattern=digits===3?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;if(!pattern.test(value))return false;const ms=value.slice(0,23)+'Z',at=Date.parse(ms);return Number.isFinite(at)&&new Date(at).toISOString()===ms;}
const timestamp=z.string().refine(value=>canonical(value,6)),instant=z.string().refine(value=>canonical(value,3));
const birthStateSchema=z.object({wallet:key,created_at:timestamp}).strict();
const linkStateSchema=z.object({wallet:key,seeker_wallet:key,sgt_mint:key,revoked_at:timestamp.nullable()}).strict();
const stateSchema=z.union([birthStateSchema,linkStateSchema]);
const requestSchema=z.object({wallet:key,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict();
const eventSchema=z.object({id:positive,wallet:key,observedAt:timestamp,sourceTable:z.enum(['players','seeker_links']),sourceId:key,operation:z.enum(['INSERT','UPDATE','DELETE']),beforeState:stateSchema.nullable(),afterState:stateSchema.nullable()}).strict();
const markerSchema=z.object({startedAt:timestamp,birthEventFloor:ordinal,coverageStartedAt:timestamp,sourceSeal:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const birthSchema=z.object({eventId:positive,wallet:key,createdAt:timestamp,observedAt:timestamp}).strict();
const evidenceSchema=requestSchema.extend({version:z.literal(1),purpose:z.literal('seeker_absence_interval'),startsAt:instant,endsAt:instant,observedAt:timestamp,
 marker:markerSchema,birth:birthSchema,player:birthStateSchema,events:z.array(eventSchema).max(MAX_ROWS),link:z.null(),
 bonusAuthorized:z.literal(false),eligibilityAuthorized:z.literal(false),allocationAuthorized:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
export type MiningSeekerAbsenceIntervalEvidence=z.infer<typeof evidenceSchema>;
type LinkState=z.infer<typeof linkStateSchema>;
const noAuthority={link:null,bonusAuthorized:false as const,eligibilityAuthorized:false as const,allocationAuthorized:false as const,publicationAuthorized:false as const};
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const p=schema.safeParse(value);return p.success?p.data:fail(code);}
const micros=(value:string)=>value.replace('Z','000Z');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function interval(day:string){const startsAt=`${day}T00:00:00.000Z`,n=Date.parse(startsAt);if(!Number.isFinite(n)||new Date(n).toISOString()!==startsAt)fail('INVALID_INPUT');const endsAt=new Date(n+DAY_MS).toISOString();if(!canonical(endsAt,3))fail('INVALID_INPUT');return {startsAt,endsAt};}
const isLink=(s:unknown):s is LinkState=>s!==null&&typeof s==='object'&&'sgt_mint'in s;
/** Replays the retained link chain that may legitimately begin at or after the day's end
 * and returns its final state. Any recorded link before the end refuses. */
function linkChain(p:MiningSeekerAbsenceIntervalEvidence):LinkState|null{
 const end=micros(p.endsAt),floor=BigInt(p.marker.birthEventFloor);let current:LinkState|null=null,first=true;
 for(const e of p.events){
  if(e.sourceTable!=='seeker_links')continue;
  // A link event at or below the committed floor existed before the marker, hence before the
  // day, whatever recorded time a forward-stepped clock gave it.
  if(BigInt(e.id)<=floor||e.observedAt<end)fail('COVERAGE_UNAVAILABLE');
  const before=e.beforeState,after=e.afterState;
  if(first&&(e.operation!=='INSERT'||before!==null))fail('COVERAGE_UNAVAILABLE');first=false;
  if(!same(current,before))fail('COVERAGE_UNAVAILABLE');
  if(after!==null&&(!isLink(after)||after.wallet!==p.wallet))fail('COVERAGE_UNAVAILABLE');
  current=after as LinkState|null;
 }
 return current;
}
/** Shape replay authenticates no DB by itself; the reader binds the marker, seal,
 * birth and live rows. Every refusal is typed; nothing degrades to "no link". */
export function validateMiningSeekerAbsenceIntervalEvidence(value:unknown):MiningSeekerAbsenceIntervalEvidence{
 const p=parse(evidenceSchema,value);if(Buffer.byteLength(JSON.stringify(p),'utf8')>MAX_BYTES)fail('TOO_LARGE');
 const expected=interval(p.day);if(p.startsAt!==expected.startsAt||p.endsAt!==expected.endsAt)fail('SOURCE_CONFLICT');
 if(p.observedAt<micros(p.endsAt))fail('DAY_OPEN');
 const m=p.marker;if(m.coverageStartedAt>m.startedAt)fail('SOURCE_CONFLICT');
 if(m.startedAt>=micros(p.startsAt))fail('COVERAGE_UNAVAILABLE');
 let prior=0n,births=0,seen='';
 for(const e of p.events){
  // Ids are commit order; the wallet's own rows serialize, so recorded time may never step back.
  const id=BigInt(e.id);if(id<=prior||e.observedAt<m.coverageStartedAt||e.observedAt>p.observedAt||e.observedAt<seen||e.wallet!==p.wallet)fail('SOURCE_CONFLICT');prior=id;seen=e.observedAt;
  const before=e.beforeState,after=e.afterState;
  if(e.operation==='INSERT'?before!==null||after===null:e.operation==='DELETE'?before===null||after!==null:before===null||after===null||same(before,after))fail('SOURCE_CONFLICT');
  if(e.sourceId!==(after??before)?.wallet)fail('SOURCE_CONFLICT');
  if(e.sourceTable==='players'){
   // Exactly one recorded identity event may exist: the original captured birth.
   if(++births>1||e.operation!=='INSERT'||after===null||isLink(after)||after.wallet!==p.wallet)fail('SOURCE_CONFLICT');
   if(e.id!==p.birth.eventId||after.created_at!==p.birth.createdAt||e.observedAt!==p.birth.observedAt)fail('SOURCE_CONFLICT');
  }else if(!isLink(before??after))fail('SOURCE_CONFLICT');
 }
 const b=p.birth;
 if(births!==1||b.wallet!==p.wallet||p.player.wallet!==p.wallet||p.player.created_at!==b.createdAt
  ||b.createdAt<m.coverageStartedAt||b.createdAt>b.observedAt||b.observedAt>=micros(p.startsAt))fail('IDENTITY_COVERAGE_UNAVAILABLE');
 linkChain(p);
 return freeze(p);
}
function mapError(error:unknown):never{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){
 if('code'in e){if(e.code==='55P03')fail('BUSY',error);if(e.code==='57014'||e.code==='42501')fail('SOURCE_UNAVAILABLE',error);if(e.code==='22007'||e.code==='22008')fail('SOURCE_CONFLICT',error);
  // Any other database refusal (missing object, serialization, shutdown) is an unavailable source, never evidence.
  if(typeof e.code==='string'&&/^[0-9A-Z]{5}$/.test(e.code))fail('SOURCE_UNAVAILABLE',error);}
 e='cause'in e?e.cause:undefined;
 }throw error;}
function normalized(column:'before_state'|'after_state'){
 const field=sql.raw(`e.${column}`);
 return sql`case when ${field} is null then null when e.source_table='players' then ${field}||jsonb_build_object('created_at',to_char((${field}->>'created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) else ${field}||jsonb_build_object('revoked_at',to_char((${field}->>'revoked_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end`;
}
type Transaction=Parameters<Parameters<Db['transaction']>[0]>[0];
/** The same barrier as the accepted enrollment interval reader (seekerMiningEnrollment.ts):
 * identical share-mode lock set, sealed-source validity and fresh-transaction check. The
 * list is duplicated here because that module keeps it private; keep them in step. */
const SOURCE_RELATIONS=['players','seeker_links','mining_free_coverage','mining_seeker_link_coverage','mining_free_cohort_events','mining_seeker_enrollments','mining_seeker_enrollment_contract'];
async function barrier(tx:Transaction):Promise<string>{
 await tx.execute(sql`set local statement_timeout='2000ms'`);
 await tx.execute(sql`lock table public.players,public.seeker_links,public.mining_free_coverage,public.mining_seeker_link_coverage,public.mining_free_cohort_events,public.mining_seeker_enrollments,public.mining_seeker_enrollment_contract in share mode nowait`);
 // The sealed 0269 contract pins columns, constraints, indexes and ACLs but not row security,
 // inheritance or rules: a non-superuser owner under FORCE ROW LEVEL SECURITY could hide journal
 // rows while the birth stays visible, and an inheritance child (never guarded, locked apart from
 // its parent) could inject forged rows into what the reader treats as the journal. Every locked
 // relation must be a plain permanent table with no row security, children or rules.
 const [a]=await tx.execute<{observed_at:string;valid:boolean;fresh:boolean;canonical:boolean}>(sql`select to_char(public.shardkeep_mining_free_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,public.shardkeep_mining_seeker_enrollment_sources_valid() valid,not exists(select 1 from pg_locks where pid=pg_backend_pid() and granted and mode='RowExclusiveLock' and relation in('public.players'::regclass,'public.seeker_links'::regclass,'public.mining_free_coverage'::regclass,'public.mining_seeker_link_coverage'::regclass,'public.mining_free_cohort_events'::regclass,'public.mining_seeker_enrollments'::regclass,'public.mining_seeker_enrollment_contract'::regclass)) fresh,
  (select count(*)=${sql.raw(String(SOURCE_RELATIONS.length))} from pg_class c where c.relnamespace='public'::regnamespace and c.relname in (select jsonb_array_elements_text(${JSON.stringify(SOURCE_RELATIONS)}::jsonb)) and c.relkind='r' and c.relpersistence='p' and not c.relrowsecurity and not c.relforcerowsecurity and not c.relhassubclass and not c.relhasrules) canonical`);
 if(a?.valid!==true||a.fresh!==true||a.canonical!==true)fail('SOURCE_UNAVAILABLE');return parse(timestamp,a.observed_at);
}
/** Reads the committed marker, the sealed source, the original captured birth, the live
 * player and link rows and the wallet's complete recorded journal in one fenced
 * transaction, then validates purely. Readable while paused; never a locator or provider. */
export async function readMiningSeekerAbsenceInterval(db:Db,input:unknown):Promise<MiningSeekerAbsenceIntervalEvidence>{
 if('rollback'in db)fail('INVALID_INPUT');const request=parse(requestSchema,input,'INVALID_INPUT'),range=interval(request.day);
 try{return await db.transaction(async tx=>{
  const observedAt=await barrier(tx);if(observedAt<micros(range.endsAt))fail('DAY_OPEN');
  const [marker]=await tx.execute<{startedAt:string;birthEventFloor:string;coverageStartedAt:string;sourceSeal:string}>(sql`select to_char(sc.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "startedAt",sc.birth_event_floor::text "birthEventFloor",
   to_char(c.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "coverageStartedAt",encode(sha256(convert_to(seal.record::text,'UTF8')),'hex') "sourceSeal"
   from public.mining_seeker_link_coverage sc cross join public.mining_free_coverage c cross join public.mining_seeker_enrollment_contract seal where sc.id and c.id and seal.singleton`);
  if(!marker)fail('COVERAGE_UNAVAILABLE');
  const [player]=await tx.execute<{wallet:string;created_at:string}>(sql`select wallet,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at from public.players where wallet=${request.wallet} and isfinite(created_at)`);
  if(!player)fail('IDENTITY_COVERAGE_UNAVAILABLE');
  // The wallet's own recorded events are the whole history: seeker_links.wallet is a foreign
  // key to players.wallet (0044), so every link row of a post-coverage player postdates its
  // captured birth and was journaled under the wallet; journal rows are append-only, a
  // pre-marker TRUNCATE cannot erase them (its statement row, recorded for cohort wallets,
  // is refused by the event schema), and TRUNCATE is blocked once the marker exists.
  const where=sql`e.wallet=${request.wallet} and e.source_table in('players','seeker_links')`;
  const [size]=await tx.execute<{n:number;bytes:string}>(sql`select count(*)::int n,coalesce(sum(octet_length(to_jsonb(e)::text)),0)::text bytes from(select * from public.mining_free_cohort_events e where ${where} order by e.id limit ${MAX_ROWS+1}) e`);
  if(!size)fail('SOURCE_UNAVAILABLE');if(size.n>MAX_ROWS||BigInt(size.bytes)>BigInt(MAX_BYTES))fail('TOO_LARGE');
  const rows=await tx.execute<{id:string;wallet:string;observed_at:string;source_table:string;source_id:string;operation:string;before_state:unknown;after_state:unknown}>(sql`select e.id::text,e.wallet,to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,e.source_table,e.source_id,e.operation,${normalized('before_state')} before_state,${normalized('after_state')} after_state from public.mining_free_cohort_events e where ${where} order by e.id limit ${MAX_ROWS+1}`);
  if(rows.length!==size.n)fail('SOURCE_CONFLICT');
  const events=rows.map(e=>({id:e.id,wallet:e.wallet,observedAt:e.observed_at,sourceTable:e.source_table,sourceId:e.source_id,operation:e.operation,beforeState:e.before_state,afterState:e.after_state}));
  const births=events.filter(e=>e.sourceTable==='players'&&e.operation==='INSERT');
  // No captured birth is an unavailable identity; more than one is a mutated identity.
  if(births.length===0)fail('IDENTITY_COVERAGE_UNAVAILABLE');if(births.length>1)fail('SOURCE_CONFLICT');
  const born=births[0]!,after=born.afterState as {wallet?:unknown;created_at?:unknown}|null;
  if(!after||typeof after.created_at!=='string')fail('IDENTITY_COVERAGE_UNAVAILABLE');
  const evidence=validateMiningSeekerAbsenceIntervalEvidence({...request,...range,version:1,purpose:'seeker_absence_interval',observedAt,marker,
   birth:{eventId:born.id,wallet:request.wallet,createdAt:after.created_at,observedAt:born.observedAt},player,events,...noAuthority});
  // Commit order, not claimed time, decides "after the end": a link admitted as post-day must
  // have been journaled after every event the whole journal recorded before the day's end.
  const [frontier]=await tx.execute<{id:string}>(sql`select coalesce(max(id),0)::text id from public.mining_free_cohort_events where observed_at<${range.endsAt}::timestamptz`);
  if(!frontier)fail('SOURCE_UNAVAILABLE');
  if(evidence.events.some(e=>e.sourceTable==='seeker_links'&&BigInt(e.id)<=BigInt(frontier.id)))fail('COVERAGE_UNAVAILABLE');
  // The live rows must be exactly what the recorded chain explains: a link the journal
  // never captured, or a chain that no longer matches the table, is not an absence.
  const live=await tx.execute<{wallet:string;seeker_wallet:string;sgt_mint:string;revoked_at:string|null}>(sql`select wallet,seeker_wallet,sgt_mint,to_char(revoked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') revoked_at from public.seeker_links where wallet=${request.wallet} limit 2`);
  const final=linkChain(evidence);
  if(final===null?live.length!==0:live.length!==1||!same(live[0],final))fail('COVERAGE_UNAVAILABLE');
  return evidence;
 });}catch(error){return mapError(error);}
}
