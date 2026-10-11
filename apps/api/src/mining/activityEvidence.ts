/** Server-recorded battle participation only. This journal cannot allocate rewards. */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';

const policyVersion='battle-evidence-v1' as const;
// Operational bounds keep the activity capture barrier short; these are not scoring limits.
const MAX_CANDIDATES=2_000, MAX_HISTORY=10_000;
const unavailable=['contribution','epoch-roster','bonus','progression','source-attribution'] as const;
const timestamp=z.string().datetime();
const inputSchema=z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(policyVersion)}).strict();
const eventSchema=z.object({id:z.string(),wallet:z.string(),baseId:z.string().uuid().nullable(),
  sourceKey:z.enum(['battle_fought','pve_battle','pvp_win']),sourceTable:z.enum(['raids','raid_commands']),sourceId:z.string(),
  occurredAt:timestamp,capturedAt:timestamp,active:z.boolean(),fought:z.boolean(),invalidatedAt:timestamp.nullable(),metadata:z.record(z.string(),z.unknown())}).strict();
const raidSchema=z.object({id:z.string().uuid(),wallet:z.string(),baseId:z.string().uuid().nullable(),
  opponent:z.string().nullable(),campaignStage:z.number().int().nullable(),createdAt:timestamp,resolvedAt:timestamp.nullable(),
  status:z.enum(['pending_orders','resolving','resolved','expired']),deployments:z.number().int().nonnegative(),
  stars:z.number().int().nonnegative().nullable(),retreated:z.boolean().nullable()}).strict();
const evidenceSchema=z.object({observedAt:timestamp,raids:z.array(z.object({raid:raidSchema,events:z.array(eventSchema)}).strict()).max(MAX_CANDIDATES)}).strict();
const resultSchema=z.object({day:z.string(),policyVersion:z.literal(policyVersion),allocationReady:z.literal(false),
  unavailable:z.tuple([z.literal(unavailable[0]),z.literal(unavailable[1]),z.literal(unavailable[2]),z.literal(unavailable[3]),z.literal(unavailable[4])]),
  wallets:z.array(z.object({wallet:z.string().min(1),playedRaidIds:z.array(z.string().uuid()),freshBattleEvidence:z.literal(true),lastActionAt:timestamp}).strict())}).strict();
export type MiningActivityEvidenceResult=z.infer<typeof resultSchema>;
type Evidence=z.infer<typeof evidenceSchema>;
type Code='INVALID_INPUT'|'DAY_OPEN'|'COVERAGE_UNAVAILABLE'|'ACTIVITY_BUSY'|'TOO_LARGE'|'PENDING_BATTLES'|'SOURCE_CONFLICT'|'JOURNAL_CONFLICT';
export class MiningActivityEvidenceError extends Error {
  constructor(readonly code:Code) {super(`Mining battle evidence refused: ${code}`);this.name='MiningActivityEvidenceError';}
}
function fail(code:Code):never {throw new MiningActivityEvidenceError(code);}
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object') return `{${Object.entries(value).sort(([a],[b])=>lexical(a,b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function iso(value:unknown):string {
  const date=value instanceof Date?value:new Date(String(value));
  if(!Number.isFinite(+date)) return fail('SOURCE_CONFLICT');
  return date.toISOString();
}
function derive(day:string,coverage:string,evidence:Evidence):MiningActivityEvidenceResult {
  const wallets=new Map<string,{wallet:string;playedRaidIds:string[];freshBattleEvidence:true;lastActionAt:string}>();
  for(const {raid:r,events} of evidence.raids) {
    if(r.createdAt<coverage) fail('COVERAGE_UNAVAILABLE');
    if(!r.baseId || events.length===0) fail('SOURCE_CONFLICT');
    for(const e of events) {
      if(e.wallet!==r.wallet || e.baseId!==r.baseId || e.metadata['raidId']!==r.id
        || e.metadata['opponentWallet']!==r.opponent || e.metadata['campaignStage']!==r.campaignStage
        || e.id!==`${e.sourceTable}:${e.sourceId}:${e.sourceKey}:${e.wallet}`
        || e.occurredAt<r.createdAt || e.occurredAt>evidence.observedAt
        || e.capturedAt>evidence.observedAt
        || (e.sourceTable==='raids'&&e.sourceId!==r.id)
        || (e.sourceTable==='raid_commands'&&(e.sourceKey!=='battle_fought'||!/^\d+$/.test(e.sourceId)))) fail('SOURCE_CONFLICT');
    }
    const accepted=events.filter(e=>e.sourceKey==='battle_fought');
    if(!accepted.length || accepted.some(e=>!e.active||!e.fought)) fail('SOURCE_CONFLICT');
    accepted.sort((a,b)=>lexical(a.occurredAt,b.occurredAt)||lexical(a.id,b.id));
    // Assign the raid once, including when a later deployment crosses midnight.
    if(accepted[0]!.occurredAt.slice(0,10)!==day) continue;
    const actions=accepted.filter(e=>e.invalidatedAt===null&&e.occurredAt.slice(0,10)===day);
    if(!actions.length || r.opponent===r.wallet || r.status==='expired') continue;
    if(r.status!=='resolved') fail('PENDING_BATTLES');
    if(r.stars===null || !r.resolvedAt || r.deployments===0) fail('SOURCE_CONFLICT');
    const qualifying=r.opponent===null?(r.campaignStage===null||r.stars>0):r.stars>0;
    const resolutions=events.filter(e=>e.sourceKey!=='battle_fought');
    if(!qualifying) {if(resolutions.length) fail('SOURCE_CONFLICT');continue;}
    if(resolutions.length===0) fail('PENDING_BATTLES');
    const resolution=resolutions[0]!;
    if(resolutions.length!==1 || resolution.sourceTable!=='raids' || resolution.sourceKey!==(r.opponent===null?'pve_battle':'pvp_win')
      || resolution.active || resolution.fought || resolution.invalidatedAt!==null || resolution.metadata['stars']!==r.stars
      || resolution.occurredAt<accepted[0]!.occurredAt) fail('SOURCE_CONFLICT');
    const lastActionAt=actions[actions.length-1]!.occurredAt;
    const wallet=wallets.get(r.wallet)??{wallet:r.wallet,playedRaidIds:[],freshBattleEvidence:true,lastActionAt};
    wallet.playedRaidIds.push(r.id); if(lastActionAt>wallet.lastActionAt) wallet.lastActionAt=lastActionAt;
    wallets.set(r.wallet,wallet);
  }
  return {day,policyVersion,allocationReady:false,unavailable:[...unavailable],wallets:[...wallets.values()]
    .map(w=>({...w,playedRaidIds:w.playedRaidIds.sort(lexical)})).sort((a,b)=>lexical(a.wallet,b.wallet))};
}
const hash=(day:string,coverageStartedAt:string,evidence:Evidence,result:MiningActivityEvidenceResult)=>createHash('sha256')
  .update(canonical({day,policyVersion,coverageStartedAt,evidence,result})).digest('hex');
async function replay(db:DbOrTx,day:string):Promise<MiningActivityEvidenceResult|null> {
  const [row]=await db.execute<{coverage_started_at:unknown;evidence:unknown;result:unknown;evidence_hash:string}>(sql`
    select coverage_started_at,evidence,result,evidence_hash from mining_activity_evidence where day=${day}::date and policy_version=${policyVersion}`);
  if(!row) return null;
  try {
    const evidence=evidenceSchema.parse(row.evidence),result=resultSchema.parse(row.result),coverage=iso(row.coverage_started_at);
    if(result.day!==day || coverage>`${day}T00:00:00.000Z`
      || hash(day,coverage,evidence,result)!==row.evidence_hash || canonical(derive(day,coverage,evidence))!==canonical(result)) fail('JOURNAL_CONFLICT');
    return result;
  } catch {return fail('JOURNAL_CONFLICT');}
}

export async function collectMiningActivityEvidence(db:Db,value:unknown,sourceClock?:()=>Date):Promise<MiningActivityEvidenceResult> {
  const parsed=inputSchema.safeParse(value);
  if(!parsed.success) return fail('INVALID_INPUT');
  const {day}=parsed.data,start=new Date(`${day}T00:00:00.000Z`);
  if(!Number.isFinite(+start)||start.toISOString().slice(0,10)!==day) return fail('INVALID_INPUT');
  const end=new Date(+start+86_400_000);
  const existing=await replay(db,day); if(existing) return existing;
  try {return await db.transaction(async tx=>{
    // Live capture samples acceptance time only after its ROW EXCLUSIVE lock.
    // NOWAIT avoids inverting an in-flight gameplay transaction's source locks.
    await tx.execute(sql`lock table raids,player_action_events,playtest_activity_coverage in share mode nowait`);
    const [lock]=await tx.execute<{locked:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'mining-activity:'+day},0)) as locked`);
    if(!lock?.locked) fail('ACTIVITY_BUSY');
    const duplicate=await replay(tx,day); if(duplicate) return duplicate;
    const injected=sourceClock?.();if(injected&&!Number.isFinite(+injected))fail('SOURCE_CONFLICT');
    const [clock]=await tx.execute<{now:unknown}>(sql`select coalesce(${injected?.toISOString()??null}::timestamptz,clock_timestamp()) as now`);
    const observedAt=iso(clock?.now);
    if(observedAt<end.toISOString()) fail('DAY_OPEN');
    const [coverageRow]=await tx.execute<{started_at:unknown}>(sql`select started_at from playtest_activity_coverage where key='authoritative-v1'`);
    if(!coverageRow) fail('COVERAGE_UNAVAILABLE');
    const coverage=iso(coverageRow.started_at); if(coverage>start.toISOString()) fail('COVERAGE_UNAVAILABLE');
    const candidates=await tx.execute<{raid_id:unknown}>(sql`select metadata->>'raidId' as raid_id from player_action_events
      where source_key='battle_fought' and occurred_at>=${start.toISOString()}::timestamptz and occurred_at<${end.toISOString()}::timestamptz
      order by occurred_at,id limit ${MAX_CANDIDATES+1}`);
    if(candidates.length>MAX_CANDIDATES) fail('TOO_LARGE');
    const ids=[...new Set(candidates.map(row=>{const id=z.string().uuid().safeParse(row.raid_id);return id.success?id.data:fail('SOURCE_CONFLICT');}))].sort(lexical);
    const evidence:Evidence={observedAt,raids:[]};
    if(ids.length) {
      const idList=sql.join(ids.map(id=>sql`${id}`),sql`, `);
      const rows=await tx.execute<Record<string,unknown>>(sql`select id,attacker_wallet,attacker_base_id,defender_wallet,campaign_stage,
        created_at,resolved_at,status,orders,result from raids where id::text in (${idList}) order by id`);
      if(rows.length!==ids.length) fail('SOURCE_CONFLICT');
      const history=await tx.execute<Record<string,unknown>>(sql`select * from player_action_events
        where metadata->>'raidId' in (${idList}) and source_key in ('battle_fought','pve_battle','pvp_win')
        order by occurred_at,id limit ${MAX_HISTORY+1}`);
      if(history.length>MAX_HISTORY) fail('TOO_LARGE');
      const events=history.map(e=>eventSchema.parse({id:e.id,wallet:e.wallet,baseId:e.base_id,sourceKey:e.source_key,sourceTable:e.source_table,
        sourceId:e.source_id,occurredAt:iso(e.occurred_at),capturedAt:iso(e.captured_at),active:e.active,fought:e.fought,
        invalidatedAt:e.invalidated_for_scoring_at===null?null:iso(e.invalidated_for_scoring_at),metadata:e.metadata}));
      for(const row of rows) {
        const orders=row.orders as {deploys?:unknown;heroDeploys?:unknown}|null,result=row.result as {stars?:unknown;retreated?:unknown}|null;
        if(orders&&((orders.deploys!==undefined&&!Array.isArray(orders.deploys))||(orders.heroDeploys!==undefined&&!Array.isArray(orders.heroDeploys)))) fail('SOURCE_CONFLICT');
        const raid=raidSchema.parse({id:row.id,wallet:row.attacker_wallet,baseId:row.attacker_base_id,opponent:row.defender_wallet,
          campaignStage:row.campaign_stage,createdAt:iso(row.created_at),resolvedAt:row.resolved_at===null?null:iso(row.resolved_at),status:row.status,
          deployments:(Array.isArray(orders?.deploys)?orders.deploys.length:0)+(Array.isArray(orders?.heroDeploys)?orders.heroDeploys.length:0),
          stars:result?.stars??null,retreated:result?.retreated??null});
        evidence.raids.push({raid,events:events.filter(e=>e.metadata['raidId']===raid.id)});
      }
    }
    const result=derive(day,coverage,evidence),digest=hash(day,coverage,evidence,result);
    await tx.execute(sql`insert into mining_activity_evidence(day,policy_version,coverage_started_at,sealed_at,evidence_hash,evidence,result)
      values(${day}::date,${policyVersion},${coverage}::timestamptz,${observedAt}::timestamptz,${digest},${JSON.stringify(evidence)}::jsonb,${JSON.stringify(result)}::jsonb)
      on conflict(day,policy_version) do nothing`);
    return (await replay(tx,day))??fail('JOURNAL_CONFLICT');
  });} catch(error) {
    if(error instanceof z.ZodError) return fail('SOURCE_CONFLICT');
    const e=error as {code?:string;cause?:{code?:string}};
    if(e.code==='55P03'||e.cause?.code==='55P03') return fail('ACTIVITY_BUSY');
    throw error;
  }
}
