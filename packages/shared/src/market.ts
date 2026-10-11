/** Versioned public market contracts. Subpath-only: the initial web graph need not
 * load money-screen validation. All tuning stays in constants.ts:MARKETPLACE. */
import { z } from 'zod';

const Key = z.string().min(8).max(128);
const Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Amount = z.string().refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const ZeroAmount = z.string().refine((v) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n);
const Item = z.string().min(1).max(64);
const DateTime = z.iso.datetime();
const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
export const ITEM_MARKET_FEATURE = { version: 1, listingReceipts: 1, reservationReceipts: 1, cancelReceipts: 1 } as const;
export const MarketKeySchema = z.object({ key: Key }).strict();
export const MarketListRequestSchema = z.object({ itemId: Item, priceLamports: Amount, idempotencyKey: Key, baseId: z.uuid().nullable() }).strict();
export const MarketReserveRequestSchema = z.object({
  idempotencyKey: Key, itemId: Item, sourceBaseId: z.uuid().nullable(), seller: Address,
  priceLamports: Amount, buyerBaseId: z.uuid().nullable(),
}).strict().refine((v) => (v.sourceBaseId === null) === (v.buyerBaseId === null), 'custody mismatch');
export type MarketReserveRequest = z.infer<typeof MarketReserveRequestSchema>;
export const MarketCancelRequestSchema = z.object({
  idempotencyKey: Key, itemId: Item, sourceBaseId: z.uuid().nullable(), priceLamports: Amount,
  status: z.enum(['active', 'reserved']), reference: Address.nullable(),
}).strict().refine((v) => (v.status === 'active') === (v.reference === null), 'generation mismatch');
export type MarketCancelRequest = z.infer<typeof MarketCancelRequestSchema>;
export const MarketPaidRequestSchema = z.object({ reference: Address, signature: Signature }).strict();
export const MarketSettleRequestSchema = z.object({ reference: Address, signature: Signature.optional() }).strict();

export const MarketListingReceiptSchema = z.object({
  version: z.literal(1), idempotencyKey: Key, creator: Address, listingId: z.uuid(), itemId: Item,
  sourceBaseId: z.uuid().nullable(), priceLamports: Amount, createdAt: DateTime,
}).strict();
export const MarketQuoteSchema = z.object({
  version: z.literal(1), idempotencyKey: Key.nullable(), reservationId: z.uuid(), listingId: z.uuid(),
  itemId: Item, buyer: Address, seller: Address, sourceBaseId: z.uuid().nullable(), buyerBaseId: z.uuid().nullable(),
  cluster: z.enum(['devnet', 'mainnet-beta']), reference: Address, priceLamports: Amount,
  feeBps: z.number().int().min(0).max(10000), sellerLamports: Amount, feeLamports: ZeroAmount,
  feeTreasury: Address, createdAt: DateTime, payableUntil: DateTime,
}).strict().refine((q) => /^[0-9]+$/.test(q.priceLamports) && /^[0-9]+$/.test(q.sellerLamports) && /^[0-9]+$/.test(q.feeLamports)
  && Number.isSafeInteger(q.feeBps) && BigInt(q.priceLamports) === BigInt(q.sellerLamports) + BigInt(q.feeLamports)
  && BigInt(q.feeLamports) === BigInt(q.priceLamports) * BigInt(q.feeBps) / 10000n
  && q.buyer !== q.seller && q.buyer !== q.feeTreasury && q.seller !== q.feeTreasury
  && (q.sourceBaseId === null) === (q.buyerBaseId === null)
  && Date.parse(q.payableUntil) > Date.parse(q.createdAt), 'invalid frozen quote');
export const MarketReservationReceiptSchema = z.object({
  quote: MarketQuoteSchema, serverNow: DateTime, payable: z.boolean(),
  state: z.enum(['reserved', 'committed', 'settled', 'superseded', 'cancelled']),
  paymentSignature: Signature.nullable(), txSignature: Signature.nullable(), resolvedAt: DateTime.nullable(),
}).strict().refine((r) => {
  if (r.payable && (r.state !== 'reserved' || Date.parse(r.serverNow) >= Date.parse(r.quote.payableUntil))) return false;
  if (r.state === 'reserved') return r.paymentSignature === null && r.txSignature === null && r.resolvedAt === null;
  if (r.state === 'committed') return r.paymentSignature !== null && r.txSignature === null && r.resolvedAt === null && !r.payable;
  if (r.state === 'settled') return r.txSignature !== null && r.resolvedAt !== null && !r.payable && (r.paymentSignature === null || r.paymentSignature === r.txSignature);
  return r.txSignature === null && r.resolvedAt !== null && !r.payable;
}, 'invalid reservation lifecycle');
export const MarketCancellationReceiptSchema = z.object({
  version: z.literal(1), idempotencyKey: Key, actor: Address, listingId: z.uuid(), itemId: Item,
  sourceBaseId: z.uuid().nullable(), priceLamports: Amount, expectedStatus: z.enum(['active', 'reserved']),
  expectedReference: Address.nullable(), createdAt: DateTime, state: z.enum(['pending', 'cancelled', 'settled', 'refused']),
  resolvedAt: DateTime.nullable(), refusalCode: z.string().min(1).max(64).nullable(),
  settlement: z.object({ reference: Address, txSignature: Signature, buyer: Address, buyerBaseId: z.uuid().nullable() }).strict().nullable(),
}).strict().refine((r) => (r.expectedStatus === 'active') === (r.expectedReference === null)
  && (r.state === 'pending' ? r.resolvedAt === null && r.refusalCode === null && r.settlement === null
    : r.resolvedAt !== null && (r.state === 'settled' ? r.settlement !== null && r.refusalCode === null && r.expectedReference === r.settlement.reference && (r.sourceBaseId === null) === (r.settlement.buyerBaseId === null)
      : r.settlement === null && (r.state === 'refused' ? r.refusalCode !== null : r.refusalCode === null))), 'invalid cancellation lifecycle');
