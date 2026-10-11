import { WallBatchKeySchema, WallBatchReceiptSchema, WallBatchRequestSchema, WallBatchStatusSchema, type WallBatchRequest } from '@shardkeep/shared/wallBatch';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, players } from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { placeWallBatchCommand, wallBatchLedgerKey, type StableBaseMutationContext } from './base';

export const wallBatchEnabled = () => process.env['WALL_BATCH_V1_ENABLED'] === 'true';
const Proof = z.object({ actor: z.string(), request: WallBatchRequestSchema }).strict();
const Metadata = z.union([
  z.object({ baseId: z.uuid(), wallBatchV1: Proof }).strict(),
  z.object({ wallet: z.string(), wallBatchV1: Proof }).strict(),
]);
function invalid(): never {
  throw new HttpError(503, 'Original wall placement evidence is unavailable; retain this request.', 'WALL_BATCH_EVIDENCE_UNAVAILABLE');
}
async function lockActor(db: DbOrTx, wallet: string) {
  const [actor] = await db.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
  if (!actor) throw new HttpError(401, 'player session is unavailable');
}
/** Immutable committed proof only: no mutable buildings, balance bootstrap, job
 * completion, deed RPC or ownership lookup. An occupied but invalid key blocks. */
async function readReceipt(db: DbOrTx, wallet: string, key: string) {
  const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, wallBatchLedgerKey(wallet, key)));
  if (!txn) return null;
  const decoded = Metadata.safeParse(txn.metadata);
  if (txn.type !== 'build.place' || !decoded.success) return invalid();
  const meta = decoded.data; const request = meta.wallBatchV1.request;
  if (meta.wallBatchV1.actor !== wallet || request.idempotencyKey !== key) return invalid();
  if (request.baseId === null ? !('wallet' in meta) || meta.wallet !== wallet
    : !('baseId' in meta) || meta.baseId !== request.baseId) return invalid();
  const entries = await db.select({ delta: ledgerEntries.delta, kind: accounts.kind, currency: accounts.currency,
    ownerWallet: accounts.ownerWallet, baseId: accounts.baseId }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  if (entries.length !== 2) return invalid();
  const debit = entries.find(e => e.delta < 0n); const credit = entries.find(e => e.delta > 0n);
  if (!debit || !credit || debit.delta + credit.delta !== 0n || debit.currency !== 'SHARDS' || credit.currency !== 'SHARDS'
    || credit.kind !== 'shard_burn' || credit.ownerWallet !== null || credit.baseId !== null) return invalid();
  if (request.baseId === null ? debit.kind !== 'player_shards' || debit.ownerWallet !== wallet || debit.baseId !== null
    : debit.kind !== 'base_shards' || debit.ownerWallet !== null || debit.baseId !== request.baseId) return invalid();
  const receipt = WallBatchReceiptSchema.safeParse({ version: 1, actor: wallet, idempotencyKey: key, request,
    receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(), funding: { currency: 'SHARDS', amount: (-debit.delta).toString() } });
  return receipt.success ? receipt.data : invalid();
}
export async function getWallBatchCommand(db: Db, wallet: string, inputKey: string) {
  const { key } = WallBatchKeySchema.parse({ key: inputKey });
  return db.transaction(async tx => {
    await lockActor(tx, wallet);
    return WallBatchStatusSchema.parse({ version: 1, wallet, idempotencyKey: key, enabled: wallBatchEnabled(), receipt: await readReceipt(tx, wallet, key) });
  });
}
export async function executeWallBatchCommand(db: Db, wallet: string, input: WallBatchRequest,
  now = new Date(), context?: StableBaseMutationContext) {
  const request = WallBatchRequestSchema.parse(input);
  return db.transaction(async tx => {
    await lockActor(tx, wallet);
    const prior = await readReceipt(tx, wallet, request.idempotencyKey);
    if (prior) {
      if (JSON.stringify(prior.request) !== JSON.stringify(request)) {
        throw new HttpError(409, 'This key belongs to different wall placement consent.', 'WALL_BATCH_MISMATCH');
      }
      return prior;
    }
    if (!wallBatchEnabled()) throw new HttpError(503, 'Wall batch placement is temporarily unavailable.', 'WALL_BATCH_DISABLED');
    if (request.baseId === null && multiBaseEnabled()) throw new HttpError(409, 'Review an explicit original base before placing walls.', 'BASE_ID_REQUIRED');
    if (request.baseId ? context?.baseId !== request.baseId : context !== undefined) {
      throw new HttpError(409, 'Review the original wall placement base again.', 'WALL_BATCH_CONTEXT_MISMATCH');
    }
    const result = await placeWallBatchCommand(tx, wallet, request, now, context);
    const receipt = await readReceipt(tx, wallet, request.idempotencyKey);
    if (!receipt || receipt.receiptId !== result.receiptId) return invalid();
    return receipt;
  });
}
