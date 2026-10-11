/** Phase E purchase wire contract. Subpath-only: no first-paint barrel export. */
import { z } from 'zod';
const Id = z.uuid(), Key = z.string().min(8).max(128);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Count = z.number().int().nonnegative().safe();
const Amount = z.string().refine(v => v.length <= 19 && /^[1-9]\d*$/.test(v)
  && BigInt(v) <= 9_223_372_036_854_775_807n, 'expected a positive canonical int64');
export const FreeBasePurchaseRequestSchema = z.object({ sourceBaseId: Id, idempotencyKey: Key }).strict();
export const FreeBasePurchaseReceiptSchema = z.object({
  version: z.literal(1), wallet: Wallet, idempotencyKey: Key, sourceBaseId: Id, baseId: Id,
  slot: Count.positive(), shardsCharged: Amount, debitTransactionId: Id,
  development: z.object({ keepId: Id, keepLevel: Count.positive(), workshopId: Id,
    workshopLevel: Count.positive(), goldForgeId: Id, goldForgeLevel: Count.positive() }).strict(),
  acceptedAt: z.iso.datetime(),
}).strict().refine(r => r.baseId !== r.sourceBaseId, 'purchase must create a different base');
export const FreeBasePurchaseReceiptEnvelopeSchema = z.object({ receipt: FreeBasePurchaseReceiptSchema.nullable() }).strict();
export const FreeBasePurchaseTermsSchema = z.object({
  policyVersion: z.literal(1), costShards: Amount, minKeepLevel: Count.positive(),
  minWorkshopLevel: Count.positive(), minGoldForgeLevel: Count.positive(),
  maxFreeBases: Count.positive(), maxActiveBases: Count.positive(),
}).strict();
export const FreeBasePurchaseAdmissionReasonSchema = z.enum(['ready', 'disabled', 'stable-bases-required',
  'already-purchased', 'source-required', 'source-unavailable', 'source-not-free', 'source-reserved',
  'full-roster', 'development-required', 'insufficient-shards', 'being-raided']);
export const FreeBasePurchaseViewSchema = z.object({
  version: z.literal(1), wallet: Wallet, enabled: z.boolean(), sourceBaseId: Id.nullable(),
  terms: FreeBasePurchaseTermsSchema,
  admission: z.object({ allowed: z.boolean(), reason: FreeBasePurchaseAdmissionReasonSchema }).strict(),
  receipt: FreeBasePurchaseReceiptSchema.nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.admission.allowed !== (v.admission.reason === 'ready')
    || v.admission.allowed && (!v.enabled || v.sourceBaseId === null || v.receipt !== null)
    || v.receipt !== null && v.receipt.wallet !== v.wallet) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent purchase availability' });
  }
});
export type FreeBasePurchaseRequest = z.infer<typeof FreeBasePurchaseRequestSchema>;
export type FreeBasePurchaseReceipt = z.infer<typeof FreeBasePurchaseReceiptSchema>;
export type FreeBasePurchaseTerms = z.infer<typeof FreeBasePurchaseTermsSchema>;
export type FreeBasePurchaseView = z.infer<typeof FreeBasePurchaseViewSchema>;
export type FreeBasePurchaseAdmissionReason = z.infer<typeof FreeBasePurchaseAdmissionReasonSchema>;
