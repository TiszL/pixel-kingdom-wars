/** B4 original winning-spot raw-resource payouts. Retained admission/source
 * receipts supply authority; request fields cannot supply winners or amounts.
 * SHARDS has no accepted source in this slice and is explicitly excluded. */
import { PublicKey } from '@solana/web3.js';
import { SeekerResourceClaimRequestSchema, type SeekerResourceClaimRequest, type SeekerResourceClaimReceipt } from '@shardkeep/shared/seekerResourceClaimsApi';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { phaseESeekerEnabled } from '../config';
import { expeditionTermSnapshots, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { readStoredExpeditionTerm } from './expeditionTermStore';
import { readAdvancedExpedition } from './advancedExpeditionDispatch';
import { readAdvancedExpeditionReturn } from './advancedExpeditionReturns';
import { readHarvesterSettlement } from './harvesterSettlement';
import {readStarterExpedition} from './starterExpeditionDispatch';
import { readStarterExpeditionReturn } from './starterExpeditionReturns';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

const uuid = z.string().uuid().transform(v => v.toLowerCase());
const walletSchema = z.string().min(32).max(44).refine(value => {
 if (value.length < 32 || value.length > 44) return false;
 try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
export { SeekerResourceClaimRequestSchema } from '@shardkeep/shared/seekerResourceClaimsApi';
export type { SeekerResourceClaimRequest, SeekerResourceClaimReceipt } from '@shardkeep/shared/seekerResourceClaimsApi';
const fail = (code: string, message: string) => new HttpError(409, message, code);
const integrity = () => fail('SEEKER_RESOURCE_EVIDENCE', 'Original resource tax evidence is unavailable or inconsistent');
export const seekerResourceClaimsEnabled = phaseESeekerEnabled;
function assertAdmission() { if (!seekerResourceClaimsEnabled()) throw new HttpError(503, 'Seeker resource claims are paused', 'PHASE_E_DISABLED'); }
// Operational bounds, never a player quota. Refusal retains all earned rights.
const MAX_SOURCES = 2_000, MAX_EVENTS = 20_000, MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const uint = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => BigInt(v) <= RAW_RESOURCE_STORAGE_MAX);
export async function readOriginalSeekerResourceTerm(db: DbOrTx, id: string) {
 const [row] = await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, id));
 if (!row || Buffer.byteLength(row.canonical) > 128 * 1024) throw integrity();
 const term = await readStoredExpeditionTerm(db, id, row.snapshotHash); if (!term) throw integrity(); return term;
}
function match(receipt: SeekerResourceClaimReceipt, request: SeekerResourceClaimRequest) {
 if (receipt.idempotencyKey !== request.idempotencyKey || receipt.baseId !== request.baseId || receipt.termId !== request.termId
  || receipt.resourceId !== request.resourceId || receipt.spotId !== request.spotId)
  throw fail('IDEMPOTENCY_BODY_MISMATCH', 'This key belongs to another original resource claim');
 return receipt;
}
/** verifiedTerm is an internal already-validated snapshot from this same DB
 * transaction, never a route field. It avoids decoding one term per claim head. */
export async function readSeekerResourceClaim(db: DbOrTx, wallet: string, id: string,
 verifiedTerm?: Awaited<ReturnType<typeof readOriginalSeekerResourceTerm>>): Promise<SeekerResourceClaimReceipt | null> {
 wallet = walletSchema.parse(wallet); id = uuid.parse(id);
 const rows = await db.execute(sql`select id,wallet,base_id,term_id,term_hash,resource_id,spot_id,winner_count,
  pool_total::text,previous_total::text,cumulative_total::text,quantity::text,stock_before::text,stock_after::text,claimed_at
  from seeker_resource_claims where id=${id}::uuid and wallet=${wallet}`) as unknown as Array<Record<string, unknown>>;
 const r = rows[0]; if (!r) return null;
 const request = SeekerResourceClaimRequestSchema.parse({ idempotencyKey: r.id, baseId: r.base_id, termId: r.term_id, resourceId: r.resource_id, spotId: r.spot_id });
 const values = ['pool_total', 'previous_total', 'cumulative_total', 'quantity', 'stock_before', 'stock_after'].map(k => uint.parse(r[k]));
 const [pool, previous, cumulative, quantity, before, after] = values.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint];
 const term = verifiedTerm ?? await readOriginalSeekerResourceTerm(db, request.termId), winners = term.snapshot.spots.filter(spot => spot.ownerWallet !== null);
 if (term.snapshot.termId !== request.termId || r.term_hash !== term.hash || r.winner_count !== winners.length || !winners.some(spot => spot.spotId === request.spotId && spot.ownerWallet === wallet)
  || quantity <= 0n || previous + quantity !== cumulative || pool / BigInt(winners.length) !== cumulative || before + quantity !== after) throw integrity();
 const entries = await db.execute(sql`select bucket,delta::text from seeker_resource_claim_entries where claim_id=${id}::uuid order by bucket`) as unknown as Array<{ bucket: string; delta: string }>;
 if (entries.length !== 2 || entries[0]?.bucket !== 'base_stock' || entries[0].delta !== quantity.toString()
  || entries[1]?.bucket !== 'island_pool' || entries[1].delta !== (-quantity).toString()) throw integrity();
 const at = new Date(r.claimed_at as string | Date); if (!Number.isFinite(at.getTime())) throw integrity();
 return Object.freeze({ ...request, id, wallet, termHash: term.hash, winnerCount: winners.length, poolTotal: values[0]!, previousTotal: values[1]!,
  cumulativeTotal: values[2]!, quantity: values[3]!, stockBefore: values[4]!, stockAfter: values[5]!, claimedAt: at.toISOString(), shardsIncluded: false });
}

/** Application-owned budget shared across all resource pools on one page. */
export function createSeekerResourceSourceBudget() { return { sources: 0n, events: 0n, bytes: 0n }; }
export async function readCompleteSeekerResourcePool(db: DbOrTx, termId: string, termHash: string, resource: string,
 budget = createSeekerResourceSourceBudget()): Promise<bigint> {
 // Owner-only companion evidence never falls back to a misleading zero.
 const [capability]=await db.execute<{owner:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_expeditions'::regclass) owner`);
 if(!capability?.owner){const [present]=await db.execute<{present:boolean}>(sql`select public.shardkeep_has_equipment_resource_sources_v2(${termId}::uuid,${resource}) present`);if(present?.present!==false)throw integrity();}
 // Bound source JSON and joined receipt rows before calling historical decoders.
 const [size] = await db.execute(sql`select count(*)::text as sources,coalesce(sum(events),0)::text as events,coalesce(sum(bytes),0)::text as bytes from (
  select 1 as events,octet_length(to_jsonb(s)::text)+coalesce(octet_length(to_jsonb(r)::text),0)+512 as bytes
   from starter_expeditions s left join starter_expedition_returns r on r.expedition_id=s.id where s.term_id=${termId}::uuid
    and ((s.resource_id=${resource} and r.id is not null) or s.route_snapshot->'fitting'->>'resourceId'=${resource})
  union all select (select count(*) from harvester_events e where e.source_id=s.id),octet_length(to_jsonb(s)::text)+
   coalesce((select sum(octet_length(to_jsonb(e)::text)+512) from harvester_events e where e.source_id=s.id),0)
   from harvester_sources s where s.term_id=${termId}::uuid and s.resource_id=${resource}
 ) source_sizes`) as unknown as Array<{ sources: string; events: string; bytes: string }>;
 if (size) { budget.sources += BigInt(size.sources); budget.events += BigInt(size.events); budget.bytes += BigInt(size.bytes); }
 if (!size || budget.sources > BigInt(MAX_SOURCES) || budget.events > BigInt(MAX_EVENTS) || budget.bytes > BigInt(MAX_SOURCE_BYTES))
  throw fail('SEEKER_RESOURCE_SOURCE_BOUNDS', 'Original resource history exceeds this bounded claim reader');
 if(capability?.owner){
  const [extra]=await db.execute<{events:string;bytes:string}>(sql`with headers as materialized(select id from starter_expeditions where term_id=${termId}::uuid and (resource_id=${resource} or route_snapshot->'fitting'->>'resourceId'=${resource})),proof_rows as (
   select to_jsonb(q) j from ordinary_equipment_reservations q join headers h on h.id=q.expedition_id where q.trip_kind='starter'
   union all select to_jsonb(q) from ordinary_equipment_releases q join headers h on h.id=q.expedition_id where q.trip_kind='starter'
   union all select to_jsonb(q) from ordinary_equipment_secondary_outputs q join headers h on h.id=q.expedition_id where q.trip_kind='starter'
   union all select to_jsonb(q) from ordinary_equipment_secondary_returns q join headers h on h.id=q.expedition_id where q.trip_kind='starter'
   union all select to_jsonb(q) from ordinary_equipment_secondary_entries q join headers h on h.id=q.expedition_id where q.trip_kind='starter'
  )select count(*)::text events,coalesce(sum(octet_length(j::text)),0)::text bytes from proof_rows`);
  if(!extra)throw integrity();budget.events+=BigInt(extra.events);budget.bytes+=BigInt(extra.bytes);
  if(budget.events>BigInt(MAX_EVENTS)||budget.bytes>BigInt(MAX_SOURCE_BYTES))throw fail('SEEKER_RESOURCE_SOURCE_BOUNDS','Original resource history exceeds this bounded claim reader');
 }
 const ids = await db.execute(sql`select 'expedition' as kind,s.id from starter_expeditions s left join starter_expedition_returns r on r.expedition_id=s.id
  where s.term_id=${termId}::uuid and ((s.resource_id=${resource} and r.id is not null) or s.route_snapshot->'fitting'->>'resourceId'=${resource})
  union all select 'harvester',id from harvester_sources where term_id=${termId}::uuid and resource_id=${resource}
  order by kind,id limit ${MAX_SOURCES + 1}`) as unknown as Array<{ kind: string; id: string }>;
 if (ids.length > MAX_SOURCES) throw fail('SEEKER_RESOURCE_SOURCE_BOUNDS', 'Original resource history changed beyond the reader bound');
 let total = await readAdvancedPool(db, termId, termHash, resource, budget);
 for (const row of ids) {
  if (row.kind === 'expedition') {
   const proof = await readStarterExpeditionReturn(db, row.id);
   const original=proof?.expedition??await readStarterExpedition(db,row.id);
   if(!original||original.termId!==termId||original.termHash!==termHash||(original.resourceId!==resource&&original.routeSnapshot.secondaryOutput?.resourceId!==resource))throw integrity();
   if(proof)total+=original.resourceId===resource?proof.entries.find(e=>e.bucket==='island_pool')!.delta:BigInt(original.routeSnapshot.secondaryOutput!.islandPoolQuantity);
   else{const flights=await db.execute<{installation_id:string}>(sql`select installation_id from starter_expedition_inflight where expedition_id=${row.id}::uuid`);if(flights.length!==1||flights[0]!.installation_id!==original.installationId)throw integrity();}
  } else {
   const proof = await readHarvesterSettlement(db, row.id);
   if (!proof || proof.source.termId !== termId || proof.source.termHash !== termHash || proof.source.resourceId !== resource) throw integrity();
   total += proof.events.reduce((sum, event) => sum + event.entries.find(e => e.bucket === 'island_pool')!.delta, 0n);
  }
  if (total < 0n || total > RAW_RESOURCE_STORAGE_MAX) throw integrity();
 }
 return total;
}

export async function claimSeekerResourceTax(db: Db, wallet: string, raw: unknown,
 authority: StableBaseMutationContext, deps: { assertAdmission?: () => void } = {}): Promise<SeekerResourceClaimReceipt> {
 if ('rollback' in db) throw integrity();
 const gate = () => { assertAdmission(); deps.assertAdmission?.(); };
 wallet = walletSchema.parse(wallet); const input = SeekerResourceClaimRequestSchema.parse(raw);
 if (authority.baseId !== input.baseId) throw fail('BASE_NOT_OWNED', 'Claim destination does not match its authority');
 const prior = await readSeekerResourceClaim(db, wallet, input.idempotencyKey); if (prior) return match(prior, input);
 gate();
 try { return await db.transaction(async tx => {
  const [mode] = await tx.execute(sql`select current_setting('transaction_isolation') as isolation`) as unknown as Array<{ isolation: string }>;
  if (mode?.isolation !== 'read committed') throw integrity();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seeker-resource-request:${input.idempotencyKey}`},0))`);
  const existing = await readSeekerResourceClaim(tx, wallet, input.idempotencyKey); if (existing) return match(existing, input);
  gate();
  const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
  if (!player) throw new HttpError(404, 'player not found');
  await lockStablePrerequisiteBase(tx, wallet, authority);
  gate();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seeker-resource:${input.termId}:${input.resourceId}`},0))`);
  const term = await readOriginalSeekerResourceTerm(tx, input.termId), winners = term.snapshot.spots.filter(spot => spot.ownerWallet !== null);
  if (!winners.some(spot => spot.spotId === input.spotId && spot.ownerWallet === wallet))
   throw fail('SEEKER_RESOURCE_NOT_OWNER', 'This wallet did not win the original spot');
  const total = await readCompleteSeekerResourcePool(tx, input.termId, term.hash, input.resourceId);
  const [cursor] = await tx.execute(sql`select cumulative_total::text as cumulative from seeker_resource_claims
   where term_id=${input.termId}::uuid and resource_id=${input.resourceId} and spot_id=${input.spotId} order by cumulative_total desc limit 1`) as unknown as Array<{ cumulative: string }>;
  const previous = BigInt(cursor?.cumulative ?? '0'), cumulative = total / BigInt(winners.length);
  if (cumulative <= previous) throw fail('SEEKER_RESOURCE_NOTHING_DUE', 'No additional whole resource share is currently due');
  // Authority/source awaits may outlive an admission pause. Historical replay
  // returned above; only this new irreversible stock delivery is gated here.
  await authority.assertAuthority(tx, wallet, input.baseId);
  gate();
  await tx.execute(sql`insert into seeker_resource_claims(id,wallet,base_id,term_id,resource_id,spot_id,expected_pool,expected_previous)
   values(${input.idempotencyKey}::uuid,${wallet},${input.baseId}::uuid,${input.termId}::uuid,${input.resourceId},${input.spotId},${total.toString()}::bigint,${previous.toString()}::bigint)`);
  const result = await readSeekerResourceClaim(tx, wallet, input.idempotencyKey); if (!result) throw integrity(); return match(result, input);
 }); } catch (error) {
  const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : '';
  for (const code of ['SEEKER_RESOURCE_SOURCE_CHANGED', 'SEEKER_RESOURCE_CURSOR_CHANGED', 'SEEKER_RESOURCE_STOCK_OVERFLOW']) {
   if (cause === code) throw fail(code, code === 'SEEKER_RESOURCE_STOCK_OVERFLOW'
    ? 'The destination has no room for this resource claim' : 'Original resource rights changed; retry the same request');
  }
  throw error;
 }
}

/** All source identities are discovered before child joins. Owner proof reads
 * are bounded before decoding; ordinary roles see only the boolean probe. */
async function readAdvancedPool(db: DbOrTx, termId: string, termHash: string, resource: string,
 budget: ReturnType<typeof createSeekerResourceSourceBudget>): Promise<bigint> {
 const [access] = await db.execute<{owner:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_expeditions'::regclass) owner`);
 if (!access?.owner) {
  const [presence] = await db.execute<{present:boolean}>(sql`select public.shardkeep_has_equipment_resource_sources_v2(${termId}::uuid,${resource}) present`);
  if (presence?.present !== false) throw integrity();
  return 0n;
 }
 const [size] = await db.execute<{sources:string;events:string;bytes:string;ids:string[]}>(sql`
  with headers as materialized(select * from advanced_expeditions where term_id=${termId}::uuid and (resource_id=${resource} or route_snapshot->'fitting'->>'resourceId'=${resource})),
  supplies as materialized(select q.* from advanced_expedition_supplies q join headers h on h.id=q.expedition_id),
  operation_ids as (select reserve_id id from supplies union select consume_id from supplies),
  operations as materialized(select o.* from resource_stock_operations o where o.id in(select id from operation_ids)
   or o.id in(select reservation_id from resource_stock_operations where id in(select id from operation_ids))),
  raids as (select distinct raid_id from raw_raid_reservation_debits where reservation_id in(select id from operations)),
  proof_rows as (
   select to_jsonb(h) j from headers h
   union all select to_jsonb(q) from ordinary_equipment_reservations q join headers h on h.id=q.expedition_id where q.trip_kind='advanced'
   union all select to_jsonb(q) from ordinary_equipment_releases q join headers h on h.id=q.expedition_id where q.trip_kind='advanced'
   union all select to_jsonb(q) from ordinary_equipment_secondary_outputs q join headers h on h.id=q.expedition_id where q.trip_kind='advanced'
   union all select to_jsonb(q) from ordinary_equipment_secondary_returns q join headers h on h.id=q.expedition_id where q.trip_kind='advanced'
   union all select to_jsonb(q) from ordinary_equipment_secondary_entries q join headers h on h.id=q.expedition_id where q.trip_kind='advanced'
   union all select to_jsonb(q) from supplies q
   union all select to_jsonb(r) from advanced_expedition_returns r join headers h on h.id=r.expedition_id
   union all select to_jsonb(e) from advanced_expedition_entries e join advanced_expedition_returns r on r.id=e.return_id join headers h on h.id=r.expedition_id
   union all select to_jsonb(f) from advanced_expedition_inflight f join headers h on h.id=f.expedition_id
   union all select to_jsonb(o) from operations o
   union all select to_jsonb(e) from resource_stock_entries e where operation_id in(select id from operations)
   union all select to_jsonb(t) from expedition_term_snapshots t where term_id in(select term_id from headers)
   union all select to_jsonb(r) from raw_raid_reservation_debits r where raid_id in(select raid_id from raids)
   union all select to_jsonb(r) from raw_raid_allocations r where raid_id in(select raid_id from raids)
   union all select to_jsonb(r) from raw_raid_snapshots r where raid_id in(select raid_id from raids)
   union all select to_jsonb(r) from raw_raid_resources r where raid_id in(select raid_id from raids)
   union all select to_jsonb(r) from raw_raid_terminals r where raid_id in(select raid_id from raids)
   union all select to_jsonb(r) from raw_raid_entries r where raid_id in(select raid_id from raids)
  ) select (select count(*)::text from headers) sources,count(*)::text events,
   coalesce(sum(octet_length(j::text)),0)::text bytes,
   array(select id::text from headers order by id limit ${MAX_SOURCES+1}) ids from proof_rows`);
 if (!size) throw integrity();
 budget.sources+=BigInt(size.sources);budget.events+=BigInt(size.events);budget.bytes+=BigInt(size.bytes);
 if(budget.sources>BigInt(MAX_SOURCES)||budget.events>BigInt(MAX_EVENTS)||budget.bytes>BigInt(MAX_SOURCE_BYTES))
  throw fail('SEEKER_RESOURCE_SOURCE_BOUNDS','Original resource history exceeds this bounded claim reader');
 let total=0n;
 for(const id of size.ids){
  const source=await readAdvancedExpedition(db,id);
  if(!source||source.termId!==termId||source.termHash!==termHash||(source.resourceId!==resource&&source.routeSnapshot.secondaryOutput?.resourceId!==resource))throw integrity();
  const returned=await readAdvancedExpeditionReturn(db,id);
  if(returned)total+=source.resourceId===resource?returned.entries.find(e=>e.bucket==='island_pool')!.delta:BigInt(source.routeSnapshot.secondaryOutput!.islandPoolQuantity);
  else {
   const flights=await db.execute<{base_id:string;installation_id:string}>(sql`select base_id,installation_id from advanced_expedition_inflight where expedition_id=${id}::uuid`);
   if(flights.length!==1||flights[0]!.base_id!==source.baseId||flights[0]!.installation_id!==source.installationId)throw integrity();
  }
  if(total<0n||total>RAW_RESOURCE_STORAGE_MAX)throw integrity();
 }
 return total;
}
