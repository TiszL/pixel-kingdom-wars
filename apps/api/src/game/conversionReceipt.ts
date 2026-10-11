import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, players } from '../db/schema';

const Amount = z.string().max(32).regex(/^[1-9][0-9]*$/);
export const ConversionReceiptQuerySchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  keep: Amount,
  baseId: z.uuid().transform((id) => id.toLowerCase()).optional(),
}).strict();
export type ConversionReceiptRequest = z.infer<typeof ConversionReceiptQuerySchema>;
export const CONVERSION_RECEIPT_FEATURE = { version: 1 } as const;
const Metadata = z.object({
  wallet: z.string(), baseId: z.uuid().optional(), keep: Amount, shards: Amount,
  rate: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const ConversionReceiptSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: z.string() }),
  z.object({
    version: z.literal(1), status: z.literal('accepted'), wallet: z.string(), baseId: z.uuid().nullable(),
    request: ConversionReceiptQuerySchema, receiptId: z.uuid(), acceptedAt: z.iso.datetime(),
    funding: z.object({ currency: z.literal('KEEP'), amount: Amount }),
    result: z.object({ converted: Amount, shards: Amount, rate: Metadata.shape.rate }),
  }),
]);

/** Both transfers are committed together by convertKeepToShards. Neither a
 * current SHARDS balance nor one half of an exchange proves this request.
 * The original actor may recover after a deed transfer without reading the
 * buyer's state. The rate is frozen metadata, never today's economy constant. */
export async function getConversionReceipt(db: Db, wallet: string, input: ConversionReceiptRequest) {
  const request = ConversionReceiptQuerySchema.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  return db.transaction(async (tx) => {
    // Same first lock as the writer: do not observe a half-finished conversion.
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) return unknown;
    const prefix = `convert:${wallet}:${request.idempotencyKey}`;
    const transactions = await tx.select().from(ledgerTransactions)
      .where(inArray(ledgerTransactions.idempotencyKey, [`${prefix}:keep`, `${prefix}:shards`]));
    const keepTxn = transactions.find((row) => row.idempotencyKey === `${prefix}:keep`);
    const shardsTxn = transactions.find((row) => row.idempotencyKey === `${prefix}:shards`);
    if (!keepTxn || !shardsTxn || keepTxn.type !== 'forge.convert' || shardsTxn.type !== 'forge.convert') return unknown;
    const keepMeta = Metadata.safeParse(keepTxn.metadata);
    const shardsMeta = Metadata.safeParse(shardsTxn.metadata);
    if (!keepMeta.success || !shardsMeta.success) return unknown;
    const metadata = keepMeta.data;
    for (const value of [metadata, shardsMeta.data]) {
      if (value.wallet !== wallet || (value.baseId?.toLowerCase() ?? null) !== (request.baseId ?? null)
        || value.keep !== request.keep || value.shards !== metadata.shards || value.rate !== metadata.rate) return unknown;
    }
    const keep = BigInt(metadata.keep); const shards = BigInt(metadata.shards);
    if (keep * BigInt(metadata.rate) !== shards) return unknown;
    const entries = await tx.select({ txnId: ledgerEntries.txnId, delta: ledgerEntries.delta,
      kind: accounts.kind, currency: accounts.currency, ownerWallet: accounts.ownerWallet, baseId: accounts.baseId,
    }).from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(inArray(ledgerEntries.txnId, [keepTxn.id, shardsTxn.id]));
    const keepEntries = entries.filter((entry) => entry.txnId === keepTxn.id);
    const shardEntries = entries.filter((entry) => entry.txnId === shardsTxn.id);
    if (keepEntries.length !== 2 || shardEntries.length !== 2) return unknown;
    const debit = keepEntries.find((entry) => entry.delta === -keep);
    const recycling = keepEntries.find((entry) => entry.delta === keep);
    const genesis = shardEntries.find((entry) => entry.delta === -shards);
    const credit = shardEntries.find((entry) => entry.delta === shards);
    if (!debit || debit.kind !== 'player_keep' || debit.currency !== 'KEEP'
      || debit.ownerWallet !== wallet || debit.baseId !== null
      || !recycling || recycling.kind !== 'emission_pool' || recycling.currency !== 'KEEP'
      || recycling.ownerWallet !== null || recycling.baseId !== null
      || !genesis || genesis.kind !== 'shard_genesis' || genesis.currency !== 'SHARDS'
      || genesis.ownerWallet !== null || genesis.baseId !== null
      || !credit || credit.currency !== 'SHARDS'
      || (request.baseId
        ? credit.kind !== 'base_shards' || credit.baseId !== request.baseId || credit.ownerWallet !== null
        : credit.kind !== 'player_shards' || credit.ownerWallet !== wallet || credit.baseId !== null)) return unknown;
    return ConversionReceiptSchema.parse({
      version: 1, status: 'accepted', wallet, baseId: request.baseId ?? null, request,
      receiptId: keepTxn.id, acceptedAt: keepTxn.createdAt.toISOString(),
      funding: { currency: 'KEEP', amount: metadata.keep },
      result: { converted: metadata.keep, shards: metadata.shards, rate: metadata.rate },
    });
  });
}
