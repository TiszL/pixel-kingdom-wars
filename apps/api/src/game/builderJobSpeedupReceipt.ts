/** Paid builder proof never reads today's job, owner, target or deadline. */
import { BuilderJobSpeedupConsentSchema, BuilderJobSpeedupIntentSchema, BuilderJobSpeedupLookupSchema,
  BuilderJobSpeedupProofSchema, BuilderJobSpeedupResultSchema, sameBuilderJobSpeedupIntent,
  type BuilderJobSpeedupConsent, type BuilderJobSpeedupIntent } from '@shardkeep/shared/builderJobSpeedup';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { clientCurrencyContext } from './clientCurrency';
import { spendCurrencyOf } from './heroReceipt';
export const BUILDER_JOB_SPEEDUP_FEATURE = { version: 1, receipts: 1 } as const;
export const BuilderJobSpeedupReceiptQuerySchema = BuilderJobSpeedupLookupSchema.extend({
  baseId: BuilderJobSpeedupLookupSchema.shape.baseId.optional().transform(v => v ?? null),
});
const Metadata = z.object({ wallet: z.string(), baseId: z.uuid().optional(), jobId: z.uuid(), remSec: z.number().int().positive(),
  recycled: z.literal(true).optional(), currency: z.enum(['KEEP', 'GEMS']).optional(),
  builderJobSpeedup: z.object({ version: z.literal(1), request: BuilderJobSpeedupIntentSchema, result: BuilderJobSpeedupResultSchema }).strict(),
}).strict();
export function builderJobSpeedupLedgerKey(wallet: string, key: string) { return `speedup:${wallet}:${key}`; }
export function builderJobSpeedupIntent(jobId: string, key: string, baseId: string | undefined, consent?: BuilderJobSpeedupConsent): BuilderJobSpeedupIntent | undefined {
  if (!consent) return undefined;
  const expectedCurrency = clientCurrencyContext().expectedCurrency;
  if (!expectedCurrency) throw new HttpError(400, 'paid builder consent requires an exact currency header', 'INVALID_CURRENCY_CONSENT');
  return parse(BuilderJobSpeedupIntentSchema, { jobId, baseId: baseId?.toLowerCase() ?? null, idempotencyKey: key, expectedCurrency, consent });
}
export function assertBuilderJobSpeedupScope(request: BuilderJobSpeedupIntent | undefined, stable: boolean): void {
  if (request && (request.baseId !== null) !== stable) throw new HttpError(409, 'builder base mode changed; review again', 'BUILDER_SPEEDUP_SCOPE_CHANGED');
}
export function builderJobPaidQuote(job: { kind: string; buildingId: string | null; obstacleId: string | null; startedAt: Date; finishesAt: Date }, cost: bigint): BuilderJobSpeedupConsent | null {
  if (job.kind === 'build' || cost <= 0n) return null;
  return BuilderJobSpeedupConsentSchema.parse({ version: 1, kind: job.kind, buildingId: job.buildingId, obstacleId: job.obstacleId,
    startedAt: job.startedAt.toISOString(), finishesAt: job.finishesAt.toISOString(), maxCostKeep: cost.toString() });
}
export async function getBuilderJobSpeedupReceipt(db: DbOrTx, wallet: string, input: z.infer<typeof BuilderJobSpeedupLookupSchema>) {
  const lookup = BuilderJobSpeedupLookupSchema.parse(input); const unknown = { version: 1, status: 'unknown', idempotencyKey: lookup.idempotencyKey } as const;
  const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, builderJobSpeedupLedgerKey(wallet, lookup.idempotencyKey)));
  if (!txn || txn.type !== 'build.speedup') return unknown;
  const parsed = Metadata.safeParse(txn.metadata); if (!parsed.success) return unknown;
  const m = parsed.data; const { request, result } = m.builderJobSpeedup;
  if (m.wallet !== wallet || request.idempotencyKey !== lookup.idempotencyKey || request.baseId !== lookup.baseId
    || (m.baseId ?? null) !== lookup.baseId || m.jobId !== lookup.jobId || request.jobId !== lookup.jobId
    || m.remSec !== Math.ceil((Date.parse(request.consent.finishesAt) - Date.parse(result.completedAt)) / 1000)) return unknown;
  const entries = await db.select({ delta: ledgerEntries.delta, account: accounts }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  const debit = entries.find(e => e.delta < 0n); const credit = entries.find(e => e.delta > 0n);
  if (entries.length !== 2 || !debit || !credit || debit.delta + credit.delta !== 0n
    || spendCurrencyOf(debit.account, credit.account, m) !== request.expectedCurrency
    || debit.account.ownerWallet !== wallet || debit.account.baseId !== null || credit.account.ownerWallet !== null || credit.account.baseId !== null
    || -debit.delta > BigInt(request.consent.maxCostKeep)) return unknown;
  const proof = BuilderJobSpeedupProofSchema.safeParse({ version: 1, status: 'accepted', wallet, request, result,
    receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(), funding: { currency: request.expectedCurrency, amount: (-debit.delta).toString() } });
  return proof.success ? proof.data : unknown;
}
export async function replayBuilderJobSpeedup(db: DbOrTx, wallet: string, request: BuilderJobSpeedupIntent | undefined) {
  if (!request) return null;
  const [txn] = await db.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, builderJobSpeedupLedgerKey(wallet, request.idempotencyKey)));
  if (!txn) return null;
  const proof = await getBuilderJobSpeedupReceipt(db, wallet, { jobId: request.jobId, baseId: request.baseId, idempotencyKey: request.idempotencyKey });
  if (proof.status !== 'accepted' || !sameBuilderJobSpeedupIntent(proof.request, request)) throw new HttpError(409, 'builder speedup key differs from original acceptance', 'BUILDER_SPEEDUP_RECEIPT_INVALID');
  return { cost: 0n };
}
