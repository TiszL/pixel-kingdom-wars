/** Durable public quote/command evidence. These reads never perform RPC or mutate
 * custody. Only the existing marketplace transactions write lifecycle outcomes. */
import {
  MarketCancellationReceiptSchema, MarketListingReceiptSchema, MarketReservationReceiptSchema,
  type MarketCancelRequest, type MarketReserveRequest,
} from '@shardkeep/shared/market';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx, DbTx } from '../db/client';
import { itemListings, itemMarketCancellations, itemMarketReservations } from '../db/schema';
import { HttpError } from '../lib/errors';

export type MarketListing = typeof itemListings.$inferSelect;
export type MarketReservation = typeof itemMarketReservations.$inferSelect;
export type MarketCancellation = typeof itemMarketCancellations.$inferSelect;

export async function listingCreationReceipt(db: DbOrTx, actor: string, key: string) {
  const [row] = await db.select().from(itemListings).where(eq(itemListings.idempotencyKey, `item-list:${actor}:${key}`));
  return row ? MarketListingReceiptSchema.parse({ version: 1, idempotencyKey: key, creator: actor,
    listingId: row.id, itemId: row.itemId, sourceBaseId: row.baseId,
    priceLamports: row.priceLamports.toString(), createdAt: row.createdAt.toISOString() }) : null;
}
export async function reservationByKey(db: DbOrTx, buyer: string, key: string) {
  const [row] = await db.select().from(itemMarketReservations).where(and(eq(itemMarketReservations.buyerWallet, buyer), eq(itemMarketReservations.requestKey, key)));
  return row ?? null;
}
export async function reservationById(db: DbOrTx, buyer: string, id: string) {
  const [row] = await db.select().from(itemMarketReservations).where(and(eq(itemMarketReservations.buyerWallet, buyer), eq(itemMarketReservations.id, id)));
  if (!row) throw new HttpError(404, 'reservation not found');
  return row;
}
export async function recordedReservation(db: DbOrTx, listing: Pick<MarketListing, 'id' | 'reference'>) {
  if (!listing.reference) return null;
  const [row] = await db.select().from(itemMarketReservations)
    .where(and(eq(itemMarketReservations.listingId, listing.id), eq(itemMarketReservations.reference, listing.reference)));
  return row ?? null;
}
export function sameQuote(row: MarketReservation, listing: Pick<MarketListing, 'id' | 'itemId' | 'baseId' | 'buyerBaseId' | 'sellerWallet' | 'reservedBy' | 'reference' | 'priceLamports'>) {
  return row.listingId === listing.id && row.itemId === listing.itemId && row.sourceBaseId === listing.baseId
    && row.buyerBaseId === listing.buyerBaseId && row.sellerWallet === listing.sellerWallet && row.buyerWallet === listing.reservedBy
    && row.reference === listing.reference && row.priceLamports === listing.priceLamports;
}
export function requireReserveRequest(row: MarketReservation, listingId: string, request: MarketReserveRequest) {
  const saved = row.requestPayload;
  if (row.listingId !== listingId || !saved || saved.idempotencyKey !== request.idempotencyKey || saved.itemId !== request.itemId
    || saved.sourceBaseId !== request.sourceBaseId || saved.seller !== request.seller || saved.priceLamports !== request.priceLamports
    || saved.buyerBaseId !== request.buyerBaseId) throw new HttpError(409, 'reservation key was already used for different terms', 'MARKET_KEY_CONFLICT');
}
export async function reservationReceipt(db: DbOrTx, original: MarketReservation, now = new Date()) {
  // One snapshot reads immutable history and the currently authoritative generation.
  // A forward recovery must never advertise stale history as a payable quote.
  const [current] = await db.select({ row: itemMarketReservations, listing: itemListings }).from(itemMarketReservations)
    .innerJoin(itemListings, eq(itemListings.id, itemMarketReservations.listingId))
    .where(eq(itemMarketReservations.id, original.id));
  if (!current) throw new HttpError(409, 'recorded reservation is unavailable');
  const { row, listing } = current;
  const payable = row.state === 'reserved' && now < row.payableUntil && listing.status === 'reserved'
    && sameQuote(row, listing) && listing.paymentSig === null && listing.txSignature === null
    && listing.reservedUntil?.getTime() === row.payableUntil.getTime();
  return MarketReservationReceiptSchema.parse({ quote: {
    version: 1, idempotencyKey: row.requestKey, reservationId: row.id, listingId: row.listingId,
    itemId: row.itemId, buyer: row.buyerWallet, seller: row.sellerWallet, sourceBaseId: row.sourceBaseId,
    buyerBaseId: row.buyerBaseId, cluster: row.cluster, reference: row.reference, priceLamports: row.priceLamports.toString(),
    feeBps: row.feeBps, sellerLamports: row.sellerLamports.toString(), feeLamports: row.feeLamports.toString(),
    feeTreasury: row.feeTreasury, createdAt: row.createdAt.toISOString(), payableUntil: row.payableUntil.toISOString(),
  }, serverNow: now.toISOString(), payable,
  state: row.state, paymentSignature: row.paymentSig, txSignature: row.txSignature, resolvedAt: row.resolvedAt?.toISOString() ?? null });
}
export async function completeReservation(tx: DbTx, listing: Parameters<typeof sameQuote>[1], signature: string) {
  const row = await recordedReservation(tx, listing);
  if (!row) return;
  if (!sameQuote(row, listing) || !['reserved', 'committed'].includes(row.state)
    || (row.paymentSig !== null && row.paymentSig !== signature)) throw new HttpError(409, 'recorded reservation changed');
  await tx.update(itemMarketReservations).set({ state: 'settled', txSignature: signature, resolvedAt: new Date() })
    .where(eq(itemMarketReservations.id, row.id));
}
export async function cancellationByKey(db: DbOrTx, actor: string, key: string) {
  const [row] = await db.select().from(itemMarketCancellations)
    .where(and(eq(itemMarketCancellations.actorWallet, actor), eq(itemMarketCancellations.requestKey, key)));
  return row ?? null;
}
export function requireCancelRequest(row: MarketCancellation, listingId: string, request: MarketCancelRequest) {
  if (row.listingId !== listingId || row.itemId !== request.itemId || row.sourceBaseId !== request.sourceBaseId
    || row.priceLamports.toString() !== request.priceLamports || row.expectedStatus !== request.status
    || row.expectedReference !== request.reference || row.requestKey !== request.idempotencyKey) {
    throw new HttpError(409, 'cancellation key was already used for different terms', 'MARKET_KEY_CONFLICT');
  }
}
export function cancellationReceipt(row: MarketCancellation) {
  return MarketCancellationReceiptSchema.parse({ version: 1, idempotencyKey: row.requestKey, actor: row.actorWallet,
    listingId: row.listingId, itemId: row.itemId, sourceBaseId: row.sourceBaseId, priceLamports: row.priceLamports.toString(),
    expectedStatus: row.expectedStatus, expectedReference: row.expectedReference, createdAt: row.createdAt.toISOString(),
    state: row.state, resolvedAt: row.resolvedAt?.toISOString() ?? null, refusalCode: row.refusalCode,
    settlement: row.state === 'settled' ? { reference: row.settledReference, txSignature: row.settledTxSignature,
      buyer: row.settledBuyer, buyerBaseId: row.settledBuyerBaseId } : null });
}
