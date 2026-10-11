/** Historical completed development facts; no timer completion or score authority. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';

// Operational read bounds, not game caps. Oversized history never becomes zero.
const MAX_ROWS=10_000;
const DAY_MS=86_400_000;
const uuid=z.uuid();
/** PostgreSQL JSON timestamps use the writer's zone. Canonicalize the instant
 * without losing microseconds: Date alone would collapse distinct source facts. */
function canonicalTimestamp(value:string):string|null{
 const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
 if(!match)return null;
 const whole=Date.parse(`${match[1]}Z`);
 if(!Number.isFinite(whole)||new Date(whole).toISOString().slice(0,19)!==match[1])return null;
 const hours=Number(match[5]??0),minutes=Number(match[6]??0);
 if(hours>23||minutes>59)return null;
 const offset=(hours*60+minutes)*(match[4]==='-'?-1:1);
 const utc=new Date(whole-offset*60_000).toISOString();
 if(utc.length!==24)return null;
 return `${utc.slice(0,19)}.${(match[2]??'').padEnd(6,'0')}Z`;
}
const timestamp=z.string().transform((value,ctx)=>{
 const canonical=canonicalTimestamp(value);
 if(canonical===null){ctx.addIssue({code:'custom',message:'invalid captured timestamp'});return z.NEVER;}
 return canonical;
});
const baseSchema=z.object({
 id:uuid,owner_wallet:z.string().min(1).max(64),status:z.enum(['active','inactive']),keep_level:z.number().int().nonnegative(),
 land_paid_at:timestamp.nullable(),deed_asset_id:z.string().nullable(),deed_mint_asset_id:z.string().nullable(),deed_minting_at:timestamp.nullable(),
}).strict();
const buildingSchema=z.object({id:uuid,base_id:uuid.nullable(),type:z.string().min(1),level:z.number().int().nonnegative()}).strict();
const jobSchema=z.object({
 id:uuid,base_id:uuid.nullable(),building_id:uuid.nullable(),kind:z.enum(['build','upgrade','clear_obstacle','repair']),
 started_at:timestamp,finishes_at:timestamp,completed_at:timestamp.nullable(),cancelled_at:timestamp.nullable(),
}).strict();
type Base=z.infer<typeof baseSchema>;
type Building=z.infer<typeof buildingSchema>;
type Job=z.infer<typeof jobSchema>;
type Source=Base|Building|Job;
type Code='INVALID_INPUT'|'DAY_OPEN'|'COVERAGE_UNAVAILABLE'|'SOURCE_CONFLICT'|'SOURCE_UNAVAILABLE'|'BUSY'|'TOO_LARGE';
export class MiningDevelopmentEvidenceError extends Error {
 constructor(readonly code:Code){super(`Mining development evidence refused: ${code}`);this.name='MiningDevelopmentEvidenceError';}
}
function fail(code:Code):never{throw new MiningDevelopmentEvidenceError(code);}
function iso(value:unknown):string{
 if(!(typeof value==='string'||value instanceof Date)||!Number.isFinite(new Date(value).getTime()))return fail('SOURCE_CONFLICT');
 return new Date(value).toISOString();
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
 return JSON.stringify(value);
}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.safeParse(value);return parsed.success?parsed.data:fail('SOURCE_CONFLICT');}
type EventRow = {
 id:string;tx_key:string;observed_at:unknown;source_table:string;source_id:string;before_state:unknown;after_state:unknown;
 marker_matches:boolean;after_baseline:boolean;
}
export interface MiningDevelopmentEvidence {
 baseId:string;day:string;policyVersion:1;cutoffAt:string;base:Base|null;
 completed:Record<'keep'|'workshop'|'goldforge',Array<{id:string;level:number}>>;
 coverage:{baselineObservedAt:string;effectiveFrom:string;eventIds:string[];transactions:Array<{txKey:string;observedAt:string;eventIds:string[]}>};
 allocationReady:false;publicationAuthorized:false;
}
/** One bounded, complete transaction cut. Immutable history is reduced afresh,
 * so later completion, ownership changes and current levels cannot rewrite it. */
export async function readMiningDevelopmentEvidence(db:DbOrTx,input:unknown):Promise<MiningDevelopmentEvidence>{
 const parsed=z.object({baseId:uuid,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(1)}).strict().safeParse(input);
 if(!parsed.success)return fail('INVALID_INPUT');
 const {baseId,day,policyVersion}=parsed.data,start=Date.parse(`${day}T00:00:00.000Z`);
 if(!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==day)return fail('INVALID_INPUT');
 const cutoffAt=new Date(start+DAY_MS).toISOString();
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`lock table public.bases,public.buildings,public.builder_jobs,public.mining_development_baselines,public.mining_development_transactions,public.mining_development_events in share mode nowait`);
  const [clock]=await tx.execute<{observed_at:unknown;isolation:string}>(sql`select public.shardkeep_mining_development_clock() as observed_at,current_setting('transaction_isolation') as isolation`);
  if(!clock||clock.isolation!=='read committed')return fail('SOURCE_UNAVAILABLE');
  if(Date.parse(iso(clock.observed_at))<start+DAY_MS)return fail('DAY_OPEN');
  const [baseline]=await tx.execute<{observed_at:unknown;effective_from:unknown;base_state:unknown;buildings:unknown;jobs:unknown}>(sql`select observed_at,effective_from,base_state,buildings,jobs from public.mining_development_baselines where base_id=${baseId}::uuid`);
  if(!baseline)return fail('COVERAGE_UNAVAILABLE');
  const baselineObservedAt=iso(baseline.observed_at),effectiveFrom=iso(baseline.effective_from);
  if(Date.parse(effectiveFrom)!==Math.floor(Date.parse(baselineObservedAt)/DAY_MS)*DAY_MS+DAY_MS)return fail('SOURCE_CONFLICT');
  if(start<Date.parse(effectiveFrom))return fail('COVERAGE_UNAVAILABLE');
  if(!Array.isArray(baseline.buildings)||!Array.isArray(baseline.jobs))return fail('SOURCE_CONFLICT');
  if(baseline.buildings.length>MAX_ROWS||baseline.jobs.length>MAX_ROWS)return fail('TOO_LARGE');
  let base:Base|null=parse(baseSchema,baseline.base_state);
  if(base.id!==baseId)return fail('SOURCE_CONFLICT');
  const buildings=new Map<string,Building>(),jobs=new Map<string,Job>();
  for(const raw of baseline.buildings){const b=parse(buildingSchema,raw);if(b.base_id!==baseId||buildings.has(b.id))return fail('SOURCE_CONFLICT');buildings.set(b.id,b);}
  for(const raw of baseline.jobs){const j=parse(jobSchema,raw);if(j.base_id!==baseId||jobs.has(j.id))return fail('SOURCE_CONFLICT');jobs.set(j.id,j);}
  const events=await tx.execute<EventRow>(sql`select e.id::text,e.tx_key,e.observed_at,e.source_table,e.source_id,e.before_state,e.after_state,
   (m.observed_at=e.observed_at) is true as marker_matches,(e.observed_at>=b.observed_at) as after_baseline
   from public.mining_development_events e
   join public.mining_development_baselines b on b.base_id=e.base_id
   left join public.mining_development_transactions m on m.tx_key=e.tx_key
   where e.base_id=${baseId}::uuid and e.observed_at<${cutoffAt}::timestamptz
   order by e.observed_at,e.id limit ${MAX_ROWS+1}`);
  if(events.length>MAX_ROWS)return fail('TOO_LARGE');
  // SQL orders exact timestamp precision; groups need not have contiguous IDs.
  const groups=new Map<string,{observedAt:string;events:EventRow[]}>();
  for(const e of events){
   if(!e.marker_matches||!e.after_baseline||!/^\d+$/.test(e.id)||!/^\d+$/.test(e.tx_key))return fail('SOURCE_CONFLICT');
   const observedAt=iso(e.observed_at),group=groups.get(e.tx_key);
   if(group&&group.observedAt!==observedAt)return fail('SOURCE_CONFLICT');
   if(group)group.events.push(e);else groups.set(e.tx_key,{observedAt,events:[e]});
  }
  const uncertainBuildings=new Set<string>(),lostInitialJobs=new Set<string>();
  for(const group of groups.values())for(const e of group.events){
   const schema=e.source_table==='bases'?baseSchema:e.source_table==='buildings'?buildingSchema:e.source_table==='builder_jobs'?jobSchema:null;
   if(!schema)return fail('SOURCE_CONFLICT');
   const before=e.before_state===null?null:parse(schema as z.ZodType<Source>,e.before_state);
   const after=e.after_state===null?null:parse(schema as z.ZodType<Source>,e.after_state);
   if((!before&&!after)||(before&&before.id!==e.source_id)||(after&&after.id!==e.source_id))return fail('SOURCE_CONFLICT');
   if(e.source_table==='bases'){
    if(e.source_id!==baseId||canonical(base)!==canonical(before))return fail('SOURCE_CONFLICT');
    base=after as Base|null;continue;
   }
   const old=before as Building|Job|null,next=after as Building|Job|null;
   const oldHere=old?.base_id===baseId,nextHere=next?.base_id===baseId;
   if(!oldHere&&!nextHere)return fail('SOURCE_CONFLICT');
   const map=e.source_table==='buildings'?buildings:jobs;
   const current=map.get(e.source_id);
   if(oldHere?canonical(current??null)!==canonical(old):current!==undefined)return fail('SOURCE_CONFLICT');
   if(nextHere)(map as Map<string,Building|Job>).set(e.source_id,next!);else map.delete(e.source_id);
   if(e.source_table==='buildings'){
    // An incoming move has no proof of all jobs left at its former base. Even
    // a paired job move cannot establish the absence of another pending build.
    if(nextHere&&old&&!oldHere)uncertainBuildings.add(e.source_id);
    if(!nextHere)uncertainBuildings.delete(e.source_id);
   }else{
    const prior=before as Job|null,nextJob=after as Job|null;
    if(prior?.kind==='build'&&prior.building_id&&(prior.completed_at===null||prior.cancelled_at!==null)
     &&(!nextHere||nextJob?.building_id!==prior.building_id||nextJob.kind!=='build'))lostInitialJobs.add(prior.building_id);
   }
   if(buildings.size>MAX_ROWS||jobs.size>MAX_ROWS)return fail('TOO_LARGE');
  }
  if(uncertainBuildings.size||[...lostInitialJobs].some(id=>buildings.has(id)))return fail('SOURCE_UNAVAILABLE');
  const completed:MiningDevelopmentEvidence['completed']={keep:[],workshop:[],goldforge:[]};
  const unfinishedInitial=new Set([...jobs.values()].filter(j=>j.kind==='build'&&(j.completed_at===null||j.cancelled_at!==null)).map(j=>j.building_id));
  if(base)for(const b of buildings.values()){
   if(b.type!=='keep'&&b.type!=='workshop'&&b.type!=='goldforge')continue;
   // Stored level remains the old completed level throughout an upgrade.
   // Initial construction exposes a level early, so its job must be complete.
   if(unfinishedInitial.has(b.id))continue;
   completed[b.type].push({id:b.id,level:b.level});
  }
  for(const list of Object.values(completed))list.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return {baseId,day,policyVersion,cutoffAt,base,completed,coverage:{baselineObservedAt,effectiveFrom,eventIds:events.map(e=>e.id),
   transactions:[...groups].map(([txKey,g])=>({txKey,observedAt:g.observedAt,eventIds:g.events.map(e=>e.id)}))},allocationReady:false,publicationAuthorized:false};
 });}catch(error){const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')return fail('BUSY');throw error;}
}
