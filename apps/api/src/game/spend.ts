/**
 * In-game currency sinks + SOL/reward helpers (ECONOMY.md §4b, ✅ LOCKED v3; D-152).
 *
 * D-152 (owner 2026-09-20): every system sink charges GEMS, the closed in-game
 * currency. Gems are acquired only by converting KEEP 1:1 (that KEEP recycles
 * to the emission pool exactly as spent KEEP always did) or by owner-authored
 * one-time task grants (gemsGrants.ts). Spent Gems go to `gems_sink`; nothing
 * ever converts Gems back to KEEP (GEMS-CURRENCY §3 G-1..G-4).
 *
 * Until the custody retirement (E3) custodial `player_keep` still exists, so
 * the sink shim `spendGameCurrency` charges the currency the calling client
 * advertises and never splits a price (E2-GEMS-CONTRACT §3): a code-26 client
 * pays Gems first, then the whole price from custodial KEEP; a legacy client
 * (code 25, no header, workers) pays KEEP first, then Gems. The legacy KEEP leg
 * is the historical `spendKeep` posting (`player_keep → emission_pool`, 100 %
 * recycle, D-062) and is not exported any more: the pinned caller-enumeration
 * test (gems-callers.test.ts) proves no sink bypasses the shim.
 *
 * Construction, structure upgrades, troop training/research, obstacle clears,
 * repairs and raid antes are SHARDS sinks. The only KEEP that burns is the 2%
 * withdrawal fee (money/withdrawals.ts), a token-economics burn rather than
 * gameplay spend, and the KEEP market's 10% real burn (D-150, E3a+).
 *
 * All amounts are integer/bigint base units (no float in balances). Every helper
 * accepts a Db OR an open transaction handle so a caller can run several posts
 * inside one atomic transaction with row locks.
 */
import { gemsEnabled } from '../config';
import { eq } from 'drizzle-orm';
import { HttpError } from '../lib/errors';
import { clientCurrencyContext, type ClientCurrency, type ClientCurrencyContext } from './clientCurrency';
import type { DbOrTx } from '../db/client';
import { accounts, keepCustodyCutoverState, ledgerEntries, ledgerTransactions } from '../db/schema';
import { spendCurrencyOf } from './heroReceipt';
import {
  bootstrapSystemAccounts,
  getOrCreatePlayerAccount,
} from '../ledger/accounts';
import { InsufficientFundsError, postTransaction, type PostedTransaction, type PostTransactionInput } from '../ledger/ledger';

/**
 * Spend a KEEP sink (ECONOMY.md §4b): debit the player, CREDIT emission_pool the
 * full amount (recycle — never burn/split). Idempotent via the key. Insufficient
 * KEEP surfaces as a ledger InsufficientFundsError (mapped to 422 by callers).
 * Accepts a Db OR an open transaction handle — placeBuilding runs it inside its
 * per-wallet locked transaction so the spend commits atomically with the
 * placement. NOTE (K-023 fixed, M23 a15): a KEEP spend advances NO quest — the
 * spend quests count SHARDS only (spendShards/spendBaseShards).
 */
async function legacySpendKeep(
  db: DbOrTx,
  wallet: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
  assertNew?: PostTransactionInput['assertNew'],
): Promise<PostedTransaction> {
  if (amount <= 0n) throw new RangeError(`spendKeep: amount must be positive, got ${amount}`);
  const sys = await bootstrapSystemAccounts(db);
  const player = await getOrCreatePlayerAccount(db, wallet, 'player_keep');

  const posted = await postTransaction(db, {
    idempotencyKey,
    type,
    entries: [
      { account: player.id, delta: -amount },
      { account: sys.emission_pool, delta: amount }, // recycle 100% (ECONOMY.md §4b)
    ],
    // `currency` is stamped only once Gems exist (G-7: flag-off postings stay byte-identical).
    metadata: { wallet, recycled: true, ...(gemsEnabled() ? { currency: 'KEEP' } : {}), ...metadata },
    ...(assertNew ? { assertNew } : {}),
  });

  // K-023 FIXED (M23 a15, owner assignment 2026-08-15): KEEP sinks NO LONGER
  // advance the spend quests. The player-facing templates say "Spend 200/500
  // SHARDS", so a KEEP spend advancing them was a currency mislabel (least
  // surprise). spendShards/spendBaseShards are the only spend-quest hooks now;
  // test/social.test.ts pins that a spendKeep moves no quest progress.
  return posted;
}

export type SpendCurrency = ClientCurrency;
export interface SpendResult extends PostedTransaction { currency: SpendCurrency }

/**
 * Spend Gems on a system sink (D-152): `player_gems −amount / gems_sink +amount`.
 * Same idempotency and insufficient-funds semantics as the KEEP leg, and the same
 * K-023 rule: a Gems spend advances NO quest.
 */
export async function spendGems(
  db: DbOrTx,
  wallet: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
  assertNew?: PostTransactionInput['assertNew'],
): Promise<PostedTransaction> {
  if (amount <= 0n) throw new RangeError(`spendGems: amount must be positive, got ${amount}`);
  const sys = await bootstrapSystemAccounts(db);
  const player = await getOrCreatePlayerAccount(db, wallet, 'player_gems');
  return postTransaction(db, {
    idempotencyKey,
    type,
    entries: [
      { account: player.id, delta: -amount },
      { account: sys.gems_sink, delta: amount },
    ],
    metadata: { wallet, currency: 'GEMS', ...metadata },
    ...(assertNew ? { assertNew } : {}),
  });
}

/** A duplicate may have been paid through the other leg, with different flags
 * or balances. Prove its original wallet debit and exact sink shape; never
 * report the attempted leg or infer payment from metadata alone. */
async function spendResult(db: DbOrTx, wallet: string, type: string, posted: PostedTransaction, attempted: SpendCurrency): Promise<SpendResult> {
  if (!posted.duplicate) return { ...posted, currency: attempted };
  const rows = await db.select({ delta: ledgerEntries.delta, account: accounts, type: ledgerTransactions.type, metadata: ledgerTransactions.metadata })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId)).where(eq(ledgerEntries.txnId, posted.transaction.id));
  const debit = rows.find((r) => r.delta < 0n);
  const credit = rows.find((r) => r.delta > 0n);
  const metadata = debit?.metadata as { wallet?: unknown; recycled?: true; currency?: SpendCurrency } | undefined;
  const currency = debit && credit && metadata ? spendCurrencyOf(debit.account, credit.account, metadata) : null;
  if (rows.length !== 2 || !debit || !credit || debit.delta + credit.delta !== 0n || !currency
    || debit.type !== type || metadata?.wallet !== wallet || debit.account.ownerWallet !== wallet || debit.account.baseId !== null
    || credit.account.ownerWallet !== null || credit.account.baseId !== null) {
    throw new Error('spend replay does not prove the original wallet sink');
  }
  return { ...posted, currency };
}

function changedCurrency(expectedCurrency: ClientCurrency, cost: bigint, reason: 'insufficient_balance' | 'currency_unavailable'): HttpError {
  return new HttpError(409, 'the reviewed currency is no longer available for this price; review again', 'CURRENCY_CONSENT_CHANGED', {
    expectedCurrency, cost: cost.toString(), reason,
  });
}

/**
 * The sink shim (E2-GEMS-CONTRACT §3). Charges exactly ONE currency for the whole
 * price. Exact command consent selects one leg without fallback and uses409
 * on changed availability. Without exact consent, flag off → historical KEEP;
 * flag on → the order is the client's
 * advertised currency first (`opts.currency`, else the request's x-pkw-currency
 * header, else KEEP for legacy clients and workers); a currency that cannot cover
 * the price is skipped, never split. A duplicate key returns the original posting
 * whichever currency it used. When neither covers the price the typed error names
 * the client's preferred currency so the funds sheet routes correctly
 * (INSUFFICIENT_GEMS for Gems-aware clients, INSUFFICIENT_KEEP for legacy ones).
 * Once custody is frozen, preference-only clients use Gems exclusively. Exact
 * KEEP consent refuses a new charge; original receipts still recover first.
 */
export async function spendGameCurrency(
  db: DbOrTx,
  wallet: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
  opts: { currency?: ClientCurrency; context?: ClientCurrencyContext } = {},
): Promise<SpendResult> {
  if (amount <= 0n) throw new RangeError(`spendGameCurrency: amount must be positive, got ${amount}`);
  const context = opts.context ?? clientCurrencyContext();
  const expected = context.expectedCurrency;
  // This is only a currency-selection observation, never an admission lock.
  // The ledger acquires accounts before its definitive custody fence so a
  // concurrent freeze remains a typed refusal without reversing lock order.
  const [custody] = gemsEnabled() && expected !== 'GEMS'
    ? await db.select({ phase: keepCustodyCutoverState.phase }).from(keepCustodyCutoverState)
      .where(eq(keepCustodyCutoverState.id, true))
    : [];
  const custodyRetired = custody?.phase === 'frozen' || custody?.phase === 'retired';
  if (expected) {
    try {
      const posted = expected === 'GEMS'
        ? await spendGems(db, wallet, amount, type, idempotencyKey, metadata, () => {
          if (!gemsEnabled()) throw changedCurrency(expected, amount, 'currency_unavailable');
        })
        : await legacySpendKeep(db, wallet, amount, type, idempotencyKey, metadata, () => {
          if (custodyRetired) throw changedCurrency(expected, amount, 'currency_unavailable');
        });
      return await spendResult(db, wallet, type, posted, expected);
    } catch (error) {
      if (error instanceof InsufficientFundsError) throw changedCurrency(expected, amount, 'insufficient_balance');
      throw error;
    }
  }
  if (!gemsEnabled()) {
    return spendResult(db, wallet, type, await legacySpendKeep(db, wallet, amount, type, idempotencyKey, metadata), 'KEEP');
  }
  const preferred: ClientCurrency = custodyRetired ? 'GEMS' : opts.currency ?? context.currency ?? 'KEEP';
  const order: ClientCurrency[] = custodyRetired ? ['GEMS'] : preferred === 'GEMS' ? ['GEMS', 'KEEP'] : ['KEEP', 'GEMS'];
  // No unlocked balance precheck (security review 2026-09-20 #4): postTransaction
  // claims the idempotency key BEFORE it checks balances, so a retry of an
  // already-charged key returns the original even when both balances have
  // since dropped below the price. Each attempt is its own savepoint; only a
  // shortfall falls through to the next currency, so a price is never split
  // and never charged twice.
  for (const currency of order) {
    try {
      const posted = currency === 'GEMS'
        ? await spendGems(db, wallet, amount, type, idempotencyKey, metadata)
        : await legacySpendKeep(db, wallet, amount, type, idempotencyKey, metadata);
      return await spendResult(db, wallet, type, posted, currency);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
    }
  }
  const gems = await getOrCreatePlayerAccount(db, wallet, 'player_gems');
  const keep = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  throw new HttpError(422, `not enough ${preferred} (need ${amount})`, `INSUFFICIENT_${preferred}`, {
    costGems: amount.toString(), gemsBalance: gems.balance.toString(), keepCustodial: keep.balance.toString(),
  });
}

/**
 * Mirror a committed two-entry spend back to the player, whichever currency it
 * used (the `raid.buffs.system_refund` shape). Values come from the immutable
 * receipt, never from today's constants; the refund key keeps it retryable.
 */
export async function refundPostedSpend(
  db: DbOrTx,
  original: { entries: ReadonlyArray<{ accountId: string; delta: bigint }> },
  refundIdempotencyKey: string,
  type: string,
  metadata?: Record<string, unknown>,
): Promise<PostedTransaction> {
  return postTransaction(db, {
    idempotencyKey: refundIdempotencyKey,
    type,
    entries: original.entries.map((entry) => ({ account: entry.accountId, delta: -entry.delta })),
    metadata: { ...metadata },
  });
}

/**
 * Spend a SHARD sink (dual-currency split, owner 2026-07-24 — ITEMS plan §3):
 * buildings, upgrades, troop training and obstacle clears now charge the SOFT
 * currency. Shards BURN on spend (shard_burn) — they are freely minted by
 * mining (shard_genesis), so there is no pool to recycle into; scarcity comes
 * from the mining quota, and KEEP value comes only from the Gold Forge's
 * daily budget. Same idempotency + insufficient-funds semantics as spendKeep.
 */
export async function spendShards(
  db: DbOrTx,
  wallet: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
  options: { progressQuests?: boolean } = {},
): Promise<PostedTransaction> {
  if (amount <= 0n) throw new RangeError(`spendShards: amount must be positive, got ${amount}`);
  const sys = await bootstrapSystemAccounts(db);
  const player = await getOrCreatePlayerAccount(db, wallet, 'player_shards');

  const posted = await postTransaction(db, {
    idempotencyKey,
    type,
    entries: [
      { account: player.id, delta: -amount },
      { account: sys.shard_burn, delta: amount },
    ],
    metadata: { wallet, ...metadata },
  });

  // The spend quests literally track SHARD spends (K-023 fixed, M23 a15).
  // Only after a NON-duplicate post so failed/retried spends never progress.
  // Dynamic import: quests.ts statically imports this module (claim rewards).
  if (!posted.duplicate && options.progressQuests !== false) {
    const { progressQuestBatch } = await import('./quests');
    await progressQuestBatch(db, wallet, [
      ['spend_200', Number(amount)],
      ['spend_500', Number(amount)],
    ]);
  }
  return posted;
}

/** Mint shards to a player (mining/starter — the shard_genesis faucet). */
export async function rewardShards(
  db: DbOrTx,
  wallet: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
): Promise<PostedTransaction> {
  if (amount <= 0n) throw new RangeError(`rewardShards: amount must be positive, got ${amount}`);
  const sys = await bootstrapSystemAccounts(db);
  const player = await getOrCreatePlayerAccount(db, wallet, 'player_shards');
  return postTransaction(db, {
    idempotencyKey,
    type,
    entries: [
      { account: sys.shard_genesis, delta: -amount },
      { account: player.id, delta: amount },
    ],
    metadata: { wallet, ...metadata },
  });
}

/**
 * SOL sinks retired the prepaid `player_sol_credit` balance (v3, owner
 * 2026-07-19): raid energy and shield extension are now pay-per-action on-chain
 * — a real SOL transfer (shardkeep-core buy_sink) verified at `finalized`, then
 * the in-game grant (money/deposits.ts creditDeposit). There is no ledger SOL
 * debit/credit and no league SOL slice anymore; leagues are funded entirely by
 * the KEEP loot tithe → league_pool.
 */

// rewardKeep was removed under D-152: in-game rewards are Gems grants (gemsGrants.ts);
// mining pays wallet KEEP through the E4 economy program, never a custodial credit.
