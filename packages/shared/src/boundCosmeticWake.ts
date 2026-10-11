/** Account preference and prospective frozen trip appearance. Grammar alone proves neither
 * entitlement nor application readiness; a historical read never selects today's preference. */
import { z } from 'zod';
import { BoundCosmeticAppearanceSchema } from './boundCosmeticApi';

export const BoundCosmeticWakeVisualV1Schema = z.object({
  version: z.literal(1),
  wake: BoundCosmeticAppearanceSchema.refine(
    value => value.outputId === 'aurora_wake', 'An expedition Wake requires Aurora',
  ).nullable(),
}).strict();
export type BoundCosmeticWakeVisualV1 = z.infer<typeof BoundCosmeticWakeVisualV1Schema>;

export const BoundCosmeticWakeReadSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), visual: BoundCosmeticWakeVisualV1Schema }).strict(),
  z.object({ state: z.literal('unavailable'), visual: z.null() }).strict(),
]);
export type BoundCosmeticWakeRead = z.infer<typeof BoundCosmeticWakeReadSchema>;

/** Legacy absence, an observed off/default selection, and unavailable source remain distinct. */
export function matchBoundCosmeticWakeRead(raw: unknown): BoundCosmeticWakeRead | undefined {
  return raw === undefined ? undefined : BoundCosmeticWakeReadSchema.parse(raw);
}

// PostgreSQL signed bigint revision domain, not a gameplay quantity or client policy.
const maximumRevision = 9223372036854775807n;
function revision(min: bigint, max: bigint) {
  return z.string().refine(value => /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value).toString() === value && BigInt(value) >= min && BigInt(value) <= max, 'Invalid canonical preference revision');
}

/** Authentication supplies the account. No kingdom, caller wallet, price or currency is accepted. */
export const BoundCosmeticWakePreferenceRequestSchema = z.object({
  enabled: z.boolean(),
  expectedRevision: revision(0n, maximumRevision - 1n),
}).strict();
export type BoundCosmeticWakePreferenceRequest = z.infer<typeof BoundCosmeticWakePreferenceRequestSchema>;

export const BoundCosmeticWakePreferenceResponseSchema = z.object({
  enabled: z.boolean(),
  revision: revision(1n, maximumRevision),
  visual: BoundCosmeticWakeReadSchema,
}).strict();
export type BoundCosmeticWakePreferenceResponse = z.infer<typeof BoundCosmeticWakePreferenceResponseSchema>;
