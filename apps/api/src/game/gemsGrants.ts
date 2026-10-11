/**
 * Gems grants (D-152 same-day amendment; E2-GEMS-CONTRACT §1.2, §1.3).
 *
 * Gems have exactly three sources: KEEP conversion (gems.ts), the custody
 * retirement (E3 tool) and GRANTS — owner-authored one-time tasks, the devnet
 * welcome aid, historical refunds and the dev-login convenience. A grant is
 * never an unbacked mint: every grant debits KEEP from `gems_reward_budget`
 * (funded from the recycled leg of mined KEEP; on devnet from `emission_pool`
 * by a journaled operator posting) and recycles it to `emission_pool` in the
 * same transaction as the Gems credit, so invariant G-3 holds row by row and
 * no supply beyond the daily ceiling is created. An exhausted budget fails
 * closed (GEMS_BUDGET_EXHAUSTED); a task is claimable once per wallet, forever.
 */
import { GEMS_TASKS, PLAYTEST, type GemsTaskSpec } from '@shardkeep/shared';
import { and, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, players } from '../db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../ledger/accounts';
import { InsufficientFundsError, postTransaction, type PostedTransaction } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { GemsTaskExpectedSchema, assertGemsTerms, assertSameGemsExpected, type GemsTaskExpected } from './gemsConsent';

export type GemsGrantReason = 'task' | 'welcome' | 'refund' | 'dev';

export function grantKey(reason: GemsGrantReason, wallet: string, ref?: string): string {
  switch (reason) {
    case 'task': return `grant:task:${ref}:${wallet}`;
    case 'welcome': return `grant:welcome:${wallet}`;
    case 'refund': return `grant:refund:${ref}`;
    case 'dev': return `grant:dev:${wallet}`;
  }
}

/** Mint Gems against KEEP taken from the reward budget (G-3 backing in one row). */
export async function grantGems(
  db: DbOrTx,
  input: { wallet: string; gems: bigint; reason: GemsGrantReason; ref?: string; metadata?: Record<string, unknown>; assertNew?: () => undefined },
): Promise<PostedTransaction> {
  if (input.gems <= 0n) throw new RangeError(`grantGems: amount must be positive, got ${input.gems}`);
  const sys = await bootstrapSystemAccounts(db);
  const player = await getOrCreatePlayerAccount(db, input.wallet, 'player_gems');
  try {
    return await postTransaction(db, {
      idempotencyKey: grantKey(input.reason, input.wallet, input.ref),
      type: 'gems.grant',
      ...(input.assertNew ? { assertNew: input.assertNew } : {}),
      entries: [
        { account: sys.gems_reward_budget, delta: -input.gems }, // KEEP backing (recycled-leg budget)
        { account: sys.emission_pool, delta: input.gems },
        { account: sys.gems_mint, delta: -input.gems },
        { account: player.id, delta: input.gems },
      ],
      metadata: { wallet: input.wallet, reason: input.reason, ...(input.ref ? { ref: input.ref } : {}), gems: input.gems.toString(), ...input.metadata },
    });
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw new HttpError(503, 'the Gems reward budget is exhausted; try again later', 'GEMS_BUDGET_EXHAUSTED');
    }
    throw error;
  }
}

/** Operator/dev funding of the reward budget from the emission pool (journaled;
 *  capped per day by GEMS_REWARD_BUDGET.recycledLegShareBps of the previous
 *  day's recycled KEEP once mining exists — the cap is enforced by the operator
 *  tool that calls this, never silently here). */
export async function fundGemsRewardBudget(
  db: DbOrTx, keep: bigint, idempotencyKey: string, metadata?: Record<string, unknown>,
): Promise<PostedTransaction> {
  if (keep <= 0n) throw new RangeError('fundGemsRewardBudget: amount must be positive');
  const sys = await bootstrapSystemAccounts(db);
  return postTransaction(db, {
    idempotencyKey: `gems:budget:fund:${idempotencyKey}`,
    type: 'gems.budget.fund',
    entries: [
      { account: sys.emission_pool, delta: -keep },
      { account: sys.gems_reward_budget, delta: keep },
    ],
    metadata: { keep: keep.toString(), ...metadata },
  });
}

const TASKS: Readonly<Record<string, GemsTaskSpec>> = GEMS_TASKS;

export function activeGemsTasks(): Array<{ id: string; gems: number; title: string }> {
  return Object.entries(TASKS)
    .filter(([, spec]) => spec.active)
    .map(([id, spec]) => ({ id, gems: spec.gems, title: spec.title }));
}

/** Claim an owner-authored one-time task. Once per wallet per task: a repeat with
 *  the same client key returns the original grant; a different client key for an
 *  already-claimed task is refused (CLAIM_ALREADY_SETTLED, resolves to the receipt). */
export async function claimGemsTask(db: DbOrTx, wallet: string, taskId: string, idempotencyKey: string, expected?: GemsTaskExpected) {
  expected = parse(GemsTaskExpectedSchema.optional(), expected);
  return (db as Db).transaction(async (tx) => {
    // Serialize this wallet's task claims before consulting a mutable catalogue.
    // The immutable one-task key and postTransaction's winner hook are still the
    // final protection against concurrent callers and alternate grant paths.
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const original = await taskResult(tx, wallet, taskId, idempotencyKey, expected, true);
    if (original) return original;
    const spec = TASKS[taskId];
    if (!spec || !spec.active) throw new HttpError(404, 'unknown or inactive task', 'TASK_UNKNOWN');
    const gems = BigInt(spec.gems);
    const posted = await grantGems(tx, { wallet, gems, reason: 'task', ref: taskId,
      metadata: { idempotencyKey, ...(expected ? { expected } : {}) },
      assertNew: () => assertGemsTerms(expected, null, gems.toString()) });
    const accepted = await taskResult(tx, wallet, taskId, idempotencyKey, expected, posted.duplicate);
    if (!accepted) throw new Error('Gems task posting could not be proved');
    return accepted;
  });
}

/** Devnet welcome aid as Gems (replaces the KEEP mail attachment when enabled). */
export async function grantWelcomeGems(db: DbOrTx, wallet: string): Promise<PostedTransaction> {
  return grantGems(db, { wallet, gems: BigInt(PLAYTEST.welcomeGems), reason: 'welcome' });
}

/** Historical evidence for `GET /gems/tasks/:taskId/claim/by-key/:key`: the
 *  grant row for (task, wallet) whose stored client key is `key`, with its
 *  four-entry backing verified. Anything else is `unknown` (200, never 404). */
export async function getGemsTaskClaimReceipt(db: DbOrTx, wallet: string, taskId: string, key: string) {
  const unknown = { version: 1, status: 'unknown', idempotencyKey: key } as const;
  const [txn] = await db.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, grantKey('task', wallet, taskId)));
  if (!txn || txn.type !== 'gems.grant') return unknown;
  const parsed = z.object({ wallet: z.string(), reason: z.literal('task'), ref: z.string(),
    gems: z.string().max(32).regex(/^[1-9][0-9]*$/), idempotencyKey: z.string(),
    expected: GemsTaskExpectedSchema.optional() }).safeParse(txn.metadata);
  if (!parsed.success) return unknown;
  const meta = parsed.data;
  if (meta.wallet !== wallet || meta.ref !== taskId || meta.idempotencyKey !== key
    || (meta.expected && meta.expected.output !== meta.gems)) return unknown;
  const gems = BigInt(meta.gems);
  const entries = await db.select({ delta: ledgerEntries.delta, kind: accounts.kind, currency: accounts.currency, ownerWallet: accounts.ownerWallet, baseId: accounts.baseId })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  const has = (kind: string, currency: string, delta: bigint, owner: string | null) =>
    entries.some((e) => e.kind === kind && e.currency === currency && e.delta === delta && e.ownerWallet === owner && e.baseId === null);
  if (entries.length !== 4 || !has('gems_reward_budget', 'KEEP', -gems, null) || !has('emission_pool', 'KEEP', gems, null)
    || !has('gems_mint', 'GEMS', -gems, null) || !has('player_gems', 'GEMS', gems, wallet)) return unknown;
  return {
    version: 1 as const, status: 'accepted' as const, wallet, taskId, receiptId: txn.id,
    acceptedAt: txn.createdAt.toISOString(), request: { idempotencyKey: key, taskId, ...(meta.expected ? { expected: meta.expected } : {}) },
    result: { gems: meta.gems },
  };
}

async function taskResult(db: DbOrTx, wallet: string, taskId: string, key: string, expected: GemsTaskExpected | undefined, duplicate: boolean) {
  const [original] = await db.select({ id: ledgerTransactions.id, metadata: ledgerTransactions.metadata }).from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, grantKey('task', wallet, taskId)));
  if (!original) return null;
  const originalKey = (original.metadata as { idempotencyKey?: unknown } | null)?.idempotencyKey;
  if (typeof originalKey !== 'string') throw new Error('Gems task posting is missing original command identity');
  const receipt = await getGemsTaskClaimReceipt(db, wallet, taskId, originalKey);
  if (receipt.status !== 'accepted') throw new Error('Gems task posting could not be proved');
  if (originalKey !== key) throw new HttpError(409, 'task already claimed by this wallet', 'CLAIM_ALREADY_SETTLED', { receiptId: original.id });
  assertSameGemsExpected(receipt.request.expected, expected);
  const gems = Number(receipt.result.gems);
  if (!Number.isSafeInteger(gems)) throw new Error('Gems task reward is outside the original numeric contract');
  return { taskId, gems, receiptId: receipt.receiptId, duplicate };
}

/** `GET /gems/tasks` view: catalogue rows with the wallet's claimed state. */
export async function listGemsTasks(db: DbOrTx, wallet: string) {
  const tasks = activeGemsTasks();
  if (tasks.length === 0) return [] as Array<{ id: string; gems: number; title: string; claimed: boolean }>;
  const rows = await db.select({ key: ledgerTransactions.idempotencyKey }).from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.type, 'gems.grant'), like(ledgerTransactions.idempotencyKey, `grant:task:%:${wallet}`)));
  const claimed = new Set(rows.map((r) => r.key));
  return tasks.map((task) => ({ ...task, claimed: claimed.has(grantKey('task', wallet, task.id)) }));
}
