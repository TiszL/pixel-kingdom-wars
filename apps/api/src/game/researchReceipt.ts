/** Research FINISH proof is append-only acceptance, never today's mutable row. */
import { ResearchSpeedupIntentSchema, ResearchSpeedupProofSchema, sameResearchSpeedupIntent, type ResearchSpeedupIntent } from '@shardkeep/shared/researchSpeedup';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { clientCurrencyContext } from './clientCurrency';
import type { ResearchFinishConsent } from './researchConsent';
import { spendCurrencyOf } from './heroReceipt';

export const ResearchSpeedupReceiptQuerySchema = z.object({
  ...ResearchSpeedupIntentSchema.shape,
  baseId: ResearchSpeedupIntentSchema.shape.baseId.optional().transform(v => v ?? null),
  currentLevel: z.coerce.number().pipe(ResearchSpeedupIntentSchema.shape.currentLevel),
  toLevel: z.coerce.number().pipe(ResearchSpeedupIntentSchema.shape.toLevel),
  episodeId: z.union([z.literal('null').transform(() => null), ResearchSpeedupIntentSchema.shape.episodeId.unwrap()]),
}).strict().pipe(ResearchSpeedupIntentSchema);
const Metadata = z.object({ wallet: z.string(), baseId: z.uuid().optional(), troop: ResearchSpeedupIntentSchema.shape.troop,
  toLevel: ResearchSpeedupIntentSchema.shape.toLevel, remSec: z.number().int().positive(),
  recycled: z.literal(true).optional(), currency: z.enum(['KEEP', 'GEMS']).optional(),
  researchSpeedup: z.object({ version: z.literal(1), request: ResearchSpeedupIntentSchema }).strict(),
}).strict();
export function researchSpeedupLedgerKey(wallet: string, key: string, baseId?: string | null): string {
  return `rspeedup:${baseId?.toLowerCase() ?? wallet}:${key}`;
}
export function researchSpeedupIntent(troop: ResearchSpeedupIntent['troop'], key: string, baseId: string | undefined, consent?: ResearchFinishConsent): ResearchSpeedupIntent | undefined {
  const currency = clientCurrencyContext().expectedCurrency;
  // Existing header-less and unconfirmed clients keep their historical posting.
  if (!currency || !consent) return undefined;
  return parse(ResearchSpeedupIntentSchema, { ...consent, troop, idempotencyKey: key, baseId: baseId?.toLowerCase() ?? null, expectedCurrency: currency });
}
export async function getResearchSpeedupReceipt(db: DbOrTx, wallet: string, raw: ResearchSpeedupIntent) {
  const request = ResearchSpeedupIntentSchema.parse(raw);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
    researchSpeedupLedgerKey(wallet, request.idempotencyKey, request.baseId)));
  if (!txn || txn.type !== 'research.speedup') return unknown;
  const parsed = Metadata.safeParse(txn.metadata);
  if (!parsed.success) return unknown;
  const metadata = parsed.data;
  if (metadata.wallet !== wallet || !sameResearchSpeedupIntent(request, metadata.researchSpeedup.request)
    || metadata.troop !== request.troop || metadata.toLevel !== request.toLevel
    || (metadata.baseId ?? null) !== request.baseId) return unknown;
  const entries = await db.select({ delta: ledgerEntries.delta, account: accounts }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  const debit = entries.find(e => e.delta < 0n); const credit = entries.find(e => e.delta > 0n);
  if (entries.length !== 2 || !debit || !credit || debit.delta + credit.delta !== 0n
    || spendCurrencyOf(debit.account, credit.account, metadata) !== request.expectedCurrency
    || debit.account.ownerWallet !== wallet || debit.account.baseId !== null
    || credit.account.ownerWallet !== null || credit.account.baseId !== null
    || -debit.delta > BigInt(request.maxCostKeep)) return unknown;
  return ResearchSpeedupProofSchema.parse({ version: 1, status: 'accepted', request, wallet,
    receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
    funding: { currency: request.expectedCurrency, amount: (-debit.delta).toString() },
    result: { troop: request.troop, fromLevel: request.currentLevel, toLevel: request.toLevel } });
}
/** Once transport admission has passed, guarded requests recover before mutable
 * base/episode checks. Historical GET does not require that admission. A key
 * collision or legacy posting cannot become permission to apply another effect. */
export async function replayResearchSpeedup(db: DbOrTx, wallet: string, request: ResearchSpeedupIntent | undefined) {
  if (!request) return null;
  const [txn] = await db.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
    researchSpeedupLedgerKey(wallet, request.idempotencyKey, request.baseId)));
  if (!txn) return null;
  const receipt = await getResearchSpeedupReceipt(db, wallet, request);
  if (receipt.status !== 'accepted') throw new HttpError(409, 'research speedup key does not match its original acceptance', 'RESEARCH_RECEIPT_INVALID');
  return { cost: 0n, troop: receipt.result.troop, toLevel: receipt.result.toLevel };
}
