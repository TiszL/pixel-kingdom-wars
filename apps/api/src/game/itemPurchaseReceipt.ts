/** Original shop evidence is independent of today's catalogue and inventory. */
import { INVENTORY, type ItemSpec } from '@shardkeep/shared';
import { ItemPurchaseConsentSchema, ItemPurchaseIntentSchema, ItemPurchaseLookupSchema,
  ItemPurchaseProofSchema, sameItemPurchaseIntent, type ItemPurchaseConsent,
  type ItemPurchaseIntent } from '@shardkeep/shared/itemPurchase';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { clientCurrencyContext } from './clientCurrency';
import { spendCurrencyOf } from './heroReceipt';

export const ITEM_PURCHASE_FEATURE = { version: 1, receipts: 1 } as const;
export const ItemPurchaseReceiptQuerySchema = ItemPurchaseLookupSchema.extend({
  baseId: ItemPurchaseLookupSchema.shape.baseId.optional().transform(v => v ?? null),
});
const Metadata = z.object({ wallet: z.string(), itemId: z.string(), baseId: z.uuid().optional(),
  recycled: z.literal(true).optional(), currency: z.enum(['KEEP', 'GEMS']).optional(),
  itemPurchase: z.object({ version: z.literal(1), request: ItemPurchaseIntentSchema,
    result: z.object({ itemId: z.string(), quantity: z.literal(1) }).strict(),
  }).strict().optional(),
}).strict();
export function itemPurchaseLedgerKey(wallet: string, key: string, baseId?: string | null): string {
  // Preserve the historical per-wallet/base namespace; no new operation rail.
  return baseId ? `item:${wallet}:${baseId}:${key}` : `item:${wallet}:${key}`;
}
export function itemPurchaseIntent(itemId: string, key: string, baseId: string | undefined, consent?: ItemPurchaseConsent): ItemPurchaseIntent | undefined {
  if (!consent) return undefined;
  const expectedCurrency = clientCurrencyContext().expectedCurrency;
  if (!expectedCurrency) throw new HttpError(400, 'item consent requires an exact currency header', 'INVALID_CURRENCY_CONSENT');
  return parse(ItemPurchaseIntentSchema, { itemId, baseId: baseId?.toLowerCase() ?? null, idempotencyKey: key, expectedCurrency, consent });
}
export function assertItemPurchaseScope(request: ItemPurchaseIntent | undefined, stable: boolean): void {
  if (request && (request.baseId !== null) !== stable)
    throw new HttpError(409, 'item purchase base mode changed; review again', 'ITEM_BUY_SCOPE_CHANGED');
}
export function itemPurchaseQuote(spec: ItemSpec): ItemPurchaseConsent | null {
  if (spec.acquisition.type === 'drop' || spec.acquisition.type === 'craft' || spec.dropOnly
    || !Number.isSafeInteger(spec.costKeep) || spec.costKeep <= 0) return null;
  return ItemPurchaseConsentSchema.parse({ version: 1, catalogRevision: INVENTORY.catalogRevision,
    quantity: 1, maxCostKeep: String(spec.costKeep) });
}
/** Also proves original amounts for legacy duplicate response compatibility. */
export async function itemPurchaseEvidence(db: DbOrTx, wallet: string, itemId: string, key: string, baseId?: string | null) {
  const [txn] = await db.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, itemPurchaseLedgerKey(wallet, key, baseId)));
  if (!txn || txn.type !== 'item.buy') return null;
  const parsed = Metadata.safeParse(txn.metadata); if (!parsed.success) return null;
  const m = parsed.data;
  if (m.wallet !== wallet || m.itemId !== itemId || (m.baseId ?? null) !== (baseId ?? null)) return null;
  const entries = await db.select({ delta: ledgerEntries.delta, account: accounts }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  const debit = entries.find(e => e.delta < 0n), credit = entries.find(e => e.delta > 0n);
  if (entries.length !== 2 || !debit || !credit || debit.delta + credit.delta !== 0n
    || debit.account.ownerWallet !== wallet || debit.account.baseId !== null
    || credit.account.ownerWallet !== null || credit.account.baseId !== null) return null;
  const currency = spendCurrencyOf(debit.account, credit.account, m);
  // Existing response costKeep is a JSON number. Never round historical evidence.
  if (!currency || -debit.delta > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { txn, metadata: m, currency, amount: -debit.delta };
}
export async function getItemPurchaseReceipt(db: DbOrTx, wallet: string, input: z.infer<typeof ItemPurchaseLookupSchema>) {
  const lookup = ItemPurchaseLookupSchema.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: lookup.idempotencyKey } as const;
  const evidence = await itemPurchaseEvidence(db, wallet, lookup.itemId, lookup.idempotencyKey, lookup.baseId);
  const modern = evidence?.metadata.itemPurchase;
  if (!evidence || !modern || modern.request.itemId !== lookup.itemId || modern.request.baseId !== lookup.baseId
    || modern.request.idempotencyKey !== lookup.idempotencyKey) return unknown;
  const proof = ItemPurchaseProofSchema.safeParse({ version: 1, status: 'accepted', wallet,
    request: modern.request, result: modern.result, receiptId: evidence.txn.id,
    acceptedAt: evidence.txn.createdAt.toISOString(), funding: { currency: evidence.currency, amount: evidence.amount.toString() } });
  return proof.success ? proof.data : unknown;
}
/** Route-only answer (never returned by getItemPurchaseReceipt): see readItemPurchaseReceipt. */
export const ItemPurchaseAbsentSchema = z.object({
  version: z.literal(1), status: z.literal('absent'), idempotencyKey: ItemPurchaseLookupSchema.shape.idempotencyKey,
  absentAsOf: z.iso.datetime(),
}).strict();
/** GET /items/buy/receipt. `absent` means no ledger row holds this purchase's
 * key: `item:<wallet>:<baseId>:<key>`, the only key a consented purchase of this
 * lookup can post (buyItem refuses a base other than request.baseId), nor the
 * wallet-level `item:<wallet>:<key>`. Any existing row, even a mismatching or
 * legacy one, stays `unknown`. Keys under some other base are not searched; they
 * cannot be this request's charge.
 *
 * Concurrency is the same as readConstructionReceipt: buyItem takes this wallet's
 * players row FOR UPDATE before it posts the key, and FOR SHARE here waits for
 * that transaction. A request still before its lock is invisible; `absentAsOf`
 * (stamped after the lock, before the reads) lets a client apply a minimum age. */
export async function readItemPurchaseReceipt(db: Db, wallet: string, input: z.infer<typeof ItemPurchaseLookupSchema>) {
  const lookup = ItemPurchaseLookupSchema.parse(input);
  return db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('share');
    const absentAsOf = new Date().toISOString();
    const receipt = await getItemPurchaseReceipt(tx, wallet, lookup);
    if (receipt.status !== 'unknown') return receipt;
    const keys = [itemPurchaseLedgerKey(wallet, lookup.idempotencyKey, lookup.baseId), itemPurchaseLedgerKey(wallet, lookup.idempotencyKey)];
    const [claimed] = await tx.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
      .where(inArray(ledgerTransactions.idempotencyKey, keys));
    if (claimed) return receipt;
    return ItemPurchaseAbsentSchema.parse({ version: 1, status: 'absent', idempotencyKey: lookup.idempotencyKey, absentAsOf });
  }, { isolationLevel: 'read committed' });
}
export async function replayItemPurchase(db: DbOrTx, wallet: string, request: ItemPurchaseIntent | undefined) {
  if (!request) return null;
  const [txn] = await db.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, itemPurchaseLedgerKey(wallet, request.idempotencyKey, request.baseId)));
  if (!txn) return null;
  const proof = await getItemPurchaseReceipt(db, wallet, { itemId: request.itemId, baseId: request.baseId, idempotencyKey: request.idempotencyKey });
  if (proof.status !== 'accepted' || !sameItemPurchaseIntent(request, proof.request))
    throw new HttpError(409, 'item key differs from original acceptance', 'ITEM_BUY_RECEIPT_INVALID');
  return { itemId: request.itemId, costKeep: Number(proof.funding.amount), currency: proof.funding.currency, duplicate: true };
}
