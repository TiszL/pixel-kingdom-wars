/**
 * Deed-owned SHARDS primitives and the one-time wallet -> deed cutover.
 *
 * KEEP/SOL remain wallet-owned. Gameplay SHARDS are keyed by stable base id, so
 * selling a deed transfers its spendable balance without rewriting ledger
 * ownership. Legacy balances move only through the append-only ledger; the SQL
 * migration merely prepares a durable work row and startup remains gated until
 * every prepared row is complete.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import {
  accounts, baseEconomyBackfills, deedEconomyCutoverState, ledgerEntries, ledgerTransactions,
} from '../db/schema';
import {
  bootstrapSystemAccounts, getOrCreateBaseAccount,
} from '../ledger/accounts';
import { postTransaction, type PostedTransaction } from '../ledger/ledger';

export const BASE_ECONOMY_CUTOVER_KEY_PREFIX = 'base-economy-cutover:';
export const BASE_FORGE_CUTOVER_KEY_PREFIX = 'base-economy-cutover-forge:';

export class BaseEconomyCutoverError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BaseEconomyCutoverError';
  }
}

export async function getBaseShardBalance(db: DbOrTx, baseId: string): Promise<bigint> {
  return (await getOrCreateBaseAccount(db, baseId, 'base_shards')).balance;
}

/** Mint Mine/reward SHARDS into the selected deed, never into its wallet. */
export async function rewardBaseShards(
  db: DbOrTx,
  baseId: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
): Promise<PostedTransaction> {
  if (amount <= 0n) throw new RangeError(`rewardBaseShards: amount must be positive, got ${amount}`);
  const sys = await bootstrapSystemAccounts(db);
  const base = await getOrCreateBaseAccount(db, baseId, 'base_shards');
  return postTransaction(db, {
    idempotencyKey,
    type,
    entries: [
      { account: sys.shard_genesis, delta: -amount },
      { account: base.id, delta: amount },
    ],
    metadata: { baseId, ...metadata },
  });
}

/** Burn a deed's gameplay SHARDS. The ledger enforces non-negative balances. */
export async function spendBaseShards(
  db: DbOrTx,
  baseId: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
  options: { progressQuests?: boolean } = {},
): Promise<PostedTransaction> {
  if (amount <= 0n) throw new RangeError(`spendBaseShards: amount must be positive, got ${amount}`);
  const sys = await bootstrapSystemAccounts(db);
  const base = await getOrCreateBaseAccount(db, baseId, 'base_shards');
  const posted = await postTransaction(db, {
    idempotencyKey,
    type,
    entries: [
      { account: base.id, delta: -amount },
      { account: sys.shard_burn, delta: amount },
    ],
    metadata: { baseId, ...metadata },
  });
  if (!posted.duplicate && options.progressQuests !== false) {
    // Dynamic import avoids the reward-side quests.ts → baseEconomy.ts cycle.
    // The spend quests count SHARD spends only (K-023 fixed, M23 a15).
    const { progressQuestBatch } = await import('./quests');
    await progressQuestBatch(db, '', [
      ['spend_200', Number(amount)],
      ['spend_500', Number(amount)],
    ], new Date(), baseId);
  }
  return posted;
}

function cutoverKey(wallet: string): string {
  return `${BASE_ECONOMY_CUTOVER_KEY_PREFIX}${wallet}`;
}

/**
 * Complete one prepared legacy balance move. The outer transaction makes the
 * ledger post and readiness flag indivisible. A crash after the nested ledger
 * post but before the flag cannot commit either; a retry of an already-posted
 * idempotency key validates and adopts that exact transaction.
 */
export async function completeBaseEconomyBackfill(
  db: Db,
  legacyWallet: string,
): Promise<{ baseId: string; amount: bigint; transactionId: string | null }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(baseEconomyBackfills)
      .where(eq(baseEconomyBackfills.legacyWallet, legacyWallet)).for('update');
    if (!row) {
      throw new BaseEconomyCutoverError(
        'base_economy.backfill_missing',
        `no prepared deed-economy backfill exists for ${legacyWallet}`,
      );
    }
    if (row.ledgerStatus === 'complete') {
      return {
        baseId: row.primaryBaseId,
        amount: row.legacyShardBalance,
        transactionId: row.ledgerTransferTxnId,
      };
    }
    if (row.ledgerStatus === 'failed') {
      throw new BaseEconomyCutoverError(
        'base_economy.backfill_failed',
        `deed-economy backfill for ${legacyWallet} requires operator recovery`,
      );
    }

    // The DB trigger accepts this exact transaction-local marker only for a
    // prepared, incomplete source row and never after activation. Keeping it
    // here makes the sole wallet-SHARDS debit explicit and auditable.
    await tx.execute(sql`
      select set_config('shardkeep.deed_economy_cutover', 'ledger-backfill', true)
    `);

    const destination = await getOrCreateBaseAccount(tx, row.primaryBaseId, 'base_shards');
    const forgeDestination = await getOrCreateBaseAccount(tx, row.primaryBaseId, 'base_forge_escrow');
    if (destination.id !== row.destinationShardAccountId) {
      throw new BaseEconomyCutoverError(
        'base_economy.destination_mismatch',
        `prepared destination for ${legacyWallet} is not the primary deed account`,
      );
    }
    if (forgeDestination.id !== row.destinationForgeEscrowAccountId) {
      throw new BaseEconomyCutoverError(
        'base_economy.forge_destination_mismatch',
        `prepared Forge destination for ${legacyWallet} is not the primary deed account`,
      );
    }

    if (row.legacyShardBalance > 0n && !row.sourceShardAccountId) {
      throw new BaseEconomyCutoverError(
        'base_economy.source_missing',
        `positive legacy balance for ${legacyWallet} has no source account`,
      );
    }

    await tx.update(baseEconomyBackfills).set({ ledgerStatus: 'posting' })
      .where(eq(baseEconomyBackfills.legacyWallet, legacyWallet));

    let shardTransferTxnId: string | null = null;
    if (row.legacyShardBalance > 0n) {
      const key = cutoverKey(legacyWallet);
      const [prior] = await tx.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, key));
      let posted: PostedTransaction;
      if (prior) {
        const entries = await tx.select().from(ledgerEntries)
          .where(eq(ledgerEntries.txnId, prior.id));
        posted = { transaction: prior, entries, duplicate: true };
      } else {
        const [source] = await tx.select().from(accounts)
          .where(and(
            eq(accounts.id, row.sourceShardAccountId!),
            eq(accounts.kind, 'player_shards'),
          )).for('update');
        if (!source || source.ownerWallet !== legacyWallet) {
          throw new BaseEconomyCutoverError(
            'base_economy.source_mismatch',
            `prepared source for ${legacyWallet} is not its legacy SHARDS account`,
          );
        }
        if (source.balance !== row.legacyShardBalance) {
          throw new BaseEconomyCutoverError(
            'base_economy.source_changed',
            `legacy SHARDS changed after preparation for ${legacyWallet}`,
          );
        }
        posted = await postTransaction(tx, {
          idempotencyKey: key,
          type: 'base_economy.cutover',
          entries: [
            { account: source.id, delta: -row.legacyShardBalance },
            { account: destination.id, delta: row.legacyShardBalance },
          ],
          metadata: { legacyWallet, primaryBaseId: row.primaryBaseId },
        });
      }

      const sourceDebit = posted.entries.find((entry) =>
        entry.accountId === row.sourceShardAccountId && entry.delta === -row.legacyShardBalance);
      const destinationCredit = posted.entries.find((entry) =>
        entry.accountId === destination.id && entry.delta === row.legacyShardBalance);
      if (!sourceDebit || !destinationCredit || posted.entries.length !== 2) {
        throw new BaseEconomyCutoverError(
          'base_economy.transaction_mismatch',
          `idempotency transaction ${key} does not match the prepared cutover`,
        );
      }
      shardTransferTxnId = posted.transaction.id;
    }

    let forgeTransferTxnId: string | null = null;
    if (row.legacyForgeEscrowShards > 0n) {
      const key = `${BASE_FORGE_CUTOVER_KEY_PREFIX}${legacyWallet}`;
      const [source] = await tx.select().from(accounts).where(and(
        eq(accounts.id, row.sourceForgeEscrowAccountId),
        eq(accounts.kind, 'forge_escrow'),
      )).for('update');
      if (!source || source.ownerWallet !== null || source.baseId !== null) {
        throw new BaseEconomyCutoverError(
          'base_economy.forge_source_mismatch',
          `prepared Forge source for ${legacyWallet} is not the system escrow`,
        );
      }
      const [prior] = await tx.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, key));
      const posted = prior
        ? {
          transaction: prior,
          entries: await tx.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, prior.id)),
          duplicate: true,
        }
        : await postTransaction(tx, {
          idempotencyKey: key,
          type: 'base_economy.forge_cutover',
          entries: [
            { account: source.id, delta: -row.legacyForgeEscrowShards },
            { account: forgeDestination.id, delta: row.legacyForgeEscrowShards },
          ],
          metadata: { legacyWallet, primaryBaseId: row.primaryBaseId },
        });
      const sourceDebit = posted.entries.find((entry) =>
        entry.accountId === source.id && entry.delta === -row.legacyForgeEscrowShards);
      const destinationCredit = posted.entries.find((entry) =>
        entry.accountId === forgeDestination.id && entry.delta === row.legacyForgeEscrowShards);
      if (!sourceDebit || !destinationCredit || posted.entries.length !== 2) {
        throw new BaseEconomyCutoverError(
          'base_economy.forge_transaction_mismatch',
          `idempotency transaction ${key} does not match the prepared Forge cutover`,
        );
      }
      forgeTransferTxnId = posted.transaction.id;
    }

    await tx.update(baseEconomyBackfills).set({
      ledgerStatus: 'complete',
      ledgerTransferTxnId: shardTransferTxnId,
      forgeLedgerTransferTxnId: forgeTransferTxnId,
      completedAt: new Date(),
    }).where(eq(baseEconomyBackfills.legacyWallet, legacyWallet));
    return {
      baseId: row.primaryBaseId,
      amount: row.legacyShardBalance,
      transactionId: shardTransferTxnId,
    };
  });
}

/** Boot gate: never serve a half wallet-owned/half deed-owned economy. */
export async function completePendingBaseEconomyBackfills(db: Db): Promise<number> {
  const pending = await db.select({
    wallet: baseEconomyBackfills.legacyWallet,
    status: baseEconomyBackfills.ledgerStatus,
  })
    .from(baseEconomyBackfills)
    .where(ne(baseEconomyBackfills.ledgerStatus, 'complete'));
  for (const row of pending) {
    if (row.status === 'failed') {
      throw new BaseEconomyCutoverError(
        'base_economy.backfill_failed',
        `deed-economy backfill for ${row.wallet} requires operator recovery`,
      );
    }
    await completeBaseEconomyBackfill(db, row.wallet);
  }
  const incomplete = await db.select({ wallet: baseEconomyBackfills.legacyWallet })
    .from(baseEconomyBackfills)
    .where(ne(baseEconomyBackfills.ledgerStatus, 'complete'));
  if (incomplete.length > 0) {
    throw new BaseEconomyCutoverError(
      'base_economy.incomplete',
      `${incomplete.length} deed-economy backfill(s) remain incomplete`,
    );
  }
  return pending.length;
}

export type DeedEconomyCutoverPhase = 'fenced' | 'ready';

/**
 * One-way runtime activation. Migration 0077 installs the rollback fence in a
 * dormant `fenced` phase so a fresh local/legacy database can still boot with
 * MULTI_BASE disabled. Production calls this after the ledger backfill and only
 * with the feature enabled; PostgreSQL re-checks every readiness condition
 * under the singleton row lock before accepting `fenced -> ready`.
 *
 * Once ready, flag-off startup is forbidden: starting an older ownership model
 * against a deed-owned economy is a rollback attempt, not a supported mode.
 */
export async function activateDeedEconomyCutover(
  db: Db,
  multiBase: boolean,
): Promise<{ phase: DeedEconomyCutoverPhase; activated: boolean }> {
  return db.transaction(async (tx) => {
    const [state] = await tx.select().from(deedEconomyCutoverState)
      .where(eq(deedEconomyCutoverState.id, true)).for('update');
    if (!state) {
      throw new BaseEconomyCutoverError(
        'base_economy.cutover_state_missing',
        'deed-economy cutover state is missing',
      );
    }
    if (state.phase === 'ready') {
      if (!multiBase) {
        throw new BaseEconomyCutoverError(
          'base_economy.rollback_forbidden',
          'deed economy is permanently active; MULTI_BASE_ENABLED=false is forbidden',
        );
      }
      return { phase: 'ready', activated: false };
    }
    if (state.phase !== 'fenced') {
      throw new BaseEconomyCutoverError(
        'base_economy.cutover_phase_invalid',
        `unknown deed-economy cutover phase ${state.phase}`,
      );
    }
    if (!multiBase) return { phase: 'fenced', activated: false };

    // Serialize activation itself across processes without first upgrading the
    // singleton row lock. The DB trigger then waits out every legacy DML writer
    // with a fixed-order ACCESS EXCLUSIVE lock set before validating and flipping ready.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('deed-economy-activation', 0))`);
    const [updated] = await tx.update(deedEconomyCutoverState).set({
      phase: 'ready', readyAt: new Date(),
    }).where(and(
      eq(deedEconomyCutoverState.id, true),
      eq(deedEconomyCutoverState.phase, 'fenced'),
    )).returning({ phase: deedEconomyCutoverState.phase });
    if (!updated) {
      throw new BaseEconomyCutoverError(
        'base_economy.cutover_raced',
        'deed-economy activation changed concurrently',
      );
    }
    return { phase: 'ready', activated: true };
  });
}

/** App-factory/worker readiness without performing the irreversible transition. */
export async function assertDeedEconomyCutoverReady(
  db: Db,
  multiBase: boolean,
): Promise<void> {
  const [state] = await db.select({ phase: deedEconomyCutoverState.phase })
    .from(deedEconomyCutoverState).where(eq(deedEconomyCutoverState.id, true));
  if (!state) {
    throw new BaseEconomyCutoverError(
      'base_economy.cutover_state_missing',
      'deed-economy cutover state is missing',
    );
  }
  if (state.phase === 'ready' && !multiBase) {
    throw new BaseEconomyCutoverError(
      'base_economy.rollback_forbidden',
      'deed economy is permanently active; MULTI_BASE_ENABLED=false is forbidden',
    );
  }
  if (multiBase && state.phase !== 'ready') {
    throw new BaseEconomyCutoverError(
      'base_economy.cutover_not_ready',
      'deed economy has not completed its one-way activation',
    );
  }
}
