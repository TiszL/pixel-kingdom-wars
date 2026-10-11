/** Shop purchase consent and original ledger proof. Lazy subpath only. */
import { z } from 'zod';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Key = z.string().min(8).max(128);
// Historical evidence must survive a removed catalogue entry.
const ItemId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Currency = z.enum(['KEEP', 'GEMS']);
const Amount = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(v => BigInt(v) <= 9_223_372_036_854_775_807n);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export const ItemPurchaseConsentSchema = z.object({ version: z.literal(1),
  catalogRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  quantity: z.literal(1), maxCostKeep: Amount,
}).strict();
export type ItemPurchaseConsent = z.infer<typeof ItemPurchaseConsentSchema>;
export const ItemPurchaseIntentSchema = z.object({ itemId: ItemId, baseId: Uuid.nullable(),
  idempotencyKey: Key, expectedCurrency: Currency, consent: ItemPurchaseConsentSchema,
}).strict();
export type ItemPurchaseIntent = z.infer<typeof ItemPurchaseIntentSchema>;
export const ItemPurchaseLookupSchema = ItemPurchaseIntentSchema.pick({ itemId: true, baseId: true, idempotencyKey: true });
export const ItemPurchaseProofSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key }).strict(),
  z.object({ version: z.literal(1), status: z.literal('accepted'),
    wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), request: ItemPurchaseIntentSchema,
    receiptId: Uuid, acceptedAt: Timestamp,
    funding: z.object({ currency: Currency, amount: Amount }).strict(),
    result: z.object({ itemId: ItemId, quantity: z.literal(1) }).strict(),
  }).strict().refine(v => v.funding.currency === v.request.expectedCurrency
    && BigInt(v.funding.amount) <= BigInt(v.request.consent.maxCostKeep)
    && v.result.itemId === v.request.itemId, 'proof must match the original purchase'),
]);
export type ItemPurchaseProof = z.infer<typeof ItemPurchaseProofSchema>;
export function sameItemPurchaseIntent(a: ItemPurchaseIntent, b: ItemPurchaseIntent): boolean {
  return JSON.stringify(ItemPurchaseIntentSchema.parse(a)) === JSON.stringify(ItemPurchaseIntentSchema.parse(b));
}
export function itemPurchaseBody(raw: ItemPurchaseIntent) {
  const { itemId, baseId, idempotencyKey, consent } = ItemPurchaseIntentSchema.parse(raw);
  return { itemId, ...(baseId === null ? {} : { baseId }), idempotencyKey, consent };
}
export function itemPurchaseReceiptPath(raw: z.infer<typeof ItemPurchaseLookupSchema>): string {
  const { itemId, baseId, idempotencyKey } = ItemPurchaseLookupSchema.parse(raw);
  return `/items/buy/receipt?${new URLSearchParams({ itemId, idempotencyKey, ...(baseId === null ? {} : { baseId }) })}`;
}
export function matchItemPurchaseProof(raw: unknown, wallet: string, original: ItemPurchaseIntent): ItemPurchaseProof {
  const request = ItemPurchaseIntentSchema.parse(original), proof = ItemPurchaseProofSchema.parse(raw);
  if (proof.status === 'unknown' && proof.idempotencyKey !== request.idempotencyKey) throw new Error('Item receipt key differs.');
  if (proof.status === 'accepted' && (proof.wallet !== wallet || !sameItemPurchaseIntent(request, proof.request)))
    throw new Error('Item receipt differs from original purchase.');
  return proof;
}
