/** Exact transferred-deed consent and immutable acceptance; never a payment. */
import { z } from 'zod';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const PublicKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Slot = z.string().refine(v => /^(0|[1-9][0-9]{0,15})$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
export const BaseClaimKeySchema = z.object({ key: Uuid }).strict();
export const BaseClaimRequestSchema = z.object({ idempotencyKey: Uuid, baseId: Uuid, deedAssetId: PublicKey }).strict();
export type BaseClaimRequest = z.infer<typeof BaseClaimRequestSchema>;
export const BaseClaimReceiptSchema = z.object({
  version: z.literal(1), actor: PublicKey, idempotencyKey: Uuid, request: BaseClaimRequestSchema,
  outcome: z.enum(['claimed', 'already_owned']), active: z.boolean(),
  transferId: Uuid.nullable(), fromWallet: PublicKey.nullable(),
  ownership: z.object({ owner: PublicKey, collection: PublicKey, slot: Slot }).strict(),
  createdAt: z.iso.datetime(),
}).strict().refine(r => r.idempotencyKey === r.request.idempotencyKey && r.ownership.owner === r.actor
  && (r.outcome === 'claimed' ? r.transferId !== null && r.fromWallet !== null && r.fromWallet !== r.actor
    : r.transferId === null && r.fromWallet === null));
export type BaseClaimReceipt = z.infer<typeof BaseClaimReceiptSchema>;
export const BaseClaimStatusSchema = z.object({
  version: z.literal(1), wallet: PublicKey, idempotencyKey: Uuid, enabled: z.boolean(), receipt: BaseClaimReceiptSchema.nullable(),
}).strict().refine(s => !s.receipt || s.receipt.actor === s.wallet && s.receipt.idempotencyKey === s.idempotencyKey);
export type BaseClaimStatus = z.infer<typeof BaseClaimStatusSchema>;
export const BaseClaimCandidateSchema = z.object({
  version: z.literal(1), wallet: PublicKey, enabled: z.boolean(),
  candidate: z.object({ baseId: Uuid, deedAssetId: PublicKey }).strict().nullable(),
  reason: z.enum(['ok', 'none', 'not_transferable', 'unavailable']),
}).strict().refine(s => s.candidate !== null ? s.enabled && s.reason === 'ok' : s.reason !== 'ok');
export const BaseClaimCancellationSchema = z.object({
  version: z.literal(1), wallet: PublicKey, idempotencyKey: Uuid, cancelled: z.boolean(), receipt: BaseClaimReceiptSchema.nullable(),
}).strict().refine(s => s.cancelled ? s.receipt === null : s.receipt !== null
  && s.receipt.actor === s.wallet && s.receipt.idempotencyKey === s.idempotencyKey);
