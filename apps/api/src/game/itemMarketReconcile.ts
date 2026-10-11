/**
 * Item-market reservation reconciler (worker job `market-reconcile`).
 *
 * Until 2026-09-16 the whole reservation lifecycle after `reserve` was driven
 * by the BUYER's client polling /settle. Tester report 24b9184d showed the
 * gap: a buyer whose wallet approval never produced a signature closed the
 * game, the reservation sat `reserved` for hours with the seller's unit held
 * and neither side told the truth, until another buyer happened to take it
 * over. The mirror case — a buyer who paid and then lost connectivity — would
 * have held a PAID item in escrow just as long. This sweep makes both outcomes
 * independent of any client:
 *
 *   committed / paid   → settled and delivered to the frozen buyer base
 *                        (settlePaidExpired: finalized, two-source, strict
 *                        uncertainty — exactly the takeover/cancel proof);
 *   lapsed and UNPAID  → released back to the book (`active`, receipt
 *                        `superseded`) once past the reclaim cutoff, the same
 *                        moment a takeover could have reopened it;
 *   anything uncertain → left untouched and counted (RPC disagreement,
 *                        unavailable finalized body, committed-but-not-final).
 *
 * No verifier ⇒ nothing runs. A verifier-less pass could only read "unpaid"
 * from silence, which is how a paying buyer loses an item.
 *
 * Queue discipline (security review 2026-09-17 #1): a pass read the 25 oldest
 * reserved rows, so 25 permanently uncertain ones (a pinned signature the RPC
 * no longer returns, a commitment that never finalised) filled every batch and
 * a newer lapsed reservation was never read. Each attempt is now stamped on
 * the row's current generation; rows tried within reconcileRetrySec are
 * skipped, never-attempted rows are read first and the rest rotate
 * least-recently-attempted first, exactly as the league settlement queue does.
 * A stuck row is logged on its first failed attempt only and counted after.
 */
import { MARKETPLACE } from '@shardkeep/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { itemListings } from '../db/schema';
import { HttpError } from '../lib/errors';
import { isReclaimable, releaseLapsedReservation, settlePaidExpired, type ItemMarketDeps } from './itemMarket';

export interface MarketReconcileResult {
  configured: boolean;
  /** Reserved rows examined this pass (bounded by MARKETPLACE.itemMarket.reconcileBatch). */
  scanned: number;
  /** Delivered to their buyer on finalized proof. */
  settled: number;
  /** Lapsed, proven unpaid, returned to the open book. */
  released: number;
  /** Unpaid but still inside the reclaim cutoff — the buyer may still pay. */
  waiting: number;
  /** Committed (confirmed proof) but not yet finalized — held for the buyer. */
  held: number;
  /** Proof unavailable or contradictory — untouched, retried next pass. */
  uncertain: number;
}

export async function reconcileMarketReservations(
  db: Db, deps: ItemMarketDeps, now = new Date(),
  /** Restrict a pass to these listings (an ops one-off, or a test on the shared DB). */
  scope: { listingIds?: readonly string[] } = {},
): Promise<MarketReconcileResult> {
  const result: MarketReconcileResult = {
    configured: !!deps.verifyPayment && !!deps.feeTreasury,
    scanned: 0, settled: 0, released: 0, waiting: 0, held: 0, uncertain: 0,
  };
  if (!result.configured) return result;
  const graceCutoff = new Date(now.getTime() - MARKETPLACE.itemMarket.reclaimGraceSec * 1000);
  const retryCutoff = new Date(now.getTime() - MARKETPLACE.itemMarket.reconcileRetrySec * 1000);
  // Committed rows are checked from their first pass (finality is ~13s away);
  // uncommitted rows only once lapsed past the short grace, so a live buyer
  // mid-approval is never raced by the worker's RPC reads. Never-attempted rows
  // first (oldest reservation first among them), then least recently attempted.
  const rows = await db.select().from(itemListings).where(and(
    eq(itemListings.status, 'reserved'), isNotNull(itemListings.reference), isNotNull(itemListings.reservedBy),
    or(isNotNull(itemListings.paymentSig), lte(itemListings.reservedUntil, graceCutoff)),
    or(isNull(itemListings.reconcileAttemptedAt), lte(itemListings.reconcileAttemptedAt, retryCutoff)),
    scope.listingIds ? inArray(itemListings.id, [...scope.listingIds]) : undefined,
  )).orderBy(sql`${itemListings.reconcileAttemptedAt} ASC NULLS FIRST`, asc(itemListings.reservedUntil))
    .limit(MARKETPLACE.itemMarket.reconcileBatch);
  for (const listing of rows) {
    result.scanned++;
    const firstAttempt = listing.reconcileAttemptedAt === null;
    // Persist the attempt before the proof and outside every transaction, on
    // this exact generation only: a row whose proof stays unavailable rotates
    // behind untouched rows for reconcileRetrySec even though nothing else
    // about it changes, so a batch of stuck rows cannot starve a newer one.
    await db.update(itemListings).set({ reconcileAttemptedAt: now }).where(and(
      eq(itemListings.id, listing.id), eq(itemListings.status, 'reserved'), eq(itemListings.reference, listing.reference!),
    ));
    try {
      if (await settlePaidExpired(db, deps, listing)) { result.settled++; continue; }
      if (!isReclaimable(listing, now)) { result.waiting++; continue; }
      if (await releaseLapsedReservation(db, listing, now)) result.released++;
      else result.uncertain++; // the generation moved on under us — next pass re-reads it
    } catch (error) {
      if (error instanceof HttpError && error.code === 'MARKET_PAYMENT_UNCERTAIN') { result.held++; continue; }
      result.uncertain++;
      // Once per stuck row: later attempts are counted in `uncertain`, not logged.
      if (firstAttempt) {
        console.error(`[market-reconcile] listing ${listing.id} left untouched (reserved by ${listing.reservedBy}); `
          + `retried every ${MARKETPLACE.itemMarket.reconcileRetrySec}s, further failures are counted, not logged:`, error);
      }
    }
  }
  return result;
}
