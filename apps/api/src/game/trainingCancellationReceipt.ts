import { TROOP_TYPES } from '@shardkeep/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { accounts, baseTrainingQueue, ledgerEntries, ledgerTransactions, trainingQueue } from '../db/schema';

const Key = z.string().min(8).max(128);
export const TrainingCancellationPathSchema = z.object({ queueId: z.uuid() });
// Same strip/optional behavior as the existing BaseKeyBody; old web callers
// continue sending their ordinary idempotency key and optional selected base.
export const TrainingCancellationBodySchema = z.object({ idempotencyKey: Key, baseId: z.uuid().optional() });
export const TrainingCancellationReceiptQuerySchema = TrainingCancellationBodySchema.strict();
export const TrainingCancellationResultSchema = z.object({
  id: z.uuid(), troop: z.enum(TROOP_TYPES), refundShards: z.string().max(32).regex(/^[1-9][0-9]*$/),
  cancelledAt: z.iso.datetime(), replayed: z.boolean(),
});
const identity = { version: z.literal(1), queueId: z.uuid(), idempotencyKey: Key, baseId: z.uuid().nullable() };
export const TrainingCancellationReceiptSchema = z.discriminatedUnion('status', [
  z.object({ ...identity, status: z.literal('unknown') }),
  z.object({ ...identity, status: z.literal('accepted'), result: TrainingCancellationResultSchema.extend({ replayed: z.literal(true) }) }),
]);
export type TrainingCancellationReceipt = z.infer<typeof TrainingCancellationReceiptSchema>;
export type TrainingCancellationReceiptQuery = z.infer<typeof TrainingCancellationReceiptQuerySchema>;

const RefundMetadata = z.object({ wallet: z.string(), baseId: z.uuid().optional(), queueId: z.uuid(), troop: z.enum(TROOP_TYPES), debitLedgerTxnId: z.uuid() });
const DebitMetadata = z.object({
  wallet: z.string().optional(), baseId: z.uuid().optional(), queueId: z.uuid(), troop: z.enum(TROOP_TYPES),
  costShards: z.number().refine(Number.isSafeInteger).positive(), economyVersion: z.literal(2),
});
const uuid = (value: string) => value.toLowerCase();

/** Historical cancellation proof, independent of current deed ownership. The
 * immutable refund actor owns this receipt, not necessarily the troop buyer.
 * Unknown never closes a key or proves a racing cancellation was rejected. */
export async function getTrainingCancellationReceipt(
  db: Db, wallet: string, queueIdInput: string, input: TrainingCancellationReceiptQuery,
): Promise<TrainingCancellationReceipt> {
  const queueId = uuid(TrainingCancellationPathSchema.parse({ queueId: queueIdInput }).queueId);
  const query = TrainingCancellationReceiptQuerySchema.parse(input);
  const baseId = query.baseId ? uuid(query.baseId) : null;
  const unknown = { version: 1, status: 'unknown', queueId, idempotencyKey: query.idempotencyKey, baseId } as const;
  return db.transaction(async (tx): Promise<TrainingCancellationReceipt> => {
    const [refund] = await tx.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `army-train-cancel:${queueId}`));
    const proof = refund?.type === 'army.train.cancel' ? RefundMetadata.safeParse(refund.metadata) : null;
    if (!proof?.success || proof.data.wallet !== wallet || uuid(proof.data.queueId) !== queueId
      || (proof.data.baseId ? uuid(proof.data.baseId) : null) !== baseId) return unknown;
    const row = baseId
      ? (await tx.select().from(baseTrainingQueue).where(and(eq(baseTrainingQueue.id, queueId), eq(baseTrainingQueue.baseId, baseId))))[0]
      : (await tx.select().from(trainingQueue).where(and(eq(trainingQueue.id, queueId), eq(trainingQueue.playerWallet, wallet))))[0];
    if (!row || row.economyVersion !== 2 || !row.cancelledAt || !row.completedAt
      || row.completedAt.getTime() !== row.cancelledAt.getTime() || row.cancelIdempotencyKey !== query.idempotencyKey
      || row.paidShardCost === null || row.paidShardCost <= 0n || !row.debitLedgerTxnId
      || row.refundLedgerTxnId !== refund!.id || uuid(proof.data.debitLedgerTxnId) !== row.debitLedgerTxnId
      || proof.data.troop !== row.troop) return unknown;
    const [debit] = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, row.debitLedgerTxnId));
    const paid = debit?.type === 'army.train' ? DebitMetadata.safeParse(debit.metadata) : null;
    if (!paid?.success || uuid(paid.data.queueId) !== queueId || paid.data.troop !== row.troop
      || BigInt(paid.data.costShards) !== row.paidShardCost
      || (baseId ? !paid.data.baseId || uuid(paid.data.baseId) !== baseId
        : paid.data.baseId !== undefined || paid.data.wallet !== wallet)) return unknown;
    const entries = await tx.select({ txnId: ledgerEntries.txnId, delta: ledgerEntries.delta, account: accounts })
      .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(inArray(ledgerEntries.txnId, [debit!.id, refund!.id]));
    const original = entries.filter((entry) => entry.txnId === debit!.id);
    const inverse = entries.filter((entry) => entry.txnId === refund!.id);
    if (original.length !== 2 || inverse.length !== 2) return unknown;
    const payer = original.find((entry) => entry.delta === -row.paidShardCost!);
    const burn = original.find((entry) => entry.delta === row.paidShardCost);
    if (!payer || !burn || payer.account.currency !== 'SHARDS' || burn.account.currency !== 'SHARDS'
      || burn.account.kind !== 'shard_burn' || burn.account.baseId !== null || burn.account.ownerWallet !== null
      || (baseId ? payer.account.kind !== 'base_shards' || payer.account.baseId !== baseId || payer.account.ownerWallet !== null
        : payer.account.kind !== 'player_shards' || payer.account.ownerWallet !== wallet || payer.account.baseId !== null)
      || !inverse.some((entry) => entry.account.id === payer.account.id && entry.delta === row.paidShardCost)
      || !inverse.some((entry) => entry.account.id === burn.account.id && entry.delta === -row.paidShardCost!)) return unknown;
    return TrainingCancellationReceiptSchema.parse({
      ...unknown, status: 'accepted', result: { id: row.id, troop: row.troop,
        refundShards: row.paidShardCost.toString(), cancelledAt: row.cancelledAt.toISOString(), replayed: true },
    });
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
