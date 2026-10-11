/** Captured registered-base continuity only. This is not full-day qualification or external ownership authority. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import type {DbOrTx} from '../db/client';
import {MiningRosterHistoryError,type MiningRosterBaseline,type MiningRosterSourceEvent} from './rosterHistory';
const MAX_ROWS=10_000,DAY_MS=86_400_000;
type Code=ConstructorParameters<typeof MiningRosterHistoryError>[0];
function fail(code:Code):never{throw new MiningRosterHistoryError(code);}
const wallet=z.string().min(1).max(128);
function canonical(value:string,digits:3|6){
 if(!(digits===3?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).test(value))return false;
 const ms=value.slice(0,23)+'Z',n=Date.parse(ms);return Number.isFinite(n)&&new Date(n).toISOString()===ms;
}
const timestamp=z.string().refine(value=>canonical(value,6)),instant=z.string().refine(value=>canonical(value,3));
const baseSchema=z.object({id:z.uuid(),owner_wallet:wallet,status:z.enum(['active','inactive']),land_paid_at:timestamp.nullable(),deed_asset_id:z.string().nullable(),deed_mint_asset_id:z.string().nullable(),deed_minting_at:timestamp.nullable()}).strict();
const slotSchema=z.object({wallet,slot:z.number().int().min(1).max(PHASE_E_POLICY.bases.activePerWalletMax),base_id:z.uuid(),active:z.boolean()}).strict();
const unknownAuthority={sourceUniverse:'registered-stable-bases' as const,historicalBirth:'unknown' as const,externalDeedOwnership:'unknown' as const,eligibilityAuthorized:false as const,replacementAuthorized:false as const};
const authoritySchema={sourceUniverse:z.literal('registered-stable-bases'),historicalBirth:z.literal('unknown'),externalDeedOwnership:z.literal('unknown'),eligibilityAuthorized:z.literal(false),replacementAuthorized:z.literal(false)};
const baselineSchema=z.object({wallet,observedAt:timestamp,effectiveFrom:timestamp,bases:z.array(baseSchema),slots:z.array(slotSchema),...authoritySchema}).strict();
const source=z.union([baseSchema,slotSchema]),positiveId=z.string().regex(/^[1-9]\d*$/);
const eventSchema=z.object({id:positiveId,txKey:positiveId,observedAt:timestamp,markerObservedAt:timestamp,sourceTable:z.enum(['bases','base_slots']),sourceId:z.string(),beforeState:source.nullable(),afterState:source.nullable()}).strict();
const requestSchema=z.object({wallet,baseId:z.uuid(),startsAt:instant,endsAt:instant}).strict();
const evidenceSchema=requestSchema.extend({version:z.literal(1),purpose:z.literal('registered_base_unchanged_interval'),observedAt:timestamp,baseline:baselineSchema,events:z.array(eventSchema),base:baseSchema,slot:slotSchema,...authoritySchema}).strict();
type Base=z.infer<typeof baseSchema>;type Slot=z.infer<typeof slotSchema>;type Source=Base|Slot;
export interface MiningRosterIntervalEvidence {
 version:1;purpose:'registered_base_unchanged_interval';wallet:string;baseId:string;startsAt:string;endsAt:string;observedAt:string;
 baseline:MiningRosterBaseline;events:(MiningRosterSourceEvent&{markerObservedAt:string})[];base:Base;slot:Slot;
 sourceUniverse:'registered-stable-bases';historicalBirth:'unknown';externalDeedOwnership:'unknown';eligibilityAuthorized:false;replacementAuthorized:false;
}
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const result=schema.safeParse(value);return result.success?result.data:fail(code);}
function micros(value:string){return value.replace('Z','000Z');}
function bounded(value:{baseline:{bases:unknown[];slots:unknown[]};events:unknown[]}){if(value.events.length>MAX_ROWS||value.baseline.bases.length>MAX_ROWS||value.baseline.slots.length>MAX_ROWS)fail('TOO_LARGE');}
function actor(value:Source){return 'id'in value?value.owner_wallet:value.wallet;}
function key(value:Source){return 'id'in value?value.id:`${value.wallet}:${value.slot}`;}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
/** Replays the retained complete groups. A transaction's first mutation time is never treated as its commit time. */
export function validateMiningRosterIntervalEvidence(value:unknown):MiningRosterIntervalEvidence{
 const p=parse(evidenceSchema,value);bounded(p);
 if(p.startsAt>=p.endsAt)fail('SOURCE_CONFLICT');
 const start=micros(p.startsAt),end=micros(p.endsAt),b=p.baseline;
 if(end>p.observedAt)fail('DAY_OPEN');
 if(b.wallet!==p.wallet||b.observedAt>p.observedAt||b.effectiveFrom!==new Date(Math.floor(Date.parse(b.observedAt)/DAY_MS)*DAY_MS+DAY_MS).toISOString().replace('.000Z','.000000Z'))fail('SOURCE_CONFLICT');
 if(b.observedAt>=start)fail('COVERAGE_UNAVAILABLE');
 const bases=new Map<string,Base>(),slots=new Map<string,Slot>(),slotted=new Set<string>(),assets=new Set<string>();
 for(const base of b.bases){if(base.owner_wallet!==p.wallet||bases.has(base.id))fail('SOURCE_CONFLICT');bases.set(base.id,base);
  for(const asset of new Set([base.deed_asset_id,base.deed_mint_asset_id].filter((x):x is string=>x!==null))){if(assets.has(asset))fail('SOURCE_CONFLICT');assets.add(asset);}}
 for(const slot of b.slots){if(slot.wallet!==p.wallet||slots.has(key(slot))||slotted.has(slot.base_id)||!bases.has(slot.base_id)||slot.active&&bases.get(slot.base_id)!.status!=='active')fail('SOURCE_CONFLICT');slots.set(key(slot),slot);slotted.add(slot.base_id);}
 if(b.bases.some(base=>base.status==='active'&&!b.slots.some(slot=>slot.base_id===base.id&&slot.active)))fail('SOURCE_CONFLICT');
 const base=bases.get(p.baseId),slot=b.slots.find(s=>s.base_id===p.baseId&&s.active);
 if(!base||base.status!=='active'||!slot)fail('COVERAGE_UNAVAILABLE');
 if(!same(p.base,base)||!same(p.slot,slot))fail('SOURCE_CONFLICT');
 const targetAssets=new Set([base.deed_asset_id,base.deed_mint_asset_id].filter((x):x is string=>x!==null));
 const groups=new Map<string,typeof p.events>(),ids=new Set<string>();let prior:typeof p.events[number]|undefined;
 for(const e of p.events){
  if(ids.has(e.id)||e.observedAt!==e.markerObservedAt||e.observedAt<b.observedAt||e.observedAt>p.observedAt||prior&&(e.observedAt<prior.observedAt||e.observedAt===prior.observedAt&&BigInt(e.id)<=BigInt(prior.id)))fail('SOURCE_CONFLICT');ids.add(e.id);prior=e;
  const states=[e.beforeState,e.afterState].filter((x):x is Source=>x!==null);
  if(!states.length||!states.some(s=>actor(s)===p.wallet)||states.some(s=>key(s)!==e.sourceId||('id'in s)!==(e.sourceTable==='bases')))fail('SOURCE_CONFLICT');
  // Even a change after this interval, or stamped before it, lacks a separate commit-time witness.
  if(states.some(s=>'id'in s?s.id===p.baseId||[s.deed_asset_id,s.deed_mint_asset_id].some(a=>a!==null&&targetAssets.has(a)):s.base_id===p.baseId))fail('COVERAGE_UNAVAILABLE');
  const group=groups.get(e.txKey)??[];if(group.length&&group[0]!.observedAt!==e.observedAt)fail('SOURCE_CONFLICT');group.push(e);groups.set(e.txKey,group);
 }
 for(const group of groups.values())for(const e of group){
  const table:Map<string,Source>=e.sourceTable==='bases'?bases:slots;
  if(e.beforeState&&actor(e.beforeState)===p.wallet){if(!same(table.get(key(e.beforeState)),e.beforeState))fail('SOURCE_CONFLICT');table.delete(key(e.beforeState));}
  if(e.afterState&&actor(e.afterState)===p.wallet){if(table.has(key(e.afterState)))fail('SOURCE_CONFLICT');table.set(key(e.afterState),e.afterState);}
  if(bases.size>MAX_ROWS||slots.size>MAX_ROWS)fail('TOO_LARGE');
 }
 return Object.freeze(p);
}
function mapError(error:unknown):never{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){if('code'in e&&e.code==='55P03')fail('BUSY');e='cause'in e?e.cause:undefined;}throw error;}
/** The short READ COMMITTED barrier includes all committed wallet history, including post-interval events. */
export async function readMiningRosterInterval(db:DbOrTx,input:unknown):Promise<MiningRosterIntervalEvidence>{
 const request=parse(requestSchema,input,'INVALID_INPUT');if(request.startsAt>=request.endsAt)fail('INVALID_INPUT');
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`lock table public.players,public.bases,public.base_slots,public.mining_roster_baselines,public.mining_roster_transactions,public.mining_roster_events in share mode nowait`);
  const [clock]=await tx.execute<{observed_at:string;isolation:string}>(sql`select to_char(public.shardkeep_mining_roster_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,current_setting('transaction_isolation') as isolation`);
  if(!clock||clock.isolation!=='read committed')fail('SOURCE_UNAVAILABLE');const observedAt=parse(timestamp,clock.observed_at);if(micros(request.endsAt)>observedAt)fail('DAY_OPEN');
  const [row]=await tx.execute<{wallet:string;observed_at:string;effective_from:string;bases:unknown;slots:unknown}>(sql`select wallet,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,to_char(effective_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_from,bases,slots from public.mining_roster_baselines where wallet=${request.wallet}`);
  if(!row)fail('COVERAGE_UNAVAILABLE');
  const baseline=parse(baselineSchema,{wallet:row.wallet,observedAt:row.observed_at,effectiveFrom:row.effective_from,bases:row.bases,slots:row.slots,...unknownAuthority});
  if(baseline.bases.length>MAX_ROWS||baseline.slots.length>MAX_ROWS)fail('TOO_LARGE');
  const base=baseline.bases.find(b=>b.id===request.baseId),slot=baseline.slots.find(s=>s.base_id===request.baseId&&s.active);if(!base||!slot)fail('COVERAGE_UNAVAILABLE');
  const rows=await tx.execute<{id:string;tx_key:string;observed_at:string;marker_observed_at:string|null;source_table:string;source_id:string;before_state:unknown;after_state:unknown}>(sql`select e.id::text,e.tx_key,to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,to_char(m.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as marker_observed_at,e.source_table,e.source_id,e.before_state,e.after_state from public.mining_roster_events e left join public.mining_roster_transactions m on m.tx_key=e.tx_key where e.wallet=${request.wallet} order by e.observed_at,e.id limit ${MAX_ROWS+1}`);
  if(rows.length>MAX_ROWS)fail('TOO_LARGE');
  const events=rows.map(e=>({id:e.id,txKey:e.tx_key,observedAt:e.observed_at,markerObservedAt:e.marker_observed_at,sourceTable:e.source_table,sourceId:e.source_id,beforeState:e.before_state,afterState:e.after_state}));
  return validateMiningRosterIntervalEvidence({...request,version:1,purpose:'registered_base_unchanged_interval',observedAt,baseline,base,slot,events,...unknownAuthority});
 });}catch(error){return mapError(error);}
}
