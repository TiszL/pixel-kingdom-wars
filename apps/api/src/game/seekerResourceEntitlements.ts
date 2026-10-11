/** Authenticated wallet discovery of retained original-term resource rights.
 * No destination authorization, current lease, chain call or admission write. */
import { sql } from 'drizzle-orm';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { PhaseERawResourceIdSchema } from '@shardkeep/shared/phaseEResources';
import { SeekerResourceEntitlementQuerySchema, SeekerResourceEntitlementViewSchema,
 type SeekerResourceEntitlementView } from '@shardkeep/shared/seekerResourceClaimsApi';
import type { Db } from '../db/client';
import { createSeekerResourceSourceBudget, readCompleteSeekerResourcePool, readOriginalSeekerResourceTerm,
 readSeekerResourceClaim, seekerResourceClaimsEnabled } from './seekerResourceClaims';

// Operational browse limits. Hitting any evidence bound preserves rights and
// returns unavailable, never an apparently complete zero balance.
const MAX_SCANNED_TERMS = 16, MAX_TERM_BYTES = 128 * 1024;
const MAX_HEADS = PHASE_E_POLICY.seekerIsland.totalSpots * PhaseERawResourceIdSchema.options.length;
export async function readSeekerResourceEntitlements(db: Db, wallet: string, rawQuery: unknown): Promise<SeekerResourceEntitlementView> {
 const { cursor = null } = SeekerResourceEntitlementQuerySchema.parse(rawQuery);
 const base = SeekerResourceEntitlementViewSchema.parse({ version: 1, wallet, claimsEnabled: seekerResourceClaimsEnabled(),
  shardsIncluded: false, status: 'available', reason: null, cursor, nextCursor: null, rows: [] });
 try { return await db.transaction(async tx => {
  // PK seek and LIMIT precede any owner JSON read. UUID positions are refreshed
  // from null by clients; later-retained lower UUIDs are not permanently skipped.
  const terms = await tx.execute(sql`select term_id,octet_length(canonical)::text as bytes,octet_length(snapshot::text)::text as snapshot_bytes
   from expedition_term_snapshots where ${cursor === null ? sql`true` : sql`term_id>${cursor}::uuid`}
   order by term_id limit ${MAX_SCANNED_TERMS}`) as unknown as Array<{ term_id: string; bytes: string; snapshot_bytes: string }>;
  let position: string | null = null;
  const rows: SeekerResourceEntitlementView['rows'] = [];
  for (const entry of terms) {
   position = entry.term_id;
   if (BigInt(entry.bytes) > BigInt(MAX_TERM_BYTES) || BigInt(entry.snapshot_bytes) > BigInt(MAX_TERM_BYTES)) return { ...base, status: 'unavailable' as const, reason: 'SOURCE_BOUNDS' as const };
   const term = await readOriginalSeekerResourceTerm(tx, entry.term_id);
   const winners = term.snapshot.spots.filter(s => s.ownerWallet !== null), owned = winners.filter(s => s.ownerWallet === wallet);
   if (!owned.length) continue;
   const spots = sql.join(owned.map(s => sql`(${s.spotId}::integer)`), sql`, `);
   const resources = sql.join(PhaseERawResourceIdSchema.options.map(r => sql`(${r}::text)`), sql`, `);
   // Do not wallet-filter heads: a contradictory original recipient is an
   // integrity failure rather than an invisible claim and an inflated due.
   // One bounded descending index seek for each possible spot/resource; do
   // not DISTINCT/sort an ever-growing cumulative receipt history.
   const heads = await tx.execute(sql`select h.id,s.spot_id,r.resource_id from (values ${spots}) s(spot_id)
    cross join (values ${resources}) r(resource_id) cross join lateral (
     select id from seeker_resource_claims c where c.term_id=${entry.term_id}::uuid
      and c.resource_id=r.resource_id and c.spot_id=s.spot_id order by cumulative_total desc limit 1
    ) h limit ${MAX_HEADS + 1}`) as unknown as Array<{ id: string; spot_id: number; resource_id: string }>;
   if (heads.length > MAX_HEADS) return { ...base, status: 'unavailable' as const, reason: 'SOURCE_BOUNDS' as const };
   const claimed = new Map<string, bigint>();
   for (const head of heads) {
    const receipt = await readSeekerResourceClaim(tx, wallet, head.id, term);
    if (!receipt || receipt.termId !== entry.term_id || receipt.spotId !== head.spot_id || receipt.resourceId !== head.resource_id)
     throw new Error('Contradictory original claim head');
    claimed.set(`${head.spot_id}:${head.resource_id}`, BigInt(receipt.cumulativeTotal));
   }
   const budget = createSeekerResourceSourceBudget();
   for (const resource of [...PhaseERawResourceIdSchema.options].sort()) {
    const pool = await readCompleteSeekerResourcePool(tx, entry.term_id, term.hash, resource, budget);
    const cumulative = pool / BigInt(winners.length);
    for (const spot of owned) {
     const paid = claimed.get(`${spot.spotId}:${resource}`) ?? 0n;
     if (paid > cumulative) throw new Error('Claimed share exceeds complete original source');
     if (pool === 0n) continue;
     rows.push({ termId: entry.term_id, termHash: term.hash, startsAt: term.snapshot.startsAt, endsAt: term.snapshot.endsAt,
      spotId: spot.spotId, resourceId: resource, winnerCount: winners.length, poolTotal: pool.toString(), cumulativeTotal: cumulative.toString(),
      claimedTotal: paid.toString(), dueQuantity: (cumulative - paid).toString() });
    }
   }
   break; // At most one owned term per page, even if its pool is currently empty.
  }
  rows.sort((a, b) => a.spotId - b.spotId || (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
  const [more] = position === null ? [] : await tx.execute(sql`select exists(select 1 from expedition_term_snapshots where term_id>${position}::uuid) as value`) as unknown as Array<{ value: boolean }>;
  return SeekerResourceEntitlementViewSchema.parse({ ...base, rows, nextCursor: more?.value ? position : null });
 }, { isolationLevel: 'repeatable read', accessMode: 'read only' }); }
 catch (error) {
  const bounds = typeof error === 'object' && error !== null && 'code' in error && error.code === 'SEEKER_RESOURCE_SOURCE_BOUNDS';
  return { ...base, status: 'unavailable', reason: bounds ? 'SOURCE_BOUNDS' : 'SOURCE_INTEGRITY' };
 }
}
