/** Exact claim-command outcomes; existing Forge allocation and payout rules are unchanged. */
import { z } from 'zod';
import { FORGE } from './constants';
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const isAmount = (v: string) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const Amount = z.string().refine(isAmount);
const Day = z.iso.date();
export const ForgeClaimKeySchema = z.object({ key: Uuid }).strict();
export const ForgeClaimRequestSchema = z.object({
  idempotencyKey: Uuid, baseId: Uuid.nullable(), day: Day.nullable(),
}).strict();
export type ForgeClaimRequest = z.infer<typeof ForgeClaimRequestSchema>;
export const ForgeClaimResultSchema = z.object({
  claimed: z.array(z.object({ day: Day, keep: Amount.refine(v => v !== '0'), ledgerTransactionId: Uuid }).strict()).max(FORGE.claimBatchMax),
  totalKeep: Amount, remaining: z.number().int().nonnegative().safe(),
}).strict().refine(r => isAmount(r.totalKeep) && r.claimed.every(row => isAmount(row.keep))
  && r.claimed.reduce((sum, row) => sum + BigInt(row.keep), 0n) === BigInt(r.totalKeep)
  && r.claimed.every((row, i) => i === 0 || row.day > r.claimed[i - 1]!.day)
  && new Set(r.claimed.map(row => row.ledgerTransactionId)).size === r.claimed.length, 'invalid Forge claim payout');
export type ForgeClaimResult = z.infer<typeof ForgeClaimResultSchema>;
export const ForgeClaimReceiptSchema = z.object({
  version: z.literal(1), actor: Wallet, idempotencyKey: Uuid, baseId: Uuid.nullable(), day: Day.nullable(),
  result: ForgeClaimResultSchema, createdAt: z.iso.datetime(),
}).strict().refine(r => r.day === null || r.result.claimed.every(row => row.day === r.day), 'claim selector mismatch');
export type ForgeClaimReceipt = z.infer<typeof ForgeClaimReceiptSchema>;
export const ForgeClaimStatusSchema = z.object({
  version: z.literal(1), wallet: Wallet, idempotencyKey: Uuid, enabled: z.boolean(), receipt: ForgeClaimReceiptSchema.nullable(),
}).strict().refine(r => !r.receipt || (r.receipt.actor === r.wallet && r.receipt.idempotencyKey === r.idempotencyKey), 'claim identity mismatch');
