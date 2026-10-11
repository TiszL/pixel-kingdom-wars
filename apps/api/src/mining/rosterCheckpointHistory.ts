/** A later locked roster observation proves only subsequent unchanged registered custody. No full-day or external ownership authority follows. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import type {Db} from '../db/client';
import {MiningRosterHistoryError} from './rosterHistory';
const MAX_ROWS=10_000;
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
const checkpointSchema=z.object({id:z.uuid(),wallet,observedAt:timestamp,eventFrontier:z.string().regex(/^(0|[1-9]\d*)$/),bases:z.array(baseSchema),slots:z.array(slotSchema)}).strict();
const source=z.union([baseSchema,slotSchema]),positiveId=z.string().regex(/^[1-9]\d*$/);
const eventSchema=z.object({id:positiveId,txKey:positiveId,observedAt:timestamp,markerObservedAt:timestamp,sourceTable:z.enum(['bases','base_slots']),sourceId:z.string(),beforeState:source.nullable(),afterState:source.nullable()}).strict();
const requestSchema=z.object({wallet,baseId:z.uuid(),startsAt:instant,endsAt:instant}).strict();
const evidenceSchema=requestSchema.extend({version:z.literal(1),purpose:z.literal('registered_base_checkpoint_interval'),observedAt:timestamp,checkpoint:checkpointSchema,events:z.array(eventSchema),base:baseSchema,slot:slotSchema,...authoritySchema}).strict();
type Base=z.infer<typeof baseSchema>;type Slot=z.infer<typeof slotSchema>;type Source=Base|Slot;
export type MiningRosterCheckpointIntervalEvidence=z.infer<typeof evidenceSchema>;
function parse<T>(schema:z.ZodType<T>,value:unknown,code:Code='SOURCE_CONFLICT'):T{const result=schema.safeParse(value);return result.success?result.data:fail(code);}
function micros(value:string){return value.replace('Z','000Z');}
function bounded(value:{checkpoint:{bases:unknown[];slots:unknown[]};events:unknown[]}){if(value.events.length>MAX_ROWS||value.checkpoint.bases.length>MAX_ROWS||value.checkpoint.slots.length>MAX_ROWS)fail('TOO_LARGE');}
function actor(value:Source){return 'id'in value?value.owner_wallet:value.wallet;}
function key(value:Source){return 'id'in value?value.id:`${value.wallet}:${value.slot}`;}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
/** Replays the retained complete groups. A transaction's first mutation time is never treated as its commit time. */
export function validateMiningRosterCheckpointIntervalEvidence(value:unknown):MiningRosterCheckpointIntervalEvidence{
 const p=parse(evidenceSchema,value);bounded(p);
 if(p.startsAt>=p.endsAt)fail('SOURCE_CONFLICT');
 const start=micros(p.startsAt),end=micros(p.endsAt),b=p.checkpoint;
 if(end>p.observedAt)fail('DAY_OPEN');
 if(b.wallet!==p.wallet||b.observedAt>p.observedAt)fail('SOURCE_CONFLICT');
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
 const groups=new Map<string,string>();let prior=BigInt(b.eventFrontier);
 for(const e of p.events){
  if(BigInt(e.id)<=prior||e.observedAt!==e.markerObservedAt||e.observedAt>p.observedAt)fail('SOURCE_CONFLICT');prior=BigInt(e.id);
  const states=[e.beforeState,e.afterState].filter((x):x is Source=>x!==null);
  if(!states.length||!states.some(s=>actor(s)===p.wallet)||states.some(s=>key(s)!==e.sourceId||('id'in s)!==(e.sourceTable==='bases')))fail('SOURCE_CONFLICT');
  // Even a change after this interval, or stamped before it, lacks a separate commit-time witness.
  if(states.some(s=>'id'in s?s.id===p.baseId||[s.deed_asset_id,s.deed_mint_asset_id].some(a=>a!==null&&targetAssets.has(a)):s.base_id===p.baseId))fail('COVERAGE_UNAVAILABLE');
  const marker=groups.get(e.txKey);if(marker!==undefined&&marker!==e.observedAt)fail('SOURCE_CONFLICT');groups.set(e.txKey,e.observedAt);
 }
 // Independent transactions may interleave IDs. Replay source order, not grouped timestamps.
 for(const e of p.events){
  const table:Map<string,Source>=e.sourceTable==='bases'?bases:slots;
  if(e.beforeState&&actor(e.beforeState)===p.wallet){if(!same(table.get(key(e.beforeState)),e.beforeState))fail('SOURCE_CONFLICT');table.delete(key(e.beforeState));}
  if(e.afterState&&actor(e.afterState)===p.wallet){if(table.has(key(e.afterState)))fail('SOURCE_CONFLICT');table.set(key(e.afterState),e.afterState);}
  if(bases.size>MAX_ROWS||slots.size>MAX_ROWS)fail('TOO_LARGE');
 }
 return Object.freeze(p);
}
function mapError(error:unknown):never{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){if('code'in e&&e.code==='55P03')fail('BUSY');e='cause'in e?e.cause:undefined;}throw error;}
/** Own transaction only: an outer owner transaction could expose an uncommitted checkpoint. The barrier includes all post-interval events. */
export async function readMiningRosterCheckpointInterval(db:Db,input:unknown):Promise<MiningRosterCheckpointIntervalEvidence>{
 if('rollback' in db)fail('SOURCE_UNAVAILABLE');
 const request=parse(requestSchema,input,'INVALID_INPUT');if(request.startsAt>=request.endsAt)fail('INVALID_INPUT');
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`lock table public.players,public.bases,public.base_slots,public.mining_roster_baselines,public.mining_roster_checkpoints,public.mining_roster_transactions,public.mining_roster_events in share mode nowait`);
  const [clock]=await tx.execute<{observed_at:string;isolation:string}>(sql`select to_char(public.shardkeep_mining_roster_clock() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,current_setting('transaction_isolation') as isolation`);
  if(!clock||clock.isolation!=='read committed')fail('SOURCE_UNAVAILABLE');const observedAt=parse(timestamp,clock.observed_at);if(micros(request.endsAt)>observedAt)fail('DAY_OPEN');
  const [row]=await tx.execute<{id:string;wallet:string;observed_at:string;event_frontier:string;bases:unknown;slots:unknown}>(sql`select id,wallet,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,event_frontier::text,bases,slots from public.mining_roster_checkpoints where wallet=${request.wallet} and observed_at<${request.startsAt}::timestamptz order by observed_at desc,event_frontier desc limit 1`);
  if(!row)fail('COVERAGE_UNAVAILABLE');
  const checkpoint=parse(checkpointSchema,{id:row.id,wallet:row.wallet,observedAt:row.observed_at,eventFrontier:row.event_frontier,bases:row.bases,slots:row.slots});
  if(checkpoint.bases.length>MAX_ROWS||checkpoint.slots.length>MAX_ROWS)fail('TOO_LARGE');
  const base=checkpoint.bases.find(b=>b.id===request.baseId),slot=checkpoint.slots.find(s=>s.base_id===request.baseId&&s.active);if(!base||!slot)fail('COVERAGE_UNAVAILABLE');
  const rows=await tx.execute<{id:string;tx_key:string;observed_at:string;marker_observed_at:string|null;source_table:string;source_id:string;before_state:unknown;after_state:unknown}>(sql`select e.id::text,e.tx_key,to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at,to_char(m.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as marker_observed_at,e.source_table,e.source_id,e.before_state,e.after_state from public.mining_roster_events e left join public.mining_roster_transactions m on m.tx_key=e.tx_key where e.wallet=${request.wallet} and e.id>${checkpoint.eventFrontier}::bigint order by e.id limit ${MAX_ROWS+1}`);
  if(rows.length>MAX_ROWS)fail('TOO_LARGE');
  const events=rows.map(e=>({id:e.id,txKey:e.tx_key,observedAt:e.observed_at,markerObservedAt:e.marker_observed_at,sourceTable:e.source_table,sourceId:e.source_id,beforeState:e.before_state,afterState:e.after_state}));
  return validateMiningRosterCheckpointIntervalEvidence({...request,version:1,purpose:'registered_base_checkpoint_interval',observedAt,checkpoint,base,slot,events,...unknownAuthority});
 });}catch(error){return mapError(error);}
}
