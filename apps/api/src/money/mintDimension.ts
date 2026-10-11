/**
 * PER-MINT LEDGER DIMENSION (security review 2026-07-28, KEEP mint rotation).
 *
 * The KEEP mint has rotated twice on devnet — legacy `8u6x…` → v2 `2yuk…` →
 * v3 `5GQh…` — while `deposits` / `withdrawals` recorded only an AMOUNT. The
 * result: 13,959 KEEP of on-chain outflow spread across at least two different
 * SPL tokens with no way to attribute any of it, so "how much of mint X do we
 * still owe / still hold" is not answerable from the books at all. That is a
 * reserve question, and on mainnet it is the only question that matters.
 *
 * This module is the ONE place that answers "which token is this row counting".
 * It is BOOKKEEPING: nothing here gates, prices or moves money — a null answer
 * writes a null column and the payout proceeds exactly as before.
 *
 * The mint is read from the selected cluster's exact public address registry at
 * WRITE time (not cached): that file is the authoritative record of the current
 * mint, it is what `makeHotWalletKeepSender` and the deposit verifier read, and
 * a rotation edits it. Reading it per credit costs one small sync file read on a
 * path that runs a handful of times an hour.
 */
import path from 'node:path';
import { loadAddresses, type GameSolanaCluster } from '@shardkeep/chain';
import type { DepositKind } from './deposits';

/** Wrapped-SOL mint address — the canonical way to name "native SOL" in a mint
 *  column, so a lamport row and a KEEP row are distinguishable by value alone
 *  instead of by re-deriving the currency from `kind`. */
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Deposit kinds whose `amount` is denominated in KEEP base units. Everything
 *  else is lamports — including `keep_vend`, where the player pays SOL and the
 *  KEEP they receive is a LEDGER credit that never touches an SPL mint (that
 *  gap is AUDIT-FIX-PLAN B1, tracked separately; do not paper over it here by
 *  labelling the row with the KEEP mint). */
const KEEP_DENOMINATED: ReadonlySet<DepositKind> = new Set<DepositKind>(['keep_deposit', 'gems_buy']);

function repoRoot(): string {
  return process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
}

function selectedCluster(): GameSolanaCluster {
  const cluster = process.env['SOLANA_CLUSTER'] ?? 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new Error(`unsupported SOLANA_CLUSTER=${cluster}`);
  }
  return cluster;
}

/**
 * The KEEP mint in force RIGHT NOW, or null when the addresses file is absent
 * (tests, a fresh checkout). Null is recorded as NULL — an unknown mint must
 * look unknown in the books rather than be guessed.
 */
export function currentKeepMint(cluster: GameSolanaCluster = selectedCluster()): string | null {
  return loadAddresses(repoRoot(), cluster)?.keepMint ?? null;
}

/** Which token a credited deposit's `amount` counts. */
export function depositMint(kind: DepositKind, cluster?: GameSolanaCluster): string | null {
  return KEEP_DENOMINATED.has(kind) ? currentKeepMint(cluster) : NATIVE_SOL_MINT;
}
