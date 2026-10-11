import {
  TRAINING_SCHEDULE, TROOPS, TROOP_TYPES,
  type TrainingComposition, type TrainingFinishAllConsent, type TrainingQueueConsentRow,
  type TrainingScheduleConsent,
} from '@shardkeep/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx, DbTx } from '../db/client';
import { baseTrainingQueue, trainingQueue } from '../db/schema';
import { HttpError } from '../lib/errors';

const queueSchema = z.array(z.object({
  id: z.uuid(), startedAt: z.iso.datetime(), finishesAt: z.iso.datetime(),
}).strict()).max(TRAINING_SCHEDULE.maxConsentQueueRows)
  .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length);
export const TrainingScheduleConsentSchema = z.object({
  version: z.literal(TRAINING_SCHEDULE.version), queue: queueSchema,
  unitDurations: z.array(z.object({ troop: z.enum(TROOP_TYPES), durationMs: z.number().int().positive() }).strict())
    .max(TROOP_TYPES.length),
}).strict();
export const TrainingFinishAllConsentSchema = z.object({
  version: z.literal(TRAINING_SCHEDULE.version), queue: queueSchema,
  maxCostKeep: z.string().max(32).regex(/^(0|[1-9][0-9]*)$/),
}).strict();

export type TrainingScheduleRow = typeof baseTrainingQueue.$inferSelect;
type QueueRow = Pick<TrainingScheduleRow, 'id' | 'startedAt' | 'finishesAt'>;

export const queueConsent = (rows: QueueRow[]): TrainingQueueConsentRow[] => rows.map((r) => ({
  id: r.id, startedAt: r.startedAt.toISOString(), finishesAt: r.finishesAt.toISOString(),
}));
export const unitDurations = (composition: TrainingComposition): TrainingScheduleConsent['unitDurations'] =>
  composition.map(({ troop }) => ({ troop, durationMs: Math.round(TROOPS[troop].trainSec * 1000) }));

/** Stable and legacy reads have identical scheduling fields. Caller owns the lane lock. */
export async function trainingRows(db: DbOrTx, wallet: string, baseId?: string) {
  return baseId
    ? db.select().from(baseTrainingQueue).where(and(eq(baseTrainingQueue.baseId, baseId), isNull(baseTrainingQueue.completedAt)))
      .orderBy(baseTrainingQueue.finishesAt, baseTrainingQueue.startedAt, baseTrainingQueue.id)
    : db.select().from(trainingQueue).where(and(eq(trainingQueue.playerWallet, wallet), isNull(trainingQueue.completedAt)))
      .orderBy(trainingQueue.finishesAt, trainingQueue.startedAt, trainingQueue.id);
}

export const laneTail = (rows: QueueRow[], now: Date): number =>
  rows.reduce((end, row) => Math.max(end, row.finishesAt.getTime()), now.getTime());

/** Plain snapshots are checked against owned database rows, never trusted as authority.
 * Only natural completion may remove a quoted row without a fresh confirmation. */
export async function queueConsentMatches(
  tx: DbOrTx, wallet: string, baseId: string | undefined,
  expected: TrainingQueueConsentRow[], active: QueueRow[], now: Date,
): Promise<boolean> {
  const byId = new Map(expected.map((r) => [r.id, r]));
  if (byId.size !== expected.length) return false;
  const matches = (r: QueueRow): boolean => {
    const q = byId.get(r.id);
    return !!q && q.startedAt === r.startedAt.toISOString() && q.finishesAt === r.finishesAt.toISOString();
  };
  if (!active.every(matches)) return false;
  const activeIds = new Set(active.map((r) => r.id));
  const missing = expected.filter((r) => !activeIds.has(r.id)).map((r) => r.id);
  if (!missing.length) return true;
  const prior = baseId
    ? await tx.select().from(baseTrainingQueue).where(and(eq(baseTrainingQueue.baseId, baseId), inArray(baseTrainingQueue.id, missing)))
    : await tx.select().from(trainingQueue).where(and(eq(trainingQueue.playerWallet, wallet), inArray(trainingQueue.id, missing)));
  return prior.length === missing.length && prior.every((r) => matches(r) && r.completedAt !== null
    && r.cancelledAt === null && r.completedAt.getTime() >= r.finishesAt.getTime()
    && r.finishesAt.getTime() <= now.getTime());
}

export function requireScheduleConsent(raw: TrainingScheduleConsent | undefined): TrainingScheduleConsent {
  if (raw === undefined) throw new HttpError(409, 'refresh training to review the sequential schedule', 'TRAINING_CONSENT_REQUIRED');
  const parsed = TrainingScheduleConsentSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, 'invalid training schedule consent', 'TRAINING_CONSENT_INVALID');
  return parsed.data;
}
export function requireFinishConsent(raw: TrainingFinishAllConsent | undefined): TrainingFinishAllConsent {
  if (raw === undefined) throw new HttpError(409, 'refresh training to confirm the current queue and KEEP price', 'TRAINING_CONSENT_REQUIRED');
  const parsed = TrainingFinishAllConsentSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, 'invalid training finish consent', 'TRAINING_CONSENT_INVALID');
  return parsed.data;
}

/** Refund and repack share the transaction. Grandfathered rows and elapsed
 * progress remain untouched; only not-yet-started V2 rows move forward. */
export async function repackTrainingLane(tx: DbTx, wallet: string, now: Date, baseId?: string): Promise<void> {
  const rows = await trainingRows(tx, wallet, baseId);
  let cursor = laneTail(rows.filter((r) => r.scheduleVersion === 1), now);
  for (const row of rows.filter((r) => r.scheduleVersion === TRAINING_SCHEDULE.version)) {
    if (row.startedAt.getTime() <= now.getTime()) {
      cursor = Math.max(cursor, row.finishesAt.getTime());
      continue;
    }
    const duration = row.finishesAt.getTime() - row.startedAt.getTime();
    const startedAt = new Date(cursor), finishesAt = new Date(cursor + duration);
    if (startedAt.getTime() < row.startedAt.getTime()) {
      if (baseId) await tx.update(baseTrainingQueue).set({ startedAt, finishesAt })
        .where(and(eq(baseTrainingQueue.id, row.id), isNull(baseTrainingQueue.completedAt)));
      else await tx.update(trainingQueue).set({ startedAt, finishesAt })
        .where(and(eq(trainingQueue.id, row.id), isNull(trainingQueue.completedAt)));
    }
    cursor = Math.min(row.finishesAt.getTime(), finishesAt.getTime());
  }
}
