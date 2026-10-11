import type { BasePurchaseNetwork, BasePurchaseQuote } from '@shardkeep/shared/basePurchases';
import { allowBasePurchaseTerminal, assertBasePurchasePayment, assertBasePurchaseNetwork, originalBasePurchase, basePurchaseWarzoneDirectLamports, matchesBasePurchaseWarzoneTransaction, matchesBasePurchaseBuilderTransaction } from './basePurchases';
/**
 * Deposit watcher — the on-chain verifier half of money/deposits.ts (R9,
 * ARCHITECTURE §5: "server polls signatures for the reference, waits
 * `finalized`, credits idempotently").
 *
 * Two seams keep the credit path unit-testable without RPC (house convention):
 *
 *  - `makeChainDepositVerifier(connection)` — real verifier: looks up the
 *    reference key's signatures at FINALIZED, fetches the tx, accepts it only
 *    if it succeeded and shardkeep-core itself emitted a PaymentMade matching
 *    the intent's wallet/kind/reference (Anchor EventParser scopes events to
 *    our program's frames, so another program can't forge one). For 'entry'
 *    with no tx found it falls back to Player-PDA existence — the PDA is
 *    `init`-once by pay_entry, so its existence at finalized proves the wallet
 *    paid (recovery for lost/expired intents; synthetic sig `pda:<wallet>`).
 *
 *  - `pollPendingDeposits` / `verifyDepositNow` — orchestration: verify a
 *    deposit, credit once (creating base+plot for entry), expire stale ones.
 *
 * CRITICAL (incident 2026-07-18): crediting must NOT depend on the background
 * worker being enabled. `verifyDepositNow` runs the same logic inline from the
 * client's poll (POST /deposits/:id/verify) so a player who paid is credited
 * even when ENABLE_WORKERS=false; the BullMQ job is only a backstop for
 * abandoned sessions.
 */
import { DEPOSIT_VERIFICATION, ECONOMY, WARZONE } from '@shardkeep/shared';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  finalizedPaymentTransactions, isCanonicalPlayerAccount, isCanonicalSolanaSignature, keepAta,
  parsePaymentMadeEvents, playerPda,
  verifyKeepDeposit, verifyKeepDepositCommit, verifySolPayment, verifySolPaymentCommit,
} from '@shardkeep/chain';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import { bases, deposits, fantasyLandClaims, players, plotReservations, plots } from '../db/schema';
import { releaseExpiredFantasyClaim } from '../game/fantasyLocation';
import { HttpError } from '../lib/errors';
import { depositPaymentRecoverable, recoverableDepositPaymentSql } from './depositRecovery';
import { invalidateGlobe } from '../lib/globeCache';
import { invalidateValley } from '../lib/mapCache';
import { invalidateShieldMapValley } from '../game/baseShields';
import {
  acquireDepositVerificationPermit, creditDeposit, currentDepositVerificationSignal,
  entryPurchaseConsumed, lockDepositVerification,
  lockDepositVerificationShared, lockUnusedDepositSignature,
  withDepositVerificationDeadline, type DepositKind, type DepositPayload,
  type DepositPaymentCommitVerifier, type VerifiedPayment,
} from './deposits';

/** Program event `kind` byte → deposit kind (lib.rs PAYMENT_KIND_*). Generic
 * buy_sink kinds ≥3 are echoed unchanged and mapped only by this server. */
const KIND_BY_CODE: Record<number, DepositKind> = {
  0: 'entry', 1: 'builder', 2: 'expansion', 3: 'energy', 4: 'shield', 5: 'mine',
  6: 'warzone_shield', 7: 'energy_pack', 8: 'builder', 9: 'deed',
};

/** The warzone-shield kind byte for buy_sink (must match the client). */
export const WARZONE_SHIELD_KIND = 6;
/** Generic buy_sink kind for builders 2–6. The legacy dedicated buy_builder
 * event remains accepted as kind 1 for already-finalized/in-flight purchases. */
export const BUILDER_SINK_KIND = 8;

export interface PendingDeposit {
  basePurchaseV1?: BasePurchaseQuote | undefined;
  id: string;
  playerWallet: string;
  kind: DepositKind;
  reference: string;
  createdAt: Date;
  /** Exact server-frozen quote, when this deposit kind has one. */
  expectedLamports?: bigint | undefined;
  /** Authenticated client-submitted broadcast signature. */
  paymentSignature?: string | undefined;
  /** gems_buy: the reserve token account + KEEP mint the server froze into the
   * row at intent creation (payload.destination / .mint). The verifier proves
   * the transfer against these, never against the live env. */
  destination?: string | undefined;
  mint?: string | undefined;
}

/** Resolves to a VerifiedPayment, or null when no finalized payment exists (yet). */
export type DepositVerifier = (dep: PendingDeposit) => Promise<VerifiedPayment | null>;

const SIGNATURE_PAGE_SIZE = 16;
const SIGNATURE_SCAN_CAP = 256;

/** A capped scan cannot prove absence: callers must keep the intent pending for
 * operator/RPC recovery rather than expiring a payment hidden past the cap. */
export class DepositVerificationIndeterminateError extends Error {
  constructor(reference: string) {
    super(`finalized signature scan cap exhausted for ${reference}`);
    this.name = 'DepositVerificationIndeterminateError';
  }
}

/** Two finalized providers must agree before mainnet money is credited. */
export class DepositProviderDisagreementError extends Error {
  constructor(reference: string, detail: string) {
    super(`independent RPCs disagree for deposit ${reference}: ${detail}`);
    this.name = 'DepositProviderDisagreementError';
  }
}

function sameVerifiedPayment(a: VerifiedPayment | null, b: VerifiedPayment | null): boolean {
  if (a === null || b === null) return a === b;
  return a.txSignature === b.txSignature
    && a.wallet === b.wallet
    && a.kind === b.kind
    && a.lamports === b.lamports
    && a.finalized === b.finalized;
}

/**
 * Fail-closed two-provider wrapper. A transient visibility difference throws so
 * the intent remains pending; it never converts provider disagreement into an
 * unpaid expiry or an unbacked credit.
 */
export function requireMatchingDepositVerifiers(
  primary: DepositVerifier,
  secondary: DepositVerifier,
): DepositVerifier {
  return async (dep) => {
    const [a, b] = await Promise.all([primary(dep), secondary(dep)]);
    if (!sameVerifiedPayment(a, b)) {
      throw new DepositProviderDisagreementError(
        dep.reference,
        `${a?.txSignature ?? 'not-seen'} != ${b?.txSignature ?? 'not-seen'}`,
      );
    }
    return a;
  };
}

export function requireMatchingDepositCommitVerifiers(
  primary: DepositPaymentCommitVerifier,
  secondary: DepositPaymentCommitVerifier,
): DepositPaymentCommitVerifier {
  return async (dep) => {
    const [a, b] = await Promise.all([primary(dep), secondary(dep)]);
    if (a?.txSignature !== b?.txSignature) {
      throw new DepositProviderDisagreementError(
        dep.reference,
        `${a?.txSignature ?? 'not-seen'} != ${b?.txSignature ?? 'not-seen'}`,
      );
    }
    return a;
  };
}

/** Deposit-only Connection: every HTTP RPC call is abortable and bounded. The
 * outer verifier deadline below bounds the WHOLE multi-page attempt too. */
export function makeDepositRpcConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: 'finalized',
    fetch: depositVerificationFetch,
  });
}

/** Exported only as a deterministic transport seam for abort-propagation tests. */
export async function depositVerificationFetch(
  input: string | URL | globalThis.Request, init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const signals = [controller.signal, currentDepositVerificationSignal(), init?.signal]
    .filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
  const timer = setTimeout(
    () => controller.abort(new Error('deposit verification RPC timed out')),
    DEPOSIT_VERIFICATION.rpcTimeoutMs,
  );
  try {
    return await globalThis.fetch(input, { ...init, signal: AbortSignal.any(signals) });
  } finally {
    clearTimeout(timer);
  }
}

export function makeChainDepositVerifier(
  connection: Connection,
  parseEvents: typeof parsePaymentMadeEvents = parsePaymentMadeEvents,
): DepositVerifier {
  return async (dep) => {
    const reference = new PublicKey(dep.reference);
    // Collect every finalized program payment that matches this intent across
    // all sigs. A frozen exact quote wins regardless of retry ordering; when no
    // exact attempt exists, keep the highest wrong amount visible for operator
    // reconciliation rather than misclassifying the reference as unpaid.
    const candidates: VerifiedPayment[] = [];
    let missingEvidence = false;
    if (dep.paymentSignature && isCanonicalSolanaSignature(dep.paymentSignature)) {
      const tx = await connection.getTransaction(dep.paymentSignature, {
        commitment: 'finalized', maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.meta || (!tx.meta.err && !Array.isArray(tx.meta.logMessages))) {
        missingEvidence = true;
      } else if (!tx.meta.err) {
        // Preserve a real wrong-amount payment for reconciliation. Exact quote
        // selection happens below; only the confirmed handoff demands exact SOL.
        const events = parseEvents(tx.meta.logMessages!).filter(e => !dep.basePurchaseV1
          || e.kind === dep.basePurchaseV1.rail.sinkKind && matchesBasePurchaseBuilderTransaction(tx, dep.basePurchaseV1, e.lamports));
        for (const e of events) {
          if (e.reference === dep.reference && e.wallet === dep.playerWallet
            && KIND_BY_CODE[e.kind] === dep.kind) {
            const candidate = {
              txSignature: dep.paymentSignature, wallet: e.wallet, kind: dep.kind,
              lamports: e.lamports, finalized: true as const,
            };
            if (dep.expectedLamports === undefined || candidate.lamports === dep.expectedLamports) {
              return candidate;
            }
            candidates.push(candidate);
          }
        }
      }
    }
    let before: string | undefined;
    let scanned = 0;
    let complete = false;
    const notBeforeSecond = Math.floor(dep.createdAt.getTime() / 1_000);
    while (scanned < SIGNATURE_SCAN_CAP) {
      const limit = Math.min(SIGNATURE_PAGE_SIZE, SIGNATURE_SCAN_CAP - scanned);
      const sigs = await connection.getSignaturesForAddress(
        reference, { limit, ...(before ? { before } : {}) }, 'finalized',
      );
      if (sigs.length === 0) { complete = true; break; }
      let crossedStart = false;
      for (const sig of sigs) {
        scanned++;
        if (sig.blockTime !== null && sig.blockTime !== undefined && sig.blockTime < notBeforeSecond) {
          crossedStart = true;
          break;
        }
        if (sig.err) continue;
        if (sig.signature === dep.paymentSignature) continue;
        const tx = await connection.getTransaction(sig.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        // A listed successful signature may be the player's payment. Missing
        // body, metadata or logs is incomplete RPC evidence, never proof that
        // the reference was unpaid. Keep scanning for a complete exact match.
        if (!tx || !tx.meta || (!tx.meta.err && !Array.isArray(tx.meta.logMessages))) {
          missingEvidence = true;
          continue;
        }
        if (tx.meta.err) continue;
        const events = parseEvents(tx.meta.logMessages!).filter(e => !dep.basePurchaseV1
          || e.kind === dep.basePurchaseV1.rail.sinkKind && matchesBasePurchaseBuilderTransaction(tx, dep.basePurchaseV1, e.lamports));
        for (const e of events) {
          if (e.reference === dep.reference &&
              e.wallet === dep.playerWallet &&
              KIND_BY_CODE[e.kind] === dep.kind) {
            const candidate = {
              txSignature: sig.signature, wallet: e.wallet, kind: dep.kind,
              lamports: e.lamports, finalized: true as const,
            };
            if (dep.expectedLamports === undefined || candidate.lamports === dep.expectedLamports) {
              return candidate;
            }
            candidates.push(candidate);
          }
        }
      }
      if (crossedStart || sigs.length < limit) { complete = true; break; }
      const nextBefore = sigs.at(-1)!.signature;
      if (nextBefore === before) break;
      before = nextBefore;
    }
    if (!complete || missingEvidence) throw new DepositVerificationIndeterminateError(dep.reference);
    if (candidates.length > 0) return selectProgramPaymentCandidate(candidates, dep.expectedLamports);

    // Entry recovery: pay_entry `init`s the Player PDA exactly once. Validate
    // the full finalized Anchor account because an attacker can pre-fund the
    // predictable address with a 1-lamport system account. Synthetic signature
    // keeps the unique-per-wallet credit guarantee when the payment tx itself
    // has fallen outside RPC history.
    if (dep.kind === 'entry') {
      const wallet = new PublicKey(dep.playerWallet);
      const address = playerPda(wallet);
      const account = await connection.getAccountInfo(address, 'finalized');
      if (isCanonicalPlayerAccount(address, wallet, account)) {
        return {
          txSignature: `pda:${dep.playerWallet}`,
          wallet: dep.playerWallet,
          kind: 'entry',
          lamports: BigInt(Math.round(ECONOMY.entryFeeSol * 1_000_000_000)),
          finalized: true,
        };
      }
    }
    return null;
  };
}

/**
 * KEEP-deposit verifier (owner 2026-07-19): a KEEP deposit is a plain SPL
 * transfer (no program event), so this looks up the reference-tagged tx and
 * reports the hot wallet's KEEP ATA balance INCREASE as the amount. `lamports`
 * carries KEEP base units for this kind (creditDeposit converts to whole KEEP).
 */
export function makeKeepDepositVerifier(
  connection: Connection, keepMint: PublicKey, hotWallet: PublicKey,
): DepositVerifier {
  const destination = keepAta(hotWallet, keepMint);
  return async (dep) => (dep.kind === 'keep_deposit' ? keepTransferPayment(connection, dep, keepMint, destination) : null);
}

/**
 * gems_buy verifier (E2-GEMS-CONTRACT §2; K-150): the same plain SPL transfer
 * as a KEEP deposit, but into the EMISSION-RESERVE ATA. The destination and
 * mint come from the intent ROW (frozen server-side at creation, security
 * review 2026-09-20 #1), so GEMS_RESERVE_ATA gates creation/advertising only:
 * rotating or unsetting it can neither strand a paid intent nor let a
 * transfer to a stale account credit. `lamports` carries KEEP base units;
 * creditDeposit floors to whole KEEP and mints Gems against that inflow.
 */
export function makeGemsBuyVerifier(connection: Connection): DepositVerifier {
  return async (dep) => {
    if (dep.kind !== 'gems_buy' || !dep.destination || !dep.mint) return null;
    return keepTransferPayment(connection, dep, new PublicKey(dep.mint), new PublicKey(dep.destination));
  };
}

async function keepTransferPayment(
  connection: Connection, dep: PendingDeposit, keepMint: PublicKey, destination: PublicKey,
): Promise<VerifiedPayment | null> {
  const res = await verifyKeepDeposit(connection, {
    reference: new PublicKey(dep.reference),
    keepMint,
    destination,
    expectedSigner: new PublicKey(dep.playerWallet),
    notBefore: dep.createdAt,
    paymentSignature: dep.paymentSignature,
    strictUncertainty: dep.kind === 'gems_buy',
  });
  if (!res) return null;
  return {
    txSignature: res.txSignature, wallet: dep.playerWallet, kind: dep.kind,
    lamports: res.amountBaseUnits, finalized: true,
  };
}

/**
 * SOL-payment verifier: a mine_build (new mine) AND a mine UPGRADE both pay SOL
 * DIRECTLY to the liquidity wallet (100%, not the 40/35/25 buy_sink split, owner
 * 2026-07-19/20), so this reads the liquidity wallet's lamport delta from the
 * reference-tagged tx. `lamports` carries the SOL received; creditDeposit
 * re-price-checks it against the level/count-appropriate price.
 */
export function makeSolPaymentVerifier(connection: Connection, destination: PublicKey): DepositVerifier {
  return async (dep) => {
    if (dep.kind !== 'mine_build' && dep.kind !== 'mine' && dep.kind !== 'expansion' && dep.kind !== 'keep_vend') return null;
    const res = await verifySolPayment(connection, {
      reference: new PublicKey(dep.reference),
      destination,
      expectedSigner: new PublicKey(dep.playerWallet),
      expectedLamports: dep.expectedLamports,
      notBefore: dep.createdAt,
      paymentSignature: dep.paymentSignature,
    });
    if (!res) return null;
    return {
      txSignature: res.txSignature, wallet: dep.playerWallet, kind: dep.kind,
      lamports: res.lamports, finalized: true,
    };
  };
}

/** An exact frozen quote wins regardless of signature ordering. If every
 * attempt is wrong, retain the historical highest-value fallback so the paid
 * but ungrantable attempt is recorded for operator resolution after the TTL. */
export function selectProgramPaymentCandidate<T extends { lamports: bigint }>(
  candidates: readonly T[], expectedLamports?: bigint,
): T {
  if (expectedLamports !== undefined) {
    const exact = candidates.find((candidate) => candidate.lamports === expectedLamports);
    if (exact) return exact;
  }
  return [...candidates].sort((a, b) => (
    b.lamports > a.lamports ? 1 : b.lamports < a.lamports ? -1 : 0
  ))[0]!;
}

/**
 * Warzone-shield verifier (#49): the 10 SOL is paid in ONE tx as TWO legs — a
 * direct SystemProgram transfer of ~5 SOL to the liquidity wallet, PLUS a
 * buy_sink(kind=6, ~5 SOL) that the program splits 40/35/25. This confirms BOTH
 * legs on the SAME reference tx and enforces each half is at/above its 50% target
 * (so the "50% straight to liquidity + 50% usual split" routing is real, not e.g.
 * 9 SOL to one leg). The liquidity wallet's total delta = the direct leg + 40% of
 * the split leg, so we reconstruct the direct amount by subtracting that 40%.
 */
/**
 * PURE security-critical core: given the liquidity wallet's TOTAL lamport delta on
 * the tx and the buy_sink split-leg amount, reconstruct the direct-transfer leg and
 * decide whether BOTH halves meet their 50% targets. The liquidity delta = the
 * direct leg + ECONOMY.solSplitBps.liquidity% of the split leg (buy_sink routes 40%
 * of its half to liquidity too), so direct = delta − that 40%. Rejects a lopsided
 * pay (e.g. 9 SOL direct + 1 SOL buy_sink) because the split leg falls under its half.
 */
export function verifyWarzoneSplit(liquidityDelta: bigint, splitLamports: bigint): { ok: boolean; total: bigint } {
  const directExpected = (BigInt(WARZONE.shieldCostSolLamports) * BigInt(WARZONE.shieldLiquidityDirectBps)) / 10_000n;
  const splitExpected = BigInt(WARZONE.shieldCostSolLamports) - directExpected;
  const liqFromSplit = (splitLamports * BigInt(ECONOMY.solSplitBps.liquidity)) / 10_000n;
  const directLeg = liquidityDelta > liqFromSplit ? liquidityDelta - liqFromSplit : 0n;
  const ok = splitLamports >= splitExpected && directLeg >= directExpected;
  return { ok, total: splitLamports + directLeg };
}

export function makeWarzoneShieldVerifier(
  connection: Connection, liquidity: PublicKey,
  parseEvents: typeof parsePaymentMadeEvents = parsePaymentMadeEvents,
): DepositVerifier {
  return async (dep) => {
    if (dep.kind !== 'warzone_shield') return null;
    const reference = new PublicKey(dep.reference);
    const signer = dep.playerWallet;
    const destination = liquidity.toBase58();
    // Inspect both legs on every candidate transaction. Selecting a direct-SOL
    // payment first let a newer direct-only retry shadow an older valid two-leg
    // payment carrying the same public reference.
    let incompletePayment = false;
    for await (const { signature, tx } of finalizedPaymentTransactions(
      connection, reference, dep.createdAt, dep.paymentSignature,
    )) {
      if (dep.basePurchaseV1) {
        const events = parseEvents(tx.meta?.logMessages ?? []).filter(event => event.reference === dep.reference
          && event.wallet === dep.playerWallet && KIND_BY_CODE[event.kind] === 'warzone_shield');
        if (events.some(event => matchesBasePurchaseWarzoneTransaction(tx, dep.basePurchaseV1!, event.lamports))) {
          return { txSignature: signature, wallet: dep.playerWallet, kind: 'warzone_shield',
            lamports: BigInt(dep.basePurchaseV1.amountLamports), finalized: true };
        }
        // A real split payment is not evidence of an unpaid reference merely
        // because its other leg is absent or differs. Preserve reconciliation.
        if (events.length || basePurchaseWarzoneDirectLamports(tx, dep.basePurchaseV1).length) incompletePayment = true;
        continue;
      }
      const msg = tx.transaction.message as unknown as {
        staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[];
      };
      const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
      if (keys[0]?.toBase58() !== signer) continue;
      const destinationIndex = keys.findIndex((key) => key.toBase58() === destination);
      if (destinationIndex < 0) continue;
      const liquidityDelta = BigInt(tx.meta?.postBalances?.[destinationIndex] ?? 0)
        - BigInt(tx.meta?.preBalances?.[destinationIndex] ?? 0);
      if (liquidityDelta <= 0n) continue;
      const splits = parseEvents(tx.meta?.logMessages ?? []).filter(
        (event) => event.reference === dep.reference && event.wallet === dep.playerWallet
          && KIND_BY_CODE[event.kind] === 'warzone_shield',
      );
      for (const split of splits) {
        const { ok, total } = verifyWarzoneSplit(liquidityDelta, split.lamports);
        if (ok) {
          return {
            txSignature: signature, wallet: dep.playerWallet, kind: 'warzone_shield',
            lamports: total, finalized: true,
          };
        }
      }
    }
    if (incompletePayment) throw new DepositVerificationIndeterminateError(dep.reference);
    return null;
  };
}

export interface CombinedDepositVerifierOpts {
  liquidity?: PublicKey | null;
  hot?: { keepMint: PublicKey; pubkey: PublicKey } | null;
  basePurchaseNetwork?: BasePurchaseNetwork;
}

/** One DepositVerifier that routes by kind: KEEP deposits and gems_buy use the
 *  SPL-transfer verifier (custody ATA / emission-reserve ATA), mine_build/mine/
 *  expansion the direct-SOL-to-liquidity verifier, warzone_shield the two-leg
 *  verifier, everything else the program-event verifier. */
export function combineDepositVerifiers(
  program: DepositVerifier, keep: DepositVerifier, solPayment: DepositVerifier, warzoneShield: DepositVerifier,
  gemsBuy: DepositVerifier = async () => null,
): DepositVerifier {
  return (dep) => {
    if (dep.kind === 'keep_deposit') return keep(dep);
    if (dep.kind === 'gems_buy') return gemsBuy(dep);
    if (dep.kind === 'mine_build' || dep.kind === 'mine' || dep.kind === 'expansion' || dep.kind === 'keep_vend') return solPayment(dep);
    if (dep.kind === 'warzone_shield') return warzoneShield(dep);
    return program(dep);
  };
}

/**
 * Build the FULL combined deposit verifier from the finalized connection + the
 * (optional) liquidity wallet and hot wallet. The server's on-demand route AND
 * the BullMQ backstop worker MUST both use this — a program-only verifier (the
 * old worker) actively EXPIRES paid direct-SOL/SPL deposits (mine_build, mine,
 * keep_deposit) for abandoned sessions. Sharing one factory prevents that drift.
 */
export function makeCombinedDepositVerifier(
  connection: Connection,
  opts: CombinedDepositVerifierOpts,
): DepositVerifier {
  const noop: DepositVerifier = async () => null;
  const program = makeChainDepositVerifier(connection);
  const solPayment = opts.liquidity ? makeSolPaymentVerifier(connection, opts.liquidity) : noop;
  const keep = opts.hot ? makeKeepDepositVerifier(connection, opts.hot.keepMint, opts.hot.pubkey) : noop;
  const warzoneShield = opts.liquidity ? makeWarzoneShieldVerifier(connection, opts.liquidity) : noop;
  // gems_buy needs no config here: its destination/mint travel with the row.
  const gemsBuy = makeGemsBuyVerifier(connection);
  const combined = combineDepositVerifiers(program, keep, solPayment, warzoneShield, gemsBuy);
  return async dep => {
    if (dep.basePurchaseV1) {
      assertBasePurchaseNetwork(dep.basePurchaseV1, opts.basePurchaseNetwork);
      if (opts.liquidity?.toBase58() !== dep.basePurchaseV1.rail.treasuryLiquidity) throw new Error('versioned deposit treasury is unavailable');
    }
    const payment = await combined(dep);
    return payment && dep.basePurchaseV1 ? { ...payment, basePurchaseV1: dep.basePurchaseV1 } : payment;
  };
}

/** Exact CONFIRMED proof used by POST /deposits/:id/paid before persisting a
 * signature. It deliberately performs no reference-history fallback: a public
 * signature cannot reserve another intent unless this exact transaction proves
 * its wallet, reference, kind, destination, and frozen quote. */
export function makeCombinedDepositCommitVerifier(
  connection: Connection,
  opts: CombinedDepositVerifierOpts,
  parseEvents: typeof parsePaymentMadeEvents = parsePaymentMadeEvents,
): DepositPaymentCommitVerifier {
  return async (dep) => {
    if (dep.basePurchaseV1) {
      assertBasePurchaseNetwork(dep.basePurchaseV1, opts.basePurchaseNetwork);
      if (opts.liquidity?.toBase58() !== dep.basePurchaseV1.rail.treasuryLiquidity) throw new Error('versioned deposit treasury is unavailable');
    }
    const reference = new PublicKey(dep.reference);
    const signer = new PublicKey(dep.playerWallet);
    if (dep.kind === 'keep_deposit') {
      if (!opts.hot) return null;
      return verifyKeepDepositCommit(connection, {
        reference, keepMint: opts.hot.keepMint, destination: keepAta(opts.hot.pubkey, opts.hot.keepMint),
        expectedSigner: signer, paymentSignature: dep.paymentSignature,
      });
    }
    if (dep.kind === 'gems_buy') {
      // Frozen in the row at creation — never the live env (security review #1).
      if (!dep.destination || !dep.mint) return null;
      return verifyKeepDepositCommit(connection, {
        reference, keepMint: new PublicKey(dep.mint), destination: new PublicKey(dep.destination),
        expectedSigner: signer, paymentSignature: dep.paymentSignature,
      });
    }
    if (dep.kind === 'mine_build' || dep.kind === 'mine' || dep.kind === 'expansion' || dep.kind === 'keep_vend') {
      if (!opts.liquidity) return null;
      return verifySolPaymentCommit(connection, {
        reference, destination: opts.liquidity, expectedSigner: signer,
        expectedLamports: dep.expectedLamports, paymentSignature: dep.paymentSignature,
      });
    }

    const tx = await connection.getTransaction(dep.paymentSignature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) return null;
    const events = dep.basePurchaseV1 && dep.kind !== 'warzone_shield' && !matchesBasePurchaseBuilderTransaction(tx, dep.basePurchaseV1) ? [] : parseEvents(tx.meta?.logMessages ?? []);
    if (dep.kind === 'warzone_shield') {
      if (!opts.liquidity) return null;
      if (dep.basePurchaseV1) {
        return events.some(event => event.reference === dep.reference && event.wallet === dep.playerWallet
          && KIND_BY_CODE[event.kind] === 'warzone_shield'
          && matchesBasePurchaseWarzoneTransaction(tx, dep.basePurchaseV1!, event.lamports))
          ? { txSignature: dep.paymentSignature } : null;
      }
      const msg = tx.transaction.message as unknown as {
        staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[];
      };
      const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
      if (keys[0]?.toBase58() !== dep.playerWallet) return null;
      const destinationIndex = keys.findIndex((key) => key.equals(opts.liquidity!));
      if (destinationIndex < 0) return null;
      const liquidityDelta = BigInt(tx.meta?.postBalances?.[destinationIndex] ?? 0)
        - BigInt(tx.meta?.preBalances?.[destinationIndex] ?? 0);
      for (const event of events) {
        if (event.reference !== dep.reference || event.wallet !== dep.playerWallet
          || KIND_BY_CODE[event.kind] !== 'warzone_shield') continue;
        const split = verifyWarzoneSplit(liquidityDelta, event.lamports);
        if (split.ok && (dep.expectedLamports === undefined || split.total === dep.expectedLamports)) {
          return { txSignature: dep.paymentSignature };
        }
      }
      return null;
    }
    const exact = events.find((event) => event.reference === dep.reference
      && event.wallet === dep.playerWallet && KIND_BY_CODE[event.kind] === dep.kind
      && (dep.expectedLamports === undefined || event.lamports === dep.expectedLamports));
    return exact ? { txSignature: dep.paymentSignature } : null;
  };
}

type DepositRow = typeof deposits.$inferSelect;

/** Publish a newly credited parcel to both shared world views. Credit has already
 * committed when this runs: external initialization must stay outside the money
 * transaction, and the unique plots(base_id) identity gives us the exact valley
 * without trusting the watcher's earlier, unlocked deposit snapshot. */
async function invalidateCreditedLandCaches(db: Db, baseId: string): Promise<void> {
  const rows = await db.select({ valleyId: plots.valleyId }).from(plots)
    .where(eq(plots.baseId, baseId)).limit(2);
  if (rows.length !== 1) {
    throw new Error(`credited land base ${baseId} has ${rows.length} plots`);
  }
  invalidateGlobe();
  if (rows[0]!.valleyId) invalidateValley(rows[0]!.valleyId);
}

/** Mark a never-paid pending deposit expired. The unlocked watcher snapshot is
 * not authoritative: `/paid` may have committed an exact CONFIRMED signature
 * while RPC finality was still unavailable. Follow the shared player→deposit
 * lock order, then refuse terminal expiry when the locked row is known-paid. */
async function expireDeposit(db: Db, id: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [preview] = await tx.select({ wallet: deposits.playerWallet }).from(deposits)
      .where(eq(deposits.id, id));
    if (!preview) return 0;
    // The verification lease is an outer serialization root, acquired before
    // the canonical player→optional base→signature→deposit row-lock chain.
    await lockDepositVerification(tx, id);
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, preview.wallet)).for('update');
    if (!player) return 0;
    const [claim] = await tx.select({ baseId: fantasyLandClaims.baseId }).from(fantasyLandClaims)
      .where(eq(fantasyLandClaims.depositId, id));
    if (claim) await tx.select().from(bases).where(eq(bases.id, claim.baseId)).for('update');
    const [locked] = await tx.select({ paymentSignature: deposits.paymentSignature }).from(deposits)
      .where(and(eq(deposits.id, id), eq(deposits.status, 'pending'))).for('update');
    if (!locked || locked.paymentSignature) return 0;
    await allowBasePurchaseTerminal(tx, id);
    const res = await tx.update(deposits).set({ status: 'expired' })
      .where(and(
        eq(deposits.id, id), eq(deposits.status, 'pending'), isNull(deposits.paymentSignature),
      ))
      .returning({ id: deposits.id });
    if (res.length > 0) {
      await tx.update(plotReservations).set({ state: 'expired' })
        .where(and(eq(plotReservations.depositId, id), eq(plotReservations.state, 'reserved')));
      await releaseExpiredFantasyClaim(tx, id);
    }
    return res.length;
  });
}

/** Terminal fail for a PAID-but-un-grantable deposit: records the on-chain proof
 *  (signature + amount) so ops can resolve it (refund or manual grant) and the
 *  client stops polling. Idempotent — affects pending rows or an expired Gems
 *  original whose late positive proof cannot be credited. */
async function markDepositFailed(
  db: Db, id: string, payment: VerifiedPayment, now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [preview] = await tx.select({ wallet: deposits.playerWallet }).from(deposits)
      .where(eq(deposits.id, id));
    if (!preview) return false;
    await lockDepositVerification(tx, id);
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, preview.wallet)).for('update');
    if (!player) return false;
    await lockUnusedDepositSignature(tx, id, payment.txSignature);
    const [pending] = await tx.select().from(deposits)
      .where(and(eq(deposits.id, id), recoverableDepositPaymentSql())).for('update');
    if (!pending) return false;
    await assertBasePurchasePayment(tx, pending, payment);
    const res = await tx.update(deposits)
      .set({ status: 'failed', txSignature: payment.txSignature, amount: payment.lamports, finalizedAt: now })
      .where(and(eq(deposits.id, id), recoverableDepositPaymentSql()))
      .returning({ id: deposits.id });
    if (res.length > 0) {
      await tx.update(plotReservations).set({ state: 'failed' })
        .where(and(eq(plotReservations.depositId, id), eq(plotReservations.state, 'reserved')));
    }
    return res.length > 0;
  });
}

/**
 * Verify + credit ONE eligible deposit. Expired Gems are explicit recovery only.
 * Shared by the poll job and the on-demand route so both behave identically.
 */
async function processDeposit(
  db: Db, verify: DepositVerifier, dep: DepositRow, now: Date,
): Promise<'credited' | 'expired' | 'redundant' | 'failed' | 'none'> {
  const releasePermit = await acquireDepositVerificationPermit();
  let scanned: Awaited<ReturnType<typeof processDepositUnderSharedLease>>;
  try {
    scanned = await db.transaction(async (tx) => {
      // Positive verifiers and `/paid` share this fence across RPC and their
      // durable transition. A negative scan releases it before asking the
      // exclusive terminal fence to expire, so `/paid` is never starved behind
      // a stale FINALIZED view and terminalization waits for in-flight proofs.
      await lockDepositVerificationShared(tx, dep.id);
      return processDepositUnderSharedLease(verify, dep, now, tx);
    });
  } finally {
    releasePermit();
  }
  if (scanned.action === 'credited') {
    if (scanned.shieldMapInvalidation) {
      invalidateShieldMapValley(scanned.shieldMapInvalidation.valleyId);
    }
    if (scanned.landActivated) {
      const stableBaseId = scanned.baseId;
      if (!stableBaseId) throw new Error('entry credit did not materialize a stable base');
      try {
        await invalidateCreditedLandCaches(db, stableBaseId);
      } catch (error) {
        // Credit is already committed and remains the authority. A cache-publish
        // fault must not skip starter-base initialization or durable deed mint
        // recovery; both caches expire naturally, while the invariant failure is
        // loud enough for operators to investigate.
        console.error(`[deposit] credited land cache publish failed for ${stableBaseId}:`, error);
      }
      const { ensureStartingBase } = await import('../game/base');
      await ensureStartingBase(db, dep.playerWallet, stableBaseId);
      const { mintDeedIfConfigured } = await import('../game/deed');
      void mintDeedIfConfigured(db, dep.playerWallet, stableBaseId);
      const siblings = await db.select({ id: deposits.id }).from(deposits)
        .where(and(
          eq(deposits.playerWallet, dep.playerWallet),
          eq(deposits.kind, 'entry'),
          eq(deposits.status, 'pending'),
          ne(deposits.id, dep.id),
        ));
      for (const sibling of siblings) await expireDeposit(db, sibling.id);
    }
    return 'credited';
  }
  if (scanned.action !== 'terminal') return scanned.action;
  if (scanned.payment) {
    const failed = await markDepositFailed(db, dep.id, scanned.payment, now);
    return failed ? 'failed' : 'none';
  }
  const n = await expireDeposit(db, dep.id);
  return n > 0 ? scanned.redundant ? 'redundant' : 'expired' : 'none';
}

async function processDepositUnderSharedLease(
  verify: DepositVerifier, dep: DepositRow, now: Date, lease: DbTx,
): Promise<
  | {
    action: 'credited';
    landActivated: boolean;
    baseId?: string;
    shieldMapInvalidation?: { valleyId: string | null };
  }
  | { action: 'none' }
  | { action: 'terminal'; redundant?: boolean; payment?: VerifiedPayment }
> {
  const [current] = await lease.select().from(deposits)
    .where(and(eq(deposits.id, dep.id), recoverableDepositPaymentSql()));
  if (!current) return { action: 'none' };
  dep = current;
  const basePurchaseV1 = originalBasePurchase(dep);
  const frozenTarget = dep.payload as DepositPayload | null;
  const pending: PendingDeposit = {
    id: dep.id, playerWallet: dep.playerWallet, kind: dep.kind as DepositKind,
    reference: dep.reference, createdAt: dep.createdAt,
    ...(dep.paymentSignature ? { paymentSignature: dep.paymentSignature } : {}),
    ...(basePurchaseV1 ? { basePurchaseV1 } : {}),
    ...(frozenTarget?.destination ? { destination: frozenTarget.destination } : {}),
    ...(frozenTarget?.mint ? { mint: frozenTarget.mint } : {}),
  };
  const frozenAmount = (dep.payload as DepositPayload | null)?.amountLamports;
  if (Number.isSafeInteger(frozenAmount) && frozenAmount !== undefined) {
    pending.expectedLamports = BigInt(frozenAmount);
  }

  // A redundant entry intent (the wallet already paid via another intent, e.g.
  // a double-click before the fix) must not re-credit or collide on the
  // synthetic `pda:` signature — close it so it stops being retried forever.
  const frozenLandEligibility = (dep.payload as DepositPayload | null)?.landPurchaseVersion === 1;
  if (dep.kind === 'entry' && !frozenLandEligibility && !dep.paymentSignature
    && await entryPurchaseConsumed(lease, dep.playerWallet)) {
    return { action: 'terminal', redundant: true };
  }

  const payment = await withDepositVerificationDeadline(
    () => verify(pending), 'deposit verification attempt timed out',
  );
  if (payment) {
    // A mismatched wallet/kind is a verifier CONTRACT VIOLATION, not a grantable
    // payment — the real verifier matches on reference+wallet+kind, so this can't
    // happen in prod. Surface it LOUDLY (don't fall into the strand-fail path,
    // which is only for genuine can't-apply-the-effect cases).
    if (payment.wallet !== dep.playerWallet || payment.kind !== (dep.kind as DepositKind)) {
      throw new Error(`verifier returned a mismatched payment for deposit ${dep.id}`);
    }
    // A verifier/configuration mismatch is uncertainty, never stranded-paid
    // evidence that may consume the original quote after its TTL.
    await assertBasePurchasePayment(lease, dep, payment);
    try {
      const res = await creditDeposit(
        lease, dep.id, payment, now, { deferMapInvalidation: true },
      );
      // Gate base creation on the credit that actually STAMPED entryPaidAt, not
      // merely on credited — two concurrent verify calls both credit distinct
      // deposit rows, but only one wins the players IS-NULL update, so only it
      // creates the base (security review FINDING 2 — no duplicate Keeps).
      if (res.landActivated) {
        return {
          action: 'credited', landActivated: true,
          ...(res.baseId ? { baseId: res.baseId } : {}),
          ...(res.shieldMapInvalidation
            ? { shieldMapInvalidation: res.shieldMapInvalidation }
            : {}),
        };
      }
      return res.credited
        ? {
          action: 'credited', landActivated: false,
          ...(res.shieldMapInvalidation
            ? { shieldMapInvalidation: res.shieldMapInvalidation }
            : {}),
        }
        : { action: 'none' };
    } catch (error) {
      if (error instanceof HttpError && error.code === 'BASE_BEING_RAIDED') {
        return { action: 'none' };
      }
      // The payment IS verified on-chain but the grant couldn't apply — either a
      // TRANSIENT block that self-heals (e.g. a KEEP shortfall once the player
      // tops up) or a PERMANENT mismatch (the target Mine was destroyed, or its
      // level advanced past the paid price). Fall through: retry within the TTL,
      // then strand-FAIL below (recording the payment) so the SOL is never lost
      // silently — never re-throw here, which would leave it stuck pending.
    }
  }

  const ttlMs = ECONOMY.depositPendingTtlMin * 60_000;
  if (now.getTime() - dep.createdAt.getTime() > ttlMs) {
    // `/paid` persisted this signature only after exact CONFIRMED proof. It may
    // legitimately take longer than the intent TTL to reach FINALIZED (or RPC
    // finality may be temporarily unavailable). Never classify that known-paid
    // intent as unpaid/expired; keep it fail-closed and retry exact settlement.
    if (dep.paymentSignature && !payment) return { action: 'none' };
    // Past the TTL. If a finalized payment exists but we still couldn't grant,
    // it is STRANDED-PAID → terminal 'failed' (surfaced for ops to resolve),
    // NOT a silent 'expired'. No visible payment may expire admission, but is
    // never a negative proof that an attempted transfer did not land. Gems
    // originals remain explicitly recoverable by positive proof after expiry.
    if (payment) {
      return { action: 'terminal', payment };
    }
    return { action: 'terminal' };
  }
  return { action: 'none' };
}

/**
 * One watcher pass over ALL pending deposits (BullMQ backstop). Never throws
 * for a single bad deposit — failures are counted and retried next pass.
 */
export async function pollPendingDeposits(
  db: Db, verify: DepositVerifier, now = new Date(),
): Promise<{ checked: number; credited: number; expired: number; failed: number; errors: number }> {
  const pending = await db.select().from(deposits).where(eq(deposits.status, 'pending'));
  let credited = 0;
  let expired = 0;
  let failed = 0;
  let errors = 0;
  for (const dep of pending) {
    try {
      const r = await processDeposit(db, verify, dep, now);
      if (r === 'credited') credited++;
      else if (r === 'expired' || r === 'redundant') expired++;
      else if (r === 'failed') failed++; // paid-but-stranded — ops resolves
    } catch {
      errors++; // aggregate fail-loud; the row stays pending for retry
    }
  }
  return { checked: pending.length, credited, expired, failed, errors };
}

/**
 * On-demand verification for a SINGLE deposit, driven by the client's poll
 * (POST /deposits/:id/verify). This is what makes the entry flow live without
 * the background worker (incident 2026-07-18). Settled/failed rows are no-ops;
 * expired Gems originals can still recover positive proof.
 */
export async function verifyDepositNow(
  db: Db, verify: DepositVerifier, wallet: string, depositId: string, now = new Date(),
): Promise<{ action: 'credited' | 'expired' | 'redundant' | 'failed' | 'none' }> {
  const [dep] = await db.select().from(deposits)
    .where(and(eq(deposits.id, depositId), eq(deposits.playerWallet, wallet)));
  if (!dep || !depositPaymentRecoverable(dep)) return { action: 'none' };
  return { action: await processDeposit(db, verify, dep, now) };
}
