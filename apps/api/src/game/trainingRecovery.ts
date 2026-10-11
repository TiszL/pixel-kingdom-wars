/** A receipt records a purchase, not today's army. Unknown keys remain live until
 * their owner explicitly closes them under the same lock used by trainBatch. */
import { TROOP_TYPES } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { armyTrainingBatches, armyTrainingBatchClosures, players } from '../db/schema';
import { HttpError } from '../lib/errors';

const Key = z.string().min(8).max(128);
export const TrainingReceiptQuerySchema = z.object({ idempotencyKey: Key }).strict();
export const TrainingCloseBodySchema = z.object({ idempotencyKey: Key, confirmed: z.literal(true) }).strict();
const Decimal = z.string().max(32).regex(/^(0|[1-9][0-9]*)$/);
const identity = { version: z.literal(1), idempotencyKey: Key };
export const TrainingRecoverySchema = z.discriminatedUnion('status', [
  z.object({ ...identity, status: z.literal('unknown') }),
  z.object({ ...identity, status: z.literal('closed'), closedAt: z.iso.datetime() }),
  z.object({
    ...identity, status: z.literal('accepted'), baseId: z.uuid().nullable(), acceptedAt: z.iso.datetime(),
    request: z.object({
      composition: z.array(z.object({ troop: z.enum(TROOP_TYPES), count: z.number().int().positive() })),
      confirmedCostShards: Decimal,
    }),
    result: z.object({
      queue: z.array(z.object({ id: z.uuid(), troop: z.enum(TROOP_TYPES), finishesAt: z.iso.datetime() })),
      costShards: Decimal, replayed: z.literal(true),
    }),
  }),
]);
export type TrainingRecovery = z.infer<typeof TrainingRecoverySchema>;

export async function getTrainingReceipt(db: DbOrTx, wallet: string, idempotencyKey: string): Promise<TrainingRecovery> {
  const [receipt] = await db.select().from(armyTrainingBatches).where(and(
    eq(armyTrainingBatches.playerWallet, wallet), eq(armyTrainingBatches.idempotencyKey, idempotencyKey),
  ));
  if (receipt) {
    const parsed = TrainingRecoverySchema.safeParse({
      version: 1, status: 'accepted', idempotencyKey, baseId: receipt.baseId,
      request: receipt.request, result: { ...(receipt.result as object), replayed: true },
      acceptedAt: receipt.createdAt.toISOString(),
    });
    if (!parsed.success) throw new HttpError(409, 'the original training receipt could not be verified', 'TRAINING_RECEIPT_INVALID');
    return parsed.data;
  }
  const [closed] = await db.select().from(armyTrainingBatchClosures).where(and(
    eq(armyTrainingBatchClosures.playerWallet, wallet), eq(armyTrainingBatchClosures.idempotencyKey, idempotencyKey),
  ));
  return closed
    ? { version: 1, status: 'closed', idempotencyKey, closedAt: closed.createdAt.toISOString() }
    : { version: 1, status: 'unknown', idempotencyKey };
}

/** No deed/queue/quote checks: even a landless seller may close their own key.
 * Acceptance and closure both hold players FOR UPDATE until commit. If an
 * acceptance won, return its immutable receipt; never turn it into cancellation. */
export async function closeTrainingBatch(db: Db, wallet: string, idempotencyKey: string): Promise<TrainingRecovery> {
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const prior = await getTrainingReceipt(tx, wallet, idempotencyKey);
    if (prior.status !== 'unknown') return prior;
    const [closed] = await tx.insert(armyTrainingBatchClosures).values({ playerWallet: wallet, idempotencyKey }).returning();
    return { version: 1, status: 'closed', idempotencyKey, closedAt: closed!.createdAt.toISOString() };
  });
}

/** Call only after taking the training wallet lock, before any batch debit. */
export async function assertTrainingBatchOpen(tx: DbOrTx, wallet: string, idempotencyKey: string): Promise<void> {
  const [closed] = await tx.select({ key: armyTrainingBatchClosures.idempotencyKey }).from(armyTrainingBatchClosures).where(and(
    eq(armyTrainingBatchClosures.playerWallet, wallet), eq(armyTrainingBatchClosures.idempotencyKey, idempotencyKey),
  ));
  if (closed) throw new HttpError(409, 'this training request was permanently closed; review a new quote', 'TRAINING_BATCH_CLOSED');
}
