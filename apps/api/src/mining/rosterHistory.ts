/** Registered-base history only. Neither external deedlessness nor fee authority follows. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import type { Db,DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';
const MAX_ROWS=10_000,DAY_MS=86_400_000;
const walletSchema=z.string().min(1).max(128),timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const baseSchema=z.object({id:z.uuid(),owner_wallet:walletSchema,status:z.enum(['active','inactive']),land_paid_at:timestamp.nullable(),
 deed_asset_id:z.string().nullable(),deed_mint_asset_id:z.string().nullable(),deed_minting_at:timestamp.nullable()}).strict();
const slotSchema=z.object({wallet:walletSchema,slot:z.number().int().min(1).max(PHASE_E_POLICY.bases.activePerWalletMax),base_id:z.uuid(),active:z.boolean()}).strict();
type Base=z.infer<typeof baseSchema>;type Slot=z.infer<typeof slotSchema>;type Source=Base|Slot;
type Code='INVALID_INPUT'|'DISABLED'|'BUSY'|'DAY_OPEN'|'COVERAGE_UNAVAILABLE'|'SOURCE_CONFLICT'|'SOURCE_UNAVAILABLE'|'TOO_LARGE';
export class MiningRosterHistoryError extends Error {constructor(readonly code:Code){super(`Mining roster history refused: ${code}`);this.name='MiningRosterHistoryError';}}
function fail(code:Code):never{throw new MiningRosterHistoryError(code);}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);return result.success?result.data:fail('SOURCE_CONFLICT');}
const unknownAuthority={sourceUniverse:'registered-stable-bases' as const,historicalBirth:'unknown' as const,externalDeedOwnership:'unknown' as const,
 eligibilityAuthorized:false as const,replacementAuthorized:false as const};
export interface MiningRosterBaseline {
 wallet:string;observedAt:string;effectiveFrom:string;bases:Base[];slots:Slot[];
 sourceUniverse:'registered-stable-bases';historicalBirth:'unknown';externalDeedOwnership:'unknown';eligibilityAuthorized:false;replacementAuthorized:false;
}
async function existing(db:DbOrTx,wallet:string):Promise<MiningRosterBaseline|null>{
 const [row]=await db.execute<{wallet:string;observed_at:string;effective_from:string;bases:unknown;slots:unknown}>(sql`
  select wallet,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,
   to_char(effective_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_from,bases,slots
  from public.mining_roster_baselines where wallet=${wallet}`);
 if(!row)return null;
 return {wallet:row.wallet,observedAt:parse(timestamp,row.observed_at),effectiveFrom:parse(timestamp,row.effective_from),
  bases:parse(z.array(baseSchema).max(MAX_ROWS),row.bases),slots:parse(z.array(slotSchema).max(MAX_ROWS),row.slots),...unknownAuthority};
}
function mapError(error:unknown):never{const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')fail('BUSY');throw error;}
/** Own short transaction. The owner-only trigger takes the barrier and supplies every fact. */
export async function initializeMiningRosterHistory(db:Db,wallet:string):Promise<MiningRosterBaseline>{
 if(!walletSchema.safeParse(wallet).success)fail('INVALID_INPUT');
 const prior=await existing(db,wallet);if(prior)return prior;
 if(!phaseEMiningEnabled())fail('DISABLED');
 try{return await db.transaction(async tx=>{const duplicate=await existing(tx,wallet);if(duplicate)return duplicate;
  if(!phaseEMiningEnabled())fail('DISABLED');await tx.execute(sql`insert into public.mining_roster_baselines(wallet) values(${wallet})`);
  return (await existing(tx,wallet))!;
 });}catch(error){return mapError(error);}
}
type EventRow={id:string;tx_key:string;observed_at:string;source_table:string;source_id:string;before_state:unknown;after_state:unknown;marker_matches:boolean;after_baseline:boolean};
export interface MiningRosterSourceEvent {id:string;txKey:string;observedAt:string;sourceTable:'bases'|'base_slots';sourceId:string;beforeState:Source|null;afterState:Source|null}
function snapshot(bases:Map<string,Base>,slots:Map<string,Slot>){
 const b=[...bases.values()].sort((a,b)=>a.id.localeCompare(b.id)),s=[...slots.values()].sort((a,b)=>a.slot-b.slot);
 return {bases:b,slots:s,facts:{ownedBases:b.length,activeSlots:s.filter(x=>x.active).length,
  freeOwnedBases:b.filter(x=>x.land_paid_at===null&&x.deed_asset_id===null&&x.deed_mint_asset_id===null&&x.deed_minting_at===null).length,
  sourceIdentityConsistent:new Set(s.map(x=>x.base_id)).size===s.length
   &&s.every(x=>bases.has(x.base_id)&&(!x.active||bases.get(x.base_id)!.status==='active'))
   &&b.every(x=>x.status!=='active'||s.some(slot=>slot.active&&slot.base_id===x.id))}};
}
/** Closed-day replay uses complete committed transaction groups, never current state. */
export async function readMiningRosterHistory(db:DbOrTx,input:unknown){
 const request=z.object({wallet:walletSchema,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(1)}).strict().safeParse(input);
 if(!request.success)fail('INVALID_INPUT');const {wallet,day,policyVersion}=request.data,start=Date.parse(`${day}T00:00:00.000Z`);
 if(!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==day)fail('INVALID_INPUT');
 const startAt=`${day}T00:00:00.000000Z`,endAt=new Date(start+DAY_MS).toISOString().replace('.000Z','.000000Z');
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`lock table public.players,public.bases,public.base_slots,public.mining_roster_baselines,public.mining_roster_transactions,public.mining_roster_events in share mode nowait`);
  const [clock]=await tx.execute<{observed_at:string;isolation:string}>(sql`select to_char(public.shardkeep_mining_roster_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,current_setting('transaction_isolation') as isolation`);
  if(!clock||clock.isolation!=='read committed')fail('SOURCE_UNAVAILABLE');const observedAt=parse(timestamp,clock.observed_at);if(observedAt<endAt)fail('DAY_OPEN');
  const baseline=await existing(tx,wallet);if(!baseline||baseline.effectiveFrom>startAt)fail('COVERAGE_UNAVAILABLE');
  if(baseline.effectiveFrom!==new Date(Math.floor(Date.parse(baseline.observedAt)/DAY_MS)*DAY_MS+DAY_MS).toISOString().replace('.000Z','.000000Z'))fail('SOURCE_CONFLICT');
  const bases=new Map<string,Base>(),slots=new Map<string,Slot>();
  for(const b of baseline.bases){if(b.owner_wallet!==wallet||bases.has(b.id))fail('SOURCE_CONFLICT');bases.set(b.id,b);}
  for(const s of baseline.slots){const key=`${s.wallet}:${s.slot}`;if(s.wallet!==wallet||slots.has(key))fail('SOURCE_CONFLICT');slots.set(key,s);}
  const rows=await tx.execute<EventRow>(sql`select e.id::text,e.tx_key,to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,
   e.source_table,e.source_id,e.before_state,e.after_state,(m.observed_at=e.observed_at) is true as marker_matches,(e.observed_at>=b.observed_at) as after_baseline
   from public.mining_roster_events e left join public.mining_roster_transactions m on m.tx_key=e.tx_key
   join public.mining_roster_baselines b on b.wallet=e.wallet where e.wallet=${wallet} and e.observed_at<${endAt}::timestamptz order by e.observed_at,e.id limit ${MAX_ROWS+1}`);
  if(rows.length>MAX_ROWS)fail('TOO_LARGE');
  const groups=new Map<string,MiningRosterSourceEvent[]>(),seen=new Set<string>();
  for(const r of rows){
   if(!/^\d+$/.test(r.id)||!/^\d+$/.test(r.tx_key)||seen.has(r.id)||!r.marker_matches||!r.after_baseline)fail('SOURCE_CONFLICT');seen.add(r.id);
   const sourceTable=parse(z.enum(['bases','base_slots']),r.source_table),schema=sourceTable==='bases'?baseSchema:slotSchema;
   const before=r.before_state===null?null:parse<Source>(schema,r.before_state),after=r.after_state===null?null:parse<Source>(schema,r.after_state);
   if(!before&&!after)fail('SOURCE_CONFLICT');const actor=(s:Source|null)=>s&&('owner_wallet'in s?s.owner_wallet:s.wallet);
   if(actor(before)!==wallet&&actor(after)!==wallet)fail('SOURCE_CONFLICT');
   const ref=after??before!,expectedId='id'in ref?ref.id:`${ref.wallet}:${ref.slot}`;if(r.source_id!==expectedId)fail('SOURCE_CONFLICT');
   const event:MiningRosterSourceEvent={id:r.id,txKey:r.tx_key,observedAt:parse(timestamp,r.observed_at),sourceTable,sourceId:r.source_id,beforeState:before,afterState:after};
   const group=groups.get(r.tx_key)??[];if(group.length&&group[0]!.observedAt!==event.observedAt)fail('SOURCE_CONFLICT');group.push(event);groups.set(r.tx_key,group);
  }
  let open:ReturnType<typeof snapshot>|undefined;const changes:MiningRosterSourceEvent[]=[],broken=new Set<string>();
  for(const group of groups.values()){
   const inDay=group[0]!.observedAt>=startAt;if(inDay&&!open)open=snapshot(bases,slots);
   for(const e of group){
    const table:Map<string,Source>=e.sourceTable==='bases'?bases:slots;
    const belongs=(s:Source|null)=>s!==null&&('owner_wallet'in s?s.owner_wallet:s.wallet)===wallet;
    const key=(s:Source)=>'id'in s?s.id:`${s.wallet}:${s.slot}`;
    if(belongs(e.beforeState)){const before=e.beforeState!;if(JSON.stringify(table.get(key(before)))!==JSON.stringify(before))fail('SOURCE_CONFLICT');table.delete(key(before));}
    if(belongs(e.afterState)){const after=e.afterState!;if(table.has(key(after)))fail('SOURCE_CONFLICT');table.set(key(after),after);}
    if(bases.size>MAX_ROWS||slots.size>MAX_ROWS)fail('TOO_LARGE');
    if(inDay){changes.push(e);for(const state of [e.beforeState,e.afterState])if(state)broken.add('id'in state?state.id:state.base_id);}
   }
  }
  return {wallet,day,policyVersion,observedAt,baseline,open:open??snapshot(bases,slots),close:snapshot(bases,slots),changes,
   continuityBrokenBaseIds:[...broken].sort(),...unknownAuthority};
 });}catch(error){return mapError(error);}
}
