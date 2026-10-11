/** Wallet Gems evidence (K-156). A deposit's observed transfer is not a ledger
 * credit. Historical amounts come only from its original, exact backed posting. */
import { ECONOMY, TOKEN } from '@shardkeep/shared';
import { isCanonicalSolanaSignature, keepAta } from '@shardkeep/chain';
import { PublicKey } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { accounts, deposits, ledgerEntries, ledgerTransactions } from '../db/schema';

type Deposit = typeof deposits.$inferSelect;
const Whole = z.number().int().positive().refine(Number.isSafeInteger);
const Amount = z.string().regex(/^[1-9][0-9]*$/);
const Address = z.string().refine((value) => {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
const QuotePayload = z.object({
  idempotencyKey: z.string().min(8).max(128), keepIn: Whole, gemsOut: Whole,
  destination: Address, mint: Address,
  gemsBuyVersion: z.literal(1).optional(), decimals: z.number().int().min(0).max(19).optional(),
  expiresAt: z.iso.datetime().optional(),
});
function evidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('Wallet Gems purchase evidence is inconsistent');
}

/** Original rows already froze keepIn/gemsOut/mint/destination. Their missing
 * precision/expiry use the original KEEP protocol; new rows freeze both too.
 * D-152 is a 1:1 obligation, never permission to adopt a later catalogue rate. */
export function originalGemsBuyIntent(row: Deposit) {
  const parsed = QuotePayload.safeParse(row.payload);
  evidence(row.kind === 'gems_buy' && parsed.success);
  const q = parsed.data;
  evidence(q.keepIn === q.gemsOut);
  evidence(q.gemsBuyVersion === undefined || (q.decimals !== undefined && q.expiresAt !== undefined));
  const decimals = q.decimals ?? TOKEN.decimals;
  const expiresAt = q.expiresAt ?? new Date(row.createdAt.getTime() + ECONOMY.depositPendingTtlMin * 60_000).toISOString();
  evidence(Date.parse(expiresAt) > row.createdAt.getTime());
  const source = keepAta(new PublicKey(row.playerWallet), new PublicKey(q.mint)).toBase58();
  evidence(new Set([row.playerWallet, source, q.destination, q.mint, row.reference]).size === 5);
  evidence(Address.safeParse(row.reference).success);
  return { id: row.id, kind: 'gems_buy' as const, wallet: row.playerWallet,
    idempotencyKey: q.idempotencyKey, reference: row.reference, source, destination: q.destination,
    mint: q.mint, decimals, keepIn: q.keepIn, gemsOut: q.gemsOut, expiresAt };
}

const CreditMetadata = z.object({
  wallet: z.string(), depositId: z.uuid(), txSignature: z.string().refine(isCanonicalSolanaSignature),
  keepBaseUnits: Amount, keep: Amount, gems: Amount, rate: z.number().int().positive(), source: z.literal('wallet'),
  mint: Address.optional(), destination: Address.optional(),
});

export async function gemsBuyDisclosure(db: DbOrTx, row: Deposit) {
  const quote = originalGemsBuyIntent(row);
  const unit = 10n ** BigInt(quote.decimals);
  evidence(row.amount === null || row.amount >= 0n);
  const observed = { keepIn: quote.keepIn, gemsOut: quote.gemsOut,
    dustBaseUnits: row.amount === null ? null : (row.amount % unit).toString() };
  // Failed means paid but ungrantable; its observed amount must never claim a credit.
  if (row.status !== 'credited') return { ...observed, keepCredited: null, gemsCredited: null, receipt: null };
  evidence(row.amount !== null && row.txSignature !== null && isCanonicalSolanaSignature(row.txSignature));
  // /paid's confirmed candidate can differ from the finalized reference fallback.
  // The original ledger proves txSignature; retain paymentSignature separately.
  const [txn] = await db.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, `deposit:${row.id}:credit`));
  evidence(txn?.type === 'gems.buy');
  const parsed = CreditMetadata.safeParse(txn.metadata);
  evidence(parsed.success);
  const meta = parsed.data;
  const keep = BigInt(meta.keep), gems = BigInt(meta.gems);
  evidence(meta.wallet === row.playerWallet && meta.depositId === row.id && meta.txSignature === row.txSignature
    && BigInt(meta.keepBaseUnits) === row.amount && row.amount / unit === keep
    && keep === gems && meta.rate === quote.gemsOut / quote.keepIn
    && (meta.mint === undefined || meta.mint === quote.mint)
    && (meta.destination === undefined || meta.destination === quote.destination));
  const entries = await db.select({ kind: accounts.kind, currency: accounts.currency,
    owner: accounts.ownerWallet, baseId: accounts.baseId, delta: ledgerEntries.delta })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(eq(ledgerEntries.txnId, txn.id));
  const has = (kind: string, currency: string, delta: bigint, owner: string | null) =>
    entries.some((e) => e.kind === kind && e.currency === currency && e.delta === delta
      && e.owner === owner && e.baseId === null);
  evidence(entries.length === 4 && has('onchain_inflow', 'KEEP', -keep, null)
    && has('emission_pool', 'KEEP', keep, null) && has('gems_mint', 'GEMS', -gems, null)
    && has('player_gems', 'GEMS', gems, row.playerWallet));
  return { ...observed, keepCredited: meta.keep, gemsCredited: meta.gems,
    receipt: { version: 1 as const, receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
      wallet: row.playerWallet, depositId: row.id, txSignature: row.txSignature,
      funding: { currency: 'KEEP' as const, amount: meta.keep, baseUnits: meta.keepBaseUnits },
      result: { currency: 'GEMS' as const, amount: meta.gems, rate: meta.rate } } };
}
