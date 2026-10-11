/** Original paid Finish All consent and immutable ledger proof. Lazy subpath only. */
import { z } from 'zod';
import { TRAINING_SCHEDULE } from './constants';
import { TROOP_TYPES } from './types';
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Key = z.string().min(8).max(128);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Amount = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => BigInt(v) <= 9_223_372_036_854_775_807n);
const QueueRow = z.object({ id: Uuid, startedAt: Timestamp, finishesAt: Timestamp }).strict()
  .refine(v => Date.parse(v.startedAt) < Date.parse(v.finishesAt));
const Queue = z.array(QueueRow).min(1).max(TRAINING_SCHEDULE.maxConsentQueueRows)
  .refine(rows => new Set(rows.map(r => r.id)).size === rows.length);
export const TrainingFinishIntentSchema = z.object({
  baseId: Uuid.nullable(), idempotencyKey: Key, expectedCurrency: z.enum(['KEEP', 'GEMS']),
  consent: z.object({ version: z.literal(TRAINING_SCHEDULE.version), queue: Queue, maxCostKeep: Amount }).strict(),
}).strict();
export type TrainingFinishIntent = z.infer<typeof TrainingFinishIntentSchema>;
export const TrainingFinishLookupSchema = TrainingFinishIntentSchema.pick({ baseId: true, idempotencyKey: true });
export const TrainingFinishResultSchema = z.object({
  completedAt: Timestamp,
  paidRows: z.array(QueueRow.safeExtend({ troop: z.enum(TROOP_TYPES) })).min(1).max(TRAINING_SCHEDULE.maxConsentQueueRows),
  completed: z.array(z.object({ troop: z.enum(TROOP_TYPES), count: z.number().int().positive().max(TRAINING_SCHEDULE.maxConsentQueueRows) }).strict()).min(1).max(TROOP_TYPES.length),
}).strict().refine(result => {
  if (new Set(result.paidRows.map(r => r.id)).size !== result.paidRows.length
    || result.paidRows.some(r => Date.parse(r.finishesAt) <= Date.parse(result.completedAt))) return false;
  const counts = new Map<string, number>();
  for (const row of result.paidRows) counts.set(row.troop, (counts.get(row.troop) ?? 0) + 1);
  return JSON.stringify([...counts].map(([troop, count]) => ({ troop, count }))) === JSON.stringify(result.completed);
}, 'paid completion must match its unique still-running rows');
export type TrainingFinishResult = z.infer<typeof TrainingFinishResultSchema>;
export const TrainingFinishProofSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key }).strict(),
  z.object({ version: z.literal(1), status: z.literal('accepted'), wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    request: TrainingFinishIntentSchema, receiptId: Uuid, acceptedAt: Timestamp,
    funding: z.object({ currency: z.enum(['KEEP', 'GEMS']), amount: Amount }).strict(), result: TrainingFinishResultSchema,
  }).strict().refine(v => v.funding.currency === v.request.expectedCurrency
    && BigInt(v.funding.amount) <= BigInt(v.request.consent.maxCostKeep)
    && v.result.paidRows.length === v.request.consent.queue.filter(row => Date.parse(row.finishesAt) > Date.parse(v.result.completedAt)).length
    && v.result.paidRows.every(row => v.request.consent.queue.some(q => q.id === row.id && q.startedAt === row.startedAt && q.finishesAt === row.finishesAt)),
  'funding and paid rows must belong to the original consent'),
]);
export type TrainingFinishProof = z.infer<typeof TrainingFinishProofSchema>;
export function sameTrainingFinishIntent(a: TrainingFinishIntent, b: TrainingFinishIntent): boolean {
  return JSON.stringify(TrainingFinishIntentSchema.parse(a)) === JSON.stringify(TrainingFinishIntentSchema.parse(b));
}
export function trainingFinishBody(raw: TrainingFinishIntent) {
  const { baseId, idempotencyKey, consent } = TrainingFinishIntentSchema.parse(raw);
  return { ...(baseId === null ? {} : { baseId }), idempotencyKey, consent };
}
export function trainingFinishReceiptPath(raw: z.infer<typeof TrainingFinishLookupSchema>): string {
  const { baseId, idempotencyKey } = TrainingFinishLookupSchema.parse(raw);
  return `/army/train/speedup/receipt?${new URLSearchParams({ idempotencyKey, ...(baseId === null ? {} : { baseId }) })}`;
}
export function matchTrainingFinishProof(raw: unknown, wallet: string, original: TrainingFinishIntent): TrainingFinishProof {
  const request = TrainingFinishIntentSchema.parse(original); const proof = TrainingFinishProofSchema.parse(raw);
  if (proof.status === 'unknown' && proof.idempotencyKey !== request.idempotencyKey) throw new Error('Finish receipt key differs.');
  if (proof.status === 'accepted' && (proof.wallet !== wallet || !sameTrainingFinishIntent(proof.request, request))) throw new Error('Finish receipt differs from the original command.');
  return proof;
}
