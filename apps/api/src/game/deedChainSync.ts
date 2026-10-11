/**
 * Land Deed ON-CHAIN metadata sync — the half that makes "dynamic" actually
 * reach a wallet.
 *
 * ── WHY THIS EXISTS ──
 * deedR2.ts keeps each deed's JSON document and base picture current. That was
 * never enough, and the gap is not obvious: wallets and explorers do not fetch
 * a deed's URI. They read a DAS indexer, and DAS re-fetches a document only
 * when something ON CHAIN changes. A deed whose URI never moves keeps showing
 * whatever DAS cached at mint — forever.
 *
 * Measured on devnet 2026-08-03: R2 served Keep 17 / 111 buildings while the
 * on-chain URI was correct, and every wallet and the Solana explorer showed
 * Keep 15 / 85 with no mechanism that would ever have corrected it. Nothing was
 * broken; the design simply had no way to tell an indexer to look again.
 *
 * So: when a deed's document changes, write a new versioned URI on chain. That
 * is the only signal an indexer acts on, and it costs one transaction.
 *
 * ── WHY IT IS SEPARATE FROM deedR2 ──
 * Different cadence and a different failure budget. R2 is free and idempotent,
 * so it sweeps every 60s. This SPENDS SOL and signs with the deed authority, so
 * it runs far slower and coalesces: a player who moves six buildings in a
 * minute produces one on-chain write, not six. Keeping them apart also means an
 * RPC outage or an empty fee payer degrades the on-chain leg while traits and
 * pictures keep publishing normally.
 *
 * ── COST, MEASURED NOT ESTIMATED ──
 * A Core `update` is small and the cost is dominated by the per-signature fee,
 * so batching divides it. Measured against devnet with a 123-char URI:
 * exactly 6 updates per transaction. At 5,000 lamports per signature that is
 * ~833 lamports per deed, i.e. roughly 0.5 SOL/month for 20k players on the
 * default daily cadence. The batch size is discovered at build time by
 * `unsafeSplitByTransactionSize`, never hardcoded.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──
 * It never touches owner, plugins, royalties or the freeze delegate. Only the
 * URI. INV-1 still stands: gameplay never reads deed or DAS state, so nothing
 * here can affect a raid, a claim or a balance — it is presentation only.
 */
import { createHash } from 'node:crypto';

/** Solana address shape — same test the deed routes and the R2 key guard use. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
import { and, gt, isNotNull } from 'drizzle-orm';
import {
  deedJsonUriVersioned, deedUriVersion, updateLandDeedUris, type DeedUriUpdate,
} from '@shardkeep/chain';
import type { Db } from '../db/client';
import { bases, players } from '../db/schema';
import { publishedDeedDoc } from './deedR2';
import { multiBaseEnabled } from '../config';
import { fantasyPublishingScope, retiredMintPublishingScope, retiredWalletPublishingScope } from './fantasyPublishing';

export interface DeedChainConfig {
  rpcUrl: string;
  adminSecret: Uint8Array;
  collection: string;
  /** Public base the deed JSON is served from — must match what was minted. */
  publicBaseUrl: string;
}

/**
 * How often to reconcile the chain. An order of magnitude slower than the R2
 * sweep on purpose: this one spends money, and nobody needs sub-minute
 * freshness on a wallet display. Every change still lands — it just rides the
 * next tick, and several changes to one base collapse into a single write.
 */
export const DEFAULT_CHAIN_SYNC_MS = 10 * 60_000;

/**
 * Do not spend below this. The admin key is SHARED: it also posts epoch roots
 * (the merkle distributor / proof-of-reserves path) and mints new players'
 * deeds. Those are money and onboarding; this loop is presentation. Draining
 * the payer for cosmetics would stop root posting and stop new deeds, and the
 * only symptom would be an error every 10 minutes in a log nobody reads.
 *
 * A floor, not a budget: the loop simply declines to run while the balance is
 * low, and says so.
 */
export const MIN_PAYER_SOL = 0.05;

/**
 * Worst-case spend is structurally capped and worth stating, because it is the
 * ONLY rate limit: the cursor visits each deed at most once per lap, so the
 * ceiling is SWEEP_BATCH per interval regardless of how hard players thrash
 * their bases — 200 per 10 min = 28,800 writes/day ≈ 0.024 SOL/day fleet-wide
 * at 6 updates per transaction. Changing either constant changes that ceiling.
 */

/** Deeds inspected per tick. Each costs ~2 DB reads plus a share of one RPC
 *  multi-fetch, so this is cheap; the ceiling exists so a large fleet spreads
 *  across ticks instead of one long stall, matching deedR2's cursor. */
const SWEEP_BATCH = 200;

/** The version stamped into a deed's URI: a hash of the document a wallet would
 *  render. Changes iff the displayed content changes, which is what makes the
 *  updater idempotent — same content, same URI, nothing to write. */
export function metadataVersion(metadataJson: string): string {
  return createHash('sha256').update(metadataJson).digest('hex').slice(0, 8);
}

export interface ChainSweepResult {
  /** Deeds whose on-chain URI was rewritten. */
  updated: number;
  /** Transactions sent. `updated / txs` is the batching win. */
  txs: number;
  /** Deeds already carrying the right version — the steady state. */
  current: number;
  /** Asset ids the chain could not produce (burned, or a bad id in the DB). */
  missing: string[];
  /** Asset ids whose transaction failed to confirm. They retry next lap. */
  failed: string[];
  /** Last asset id visited, for the cursor. */
  cursor: string | undefined;
}

/**
 * One reconcile pass. Exported for tests; the loop below just calls it.
 *
 * `sendUpdates` is the injection seam — the real one signs and pays, so tests
 * must never reach it by accident.
 */
export async function sweepDeedChain(
  db: Db,
  cfg: Pick<DeedChainConfig, 'publicBaseUrl'>,
  sendUpdates: (updates: readonly DeedUriUpdate[]) => Promise<{
    updated: number; txs: number; alreadyCurrent: number; missing: string[]; failed?: string[];
  }>,
  opts: {
    after?: string; limit?: number;
    /** Injection seam: the last PUBLISHED document for an asset. Defaults to
     *  the live R2 loop's record. */
    published?: (assetId: string) => string | null;
  } = {},
): Promise<ChainSweepResult> {
  const published = opts.published ?? publishedDeedDoc;
  const rows = multiBaseEnabled()
    ? await db.select({ assetId: bases.deedAssetId }).from(bases)
      .where(opts.after !== undefined
        ? and(isNotNull(bases.deedAssetId), gt(bases.deedAssetId, opts.after), fantasyPublishingScope())
        : and(isNotNull(bases.deedAssetId), fantasyPublishingScope()))
      .orderBy(bases.deedAssetId).limit(opts.limit ?? SWEEP_BATCH)
    : await db.select({ assetId: players.deedAssetId }).from(players)
      .where(opts.after !== undefined
        ? and(isNotNull(players.deedAssetId), gt(players.deedAssetId, opts.after), retiredMintPublishingScope(players.deedAssetId), retiredWalletPublishingScope(players.wallet))
        : and(isNotNull(players.deedAssetId), retiredMintPublishingScope(players.deedAssetId), retiredWalletPublishingScope(players.wallet)))
      .orderBy(players.deedAssetId).limit(opts.limit ?? SWEEP_BATCH);

  const wanted: DeedUriUpdate[] = [];
  const skipped: string[] = [];
  let cursor: string | undefined;
  for (const { assetId } of rows) {
    cursor = assetId!;
    // Cheap shape filter before an asset id becomes an on-chain write target.
    // It cannot redirect a write — mpl-core requires the asset belong to our
    // collection — but a corrupt row would otherwise ride into the batch and
    // fail it. Same regex the deed routes and the R2 key guard already use.
    if (!BASE58_ADDRESS.test(assetId!)) {
      console.warn(`[deed-chain] skipping malformed deed_asset_id: ${JSON.stringify(assetId)}`);
      continue;
    }
    // Version WHAT WAS PUBLISHED, not what is currently true. Hashing the live
    // DB would advertise a version for bytes that do not exist yet: DAS reacts
    // within seconds, fetches the older document still sitting in R2, caches it,
    // and then never looks again because the on-chain URI already matches. That
    // is the original stale-deed bug wearing the fix as a disguise.
    //
    // It also fixes a second, quieter miss: the published document carries the
    // base picture's cache-buster, so hashing it means a LAYOUT-ONLY change (a
    // building moved — same traits, new picture) propagates. Hashing the DB
    // traits alone would never have moved the image, and the image is the whole
    // visual of the NFT.
    const doc = published(assetId!);
    if (doc === null) { skipped.push(assetId!); continue; }
    const version = metadataVersion(doc);
    wanted.push({ asset: assetId!, uri: deedJsonUriVersioned(cfg.publicBaseUrl, assetId!, version) });
  }
  if (skipped.length > 0) {
    // Not an error: the R2 loop simply has not reached these yet (or the process
    // restarted). They ride the next lap, by which time bytes exist.
    console.log(`[deed-chain] ${skipped.length} deed(s) awaiting first publish — will version next lap`);
  }

  if (wanted.length === 0) return { updated: 0, txs: 0, current: 0, missing: [], failed: [], cursor };
  const r = await sendUpdates(wanted);
  return {
    updated: r.updated, txs: r.txs, current: r.alreadyCurrent,
    missing: r.missing, failed: r.failed ?? [], cursor,
  };
}

/** Does this stored URI already carry `version`? Exported so an ops script can
 *  answer "is this deed current on chain" without sending anything. */
export function chainUriIsCurrent(storedUri: string, version: string): boolean {
  return deedUriVersion(storedUri) === version;
}

/**
 * Start the loop. Returns a stop handle.
 *
 * Non-overlapping and cursored, for the same reasons deedR2's loop is: an
 * overlapping pass would double-spend transactions for the same deeds, and an
 * unbounded scan would hold RPC and DB capacity behind live traffic.
 */
export function startDeedChainSync(
  db: Db, cfg: DeedChainConfig, intervalMs = DEFAULT_CHAIN_SYNC_MS,
  /** Injection seam for the payer balance check (tests, and ops tooling). */
  readBalanceSol: () => Promise<number> = () => payerBalanceSol(cfg),
): { stop(): void } {
  let cursor: string | undefined;
  let running = false;
  let skipped = 0;

  markDeedChainSyncRunning(intervalMs);

  const send = async (updates: readonly DeedUriUpdate[]): Promise<{
    updated: number; txs: number; alreadyCurrent: number; missing: string[];
  }> => updateLandDeedUris({
    rpcUrl: cfg.rpcUrl, adminSecret: cfg.adminSecret, collection: cfg.collection, updates,
    // Attended migrations only: updateLandDeedUris refuses a pass that moves
    // many URI origins/paths (follow-up #6) unless this is set. Read per pass,
    // not at boot, so tests can exercise it and a typo'd value fails the very
    // next tick instead of after a restart.
    allowRepoint: process.env['DEED_CHAIN_REURI'] === 'true',
  });

  const pass = async (): Promise<void> => {
    if (running) {
      // Log it. Silent skipping is how the R2 loop's five-day outage stayed
      // invisible, and this loop has the same shape: umi has no default HTTP
      // timeout, so a hung sendAndConfirm would pin `running` forever.
      if (++skipped % 5 === 1) console.warn(`[deed-chain] pass still running, skipped ${skipped} tick(s)`);
      return;
    }
    running = true;
    try {
      const sol = await readBalanceSol();
      if (sol < MIN_PAYER_SOL) {
        console.warn(
          `[deed-chain] payer at ${sol.toFixed(4)} SOL, below the ${MIN_PAYER_SOL} floor — skipping. `
          + 'This key also posts epoch roots and mints deeds; top it up before those stop too.',
        );
        // Recorded as a FAILURE, not a healthy skip: a permanently-empty payer
        // freezes every deed exactly like a dead loop would, and "an error every
        // 10 minutes in a log nobody reads" is the precise failure mode the
        // health endpoint exists to replace. The heartbeat does not advance, so
        // after the stale window /health goes red with this as lastError.
        recordDeedChainSweepError(new Error(
          `payer at ${sol.toFixed(4)} SOL is below the ${MIN_PAYER_SOL} SOL floor — deed URIs are frozen`,
        ));
        return;
      }
      const r = await sweepDeedChain(db, cfg, send, cursor === undefined ? {} : { after: cursor });
      cursor = r.cursor === undefined ? undefined : r.cursor;
      if (r.updated > 0) {
        console.log(`[deed-chain] rewrote ${r.updated} deed URI(s) in ${r.txs} tx(s)`);
      }
      if (r.missing.length > 0) {
        console.warn(`[deed-chain] ${r.missing.length} deed asset(s) not readable on chain:`, r.missing.slice(0, 5));
      }
      if (r.failed.length > 0) {
        console.warn(`[deed-chain] ${r.failed.length} deed(s) failed to confirm, retrying next lap:`, r.failed.slice(0, 5));
      }
      // Heartbeat on every completed sweep, including one that wrote nothing —
      // "no deed changed" is the healthy steady state, same rule as deedR2.
      recordDeedChainSweepOk(r.updated);
    } catch (e) {
      // Never throw out of the loop: this is presentation, and an RPC blip or an
      // empty fee payer must degrade the on-chain leg without touching the game.
      console.error('[deed-chain] sweep failed (retries next tick):', e);
      recordDeedChainSweepError(e);
    } finally {
      running = false;
    }
  };

  void pass();
  const timer = setInterval(() => { void pass(); }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Liveness (security review 2026-08-03 follow-up #5)
// ---------------------------------------------------------------------------

/**
 * Is the CHAIN leg actually alive? Same recorder pattern as deedR2's, for the
 * same reason: this loop's failure mode is silent. R2 keeps publishing, the
 * game stays healthy, and every wallet quietly freezes at the last URI that
 * made it on chain — which is indistinguishable from "working" until a player
 * looks at their own NFT. /health is the only place an uptime check can see it.
 *
 * The health signal is `lastSweepOkAt`, NOT "last write": most sweeps write
 * nothing because no deed changed, and that is the healthy steady state. What
 * must never happen is the loop stopping — or ticking while unable to spend
 * (empty payer), which the loop records as a failure so it goes red too.
 */
export interface DeedChainSyncStatus {
  /** Configured AND owned by this process — i.e. this loop should be ticking. */
  running: boolean;
  /** Why not, when running is false. Null when running. */
  disabledReason: string | null;
  /** Epoch ms of the last sweep that completed without throwing or skipping. */
  lastSweepOkAt: number | null;
  /** Epoch ms of the last sweep that threw (or declined below the SOL floor). */
  lastSweepErrorAt: number | null;
  lastError: string | null;
  /** Sweeps that have failed in a row. Resets on any success. */
  consecutiveFailures: number;
  /** Epoch ms a sweep last WROTE a URI on chain (informational, NOT health). */
  lastWriteAt: number | null;
  /** URIs rewritten since boot. */
  updatedTotal: number;
  /** Nominal ms between ticks, so `stale` has a basis. */
  intervalMs: number | null;
  /** Epoch ms the loop was started here — the grace clock before the first
   *  sweep lands, so a deploy does not serve 503 on the way up. */
  startedAt: number | null;
}

const chainSyncStatus: DeedChainSyncStatus = {
  running: false,
  disabledReason: 'not started',
  lastSweepOkAt: null,
  lastSweepErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastWriteAt: null,
  updatedTotal: 0,
  intervalMs: null,
  startedAt: null,
};

/** Mark why the chain sync is not running here. Called from server boot. */
export function setDeedChainSyncDisabled(reason: string): void {
  chainSyncStatus.running = false;
  chainSyncStatus.disabledReason = reason;
  chainSyncStatus.startedAt = null;
}

/** The loop is live on this process, ticking every `intervalMs`. */
export function markDeedChainSyncRunning(intervalMs: number, at = Date.now()): void {
  chainSyncStatus.running = true;
  chainSyncStatus.disabledReason = null;
  chainSyncStatus.intervalMs = intervalMs;
  chainSyncStatus.startedAt = at;
  // A restart genuinely resets the heartbeat: the previous process's last-ok
  // stamp says nothing about whether THIS one is sweeping.
  chainSyncStatus.lastSweepOkAt = null;
}

/** A sweep completed. `updated` may be 0 — that is the healthy common case. */
export function recordDeedChainSweepOk(updated: number, at = Date.now()): void {
  chainSyncStatus.lastSweepOkAt = at;
  chainSyncStatus.consecutiveFailures = 0;
  chainSyncStatus.lastError = null;
  if (updated > 0) {
    chainSyncStatus.lastWriteAt = at;
    chainSyncStatus.updatedTotal += updated;
  }
}

/** A sweep failed — threw, or declined to spend below the payer floor. Does NOT
 *  clear the last-ok stamp: persistent failure must age into staleness, never
 *  masquerade as a heartbeat. */
export function recordDeedChainSweepError(e: unknown, at = Date.now()): void {
  chainSyncStatus.lastSweepErrorAt = at;
  chainSyncStatus.lastError = e instanceof Error ? e.message : String(e);
  chainSyncStatus.consecutiveFailures++;
}

/**
 * A snapshot for /health, staleness derived at read time from the REAL
 * interval. `ok` is false ONLY when this process is supposed to be syncing and
 * has visibly stopped (or cannot spend): a process that legitimately does not
 * run the loop — an api container, a dev box with DEED_CHAIN_SYNC unset, which
 * is the default — reports ok:true with a reason, exactly like deedR2's.
 */
export function deedChainSyncHealth(now = Date.now()): DeedChainSyncStatus & {
  ok: boolean; stale: boolean; ageSec: number | null;
} {
  const age = chainSyncStatus.lastSweepOkAt === null ? null : now - chainSyncStatus.lastSweepOkAt;
  // Four missed ticks before calling it stale, same judgement as deedR2: one
  // slow sweep must not flap the check, but ~40 minutes of silence on a 10-min
  // cadence is real.
  const limit = (chainSyncStatus.intervalMs ?? DEFAULT_CHAIN_SYNC_MS) * 4;
  // Measured from start until the first sweep lands, so a deploy is not
  // instantly stale — but it still goes red if that first sweep never arrives.
  const sinceHeartbeat = age ?? (chainSyncStatus.startedAt === null ? 0 : now - chainSyncStatus.startedAt);
  const stale = chainSyncStatus.running && sinceHeartbeat > limit;
  return {
    ...chainSyncStatus,
    stale,
    ageSec: age === null ? null : Math.round(age / 1000),
    ok: !stale,
  };
}

/** Current SOL balance of the signing key. Its own function so the loop can be
 *  tested without an RPC, and so ops tooling can ask the same question. */
export async function payerBalanceSol(cfg: DeedChainConfig): Promise<number> {
  const { Connection, Keypair } = await import('@solana/web3.js');
  const kp = Keypair.fromSecretKey(cfg.adminSecret);
  const lamports = await new Connection(cfg.rpcUrl, 'confirmed').getBalance(kp.publicKey);
  return lamports / 1e9;
}
