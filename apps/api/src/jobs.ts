import { startStarterExpeditionScheduler } from './game/starterExpeditionScheduler';
import { startSeekerAuctionCrankWorker } from './seeker/auctionCrankCli';
import { loadDevnetOnlyJobs } from './devnetOnlyLoader';
import { basePurchaseNetwork } from './money/basePurchases';
import { PLAYTEST_COMPETITIONS } from '@shardkeep/shared';
import { ensurePlaytestCampaigns, refreshPlaytestCampaign, snapshotPlaytestFounders } from './game/playtestCampaigns';
import { internalWalletsOf } from './game/playtestStats';
import { invalidateMintEvidenceInventory, reconcilePlaytestMintEvidence, reconcileCampaignCloseEvidence, type MintReconciliationResult } from './game/playtestMintEvidence';
/**
 * Background jobs (PLAN.md 4h) — BullMQ repeatables over Redis. Started only
 * when ENABLE_WORKERS=true (dev servers and tests run without them; every job
 * body is a plain function with its own tests).
 *
 * Schedule (UTC):
 *  - weekly snapshot: Monday 00:10 (+ outbox relay every minute)
 *  - league close:    Monday 00:00; frozen receipt drain Monday 00:15
 *  - PvE respawn:     daily 00:20
 *  - referral gate:   hourly
 *  - withdrawals:     every WITHDRAWAL_PAYOUT_POLL_MS (10s default)
 *  - deed ownership:  dedicated queue, scheduled every
 *                     BASE_OWNERSHIP.observationPollMs (5 seconds) while
 *                     multi-base is enabled (a capped full pass against a sick
 *                     RPC may still take 40s)
 *
 * Economy v2 (ECONOMY.md §2): there is NO day-end emission settle — mining is a
 * fixed per-player quota realized lazily at Mine COLLECT, so the old daily
 * pro-rata pool cron is gone. The lifetime 500M play-allocation cap is enforced
 * inline at collect/claim time (remainingPlayAllocation), not by a cron. A
 * light rollover-accounting job can be re-added later if budget telemetry is
 * wanted; it is intentionally not scheduled for the MVP.
 */
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, openSync, readFileSync, statSync,
} from 'node:fs';
import path from 'node:path';
import type { DeedChainConfig } from './game/deedChainSync';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  BASE_OWNERSHIP, CHAT, ECONOMY, LEAGUES, LIVE_RAID, MARKETPLACE, NOTIFICATIONS, PROFILE_AVATAR,
  TESTER_PROGRAM, DEVNET_FAUCET, PLAYTEST_STATS,
} from '@shardkeep/shared';
import {
  assertSolanaCluster, SolanaClusterRpcError, DeedMintInventoryError, makeDeedMintInventoryConnection, type MintInventoryConnection, addressesFileName, deedAssetName, deedJsonUri, deriveLandDeedAsset, loadAddresses,
  isCanonicalSolanaSignature, makeHotWalletKeepSender, makeRemotePolicyKeepSender, mintLandDeed,
  postEpochRoot, type GameSolanaCluster, type KeepTransferSender,
} from '@shardkeep/chain';
import { assertSafeWithdrawalPolicySignerEndpoint, resolveSolanaRpcUrl, type Config } from './config';
import type { Db } from './db/client';
import { assertEconomyChainIdentity, assertGemsReserveIdentity } from './money/economyIdentity';
import { runEmissionController } from './game/emissionController';
import {
  assertDeedObserverCapacityWithinLimit, makeFinalizedDeedReader, summarizeOwnershipSweep,
  sweepActiveBaseOwnership,
} from './game/baseOwnership';
import { configureDeedMinter, reconcileMissingDeeds, type DeedMinter } from './game/deed';
import { sweepTesterMilestones } from './game/tester';
import { writePlaytestStatsSnapshot } from './game/playtestStats';
import {
  classifyMineFullNotificationBootstrap, makeWebPushTransport, makeFcmTransport, sweepDueNotifications,
} from './notifications';
import { makeDevnetFaucetSender, processDevnetFaucetGrants } from './money/devnetFaucet';
import { r2ConfigFromEnv, r2DeedUri } from './game/deedR2';
import { deedAssetBase } from './game/deedMetadata';
import {
  qualifyReferrals,
} from './game/social';
import {
  closeLeagueWeek, ensureLeagueRewardActivation, recoverMissingLeagueCloses,
  reconcilePendingLeagueRewards, runWeeklyLeagueReset,
} from './game/leagues';
import { respawnPveCamps } from './game/world';
import { recoverLiveRaidLifecycle } from './game/raids';
import { refundRemovedSkins } from './game/skinRefunds';
import { reconcileMarketReservations } from './game/itemMarketReconcile';
import { makeMarketPaymentVerifiers } from './money/marketPaymentProof';
import { grandfatherEliteTroopUnlocks } from './game/troopUnlocks';
import { drainAvatarRetirements, makeR2AvatarStorage } from './game/playerAvatar';
import { drainExpiredGlobalChat } from './chat/service';
import { expireDueMailRewards } from './mail/service';
import {
  makeCombinedDepositVerifier, makeDepositRpcConnection, pollPendingDeposits,
  requireMatchingDepositVerifiers,
} from './money/depositWatcher';
import { buildWeeklySnapshot, checkReserves, relayOutbox, type ReserveReader, type RootSender, type SnapshotResult } from './money/snapshot';
import {
  makeFinalizedHotKeepReserveReader, publicCustodyReserveEvidence,
  type CustodyReserveEvidence,
} from './money/reserves';
import { processDueWithdrawals } from './money/withdrawals';
import { makeWithdrawalAuthorizationGate } from './money/withdrawalAuthorization';
import { errorForStorage } from './lib/errors';
import { relayServerError, sanitizeMintInventoryDiagnostics } from './telemetry';
import { makeResendEmailSender } from './lib/resend';
import { consoleEmailSender } from './auth/twofa';
import { sweepExpiredTotpRecoveries } from './auth/totpRecoveryPolicy';
import { FEEDBACK_SCREENSHOTS, FEEDBACK_EXPORTS } from '@shardkeep/shared/feedback';
import { cleanupFeedbackScreenshots } from './game/feedbackRetention';
import { cleanupFeedbackExports, cleanupFeedbackExportTemporaryDirectories } from './game/feedbackExportRetention';
import { prepareNextFeedbackExport } from './game/feedbackExportPreparation';
import { makeFeedbackExportStorage } from './game/feedbackExportStorage';
import { feedbackR2ConfigFromEnv, makeFeedbackScreenshotStorage } from './game/feedbackStorage';

const QUEUE = 'shardkeep-jobs';
const DEED_OWNERSHIP_QUEUE = 'shardkeep-deed-ownership';
export const DEED_OWNERSHIP_SCHEDULER_ID = 'sched-deed-ownership';
export const AVATAR_RETIREMENT_QUEUE = 'shardkeep-avatar-retirements';
export const GLOBAL_CHAT_RETENTION_QUEUE = 'shardkeep-global-chat-retention';
/** Private R2 calls have their own distributed single-worker queue so a storage
 * outage cannot occupy deposit/withdrawal/root processing. */
export const FEEDBACK_RETENTION_QUEUE = 'shardkeep-feedback-retention';
export const FEEDBACK_EXPORT_QUEUE = 'shardkeep-feedback-exports';
/** Recovery expiry and security-notice delivery may wait on the email provider.
 * Keep that latency off the custody/root queue and serialize it across replicas. */
export const TOTP_RECOVERY_QUEUE = 'shardkeep-totp-recovery';
/** Tester-program milestone derivation runs ~50 read queries per player; it
 * gets its own queue so a sweep can never delay deposit/withdrawal/root jobs
 * on the main custody queue (review 2026-08-21). */
export const TESTER_SWEEP_QUEUE = 'shardkeep-tester-sweep';
/** D-103 public playtest statistics: one full-table read pass every five
 * minutes, persisted as a snapshot the API serves. Own queue for the same
 * reason as the tester sweep — a slow scan must never delay custody jobs. */
export const PLAYTEST_STATS_QUEUE = 'shardkeep-playtest-stats';
/** M33 Web Push sweep (D-101): every 30 s it scans for due raids/builds/
 * training/mail and talks to third-party push services. Own queue so a slow
 * push endpoint can never delay custody jobs; scheduled only when
 * PUSH_NOTIFICATIONS_ENABLED. */
export const NOTIFICATION_SWEEP_QUEUE = 'shardkeep-notification-sweep';
/** DEVNET PLAYTEST ONLY: pays in-game devnet SOL grants from the faucet
 * keypair (worker-only mount). Own queue: a slow devnet RPC must never delay
 * custody jobs. Remove with money/devnetFaucet.ts before mainnet. */
export const DEVNET_FAUCET_QUEUE = 'shardkeep-devnet-faucet';

type ChainRuntimeConfig = Pick<
  Config,
  | 'SOLANA_CLUSTER' | 'SOLANA_RPC_URL' | 'SOLANA_RPC_URL_2'
  | 'WITHDRAWAL_SIGNER_MODE' | 'WITHDRAWAL_POLICY_CUSTODY_BACKEND'
  | 'WITHDRAWAL_POLICY_SIGNER_URL'
  | 'WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP'
  | 'WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE' | 'WITHDRAWAL_POLICY_KEEP_MINT'
>;

function selectedCluster(config?: Pick<Config, 'SOLANA_CLUSTER'>): GameSolanaCluster {
  const cluster = config?.SOLANA_CLUSTER ?? process.env['SOLANA_CLUSTER'] ?? 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new Error(`unsupported SOLANA_CLUSTER=${cluster}`);
  }
  return cluster;
}

function selectedRpcUrl(config?: Pick<Config, 'SOLANA_RPC_URL'>): string {
  return resolveSolanaRpcUrl(config?.SOLANA_RPC_URL ?? process.env['SOLANA_RPC_URL'], process.env['NODE_ENV']);
}

function readWorkerSignerToken(file: string): string {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error('withdrawal policy signer auth token file must be a 0600 regular file');
    }
    return readFileSync(descriptor, 'utf8').trim();
  } finally {
    closeSync(descriptor);
  }
}

/**
 * K-026 operational retention. Completed records are diagnostic history, not
 * execution state: delayed, waiting, active and retrying jobs live in separate
 * BullMQ sets and are never eligible for these limits.
 *
 * BullMQ 5.78 applies `limit` only to age eviction. Combining `count` with it
 * still lets removeJobsByMaxCount delete every excess record in one Lua command
 * (the production main queue currently has ~100k excess records). These policies
 * are therefore deliberately age-only: each completion removes at most `limit`
 * old terminal records, then normal scheduler cadence holds a time-bounded
 * steady state without a blocking one-shot purge.
 */
export const BULLMQ_RETENTION = {
  main: {
    removeOnComplete: { age: 6 * 3_600, limit: 100 },
    removeOnFail: { age: 86_400, limit: 25 },
  },
  deedOwnership: {
    removeOnComplete: { age: 86_400, limit: 100 },
    removeOnFail: { age: 2 * 86_400, limit: 25 },
  },
  avatarRetirement: {
    removeOnComplete: { age: 7 * 86_400, limit: 100 },
    removeOnFail: { age: 7 * 86_400, limit: 25 },
  },
  globalChatRetention: {
    removeOnComplete: { age: 30 * 86_400, limit: 50 },
    removeOnFail: { age: 30 * 86_400, limit: 25 },
  },
  feedbackRetention: {
    removeOnComplete: { age: 86_400, limit: 50 },
    removeOnFail: { age: 2 * 86_400, limit: 25 },
  },
  totpRecovery: {
    removeOnComplete: { age: 86_400, limit: 50 },
    removeOnFail: { age: 2 * 86_400, limit: 25 },
  },
  testerSweep: {
    removeOnComplete: { age: 86_400, limit: 50 },
    removeOnFail: { age: 2 * 86_400, limit: 25 },
  },
  playtestStats: {
    removeOnComplete: { age: 86_400, limit: 50 },
    removeOnFail: { age: 2 * 86_400, limit: 25 },
  },
  notificationSweep: {
    removeOnComplete: { age: 86_400, limit: 50 },
    removeOnFail: { age: 2 * 86_400, limit: 25 },
  },
  devnetFaucet: {
    removeOnComplete: { age: 6 * 3_600, limit: 50 },
    removeOnFail: { age: 86_400, limit: 25 },
  },
} as const;

/** BullMQ persists processor return values as JSON. Keep bigint arithmetic in
 * the authoritative service, but cross the queue boundary as decimal strings. */
export function serializeLeagueJobResult<T extends { cacheShards: bigint }>(result: T) {
  return {
    ...result,
    cacheShards: result.cacheShards.toString(),
  };
}

/** An empty post-freeze observation is not a published Merkle snapshot. Keep
 * that distinction and the separate reserve result in the completed job. */
export function serializeSnapshotJobResult(result: SnapshotResult, reserves: unknown) {
  return { ...result, epoch: result.epoch.toString(), totalBalance: result.totalBalance.toString(), reserves };
}

/** Every worker boot must materialize a fresh recovery attempt. A boundary-keyed
 * id can remain occupied by a retained failed BullMQ job, making a 00:16 restart
 * silently skip the only recovery path after the minute scheduler has ended. */
export function leagueCloseRecoveryStartupJobId(): string {
  return `league-close-recovery-startup-${randomUUID()}`;
}

function keypairFromFile(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

/** Guarded operator escape hatch for a post_root transaction pushed outside the
 * automatic 20-signature recovery page. The chain client still fetches and
 * proves the exact successful instruction; this map never marks rows sent. */
export function parseEpochRootRecoverySignatures(raw: string | undefined): ReadonlyMap<bigint, string> {
  if (!raw?.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('EPOCH_ROOT_RECOVERY_SIGNATURES must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('EPOCH_ROOT_RECOVERY_SIGNATURES must be a JSON object');
  }
  const result = new Map<bigint, string>();
  const u64Max = (1n << 64n) - 1n;
  for (const [epochText, signature] of Object.entries(parsed)) {
    if (!/^(0|[1-9][0-9]*)$/.test(epochText)) {
      throw new Error(`invalid epoch key in EPOCH_ROOT_RECOVERY_SIGNATURES: ${epochText}`);
    }
    const epoch = BigInt(epochText);
    if (epoch > u64Max) throw new Error(`epoch exceeds u64 in EPOCH_ROOT_RECOVERY_SIGNATURES: ${epochText}`);
    if (typeof signature !== 'string' || !isCanonicalSolanaSignature(signature)) {
      throw new Error(`invalid Solana signature for recovery epoch ${epochText}`);
    }
    result.set(epoch, signature);
  }
  return result;
}

function chainRootSender(config: Config): RootSender {
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'];
  if (!adminPath) {
    return async () => {
      throw new Error('ADMIN_KEYPAIR_PATH not set — post_root relay disabled');
    };
  }
  const admin = keypairFromFile(adminPath);
  const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  const recoverySignatures = parseEpochRootRecoverySignatures(
    process.env['EPOCH_ROOT_RECOVERY_SIGNATURES'],
  );
  return (epoch, rootHex, total) =>
    postEpochRoot(
      connection,
      admin,
      epoch,
      Uint8Array.from(Buffer.from(rootHex, 'hex')),
      total,
      recoverySignatures.get(epoch),
    );
}

/**
 * Real KEEP payout sender (owner 2026-07-18), or null when the hot wallet isn't
 * provisioned (then the withdrawals job skips rather than failing every row).
 * KEEP mint comes from infra/devnet.addresses.json; the transfer confirms at
 * FINALIZED with no blind retry (money bar, ARCHITECTURE §5).
 */
/** The liquidity-pool treasury wallet (public), the 100% destination for
 *  mine-build SOL (owner 2026-07-19). Independent of the hot wallet. */
export function liquidityWallet(config?: Pick<Config, 'SOLANA_CLUSTER'>): PublicKey | null {
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const addresses = loadAddresses(repoRoot, selectedCluster(config));
  return addresses ? new PublicKey(addresses.treasuries.liquidity) : null;
}

/**
 * Land Deed minter (Phase 6) — bound to the admin keypair + the Core collection
 * from infra/devnet.addresses.json (written by `pnpm deed:collection`). Null when
 * either is missing → deed minting is simply disabled (never blocks entry).
 */
export function deedMinter(config?: ChainRuntimeConfig): DeedMinter | null {
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'];
  if (!adminPath) return null;
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const cluster = selectedCluster(config);
  const addresses = loadAddresses(repoRoot, cluster);
  const collection = addresses?.deedCollection;
  if (!collection) return null;
  const adminSecret = keypairFromFile(adminPath).secretKey;
  // DYNAMIC metadata (ITEMS plan §metadata, wired 2026-07-26): each deed's URI
  // points at a per-ASSET JSON that reflects the base AS IT IS NOW — the deed
  // evolves with the base instead of freezing at mint. URI preference:
  //  1. R2 public bucket (deedR2.ts keeps it fresh) — required while the api
  //     runs on a non-public host (owner: local box + Cloudflare R2);
  //  2. the api's own GET /deed/asset/:assetId.json when it HAS a public host.
  const r2 = r2ConfigFromEnv();
  // FAIL LOUD instead of minting dead deeds (owner 2026-07-29: "I dont see any
  // data metadata or base image"). A deed's URI is written ON CHAIN at mint; if
  // it points at localhost, every wallet and explorer shows an empty NFT
  // forever — which is precisely what happened to the deeds minted with
  // DEED_METADATA_BASE_URL=http://localhost:8787. deedAssetBase() rejects
  // loopback hosts, so an unpublishable deed is never minted at all; existing
  // deeds are repaired with `pnpm --filter @shardkeep/scripts deed:reuri` once
  // a public host exists.
  const publicBase = deedAssetBase();
  if (!r2 && !publicBase) {
    console.error(
      '[deed] minting DISABLED: no PUBLIC metadata host. Set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY ' +
      '(bucket already configured) or point DEED_METADATA_BASE_URL at a publicly reachable https host. ' +
      'Minting now would write a permanently unreadable URI on chain.',
    );
    return null;
  }
  // ASSET-KEYED URI (security review 2026-07-29 F2): the deed's document is
  // addressed by the ASSET, so it keeps describing the base it conveys after a
  // resale — a wallet-keyed URI followed the SELLER instead, and the seller's
  // next deed would have been minted onto the very same URI. The asset address
  // is generated locally before the mint tx is sent, so it is knowable here.
  const uriFor = (asset: string): string => (r2 ? r2DeedUri(r2, asset) : deedJsonUri(publicBase!, asset));
  return {
    // Pure/local plan: no fetch, signature or broadcast. mintDeedIfConfigured
    // commits this address to bases.deed_mint_asset_id before calling `mint`.
    assetFor: (operationId) => deriveLandDeedAsset({
      rpcUrl: selectedRpcUrl(config), adminSecret, operationId,
    }),
    mint: (owner, operationId, expectedAsset) => mintLandDeed({
      rpcUrl: selectedRpcUrl(config), adminSecret, collection, owner, operationId, expectedAsset,
      identity: (asset) => ({ name: deedAssetName(asset), uri: uriFor(asset) }),
      // Stamped on the ASSET too, not just inherited from the collection, so every
      // explorer/wallet reads the real 5% instead of printing "Seller Fee 0%". The
      // plugin's contents are copied from the COLLECTION; this number is only the
      // assertion that the collection still agrees with us (mint aborts if not).
      royaltyBps: MARKETPLACE.deedRoyaltyBps,
      // WHERE the royalty is paid is CONFIG (owner 2026-07-29), and it is
      // ASSERTED here, never substituted: if the env names a treasury the
      // collection has not been repointed to, minting FAILS rather than producing
      // deeds that pay the old address forever. `deed:royalty:creator` is what
      // makes the two agree. Unset ⇒ no destination check (devnet status quo).
      expectedCreator: process.env['DEED_ROYALTY_CREATOR']?.trim() || undefined,
    }),
  };
}

/** The hot wallet PUBLIC key + KEEP mint (both public), for the inbound KEEP
 *  deposit flow — the intent destination ATA and the deposit verifier. Guarded
 *  like hotWalletSender: null when the hot wallet isn't provisioned. */
export function hotWalletInfo(
  config?: Pick<Config, 'SOLANA_CLUSTER'>,
): { pubkey: PublicKey; keepMint: PublicKey } | null {
  const hotPubkey = process.env['HOT_WALLET_PUBKEY']?.trim();
  if (!hotPubkey) return null;
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const cluster = selectedCluster(config);
  const addresses = loadAddresses(repoRoot, cluster);
  if (!addresses) {
    throw new Error(
      `HOT_WALLET_PUBKEY set but infra/${addressesFileName(cluster)} not found under ${repoRoot}`,
    );
  }
  return { pubkey: new PublicKey(hotPubkey), keepMint: new PublicKey(addresses.keepMint) };
}

/** Conservative two-provider PoR agreement. Slot equality is not required, but
 * every identity, encumbrance and exact balance field is. */
export function assertMatchingCustodyEvidence(
  a: CustodyReserveEvidence, b: CustodyReserveEvidence,
): void {
  const fingerprint = (e: CustodyReserveEvidence): string => [
    e.role, e.commitment, e.account, e.owner, e.mint, e.tokenProgram,
    e.canonicalAta, e.state, e.delegate, e.delegatedAmountBaseUnits,
    e.observedBalanceBaseUnits, e.observedBalanceKeep, e.eligible,
    e.ineligibilityReason,
  ].map((value) => value === null ? 'null' : String(value)).join('|');
  if (fingerprint(a) !== fingerprint(b)) {
    throw new Error(
      'independent finalized custody RPCs disagree on KEEP account identity, encumbrance, or balance',
    );
  }
}

/** Validated finalized evidence for the one canonical liquid-custody KEEP ATA.
 * Generic treasuries, cold addresses and LP positions are not withdrawal-ready
 * custody and therefore never enter PoR or the payout gate. */
export function hotKeepReserveReader(config?: ChainRuntimeConfig): ReserveReader | null {
  const info = hotWalletInfo(config);
  if (!info) return null;
  const primary = makeFinalizedHotKeepReserveReader(
    new Connection(selectedRpcUrl(config), 'finalized'), info.pubkey, info.keepMint,
  );
  const secondaryRaw = config?.SOLANA_RPC_URL_2 ?? process.env['SOLANA_RPC_URL_2'];
  const secondaryUrl = secondaryRaw ? resolveSolanaRpcUrl(secondaryRaw, process.env['NODE_ENV']) : undefined;
  if (!secondaryUrl) return primary;
  const secondary = makeFinalizedHotKeepReserveReader(
    new Connection(secondaryUrl, 'finalized'), info.pubkey, info.keepMint,
  );
  return async () => {
    const [a, b] = await Promise.all([primary(), secondary()]);
    assertMatchingCustodyEvidence(a, b);
    // Slots may differ while both are finalized; every economic/account field
    // and exact base-unit balance must agree before either can authorize payout.
    return a.slot <= b.slot ? a : b;
  };
}

export function hotWalletSender(
  rpcConfig?: ChainRuntimeConfig,
): KeepTransferSender | null {
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const cluster = selectedCluster(rpcConfig);
  const custodyBackend = rpcConfig?.WITHDRAWAL_POLICY_CUSTODY_BACKEND
    ?? process.env['WITHDRAWAL_POLICY_CUSTODY_BACKEND'] ?? 'file';
  if (custodyBackend !== 'file') {
    throw new Error(
      'WITHDRAWAL_POLICY_CUSTODY_BACKEND supports only file; no HSM or enclave backend is implemented',
    );
  }
  if (cluster === 'mainnet-beta') {
    throw new Error(
      'mainnet-beta forbids file-backed withdrawal custody; no reviewed HSM or enclave backend is implemented',
    );
  }
  const addresses = loadAddresses(repoRoot, cluster);
  if (!addresses) {
    throw new Error(
      `HOT_WALLET_KEYPAIR_PATH set but infra/${addressesFileName(cluster)} not found under ${repoRoot}`,
    );
  }
  const keepMint = new PublicKey(addresses.keepMint);
  const mode = rpcConfig?.WITHDRAWAL_SIGNER_MODE
    ?? process.env['WITHDRAWAL_SIGNER_MODE'] ?? 'legacy';
  const hotPath = process.env['HOT_WALLET_KEYPAIR_PATH'];
  const configured = process.env['HOT_WALLET_PUBKEY']?.trim();
  if (!configured) {
    if (mode === 'remote' || hotPath) {
      throw new Error('HOT_WALLET_PUBKEY is required when withdrawal signing is configured');
    }
    return null;
  }
  const sourceOwner = new PublicKey(configured);
  const primaryUrl = selectedRpcUrl(rpcConfig);
  const primary = new Connection(primaryUrl, 'finalized');
  // Mainnet finality requires agreement from both configured provider hosts.
  // Null history after expiry is never treated as proof that a transfer did
  // not land: ordinary RPC providers may have pruned the finalized record.
  // Source labels use hostnames so aliases to one provider are deduplicated.
  const primaryHost = new URL(primaryUrl).hostname.toLowerCase();
  const secondaryUrls = [rpcConfig?.SOLANA_RPC_URL_2 ?? process.env['SOLANA_RPC_URL_2']]
    .map((url) => url?.trim()).filter((url): url is string => Boolean(url))
    .map(url => resolveSolanaRpcUrl(url, process.env['NODE_ENV']));
  const sources = new Map<string, Connection>();
  for (const url of secondaryUrls) {
    const host = new URL(url).hostname.toLowerCase();
    if (host !== primaryHost && !sources.has(host)) {
      sources.set(host, new Connection(url, 'finalized'));
    }
  }
  const reconciliationSources = [...sources].map(([source, connection]) => ({ source, connection }));
  if (mode === 'remote') {
    if (process.env['HOT_WALLET_KEYPAIR_PATH']?.trim()) {
      throw new Error('remote withdrawal worker must not receive HOT_WALLET_KEYPAIR_PATH');
    }
    const signerUrl = rpcConfig?.WITHDRAWAL_POLICY_SIGNER_URL
      ?? process.env['WITHDRAWAL_POLICY_SIGNER_URL'];
    const allowPrivateHttp = rpcConfig?.WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP
      ?? process.env['WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP'] ?? 'false';
    const tokenPath = rpcConfig?.WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE
      ?? process.env['WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE'];
    const policyMint = rpcConfig?.WITHDRAWAL_POLICY_KEEP_MINT
      ?? process.env['WITHDRAWAL_POLICY_KEEP_MINT'];
    if (!signerUrl || !tokenPath || !policyMint) {
      throw new Error('remote withdrawal policy signer configuration is incomplete');
    }
    assertSafeWithdrawalPolicySignerEndpoint(signerUrl, allowPrivateHttp);
    if (new PublicKey(policyMint).toBase58() !== keepMint.toBase58()) {
      throw new Error('WITHDRAWAL_POLICY_KEEP_MINT does not match the selected cluster registry');
    }
    const resolvedToken = path.isAbsolute(tokenPath) ? tokenPath : path.resolve(repoRoot, tokenPath);
    const authToken = readWorkerSignerToken(resolvedToken);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(authToken)) {
      throw new Error('withdrawal policy signer auth token file is malformed');
    }
    return makeRemotePolicyKeepSender(primary, {
      endpoint: signerUrl,
      authToken,
      cluster,
      sourceOwner,
      keepMint,
    }, reconciliationSources);
  }

  if (!hotPath) return null;
  // The env path is repo-root-relative (e.g. infra/keys/…), but the api process
  // runs from apps/api — resolve against repoRoot so a relative path is found.
  const resolvedHot = path.isAbsolute(hotPath) ? hotPath : path.resolve(repoRoot, hotPath);
  const signer = keypairFromFile(resolvedHot);
  if (signer.publicKey.toBase58() !== configured) {
    throw new Error('HOT_WALLET_KEYPAIR_PATH does not match HOT_WALLET_PUBKEY');
  }
  return makeHotWalletKeepSender(
    primary, signer, keepMint,
    reconciliationSources,
  );
}

/** Both reconciliations run, but a secondary close failure must never replace
 * the inventory reason that made the job fail. Neither path relays raw RPC/SQL. */
export async function runMintEvidenceReconciliation(db: Db, rpc: Connection, collection: string,
  inventoryConnection: MintInventoryConnection): Promise<MintReconciliationResult> {
  let result: MintReconciliationResult | undefined;
  let primary: Error | undefined;
  try {
    result = await reconcilePlaytestMintEvidence(db, rpc, collection, inventoryConnection);
    if (!result.complete) console.warn(JSON.stringify({ level: 40, event: 'playtest_mint_verification_unavailable', ...sanitizeMintInventoryDiagnostics(result.diagnostics) }));
  } catch (error) {
    const safe = error instanceof DeedMintInventoryError ? error : new DeedMintInventoryError({ reason: 'rpc_error', stage: 'collection_before', attempts: 0, contextRetries: 0 });
    primary = safe;
    console.error(JSON.stringify({ level: 50, event: 'playtest_mint_verification_failed', ...sanitizeMintInventoryDiagnostics(safe.diagnostics) }));
  }
  try { await reconcileCampaignCloseEvidence(db, rpc, collection); }
  catch {
    const secondary = new Error('Campaign close evidence verification unavailable; finalized chain evidence required');
    console.error(JSON.stringify({ level: 50, event: 'playtest_close_evidence_failed' }));
    if (primary) relayServerError(secondary, { logger: 'pkw-worker', route: 'job:mint-evidence:close' });
    else primary = secondary; // The common failed-job relay reports this once.
  }
  if (primary) throw primary;
  return result!;
}

/** Attest each reconciliation's selected endpoint before either inventory or
 * historical proof reads. No provider mixing or fallback on a failed override. */
export async function runConfiguredMintEvidenceReconciliation(db: Db,
  config: Pick<Config, 'SOLANA_RPC_URL' | 'SOLANA_CLUSTER' | 'MINT_EVIDENCE_RPC_URL'>, collection: string) {
  const rpcUrl = config.MINT_EVIDENCE_RPC_URL ?? selectedRpcUrl(config);
  try { await assertSolanaCluster({ rpcUrl, cluster: config.SOLANA_CLUSTER }); }
  catch (error) {
    const safe = new DeedMintInventoryError({ stage: 'cluster', attempts: 0, contextRetries: 0,
      reason: error instanceof SolanaClusterRpcError ? 'cluster_unavailable' : 'cluster_mismatch' });
    await invalidateMintEvidenceInventory(db, safe);
    throw safe;
  }
  const rpc = makeDeedMintInventoryConnection(rpcUrl, new AbortController().signal);
  return runMintEvidenceReconciliation(db, rpc, collection, signal => makeDeedMintInventoryConnection(rpcUrl, signal));
}

/** Campaign evidence can be temporarily incomplete while genuine activity and
 * lifetime totals remain publishable. Isolate each campaign step; failures are
 * still logged and relayed, while a statistics write failure fails the job. */
export async function refreshPublicPlaytestStats(db: Db, config: Config) {
  const internal = internalWalletsOf(config);
  const refreshStep = async (stage: string, run: () => Promise<unknown>): Promise<void> => {
    try { await run(); }
    catch (error) {
      console.error(`[playtest-stats] ${stage} failed; continuing public statistics: ${errorForStorage(error, 300)}`);
      relayServerError(error, { logger: 'pkw-worker', route: `job:playtest-stats:${stage}` });
    }
  };
  await refreshStep('campaign-definitions', () => ensurePlaytestCampaigns(db));
  await refreshStep('founder-snapshot', () => snapshotPlaytestFounders(db, internal));
  for (const id of [PLAYTEST_COMPETITIONS.foundingId, PLAYTEST_COMPETITIONS.rewardedId]) {
    await refreshStep(id, () => refreshPlaytestCampaign(db, id, internal));
  }
  const stats = await writePlaytestStatsSnapshot(db, config, new Date());
  return { computedAt: stats.computedAt, players: stats.cohorts.total.players };
}

/** Registers the repeating deed-ownership sweep. A scheduler stored at another
 * cadence is REMOVED first, because BullMQ 5.78 keeps a scheduler's stored
 * `offset` when `every` changes (addJobScheduler-11.lua: after it replaces the
 * pending delayed job, storeJobScheduler re-reads the old offset). Production's
 * offset was computed on the previous 15 s grid, so it can be anywhere in
 * [0, 15_000). An occurrence that becomes active more than one period late - a
 * sick RPC wave, a worker restart - is realigned by
 * getJobSchedulerEveryNextMillis to floor(now / every) * every + every + offset:
 * with a stale offset that is up to every + 15 s without a sweep, and every
 * proof ages past mutationFreshnessMs (the 2026-09-18 false-503 shape).
 * Removing the scheduler deletes its hash, so the offset is recomputed as
 * now % every and that realignment stays below two periods. A boot at the
 * unchanged cadence keeps the plain upsert production has always run: it
 * replaces the pending occurrence in whatever state it is in, while
 * removeJobScheduler only clears a DELAYED one and would strand a waiting
 * occurrence as one extra sweep per boot. */
export async function scheduleDeedOwnershipObserver(deedOwnershipQueue: Queue): Promise<void> {
  const every = BASE_OWNERSHIP.observationPollMs;
  await deedOwnershipQueue.setGlobalConcurrency(1);
  const stored = await deedOwnershipQueue.getJobScheduler(DEED_OWNERSHIP_SCHEDULER_ID);
  if (stored && (stored.every !== every || (stored.offset ?? 0) >= every)) {
    await deedOwnershipQueue.removeJobScheduler(DEED_OWNERSHIP_SCHEDULER_ID);
  }
  await deedOwnershipQueue.upsertJobScheduler(
    DEED_OWNERSHIP_SCHEDULER_ID, { every }, { name: 'deed-ownership' },
  );
}

export async function startWorkers(config: Config, db: Db): Promise<{ close: () => Promise<void> }> {
  const identityRoot = config.REPO_ROOT ?? path.resolve(process.cwd(), '..', '..');
  const selectedIdentity = loadAddresses(identityRoot, config.SOLANA_CLUSTER);
  const knownDevnetIdentity = loadAddresses(identityRoot, 'devnet');
  if (!selectedIdentity || !knownDevnetIdentity) {
    throw new Error('worker economy chain registry identity is unavailable');
  }
  await assertEconomyChainIdentity(db, {
    cluster: config.SOLANA_CLUSTER,
    keepMint: selectedIdentity.keepMint,
    coreProgram: selectedIdentity.coreProgram,
    configPda: selectedIdentity.config,
  }, {
    cluster: 'devnet',
    keepMint: knownDevnetIdentity.keepMint,
    coreProgram: knownDevnetIdentity.coreProgram,
    configPda: knownDevnetIdentity.config,
  });
  await assertGemsReserveIdentity(db, config, {
    cluster: config.SOLANA_CLUSTER, keepMint: selectedIdentity.keepMint,
    coreProgram: selectedIdentity.coreProgram, configPda: selectedIdentity.config,
  }, [config.SOLANA_RPC_URL, config.SOLANA_RPC_URL_2]
    .filter((url): url is string => Boolean(url)).map(makeDepositRpcConnection));

  if (config.MULTI_BASE_ENABLED === 'true') await assertDeedObserverCapacityWithinLimit(db);
  if (config.MULTI_BASE_ENABLED === 'true' && config.LEAGUE_REWARDS_ENABLED === 'true') {
    await ensureLeagueRewardActivation(db, new Date(), {
      enabled: true,
      startWeek: config.LEAGUE_REWARD_START_WEEK,
    });
  }
  const connection = { url: process.env['REDIS_URL'] ?? 'redis://localhost:6380' };
  const queue = new Queue(QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.main,
  });
  const deedOwnershipQueue = new Queue(DEED_OWNERSHIP_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.deedOwnership,
  });
  const avatarRetirementQueue = new Queue(AVATAR_RETIREMENT_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.avatarRetirement,
  });
  const globalChatRetentionQueue = new Queue(GLOBAL_CHAT_RETENTION_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.globalChatRetention,
  });
  const feedbackRetentionQueue = new Queue(FEEDBACK_RETENTION_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.feedbackRetention,
  });
  const feedbackExportQueue = new Queue(FEEDBACK_EXPORT_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.feedbackRetention,
  });
  const totpRecoveryQueue = new Queue(TOTP_RECOVERY_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.totpRecovery,
  });
  const testerSweepQueue = new Queue(TESTER_SWEEP_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.testerSweep,
  });
  const playtestStatsQueue = new Queue(PLAYTEST_STATS_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.playtestStats,
  });
  const mintEvidenceQueue = new Queue('playtest-mint-evidence', { connection, defaultJobOptions: BULLMQ_RETENTION.playtestStats });
  const notificationSweepQueue = new Queue(NOTIFICATION_SWEEP_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.notificationSweep,
  });
  // Config refuses PUSH_NOTIFICATIONS_ENABLED=true without the VAPID trio, so
  // the transport exists exactly when the flag is on.
  const pushTransport = config.PUSH_NOTIFICATIONS_ENABLED === 'true'
    ? makeWebPushTransport(config)
    : null;
  const fcmTransport = makeFcmTransport(config);
  const devnetFaucetQueue = new Queue(DEVNET_FAUCET_QUEUE, {
    connection, defaultJobOptions: BULLMQ_RETENTION.devnetFaucet,
  });
  // DEVNET PLAYTEST ONLY: the faucet sender exists only when the flag is on,
  // the cluster is devnet (config also refuses otherwise) and the worker has
  // the dedicated keypair. Anything else leaves grant rows `requested` and the
  // client shows the public-faucet guide.
  const devnetFaucetPath = process.env['DEVNET_FAUCET_KEYPAIR_PATH'];
  // Best-effort by design: a missing/unreadable faucet key (e.g. the compose
  // bind mount created a directory before devnet-faucet:init ran) must never
  // take the custody worker down — grant rows simply wait.
  let devnetFaucetKeypair: Keypair | null = null;
  if (config.DEVNET_FAUCET_ENABLED === 'true' && config.SOLANA_CLUSTER === 'devnet' && devnetFaucetPath) {
    try {
      if (!statSync(devnetFaucetPath).isFile()) throw new Error('not a regular file');
      devnetFaucetKeypair = keypairFromFile(devnetFaucetPath);
    } catch (e) {
      console.warn(`[devnet-faucet] keypair unreadable at ${devnetFaucetPath} (${e instanceof Error ? e.message : String(e)}) — grant requests will wait; run devnet-faucet:init`);
    }
  }
  const devnetFaucetSender = devnetFaucetKeypair
    ? makeDevnetFaucetSender(new Connection(config.SOLANA_RPC_URL, 'confirmed'), devnetFaucetKeypair)
    : null;
  if (config.DEVNET_FAUCET_ENABLED === 'true' && !devnetFaucetSender) {
    console.warn('[devnet-faucet] DEVNET_FAUCET_ENABLED=true but no keypair/cluster — grant requests will wait');
  }
  if (devnetFaucetSender) console.log(`[devnet-faucet] paying grants from ${devnetFaucetSender.publicKey.toBase58()}`);
  const sendRoot = chainRootSender(config);
  const recoveryEmailSender = config.RESEND_API_KEY && config.EMAIL_FROM
    ? makeResendEmailSender(config.RESEND_API_KEY, config.EMAIL_FROM)
    : consoleEmailSender;
  const avatarR2 = r2ConfigFromEnv();
  if (config.NODE_ENV === 'production' && !avatarR2) {
    throw new Error(
      'profile avatar retirement requires R2_ENDPOINT, R2_ACCESS_KEY_ID, '
      + 'R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_BASE_URL',
    );
  }
  const avatarRetirementDelete = avatarR2 ? makeR2AvatarStorage(avatarR2).delete : null;
  const feedbackR2 = feedbackR2ConfigFromEnv();
  const feedbackStorage = feedbackR2 ? makeFeedbackScreenshotStorage(feedbackR2) : null;
  const feedbackExportStorage = feedbackR2 ? makeFeedbackExportStorage(feedbackR2) : null;
  const feedbackExportStop = new AbortController();
  await feedbackExportQueue.setGlobalConcurrency(1);
  if (feedbackStorage && feedbackExportStorage) {
    await feedbackExportQueue.upsertJobScheduler('sched-feedback-exports',
      { every: FEEDBACK_EXPORTS.preparationPollMs }, { name: 'feedback-export' });
  } else {
    await feedbackExportQueue.removeJobScheduler('sched-feedback-exports');
  }
  await feedbackRetentionQueue.setGlobalConcurrency(1);
  if (feedbackStorage) {
    await feedbackRetentionQueue.upsertJobScheduler('sched-feedback-retention',
      { every: FEEDBACK_SCREENSHOTS.cleanupPollMs }, { name: 'feedback-retention' });
    console.log('[feedback-retention] private screenshot cleanup active');
  } else {
    await feedbackRetentionQueue.removeJobScheduler('sched-feedback-retention');
    console.warn('[feedback-retention] inactive until complete private FEEDBACK_R2_* credentials are installed');
  }

  // R2 may consume the full bounded batch × per-call timeout during an outage.
  // Keep that latency off the custody/root queue and serialize it globally;
  // row-level SKIP LOCKED remains a second line of defense across replicas.
  await avatarRetirementQueue.setGlobalConcurrency(PROFILE_AVATAR.retirementWorkerConcurrency);
  await avatarRetirementQueue.upsertJobScheduler(
    'sched-avatar-retirements',
    { every: PROFILE_AVATAR.retirementPollMs },
    { name: 'avatar-retirements' },
  );

  // This scheduler used to share QUEUE with deposits, withdrawals, snapshots,
  // and every other singleton worker job. A supported-cap ownership pass can
  // legitimately occupy ~40s of RPC time, so keeping it there delays custody
  // work. Remove the old scheduler on every boot before installing its isolated
  // replacement; any already-materialized legacy job is handled as a cheap
  // no-op by the main worker below.
  await queue.removeJobScheduler('sched-deed-ownership');

  const jobs: Array<[string, string]> = [
    ['snapshot', '10 0 * * 1'],
    ['league-reset', LEAGUES.settlementCron],
    ['pve-respawn', '20 0 * * *'],
    ['mail-expiry', '5 0 * * *'],
    ['referral-gate', '0 * * * *'],
    ['outbox-relay', '* * * * *'],
    // Treasury-aware emission controller (#45): every 10 min = ECONOMY.emissionControllerSec.
    ['emission-controller', '*/10 * * * *'],
  ];
  for (const [name, pattern] of jobs) {
    await queue.upsertJobScheduler(`sched-${name}`, { pattern, tz: 'UTC' }, { name });
  }
  await queue.upsertJobScheduler(
    'sched-league-close',
    { pattern: LEAGUES.closeCron, tz: 'UTC' },
    {
      name: 'league-close',
      opts: {
        attempts: LEAGUES.closeSnapshotAttempts,
        backoff: { type: 'fixed', delay: LEAGUES.closeSnapshotRetryMs },
      },
    },
  );
  // Durable SQL fencing outlives both runtime feature flags. Keep a cheap
  // watchdog installed unconditionally: with no activation/gap it is a no-op;
  // after a DB/RPC outage it terminally closes overdue weeks without restart.
  await queue.upsertJobScheduler(
    'sched-league-close-recovery',
    { pattern: LEAGUES.closeRecoveryCron, tz: 'UTC' },
    { name: 'league-close-recovery' },
  );
  // Remove the rolling-compatible legacy scheduler from the custody/root queue
  // before installing the isolated replacement. An already-materialized tagged
  // job remains a cheap no-op in the main worker below.
  await queue.removeJobScheduler('sched-global-chat-retention');
  await globalChatRetentionQueue.setGlobalConcurrency(CHAT.retentionWorkerConcurrency);
  await globalChatRetentionQueue.upsertJobScheduler(
    'sched-global-chat-retention',
    { every: CHAT.retentionPollMs },
    { name: 'global-chat-retention' },
  );
  await totpRecoveryQueue.setGlobalConcurrency(1);
  await totpRecoveryQueue.upsertJobScheduler(
    'sched-totp-recovery',
    { every: 60_000 },
    { name: 'totp-recovery' },
  );
  // Deposit watcher (R9): sub-minute cadence, so `every` ms instead of cron.
  await queue.upsertJobScheduler(
    'sched-deposit-watch',
    { every: ECONOMY.depositPollSec * 1000 },
    { name: 'deposit-watch' },
  );
  await queue.upsertJobScheduler(
    'sched-withdrawals',
    { every: config.WITHDRAWAL_PAYOUT_POLL_MS },
    { name: 'withdrawals' },
  );
  // Item-market reconciler (tester report 24b9184d, 2026-09-16): settles paid
  // reservations and releases lapsed unpaid ones without any client polling.
  await queue.upsertJobScheduler(
    'sched-market-reconcile',
    { every: MARKETPLACE.itemMarket.reconcilePollSec * 1000 },
    { name: 'market-reconcile' },
  );
  await queue.upsertJobScheduler(
    'sched-deed-mint-reconcile',
    { every: config.DEED_MINT_RECONCILE_POLL_MS },
    { name: 'deed-mint-reconcile' },
  );
  await queue.upsertJobScheduler(
    'sched-live-raid-recovery',
    { every: LIVE_RAID.recoverySweepSec * 1_000 },
    { name: 'live-raid-recovery' },
  );
  // Tester program (owner 2026-08-21): derive/backfill milestones, least
  // recently derived players first; idempotent, read-only over game state.
  // Isolated queue: the first release briefly scheduled this on the main
  // custody queue — remove that scheduler so it cannot linger on an upgrade.
  await queue.removeJobScheduler('sched-tester-sweep');
  await testerSweepQueue.setGlobalConcurrency(1);
  await testerSweepQueue.upsertJobScheduler(
    'sched-tester-sweep',
    { every: TESTER_PROGRAM.sweepEveryMs },
    { name: 'tester-sweep' },
  );
  // D-103 public statistics: read-only over game state, one snapshot row per
  // pass, trimmed beyond PLAYTEST_STATS.retentionDays. Queue-global
  // concurrency 1 keeps replicas from writing the same instant twice.
  await mintEvidenceQueue.setGlobalConcurrency(1);
  await mintEvidenceQueue.upsertJobScheduler('sched-mint-evidence', { every: PLAYTEST_STATS.refreshEveryMs }, { name: 'mint-evidence' });
  await playtestStatsQueue.setGlobalConcurrency(1);
  await playtestStatsQueue.upsertJobScheduler(
    'sched-playtest-stats',
    { every: PLAYTEST_STATS.refreshEveryMs },
    { name: 'playtest-stats' },
  );
  // M33 push notifications (D-101): the (kind, ref_id) ledger makes the sweep
  // idempotent, and queue-global concurrency 1 keeps a second replica from
  // racing it against the same push services.
  if (pushTransport || fcmTransport) {
    await notificationSweepQueue.setGlobalConcurrency(1);
    await notificationSweepQueue.upsertJobScheduler(
      'sched-notification-sweep',
      { every: NOTIFICATIONS.sweepEveryMs },
      { name: 'notification-sweep' },
    );
  } else {
    await notificationSweepQueue.removeJobScheduler('sched-notification-sweep');
  }
  if (devnetFaucetSender) {
    await devnetFaucetQueue.setGlobalConcurrency(1);
    await devnetFaucetQueue.upsertJobScheduler(
      'sched-devnet-faucet',
      { every: DEVNET_FAUCET.pollMs },
      { name: 'devnet-faucet' },
    );
  } else {
    await devnetFaucetQueue.removeJobScheduler('sched-devnet-faucet');
  }
  if (config.MULTI_BASE_ENABLED === 'true' && config.LEAGUE_REWARDS_ENABLED === 'true') {
    await queue.upsertJobScheduler(
      'sched-league-entitlement-reconcile',
      { every: LEAGUES.reconcileMs },
      { name: 'league-entitlement-reconcile', opts: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } } },
    );
  } else {
    await queue.removeJobScheduler('sched-league-entitlement-reconcile');
  }
  if (config.MULTI_BASE_ENABLED === 'true') {
    // Queue-global, not merely Worker-local: an accidental second worker
    // replica must not overlap finalized RPC sweeps and multiply the bounded
    // 32-read authority load.
    await scheduleDeedOwnershipObserver(deedOwnershipQueue);
  } else {
    // A flag-off worker recreation must stop the existing repeat producer too;
    // merely omitting the Worker would leave delayed jobs accumulating in Redis.
    await deedOwnershipQueue.removeJobScheduler(DEED_OWNERSHIP_SCHEDULER_ID);
    await deedOwnershipQueue.removeGlobalConcurrency();
  }

  // FINALIZED commitment is the verification bar for money (ARCHITECTURE §5) —
  // deliberately NOT the 'confirmed' the root relay uses. The worker MUST use the
  // FULL combined verifier (same as the on-demand route) — a program-only verifier
  // here expires paid direct-SOL/SPL deposits (mine, mine_build, keep_deposit) for
  // abandoned sessions (owner 2026-07-20 — latent-bug fix).
  const finalized = makeDepositRpcConnection(config.SOLANA_RPC_URL);
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const deedCollection = loadAddresses(repoRoot, config.SOLANA_CLUSTER)?.deedCollection ?? null;
  const deedOwnershipReader = makeFinalizedDeedReader({
    rpcUrl: config.SOLANA_RPC_URL,
    ...(deedCollection ? { deedCollection } : {}),
  });
  let hot: ReturnType<typeof hotWalletInfo> = null;
  try { hot = hotWalletInfo(config); } catch { /* hot wallet optional — SOL deposits still verify */ }
  const paidBaseAddresses = loadAddresses(repoRoot, config.SOLANA_CLUSTER);
  const paidBaseNetwork = paidBaseAddresses ? basePurchaseNetwork(config.SOLANA_CLUSTER, paidBaseAddresses) : undefined;
  const primaryDepositVerifier = makeCombinedDepositVerifier(
    finalized, { liquidity: liquidityWallet(config), hot, ...(paidBaseNetwork ? { basePurchaseNetwork: paidBaseNetwork } : {}) },
  );
  const depositVerifier = config.SOLANA_RPC_URL_2
    ? requireMatchingDepositVerifiers(
      primaryDepositVerifier,
      makeCombinedDepositVerifier(
        makeDepositRpcConnection(config.SOLANA_RPC_URL_2),
        { liquidity: liquidityWallet(config), hot, ...(paidBaseNetwork ? { basePurchaseNetwork: paidBaseNetwork } : {}) },
      ),
    )
    : primaryDepositVerifier;
  // Same two-source finalized proof the API process uses for /settle, cancel
  // and takeover (money/marketPaymentProof.ts). Without the ops treasury the
  // reconciler reports itself unconfigured and touches nothing.
  const marketFeeTreasury = paidBaseAddresses?.treasuries?.ops;
  const marketReconcileDeps = marketFeeTreasury ? {
    cluster: config.SOLANA_CLUSTER,
    feeTreasury: marketFeeTreasury,
    ...makeMarketPaymentVerifiers(
      finalized, config.SOLANA_RPC_URL_2 ? makeDepositRpcConnection(config.SOLANA_RPC_URL_2) : null,
    ),
  } : {};
  const keepSender = hotWalletSender(config);
  const withdrawalAuthorizationGate = makeWithdrawalAuthorizationGate(config, db);
  // Signer-isolated worker owns every deed mint. Public API containers never
  // mount the admin key and therefore only queue the best-effort work.
  configureDeedMinter(deedMinter(config));
  // Built next to the sender, never lazily: if constructing the reader throws
  // (addresses file missing) the gate must see `null` and HOLD the queue, not
  // crash the job into a retry loop that looks like a payout failure.
  let payoutReserveReader: ReserveReader | null = null;
  try {
    payoutReserveReader = hotKeepReserveReader(config);
  } catch (error) {
    console.error(`[PAYOUT-RESERVE-READER-HELD] ${errorForStorage(error, 300)}`);
  }

  const worker = new Worker(QUEUE, async (job) => {
    const now = new Date();
    switch (job.name) {
      case 'snapshot': {
        const snap = await buildWeeklySnapshot(db, now);
        // Weekly solvency check rides the snapshot cadence: reserve (live hot-ATA
        // KEEP) vs all live player KEEP and escrowed KEEP liabilities. A shortfall is a
        // custody incident — log it as loudly as a worker can; /por publishes the
        // same numbers continuously. Never let a failed RPC read fail the snapshot.
        let reserves: unknown = null;
        try {
          const reader = hotKeepReserveReader(config);
          if (reader) {
            const check = await checkReserves(db, reader);
            reserves = {
              reserveKeep: check.reserveKeep.toString(),
              liabilityKeep: check.liabilityKeep.toString(),
              deficit: check.deficit.toString(),
              covered: check.covered,
              custodyEvidence: check.custodyEvidence
                ? publicCustodyReserveEvidence(check.custodyEvidence)
                : null,
            };
            if (!check.covered) {
              console.error(`[POR-SHORTFALL] hot wallet holds ${check.reserveKeep} KEEP against ${check.liabilityKeep} KEEP of liabilities — deficit ${check.deficit}. Custody is UNDER-RESERVED.`);
            }
          }
        } catch (e) {
          console.error('[por-check] reserve read failed — coverage unknown this week:', e);
        }
        // BullMQ JSON-stringifies return values — bigints must go out as strings.
        return serializeSnapshotJobResult(snap, reserves);
      }
      case 'league-reset': {
        const policy = {
          enabled: config.LEAGUE_REWARDS_ENABLED === 'true',
          startWeek: config.LEAGUE_REWARD_START_WEEK,
        };
        // The 00:15 job is the terminal recovery owner. If every coherent RPC
        // sweep failed, this commits the immutable unpaid close before clan
        // chests/reconciliation run, so neither settlement path is lost in a
        // scheduler race and gameplay is never fenced for the rest of the week.
        if (policy.enabled) {
          await recoverMissingLeagueCloses(
            db, now, policy,
            { reader: deedOwnershipReader, expectedCollection: deedCollection },
          );
        } else {
          await closeLeagueWeek(db, now, policy);
        }
        const result = await runWeeklyLeagueReset(
          db, now, policy,
        );
        if (result.failed > 0) {
          throw new Error(`league settlement left ${result.failed} receipt(s) pending`);
        }
        return serializeLeagueJobResult(result);
      }
      case 'league-close': {
        return closeLeagueWeek(db, now, {
          enabled: config.LEAGUE_REWARDS_ENABLED === 'true',
          startWeek: config.LEAGUE_REWARD_START_WEEK,
        }, { reader: deedOwnershipReader, expectedCollection: deedCollection });
      }
      case 'league-close-recovery': {
        return recoverMissingLeagueCloses(db, now, {
          enabled: config.LEAGUE_REWARDS_ENABLED === 'true',
          startWeek: config.LEAGUE_REWARD_START_WEEK,
        }, { reader: deedOwnershipReader, expectedCollection: deedCollection });
      }
      case 'league-entitlement-reconcile': {
        const result = await reconcilePendingLeagueRewards(
          db, now, {
            enabled: config.LEAGUE_REWARDS_ENABLED === 'true',
            startWeek: config.LEAGUE_REWARD_START_WEEK,
          },
        );
        if (result.failed > 0) {
          throw new Error(`league reconciliation left ${result.failed} receipt(s) pending`);
        }
        return serializeLeagueJobResult(result);
      }
      case 'pve-respawn':
        return respawnPveCamps(db, now);
      case 'mail-expiry':
        return expireDueMailRewards(db, now);
      case 'referral-gate':
        return qualifyReferrals(db, now);
      case 'emission-controller':
        return runEmissionController(db, now);
      case 'outbox-relay':
        if (job.data?.task === 'global-chat-retention') {
          return { skipped: 'global chat retention moved to its isolated queue' };
        }
        return relayOutbox(db, sendRoot, now);
      case 'deposit-watch':
        return pollPendingDeposits(db, depositVerifier, now);
      case 'market-reconcile':
        return reconcileMarketReservations(db, marketReconcileDeps, now);
      case 'deed-mint-reconcile':
        return reconcileMissingDeeds(db, 10);
      case 'live-raid-recovery': {
        // This scheduler is unconditional, unlike push delivery. Finish the
        // resumable 0101 classification while Mine pushes are still dark so
        // activation can neither flood old full buffers nor lose partial ones.
        const raidRecovery = await recoverLiveRaidLifecycle(db);
        const mineBootstrap = await classifyMineFullNotificationBootstrap(db);
        if (mineBootstrap.classified > 0 || mineBootstrap.held > 0) {
          console.log(`[notifications] Mine bootstrap: ${mineBootstrap.classified} classified, ${mineBootstrap.held} held`);
        }
        return raidRecovery;
      }
      case 'tester-sweep':
        // Moved to TESTER_SWEEP_QUEUE; a job materialized by an older scheduler
        // on this queue is a cheap no-op here.
        return { skipped: 'tester sweep moved to its isolated queue' };
      case 'deed-ownership':
        return { skipped: 'deed ownership observer moved to its isolated queue' };
      case 'withdrawals':
        // Real hot-wallet KEEP payout when provisioned; otherwise skip rather
        // than fail every row. Rows stay 'unbonding' until a sender exists —
        // visible in the skipped return below and in each row's status; a payout
        // failure records withdrawals.lastError. HOT_WALLET_KEYPAIR_PATH +
        // a funded KEEP ATA are the ops requirement.
        // The reserve reader is the payout gate's input (money/withdrawals.ts
        // makeCoverageGate) — built ONCE at worker start, alongside the sender it
        // gates, because both come from the same hot wallet: a deployment that
        // can pay must also be able to prove coverage. A null reader (or a dead
        // RPC) HOLDS the queue; it never opens it.
        return keepSender
          ? processDueWithdrawals(
              db, keepSender, payoutReserveReader, withdrawalAuthorizationGate,
              config.WITHDRAWALS_ENABLED === 'true', now,
            )
          : { skipped: 'withdrawal signer not configured — withdrawal payout disabled' };
      default:
        throw new Error(`unknown job: ${job.name}`);
    }
  }, { connection });

  await queue.add('league-close-recovery', {}, {
    // Always run once on boot: durable SQL fencing outlives both feature flags.
    // With no activation this is a no-op; with an already-protected missing
    // boundary it writes an unpaid close even after an operator kill switch.
    // The unique ID also prevents a retained failed attempt from deduping boot.
    jobId: leagueCloseRecoveryStartupJobId(),
    attempts: LEAGUES.closeSnapshotAttempts,
    backoff: { type: 'fixed', delay: LEAGUES.closeSnapshotRetryMs },
  });

  const avatarRetirementWorker = new Worker(AVATAR_RETIREMENT_QUEUE, async (job) => {
    if (job.name !== 'avatar-retirements') {
      throw new Error(`unknown avatar retirement job: ${job.name}`);
    }
    if (!avatarRetirementDelete) {
      // Development may intentionally omit R2, but accepting a queued deletion
      // as a successful no-op would make a cleared image remain public forever.
      throw new Error('profile avatar retirement storage is unavailable');
    }
    return drainAvatarRetirements(db, avatarRetirementDelete, new Date());
  }, { connection, concurrency: PROFILE_AVATAR.retirementWorkerConcurrency });

  const globalChatRetentionWorker = new Worker(GLOBAL_CHAT_RETENTION_QUEUE, async (job) => {
    if (job.name !== 'global-chat-retention') {
      throw new Error(`unknown global chat retention job: ${job.name}`);
    }
    return drainExpiredGlobalChat(db, new Date());
  }, { connection, concurrency: CHAT.retentionWorkerConcurrency });

  const feedbackRetentionWorker = new Worker(FEEDBACK_RETENTION_QUEUE, async (job) => {
    if (job.name !== 'feedback-retention') throw new Error('Unknown private feedback retention job');
    if (!feedbackStorage) throw new Error('Private feedback retention storage unavailable');
    try {
      // Independent sweeps still run when another storage operation fails.
      const results = await Promise.allSettled([
        cleanupFeedbackScreenshots(db, feedbackStorage),
        feedbackExportStorage ? cleanupFeedbackExports(db, feedbackExportStorage) : Promise.resolve({ failed: 0 }),
        cleanupFeedbackExportTemporaryDirectories(),
      ]);
      if (results.some(result => result.status === 'rejected'
        || ('failed' in result.value && result.value.failed))) throw new Error('Private feedback deletion failed');
      return { completed: true };
    } catch {
      // SQL/transport errors may contain private keys or URLs. Rows retain the
      // durable failure/retry state; telemetry receives only this stable code.
      throw new Error('Private feedback retention failed; durable cleanup will retry');
    }
  }, { connection, concurrency: 1 });

  const feedbackExportWorker = new Worker(FEEDBACK_EXPORT_QUEUE, async job => {
    if (job.name !== 'feedback-export') throw new Error('Unknown private feedback export job');
    if (!feedbackStorage || !feedbackExportStorage) throw new Error('Private feedback export storage unavailable');
    try {
      return await prepareNextFeedbackExport(db, config,
        { screenshots: feedbackStorage, exports: feedbackExportStorage }, feedbackExportStop.signal);
    } catch {
      throw new Error('Private feedback preparation failed; durable job will recover');
    }
  }, { connection, concurrency: 1 });

  const totpRecoveryWorker = new Worker(TOTP_RECOVERY_QUEUE, async (job) => {
    if (job.name !== 'totp-recovery') {
      throw new Error(`unknown authenticator recovery job: ${job.name}`);
    }
    return sweepExpiredTotpRecoveries(db, recoveryEmailSender, new Date());
  }, { connection, concurrency: 1 });

  const testerSweepWorker = new Worker(TESTER_SWEEP_QUEUE, async (job) => {
    if (job.name !== 'tester-sweep') throw new Error(`unknown tester sweep job: ${job.name}`);
    // One sweep at a time; BullMQ schedules the next occurrence only after this
    // one settles, so sweeps never overlap.
    return sweepTesterMilestones(db);
  }, { connection, concurrency: 1 });

  const mintEvidenceWorker = new Worker('playtest-mint-evidence', async () => {
    const collection = loadAddresses(identityRoot, selectedCluster(config))?.deedCollection;
    if (!collection) return { configured: false };
    return runConfiguredMintEvidenceReconciliation(db, config, collection);
  }, { connection, concurrency: 1 });

  const playtestStatsWorker = new Worker(PLAYTEST_STATS_QUEUE, async (job) => {
    if (job.name !== 'playtest-stats') throw new Error(`unknown playtest stats job: ${job.name}`);
    return refreshPublicPlaytestStats(db, config);
  }, { connection, concurrency: 1 });
  // First snapshot at boot: /playtest/stats answers 503 until one exists, and
  // the scheduler's first occurrence is a full refresh interval away.
  await playtestStatsQueue.add('playtest-stats', {}, {
    jobId: `playtest-stats-startup-${Date.now()}`,
  });

  const notificationSweepWorker = pushTransport || fcmTransport
    ? new Worker(NOTIFICATION_SWEEP_QUEUE, async (job) => {
        if (job.name !== 'notification-sweep') throw new Error(`unknown notification sweep job: ${job.name}`);
        const sweep = await sweepDueNotifications(db, pushTransport, new Date(), {
          mineFullEnabled: config.MINE_FULL_NOTIFICATIONS_ENABLED === 'true',
          ...(fcmTransport ? { fcmTransport } : {}),
        });
        if (sweep.sent || sweep.failed || sweep.capped) {
          console.log(`[notifications] sweep: ${sweep.sent} sent, ${sweep.failed} failed, ${sweep.capped} capped, ${sweep.held} held`);
        }
        return sweep;
      }, { connection, concurrency: 1 })
    : null;

  const devnetFaucetWorker = devnetFaucetSender
    ? new Worker(DEVNET_FAUCET_QUEUE, async (job) => {
        if (job.name !== 'devnet-faucet') throw new Error(`unknown devnet faucet job: ${job.name}`);
        const sweep = await processDevnetFaucetGrants(db, devnetFaucetSender, new Date());
        if (sweep.sent || sweep.failed || sweep.skipped) {
          console.log(`[devnet-faucet] sweep: ${sweep.sent} sent, ${sweep.failed} failed, ${sweep.skipped} skipped`);
        }
        return sweep;
      }, { connection, concurrency: 1 })
    : null;

  const deedOwnershipWorker = config.MULTI_BASE_ENABLED === 'true'
    ? new Worker(DEED_OWNERSHIP_QUEUE, async (job) => {
        if (job.name !== 'deed-ownership') throw new Error(`unknown deed ownership job: ${job.name}`);
        // One sweep at a time. BullMQ schedules the next occurrence as the
        // preceding one becomes active, so this cannot overlap a prior sweep;
        // the observer's own bounded 32-wide batches enforce the global RPC cap.
        return summarizeOwnershipSweep(
          await sweepActiveBaseOwnership(db, deedOwnershipReader, deedCollection, new Date()),
        );
      }, { connection, concurrency: 1 })
    : null;

  if (deedOwnershipWorker) {
    // Downtime naturally makes every observation stale. Queue one immediate
    // full pass only after the healing worker exists; queue-global concurrency
    // keeps it serialized with the repeating scheduler and other replicas.
    await deedOwnershipQueue.add('deed-ownership', {}, {
      jobId: `deed-ownership-startup-${Date.now()}`,
    });
  }

  // M23 a8 (owner 2026-08-15): retired keep-skin D-009 refund sweep, once per
  // worker boot. Idempotent (per-wallet ledger keys), so re-runs are free and a
  // reserved mid-sale listing skipped today is caught by the next boot.
  // Worker-only by construction — the public API container never enters
  // startWorkers — and a failure must not take the custody worker down: the
  // sweep is retried on every boot until it reports clean.
  try {
    const sweep = await refundRemovedSkins(db);
    console.log(
      `[skin-refund] sweep done: ${sweep.refunded} refunded, ${sweep.mailed} mailed, `
      + `${sweep.skippedReserved} reserved skipped`,
    );
  } catch (e) {
    console.error('[skin-refund] SWEEP FAILED — retired-skin refunds are OWED (D-009) and will retry next boot:', e);
  }

  // D-058 (owner 2026-08-16): one-shot elite-troop grandfather backfill. Every
  // wallet that could train dragon/direwyvern/gloamfang/hexbarrow/mage under
  // the retired Keep-level rules keeps the ability (troop_unlocks rows). Self-
  // marking (any source='grandfather' row skips the scan), and NOT the only
  // safety net: train/research lazily self-heal wallets already fielding the
  // troop, so worker downtime cannot strand a live army (the R9 lesson).
  try {
    const grandfathered = await grandfatherEliteTroopUnlocks(db);
    console.log(grandfathered.skipped
      ? '[troop-unlocks] grandfather backfill already complete — skipped'
      : `[troop-unlocks] grandfather backfill done: ${grandfathered.inserted} unlock rows seeded`);
  } catch (e) {
    console.error('[troop-unlocks] GRANDFATHER BACKFILL FAILED — will retry next boot; the lazy train-gate self-heal still protects live armies:', e);
  }

  // Failed jobs → Sentry as `pkw-worker` (audit 2026-09-05 SENTRY-02): a
  // payout, mint or sweep that keeps failing was only ever a console line on
  // the box. The relay is rate-limited and never throws, so a retry storm
  // cannot recurse into the worker.
  const workers = [
    worker, avatarRetirementWorker, globalChatRetentionWorker, feedbackRetentionWorker, feedbackExportWorker, totpRecoveryWorker,
    testerSweepWorker, playtestStatsWorker, mintEvidenceWorker, notificationSweepWorker, devnetFaucetWorker,
    deedOwnershipWorker,
  ];
  for (const w of workers) {
    w?.on('failed', (job, err) => {
      relayServerError(err, {
        logger: 'pkw-worker',
        route: `job:${job?.name ?? 'unknown'}`,
        ...(job?.id !== undefined ? { reqId: String(job.id) } : {}),
        ...(err instanceof DeedMintInventoryError ? { mintInventory: err.diagnostics } : {}),
      });
    });
  }

  const closeExisting = async () => {
      feedbackExportStop.abort();
      await feedbackExportWorker.close();
      if (deedOwnershipWorker) await deedOwnershipWorker.close();
      if (devnetFaucetWorker) await devnetFaucetWorker.close();
      if (notificationSweepWorker) await notificationSweepWorker.close();
      await mintEvidenceWorker.close();
      await playtestStatsWorker.close();
      await testerSweepWorker.close();
      await totpRecoveryWorker.close();
      await globalChatRetentionWorker.close();
      await feedbackRetentionWorker.close();
      await avatarRetirementWorker.close();
      await worker.close();
      await avatarRetirementQueue.close();
      await globalChatRetentionQueue.close();
      await feedbackRetentionQueue.close();
      await feedbackExportQueue.close();
      await totpRecoveryQueue.close();
      await devnetFaucetQueue.close();
      await notificationSweepQueue.close();
      await mintEvidenceQueue.close();
      await playtestStatsQueue.close();
      await testerSweepQueue.close();
      await deedOwnershipQueue.close();
      await queue.close();
  };
  // Start after existing worker setup so an earlier boot error cannot orphan
  // this scheduler. Its own startup failure closes every resource it created.
  let starterReturns: Awaited<ReturnType<typeof startStarterExpeditionScheduler>>;
  try {
    starterReturns = await startStarterExpeditionScheduler(config.DATABASE_URL, config.REDIS_URL);
  } catch (error) {
    await closeExisting();
    throw error;
  }
  // The dedicated default-off auction queue starts after starter returns. Its
  // constructor owns cleanup of partial startup; the worker owns its close lifecycle.
  let seekerAuctions: Awaited<ReturnType<typeof startSeekerAuctionCrankWorker>>;
  try {
    seekerAuctions = await startSeekerAuctionCrankWorker(config, selectedIdentity);
  } catch (error) {
    try { await starterReturns.close(); }
    finally { await closeExisting(); }
    throw error;
  }
  let devnetOnly: Awaited<ReturnType<typeof loadDevnetOnlyJobs>>;
  try {
    devnetOnly = await loadDevnetOnlyJobs({ cluster: config.SOLANA_CLUSTER, enabled: config.DEVNET_SKR_FAUCET_ENABLED,
      options: { config, db, addresses: selectedIdentity } });
  } catch (error) {
    try { await seekerAuctions?.close(); }
    finally { try { await starterReturns.close(); } finally { await closeExisting(); } }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= (async () => {
    try { await devnetOnly?.close(); }
    finally {
      try { await seekerAuctions?.close(); }
      finally {
        try { await starterReturns.close(); }
        finally { await closeExisting(); }
      }
    }
  })() };
}

/**
 * Config for the ON-CHAIN deed URI sync (deedChainSync.ts), or null when any
 * piece is missing — same disabled-no-op guard as the minter above.
 *
 * Deliberately reuses the minter's inputs: the admin key that MINTED a deed is
 * its update authority, and the public base must be the one the deed's URI was
 * written with, or we would repoint every deed at a document nobody serves.
 */
export function deedChainSyncConfig(config?: ChainRuntimeConfig): DeedChainConfig | null {
  // EXPLICIT OPT-IN. Everything else this function needs is already set for
  // minting and epoch roots, so without a flag the loop would switch itself on
  // the moment an admin key appeared — and the only way to stop it would be to
  // remove that key, which also kills post_root and deed minting. A loop that
  // spends money unattended gets its own switch.
  if (process.env['DEED_CHAIN_SYNC'] !== 'true') return null;
  // SIGNER PREFERENCE (dynamic deeds, owner GO 2026-08-03): the sweep runs
  // unattended, so it should hold the DEED-OPS delegate key — installed on the
  // collection by `deed:update-delegate`, able to rewrite deed URIs/names but
  // NOT to mint KEEP, post epoch roots or move the treasury. The admin path
  // stays as the fallback so existing deployments keep working, but loudly: a
  // silently admin-signed loop is exactly the exposure the ops key removes.
  const opsPath = process.env['DEED_OPS_KEYPAIR_PATH'];
  const signerPath = opsPath ?? process.env['ADMIN_KEYPAIR_PATH'];
  if (!signerPath) return null;
  const repoRoot = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const collection = loadAddresses(repoRoot, selectedCluster(config))?.deedCollection;
  if (!collection) return null;
  // Must match the host the URI was minted against. deedAssetBase() already
  // prefers R2 and refuses loopback, which is exactly the constraint here: a
  // localhost base would rewrite every deed into an unreadable URI on chain.
  const publicBaseUrl = deedAssetBase();
  if (!publicBaseUrl) return null;
  if (!opsPath) {
    // Allowed, but said out loud at boot — the operator should know the loop
    // is spending from (and could lose) the master key.
    console.warn(
      '[deed-chain] signing the unattended URI sweep with the ADMIN key (DEED_OPS_KEYPAIR_PATH '
      + 'not set). The admin key also mints KEEP and moves the treasury; delegate a deed-ops key '
      + 'with `pnpm --filter @shardkeep/scripts deed:update-delegate` and set DEED_OPS_KEYPAIR_PATH.',
    );
  }
  return {
    rpcUrl: selectedRpcUrl(config),
    // May be the ops delegate rather than the admin — DeedChainOpts.adminSecret
    // is simply "the signer"; the balance floor reads whichever key is here.
    adminSecret: keypairFromFile(signerPath).secretKey,
    collection,
    publicBaseUrl,
  };
}
