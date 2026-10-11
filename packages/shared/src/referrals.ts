/** Recovery describes the one immutable wallet relationship, never a deed or payout.
 * Subpath-only so the initial web graph need not import this screen's validation. */
import { z } from 'zod';

const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const ReferralCodeSchema = z.string().trim().toUpperCase().min(6).max(16);
export const ReferralUseV1RequestSchema = z.object({ code: ReferralCodeSchema }).strict();
export const ReferralRelationshipSchema = z.object({
  id: z.uuid(), refereeWallet: Wallet, referrerWallet: Wallet, createdAt: z.iso.datetime(),
}).strict().refine((r) => r.refereeWallet !== r.referrerWallet, 'self referral');
export type ReferralRelationship = z.infer<typeof ReferralRelationshipSchema>;

/** null is an observation, not proof that an interrupted submission failed. */
export const ReferralStatusV1Schema = z.object({
  version: z.literal(1), wallet: Wallet, relationship: ReferralRelationshipSchema.nullable(),
}).strict().refine((r) => r.relationship === null || r.relationship.refereeWallet === r.wallet, 'wrong referee');
export type ReferralStatusV1 = z.infer<typeof ReferralStatusV1Schema>;
export const ReferralUseV1ResponseSchema = z.object({
  version: z.literal(1), wallet: Wallet, submittedCode: ReferralCodeSchema,
  outcome: z.enum(['applied', 'already_applied', 'already_bound']),
  relationship: ReferralRelationshipSchema,
}).strict().refine((r) => r.relationship.refereeWallet === r.wallet, 'wrong referee');
export type ReferralUseV1Response = z.infer<typeof ReferralUseV1ResponseSchema>;
