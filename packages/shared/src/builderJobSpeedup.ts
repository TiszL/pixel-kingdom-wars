/** Paid builder-job FINISH consent and immutable proof. Lazy subpath only. */
import { z } from 'zod';
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Key = z.string().min(8).max(128);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Amount = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => BigInt(v) <= 9_223_372_036_854_775_807n);
const Kind = z.enum(['upgrade', 'repair', 'clear_obstacle']);
export const BuilderJobSpeedupConsentSchema = z.object({ version: z.literal(1), kind: Kind,
  buildingId: Uuid.nullable(), obstacleId: Uuid.nullable(), startedAt: Timestamp, finishesAt: Timestamp, maxCostKeep: Amount,
}).strict().refine(v => Date.parse(v.startedAt) < Date.parse(v.finishesAt)
  && (v.kind === 'clear_obstacle' ? v.obstacleId !== null && v.buildingId === null : v.buildingId !== null && v.obstacleId === null), 'invalid job episode or target');
export type BuilderJobSpeedupConsent = z.infer<typeof BuilderJobSpeedupConsentSchema>;
export const BuilderJobSpeedupIntentSchema = z.object({ jobId: Uuid, baseId: Uuid.nullable(), idempotencyKey: Key,
  expectedCurrency: z.enum(['KEEP', 'GEMS']), consent: BuilderJobSpeedupConsentSchema }).strict();
export type BuilderJobSpeedupIntent = z.infer<typeof BuilderJobSpeedupIntentSchema>;
export const BuilderJobSpeedupLookupSchema = BuilderJobSpeedupIntentSchema.pick({ jobId: true, baseId: true, idempotencyKey: true });
export const BuilderJobSpeedupResultSchema = z.object({ jobId: Uuid, kind: Kind, buildingId: Uuid.nullable(), obstacleId: Uuid.nullable(), completedAt: Timestamp }).strict();
export const BuilderJobSpeedupProofSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key }).strict(),
  z.object({ version: z.literal(1), status: z.literal('accepted'), wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    request: BuilderJobSpeedupIntentSchema, result: BuilderJobSpeedupResultSchema, receiptId: Uuid, acceptedAt: Timestamp,
    funding: z.object({ currency: z.enum(['KEEP', 'GEMS']), amount: Amount }).strict(),
  }).strict().refine(v => v.funding.currency === v.request.expectedCurrency && BigInt(v.funding.amount) <= BigInt(v.request.consent.maxCostKeep)
    && v.result.jobId === v.request.jobId && v.result.kind === v.request.consent.kind
    && v.result.buildingId === v.request.consent.buildingId && v.result.obstacleId === v.request.consent.obstacleId
    && Date.parse(v.result.completedAt) >= Date.parse(v.request.consent.startedAt)
    && Date.parse(v.result.completedAt) < Date.parse(v.request.consent.finishesAt), 'proof must complete the original still-running paid job'),
]);
export type BuilderJobSpeedupProof = z.infer<typeof BuilderJobSpeedupProofSchema>;
export function sameBuilderJobSpeedupIntent(a: BuilderJobSpeedupIntent, b: BuilderJobSpeedupIntent): boolean {
  return JSON.stringify(BuilderJobSpeedupIntentSchema.parse(a)) === JSON.stringify(BuilderJobSpeedupIntentSchema.parse(b));
}
export function builderJobSpeedupBody(raw: BuilderJobSpeedupIntent) {
  const { baseId, idempotencyKey, consent } = BuilderJobSpeedupIntentSchema.parse(raw);
  return { ...(baseId === null ? {} : { baseId }), idempotencyKey, consent };
}
export function builderJobSpeedupReceiptPath(raw: z.infer<typeof BuilderJobSpeedupLookupSchema>): string {
  const { jobId, baseId, idempotencyKey } = BuilderJobSpeedupLookupSchema.parse(raw);
  return `/base/jobs/speedup/receipt?${new URLSearchParams({ jobId, idempotencyKey, ...(baseId === null ? {} : { baseId }) })}`;
}
export function matchBuilderJobSpeedupProof(raw: unknown, wallet: string, original: BuilderJobSpeedupIntent): BuilderJobSpeedupProof {
  const request = BuilderJobSpeedupIntentSchema.parse(original); const proof = BuilderJobSpeedupProofSchema.parse(raw);
  if (proof.status === 'unknown' && proof.idempotencyKey !== request.idempotencyKey) throw new Error('Builder receipt key differs.');
  if (proof.status === 'accepted' && (proof.wallet !== wallet || !sameBuilderJobSpeedupIntent(request, proof.request))) throw new Error('Builder receipt differs from original command.');
  return proof;
}
