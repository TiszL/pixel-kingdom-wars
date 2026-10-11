import { describe, expect, it } from 'vitest';
import { MARKETPLACE } from './constants';
import { MarketCancellationReceiptSchema, MarketQuoteSchema, MarketReservationReceiptSchema } from './market';
const price = BigInt(MARKETPLACE.itemMarket.minPriceLamports);
const fee = price * BigInt(MARKETPLACE.feeBps) / 10000n;
const quote = { version: 1, idempotencyKey: 'review-key', reservationId: '00000000-0000-4000-8000-000000000001',
  listingId: '00000000-0000-4000-8000-000000000002', itemId: 'wardens_helm', buyer: '2'.repeat(32), seller: '3'.repeat(32),
  sourceBaseId: null, buyerBaseId: null, cluster: 'devnet', reference: '4'.repeat(32), priceLamports: price.toString(),
  feeBps: MARKETPLACE.feeBps, sellerLamports: (price - fee).toString(), feeLamports: fee.toString(), feeTreasury: '5'.repeat(32),
  createdAt: '2026-09-12T12:00:00.000Z', payableUntil: '2026-09-12T12:01:00.000Z' };
describe('immutable marketplace receipt contracts', () => {
  it('requires exact split, distinct parties, paired custody, network and ordered deadline', () => {
    expect(MarketQuoteSchema.safeParse(quote).success).toBe(true);
    for (const changed of [{ feeLamports: (fee + 1n).toString() }, { feeBps: 1.5 }, { seller: quote.buyer },
      { buyerBaseId: quote.listingId }, { cluster: 'testnet' }, { payableUntil: quote.createdAt }, { priceLamports: '1e9' }]) {
      expect(MarketQuoteSchema.safeParse({ ...quote, ...changed }).success).toBe(false);
    }
  });
  it('terminal and committed receipts cannot invite a new payment or omit immutable proof', () => {
    const pending = { quote, serverNow: quote.createdAt, payable: true, state: 'reserved', paymentSignature: null, txSignature: null, resolvedAt: null };
    expect(MarketReservationReceiptSchema.safeParse(pending).success).toBe(true);
    for (const change of [{ serverNow: quote.payableUntil }, { state: 'committed', paymentSignature: '2'.repeat(88) },
      { state: 'settled', payable: false, resolvedAt: quote.payableUntil }, { state: 'cancelled', payable: false }]) {
      expect(MarketReservationReceiptSchema.safeParse({ ...pending, ...change }).success).toBe(false);
    }
  });
  it('cancellation paid rescue attributes the reviewed reference and original destination scope', () => {
    const receipt = { version: 1, idempotencyKey: 'cancel-key', actor: quote.seller, listingId: quote.listingId, itemId: quote.itemId,
      sourceBaseId: null, priceLamports: quote.priceLamports, expectedStatus: 'reserved', expectedReference: quote.reference,
      createdAt: quote.createdAt, state: 'settled', resolvedAt: quote.payableUntil, refusalCode: null,
      settlement: { reference: quote.reference, txSignature: '2'.repeat(88), buyer: quote.buyer, buyerBaseId: null } };
    expect(MarketCancellationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(MarketCancellationReceiptSchema.safeParse({ ...receipt, settlement: { ...receipt.settlement, reference: quote.buyer } }).success).toBe(false);
    expect(MarketCancellationReceiptSchema.safeParse({ ...receipt, settlement: { ...receipt.settlement, buyerBaseId: quote.listingId } }).success).toBe(false);
  });
});
