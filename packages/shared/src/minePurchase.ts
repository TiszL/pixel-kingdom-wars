/** Additional Mine consent. The first Mine's SHARDS placement stays separate. */
import { z } from 'zod';
import { PLOT_GEOMETRY } from './constants';
import { plotBounds } from './plotGeometry';
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/), Key = z.string().min(8).max(128);
const Amount = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const plot = plotBounds(PLOT_GEOMETRY.currentVersion), Tile = z.number().int().min(plot.min).max(plot.max - 1);
export const MinePurchaseConsentSchema = z.object({ version: z.literal(1), mineIndex: z.number().int().positive().safe(), maxCostKeep: Amount }).strict();
export const MinePurchaseIntentSchema = z.object({ type: z.literal('mine'), tx: Tile, ty: Tile, baseId: Uuid.nullable(), idempotencyKey: Key,
  expectedCurrency: z.enum(['KEEP', 'GEMS']), mineConsent: MinePurchaseConsentSchema }).strict();
export type MinePurchaseIntent = z.infer<typeof MinePurchaseIntentSchema>;
export const MinePurchaseProofSchema = z.object({ version: z.literal(1), wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  request: MinePurchaseIntentSchema, receiptId: Uuid, acceptedAt: z.iso.datetime(),
  funding: z.object({ currency: z.enum(['KEEP', 'GEMS']), amount: Amount }).strict(),
}).strict().refine(v => /^[1-9][0-9]{0,18}$/.test(v.funding.amount) && /^[1-9][0-9]{0,18}$/.test(v.request.mineConsent.maxCostKeep)
  && v.funding.currency === v.request.expectedCurrency && BigInt(v.funding.amount) <= BigInt(v.request.mineConsent.maxCostKeep));
export function sameMinePurchase(a: MinePurchaseIntent, b: MinePurchaseIntent): boolean {
  return JSON.stringify(MinePurchaseIntentSchema.parse(a)) === JSON.stringify(MinePurchaseIntentSchema.parse(b));
}
export function minePurchaseBody(raw: MinePurchaseIntent) {
  const { baseId, expectedCurrency: _currency, ...body } = MinePurchaseIntentSchema.parse(raw);
  return { ...body, ...(baseId === null ? {} : { baseId }) };
}
export function minePurchaseReceiptPath(raw: MinePurchaseIntent): string {
  const { type, tx, ty, baseId, idempotencyKey } = MinePurchaseIntentSchema.parse(raw);
  return `/base/buildings/receipt?${new URLSearchParams({ type, tx: String(tx), ty: String(ty), idempotencyKey, ...(baseId === null ? {} : { baseId }) })}`;
}
export function matchMinePurchaseProof(raw: unknown, wallet: string, request: MinePurchaseIntent) {
  const proof = MinePurchaseProofSchema.parse(raw);
  if (proof.wallet !== wallet || !sameMinePurchase(proof.request, request)) throw new Error('Mine receipt differs from original purchase.');
  return proof;
}
