/**
 * KEEP withdrawals (PLAN.md 4g — GDD §4.9, ARCHITECTURE §5).
 *
 * State machine: unbonding (24h, funds frozen in withdrawal_escrow,
 * cancellable, raid-protected because they left the play balance) →
 * processing → sent | failed → refunded. 2% fee burned at payout; the net
 * amount leaves custody to the chain (onchain_outflow world account). The hot
 * wallet signs once; signature, exact wire bytes, blockhash horizon and decoded
 * transfer are persisted before broadcast, then reconciled at finalized.
 *
 * Protections (defense in depth, research §3):
 * - per-player daily cap, scaled by Keep level, over requests in the last 24h
 * - 24h cooldown: at most one non-failed withdrawal per rolling day
 * - escrow at REQUEST time: a player cannot spend funds queued to leave
 * - payout worker re-verifies state transitions row-by-row
 * - RESERVE GATE at payout: no KEEP leaves custody unless the hot wallet
 *   demonstrably still covers the ledger's liability (see `makeCoverageGate`)
 */
import { ECONOMY, fmtDur, withdrawDailyCapForKeepLevel } from '@shardkeep/shared';
import {
  validatePreparedKeepWithdrawal,
  type KeepTransferSender,
  type KeepWithdrawalSnapshot,
  type PreparedKeepWithdrawal,
} from '@shardkeep/chain';
import { PublicKey } from '@solana/web3.js';
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import {
  ledgerTransactions, players, withdrawalAttempts, withdrawalAuthorizations,
  withdrawalPayoutReservations, withdrawals,
} from '../db/schema';
import { assertTotpRecoveryAllowsTx } from '../auth/totpRecoveryPolicy';
import { multiBaseEnabled } from '../config';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../ledger/accounts';
import { postTransaction, type PostedTransaction, type PostTransactionInput } from '../ledger/ledger';
import { errorForStorage, HttpError } from '../lib/errors';
import { assertFreshLockedActiveBaseAuthorities } from '../game/baseOwnership';
import { checkReserves, type ReserveReader } from './snapshot';
import type {
  WithdrawalAuthorizationGate, WithdrawalAuthorizationProof,
} from './withdrawalAuthorization';
import { lockWithdrawalGlobalTx, lockWithdrawalWalletTx } from './withdrawalLock';

export type { KeepTransferSender } from '@shardkeep/chain';

/**
 * Statuses whose escrow was RETURNED to the player, so the request consumed
 * nothing: it must not eat the rolling-24h cap nor start the cooldown. A
 * `refunded` row is economically identical to a `cancelled` one — the gross went
 * straight back to player_keep and nothing ever left custody — and the failure
 * that produced it was OURS (RPC down, hot ATA short), so charging the player a
 * day for it would be a penalty for our outage.
 */
const UNCHARGED_STATUSES: Array<typeof withdrawals.$inferSelect.status> = ['cancelled', 'refunded'];

// ---------------------------------------------------------------------------
// Reserve gate (ARCHITECTURE §5 "invariant monitor halts the queue on
// divergence" — AUDIT-FIX-PLAN B1)
// ---------------------------------------------------------------------------

/** Why a payout was refused before it ran. `ok:false` ALWAYS halts. */
type CoverageVerdict = { ok: true } | { ok: false; reason: string };

/** A fresh coverage verification performed immediately before one payout. */
export type CoverageGate = () => Promise<CoverageVerdict>;

/**
 * THE payout brake. Until now `checkReserves` was monitor-only: /por published
 * coverage and the weekly job logged `[POR-SHORTFALL]`, but nothing consulted it
 * before paying, so an under-reserved custody kept paying first-come-first-served
 * until the hot ATA ran dry. Historical `keep_vend` intents may still credit
 * withdrawable player_keep for SOL without moving reserve KEEP into the hot
 * wallet; new intents are disabled at creation until reserve funding exists.
 *
 * Uses `checkReserves` VERBATIM, so the gate's liability definition is the same
 * object /por publishes (player KEEP plus withdrawal, Forge-payout and league-entitlement escrows)
 * — they cannot drift into disagreeing.
 *
 * FAILS CLOSED on all three unknowns: no reader configured, the RPC read throws,
 * or coverage is short. A transient RPC failure therefore HOLDS payouts rather
 * than silently unblocking them (the queue retries on the next worker cycle).
 *
 * NEVER memoized across rows. Although one payout improves coverage by its fee,
 * the public API can concurrently create new liabilities between sequential
 * sends. Reusing one positive verdict therefore turns the worker into a stale-
 * PoR drain. Every row re-reads reserve + the current ledger liability directly
 * before its claim/send; a negative verdict leaves that row unbonding.
 */
export function makeCoverageGate(db: Db, readReserve: ReserveReader | null | undefined): CoverageGate {
  return async (): Promise<CoverageVerdict> => {
    // OPERATOR OVERRIDE. The gate is all-or-nothing and fails closed on three
    // separate unknowns, so a false negative — a mis-set reserve owner list, an
    // RPC that is down for hours — is a TOTAL withdrawal outage with no way out
    // for a solo operator except a code deploy (money review 2026-07-29 #2).
    // This is the documented escape hatch: loud, deliberate, and logged every
    // single time so it can never quietly become the normal state.
    if (process.env['PAYOUT_COVERAGE_OVERRIDE'] === 'true') {
      console.warn(
        '[PAYOUT-COVERAGE-OVERRIDE] the solvency brake is DISABLED by env. Payouts proceed WITHOUT ' +
        'proving custody covers liabilities. Unset PAYOUT_COVERAGE_OVERRIDE as soon as the reserve ' +
        'reader is correct.',
      );
      return { ok: true };
    }
    if (!readReserve) {
      return { ok: false, reason: 'no reserve reader configured — coverage cannot be proven (set HOT_WALLET_KEYPAIR_PATH and publish infra addresses)' };
    }
    let check;
    try {
      check = await checkReserves(db, readReserve);
    } catch (e) {
      return { ok: false, reason: `reserve read FAILED, coverage UNKNOWN: ${errorForStorage(e, 200)}` };
    }
    if (!check.covered) {
      return {
        ok: false,
        reason: `UNDER-RESERVED: eligible liquid hot custody holds ${check.reserveKeep} KEEP against ${check.liabilityKeep} KEEP of liabilities (deficit ${check.deficit}). Top up the canonical custody ATA or hold payouts; LP and generic treasury balances are not withdrawal-ready reserves`,
      };
    }
    return { ok: true };
  };
}

export interface WithdrawalRequestOpts {
  now?: Date;
  /** Skip the unbonding delay. Production callers pair this with `authorize` so
   * the player's 2FA is consumed atomically with the escrow freeze. */
  instant?: boolean;
  /** On-chain KEEP sender. When present alongside `instant`, the payout settles
   *  synchronously in this call (no worker needed), returning a 'sent'/'failed'
   *  row instead of a queued 'unbonding' one. */
  send?: KeepTransferSender;
  /** Live hot-ATA reserve reader for the instant path's coverage gate. Absent →
   *  the gate fails closed and the row stays queued as 'unbonding' (the payout
   *  worker retries it once coverage can be proven) — the instant path must not
   *  be the hole in the brake that gates the worker. */
  readReserve?: ReserveReader | null;
  /**
   * Optional authorization consumed INSIDE the same transaction that freezes
   * escrow. It deliberately runs only after every amount/destination/cooldown/
   * cap/balance check has passed, so a rejected request cannot burn a one-time
   * 2FA proof. Throwing rolls back both the authorization write and the escrow.
   * Idempotent retries return their existing row before this hook runs again.
   */
  /** Return false for a rejected credential. That commits only the verifier's
   * lockout/attempt state, then requestWithdrawal raises 422 outside the DB
   * transaction. Throw for infrastructure failures that must roll everything
   * back. `void` remains accepted for non-credential authorization hooks. */
  authorize?: (tx: DbTx) => Promise<boolean | void>;
  /** Raw wallet proof persisted atomically with a newly-created escrow row.
   * Public routes require it for both standard and instant withdrawals. */
  authorization?: WithdrawalAuthorizationProof;
  /** Server-selected network frozen alongside the raw proof. */
  authorizationNetwork?: { cluster: 'devnet' | 'mainnet-beta'; keepMint: string | null };
  /** Inline/local sender seam. Production signing runs in the worker. */
  authorizationGate?: WithdrawalAuthorizationGate;
}

export interface PersonalWithdrawalLimit {
  personalDailyLimitKeep: string;
  personalDailyUsedKeep: string;
  personalDailyRemainingKeep: string;
  governingKeepLevel: number;
  nextAvailableAt: string | null;
}

/** Authoritative wallet-level withdrawal allowance for UI display. Uses the same
 * strongest-active-paid-base rule and rolling-status accounting as the mutation. */
export async function getPersonalWithdrawalLimit(
  db: Db, wallet: string, now = new Date(),
): Promise<PersonalWithdrawalLimit> {
  return db.transaction(async (tx) => {
    const [pl] = await tx.select({ keepLevel: players.keepLevel }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!pl) throw new HttpError(404, 'player not found');
    let governingKeepLevel = pl.keepLevel;
    if (multiBaseEnabled()) {
      const active = await assertFreshLockedActiveBaseAuthorities(tx, wallet, now);
      const owned = active.filter((base) => base.landPaidAt !== null);
      if (owned.length === 0) throw new HttpError(402, 'entry not paid', 'LAND_NOT_OWNED');
      governingKeepLevel = Math.max(...owned.map((base) => base.keepLevel));
    }
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const recent = await tx.select().from(withdrawals).where(and(
      eq(withdrawals.playerWallet, wallet),
      gte(withdrawals.createdAt, dayAgo),
      notInArray(withdrawals.status, UNCHARGED_STATUSES),
    ));
    const used = recent.reduce((sum, withdrawal) => sum + withdrawal.amount, 0n);
    const limit = BigInt(withdrawDailyCapForKeepLevel(governingKeepLevel));
    const cooldownRows = recent.filter((withdrawal) => withdrawal.status !== 'failed');
    const lastAt = cooldownRows.length === 0 ? null : cooldownRows.reduce(
      (latest, withdrawal) => withdrawal.createdAt > latest ? withdrawal.createdAt : latest,
      cooldownRows[0]!.createdAt,
    );
    return {
      personalDailyLimitKeep: limit.toString(),
      personalDailyUsedKeep: used.toString(),
      personalDailyRemainingKeep: (used < limit ? limit - used : 0n).toString(),
      governingKeepLevel,
      nextAvailableAt: lastAt ? new Date(lastAt.getTime() + 86_400_000).toISOString() : null,
    };
  });
}

const PREFLIGHT_COMPLETE = Symbol('withdrawal preflight complete');
const AUTHORIZATION_DENIED = Symbol('withdrawal authorization denied');

/**
 * Run the exact request gates without creating a withdrawal or moving funds.
 * The sentinel is thrown at the authorization seam, which is deliberately after
 * every business validation and before the first ledger write. PostgreSQL rolls
 * the read-only transaction back; the sentinel never crosses the API boundary.
 */
export async function preflightWithdrawal(
  db: Db, wallet: string, amount: bigint, destination: string, idempotencyKey: string,
  opts: Pick<WithdrawalRequestOpts, 'now' | 'instant'> = {},
): Promise<void> {
  try {
    await requestWithdrawal(db, wallet, amount, destination, idempotencyKey, {
      ...opts,
      authorize: async () => { throw PREFLIGHT_COMPLETE; },
    });
  } catch (error) {
    if (error === PREFLIGHT_COMPLETE) return;
    throw error;
  }
}

export async function requestWithdrawal(
  db: Db, wallet: string, amount: bigint, destination: string, idempotencyKey: string,
  opts: WithdrawalRequestOpts = {},
) {
  const now = opts.now ?? new Date();
  const requestedInstant = opts.instant === true;
  // Liquidity-bootstrap gate (ONRAMP-WALLETS-PLAN §2/§8, owner decision):
  // during the first month on mainnet withdrawals are OFF globally while
  // collected SOL seeds the pool — flip WITHDRAWALS_ENABLED=false for that
  // window. An ops kill-switch, not a game number; defaults ON so devnet
  // testing and the post-liquidity steady state need no config.
  if (process.env['WITHDRAWALS_ENABLED'] === 'false') {
    throw new HttpError(503, 'withdrawals open when the liquidity pool goes live — your KEEP keeps playing until then');
  }
  if (amount <= 0n) throw new HttpError(422, 'amount must be positive');
  if (amount < BigInt(ECONOMY.minWithdrawKeep)) {
    throw new HttpError(422, `minimum withdrawal is ${ECONOMY.minWithdrawKeep} KEEP`);
  }
  // Validate the destination as an on-curve wallet BEFORE freezing escrow, so a
  // malformed/off-curve address can't lock the player's funds for 48h and then
  // fail at payout (security review 2026-07-18 #3). The payout sends to this
  // wallet's ATA; PDAs/program addresses (off-curve) are not valid destinations.
  let destKey: PublicKey;
  try {
    destKey = new PublicKey(destination);
  } catch {
    throw new HttpError(422, 'invalid destination address');
  }
  if (!PublicKey.isOnCurve(destKey.toBytes())) {
    throw new HttpError(422, 'destination must be a wallet address (on-curve)');
  }
  const dayAgo = new Date(now.getTime() - 86_400_000);

  // Cap-read → escrow-freeze → row-insert run in ONE transaction, serialized by
  // the existing global advisory lock. The cross-player amount cap is gone, but
  // retaining this canonical order avoids changing a proven concurrency boundary
  // while the per-wallet rolling cap and cooldown remain. A concurrent same-key
  // request blocks here, then takes the duplicate branch against the committed row.
  //
  // The client's idempotencyKey is NAMESPACED per-wallet under a fixed prefix so
  // it can never collide with an internal ledger key ('genesis:play_pool',
  // 'withdrawal:<id>:payout', another wallet's key, …). A collision used to make
  // postTransaction return duplicate WITHOUT freezing escrow, then fall through
  // to insert an UNBACKED row → free KEEP / negative escrow (#1 residual, critical).
  const freezeKey = `withdrawal.request:${wallet}:${idempotencyKey}`;
  const result = await db.transaction(async (tx) => {
    await lockWithdrawalGlobalTx(tx);
    await lockWithdrawalWalletTx(tx, wallet);

    // Idempotent retry short-circuit: if THIS exact request key already froze
    // escrow, return the existing withdrawal WITHOUT re-running the new-withdrawal
    // gates below. A retry of the same request is not a new withdrawal, so it must
    // not trip the 24h cooldown (freezeKey is unique per wallet+client key).
    const [prior] = await tx.select({
      id: ledgerTransactions.id,
      metadata: ledgerTransactions.metadata,
    }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, freezeKey));
    if (prior) {
      const [existing] = await tx.select().from(withdrawals)
        .where(eq(withdrawals.requestLedgerTxnId, prior.id));
      if (existing) {
        // Mode is part of the economic intent too. Without this comparison, a
        // standard request could be retried as instant: the duplicate branch
        // skipped its factor hook, then the caller inline-paid the still-
        // unbonding standard row. Missing metadata is legacy-standard (safe): a
        // legacy instant retry is refused and can still settle through worker.
        const metadata = prior.metadata;
        const priorInstant = metadata !== null && typeof metadata === 'object'
          && !Array.isArray(metadata)
          && (metadata as Record<string, unknown>)['instant'] === true;
        if (priorInstant !== requestedInstant) {
          throw new HttpError(409, 'idempotency key already used for a different withdrawal mode');
        }
        // An idempotency key identifies one exact economic intent. Returning a
        // prior row for a different amount/destination makes a retried UI look
        // successful while authorizing something other than the reviewed
        // request. Refuse the collision; the original row remains untouched.
        if (existing.amount !== amount || existing.destination !== destination) {
          throw new HttpError(409, 'idempotency key already used for a different withdrawal');
        }
        return { row: existing, newlyCreated: false };
      }
      throw new HttpError(409, 'idempotency key already used');
    }

    // Checked after the idempotent-replay branch: recovery blocks a new escrow,
    // while a caller may still learn the terminal result of an older request.
    // The shared wallet lock makes this atomic against recovery confirmation.
    await assertTotpRecoveryAllowsTx(tx, wallet, 'withdrawal', now);

    // Per-player rolling cap, scaled by Keep level. Cancelled and refunded rows
    // do not count because their escrow returned without leaving custody.
    const [pl] = await tx.select({ keepLevel: players.keepLevel }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!pl) throw new HttpError(404, 'player not found');
    let capKeepLevel = pl.keepLevel;
    if (multiBaseEnabled()) {
      // Wallet-wide allowance uses the strongest ACTIVE PAID base, never the
      // compatibility scalar. Multiple bases increase choice, not total outflow.
      const active = await assertFreshLockedActiveBaseAuthorities(tx, wallet);
      const owned = active.filter((base) => base.landPaidAt !== null);
      if (owned.length === 0) throw new HttpError(402, 'entry not paid', 'LAND_NOT_OWNED');
      capKeepLevel = Math.max(...owned.map((base) => base.keepLevel));
    }
    const dailyCap = withdrawDailyCapForKeepLevel(capKeepLevel);
    const mine = await tx.select().from(withdrawals).where(and(
      eq(withdrawals.playerWallet, wallet),
      gte(withdrawals.createdAt, dayAgo),
      notInArray(withdrawals.status, UNCHARGED_STATUSES),
    ));

    // 24h cooldown between withdrawals (owner 2026-07-19): at most ONE (non-failed)
    // withdrawal per rolling 24h, so a player must leave loot on their base between
    // cash-outs instead of draining every mine tick — keeps raids worth running.
    // Cancelled/refunded (excluded above) and failed attempts don't start a cooldown.
    const recent = mine.filter((w) => w.status !== 'failed');
    if (recent.length > 0) {
      const lastAt = recent.reduce((m, w) => (w.createdAt > m ? w.createdAt : m), recent[0]!.createdAt);
      const nextAt = new Date(lastAt.getTime() + 86_400_000);
      const leftSec = Math.max(1, Math.ceil((nextAt.getTime() - now.getTime()) / 1_000));
      throw new HttpError(429, `withdrawal on cooldown — next available in ${fmtDur(leftSec)}`);
    }

    const mineSum = mine.reduce((sum, withdrawal) => sum + withdrawal.amount, 0n);
    if (mineSum + amount > BigInt(dailyCap)) {
      throw new HttpError(422, `daily withdrawal cap is ${dailyCap} KEEP at Keep level ${capKeepLevel}`);
    }

    // Freeze the gross amount in escrow NOW (raid-protected, unspendable).
    const sys = await bootstrapSystemAccounts(tx);
    const player = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');

    // A withdrawal can take the whole in-game balance when that balance fits the
    // player's rolling Keep-level cap. The old 50%-of-holdings single-request cap
    // and the cross-player global daily cap are gone; one wallet's activity cannot
    // consume another wallet's allowance.
    // ⚠ SCOPE OF THAT ARGUMENT (money review 2026-07-29 #4): "capped upstream at
    // the mint" is true of EMISSION only. Two paths credit player_keep without
    // touching the forge — `keep_deposit` (backed 1:1, benign) and historical
    // `keep_vend` recovery credits. New vend intents are fail-closed.
    // ✅ CLOSED at the OUTFLOW end (2026-07-29): the payout queue now consults
    // coverage — `makeCoverageGate` above blocks every payout (worker AND the
    // instant 2FA path) whenever the hot wallet no longer covers the ledger's
    // liability, using checkReserves verbatim so the brake and /por can never
    // disagree. So an unbacked credit can no longer be converted into KEEP
    // leaving custody. The CREDIT end is now gated off for new sales; this brake
    // remains necessary for already-paid historical intents and any other
    // reserve divergence.
    // Balance is still a hard ceiling (player_keep is a NON_NEGATIVE_KIND, so the
    // freeze below would fail anyway) — checked here, under the lock on the
    // pre-freeze balance, to answer with a player-readable error instead of a raw
    // ledger one naming an internal account id.
    if (amount > player.balance) {
      throw new HttpError(422, `not enough KEEP — you have ${player.balance}`);
    }

    if (await opts.authorize?.(tx) === false) return AUTHORIZATION_DENIED;

    const posted = await postTransaction(tx, {
      idempotencyKey: freezeKey,
      type: 'withdrawal.request',
      entries: [
        { account: player.id, delta: -amount },
        { account: sys.withdrawal_escrow, delta: amount },
      ],
      metadata: { wallet, destination, instant: requestedInstant },
    });
    if (posted.duplicate) {
      // Freeze + insert are atomic in THIS tx, so a real duplicate always has its
      // row — return it (idempotent retry). No row means the freeze wasn't applied
      // (impossible for a namespaced 'withdrawal.request' key); refuse rather than
      // build an unbacked withdrawal against a foreign ledger txn.
      const [existing] = await tx.select().from(withdrawals)
        .where(eq(withdrawals.requestLedgerTxnId, posted.transaction.id));
      if (existing) return { row: existing, newlyCreated: false };
      throw new HttpError(409, 'idempotency key already used');
    }

    const fee = (amount * BigInt(ECONOMY.withdrawFeeBps)) / 10_000n;
    const [inserted] = await tx.insert(withdrawals).values({
      playerWallet: wallet,
      currency: 'KEEP',
      amount,
      feeBurned: fee,
      destination,
      status: 'unbonding',
      // Instant (2FA-verified) → due immediately, no cooldown. Otherwise the 24h
      // unbonding window (frozen, cancellable, raid-protected).
      unbondsAt: requestedInstant ? now : new Date(now.getTime() + ECONOMY.unbondingHours * 3600 * 1000),
      requestLedgerTxnId: posted.transaction.id,
    }).returning();
    if (opts.authorization) {
      if (!opts.authorizationNetwork?.keepMint) {
        throw new HttpError(503, 'KEEP withdrawal network is not configured');
      }
      await tx.insert(withdrawalAuthorizations).values({
        withdrawalId: inserted!.id,
        challengeToken: opts.authorization.challengeToken,
        walletSignature: opts.authorization.signature,
        cluster: opts.authorizationNetwork.cluster,
        keepMint: opts.authorizationNetwork.keepMint,
      });
    }
    return { row: inserted!, newlyCreated: true };
  });

  // A wrong one-time factor must increment/lock out even though no money moves.
  // Returning the sentinel let that verifier state commit; throwing here keeps
  // the public failure while guaranteeing there is no escrow/withdrawal row.
  if (result === AUTHORIZATION_DENIED) {
    throw new HttpError(422, 'invalid or expired authorization code');
  }
  const { row, newlyCreated } = result;

  // Instant path: settle on-chain right now so the player doesn't wait for the
  // payout worker. A send failure marks the row 'failed', keeping the escrow
  // frozen under the same double-send-safe rules as the worker.
  // ONLY the newly-created row reaches this seam: an idempotent retry skipped
  // its already-consumed authorization, so it must never trigger another inline
  // chain action. payoutWithdrawalRow's atomic claim protects the in-flight
  // case. The reserve gate applies HERE TOO — a 2FA code buys you out of the
  // unbonding wait, not out of the solvency check; a halt leaves the row queued
  // for the worker.
  if (newlyCreated && requestedInstant && opts.send && row.status === 'unbonding') {
    await payoutWithdrawalRow(
      db, opts.send, makeCoverageGate(db, opts.readReserve),
      opts.authorizationGate ?? missingAuthorizationGate, row, now,
    );
    const [settled] = await db.select().from(withdrawals).where(eq(withdrawals.id, row.id));
    return settled!;
  }
  return row;
}

export interface WithdrawalCancelOpts {
  now?: Date;
  /** Failure-injection seam for the atomicity regression. Production omits it. */
  post?: (tx: DbTx, input: PostTransactionInput) => Promise<PostedTransaction>;
}

/** Cancel during unbonding: status claim + escrow compensation are ONE commit. */
export async function cancelWithdrawal(
  db: Db, wallet: string, withdrawalId: string, opts: WithdrawalCancelOpts = {},
) {
  const now = opts.now ?? new Date();
  const post = opts.post ?? postTransaction;
  return db.transaction(async (tx) => {
    await lockWithdrawalWalletTx(tx, wallet);
    // Ownership + state are checked in the conditional claim itself. This row
    // lock serializes concurrent cancels; only one caller can post the refund.
    const claimed = await tx.update(withdrawals)
      .set({ status: 'cancelled', completedAt: now })
      .where(and(
        eq(withdrawals.id, withdrawalId),
        eq(withdrawals.playerWallet, wallet),
        eq(withdrawals.status, 'unbonding'),
      ))
      .returning();
    if (claimed.length === 0) {
      const [existing] = await tx.select().from(withdrawals).where(and(
        eq(withdrawals.id, withdrawalId), eq(withdrawals.playerWallet, wallet),
      ));
      if (!existing) throw new HttpError(404, 'withdrawal not found');
      throw new HttpError(422, `cannot cancel a ${existing.status} withdrawal`);
    }

    const w = claimed[0]!;
    const sys = await bootstrapSystemAccounts(tx);
    const player = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
    const posted = await post(tx, {
      idempotencyKey: `withdrawal:${withdrawalId}:cancel`,
      type: 'withdrawal.cancel',
      entries: [
        { account: sys.withdrawal_escrow, delta: -w.amount },
        { account: player.id, delta: w.amount },
      ],
      metadata: { wallet, withdrawalId },
    });
    // A duplicate cannot arise through this function: the row claim serializes
    // callers and the posting commits with the status. Treat one as corruption,
    // rolling the claim back instead of recording a cancellation with no refund.
    if (posted.duplicate) throw new HttpError(409, 'withdrawal cancellation posting already exists');
    return w;
  });
}

/** Recovery-only bulk unwind. The caller owns the global+wallet lock and outer
 * transaction. Only still-unbonding rows are claimed; prepared/processing or
 * broadcast withdrawals are intentionally never rewound. */
export async function cancelUnbondingWithdrawalsForTotpRecoveryTx(
  tx: DbTx, wallet: string, recoveryId: string, now = new Date(),
): Promise<{ count: number; amount: bigint; ids: string[] }> {
  const rows = await tx.select().from(withdrawals).where(and(
    eq(withdrawals.playerWallet, wallet),
    eq(withdrawals.status, 'unbonding'),
  )).for('update');
  if (rows.length === 0) return { count: 0, amount: 0n, ids: [] };

  const sys = await bootstrapSystemAccounts(tx);
  const player = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
  let amount = 0n;
  for (const row of rows) {
    // The API owns the unbonding→cancelled transition. The existing privileged
    // terminal trigger releases any worker reservation in the same transaction.
    const [claimed] = await tx.update(withdrawals).set({
      status: 'cancelled', completedAt: now,
    }).where(and(
      eq(withdrawals.id, row.id),
      eq(withdrawals.playerWallet, wallet),
      eq(withdrawals.status, 'unbonding'),
    )).returning();
    if (!claimed) throw new Error('locked recovery withdrawal claim disappeared');
    const posted = await postTransaction(tx, {
      idempotencyKey: `withdrawal:${row.id}:cancel`,
      type: 'withdrawal.cancel',
      entries: [
        { account: sys.withdrawal_escrow, delta: -row.amount },
        { account: player.id, delta: row.amount },
      ],
      metadata: { wallet, withdrawalId: row.id, reason: 'totp_recovery', recoveryId },
    });
    if (posted.duplicate) {
      throw new HttpError(409, 'withdrawal recovery cancellation posting already exists');
    }
    await tx.update(withdrawals).set({ refundLedgerTxnId: posted.transaction.id })
      .where(and(eq(withdrawals.id, row.id), eq(withdrawals.status, 'cancelled')));
    amount += row.amount;
  }
  return { count: rows.length, amount, ids: rows.map((row) => row.id) };
}

type WithdrawalAttempt = typeof withdrawalAttempts.$inferSelect;
type WithdrawalPayout = Pick<
  typeof withdrawals.$inferSelect,
  | 'id' | 'playerWallet' | 'currency' | 'amount' | 'feeBurned' | 'destination'
  | 'status' | 'unbondsAt' | 'requestLedgerTxnId' | 'payoutLedgerTxnId' | 'createdAt'
>;

const missingAuthorizationGate: WithdrawalAuthorizationGate = async () => ({
  ok: false,
  reason: 'wallet authorization verifier is unavailable',
});

async function reserveRollingPayoutAllowance(
  db: Db, withdrawalId: string, wallet: string, gross: bigint, cap: bigint,
): Promise<boolean> {
  if (cap <= 0n) return false;
  const [row] = await db.execute(sql<{ allowed: boolean }>`
    SELECT public.shardkeep_reserve_withdrawal_allowance(
      ${withdrawalId}::uuid, ${wallet}::text, ${gross}::bigint, ${cap}::bigint
    ) AS allowed
  `);
  return row?.allowed === true;
}

async function finalizeDailyPayoutAllowance(tx: DbTx, withdrawalId: string): Promise<void> {
  const [row] = await tx.execute(sql<{ finalized: boolean }>`
    SELECT public.shardkeep_finalize_withdrawal_allowance(${withdrawalId}::uuid) AS finalized
  `);
  if (row?.finalized !== true) throw new Error('withdrawal daily allowance reservation is missing');
}

async function releaseDailyPayoutAllowance(tx: DbTx, withdrawalId: string): Promise<boolean> {
  const [row] = await tx.execute(sql<{ released: boolean }>`
    SELECT public.shardkeep_release_withdrawal_allowance(${withdrawalId}::uuid) AS released
  `);
  return row?.released === true;
}

function preparedFromAttempt(attempt: WithdrawalAttempt): PreparedKeepWithdrawal {
  const height = Number(attempt.lastValidBlockHeight);
  if (!Number.isSafeInteger(height)) throw new Error('stored last-valid block height is unsafe');
  const prepared: PreparedKeepWithdrawal = {
    version: 1,
    signature: attempt.txSignature,
    transactionBytes: Uint8Array.from(attempt.signedTransaction),
    recentBlockhash: attempt.recentBlockhash,
    lastValidBlockHeight: height,
    transfer: attempt.transferSnapshot as KeepWithdrawalSnapshot,
  };
  validatePreparedKeepWithdrawal(prepared);
  return prepared;
}

function assertPreparedMatches(
  w: WithdrawalPayout, net: bigint, prepared: PreparedKeepWithdrawal, expectedMint: string,
): void {
  validatePreparedKeepWithdrawal(prepared);
  if (prepared.transfer.withdrawalId !== w.id
      || prepared.transfer.destinationOwner !== w.destination
      || prepared.transfer.amountKeep !== net.toString()
      || prepared.transfer.mint !== expectedMint) {
    throw new Error('signed withdrawal transfer does not match the frozen payout');
  }
}

/** Commit the signed artifact and the unbonding→processing claim together. */
async function claimWithPreparedAttempt(
  db: Db, w: WithdrawalPayout, prepared: PreparedKeepWithdrawal, now: Date,
): Promise<WithdrawalAttempt | null> {
  return db.transaction(async (tx) => {
    await lockWithdrawalWalletTx(tx, w.playerWallet);
    // Canonical custody order is wallet -> withdrawal -> reservation. The
    // SECURITY DEFINER reservation function and recovery cancellation use the
    // same order; taking the reservation first here allowed a reserve/claim or
    // recovery/claim pair to deadlock under unlucky timing.
    const [current] = await tx.select({ status: withdrawals.status })
      .from(withdrawals).where(and(
        eq(withdrawals.id, w.id),
        eq(withdrawals.playerWallet, w.playerWallet),
      )).for('update');
    if (current?.status !== 'unbonding') return null;
    const [reservation] = await tx.select({ status: withdrawalPayoutReservations.status })
      .from(withdrawalPayoutReservations)
      .where(eq(withdrawalPayoutReservations.withdrawalId, w.id)).for('update');
    if (reservation?.status !== 'reserved') return null;
    const [claimed] = await tx.update(withdrawals)
      .set({ status: 'processing', lastError: 'SIGNED AND PERSISTED — broadcast pending' })
      .where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, 'unbonding')))
      .returning();
    if (!claimed) return null;
    const [attempt] = await tx.insert(withdrawalAttempts).values({
      withdrawalId: w.id,
      status: 'prepared',
      txSignature: prepared.signature,
      signedTransaction: Buffer.from(prepared.transactionBytes),
      recentBlockhash: prepared.recentBlockhash,
      lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight),
      transferSnapshot: prepared.transfer,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return attempt!;
  });
}

const REBROADCAST_AFTER_MS = 5_000;

/** Stamp the attempt BEFORE entering the RPC, then send its immutable bytes. */
async function broadcastAttempt(
  db: Db, send: KeepTransferSender, attempt: WithdrawalAttempt, now: Date,
): Promise<void> {
  const prepared = preparedFromAttempt(attempt);
  const stamped = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.id, attempt.id)).for('update');
    if (!current || !['prepared', 'broadcast'].includes(current.status)) return null;
    if (current.lastBroadcastAt
        && now.getTime() - current.lastBroadcastAt.getTime() < REBROADCAST_AFTER_MS) {
      return null;
    }
    const [updated] = await tx.update(withdrawalAttempts).set({
      status: 'broadcast',
      broadcastCount: sql`${withdrawalAttempts.broadcastCount} + 1`,
      firstBroadcastAt: current.firstBroadcastAt ?? now,
      lastBroadcastAt: now,
      updatedAt: now,
      lastError: null,
    }).where(eq(withdrawalAttempts.id, attempt.id)).returning();
    return updated!;
  });
  if (!stamped) return;
  try {
    await send.broadcast(prepared);
    await db.update(withdrawalAttempts).set({ lastError: null, updatedAt: now })
      .where(and(
        eq(withdrawalAttempts.id, attempt.id),
        inArray(withdrawalAttempts.status, ['prepared', 'broadcast']),
      ));
  } catch (error) {
    const failure = errorForStorage(error, 400);
    await db.transaction(async (tx) => {
      await tx.update(withdrawalAttempts).set({ lastError: failure, updatedAt: now })
        .where(and(
          eq(withdrawalAttempts.id, attempt.id),
          inArray(withdrawalAttempts.status, ['prepared', 'broadcast']),
        ));
      await tx.update(withdrawals).set({
        lastError: `BROADCAST AMBIGUOUS — ${prepared.signature} — ${failure}`,
      }).where(and(eq(withdrawals.id, attempt.withdrawalId), eq(withdrawals.status, 'processing')));
    });
  }
}

async function settleFinalizedSuccess(
  db: Db, attemptId: string, source: string, now: Date,
): Promise<'sent' | null> {
  const settled = await db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.id, attemptId)).for('update');
    if (!attempt || !['prepared', 'broadcast'].includes(attempt.status)) return null;
    const [w] = await tx.select().from(withdrawals)
      .where(eq(withdrawals.id, attempt.withdrawalId)).for('update');
    if (!w || w.status !== 'processing') return null;
    const [authorization] = await tx.select({
      keepMint: withdrawalAuthorizations.keepMint,
      validatedDigest: withdrawalAuthorizations.validatedDigest,
      validatedAt: withdrawalAuthorizations.validatedAt,
    }).from(withdrawalAuthorizations)
      .where(eq(withdrawalAuthorizations.withdrawalId, w.id)).for('update');
    if (!authorization?.validatedDigest || !authorization.validatedAt) {
      throw new Error(`withdrawal ${w.id} has no independently validated wallet authorization`);
    }
    const prepared = preparedFromAttempt(attempt);
    const net = w.amount - w.feeBurned;
    // Finality is not enough on its own: bind the settled mint to the immutable
    // authorization that the independent worker verifier already consumed.
    // The signed artifact is untrusted persisted input at this boundary.
    assertPreparedMatches(w, net, prepared, authorization.keepMint);
    const sys = await bootstrapSystemAccounts(tx);
    const posted = await postTransaction(tx, {
      idempotencyKey: `withdrawal:${w.id}:payout`,
      type: 'withdrawal.payout',
      entries: [
        { account: sys.withdrawal_escrow, delta: -w.amount },
        { account: sys.burn, delta: w.feeBurned },
        { account: sys.onchain_outflow, delta: net },
      ],
      metadata: { withdrawalId: w.id, txSignature: prepared.signature, finalizedSource: source },
    });
    if (posted.duplicate) {
      throw new Error(`withdrawal ${w.id} has a payout posting before atomic finality settlement`);
    }
    await finalizeDailyPayoutAllowance(tx, w.id);
    await tx.update(withdrawals).set({
      status: 'sent', txSignature: prepared.signature, mint: authorization.keepMint,
      completedAt: now, payoutLedgerTxnId: posted.transaction.id, lastError: null,
    }).where(eq(withdrawals.id, w.id));
    await tx.update(withdrawalAttempts).set({
      status: 'finalized_success', finalizedAt: now, lastCheckedAt: now,
      lastError: null, updatedAt: now,
    }).where(eq(withdrawalAttempts.id, attempt.id));
    return { id: w.id, destination: w.destination, signature: prepared.signature };
  });
  if (!settled) return null;
  console.log(`[PAYOUT-SENT] withdrawal ${settled.id} → ${settled.destination} sig ${settled.signature}`);
  return 'sent';
}

async function settleDefinitiveFailure(
  db: Db, attemptId: string, detail: string, now: Date,
): Promise<'failed' | null> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.id, attemptId)).for('update');
    if (!attempt || !['prepared', 'broadcast'].includes(attempt.status)) return null;
    const [w] = await tx.select().from(withdrawals)
      .where(eq(withdrawals.id, attempt.withdrawalId)).for('update');
    if (!w || w.status !== 'processing') return null;
    const proof = `FINALIZED ERROR — ${attempt.txSignature} — ${detail}`;
    await tx.update(withdrawalAttempts).set({
      status: 'finalized_error',
      finalizedAt: now,
      lastCheckedAt: now,
      lastError: detail,
      updatedAt: now,
    }).where(eq(withdrawalAttempts.id, attempt.id));
    await tx.update(withdrawals).set({
      status: 'failed', txSignature: attempt.txSignature, completedAt: now, lastError: proof,
    }).where(eq(withdrawals.id, w.id));
    return 'failed';
  });
}

async function reconcileAttempt(
  db: Db, send: KeepTransferSender, attempt: WithdrawalAttempt, now: Date,
): Promise<'sent' | 'failed' | 'processing' | null> {
  const prepared = preparedFromAttempt(attempt);
  let finality;
  try {
    finality = await send.reconcile(prepared);
  } catch (error) {
    const failure = errorForStorage(error, 400);
    await db.update(withdrawalAttempts).set({ lastCheckedAt: now, lastError: failure, updatedAt: now })
      .where(and(
        eq(withdrawalAttempts.id, attempt.id),
        inArray(withdrawalAttempts.status, ['prepared', 'broadcast']),
      ));
    return 'processing';
  }
  if (finality.status === 'finalized_success') {
    return settleFinalizedSuccess(db, attempt.id, finality.source, now);
  }
  if (finality.status === 'finalized_error') {
    return settleDefinitiveFailure(
      db, attempt.id, errorForStorage(finality.error, 300), now,
    );
  }
  if (finality.status === 'expired_unresolved') {
    // Ordinary RPC nodes may prune old finalized transactions. Even unanimous
    // null observations after blockhash expiry therefore cannot prove the
    // signed payout never landed. Keep escrow and the allowance reserved, and
    // require an explicit archival/operator investigation; never auto-fail or
    // expose this attempt to the player-refund path.
    await db.update(withdrawalAttempts).set({
      lastCheckedAt: now,
      lastError: 'EXPIRED UNRESOLVED — non-archival RPC history cannot prove transfer absence',
      absenceProofSources: finality.sources,
      updatedAt: now,
    }).where(and(
      eq(withdrawalAttempts.id, attempt.id),
      inArray(withdrawalAttempts.status, ['prepared', 'broadcast']),
    ));
    return 'processing';
  }
  const observation = errorForStorage(finality.observations.join('; '), 400);
  await db.update(withdrawalAttempts).set({
    lastCheckedAt: now,
    lastError: observation || null,
    updatedAt: now,
  }).where(and(
    eq(withdrawalAttempts.id, attempt.id),
    inArray(withdrawalAttempts.status, ['prepared', 'broadcast']),
  ));
  // Once even one endpoint proves the blockhash expired, another broadcast
  // cannot land. Null history remains a manual hold even if every ordinary RPC
  // agrees, because those providers may all have pruned the finalized record.
  if (!finality.expired
      && (!attempt.lastBroadcastAt
        || now.getTime() - attempt.lastBroadcastAt.getTime() >= REBROADCAST_AFTER_MS)) {
    await broadcastAttempt(db, send, attempt, now);
  }
  return 'processing';
}

/**
 * Reconcile durable processing attempts. A legacy `processing` row with no
 * attempt is intentionally invisible here: without signed bytes/signature it is
 * ambiguous and can never be auto-refunded or reconstructed.
 */
export async function reconcileProcessingWithdrawals(
  db: Db, send: KeepTransferSender, now = new Date(),
): Promise<{ sent: number; failed: number; processing: number }> {
  const attempts = await db.select({ attempt: withdrawalAttempts })
    .from(withdrawalAttempts)
    .innerJoin(withdrawals, eq(withdrawals.id, withdrawalAttempts.withdrawalId))
    .where(and(
      eq(withdrawals.status, 'processing'),
      inArray(withdrawalAttempts.status, ['prepared', 'broadcast']),
    ));
  let sent = 0;
  let failed = 0;
  const legacyAmbiguous = await db.select({ id: withdrawals.id }).from(withdrawals)
    .leftJoin(withdrawalAttempts, eq(withdrawalAttempts.withdrawalId, withdrawals.id))
    .where(and(eq(withdrawals.status, 'processing'), isNull(withdrawalAttempts.id)));
  let processing = legacyAmbiguous.length;
  for (const row of legacyAmbiguous) {
    console.error(
      `[PAYOUT-LEGACY-AMBIGUOUS] withdrawal ${row.id} has no persisted signed attempt; `
      + 'it remains processing and can never be automatically refunded or reconstructed',
    );
  }
  for (const row of attempts) {
    const result = await reconcileAttempt(db, send, row.attempt, now);
    if (result === 'sent') sent++;
    else if (result === 'failed') failed++;
    else if (result === 'processing') processing++;
  }
  return { sent, failed, processing };
}

/** Prepare/sign locally, persist, then broadcast. Ambiguity stays processing. */
async function payoutWithdrawalRow(
  db: Db, send: KeepTransferSender, gate: CoverageGate,
  authorizationGate: WithdrawalAuthorizationGate,
  w: WithdrawalPayout, now: Date,
): Promise<'sent' | 'failed' | 'processing' | 'halted' | null> {
  const authorization = await authorizationGate(w, now);
  if (!authorization.ok) {
    const reason = errorForStorage(authorization.reason, 300);
    console.error(`[PAYOUT-AUTHORIZATION-HOLD] withdrawal ${w.id} NOT signed — ${reason}`);
    await db.update(withdrawals).set({ lastError: `AUTHORIZATION HELD — ${reason}` })
      .where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, 'unbonding')));
    return 'halted';
  }
  const verdict = await gate();
  if (!verdict.ok) {
    console.error(`[PAYOUT-HALT] withdrawal ${w.id} NOT paid — ${verdict.reason}`);
    return 'halted';
  }
  const net = w.amount - w.feeBurned;
  const paidMint = authorization.keepMint;
  let walletCap: bigint;
  try {
    walletCap = BigInt((await getPersonalWithdrawalLimit(db, w.playerWallet, now)).personalDailyLimitKeep);
  } catch (error) {
    await db.transaction(async (tx) => releaseDailyPayoutAllowance(tx, w.id));
    await db.update(withdrawals).set({
      lastError: `PAYOUT HELD — wallet allowance unavailable: ${errorForStorage(error, 200)}`,
    }).where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, 'unbonding')));
    return 'halted';
  }
  if (!(await reserveRollingPayoutAllowance(db, w.id, w.playerWallet, w.amount, walletCap))) {
    await db.update(withdrawals).set({
      lastError: 'PAYOUT HELD — worker rolling 24-hour wallet allowance exhausted',
    }).where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, 'unbonding')));
    return 'halted';
  }
  let prepared: PreparedKeepWithdrawal;
  try {
    prepared = await send.prepare({
      withdrawalId: w.id,
      playerWallet: w.playerWallet,
      destination: w.destination,
      grossAmountKeep: w.amount,
      netAmountKeep: net,
      authorizationDigest: authorization.digest,
      walletRolling24hCapKeep: walletCap,
    });
    assertPreparedMatches(w, net, prepared, paidMint);
  } catch (error) {
    await db.transaction(async (tx) => releaseDailyPayoutAllowance(tx, w.id));
    await db.update(withdrawals).set({
      lastError: `PREPARE HELD — ${errorForStorage(error, 300)}`,
    }).where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, 'unbonding')));
    return 'halted';
  }
  const attempt = await claimWithPreparedAttempt(db, w, prepared, now);
  if (!attempt) {
    // The SQL release function is ownership-aware: it refuses to release once
    // another worker's atomic claim has inserted an attempt or moved the row to
    // processing. This call only cleans up a genuinely pre-claim reservation.
    await db.transaction(async (tx) => releaseDailyPayoutAllowance(tx, w.id));
    return null;
  }
  await broadcastAttempt(db, send, attempt, now);
  const [fresh] = await db.select().from(withdrawalAttempts)
    .where(eq(withdrawalAttempts.id, attempt.id));
  return reconcileAttempt(db, send, fresh!, now);
}

export async function processDueWithdrawals(
  db: Db, send: KeepTransferSender, readReserve: ReserveReader | null,
  authorizationGate: WithdrawalAuthorizationGate,
  payoutsEnabled: boolean, now = new Date(),
): Promise<{ sent: number; failed: number; held: number; skipped?: string; outflowHeld?: true }> {
  if (!payoutsEnabled) {
    return {
      sent: 0, failed: 0, held: 0,
      skipped: 'WITHDRAWALS_ENABLED=false — all queued payout outflow held',
      outflowHeld: true,
    };
  }
  const reconciled = await reconcileProcessingWithdrawals(db, send, now);
  const due = await db.select().from(withdrawals).where(and(
    eq(withdrawals.status, 'unbonding'),
    lte(withdrawals.unbondsAt, now),
  ));
  const gate = makeCoverageGate(db, readReserve);
  let sent = reconciled.sent;
  let failed = reconciled.failed;
  let held = reconciled.processing;
  for (const w of due) {
    const result = await payoutWithdrawalRow(db, send, gate, authorizationGate, w, now);
    if (result === 'sent') sent++;
    else if (result === 'failed') failed++;
    else if (result === 'halted' || result === 'processing') held++;
  }
  return { sent, failed, held };
}

/**
 * FAILED → REFUNDED (AUDIT-FIX-PLAN B1 companion): return a failed payout's
 * GROSS from withdrawal_escrow to the player's play balance. Before this, a
 * frozen/failed row left the player's KEEP stranded in escrow with no code path
 * back — recoverable only by hand-written SQL, and there is at least one such
 * row live.
 *
 * WHY PLAYER-REACHABLE (route: POST /withdrawals/:id/refund) rather than an
 * operator-only script: there is no admin surface in this codebase, so
 * "operator-only" means DB surgery stays the recovery path — the exact problem.
 * Exposing it is safe by construction: this is a pure compensating posting that
 * moves the player's OWN escrowed gross back to their OWN balance, bounded by
 * the row, touching nothing on-chain and minting nothing. It cannot pay a player
 * twice because `withdrawal:<id>:payout` and `withdrawal:<id>:refund` are
 * mutually exclusive by the row's status machine.
 *
 * NEVER AUTOMATIC. 'failed' is not proof the transfer didn't land: if `send`
 * throws after broadcasting, the tx may still confirm later. So the refund is an
 * explicit, human-triggered act. Legacy workers also erased their pre-broadcast
 * marker on sender errors, so absence of evidence is not evidence of absence.
 * A refund therefore requires positive proof: an explicit operator
 * `NOT BROADCAST — …` marker or a finalized on-chain error. Expiry plus null
 * results from ordinary RPC history is not proof because finalized history may
 * have been pruned. Every unknown/plain legacy failure remains held. That
 * proof, not status, is the guard.
 *
 * Idempotent three ways: the conditional status claim (concurrent callers
 * serialize on the row lock — the loser sees 'refunded' and gets 0 rows), the
 * ledger idempotency key, and the UNIQUE refund_ledger_txn_id column.
 */
export async function refundFailedWithdrawal(
  db: Db, withdrawalId: string, opts: { wallet?: string; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    // The claim IS the read: UPDATE … WHERE status='failed' takes the row lock,
    // so the guards below run against state no concurrent refund can change, and
    // a guard throw rolls the claim back.
    const claimed = await tx.update(withdrawals)
      .set({ status: 'refunded', completedAt: now })
      .where(and(
        eq(withdrawals.id, withdrawalId),
        eq(withdrawals.status, 'failed'),
        ...(opts.wallet ? [eq(withdrawals.playerWallet, opts.wallet)] : []),
      ))
      .returning();
    if (claimed.length === 0) {
      // Distinguish "not yours / gone" from "not refundable" without leaking
      // another wallet's rows: re-read under the same ownership scope.
      const [w] = await tx.select().from(withdrawals).where(and(
        eq(withdrawals.id, withdrawalId),
        ...(opts.wallet ? [eq(withdrawals.playerWallet, opts.wallet)] : []),
      ));
      if (!w) throw new HttpError(404, 'withdrawal not found');
      throw new HttpError(422, `only a failed withdrawal can be refunded (this one is ${w.status})`);
    }

    const w = claimed[0]!;
    // Refundability is deliberately positive-proof-only. Old code overwrote the
    // BROADCAST marker with a plain RPC error, so a null signature/plain error
    // is ambiguous too. Failing closed costs a support ticket; failing open can
    // pay twice.
    if (!hasDefinitiveNoTransferProof(w)) {
      console.error(
        `[REFUND-REFUSED] withdrawal ${w.id} carries evidence the KEEP may already have left the hot ` +
        `wallet (txSignature=${w.txSignature ?? 'none'}, lastError=${w.lastError ?? 'none'}). ` +
        'Refunding would risk paying the player TWICE. Verify on-chain first.',
      );
      throw new HttpError(409, 'this withdrawal may already have been paid on-chain — contact support');
    }

    const sys = await bootstrapSystemAccounts(tx);
    const player = await getOrCreatePlayerAccount(tx, w.playerWallet, 'player_keep');
    const posted = await postTransaction(tx, {
      idempotencyKey: `withdrawal:${w.id}:refund`,
      type: 'withdrawal.refund',
      entries: [
        { account: sys.withdrawal_escrow, delta: -w.amount },
        { account: player.id, delta: w.amount },
      ],
      metadata: { wallet: w.playerWallet, withdrawalId: w.id, failure: w.lastError },
    });
    // A duplicate here means a refund posting exists without a 'refunded' row —
    // impossible via this function (the claim precedes it in the same tx), so it
    // is a hand-written key collision. Refuse rather than credit against it.
    if (posted.duplicate && w.refundLedgerTxnId !== posted.transaction.id) {
      throw new HttpError(409, 'a refund posting already exists for this withdrawal');
    }
    const [out] = await tx.update(withdrawals)
      .set({ refundLedgerTxnId: posted.transaction.id })
      .where(eq(withdrawals.id, w.id))
      .returning();
    return out!;
  });
}

/**
 * The single server-authoritative answer used by both the refund transition and
 * the withdrawal-list UI. `failed` alone is never enough: an RPC timeout after
 * broadcast is still a possible on-chain payment. Only a failed row with
 * definitive proof that no transfer succeeded is safe for the player to unwind:
 * explicit operator no-broadcast evidence or a finalized on-chain error.
 * Expired/null and unknown/plain legacy outcomes intentionally remain false.
 */
export function isFailedWithdrawalRefundable(
  w: Pick<typeof withdrawals.$inferSelect, 'status' | 'txSignature' | 'lastError'>,
): boolean {
  return w.status === 'failed' && hasDefinitiveNoTransferProof(w);
}

function hasDefinitiveNoTransferProof(
  w: Pick<typeof withdrawals.$inferSelect, 'txSignature' | 'lastError'>,
): boolean {
  if (!w.lastError) return false;
  if (!w.txSignature && w.lastError.startsWith('NOT BROADCAST —')) return true;
  return w.lastError.startsWith('FINALIZED ERROR —');
}

export async function listWithdrawals(db: Db, wallet: string) {
  // Newest first, capped — but the cap applies ONLY to terminal rows
  // (sent/cancelled/refunded). Actionable rows (unbonding → CANCEL,
  // failed → REFUND, processing → in flight) are always returned: during a
  // payout halt an unbonding row can outlive the 24h cooldown window, after
  // which create-then-cancel pairs could stack terminal rows above it and a
  // naive newest-100 would hide the one row the player must still act on
  // (security review 2026-08-15). Actionable rows are bounded in practice by
  // the cooldown and worker, so this stays a small read.
  const actionable = await db.select().from(withdrawals)
    .where(and(
      eq(withdrawals.playerWallet, wallet),
      notInArray(withdrawals.status, ['sent', 'cancelled', 'refunded']),
    ))
    .orderBy(desc(withdrawals.createdAt));
  const terminal = await db.select().from(withdrawals)
    .where(and(
      eq(withdrawals.playerWallet, wallet),
      inArray(withdrawals.status, ['sent', 'cancelled', 'refunded']),
    ))
    .orderBy(desc(withdrawals.createdAt))
    .limit(100);
  return [...actionable, ...terminal]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
