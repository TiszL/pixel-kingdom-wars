/** Paid Finish All proof comes from the original atomic posting, never a current queue. */
import { TrainingFinishIntentSchema, TrainingFinishLookupSchema, TrainingFinishProofSchema, TrainingFinishResultSchema,
  sameTrainingFinishIntent, type TrainingFinishIntent } from '@shardkeep/shared/trainingFinish';
import type { TrainingFinishAllConsent } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { clientCurrencyContext } from './clientCurrency';
import { spendCurrencyOf } from './heroReceipt';
export const TrainingFinishReceiptQuerySchema = TrainingFinishLookupSchema.extend({
  baseId: TrainingFinishLookupSchema.shape.baseId.optional().transform(v => v ?? null),
});
const Metadata = z.object({ wallet: z.string(), baseId: z.uuid().optional(), rows: z.number().int().positive(), remSec: z.number().int().positive(),
  recycled: z.literal(true).optional(), currency: z.enum(['KEEP', 'GEMS']).optional(),
  trainingFinish: z.object({ version: z.literal(1), request: TrainingFinishIntentSchema, result: TrainingFinishResultSchema }).strict(),
}).strict();
export function trainingFinishLedgerKey(wallet: string, key: string, baseId?: string | null): string { return `tspeedup:${baseId?.toLowerCase() ?? wallet}:${key}`; }
export function trainingFinishIntent(key: string, baseId: string | undefined, consent?: TrainingFinishAllConsent, freeOffer?: string): TrainingFinishIntent | undefined {
  const expectedCurrency = clientCurrencyContext().expectedCurrency;
  if (freeOffer !== undefined || !expectedCurrency || !consent) return undefined;
  return parse(TrainingFinishIntentSchema, { baseId: baseId?.toLowerCase() ?? null, idempotencyKey: key, expectedCurrency, consent });
}
/** An exact request may not acquire a different base identity during admission. */
export function assertTrainingFinishScope(request: TrainingFinishIntent | undefined, stable: boolean): void {
  if (request && (request.baseId !== null) !== stable)
    throw new HttpError(409, 'training base mode changed; review FINISH ALL again', 'TRAINING_FINISH_SCOPE_CHANGED');
}
export function trainingFinishResult(rows: Array<{ id: string; troop: string; startedAt: Date; finishesAt: Date }>, at: Date) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.troop, (counts.get(row.troop) ?? 0) + 1);
  return TrainingFinishResultSchema.parse({ completedAt: at.toISOString(),
    paidRows: rows.map(r => ({ id: r.id, troop: r.troop, startedAt: r.startedAt.toISOString(), finishesAt: r.finishesAt.toISOString() })),
    completed: [...counts].map(([troop, count]) => ({ troop, count })) });
}
export async function getTrainingFinishReceipt(db: DbOrTx, wallet: string, input: z.infer<typeof TrainingFinishLookupSchema>) {
  const lookup = TrainingFinishLookupSchema.parse(input); const unknown = { version: 1, status: 'unknown', idempotencyKey: lookup.idempotencyKey } as const;
  const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, trainingFinishLedgerKey(wallet, lookup.idempotencyKey, lookup.baseId)));
  if (!txn || txn.type !== 'train.speedup') return unknown;
  const parsed = Metadata.safeParse(txn.metadata); if (!parsed.success) return unknown;
  const m = parsed.data; const { request, result } = m.trainingFinish;
  if (m.wallet !== wallet || request.idempotencyKey !== lookup.idempotencyKey || request.baseId !== lookup.baseId
    || (m.baseId ?? null) !== lookup.baseId || m.rows !== result.paidRows.length) return unknown;
  const entries = await db.select({ delta: ledgerEntries.delta, account: accounts }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  const debit = entries.find(e => e.delta < 0n); const credit = entries.find(e => e.delta > 0n);
  if (entries.length !== 2 || !debit || !credit || debit.delta + credit.delta !== 0n
    || spendCurrencyOf(debit.account, credit.account, m) !== request.expectedCurrency
    || debit.account.ownerWallet !== wallet || debit.account.baseId !== null || credit.account.ownerWallet !== null || credit.account.baseId !== null
    || -debit.delta > BigInt(request.consent.maxCostKeep)) return unknown;
  const proof = TrainingFinishProofSchema.safeParse({ version: 1, status: 'accepted', wallet, request, result,
    receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(), funding: { currency: request.expectedCurrency, amount: (-debit.delta).toString() } });
  return proof.success ? proof.data : unknown;
}
export async function replayTrainingFinish(db: DbOrTx, wallet: string, request: TrainingFinishIntent | undefined) {
  if (!request) return null;
  const [txn] = await db.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
    trainingFinishLedgerKey(wallet, request.idempotencyKey, request.baseId)));
  if (!txn) return null;
  const proof = await getTrainingFinishReceipt(db, wallet, { baseId: request.baseId, idempotencyKey: request.idempotencyKey });
  if (proof.status !== 'accepted' || !sameTrainingFinishIntent(proof.request, request))
    throw new HttpError(409, 'training finish key does not match its original acceptance', 'TRAINING_FINISH_RECEIPT_INVALID');
  return { cost: 0n, completed: proof.result.completed };
}
