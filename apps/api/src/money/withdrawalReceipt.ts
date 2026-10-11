import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { WITHDRAWAL_IDEMPOTENCY_KEY_RE } from '../auth/session';
import type { Db } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, withdrawalAuthorizations, withdrawals } from '../db/schema';
import { lockWithdrawalWalletTx } from './withdrawalLock';

const Amount = z.string().max(32).regex(/^(0|[1-9][0-9]*)$/);
const Address = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
/** Exactly the fields the committed rows can prove. The original signed hold
 * duration is not copied into those rows; never infer it from elapsed time or
 * today's constants. The receipt returns the stored maturity instead. */
export const WithdrawalReceiptQuerySchema = z.object({
  idempotencyKey: z.string().regex(WITHDRAWAL_IDEMPOTENCY_KEY_RE),
  grossAmount: z.string().max(32).regex(/^[1-9][0-9]*$/),
  feeBurned: Amount,
  netAmount: Amount,
  destination: Address,
  mode: z.enum(['standard', 'instant']),
  cluster: z.enum(['devnet', 'mainnet-beta']),
  keepMint: Address,
}).strict().refine((request) => {
  // Zod can run object refinements after a field's format check failed.
  // Malformed decimal input must remain a 400, never escape as a BigInt error.
  try { return BigInt(request.grossAmount) - BigInt(request.feeBurned) === BigInt(request.netAmount); }
  catch { return false; }
}, {
  message: 'gross, fee and net amounts must agree',
});
export type WithdrawalReceiptRequest = z.infer<typeof WithdrawalReceiptQuerySchema>;
export const WITHDRAWAL_RECEIPT_FEATURE = { version: 1 } as const;
export const WithdrawalReceiptSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: z.string().regex(WITHDRAWAL_IDEMPOTENCY_KEY_RE) }),
  z.object({
    version: z.literal(1), status: z.literal('accepted'), wallet: Address,
    request: WithdrawalReceiptQuerySchema,
    receiptId: z.uuid(), acceptedAt: z.iso.datetime(),
    funding: z.object({ currency: z.literal('KEEP'), amount: Amount }),
    result: z.object({ withdrawalId: z.uuid(), unbondsAt: z.iso.datetime() }),
  }),
]);
const Metadata = z.object({ wallet: Address, destination: Address, instant: z.boolean() }).strict();

/** A GET proves the original escrow acceptance only, never payout or refund.
 * No lazy settlement, current land/limits, reconstructed quote, wallet proof or
 * mutable balance is read. Taking the writer's wallet lock observes an in-flight
 * freeze only after its transaction commits or rolls back. */
export async function getWithdrawalReceipt(db: Db, wallet: string, input: WithdrawalReceiptRequest) {
  const request = WithdrawalReceiptQuerySchema.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  return db.transaction(async (tx) => {
    await lockWithdrawalWalletTx(tx, wallet);
    const [txn] = await tx.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `withdrawal.request:${wallet}:${request.idempotencyKey}`));
    if (!txn || txn.type !== 'withdrawal.request') return unknown;
    const metadata = Metadata.safeParse(txn.metadata);
    if (!metadata.success || metadata.data.wallet !== wallet || metadata.data.destination !== request.destination
      || metadata.data.instant !== (request.mode === 'instant')) return unknown;
    const [row] = await tx.select({
      id: withdrawals.id, wallet: withdrawals.playerWallet, currency: withdrawals.currency,
      amount: withdrawals.amount, fee: withdrawals.feeBurned, destination: withdrawals.destination,
      unbondsAt: withdrawals.unbondsAt,
      // Deliberately never select the stored challenge or signature. The network
      // on this original authorization survives current configuration changes.
      cluster: withdrawalAuthorizations.cluster, keepMint: withdrawalAuthorizations.keepMint,
    }).from(withdrawals).innerJoin(withdrawalAuthorizations, eq(withdrawalAuthorizations.withdrawalId, withdrawals.id))
      .where(eq(withdrawals.requestLedgerTxnId, txn.id));
    if (!row || row.wallet !== wallet || row.currency !== 'KEEP' || row.destination !== request.destination
      || row.amount.toString() !== request.grossAmount || row.fee.toString() !== request.feeBurned
      || (row.amount - row.fee).toString() !== request.netAmount
      || row.cluster !== request.cluster || row.keepMint !== request.keepMint) return unknown;
    const entries = await tx.select({ delta: ledgerEntries.delta, account: {
      kind: accounts.kind, currency: accounts.currency, ownerWallet: accounts.ownerWallet, baseId: accounts.baseId,
    } }).from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
    if (entries.length !== 2) return unknown;
    const debit = entries.find((entry) => entry.delta === -row.amount);
    const credit = entries.find((entry) => entry.delta === row.amount);
    if (!debit || !credit || debit.account.kind !== 'player_keep' || debit.account.currency !== 'KEEP'
      || debit.account.ownerWallet !== wallet || debit.account.baseId !== null
      || credit.account.kind !== 'withdrawal_escrow' || credit.account.currency !== 'KEEP'
      || credit.account.ownerWallet !== null || credit.account.baseId !== null) return unknown;
    return WithdrawalReceiptSchema.parse({
      version: 1, status: 'accepted', wallet, request,
      receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
      funding: { currency: 'KEEP', amount: row.amount.toString() },
      result: { withdrawalId: row.id, unbondsAt: row.unbondsAt.toISOString() },
    });
  });
}
