/**
 * Gems conversions (D-152; docs/phase-e/E2-GEMS-CONTRACT.md §1.2, §2).
 *
 *  - KEEP → Gems (ledger source, before the custody retirement): ONE ledger
 *    transaction carrying the KEEP pair and the GEMS pair — the ledger balances
 *    per currency, so the KEEP that backs every minted Gem is in the same row
 *    (invariant G-3): `player_keep −k / emission_pool +k / gems_mint −g /
 *    player_gems +g`. The KEEP recycles exactly as spent KEEP always did.
 *  - Gems → SHARDS at GEMS.shardsPerGem, unlimited (owner), a conversion (untaxed,
 *    G-5): `player_gems −g / gems_sink +g / shard_genesis −s / <shards> +s`.
 *    Replaces convertKeepToShards (forge.ts) whose route answers 409 once Gems are on.
 * Every function is idempotent on a namespaced key and refuses a key reused with a
 * different amount (the forge.convert rule). Receipts verify the exact entry sets.
 */
import { GEMS } from '@shardkeep/shared';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, players } from '../db/schema';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../ledger/accounts';
import { InsufficientFundsError, postTransaction } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';
import { GemsConversionExpectedSchema, assertGemsTerms, assertSameGemsExpected, type GemsConversionExpected } from './gemsConsent';

const Amount = z.string().max(32).regex(/^[1-9][0-9]*$/);
export const GEMS_FEATURE = { version: 1, receipts: 1, exactConsent: 1 } as const;

export function assertConvertibleKeep(keep: bigint): void {
  if (keep < BigInt(GEMS.minConvertKeep)) {
    throw new HttpError(422, `convert at least ${GEMS.minConvertKeep} KEEP`, 'GEMS_PURCHASE_BELOW_MINIMUM',
      { minConvertKeep: GEMS.minConvertKeep });
  }
  if (keep > BigInt(GEMS.maxConvertKeepPerTx)) {
    throw new HttpError(422, `convert at most ${GEMS.maxConvertKeepPerTx} KEEP per request`, 'GEMS_PURCHASE_ABOVE_MAXIMUM',
      { maxConvertKeepPerTx: GEMS.maxConvertKeepPerTx });
  }
}

/** KEEP → Gems from the custodial balance (pre-F only; E3 retires this source). */
export async function convertKeepToGems(db: Db, wallet: string, keep: bigint, idempotencyKey: string, expected?: GemsConversionExpected) {
  expected = parse(GemsConversionExpectedSchema.optional(), expected);
  if (keep <= 0n) assertConvertibleKeep(keep);
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const original = await fromKeepResult(tx, wallet, keep, idempotencyKey, expected, true);
    if (original) return original;
    const rate = GEMS.gemsPerKeep;
    const gems = keep * BigInt(rate);
    const sys = await bootstrapSystemAccounts(tx);
    const keepAcct = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
    const gemsAcct = await getOrCreatePlayerAccount(tx, wallet, 'player_gems');
    let posted;
    try {
      posted = await postTransaction(tx, {
        idempotencyKey: `gems:from-keep:${wallet}:${idempotencyKey}`,
        type: 'gems.from_keep',
        assertNew: () => {
          assertConvertibleKeep(keep);
          return assertGemsTerms(expected, rate, gems.toString());
        },
        entries: [
          { account: keepAcct.id, delta: -keep },
          { account: sys.emission_pool, delta: keep }, // recycles into future budgets (D-062, D-152 §0-3)
          { account: sys.gems_mint, delta: -gems },
          { account: gemsAcct.id, delta: gems },
        ],
        metadata: { wallet, keep: keep.toString(), gems: gems.toString(), rate, source: 'ledger', ...(expected ? { expected } : {}) },
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new HttpError(422, `not enough KEEP (need ${keep})`, 'INSUFFICIENT_KEEP', { keepCustodial: keepAcct.balance.toString() });
      }
      throw error;
    }
    const originalDebit = posted.entries.find((e) => e.accountId === keepAcct.id)?.delta;
    if (originalDebit !== -keep) {
      throw new HttpError(409, 'idempotency key was already used with a different conversion amount', 'IDEMPOTENCY_BODY_MISMATCH');
    }
    const accepted = await fromKeepResult(tx, wallet, keep, idempotencyKey, expected, posted.duplicate);
    if (!accepted) throw new Error('Gems conversion posting could not be proved');
    return accepted;
  });
}

/** Gems → SHARDS at the LOCKED 1:1 rate for the selected base (or the wallet's
 *  legacy pool). Unlimited by owner decision; the loop back into mining is
 *  loss-making by G-6, which the journey model proves each run. */
export async function convertGemsToShards(
  db: Db, wallet: string, gems: bigint, idempotencyKey: string,
  baseId?: string, stableContext?: StableBaseMutationContext,
  expected?: GemsConversionExpected,
) {
  expected = parse(GemsConversionExpectedSchema.optional(), expected);
  if (gems <= 0n) throw new HttpError(422, 'convert a positive Gems amount');
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const original = await toShardsResult(tx, wallet, gems, idempotencyKey, baseId, expected, true);
    if (original) return original;
    const rate = GEMS.shardsPerGem;
    const shards = gems * BigInt(rate);
    if (baseId) {
      if (!stableContext || stableContext.baseId !== baseId) {
        throw new HttpError(409, 'base authority context does not match target', 'BASE_NOT_OWNED');
      }
      await lockStablePrerequisiteBase(tx, wallet, stableContext);
    }
    const sys = await bootstrapSystemAccounts(tx);
    const gemsAcct = await getOrCreatePlayerAccount(tx, wallet, 'player_gems');
    const shardAcct = baseId
      ? await getOrCreateBaseAccount(tx, baseId, 'base_shards')
      : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
    let posted;
    try {
      posted = await postTransaction(tx, {
        idempotencyKey: `gems:to-shards:${wallet}:${idempotencyKey}`,
        type: 'gems.to_shards',
        assertNew: () => assertGemsTerms(expected, rate, shards.toString()),
        entries: [
          { account: gemsAcct.id, delta: -gems },
          { account: sys.gems_sink, delta: gems },
          { account: sys.shard_genesis, delta: -shards },
          { account: shardAcct.id, delta: shards },
        ],
        metadata: { wallet, ...(baseId ? { baseId } : {}), gems: gems.toString(), shards: shards.toString(), rate, ...(expected ? { expected } : {}) },
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new HttpError(422, `not enough GEMS (need ${gems})`, 'INSUFFICIENT_GEMS', { gemsBalance: gemsAcct.balance.toString() });
      }
      throw error;
    }
    const originalDebit = posted.entries.find((e) => e.accountId === gemsAcct.id)?.delta;
    if (originalDebit !== -gems || !posted.entries.some((e) => e.accountId === shardAcct.id && e.delta > 0n)) {
      throw new HttpError(409, 'idempotency key was already used with a different conversion amount', 'IDEMPOTENCY_BODY_MISMATCH');
    }
    const accepted = await toShardsResult(tx, wallet, gems, idempotencyKey, baseId, expected, posted.duplicate);
    if (!accepted) throw new Error('Gems conversion posting could not be proved');
    return accepted;
  });
}

export async function getGemsBalance(db: DbOrTx, wallet: string): Promise<bigint> {
  return (await getOrCreatePlayerAccount(db, wallet, 'player_gems')).balance;
}

// ---------------------------------------------------------------------------
// Receipts (E1-CONTRACTS §4.0 rule 2): immutable evidence only; `unknown` with
// 200 when nothing matches, never 404.
// ---------------------------------------------------------------------------

export const GemsFromKeepReceiptQuerySchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  /** Optional: the by-key route recovers from the key alone; a query that names
   *  an amount must match the immutable posting exactly. */
  keep: Amount.optional(),
}).strict();
export const GemsToShardsReceiptQuerySchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  gems: Amount,
  baseId: z.uuid().transform((id) => id.toLowerCase()).optional(),
}).strict();

const Unknown = z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: z.string() });
export const GemsFromKeepReceiptSchema = z.discriminatedUnion('status', [Unknown, z.object({
  version: z.literal(1), status: z.literal('accepted'), wallet: z.string(), receiptId: z.uuid(), acceptedAt: z.iso.datetime(),
  request: GemsFromKeepReceiptQuerySchema.extend({ expected: GemsConversionExpectedSchema.optional() }),
  funding: z.object({ currency: z.literal('KEEP'), amount: Amount }),
  result: z.object({ gems: Amount, rate: z.number().int().positive() }),
})]);
export const GemsToShardsReceiptSchema = z.discriminatedUnion('status', [Unknown, z.object({
  version: z.literal(1), status: z.literal('accepted'), wallet: z.string(), baseId: z.uuid().nullable(), receiptId: z.uuid(),
  acceptedAt: z.iso.datetime(), request: GemsToShardsReceiptQuerySchema.extend({ expected: GemsConversionExpectedSchema.optional() }),
  funding: z.object({ currency: z.literal('GEMS'), amount: Amount }),
  result: z.object({ shards: Amount, rate: z.number().int().positive() }),
})]);

type Entry = { delta: bigint; kind: string; currency: string; ownerWallet: string | null; baseId: string | null };
async function entriesOf(db: DbOrTx, txnId: string): Promise<Entry[]> {
  return db.select({ delta: ledgerEntries.delta, kind: accounts.kind, currency: accounts.currency,
    ownerWallet: accounts.ownerWallet, baseId: accounts.baseId })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(eq(ledgerEntries.txnId, txnId));
}
const has = (entries: Entry[], kind: string, currency: string, delta: bigint, owner: string | null, baseId?: string | null) =>
  entries.some((e) => e.kind === kind && e.currency === currency && e.delta === delta && e.ownerWallet === owner
    && (baseId === undefined || (e.baseId ?? null) === baseId));

export async function getGemsFromKeepReceipt(db: DbOrTx, wallet: string, input: z.infer<typeof GemsFromKeepReceiptQuerySchema>) {
  const request = GemsFromKeepReceiptQuerySchema.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  const [txn] = await db.select().from(ledgerTransactions)
    .where(inArray(ledgerTransactions.idempotencyKey, [`gems:from-keep:${wallet}:${request.idempotencyKey}`]));
  if (!txn || txn.type !== 'gems.from_keep') return unknown;
  const meta = z.object({ wallet: z.string(), keep: Amount, gems: Amount, rate: z.number().int().positive(),
    expected: GemsConversionExpectedSchema.optional() }).safeParse(txn.metadata);
  if (!meta.success || meta.data.wallet !== wallet
    || (request.keep !== undefined && meta.data.keep !== request.keep)) return unknown;
  const keep = BigInt(meta.data.keep); const gems = BigInt(meta.data.gems);
  if (keep * BigInt(meta.data.rate) !== gems) return unknown;
  if (meta.data.expected && (meta.data.expected.rate !== meta.data.rate || meta.data.expected.output !== meta.data.gems)) return unknown;
  const entries = await entriesOf(db, txn.id);
  if (entries.length !== 4 || !has(entries, 'player_keep', 'KEEP', -keep, wallet, null) || !has(entries, 'emission_pool', 'KEEP', keep, null, null)
    || !has(entries, 'gems_mint', 'GEMS', -gems, null, null) || !has(entries, 'player_gems', 'GEMS', gems, wallet, null)) return unknown;
  return GemsFromKeepReceiptSchema.parse({
    version: 1, status: 'accepted', wallet, receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
    request: { idempotencyKey: request.idempotencyKey, keep: meta.data.keep, ...(meta.data.expected ? { expected: meta.data.expected } : {}) },
    funding: { currency: 'KEEP', amount: meta.data.keep }, result: { gems: meta.data.gems, rate: meta.data.rate },
  });
}

export async function getGemsToShardsReceipt(db: DbOrTx, wallet: string, input: z.infer<typeof GemsToShardsReceiptQuerySchema>) {
  const request = GemsToShardsReceiptQuerySchema.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  const [txn] = await db.select().from(ledgerTransactions)
    .where(inArray(ledgerTransactions.idempotencyKey, [`gems:to-shards:${wallet}:${request.idempotencyKey}`]));
  if (!txn || txn.type !== 'gems.to_shards') return unknown;
  const meta = z.object({ wallet: z.string(), baseId: z.uuid().optional(), gems: Amount, shards: Amount, rate: z.number().int().positive(),
    expected: GemsConversionExpectedSchema.optional() }).safeParse(txn.metadata);
  if (!meta.success || meta.data.wallet !== wallet || meta.data.gems !== request.gems
    || (meta.data.baseId?.toLowerCase() ?? null) !== (request.baseId ?? null)) return unknown;
  const gems = BigInt(meta.data.gems); const shards = BigInt(meta.data.shards);
  if (gems * BigInt(meta.data.rate) !== shards) return unknown;
  if (meta.data.expected && (meta.data.expected.rate !== meta.data.rate || meta.data.expected.output !== meta.data.shards)) return unknown;
  const entries = await entriesOf(db, txn.id);
  const creditOk = request.baseId
    ? has(entries, 'base_shards', 'SHARDS', shards, null, request.baseId)
    : has(entries, 'player_shards', 'SHARDS', shards, wallet, null);
  if (entries.length !== 4 || !has(entries, 'player_gems', 'GEMS', -gems, wallet, null) || !has(entries, 'gems_sink', 'GEMS', gems, null, null)
    || !has(entries, 'shard_genesis', 'SHARDS', -shards, null, null) || !creditOk) return unknown;
  return GemsToShardsReceiptSchema.parse({
    version: 1, status: 'accepted', wallet, baseId: request.baseId ?? null, receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
    request: { ...request, ...(meta.data.expected ? { expected: meta.data.expected } : {}) },
    funding: { currency: 'GEMS', amount: meta.data.gems }, result: { shards: meta.data.shards, rate: meta.data.rate },
  });
}

async function fromKeepResult(db: DbOrTx, wallet: string, keep: bigint, key: string, expected: GemsConversionExpected | undefined, duplicate: boolean) {
  const receipt = await getGemsFromKeepReceipt(db, wallet, { idempotencyKey: key });
  if (receipt.status !== 'accepted') return null;
  if (receipt.funding.amount !== keep.toString()) throw new HttpError(409, 'idempotency key was already used with a different conversion amount', 'IDEMPOTENCY_BODY_MISMATCH');
  assertSameGemsExpected(receipt.request.expected, expected);
  return { keep: receipt.funding.amount, gems: receipt.result.gems, rate: receipt.result.rate, receiptId: receipt.receiptId, duplicate };
}

async function toShardsResult(db: DbOrTx, wallet: string, gems: bigint, key: string, baseId: string | undefined, expected: GemsConversionExpected | undefined, duplicate: boolean) {
  const receipt = await getGemsToShardsReceipt(db, wallet, { idempotencyKey: key, gems: gems.toString(), ...(baseId ? { baseId } : {}) });
  if (receipt.status !== 'accepted') return null;
  assertSameGemsExpected(receipt.request.expected, expected);
  return { gems: receipt.funding.amount, shards: receipt.result.shards, rate: receipt.result.rate, receiptId: receipt.receiptId, duplicate };
}
