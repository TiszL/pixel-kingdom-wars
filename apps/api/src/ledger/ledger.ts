/**
 * Append-only double-entry ledger engine (ARCHITECTURE §5,
 * research-security-economy.md §1, GDD §4.9).
 *
 * Invariants enforced here, in ONE SQL transaction per post:
 * - entries sum to zero per currency (double-entry);
 * - touched accounts are locked (SELECT … FOR UPDATE, stable id order — no
 *   deadlocks) and balance_after is computed and stored per entry;
 * - player accounts and finite/collected pools never go negative; mint/world
 *   accounts may;
 * - idempotency_key is UNIQUE: a duplicate post returns the ORIGINAL
 *   transaction (no error, no double-post);
 * - mistakes are fixed by compensating transactions, never UPDATEs.
 */
import { GEMS, LEGACY_QUEST_KEEP_ALLOCATION, TOKEN } from '@shardkeep/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import {
  accounts, ledgerEntries, ledgerTransactions, questBucketRetirementState,
} from '../db/schema';
import { bootstrapSystemAccounts, canGoNegative, type SystemAccountKind } from './accounts';

// ---------------------------------------------------------------------------
// Errors — callers branch on `code`, HTTP layer maps them safely.
// ---------------------------------------------------------------------------

export class LedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnbalancedTransactionError extends LedgerError {
  constructor(currency: string, sum: bigint) {
    super('ledger.unbalanced', `entries for ${currency} sum to ${sum}, expected 0`);
  }
}

export class UnknownAccountError extends LedgerError {
  constructor(accountId: string) {
    super('ledger.unknown_account', `account ${accountId} does not exist`);
  }
}

export class InsufficientFundsError extends LedgerError {
  constructor(accountId: string, balance: bigint, delta: bigint) {
    super(
      'ledger.insufficient_funds',
      `account ${accountId} balance ${balance} cannot absorb delta ${delta}`,
    );
  }
}

export class InvalidTransactionError extends LedgerError {
  constructor(message: string) {
    super('ledger.invalid', message);
  }
}

/** D-152 invariant G-1: Gems are one-way. Thrown when a posting would debit a
 *  player's Gems and credit any KEEP or SOL account in the same transaction. */
export class GemsOneWayError extends LedgerError {
  constructor(idempotencyKey: string) {
    super('ledger.gems_one_way', `transaction ${idempotencyKey} would convert Gems into KEEP or SOL`);
  }
}

const GEMS_PLAYER_KINDS: ReadonlySet<string> = new Set(['player_gems', 'player_gems_store']);

/** D-152 invariant G-3: every Gem minted is backed by the same whole amount of
 *  KEEP debited in the SAME posting from a backing account (a conversion, the
 *  reward budget, or — at the custody retirement — a retired custodial class). */
export class GemsUnbackedMintError extends LedgerError {
  constructor(idempotencyKey: string, minted: bigint, backing: bigint) {
    super('ledger.gems_unbacked_mint', `transaction ${idempotencyKey} mints ${minted} Gems against ${backing} KEEP`);
  }
}

const GEMS_BACKING_KINDS: ReadonlySet<string> = new Set([
  'player_keep', 'onchain_inflow', 'gems_reward_budget',
  // E3 retirement classes (E2-GEMS-CONTRACT §1.2 `gems.retirement`).
  'forge_payout_escrow', 'mail_keep_escrow', 'league_entitlement_escrow',
]);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface EntryInput {
  /** Account id (uuid) — from bootstrapSystemAccounts / getOrCreatePlayerAccount. */
  account: string;
  /** Signed amount in base units. Non-zero. */
  delta: bigint;
}

export interface PostTransactionInput {
  idempotencyKey: string;
  /** e.g. 'emission.daily', 'raid.loot', 'withdrawal.request'. */
  type: string;
  entries: EntryInput[];
  metadata?: Record<string, unknown>;
  /** Synchronous admission assertion for a NEW posting only. Throwing rolls
   * back the claimed key with this savepoint; old immutable receipts win first.
   * No transaction handle or async work is exposed through this narrow hook. */
  assertNew?: () => undefined;
}

export interface PostedEntry {
  id: bigint;
  txnId: string;
  accountId: string;
  delta: bigint;
  balanceAfter: bigint;
}

export interface PostedTransaction {
  transaction: { id: string; idempotencyKey: string; type: string; createdAt: Date };
  entries: PostedEntry[];
  /** true ⇒ this idempotency key was already posted; the original is returned. */
  duplicate: boolean;
}

export async function postTransaction(db: DbOrTx, input: PostTransactionInput): Promise<PostedTransaction> {
  const { idempotencyKey, type, entries, metadata } = input;

  if (!idempotencyKey) throw new InvalidTransactionError('idempotencyKey is required');
  if (entries.length < 2) throw new InvalidTransactionError('a transaction needs at least 2 entries');
  for (const e of entries) {
    if (typeof e.delta !== 'bigint') throw new InvalidTransactionError('entry deltas must be bigint');
    if (e.delta === 0n) throw new InvalidTransactionError('entry deltas must be non-zero');
  }

  // When `db` is already a transaction handle, drizzle's nested `.transaction`
  // opens a SAVEPOINT — so a caller can run several posts + row locks inside ONE
  // outer transaction (collect/cache/energy atomicity). The cast keeps the tx
  // body strongly typed (a `Db | DbTx` union collapses the callback param).
  return (db as Db).transaction(async (tx) => {
    // 1. Claim the idempotency key FIRST (before any account locks). A
    //    concurrent duplicate blocks here until the first post commits, then
    //    falls into the duplicate branch — and because nobody holds account
    //    locks before this insert, duplicate keys cannot deadlock.
    const inserted = await tx
      .insert(ledgerTransactions)
      .values({ idempotencyKey, type, metadata: metadata ?? {} })
      .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
      .returning();

    const txnRow = inserted[0];
    if (!txnRow) {
      // Duplicate — return the original transaction unchanged.
      const [original] = await tx
        .select()
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey));
      if (!original) {
        // Only possible if the competing transaction rolled back between our
        // insert and this select — surface loudly rather than retry silently.
        throw new LedgerError('ledger.idempotency_race', `idempotency key ${idempotencyKey} vanished mid-post; retry`);
      }
      const originalEntries = await tx
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.txnId, original.id))
        .orderBy(asc(ledgerEntries.id));
      return {
        transaction: original,
        entries: originalEntries,
        duplicate: true,
      };
    }

    input.assertNew?.();

    // 2. Lock every touched account in stable id order (deadlock-free).
    const accountIds = [...new Set(entries.map((e) => e.account))].sort();
    const lockedRows = await tx
      .select()
      .from(accounts)
      .where(inArray(accounts.id, accountIds))
      .orderBy(asc(accounts.id))
      .for('update');

    const byId = new Map(lockedRows.map((r) => [r.id, r]));
    for (const id of accountIds) {
      if (!byId.has(id)) throw new UnknownAccountError(id);
    }

    // Custody retirement is a definitive refusal even after KEEP balances
    // have drained to zero. Check after receipt replay and account locks but
    // before funds arithmetic; the SQL entry/cache guards also fence old
    // binaries. Custody escrows are also fenced so legacy rewards cannot
    // recreate a liability after F. Gems-only postings never take the latch.
    if (lockedRows.some((account) => (
      account.kind === 'player_keep' || account.kind === 'withdrawal_escrow'
      || account.kind === 'forge_payout_escrow' || account.kind === 'mail_keep_escrow'
      || account.kind === 'league_entitlement_escrow' || account.kind === 'forge_escrow'
      || account.kind === 'base_forge_escrow'
    ))) {
      await tx.execute(sql`select shardkeep_assert_keep_custody_post(
        ARRAY[${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)}], ${type})`);
    }

    // 3. Double-entry check: entries must sum to zero PER CURRENCY.
    const sums = new Map<string, bigint>();
    for (const e of entries) {
      const currency = byId.get(e.account)!.currency;
      sums.set(currency, (sums.get(currency) ?? 0n) + e.delta);
    }
    for (const [currency, sum] of sums) {
      if (sum !== 0n) throw new UnbalancedTransactionError(currency, sum);
    }

    // 3b. G-1 (D-152, GEMS-CURRENCY §3): Gems never become KEEP or SOL. Per-
    //     currency balance alone would still allow a four-entry posting that
    //     debits player_gems and credits player_keep; this closes it in the one
    //     place every caller must pass. Every specified Gems posting passes:
    //     spends credit gems_sink (GEMS), refunds mirror out of gems_sink,
    //     Gems → SHARDS credits SHARDS, and KEEP → Gems CREDITS player_gems.
    const debitsPlayerGems = entries.some((e) => e.delta < 0n && GEMS_PLAYER_KINDS.has(byId.get(e.account)!.kind));
    if (debitsPlayerGems && entries.some((e) => {
      const currency = byId.get(e.account)!.currency;
      return e.delta > 0n && (currency === 'KEEP' || currency === 'SOL');
    })) {
      throw new GemsOneWayError(idempotencyKey);
    }

    // 3c. G-3 (D-152): a Gems mint carries its KEEP backing in the same row —
    //     the third, non-bypassable guard behind the caller enumeration test.
    //     `gems_mint` may go negative (world account), so only this check keeps
    //     the outstanding Gems inside the KEEP that ever paid for them.
    const minted = entries.reduce((sum, e) => (e.delta < 0n && byId.get(e.account)!.kind === 'gems_mint' ? sum - e.delta : sum), 0n);
    if (minted > 0n) {
      const backing = entries.reduce((sum, e) => {
        const account = byId.get(e.account)!;
        return e.delta < 0n && account.currency === 'KEEP' && GEMS_BACKING_KINDS.has(account.kind) ? sum - e.delta : sum;
      }, 0n);
      if (backing * BigInt(GEMS.gemsPerKeep) !== minted) throw new GemsUnbackedMintError(idempotencyKey, minted, backing);
    }

    // 4. Apply entries in input order, computing balance_after sequentially
    //    (an account may appear in several entries of one transaction).
    const running = new Map(lockedRows.map((r) => [r.id, r.balance]));
    const computed = entries.map((e) => {
      const account = byId.get(e.account)!;
      const next = running.get(e.account)! + e.delta;
      if (next < 0n && !canGoNegative(account.kind)) {
        throw new InsufficientFundsError(e.account, running.get(e.account)!, e.delta);
      }
      running.set(e.account, next);
      return { txnId: txnRow.id, accountId: e.account, delta: e.delta, balanceAfter: next };
    });

    // 5. Persist entries + refresh the per-account balance cache.
    const persisted = await tx.insert(ledgerEntries).values(computed).returning();
    for (const id of accountIds) {
      await tx.update(accounts).set({ balance: running.get(id)! }).where(eq(accounts.id, id));
    }

    return { transaction: txnRow, entries: persisted, duplicate: false };
  });
}

/** Stable idempotency key for the one-time play-pool genesis mint. */
export const GENESIS_PLAY_POOL_KEY = 'genesis:play_pool';
/** Historical key used by the retired 50M quest allocation. */
export const GENESIS_QUEST_BUCKET_KEY = 'genesis:quest_bucket';
/** Stable key for the append-only consolidation into emission_pool. */
export const QUEST_BUCKET_RETIREMENT_KEY = 'economy:quest_bucket_retirement:v1';

/**
 * Ensures the system accounts exist and seeds the bounded gameplay reward pool:
 * a one-time genesis transaction moves TOKEN.allocation.playPool KEEP from
 * `keep_genesis` (→ −500M, a mint account that MAY go negative) into
 * `emission_pool` (→ +500M, NON-negative). After this, emission_pool's balance
 * IS the remaining lifetime mint, and the ledger's own FOR-UPDATE + non-negative
 * check is the hard cap — no over-mint race. Idempotent via GENESIS_PLAY_POOL_KEY
 * (a re-run returns the original, minting nothing). Call once at boot / test setup.
 */
export async function bootstrapPlayPool(db: DbOrTx): Promise<Record<SystemAccountKind, string>> {
  const sys = await bootstrapSystemAccounts(db);
  const amount = BigInt(TOKEN.allocation.playPool);
  await postTransaction(db, {
    idempotencyKey: GENESIS_PLAY_POOL_KEY,
    type: 'genesis.play_pool',
    entries: [
      { account: sys.keep_genesis, delta: -amount },
      { account: sys.emission_pool, delta: amount },
    ],
    metadata: { note: 'seed the bounded 500M gameplay allocation into emission_pool' },
  });
  return sys;
}

interface LedgerEntryShape {
  accountId: string;
  delta: bigint;
}

function assertExactEntries(
  actual: readonly LedgerEntryShape[],
  expected: readonly LedgerEntryShape[],
  code: string,
  label: string,
): void {
  const matches = actual.length === expected.length && expected.every((wanted) =>
    actual.some((entry) => entry.accountId === wanted.accountId && entry.delta === wanted.delta));
  if (!matches) throw new LedgerError(code, `${label} ledger entries do not match the audited allocation`);
}

async function assertQuestBucketCache(db: DbOrTx, accountId: string, cached: bigint): Promise<void> {
  const [row] = await db.select({
    total: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)::text`,
  }).from(ledgerEntries).where(eq(ledgerEntries.accountId, accountId));
  const ledgerBalance = BigInt(row?.total ?? '0');
  if (ledgerBalance !== cached) {
    throw new LedgerError(
      'ledger.quest_bucket_drift',
      `quest bucket cache ${cached} disagrees with append-only entries ${ledgerBalance}`,
    );
  }
}

/**
 * Permanently retires the obsolete quest KEEP allocation without rewriting
 * history. For legacy allocation A, remaining bucket B and previously issued
 * amount U=A-B and historical direct developer grants D, the compensating post is:
 *   quest_bucket -= B; emission_pool -= (U+D); keep_genesis += (A+D).
 * Player and escrow balances do not change. Fresh databases have no legacy
 * genesis post and activate the fence as a zero-value no-op.
 */
export async function retireQuestBucketAllocation(
  db: Db,
): Promise<{ activated: boolean; reconciliationTxnId: string | null }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('quest-bucket-retirement-v1', 0))`);
    const [state] = await tx.select().from(questBucketRetirementState)
      .where(eq(questBucketRetirementState.id, true)).for('update');
    if (!state) {
      throw new LedgerError('ledger.quest_retirement_state_missing', 'quest bucket retirement state is missing');
    }
    if (state.phase !== 'fenced' && state.phase !== 'ready') {
      throw new LedgerError(
        'ledger.quest_retirement_phase_invalid',
        `unknown quest bucket retirement phase ${state.phase}`,
      );
    }
    if (state.phase === 'fenced') {
      // Deployment drains API + worker first. These locks additionally wait out
      // any pre-fence ledger writer and prevent one from crossing the ready flip.
      // Ready-state restarts skip the locks: PostgreSQL already rejects old writers.
      await tx.execute(sql`lock table ledger_transactions, accounts, ledger_entries in access exclusive mode`);
    }

    const sys = await bootstrapSystemAccounts(tx);
    const [bucket] = await tx.select().from(accounts)
      .where(eq(accounts.id, sys.quest_bucket)).for('update');
    if (!bucket) throw new LedgerError('ledger.quest_bucket_missing', 'quest bucket account is missing');
    await assertQuestBucketCache(tx, bucket.id, bucket.balance);

    const [legacyGenesis] = await tx.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, GENESIS_QUEST_BUCKET_KEY));
    const legacyEntries = legacyGenesis
      ? await tx.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, legacyGenesis.id))
      : [];
    const allocation = BigInt(LEGACY_QUEST_KEEP_ALLOCATION);
    if (legacyGenesis) {
      if (legacyGenesis.type !== 'genesis.quest_bucket') {
        throw new LedgerError(
          'ledger.quest_genesis_mismatch',
          'historical quest allocation key has an unexpected transaction type',
        );
      }
      assertExactEntries(legacyEntries, [
        { accountId: sys.keep_genesis, delta: -allocation },
        { accountId: sys.quest_bucket, delta: allocation },
      ], 'ledger.quest_genesis_mismatch', 'historical quest genesis');
    }
    const [legacyGrantRow] = await tx.select({
      total: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)::text`,
    }).from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
      .where(and(
        eq(ledgerEntries.accountId, sys.keep_genesis),
        eq(ledgerTransactions.type, 'dev.grant'),
      ));
    const legacyGrantDelta = BigInt(legacyGrantRow?.total ?? '0');
    if (legacyGrantDelta > 0n) {
      throw new LedgerError(
        'ledger.legacy_dev_grant_mismatch',
        `historical developer grants have an unexpected net genesis credit ${legacyGrantDelta}`,
      );
    }
    const legacyDirectIssued = -legacyGrantDelta;
    const questAllocation = legacyGenesis ? allocation : 0n;
    const genesisRecovery = questAllocation + legacyDirectIssued;

    if (state.phase === 'ready') {
      if (bucket.balance !== 0n) {
        throw new LedgerError('ledger.quest_bucket_revived', 'retired quest bucket has a non-zero balance');
      }
      if (genesisRecovery === 0n) {
        if (state.reconciliationTxnId !== null) {
          throw new LedgerError(
            'ledger.quest_retirement_mismatch',
            'fresh retirement unexpectedly references a reconciliation transaction',
          );
        }
        return { activated: false, reconciliationTxnId: null };
      }
      if (!state.reconciliationTxnId) {
        throw new LedgerError(
          'ledger.quest_retirement_mismatch',
          'legacy quest allocation is ready without a reconciliation transaction',
        );
      }
      const [reconciliation] = await tx.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.id, state.reconciliationTxnId));
      const entries = reconciliation
        ? await tx.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, reconciliation.id))
        : [];
      if (!reconciliation
        || reconciliation.idempotencyKey !== QUEST_BUCKET_RETIREMENT_KEY
        || reconciliation.type !== 'economy.quest_bucket_retirement') {
        throw new LedgerError(
          'ledger.quest_retirement_mismatch',
          'retirement state references an unexpected reconciliation transaction',
        );
      }
      const genesisCredit = entries.filter((entry) =>
        entry.accountId === sys.keep_genesis && entry.delta === genesisRecovery);
      const bucketDebit = entries.find((entry) => entry.accountId === sys.quest_bucket)?.delta ?? 0n;
      const poolDebit = entries.find((entry) => entry.accountId === sys.emission_pool)?.delta ?? 0n;
      const expectedLength = 1 + Number(bucketDebit !== 0n) + Number(poolDebit !== 0n);
      if (genesisCredit.length !== 1
        || entries.length !== expectedLength
        || bucketDebit > 0n
        || poolDebit > 0n
        || -bucketDebit + -poolDebit !== genesisRecovery) {
        throw new LedgerError(
          'ledger.quest_retirement_mismatch',
          'reconciliation transaction does not consolidate the historical allocation exactly',
        );
      }
      return { activated: false, reconciliationTxnId: reconciliation.id };
    }
    if (!legacyGenesis && legacyDirectIssued === 0n) {
      if (bucket.balance !== 0n) {
        throw new LedgerError(
          'ledger.quest_genesis_missing',
          'quest bucket has value but no audited historical genesis transaction',
        );
      }
      const [updated] = await tx.update(questBucketRetirementState).set({
        phase: 'ready', readyAt: new Date(), reconciliationTxnId: null,
      }).where(and(
        eq(questBucketRetirementState.id, true),
        eq(questBucketRetirementState.phase, 'fenced'),
      )).returning({ phase: questBucketRetirementState.phase });
      if (!updated) throw new LedgerError('ledger.quest_retirement_raced', 'quest retirement changed concurrently');
      return { activated: true, reconciliationTxnId: null };
    }

    if (!legacyGenesis && bucket.balance !== 0n) {
      throw new LedgerError(
        'ledger.quest_genesis_missing',
        'quest bucket has value but no audited historical genesis transaction',
      );
    }
    if (bucket.balance < 0n || bucket.balance > questAllocation) {
      throw new LedgerError(
        'ledger.quest_bucket_out_of_range',
        `legacy quest bucket balance ${bucket.balance} is outside 0..${questAllocation}`,
      );
    }
    const previouslyIssued = questAllocation - bucket.balance;
    const poolCharge = previouslyIssued + legacyDirectIssued;
    const expectedEntries: EntryInput[] = [
      ...(bucket.balance > 0n ? [{ account: sys.quest_bucket, delta: -bucket.balance }] : []),
      ...(poolCharge > 0n ? [{ account: sys.emission_pool, delta: -poolCharge }] : []),
      { account: sys.keep_genesis, delta: genesisRecovery },
    ];

    const [prior] = await tx.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, QUEST_BUCKET_RETIREMENT_KEY));
    const posted = prior
      ? {
        transaction: prior,
        entries: await tx.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, prior.id)),
        duplicate: true,
      }
      : await postTransaction(tx, {
        idempotencyKey: QUEST_BUCKET_RETIREMENT_KEY,
        type: 'economy.quest_bucket_retirement',
        entries: expectedEntries,
        metadata: {
          legacyQuestAllocation: questAllocation.toString(),
          remainingBucket: bucket.balance.toString(),
          questPreviouslyIssued: previouslyIssued.toString(),
          legacyDirectIssued: legacyDirectIssued.toString(),
        },
      });
    if (posted.transaction.type !== 'economy.quest_bucket_retirement') {
      throw new LedgerError(
        'ledger.quest_retirement_mismatch',
        'retirement idempotency key has an unexpected transaction type',
      );
    }
    assertExactEntries(
      posted.entries,
      expectedEntries.map((entry) => ({ accountId: entry.account, delta: entry.delta })),
      'ledger.quest_retirement_mismatch',
      'quest retirement',
    );

    const [updated] = await tx.update(questBucketRetirementState).set({
      phase: 'ready', readyAt: new Date(), reconciliationTxnId: posted.transaction.id,
    }).where(and(
      eq(questBucketRetirementState.id, true),
      eq(questBucketRetirementState.phase, 'fenced'),
    )).returning({ phase: questBucketRetirementState.phase });
    if (!updated) throw new LedgerError('ledger.quest_retirement_raced', 'quest retirement changed concurrently');
    return { activated: true, reconciliationTxnId: posted.transaction.id };
  });
}

/** Boot-time finite-pool initialization and one-way legacy consolidation. */
export async function bootstrapEconomyAllocations(
  db: Db,
): Promise<Record<SystemAccountKind, string>> {
  const sys = await bootstrapPlayPool(db);
  await retireQuestBucketAllocation(db);
  return sys;
}
