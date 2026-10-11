/** Authoritative prospective PvE XP. Never mining eligibility or publication authority. */
import { createHash } from 'node:crypto';
import { PHASE_E_MINING_EXPERIENCE_POLICY as POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db,DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { collectMiningActivityEvidence } from './activityEvidence';
const MAX_DAYS=10_000,MAX_RAIDS=2_000,MAX_SOURCE_BYTES=4_194_304;
const inputSchema=z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(POLICY.version)}).strict();
type Code='INVALID_INPUT'|'DISABLED'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'JOURNAL_CONFLICT'|'BUSY'|'TOO_LARGE';
export class MiningWalletExperienceError extends Error {constructor(readonly code:Code){super(`Mining wallet XP refused: ${code}`);this.name='MiningWalletExperienceError';}}
function fail(code:Code):never{throw new MiningWalletExperienceError(code);}
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
function canonical(v:unknown):string{if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(v!==null&&typeof v==='object')return `{${Object.entries(v).sort(([a],[b])=>lexical(a,b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;return JSON.stringify(v);}
function iso(v:unknown){const d=v instanceof Date?v:new Date(String(v));if(!Number.isFinite(+d))fail('SOURCE_CONFLICT');return d.toISOString();}
const score=(points:number,full:number)=>Number(BigInt(Math.min(points,full))*BigInt(POLICY.scoreScale)/BigInt(full));
type Award={raidId:string;wallet:string;baseId:string;firstAcceptedAt:string;points:number};
export type MiningWalletExperienceDay={day:string;policyVersion:number;allocationReady:false;publicationAuthorized:false;
 wallets:Array<{wallet:string;qualifyingRaidIds:string[];awardedRaidIds:string[];awardedXp:number;activityBps:number}>;awards:Award[]};
type Source={sourceHash:string;coverage:string;sealedAt:string;result:MiningWalletExperienceDay};
function digest(source:Source){return createHash('sha256').update(canonical({policy:POLICY,sourceHash:source.sourceHash,coverage:source.coverage,result:source.result})).digest('hex');}
const sourceSchema=z.object({raids:z.array(z.object({raid:z.object({id:z.uuid(),wallet:z.string().min(1),baseId:z.uuid().nullable(),opponent:z.string().nullable(),campaignStage:z.number().int().nullable(),stars:z.number().int().nullable(),retreated:z.boolean().nullable(),status:z.string(),deployments:z.number().int()}).passthrough(),
 events:z.array(z.object({sourceKey:z.string(),occurredAt:z.string().datetime()}).passthrough())}).passthrough()).max(MAX_RAIDS)}).passthrough();
async function source(db:Db,day:string):Promise<Source>{
 const [size]=await db.execute<{bytes:number}>(sql`select pg_column_size(evidence)+pg_column_size(result) bytes from mining_activity_evidence where day=${day}::date and policy_version='battle-evidence-v1'`);
 if(!size)fail('SOURCE_UNAVAILABLE');if(size.bytes>MAX_SOURCE_BYTES)fail('TOO_LARGE');
 // Existing replay verifies the complete immutable source hash and all original
 // actor/event/resolution bindings. It cannot capture here: existence is required.
 const activity=await collectMiningActivityEvidence(db,{day,policyVersion:'battle-evidence-v1'});
 const [row]=await db.execute<{evidence:unknown;evidence_hash:string;coverage_started_at:unknown;sealed_at:unknown}>(sql`select evidence,evidence_hash,coverage_started_at,sealed_at from mining_activity_evidence where day=${day}::date and policy_version='battle-evidence-v1'`);
 if(!row)fail('SOURCE_UNAVAILABLE');
 const grouped=new Map<string,Award[]>(),played=new Map(activity.wallets.map(w=>[w.wallet,new Set(w.playedRaidIds)]));
 for(const {raid:r,events} of sourceSchema.parse(row.evidence).raids){
  if(!played.get(r.wallet)?.has(r.id)||r.opponent!==null||r.campaignStage===null)continue;
  if(r.retreated===null)fail('SOURCE_CONFLICT');
  if(r.retreated||r.stars===null||r.stars<POLICY.minPveStars)continue;
  if(r.status!=='resolved'||!r.baseId||r.deployments<=0)fail('SOURCE_CONFLICT');
  const first=events.filter(e=>e.sourceKey==='battle_fought').map(e=>e.occurredAt).sort(lexical)[0];
  if(!first||first.slice(0,10)!==day)fail('SOURCE_CONFLICT');
  const list=grouped.get(r.wallet)??[];list.push({raidId:r.id,wallet:r.wallet,baseId:r.baseId,firstAcceptedAt:iso(first),points:POLICY.xpPerQualifiedRaid});grouped.set(r.wallet,list);
 }
 const result:MiningWalletExperienceDay={day,policyVersion:POLICY.version,allocationReady:false,publicationAuthorized:false,wallets:[],awards:[]};
 for(const [wallet,raids] of [...grouped].sort(([a],[b])=>lexical(a,b))){
  raids.sort((a,b)=>lexical(a.firstAcceptedAt,b.firstAcceptedAt)||lexical(a.raidId,b.raidId));
  if(new Set(raids.map(r=>r.raidId)).size!==raids.length)fail('SOURCE_CONFLICT');
  const awarded=raids.slice(0,POLICY.maxRewardedRaidsPerDay);result.awards.push(...awarded);
  result.wallets.push({wallet,qualifyingRaidIds:raids.map(r=>r.raidId),awardedRaidIds:awarded.map(r=>r.raidId),awardedXp:awarded.length*POLICY.xpPerQualifiedRaid,activityBps:score(raids.length,POLICY.raidsForFullActivity)});
 }
 result.awards.sort((a,b)=>lexical(a.raidId,b.raidId));
 return {sourceHash:row.evidence_hash,coverage:iso(row.coverage_started_at),sealedAt:iso(row.sealed_at),result};
}
async function replay(db:DbOrTx,s:Source):Promise<MiningWalletExperienceDay|null>{
 const [row]=await db.execute<{source_hash:string;source_coverage_started_at:unknown;result_hash:string;result:unknown}>(sql`select source_hash,source_coverage_started_at,result_hash,result from mining_wallet_experience_days where day=${s.result.day}::date and policy_version=${POLICY.version}`);
 if(!row)return null;
 const awards=await db.execute<{raid_id:string;wallet:string;base_id:string;first_accepted_at:unknown;points:number}>(sql`select raid_id,wallet,base_id,first_accepted_at,points from mining_wallet_experience_awards where day=${s.result.day}::date and policy_version=${POLICY.version} order by raid_id limit ${MAX_RAIDS+1}`);
 if(awards.length>MAX_RAIDS||row.source_hash!==s.sourceHash||iso(row.source_coverage_started_at)!==s.coverage||row.result_hash!==digest(s)||canonical(row.result)!==canonical(s.result)
  ||canonical(awards.map(a=>({raidId:a.raid_id,wallet:a.wallet,baseId:a.base_id,firstAcceptedAt:iso(a.first_accepted_at),points:a.points})))!==canonical(s.result.awards))fail('JOURNAL_CONFLICT');
 return s.result;
}
async function guarded<T>(run:()=>Promise<T>):Promise<T>{try{return await run();}catch(error){if(error instanceof z.ZodError)fail('SOURCE_CONFLICT');const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')fail('BUSY');throw error;}}
export async function collectMiningWalletExperience(db:Db,value:unknown,sourceClock?:()=>Date):Promise<MiningWalletExperienceDay>{
 const parsed=inputSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');const {day}=parsed.data;
 const start=new Date(`${day}T00:00:00.000Z`);if(!Number.isFinite(+start)||start.toISOString().slice(0,10)!==day)fail('INVALID_INPUT');
 return guarded(async()=>{
  const [existing]=await db.execute(sql`select day from mining_wallet_experience_days where day=${day}::date and policy_version=${POLICY.version}`);
  if(!existing&&!phaseEMiningEnabled())fail('DISABLED');
  const s=await source(db,day);if(existing)return (await replay(db,s))??fail('JOURNAL_CONFLICT');
  return db.transaction(async tx=>{
   await tx.execute(sql`lock table mining_activity_evidence in share mode nowait`);
   // Serialize only the new XP ledgers; no gameplay table lock or live RPC.
   await tx.execute(sql`lock table mining_wallet_experience_days,mining_wallet_experience_awards in share row exclusive mode nowait`);
   const duplicate=await replay(tx,s);if(duplicate)return duplicate;
   if(!phaseEMiningEnabled())fail('DISABLED');
   const injected=sourceClock?.();if(injected&&!Number.isFinite(+injected))fail('SOURCE_CONFLICT');
   const [observed]=await tx.execute<{now:unknown;source_hash:string}>(sql`select coalesce(${injected?.toISOString()??null}::timestamptz,clock_timestamp()) now,evidence_hash source_hash from mining_activity_evidence where day=${day}::date and policy_version='battle-evidence-v1'`);
   if(!observed||observed.source_hash!==s.sourceHash||iso(observed.now)<s.sealedAt)fail('SOURCE_CONFLICT');
   await tx.execute(sql`insert into mining_wallet_experience_days(day,policy_version,source_policy,source_hash,source_coverage_started_at,sealed_at,result_hash,result)
    values(${day}::date,${POLICY.version},'battle-evidence-v1',${s.sourceHash},${s.coverage}::timestamptz,${iso(observed.now)}::timestamptz,${digest(s)},${JSON.stringify(s.result)}::jsonb)`);
   for(const a of s.result.awards)await tx.execute(sql`insert into mining_wallet_experience_awards(raid_id,day,policy_version,wallet,base_id,first_accepted_at,points,source_hash)
    values(${a.raidId}::uuid,${day}::date,${POLICY.version},${a.wallet},${a.baseId}::uuid,${a.firstAcceptedAt}::timestamptz,${a.points},${s.sourceHash})`);
   return (await replay(tx,s))??fail('JOURNAL_CONFLICT');
  });
 });
}
/** Recorded XP is permanently wallet-owned. Coverage describes actual sealed
 * days, including empty days; absent days never silently mean zero activity. */
export async function readMiningWalletExperience(db:Db,wallet:string,throughDay?:string){
 if(!z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).safeParse(wallet).success)fail('INVALID_INPUT');
 if(throughDay!==undefined){
  if(typeof throughDay!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(throughDay))fail('INVALID_INPUT');
  const at=new Date(`${throughDay}T00:00:00.000Z`);if(!Number.isFinite(+at)||at.toISOString().slice(0,10)!==throughDay)fail('INVALID_INPUT');
 }
 return guarded(()=>db.transaction(async tx=>{
  await tx.execute(sql`lock table mining_wallet_experience_days,mining_wallet_experience_awards in share mode nowait`);
  const [clock]=await tx.execute<{now:unknown}>(sql`select clock_timestamp() now`);
  const lastClosed=new Date(Date.parse(iso(clock?.now).slice(0,10))-86_400_000).toISOString().slice(0,10);
  if(throughDay!==undefined&&throughDay>lastClosed)fail('INVALID_INPUT');
  const through=throughDay??lastClosed;
  const days=await tx.execute<{day:string;source_coverage_started_at:unknown}>(sql`select day::text,source_coverage_started_at from mining_wallet_experience_days where policy_version=${POLICY.version} and day<=${through}::date order by day limit ${MAX_DAYS+1}`);
  if(days.length>MAX_DAYS)fail('TOO_LARGE');
  const [sum]=await tx.execute<{points:string}>(sql`select coalesce(sum(points),0)::text points from mining_wallet_experience_awards where wallet=${wallet} and policy_version=${POLICY.version} and day<=${through}::date`);
  const recordedXp=Number(sum?.points);if(!Number.isSafeInteger(recordedXp)||recordedXp<0)fail('JOURNAL_CONFLICT');
  let coverage:null|{sourceCoverageStartedAt:string;firstRecordedDay:string;recordedDays:string[];observedThroughDay:string;unprocessedDays:string[];completeFromFirstRecordedDay:boolean;priorSourceRange:null|{from:string;through:string}}=null;
  if(days.length){
   const first=days[0]!.day,recordedDays=days.map(d=>d.day),seen=new Set(recordedDays),unprocessedDays:string[]=[];
   const span=(Date.parse(through)-Date.parse(first))/86_400_000;if(span<0||span>MAX_DAYS)fail('TOO_LARGE');
   for(let at=Date.parse(first);at<=Date.parse(through);at+=86_400_000){const day=new Date(at).toISOString().slice(0,10);if(!seen.has(day))unprocessedDays.push(day);}
   const sourceCoverageStartedAt=days.map(d=>iso(d.source_coverage_started_at)).sort(lexical)[0]!;
   const coveredStart=new Date(Math.ceil(Date.parse(sourceCoverageStartedAt)/86_400_000)*86_400_000).toISOString().slice(0,10);
   coverage={sourceCoverageStartedAt,firstRecordedDay:first,recordedDays,observedThroughDay:through,unprocessedDays,completeFromFirstRecordedDay:unprocessedDays.length===0,
    priorSourceRange:coveredStart<first?{from:coveredStart,through:new Date(Date.parse(first)-86_400_000).toISOString().slice(0,10)}:null};
  }
  return {wallet,policyVersion:POLICY.version,recordedXp,recordedXpBps:score(recordedXp,POLICY.xpForFullScore),coverage,allocationReady:false as const,publicationAuthorized:false as const};
 }));
}
