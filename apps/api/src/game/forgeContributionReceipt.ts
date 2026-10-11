import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, players } from '../db/schema';

const Amount = z.string().max(32).regex(/^[1-9][0-9]*$/);
export const ForgeContributionReceiptQuerySchema = z.object({
  idempotencyKey: z.string().min(8).max(128), shards: Amount,
  baseId: z.uuid().transform((id) => id.toLowerCase()).optional(),
}).strict();
export type ForgeContributionReceiptRequest = z.infer<typeof ForgeContributionReceiptQuerySchema>;
export const FORGE_CONTRIBUTION_RECEIPT_FEATURE = { version: 1 } as const;
const Metadata = z.object({ wallet: z.string(), baseId: z.uuid().optional(), day: z.iso.date() }).strict();
export const ForgeContributionReceiptSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: z.string() }),
  z.object({
    version: z.literal(1), status: z.literal('accepted'), wallet: z.string(), baseId: z.uuid().nullable(),
    request: ForgeContributionReceiptQuerySchema, receiptId: z.uuid(), acceptedAt: z.iso.datetime(),
    funding: z.object({ currency: z.literal('SHARDS'), amount: Amount }),
    result: z.object({ day: z.iso.date(), contributedShards: Amount }),
  }),
]);

/** Original SHARDS escrow acceptance, not today's cumulative stake or eventual
 * Forge payout. The mutation assigns its UTC day at acceptance; day is a frozen
 * RESULT here, never a claim that the client consented to a particular day. */
export async function getForgeContributionReceipt(db: Db, wallet: string, input: ForgeContributionReceiptRequest) {
  const request = ForgeContributionReceiptQuerySchema.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) return unknown;
    const key = request.baseId ? `contrib:base:${request.baseId}:${request.idempotencyKey}`
      : `contrib:${wallet}:${request.idempotencyKey}`;
    const [txn] = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key));
    if (!txn || txn.type !== 'forge.contribute') return unknown;
    const parsed = Metadata.safeParse(txn.metadata);
    if (!parsed.success || parsed.data.wallet !== wallet
      || (parsed.data.baseId?.toLowerCase() ?? null) !== (request.baseId ?? null)) return unknown;
    const amount = BigInt(request.shards);
    const entries = await tx.select({ delta: ledgerEntries.delta, kind: accounts.kind,
      currency: accounts.currency, ownerWallet: accounts.ownerWallet, baseId: accounts.baseId,
    }).from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(eq(ledgerEntries.txnId, txn.id));
    if (entries.length !== 2) return unknown;
    const debit = entries.find((entry) => entry.delta === -amount);
    const credit = entries.find((entry) => entry.delta === amount);
    if (!debit || !credit || debit.currency !== 'SHARDS' || credit.currency !== 'SHARDS') return unknown;
    if (request.baseId) {
      if (debit.kind !== 'base_shards' || debit.baseId !== request.baseId || debit.ownerWallet !== null
        || credit.kind !== 'base_forge_escrow' || credit.baseId !== request.baseId || credit.ownerWallet !== null) return unknown;
    } else if (debit.kind !== 'player_shards' || debit.ownerWallet !== wallet || debit.baseId !== null
      || credit.kind !== 'forge_escrow' || credit.ownerWallet !== null || credit.baseId !== null) return unknown;
    return ForgeContributionReceiptSchema.parse({
      version: 1, status: 'accepted', wallet, baseId: request.baseId ?? null, request,
      receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
      funding: { currency: 'SHARDS', amount: request.shards },
      result: { day: parsed.data.day, contributedShards: request.shards },
    });
  });
}
