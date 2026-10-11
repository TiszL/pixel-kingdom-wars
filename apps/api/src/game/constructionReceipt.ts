import { MinePurchaseConsentSchema, MinePurchaseIntentSchema, MinePurchaseProofSchema, sameMinePurchase, type MinePurchaseIntent } from '@shardkeep/shared/minePurchase';
import { MINING } from '@shardkeep/shared';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { clientCurrencyContext } from './clientCurrency';
import { BuildingType, PLOT_GEOMETRY, plotBounds } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { accounts, itemUses, ledgerEntries, ledgerTransactions, players } from '../db/schema';
import { spendCurrencyOf } from './heroReceipt';

const Key = z.string().min(8).max(128);
const plot = plotBounds(PLOT_GEOMETRY.currentVersion);
// Recovery reads the original signed coordinates and ledger evidence. Today's
// selected base/claim is deliberately not an acceptance or recovery authority.
const Tile = z.number().int().min(plot.min).max(plot.max - 1);
const Request = z.object({
  idempotencyKey: Key, type: z.nativeEnum(BuildingType), tx: Tile, ty: Tile, baseId: z.uuid().optional(),
}).strict();
export const ConstructionReceiptQuerySchema = Request.extend({
  tx: z.coerce.number().pipe(Tile), ty: z.coerce.number().pipe(Tile),
});
export const ConstructionReceiptSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key }),
  z.object({
    version: z.literal(1), status: z.literal('accepted'), request: Request,
    baseId: z.uuid().nullable(), receiptId: z.uuid(), acceptedAt: z.iso.datetime(),
    funding: z.object({ currency: z.enum(['SHARDS', 'KEEP', 'GEMS']), amount: z.string().regex(/^[1-9][0-9]*$/) }),
    minePurchase: MinePurchaseProofSchema.optional(),
  }),
]);
export type ConstructionReceipt = z.infer<typeof ConstructionReceiptSchema>;
export type ConstructionReceiptRequest = z.infer<typeof Request>;
/** Route-only answer (never returned by getConstructionReceipt): see readConstructionReceipt. */
export const ConstructionReceiptAbsentSchema = z.object({
  version: z.literal(1), status: z.literal('absent'), idempotencyKey: Key, absentAsOf: z.iso.datetime(),
}).strict();
export type ConstructionReceiptAnswer = ConstructionReceipt | z.infer<typeof ConstructionReceiptAbsentSchema>;
// Altar keys may be claimed by an item_uses row alone; the Keep is never placed.
const NOT_KEY_SCOPED: readonly BuildingType[] = [BuildingType.Keep, BuildingType.HeroAltar, BuildingType.SiegeStool];

const fields = { type: z.nativeEnum(BuildingType), tx: Tile, ty: Tile };
const ShardMetadata = z.union([
  z.object({ ...fields, baseId: z.uuid() }).strict(),
  z.object({ ...fields, wallet: z.string() }).strict(),
]);
// D-152: an extra Mine is paid in Gems (`currency: 'GEMS'`, no `recycled`) or
// through the legacy KEEP leg (`recycled: true`); the debit account decides.
const MineMetadata = z.object({
  ...fields, type: z.literal(BuildingType.Mine), wallet: z.string(), baseId: z.uuid().optional(),
  recycled: z.literal(true).optional(), currency: z.enum(['KEEP', 'GEMS']).optional(),
  mineIndex: z.number().int().positive(),
  minePurchase: z.object({ version: z.literal(1), request: MinePurchaseIntentSchema }).strict().optional(),
}).strict();
const sameUuid = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Historical acceptance only. No mutable building/deed lookup, lazy job
 * completion, price reconstruction or purchase retry. Missing evidence stays
 * unknown; this must never authorize replacing an unresolved request. */
export async function getConstructionReceipt(
  db: DbOrTx, wallet: string, input: ConstructionReceiptRequest,
): Promise<ConstructionReceipt> {
  const request = Request.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  if (NOT_KEY_SCOPED.includes(request.type)) return unknown;
  const [txn] = await db.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, `build:${wallet}:${request.idempotencyKey}`));
  if (!txn) return unknown;
  const parsedMine = txn.type === 'build.mine' ? MineMetadata.safeParse(txn.metadata) : null;
  const parsed = txn.type === 'build.place' ? ShardMetadata.safeParse(txn.metadata) : parsedMine;
  if (!parsed?.success) return unknown;
  const metadata = parsed.data;
  if (metadata.type !== request.type || metadata.tx !== request.tx || metadata.ty !== request.ty) return unknown;
  if ('wallet' in metadata && metadata.wallet !== wallet) return unknown;
  const baseId = 'baseId' in metadata ? metadata.baseId ?? null : null;
  // Never bind an omitted original base to today's selection, or pretend an
  // explicit base was honored by an old legacy writer that ignored it.
  if (baseId === null ? request.baseId !== undefined
    : request.baseId === undefined || !sameUuid(baseId, request.baseId)) return unknown;
  const entries = await db.select({ delta: ledgerEntries.delta, account: accounts }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  if (entries.length !== 2) return unknown;
  const debit = entries.find((entry) => entry.delta < 0n);
  const credit = entries.find((entry) => entry.delta > 0n);
  if (!debit || !credit || debit.delta + credit.delta !== 0n) return unknown;
  const mine = txn.type === 'build.mine';
  const mineCurrency = mine ? spendCurrencyOf(debit.account, credit.account, metadata as { recycled?: true | undefined; currency?: 'KEEP' | 'GEMS' | undefined }) : null;
  if (mine && !mineCurrency) return unknown;
  const currency = mine ? mineCurrency! : 'SHARDS';
  const keep = mine;
  const expectedKind = mine ? (currency === 'GEMS' ? 'player_gems' : 'player_keep') : baseId ? 'base_shards' : 'player_shards';
  if (debit.account.kind !== expectedKind || debit.account.currency !== currency
    || credit.account.currency !== currency
    || credit.account.kind !== (mine ? (currency === 'GEMS' ? 'gems_sink' : 'emission_pool') : 'shard_burn')
    || credit.account.ownerWallet !== null || credit.account.baseId !== null) return unknown;
  const payerMatches = !keep && baseId
    ? debit.account.ownerWallet === null && debit.account.baseId !== null && sameUuid(debit.account.baseId, baseId)
    : debit.account.ownerWallet === wallet && debit.account.baseId === null;
  if (!payerMatches) return unknown;
  let minePurchase: z.infer<typeof MinePurchaseProofSchema> | undefined;
  if (parsedMine?.success && parsedMine.data.minePurchase) {
    const original = parsedMine.data.minePurchase.request;
    if (original.type !== request.type || original.tx !== request.tx || original.ty !== request.ty
      || original.idempotencyKey !== request.idempotencyKey || original.baseId !== baseId
      || original.mineConsent.mineIndex !== parsedMine.data.mineIndex) return unknown;
    const proof = MinePurchaseProofSchema.safeParse({ version: 1, wallet, request: original, receiptId: txn.id,
      acceptedAt: txn.createdAt.toISOString(), funding: { currency, amount: (-debit.delta).toString() } });
    if (!proof.success) return unknown;
    minePurchase = proof.data;
  }
  return ConstructionReceiptSchema.parse({
    version: 1, status: 'accepted', request, baseId, receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
    funding: { currency, amount: (-debit.delta).toString() }, ...(minePurchase ? { minePurchase } : {}),
  });
}

/** GET /base/buildings/receipt. `absent` is stronger than `unknown`: no row
 * claims `build:<wallet>:<key>` at all, so no committed command used this key.
 * Any existing row, even a mismatching one, stays `unknown`, and the altar/Keep
 * types stay `unknown` exactly as before.
 *
 * Concurrency: every construction writer (placement, wall run, Mine purchase,
 * altar/hero command) takes this wallet's players row FOR UPDATE first and
 * claims the key in that same transaction. FOR SHARE here waits for any such
 * transaction to commit or roll back. Under READ COMMITTED the reads that follow
 * see its committed result. Remaining window: a request still before its lock
 * (in transit, auth, or land/deed admission) is invisible. `absentAsOf` is
 * stamped after the lock and before the reads, so it never runs ahead of the
 * snapshot. A client must treat `absent` as final only once `absentAsOf` is at
 * least its minimum age after the last time it could have sent the request. */
export async function readConstructionReceipt(
  db: Db, wallet: string, input: ConstructionReceiptRequest,
): Promise<ConstructionReceiptAnswer> {
  const request = Request.parse(input);
  return db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('share');
    const absentAsOf = new Date().toISOString();
    const receipt = await getConstructionReceipt(tx, wallet, request);
    if (receipt.status !== 'unknown' || NOT_KEY_SCOPED.includes(request.type)) return receipt;
    if (await constructionKeyClaimed(tx, wallet, request.idempotencyKey)) return receipt;
    return ConstructionReceiptAbsentSchema.parse({ version: 1, status: 'absent', idempotencyKey: request.idempotencyKey, absentAsOf });
  }, { isolationLevel: 'read committed' });
}

/** True when any row claims this key in the construction namespace: the ledger
 * key every paid placement posts, or the hero-contract item use. That leg posts
 * no ledger row and may be base-scoped (`build:<wallet>:<baseId>:<key>`). Any
 * item use ending in `:<key>` counts, so an ambiguous match stays `unknown`. */
async function constructionKeyClaimed(tx: DbOrTx, wallet: string, key: string): Promise<boolean> {
  const [txn] = await tx.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, `build:${wallet}:${key}`));
  if (txn) return true;
  const uses = await tx.select({ key: itemUses.idempotencyKey }).from(itemUses).where(and(
    eq(itemUses.playerWallet, wallet), sql`strpos(${itemUses.idempotencyKey}, ${`build:${wallet}:`}) = 1`,
  ));
  return uses.some((use) => use.key.endsWith(`:${key}`));
}

export const MINE_PURCHASE_FEATURE = { version: 1, receipts: 1 } as const;
export function additionalMineQuote(index: number, max: number) {
  const cost = MINING.MINE_BUILD_KEEP[index];
  return index > 0 && index < max && cost !== undefined
    ? MinePurchaseConsentSchema.parse({ version: 1, mineIndex: index, maxCostKeep: String(cost) }) : null;
}
export function minePurchaseIntent(input: { type: string; tx: number; ty: number; idempotencyKey: string; baseId?: string | undefined; heroContractOnly?: boolean | undefined; mineConsent?: z.infer<typeof MinePurchaseConsentSchema> | undefined }): MinePurchaseIntent | undefined {
  if (!input.mineConsent) return undefined;
  if (input.heroContractOnly !== undefined) throw new HttpError(400, 'Mine consent cannot recruit a hero');
  const expectedCurrency = clientCurrencyContext().expectedCurrency;
  if (!expectedCurrency) throw new HttpError(400, 'Mine consent requires an exact currency header', 'INVALID_CURRENCY_CONSENT');
  return parse(MinePurchaseIntentSchema, { type: input.type, tx: input.tx, ty: input.ty, idempotencyKey: input.idempotencyKey,
    baseId: input.baseId?.toLowerCase() ?? null, expectedCurrency, mineConsent: input.mineConsent });
}
export function assertMinePurchaseScope(request: MinePurchaseIntent, stable: boolean): void {
  if ((request.baseId !== null) !== stable) throw new HttpError(409, 'Mine base mode changed; review again', 'MINE_PURCHASE_SCOPE_CHANGED');
}
export async function replayMinePurchase(db: DbOrTx, wallet: string, request: MinePurchaseIntent) {
  const [txn] = await db.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, `build:${wallet}:${request.idempotencyKey}`));
  if (!txn) return null;
  const receipt = await getConstructionReceipt(db, wallet, { type: BuildingType.Mine, tx: request.tx, ty: request.ty,
    idempotencyKey: request.idempotencyKey, ...(request.baseId ? { baseId: request.baseId } : {}) });
  if (receipt.status !== 'accepted' || !receipt.minePurchase || !sameMinePurchase(receipt.minePurchase.request, request))
    throw new HttpError(409, 'Mine key differs from original acceptance', 'MINE_PURCHASE_RECEIPT_INVALID');
  return receipt;
}
