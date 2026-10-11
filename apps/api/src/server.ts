import { basePurchaseNetwork } from './money/basePurchases';
import { existsSync } from 'node:fs';
import { assertDevnetOnlyAbsentOnMainnet } from './devnetOnlyLoader';
/** Process entrypoint: load env (fail-fast), connect, bootstrap, listen. */
import { BASE_OWNERSHIP, ECONOMY, TOKEN } from '@shardkeep/shared';
import {
  assertIndependentRpcProviders, assertMainnetAddressRegistry, assertMainnetCluster, assertSolanaCluster,
  keepAta, loadAddresses, SeekerRpcError,
} from '@shardkeep/chain';
import { buildApp } from './app';
import { consoleEmailSender } from './auth/twofa';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { assertMigrationsCurrent, runMigrations } from './db/migrate';
import { ensureGameConfig } from './game/gameConfig';
import { assertMarketRecoveryCompatible } from './game/itemMarketCompatibility';
import { runEmissionController } from './game/emissionController';
import { deedObserverCoverage, makeFinalizedDeedReader } from './game/baseOwnership';
import { hotKeepReserveReader, hotWalletInfo, liquidityWallet, startWorkers, deedChainSyncConfig } from './jobs';
import { r2ConfigFromEnv, setDeedSyncDisabled, startDeedMetadataSync } from './game/deedR2';
import { makeR2AvatarStorage } from './game/playerAvatar';
import { feedbackR2ConfigFromEnv, makeFeedbackScreenshotStorage } from './game/feedbackStorage';
import { makeFeedbackExportStorage } from './game/feedbackExportStorage';
import { DEFAULT_CHAIN_SYNC_MS, setDeedChainSyncDisabled, startDeedChainSync } from './game/deedChainSync';
import { bootstrapEconomyAllocations } from './ledger';
import { activateDeedEconomyCutover, completePendingBaseEconomyBackfills } from './game/baseEconomy';
import { assertNoIncompatibleStartedLiveRaids } from './game/raids';
import { makeResendEmailSender } from './lib/resend';
import {
  makeCombinedDepositCommitVerifier, makeCombinedDepositVerifier, makeDepositRpcConnection,
  requireMatchingDepositCommitVerifiers, requireMatchingDepositVerifiers,
} from './money/depositWatcher';
import { assertEconomyChainIdentity, assertGemsReserveIdentity } from './money/economyIdentity';
import { makeMarketPaymentVerifiers } from './money/marketPaymentProof';
import { initTelemetry } from './telemetry';
import { createMiningTransparencyRuntime } from './money/miningTransparencyRuntime';
import { createPhaseEServices } from './phaseEServices';
import { resolvePhaseEKeepIdentity, assertPhaseEKeepIdentity } from './money/phaseEKeepIdentity';
import { createMiningPublicationReceiptRuntime } from './mining/publicationReceiptRuntime';
import { createMiningClaimRuntime } from './mining/claimRuntime';
import { createRealmSaleRuntime } from './seeker/realmSaleRuntime';
import { createSeekerAuctionRuntime } from './seeker/auctionRuntime';
import { createMiningTaxRuntime } from './mining/taxRuntime';
import { createConfiguredCharterWorkflowRuntime } from './game/charterConfiguredRuntime';
import { createCharterRecoveryRuntime } from './game/clanCharterRecoveryRuntime';
import { createConfiguredKeepMarketRuntime } from './game/keepMarketConfiguredRuntime';
import { createVehicleRuntime } from './game/vehicleRuntime';
import { assertSkrMintPinsAgree } from './money/skrIdentity';

async function main(): Promise<void> {
  const config = loadConfig();
  // No reviewed v4 ceremony packet or authorized publisher is installed in this
  // ordinary entrypoint. the content pipeline's separately reviewed private composition must
  // supply it; env values alone cannot activate a recovery or signing runtime.
  if (config.MINING_PUBLICATION_RECOVERY_ENABLED === 'true' || config.MINING_PUBLICATION_JOB_ENABLED === 'true') {
    throw new Error('Mining publication startup requires the actual reviewed KEEP v4 binding and private composition; both publication flags must remain disabled');
  }
  // Arm the analytics/Sentry relays before anything can fail or emit: the
  // workers start below and their failed jobs relay through the same module.
  initTelemetry(config);
  const repoRoot = config.REPO_ROOT ?? process.cwd();
  const addresses = loadAddresses(repoRoot, config.SOLANA_CLUSTER);
  assertDevnetOnlyAbsentOnMainnet(config.SOLANA_CLUSTER, existsSync, process.env);
  assertSkrMintPinsAgree(addresses, config);
  // A selected v4 identity refuses here until an actual reviewed packet is
  // supplied by a separately reviewed composition. Never fall back to v3.
  const selectedPhaseEKeep = addresses ? resolvePhaseEKeepIdentity(config, addresses) : null;
  if (config.SOLANA_CLUSTER === 'mainnet-beta' && !addresses) {
    throw new Error(
      `mainnet-beta requires the reviewed public registry ${repoRoot}/infra/mainnet.addresses.json`,
    );
  }

  // Prove the ECONOMY endpoints before migrations, ledger bootstrap, routes or
  // workers can touch state. A URL label is not a cluster identity: only the
  // stable genesis hash is. Mainnet additionally requires different endpoint
  // hosts plus distinct operator-declared vendor labels, and both endpoints
  // must prove the same selected cluster.
  const economyRpcUrls = [config.SOLANA_RPC_URL, config.SOLANA_RPC_URL_2]
    .filter((url): url is string => Boolean(url));
  if (config.SOLANA_CLUSTER === 'mainnet-beta') {
    assertIndependentRpcProviders(economyRpcUrls);
  }
  for (const rpcUrl of economyRpcUrls) {
    await assertSolanaCluster({ rpcUrl, cluster: config.SOLANA_CLUSTER });
  }
  if (config.SOLANA_CLUSTER === 'mainnet-beta') {
    if (!addresses) throw new Error('mainnet address registry vanished during startup');
    await Promise.all(economyRpcUrls.map((rpcUrl) => (
      assertMainnetAddressRegistry(makeDepositRpcConnection(rpcUrl), addresses)
    )));
  }
  console.log(
    `[chain] ${config.SOLANA_CLUSTER} confirmed by genesis hash on ${economyRpcUrls.length} RPC endpoint(s)`,
  );

  if (config.MINT_EVIDENCE_RPC_URL && !economyRpcUrls.includes(config.MINT_EVIDENCE_RPC_URL)) {
    await assertSolanaCluster({ rpcUrl: config.MINT_EVIDENCE_RPC_URL, cluster: config.SOLANA_CLUSTER });
  }

  const { db } = createDb(config.DATABASE_URL);

  // ASSERT, don't apply. The property worth keeping is "code never runs against a
  // schema it predates" (the 0018 re-center left bases at old coords while the
  // client drew the centered claim). Applying it HERE is what does not survive a
  // second container: drizzle's migrator takes no advisory lock, so N booting
  // processes all apply, and a data-only migration double-applies silently.
  // infra/deploy.sh runs db:migrate as its own single-shot step; this refuses to
  // serve if that step was skipped. See db/migrate.ts.
  //
  // RUN_MIGRATIONS_ON_BOOT=true restores the old behaviour for a single-process
  // local run where there is no deploy script. Positive flag, default off.
  if (process.env['RUN_MIGRATIONS_ON_BOOT'] === 'true') {
    await runMigrations(db);
  } else {
    await assertMigrationsCurrent(db);
  }
  await assertMarketRecoveryCompatible(db);

  if (!addresses) throw new Error(`selected ${config.SOLANA_CLUSTER} economy registry is missing`);
  const phaseEKeepIdentity = selectedPhaseEKeep ? await assertPhaseEKeepIdentity(db, selectedPhaseEKeep) : null;
  const knownDevnet = loadAddresses(repoRoot, 'devnet');
  if (!knownDevnet) throw new Error('known devnet economy registry is missing');
  await assertEconomyChainIdentity(db, {
    cluster: config.SOLANA_CLUSTER,
    keepMint: addresses.keepMint,
    coreProgram: addresses.coreProgram,
    configPda: addresses.config,
  }, {
    cluster: 'devnet',
    keepMint: knownDevnet.keepMint,
    coreProgram: knownDevnet.coreProgram,
    configPda: knownDevnet.config,
  });

  await assertGemsReserveIdentity(db, config, {
    cluster: config.SOLANA_CLUSTER, keepMint: addresses.keepMint,
    coreProgram: addresses.coreProgram, configPda: addresses.config,
  }, [config.SOLANA_RPC_URL, config.SOLANA_RPC_URL_2]
    .filter((url): url is string => Boolean(url)).map(makeDepositRpcConnection));

  // Seed the single finite KEEP play pool, then permanently consolidate the
  // obsolete quest allocation before any route or worker can post value.
  await bootstrapEconomyAllocations(db);
  // Migration SQL prepares deed accounts but never edits cached balances.
  // Complete the auditable ledger cutover before any gameplay route can serve;
  // a failure here is a deliberate readiness failure, never mixed ownership.
  await completePendingBaseEconomyBackfills(db);
  // D-036: a battle that crossed first deploy may never be cancelled by a
  // simulator rollout. Deployment drains such rows with the old compatible
  // worker before this binary starts; refuse readiness if that protocol was
  // skipped. The irreversible deed-economy DB fence comes only afterward.
  await assertNoIncompatibleStartedLiveRaids(db);
  await activateDeedEconomyCutover(db, config.MULTI_BASE_ENABLED === 'true');

  // Seed the singleton runtime-lever row (#45 emission multiplier, #46 warzone mode).
  await ensureGameConfig(db);

  let workers: Awaited<ReturnType<typeof startWorkers>> | undefined;
  let miningTransparency: ReturnType<typeof createMiningTransparencyRuntime> = null;
  let phaseEServices: Awaited<ReturnType<typeof createPhaseEServices>> = null;
  let miningClaims: ReturnType<typeof createMiningClaimRuntime> = null;
  let publicationReceipts: ReturnType<typeof createMiningPublicationReceiptRuntime> = null;
  let realmSales: ReturnType<typeof createRealmSaleRuntime> = null;
  let seekerAuctions: ReturnType<typeof createSeekerAuctionRuntime> = null;
  let miningTax: ReturnType<typeof createMiningTaxRuntime> = null;
  let charterRecovery: ReturnType<typeof createCharterRecoveryRuntime> = null;
  let charterWorkflow: Awaited<ReturnType<typeof createConfiguredCharterWorkflowRuntime>> | null = null;
  let keepMarket: ReturnType<typeof createConfiguredKeepMarketRuntime> = null;
  let vehicleRuntime: ReturnType<typeof createVehicleRuntime> = null;
  try {
  // BullMQ repeatables (emission, snapshot, relay, …) — opt-in per process.
  if (process.env['ENABLE_WORKERS'] === 'true') {
    workers = await startWorkers(config, db);
    if (config.MULTI_BASE_ENABLED === 'true') {
      // startWorkers queues an immediate ownership sweep, but that sweep runs
      // asynchronously. The worker also serves its private /health endpoint, so
      // give its own healing pass one bounded SLA window before buildApp applies
      // the strict readiness gate. Public API processes do not enter this wait:
      // stale coverage still fails their boot immediately in buildApp.
      const deadline = Date.now() + BASE_OWNERSHIP.observationHealthFreshnessMs;
      let coverage = await deedObserverCoverage(db);
      if (!coverage.ok) {
        console.warn(
          `[multi-base] waiting for startup ownership sweep: ${coverage.uncovered} of `
          + `${coverage.active} active deed(s) uncovered`,
        );
      }
      while (!coverage.ok && Date.now() < deadline) {
        const remainingMs = Math.max(0, deadline - Date.now());
        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(BASE_OWNERSHIP.observationPollMs, remainingMs),
        ));
        coverage = await deedObserverCoverage(db);
      }
      if (!coverage.ok) {
        throw new Error(
          `[multi-base] startup ownership sweep timed out with ${coverage.uncovered} of `
          + `${coverage.active} active deed(s) uncovered; worker activation refused`,
        );
      }
      console.log(`[multi-base] ownership observer ready for ${coverage.active} active deed(s)`);
    }
  }

  // Emission controller (#45): BullMQ runs it when ENABLE_WORKERS. Without Redis
  // (a plain local boot) an interval drives it instead, so the treasury-aware
  // throttle still updates — crediting never depends on the workers (incident
  // 2026-07-18).
  //
  // POSITIVE FLAG, not `ENABLE_WORKERS !== 'true'`. That inversion asks "does this
  // process run the workers", but the work it guards is GLOBAL: with 3 API
  // containers all of them take the else-branch and the controller ticks 3x per
  // period. smoothEmissionBps is a per-TICK rate limiter (recoverStepBps 500), so
  // tripling the tick rate triples how fast emission recovers toward 1.0x during
  // a treasury drawdown — a silent breach of the policy the constant encodes,
  // with no error anywhere. Opt IN on the one process that should do it.
  let emissionTimer: NodeJS.Timeout | undefined;
  if (process.env['RUN_INPROC_SCHEDULERS'] === 'true') {
    const tick = (): void => {
      runEmissionController(db, new Date()).catch((e) => console.error('[emission-controller]', e));
    };
    void tick(); // once at boot so the multiplier reflects the current pool shape
    emissionTimer = setInterval(tick, ECONOMY.emissionControllerSec * 1000);
    emissionTimer.unref?.(); // never keep the process alive for this alone
  }

  // On-demand deposit verification at FINALIZED commitment. Wired ALWAYS (not
  // gated on ENABLE_WORKERS) so entry payments are credited from the client's
  // poll even when the background worker is off — the incident 2026-07-18 fix.
  const rpcUrl = config.SOLANA_RPC_URL;
  const depositFinalized = makeDepositRpcConnection(rpcUrl);
  const depositFinalizedSecondary = config.SOLANA_RPC_URL_2
    ? makeDepositRpcConnection(config.SOLANA_RPC_URL_2)
    : null;
  const marketFinalized = makeDepositRpcConnection(rpcUrl);
  const marketFinalizedSecondary = config.SOLANA_RPC_URL_2
    ? makeDepositRpcConnection(config.SOLANA_RPC_URL_2)
    : null;

  // Seeker verification reads a SECOND cluster, and nothing else in the config
  // says which one it is. A devnet URL in that slot makes every SGT check
  // silently answer "no badge" — or, on a cluster where anyone can create
  // accounts under the authorities the predicate trusts, silently grant one
  // (security review F8). So prove it by genesis hash, once, at boot.
  // BOTH endpoints, for the same reason: the cross-check source is compared for
  // AGREEMENT, so one pointed at the wrong cluster would answer "no SGT" for
  // everybody and deny every badge in the game.
  for (const url of [config.SOLANA_MAINNET_RPC_URL, config.SOLANA_MAINNET_RPC_URL_2]) {
    if (!url) continue;
    try {
      await assertMainnetCluster({ rpcUrl: url });
      console.log('[seeker] mainnet-beta confirmed by genesis hash');
    } catch (e) {
      // Unreachable ≠ wrong: an outage must not block a deploy, and SGT checks
      // already fail closed. A WRONG cluster is a misconfiguration — refuse.
      if (e instanceof SeekerRpcError) {
        console.error('[seeker] could not confirm the mainnet cluster (RPC unreachable) —'
          + ' SGT verification will fail closed until it answers:', e.message);
      } else throw e;
    }
  }
  if (config.SOLANA_MAINNET_RPC_URL && !config.SOLANA_MAINNET_RPC_URL_2) {
    // Not fatal — but the operator should know the badge rests on one endpoint,
    // and /me says the same thing to the client (`unconfirmed: true`).
    console.warn('[seeker] SINGLE SOURCE: set SOLANA_MAINNET_RPC_URL_2 to a different provider'
      + ' to cross-check SGT reads; until then every badge is reported unconfirmed');
  }

  // Public hot-wallet ADDRESS drives read-only flows wired ALWAYS: inbound KEEP
  // deposit verification/destination and PoR. The public API deliberately never
  // loads the mounted signer; instant payouts are queued for the worker.
  // SOL deposits (mine/mine_build → liquidity)
  // work regardless. Mine SOL → liquidity is wired whenever the liquidity address
  // is known — independent of the hot wallet.
  const liquidity = liquidityWallet(config);
  let hot: ReturnType<typeof hotWalletInfo> = null;
  let keepDeposit;
  try {
    hot = hotWalletInfo(config);
    if (hot) {
      keepDeposit = {
        hotWalletAta: keepAta(hot.pubkey, hot.keepMint).toBase58(),
        keepMint: hot.keepMint.toBase58(),
        decimals: TOKEN.decimals,
      };
    }
  } catch (e) {
    console.error('[hot-wallet] public config unavailable — instant withdrawals + KEEP deposits disabled:', e);
  }

  // Deed-transfer engine (S1/S2, 2026-07-27). S1-Q was decided by the owner
  // 2026-07-29 ("deed nfts should be tradeable"): transfers apply PULL-BASED —
  // the buyer claims via GET /base/claimable + POST /base/claim (game/baseClaim.ts),
  // which re-reads DAS for that one asset at claim time. `sweepDeedTransfers`
  // (the push watcher) stays DELIBERATELY UNWIRED, per the security review's
  // verdict; `transferBase` is shared by both and unchanged. The claim path
  // needs no boot wiring — it rides the market deps (Helius key + collection)
  // passed to buildApp below, and is unavailable when those are absent.

  // Deed metadata → R2 (owner 2026-07-26): while the api has no public host,
  // wallet UIs fetch each deed's JSON from the R2 bucket; this loop keeps those
  // objects matching live base state. Unconfigured → disabled, same guard story.
  try {
    const r2 = r2ConfigFromEnv();
    // Worker-only. This is background reconciliation, not request-path work, and
    // running it on every API container means N independent loops writing the
    // same R2 keys — plus N first-sweep storms re-PUTting every deed on every
    // deploy, because the dedupe map is per-process.
    const runsSchedulers = process.env['ENABLE_WORKERS'] === 'true'
      || process.env['RUN_INPROC_SCHEDULERS'] === 'true';
    if (r2 && runsSchedulers) {
      startDeedMetadataSync(db, r2);
      console.log(`[deed-r2] metadata sync on → ${r2.publicBaseUrl}/deed/asset/<asset>.json`);
    } else if (!r2 && runsSchedulers) {
      // THE CONTAINER THAT OWNS THE SYNC CANNOT RUN IT. That is a
      // misconfiguration, not a feature being off, and it is invisible: every
      // deed silently freezes at whatever was last published while the game
      // carries on looking healthy.
      //
      // It happened. The stack moved to infra/.env.local on 2026-07-30 and the
      // R2_* vars were only in the repo-root .env, which the container does not
      // read. Deeds stopped updating for FIVE DAYS and the only evidence was one
      // console.log at boot, scrolled away within minutes. Found by a player
      // noticing their NFT was wrong, which is the worst possible detector.
      //
      // So: warn, and KEEP warning. A boot-time line is not an alert — it has to
      // still be there in whatever log window someone actually opens.
      const warn = (): void => console.warn(
        '[deed-r2] MISCONFIGURED: this container runs the schedulers but R2_* is '
        + 'not fully set, so deed metadata and images are FROZEN. Every deed will '
        + 'keep showing whatever was last published. Set R2_ACCESS_KEY_ID, '
        + 'R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET and R2_PUBLIC_BASE_URL in '
        + 'the env file THIS container reads (infra/.env.local for the local '
        + 'stack, infra/.env.prod in production) and restart.',
      );
      warn();
      // unref: a warning must never be the reason the process refuses to exit.
      setInterval(warn, 30 * 60_000).unref();
      setDeedSyncDisabled('R2_* env not set on the container that owns the schedulers');
    } else if (!r2) {
      console.log('[deed-r2] metadata sync disabled (R2_* env not fully set)');
      setDeedSyncDisabled('R2_* env not set');
    } else {
      console.log('[deed-r2] metadata sync not run here (worker container owns it)');
      setDeedSyncDisabled('worker container owns the sync');
    }
  } catch (e) {
    console.error('[deed-r2] sync unavailable — deed metadata stays api-served:', e);
    setDeedSyncDisabled(`start failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Deed URI → chain. R2 above keeps the DOCUMENT current; this tells indexers
  // it changed, which is the only reason a wallet ever re-reads it. Same
  // worker-only rule as the R2 loop, and for a stronger reason: two containers
  // running this would pay twice for the same writes.
  try {
    const runsSchedulers = process.env['ENABLE_WORKERS'] === 'true'
      || process.env['RUN_INPROC_SCHEDULERS'] === 'true';
    // Do not even instantiate a signer config on a public API process. Only the
    // worker has the key mount and is allowed to read it.
    const chainCfg = runsSchedulers ? deedChainSyncConfig(config) : null;
    if (chainCfg && runsSchedulers) {
      startDeedChainSync(db, chainCfg);
      console.log(
        `[deed-chain] on-chain URI sync on → every ${DEFAULT_CHAIN_SYNC_MS / 60_000}m, `
        + `collection ${chainCfg.collection.slice(0, 4)}…`,
      );
    } else if (process.env['DEED_CHAIN_SYNC'] !== 'true') {
      // The deliberate default: the loop spends SOL, so it is opt-in. Recorded
      // (not just logged) so /health explains itself with a reason — the same
      // ok-true-with-reason story as the R2 leg (follow-up #5).
      setDeedChainSyncDisabled('DEED_CHAIN_SYNC not enabled');
      if (runsSchedulers) console.log('[deed-chain] on-chain URI sync OFF (DEED_CHAIN_SYNC not set to true)');
    } else if (!chainCfg) {
      // Someone OPTED IN and it still cannot run — that is a misconfiguration,
      // and its symptom is "wallets show stale traits" with a perfectly healthy
      // R2 leg: the exact confusion this whole feature came out of. Say what is
      // missing, and put it on /health where a check can see it.
      setDeedChainSyncDisabled(
        'DEED_CHAIN_SYNC=true but config incomplete (admin keypair / deedCollection / public metadata host)',
      );
      if (runsSchedulers) {
        console.warn(
          '[deed-chain] on-chain URI sync OFF despite DEED_CHAIN_SYNC=true (needs ADMIN_KEYPAIR_PATH, '
          + `a deedCollection in the ${config.SOLANA_CLUSTER} address registry, and a public metadata host). Deed `
          + 'documents will stay current, but wallets and explorers may keep showing the traits DAS '
          + 'cached at mint.',
        );
      }
    } else {
      setDeedChainSyncDisabled('worker container owns the sync');
      console.log('[deed-chain] on-chain URI sync not run here (worker container owns it)');
    }
  } catch (e) {
    console.error('[deed-chain] sync unavailable — deed documents still publish:', e);
    setDeedChainSyncDisabled(`start failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ONE shared verifier for the on-demand route AND the BullMQ worker (jobs.ts) —
  // a program-only worker would strand paid direct-SOL/SPL deposits (mine, mine_build,
  // keep_deposit) for abandoned sessions (owner 2026-07-20).
  const paidBaseNetwork = basePurchaseNetwork(config.SOLANA_CLUSTER, addresses);
  const primaryDepositVerifier = makeCombinedDepositVerifier(depositFinalized, { liquidity, hot, basePurchaseNetwork: paidBaseNetwork });
  const primaryDepositCommitVerifier = makeCombinedDepositCommitVerifier(
    depositFinalized, { liquidity, hot, basePurchaseNetwork: paidBaseNetwork },
  );
  const depositVerifier = depositFinalizedSecondary
    ? requireMatchingDepositVerifiers(
      primaryDepositVerifier,
      makeCombinedDepositVerifier(depositFinalizedSecondary, { liquidity, hot, basePurchaseNetwork: paidBaseNetwork }),
    )
    : primaryDepositVerifier;
  const depositPaymentCommitVerifier = depositFinalizedSecondary
    ? requireMatchingDepositCommitVerifiers(
      primaryDepositCommitVerifier,
      makeCombinedDepositCommitVerifier(depositFinalizedSecondary, { liquidity, hot, basePurchaseNetwork: paidBaseNetwork }),
    )
    : primaryDepositCommitVerifier;

  // Marketplace: Lane A (Helius DAS + deed collection) + the item market's SOL
  // settlement. The 5% item-market fee goes to the selected ops treasury;
  // /paid proves the exact buyer-signed split at confirmed before pinning, and
  // settlement proves it again at finalized. Addresses come only from the exact
  // selected-cluster registry; absent optional bits degrade on devnet, while a
  // missing mainnet registry was already a fatal startup error above.
  const deedCollection = addresses?.deedCollection;
  const feeTreasury = addresses?.treasuries?.ops;
  const marketDeps = {
    rpcUrl,
    cluster: config.SOLANA_CLUSTER,
    ...(config.HELIUS_API_KEY ? { heliusApiKey: config.HELIUS_API_KEY } : {}),
    ...(deedCollection ? { deedCollection } : {}),
    ...(feeTreasury ? {
      feeTreasury,
      ...makeMarketPaymentVerifiers(marketFinalized, marketFinalizedSecondary),
    } : {}),
  };

  // PoR coverage reader (guarded like the sender): /por publishes live
  // reserve-vs-liability when the hot wallet is provisioned.
  let reserveReader;
  try {
    reserveReader = hotKeepReserveReader(config) ?? undefined;
  } catch (error) {
    console.error(
      '[por] reserve reader construction failed; coverage remains unknown:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Is the gate on? Unanswerable from outside the box without this line, and the
  // failure it prevents is "I opened the alpha weeks ago and nobody could get in".
  if (config.PLAYTEST_OPEN === 'true') {
    console.log('[access] open playtest — no invite required');
  } else if (config.ALPHA_WALLETS) {
    console.warn(`[access] PLAYTEST GATE — ${config.ALPHA_WALLETS.length} env wallet(s) + invite redemptions (alpha_access) allowed`);
  } else {
    console.log('[access] open — ALPHA_WALLETS unset');
  }
  // Same visibility rule for the two other invisible-until-it-hurts switches on
  // the invite pipeline: the review panel and the bot check on the public form.
  if (config.ADMIN_WALLETS) {
    console.warn(`[admin] /admin/alpha review panel enabled for ${config.ADMIN_WALLETS.length} wallet(s)`);
  } else {
    console.log('[admin] ADMIN_WALLETS unset — every /admin/alpha route answers 404');
  }
  if (!config.TURNSTILE_SECRET_KEY) {
    console.warn('[alpha] TURNSTILE_SECRET_KEY unset — /alpha/apply accepts applications WITHOUT bot verification (dev mode; set it in production)');
  }

  // Email transport: Resend when fully configured, dev console otherwise. One loud
  // line either way — "which sender is live" is otherwise invisible until a
  // player doesn't get an invite (the deed-R2 lesson, in email form).
  let emailSender = consoleEmailSender;
  if (config.RESEND_API_KEY && config.EMAIL_FROM) {
    emailSender = makeResendEmailSender(config.RESEND_API_KEY, config.EMAIL_FROM);
    console.log(`[email] Resend configured — sending as "${config.EMAIL_FROM}"`);
  } else if (config.RESEND_API_KEY || config.EMAIL_FROM) {
    console.warn('[email] HALF-CONFIGURED: need BOTH RESEND_API_KEY and EMAIL_FROM — email challenges fail outside development');
  } else {
    console.warn('[email] no provider configured — development logs codes; every other environment fails email challenges');
  }

  // Profile pictures share the configured public bucket, but use a distinct
  // avatar-only putter guard (playerAvatar.ts). The API process needs these
  // credentials for request-time uploads even though the worker alone owns the
  // deed reconciliation loop.
  const avatarR2 = r2ConfigFromEnv();
  const feedbackR2 = feedbackR2ConfigFromEnv();
  const avatarPublicBaseUrl = process.env['R2_PUBLIC_BASE_URL']?.replace(/\/$/, '');
  if (!avatarR2) {
    console.warn('[avatar-r2] R2_* not fully set — profile reads remain available but avatar uploads answer 503');
  }

  miningTransparency = createMiningTransparencyRuntime(db, config, {
    cluster: config.SOLANA_CLUSTER, keepMint: addresses.keepMint,
    coreProgram: addresses.coreProgram, configPda: addresses.config,
  }, phaseEKeepIdentity ?? undefined);
  miningClaims = createMiningClaimRuntime(config, {
    cluster: config.SOLANA_CLUSTER, keepMint: addresses.keepMint,
    coreProgram: addresses.coreProgram, configPda: addresses.config,
  }, phaseEKeepIdentity ?? undefined);
  keepMarket = createConfiguredKeepMarketRuntime(config, { cluster: config.SOLANA_CLUSTER,
    keepMint: addresses.keepMint, keepMintV4: addresses.keepMintV4 }, phaseEKeepIdentity ?? undefined);
  realmSales = createRealmSaleRuntime(config);
  seekerAuctions = createSeekerAuctionRuntime(config, addresses);
  vehicleRuntime = createVehicleRuntime(config);
  charterRecovery = createCharterRecoveryRuntime(config);
  charterWorkflow = await createConfiguredCharterWorkflowRuntime(config, charterRecovery?.source);
  miningTax = createMiningTaxRuntime(config, {
    cluster: config.SOLANA_CLUSTER, keepMint: addresses.keepMint,
    coreProgram: addresses.coreProgram, configPda: addresses.config,
  }, phaseEKeepIdentity ?? undefined);
  publicationReceipts = phaseEKeepIdentity ? createMiningPublicationReceiptRuntime(config, phaseEKeepIdentity) : null;
  phaseEServices = await createPhaseEServices(config, db, {
    deedCollection: deedCollection ?? null,
    finalizedDeedReader: makeFinalizedDeedReader({ rpcUrl, deedCollection }),
  }, miningClaims ? { receiptSource: miningClaims.receiptSource, trust: miningClaims.provider.trust } : undefined,
  realmSales ? { receiptSource: realmSales.receiptSource, trust: realmSales.trust } : undefined,
  miningTax ? { receiptSource: miningTax.receiptSource, failureSource: miningTax.failureSource, trust: miningTax.trust } : undefined,
  vehicleRuntime?.sources, realmSales?.gameplaySources, charterRecovery?.source, miningClaims ? { reader: miningClaims.provider.reader, trust: miningClaims.provider.trust } : undefined, keepMarket?.sources, charterWorkflow.tournaments, charterWorkflow.client, charterWorkflow.retirement, charterWorkflow.migration, undefined,
  publicationReceipts && phaseEKeepIdentity ? {
    identity: phaseEKeepIdentity,
    verifierSources: { receiptSource: publicationReceipts.receiptSource, trust: publicationReceipts.trust },
  } : undefined);
  const app = await buildApp(config, db, {
    devnetOnlyAddresses: addresses,
    ...phaseEServices?.deps,
    ...(seekerAuctions ? { seekerAuctionSource: seekerAuctions.source } : {}),
    ...(miningTransparency ? { miningTransparencyReader: miningTransparency.read } : {}),
    ...(miningClaims ? { miningClaimsProvider: miningClaims.provider } : {}),
    ...(realmSales ? { realmSalePreparationSources: realmSales.preparationSources, realmSaleRelaySources: realmSales.relaySources } : {}),
    ...(miningTax ? { miningTaxPreparationSources: miningTax.preparationSources, miningTaxRelaySources: miningTax.relaySources } : {}),
    depositVerifier,
    depositPaymentCommitVerifier,
    // Public status and request admission must describe the same operational
    // boundary as the signer worker: a configured hot wallet alone is not
    // "instant available" while the payout kill switch is off.
    instantWithdrawalsEnabled: Boolean(hot) && config.WITHDRAWALS_ENABLED === 'true',
    ...(reserveReader ? { reserveReader } : {}),
    ...(keepDeposit ? { keepDeposit } : {}),
    basePurchaseNetwork: paidBaseNetwork,
    ...(liquidity ? { mineBuild: { liquidityWallet: liquidity.toBase58() } } : {}),
    market: marketDeps,
    emailSender,
    ...(avatarPublicBaseUrl ? { avatarPublicBaseUrl } : {}),
    ...(avatarR2 ? { avatarStorage: makeR2AvatarStorage(avatarR2) } : {}),
    ...(feedbackR2 ? { feedbackScreenshotStorage: makeFeedbackScreenshotStorage(feedbackR2) } : {}),
    ...(feedbackR2 ? { feedbackExportStorage: makeFeedbackExportStorage(feedbackR2) } : {}),
  });
  app.addHook('onClose', async () => { await workers?.close(); });
  app.addHook('onClose', async () => { miningTransparency?.close(); });
  app.addHook('onClose', async () => { miningClaims?.close(); });
  app.addHook('onClose', async () => { realmSales?.close(); });
  app.addHook('onClose', async () => { miningTax?.close(); });
  app.addHook('onClose', async () => { vehicleRuntime?.close(); });
  app.addHook('onClose', async () => { charterRecovery?.close(); });
  app.addHook('onClose', async () => { charterWorkflow?.close(); });
  app.addHook('onClose', async () => { keepMarket?.close(); });
  app.addHook('onClose', async () => { publicationReceipts?.close(); });
  // Avvio closes in reverse registration order: drain before aborting readers.
  app.addHook('onClose', async () => { await phaseEServices?.close(); });
  // Hooks run in reverse order: close auctions before Phase E services (570a554b).
  app.addHook('onClose', async () => { seekerAuctions?.close(); });
  const server = await app.listen({ port: config.PORT, host: config.HOST });
  phaseEServices?.start();
  void server;

  // Graceful shutdown (confirmed audit finding: no SIGTERM handling) — drain
  // in-flight requests and close DB/Redis so deploys don't cut mid-transaction.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (emissionTimer) clearInterval(emissionTimer);
      app.close().then(() => process.exit(0)).catch(() => process.exit(1));
    });
  }
  } catch (error) {
    seekerAuctions?.close();
    await phaseEServices?.close();
    publicationReceipts?.close();
    miningTransparency?.close();
    miningClaims?.close();
    realmSales?.close();
    miningTax?.close();
    vehicleRuntime?.close();
    charterRecovery?.close();
    charterWorkflow?.close();
    keepMarket?.close();
    await workers?.close();
    throw error;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
