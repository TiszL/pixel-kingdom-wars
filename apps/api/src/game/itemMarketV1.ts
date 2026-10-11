import { isCanonicalSolanaSignature } from '@shardkeep/chain';
import type { MarketCancelRequest } from '@shardkeep/shared/market';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bases, itemListings, itemMarketCancellations, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { cancelListing, settleListing, submitPayment, type ItemMarketDeps, type RecoverableListingBaseContext } from './itemMarket';
import {
  cancellationByKey, cancellationReceipt, requireCancelRequest, reservationById,
  reservationReceipt, sameQuote, type MarketCancellation,
} from './itemMarketReceipts';

export function requireMarketV1(deps: ItemMarketDeps) {
  if (!deps.cluster || !deps.feeTreasury || !deps.verifyPayment || !deps.verifyPaymentCommit) {
    throw new HttpError(503, 'versioned marketplace payment service is unavailable', 'MARKET_V1_UNAVAILABLE');
  }
}
export async function payReservation(db: Db, deps: ItemMarketDeps, buyer: string, id: string, reference: string, signature?: string, settle = false) {
  const row = await reservationById(db, buyer, id);
  if (row.reference !== reference || (signature !== undefined && (!isCanonicalSolanaSignature(signature)
    || (row.paymentSig !== null && row.paymentSig !== signature) || (row.txSignature !== null && row.txSignature !== signature)))) {
    throw new HttpError(409, 'payment does not match the saved reservation');
  }
  if (!['reserved', 'committed'].includes(row.state)) {
    // Terminal generation: nothing here can settle, refund or re-quote it (see
    // settlePaidExpired, case 3). A signature that still proves an exact split
    // for this dead quote is real SOL sitting in the seller's wallet with no
    // custodial refund path, so it is surfaced loudly for support instead of
    // being answered with a bare receipt.
    if (signature && row.state !== 'settled' && deps.verifyPaymentCommit && deps.cluster === row.cluster) {
      const late = await deps.verifyPaymentCommit({ reference: row.reference, buyer, seller: row.sellerWallet,
        feeTreasury: row.feeTreasury, sellerLamports: row.sellerLamports, feeLamports: row.feeLamports,
        paymentSignature: signature }).catch(() => null);
      if (late) {
        console.error(`[market] LATE PAYMENT ${late.txSignature} proves a ${row.state} reservation ${row.id} `
          + `(listing ${row.listingId}, buyer ${buyer}, seller ${row.sellerWallet}, ${row.priceLamports} lamports) — `
          + 'the item cannot be delivered from this generation; support must arrange the refund');
      }
    }
    return reservationReceipt(db, row);
  }
  if (deps.cluster !== row.cluster) throw new HttpError(503, 'saved reservation network is unavailable');
  const [listing] = await db.select().from(itemListings).where(eq(itemListings.id, row.listingId));
  if (!listing || !sameQuote(row, listing)) throw new HttpError(409, 'reservation is no longer current');
  if (settle) await settleListing(db, deps, buyer, row.listingId, reference, signature);
  else {
    if (!signature) throw new HttpError(422, 'payment signature required');
    await submitPayment(db, deps, buyer, row.listingId, signature, new Date(), reference);
  }
  return reservationReceipt(db, await reservationById(db, buyer, id));
}

export async function ownListingsV1(db: Db, actor: string) {
  const rows = await db.select({ id: itemListings.id, itemId: itemListings.itemId, baseId: itemListings.baseId,
    priceLamports: itemListings.priceLamports, status: itemListings.status, reference: itemListings.reference }).from(itemListings)
    .leftJoin(bases, eq(bases.id, itemListings.baseId)).where(and(
      or(and(isNull(itemListings.baseId), eq(itemListings.sellerWallet, actor)), eq(bases.ownerWallet, actor)),
      ne(itemListings.status, 'sold'), ne(itemListings.status, 'cancelled')));
  return { listings: rows.map((r) => ({ id: r.id, itemId: r.itemId, baseId: r.baseId, priceLamports: r.priceLamports.toString(), status: r.status,
    cancelConsent: { version: 1 as const, status: r.status, reference: r.reference } })) };
}

/** Admission records intent, not authority to unwind later. Every pending execution
 * still uses the existing current-source owner/finalized/raid checks. */
async function admitCancellation(db: Db, actor: string, listingId: string, request: MarketCancelRequest) {
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, actor)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const existing = await cancellationByKey(tx, actor, request.idempotencyKey);
    if (existing) { requireCancelRequest(existing, listingId, request); return existing; }
    const [listing] = await tx.select().from(itemListings).where(eq(itemListings.id, listingId)).for('update');
    if (!listing) throw new HttpError(404, 'listing not found');
    if (listing.baseId) {
      const [source] = await tx.select({ owner: bases.ownerWallet }).from(bases).where(eq(bases.id, listing.baseId));
      if (source?.owner !== actor) throw new HttpError(404, 'listing not found or not yours');
    } else if (listing.sellerWallet !== actor) throw new HttpError(404, 'listing not found or not yours');
    if (request.itemId !== listing.itemId || request.sourceBaseId !== listing.baseId || BigInt(request.priceLamports) !== listing.priceLamports
      || request.status !== listing.status || request.reference !== listing.reference) throw new HttpError(409, 'listing changed since cancellation review', 'MARKET_CONSENT_CHANGED');
    const [row] = await tx.insert(itemMarketCancellations).values({ actorWallet: actor, requestKey: request.idempotencyKey,
      listingId, itemId: listing.itemId, sourceBaseId: listing.baseId, priceLamports: listing.priceLamports,
      expectedStatus: request.status, expectedReference: request.reference }).returning();
    return row!;
  });
}

/** A crash between paid rescue and the cancellation response is recoverable from
 * exact sold proof. This is an explicit POST reconciliation, never a mutating GET. */
async function resolveCancellation(db: Db, pending: MarketCancellation, refusalCode?: string) {
  return db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, pending.actorWallet)).for('update');
    const [listing] = await tx.select().from(itemListings).where(eq(itemListings.id, pending.listingId)).for('update');
    const row = await cancellationByKey(tx, pending.actorWallet, pending.requestKey);
    if (!row || row.state !== 'pending') return row ?? pending;
    if (listing?.status === 'sold' && listing.reference === row.expectedReference && listing.itemId === row.itemId
      && listing.baseId === row.sourceBaseId && listing.priceLamports === row.priceLamports && listing.buyerWallet && listing.txSignature) {
      const [resolved] = await tx.update(itemMarketCancellations).set({ state: 'settled', resolvedAt: new Date(),
        settledReference: listing.reference, settledTxSignature: listing.txSignature, settledBuyer: listing.buyerWallet,
        settledBuyerBaseId: listing.buyerBaseId }).where(eq(itemMarketCancellations.id, row.id)).returning();
      return resolved!;
    }
    if (refusalCode) {
      const [resolved] = await tx.update(itemMarketCancellations).set({ state: 'refused', refusalCode, resolvedAt: new Date() })
        .where(eq(itemMarketCancellations.id, row.id)).returning();
      return resolved!;
    }
    return row;
  });
}
export async function cancelListingV1(db: Db, deps: ItemMarketDeps, actor: string, listingId: string, request: MarketCancelRequest,
  context: (baseId: string) => RecoverableListingBaseContext) {
  const old = await cancellationByKey(db, actor, request.idempotencyKey);
  if (old) requireCancelRequest(old, listingId, request);
  let row = old ?? await admitCancellation(db, actor, listingId, request);
  if (row.state !== 'pending') return cancellationReceipt(row);
  row = await resolveCancellation(db, row);
  if (row.state !== 'pending') return cancellationReceipt(row);
  try {
    await cancelListing(db, deps, actor, listingId, new Date(), row.sourceBaseId ? context(row.sourceBaseId) : undefined, row);
  } catch (error) {
    // Only deterministic service refusals retire the attempt. RPC/availability
    // errors remain pending and exact same-key reconciliation remains available.
    const refusal = error instanceof HttpError && [404, 409, 422].includes(error.statusCode)
      ? (error.code === 'MARKET_CONSENT_CHANGED' ? error.code : 'MARKET_CANCEL_REFUSED') : undefined;
    row = await resolveCancellation(db, row, refusal);
    if (row.state === 'pending') throw error;
    return cancellationReceipt(row);
  }
  return cancellationReceipt((await cancellationByKey(db, actor, request.idempotencyKey))!);
}
