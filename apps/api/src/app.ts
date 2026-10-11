import { registerSeekerAuctionRoutes } from './seeker/auctionRoutes';
import {registerBoundCosmeticWakeWorkshopRoutes} from './game/boundCosmeticWakeWorkshopRoutes';
import { loadDevnetOnlyRoutes, type DevnetOnlyContext } from './devnetOnlyLoader';
import type { ChainAddresses } from '@shardkeep/chain';
import type { ExtraGameToken } from './game/walletBalances';
import {registerBoundCosmeticWakeRoutes} from './game/boundCosmeticWakeRoutes';
import type {BoundCosmeticWakeViews} from './game/boundCosmeticWakeViews';
import {registerBoundCosmeticCollection} from './game/boundCosmeticCollection';
import {registerBoundCosmeticRoutes} from './game/boundCosmeticRoutes';
import type {BoundCosmeticWorkshop} from './game/boundCosmeticWorkshop';
import {registerRealmPassportRoutes} from './game/realmPassportRoutes';
import type {RealmPassportProvider} from './game/realmPassport';
import {registerDivineFragmentRoutes,type DivineFragmentRouteProvider} from './game/divineFragmentRoutes';
import { registerAdvancedExpeditionRoutes } from './game/advancedExpeditionRoutes';
import { registerCharterClientRoutes } from './game/clanCharterClientRoutes';
import type { CharterClientProvider } from './game/clanCharterClient';
import { registerCharterMigrationRoutes } from './game/clanCharterMigrationRoutes';
import type { CharterMigrationClientProvider } from './game/clanCharterMigrationClient';
import { registerCharterRetirementRoutes } from './game/clanCharterRetirementRoutes';
import type { CharterRetirementClientProvider } from './game/clanCharterRetirementClient';
import { registerCharterTournamentRoutes } from './game/clanCharterTournamentRoutes';
import type { CharterTournamentProvider } from './game/clanCharterTournaments';
import { registerCharterTournamentEventsRoutes } from './game/clanCharterTournamentEventsRoutes';
import type { CharterTournamentEventsClientProvider } from './game/clanCharterTournamentEventsClient';
import { registerDivineTrialRoutes } from './game/divineTrialRoutes';
import type { DivineTrialProvider } from './game/divineTrials';
import type { AdvancedExpeditionWorkflowProvider } from './game/advancedExpeditionWorkflow';
import { registerVehicleRoutes } from './game/vehicleRoutes';
import { registerVehicleClientRoutes } from './game/vehicleClientRoutes';
import { registerVehicleCraftClientRoutes } from './game/vehicleCraftClientRoutes';
import type { VehicleCraftClientProvider } from './game/vehicleCraftClient';
import type { VehicleClientProvider } from './game/vehicleClient';
import type { VehicleWorkflowProvider } from './game/vehicleWorkflow';
import { registerVehicleServiceRoutes } from './game/vehicleServiceRoutes';
import type { VehicleServiceWorkflowProvider } from './game/vehicleServiceWorkflow';
import { registerAdvancedFleetRoutes } from './game/advancedFleetRoutes';
import type { AdvancedFleetViewProvider } from './game/advancedFleetView';
import { registerAdvancedExpeditionGameplay, type AdvancedExpeditionGameplayProvider } from './game/advancedExpeditionGameplay';
// Phase E: prospective Mine source renewal for the existing collection route.
import { registerShardsTaxMineGameplay, type PhysicalMineSourceProvider } from './mining/shardsTaxMineGameplay';
import type { PhysicalMineRecoveryProvider } from './mining/shardsTaxMineRecoveryProvider';
import { registerMiningRosterEnrollment, type MiningRosterEnrollmentProvider } from './mining/rosterEnrollmentGameplay';
import { registerVehicleBerthOccupancy, type VehicleBerthOccupancyProvider } from './game/vehicleBerthOccupancy';
import type { BasePurchaseNetwork } from '@shardkeep/shared/basePurchases';
import { RedisRaidEventBus, registerRaidEventPublisher } from './lib/raidEventBus';
import { RaidEventHub } from './game/raidEvents';
import { getActiveBaseRaid } from './game/liveRaids';
import { recoverLiveRaidLifecycle } from './game/raids';
import { registerPlaytestCampaignRoutes, CAMPAIGN_PUBLIC_PATHS } from './routes-playtest-campaigns';
/**
 * Fastify app factory (ARCHITECTURE §5). Pure assembly — no listening, no env
 * reads — so tests can build the app against any config/db.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { z } from 'zod';
import { ATLAS_PREFIXES } from '@shardkeep/shared';
import { registerAuthRoutes } from './auth/routes';
import {
  assertRecentAuth, makeAuthenticate, makeAuthenticateLoginRecovery, makeRequireLandOwned, SESSION_COOKIE, verifyActiveSession,
} from './auth/session';
import {
  analyticsId, flushTelemetry, initTelemetry, pageviewProps, relayClientError, relayServerError, relayStats,
  sanitizeNativeTelemetryContext, serverTrack,
} from './telemetry';
import { registerAlphaRoutes } from './routes-alpha';
import { registerTesterRoutes, TESTER_PUBLIC_PATHS } from './routes-tester';
import { registerFeedbackManagementRoutes } from './routes-feedback-management';
import { registerFeedbackExportRoutes, type FeedbackExportRouteDeps } from './routes-feedback-exports';
import { PLAYTEST_PUBLIC_PATHS, registerStatsRoutes } from './routes-stats';
import { registerDevnetFaucetRoutes } from './routes-devnet-faucet';
import { registerLeagueRoutes } from './routes-leagues';
import { deedSyncHealth } from './game/deedR2';
import { deedChainSyncHealth } from './game/deedChainSync';
import { registerGameRoutes } from './game/routes';
import { registerWorkshopRoutes } from './game/workshopRoutes';
// Phase E: isolated free-base purchase surface, admission remains dark.
import { registerFreeBasePurchaseRoutes } from './game/freeBasePurchaseRoutes';
import { registerMiningClaimRoutes, type MiningClaimsProvider } from './mining/claimRoutes';
// Phase E KEEP tax: optional sources only; public runtime has no finality writer.
import { registerMiningTaxClaimRoutes } from './mining/taxClaimRoutes';
import { registerShardsTaxMineRoutes } from './mining/shardsTaxMineRoutes';
import { registerSeekerShardsRoutes } from './mining/seekerShardsRoutes';
import type { MiningTaxClaimPreparationSources } from './mining/taxClaimPreparation';
import type { MiningTaxClaimRelaySources } from './mining/taxClaimReconcile';
import { registerStarterFleetRoutes } from './game/starterFleetRoutes';
import { registerStarterExpeditionRoutes, type StarterExpeditionProvider, type StarterExpeditionAccessProvider } from './game/starterExpeditionRoutes';
import { registerHarvesterRoutes } from './game/harvesterRoutes';
// Phase E B4: original-owner resource recovery; fresh claims stay dark by default.
import type { SeekerResourceClaimProvider } from './game/seekerResourceClaimProvider';
import { registerSeekerResourceClaimRoutes } from './game/seekerResourceClaimRoutes';
import { registerRealmSaleRoutes } from './seeker/realmSaleRoutes';
import type { RealmSalePreparationSources } from './seeker/realmSalePreparation';
import type { RealmSaleRelaySources } from './seeker/realmSaleReconcile';
import { registerOrdinaryEquipmentRoutes } from './game/ordinaryEquipmentRoutes';
import type { StarterExpeditionWorkflow } from './game/starterExpeditionWorkflow';
import type { OrdinaryEquipmentProvider } from './game/ordinaryEquipmentProvider';
import { registerKeepEquipmentMarketRoutes } from './game/keepEquipmentMarketRoutes';
import type { KeepEquipmentMarketProvider } from './game/keepEquipmentMarketProvider';
import { registerOrdinaryCraftingRoutes } from './game/ordinaryCraftingRoutes';
import { CLIENT_CURRENCY_HEADER, EXPECTED_CURRENCY_HEADER, enterClientCurrency, parseClientCurrency, parseExpectedCurrency } from './game/clientCurrency';
import type { DeedReaders } from './game/baseClaim';
import { assertDeedObserverCapacityReady, deedObserverCoverage, type FinalizedDeedReader } from './game/baseOwnership';
import type { MarketPaymentCommitVerifier, MarketPaymentVerifier } from './game/itemMarket';
import { multiBaseEnabled, type Config } from './config';
import type { Db } from './db/client';
import { LedgerError } from './ledger';
import { HttpError } from './lib/errors';
import { custodyRefusal } from './lib/keepCustodyErrors';
import type { DepositVerifier } from './money/depositWatcher';
import type { DepositPaymentCommitVerifier } from './money/deposits';
import type { ReserveReader } from './money/snapshot';
import type { KeepTransferSender } from './money/withdrawals';
import { currentKeepMint } from './money/mintDimension';
import type { EmailSender } from './auth/twofa';
import { BUILD } from './version';
import { completePendingBaseEconomyBackfills } from './game/baseEconomy';
import type { AvatarStorage } from './game/playerAvatar';
import { registerFeedbackAttachmentRoutes, type FeedbackAttachmentRouteDeps } from './routes-feedback-attachments';
import { registerChatRoutes } from './chat/routes';
import { registerMailRoutes } from './mail/routes';
import { registerNotificationRoutes, registerNativeNotificationRoutes } from './notifications';
import { registerSolanaRpcRoutes, type SolanaRpcRelayDeps } from './routes-solana-rpc';
import { registerNativeRoutes } from './native/routes';
import { registerReleaseRoutes } from './routes-releases';

/** Public, uncredentialed GET/HEAD routes the landing origins may read
 *  (tests pin this list so no other route is ever opened to them). */
export const LANDING_READ_PATHS: readonly string[] = [...TESTER_PUBLIC_PATHS, ...PLAYTEST_PUBLIC_PATHS, ...CAMPAIGN_PUBLIC_PATHS, '/playtest/access'];

/** Optional wiring a caller (server.ts) injects; tests omit it. */
export interface AppDeps extends FeedbackAttachmentRouteDeps, FeedbackExportRouteDeps {
  /** SA-1: independently reviewed, finalized auction source; no DB fallback. */
  seekerAuctionSource?: import('./seeker/auctionRoutes').SeekerAuctionSource | null;
  devnetOnlyAddresses?: ChainAddresses | null;
  devnetOnlyImporter?: DevnetOnlyContext['importer'];
  /** Closed private-source services; never constructed from the request DB. */
  miningContributionProvider?: import('./game/miningContributionRoutes').MiningContributionProvider | null;
  freeBasePurchaseProvider?: import('./game/freeBasePurchaseRoutes').FreeBasePurchaseProvider | null;
  /** Separate read-only mining backing; never increases custodial coverage. */
  miningTransparencyReader?: () => Promise<import('./money/miningTransparency').MiningTransparency>;
  /** Explicit owner capability only; the ordinary runtime DB never becomes a Charter issuer. */
  charterClientProvider?: CharterClientProvider | null;
  charterRetirementClientProvider?: CharterRetirementClientProvider | null;
  charterMigrationClientProvider?: CharterMigrationClientProvider | null;
  charterTournamentProvider?: CharterTournamentProvider | null;
  charterTournamentEventsProvider?: CharterTournamentEventsClientProvider | null;
  divineTrialProvider?: DivineTrialProvider | null;
  divineFragmentProvider?: DivineFragmentRouteProvider | null;
  /** Read-only original-account history; never a claim or gameplay capability. */
  realmPassportProvider?: RealmPassportProvider | null;
  /** Phase E remains dark without explicit reviewed chain/relay wiring. No owner writer. */
  miningClaimsProvider?: MiningClaimsProvider | null;
  miningTaxPreparationSources?: MiningTaxClaimPreparationSources | null;
  miningTaxRelaySources?: MiningTaxClaimRelaySources | null;
  /** Phase E unsigned purchases require an explicitly reviewed source; dark by default. */
  realmSalePreparationSources?: RealmSalePreparationSources | null;
  realmSaleRelaySources?: RealmSaleRelaySources | null;
  solanaRpcRelay?: SolanaRpcRelayDeps;
  raidEvents?: RaidEventHub | undefined;
  /** Focused test seam; normal wiring comes from the validated dark-launch flag. */
  liveRaidV2Enabled?: boolean;
  socialTokenVerifier?: import('./auth/social').SocialTokenVerifier;
  /** Test seam for the devnet faucet's balance reads (null = no RPC). */
  devnetFaucetConnection?: import('@solana/web3.js').Connection | null;
  /** Validated, registry-selected network identity frozen into withdrawal proof. */
  withdrawalNetwork?: {
    cluster: Config['SOLANA_CLUSTER'];
    keepMint: string | null;
  };
  /** On-demand deposit verifier — makes the entry flow live WITHOUT the
   * background worker (incident 2026-07-18). Omitted in tests. */
  depositVerifier?: DepositVerifier;
  /** Exact confirmed proof required before /deposits/:id/paid persists a
   * client-submitted signature. Finalized depositVerifier still owns credit. */
  depositPaymentCommitVerifier?: DepositPaymentCommitVerifier;
  /** Test/local-only hot-wallet payout injection. Production never supplies it:
   * the signer-isolated worker settles every queued withdrawal. */
  keepSender?: KeepTransferSender;
  /** Public API availability switch for worker-paid instant withdrawals. In
   * production this requires both HOT_WALLET_PUBKEY and the payout worker's
   * WITHDRAWALS_ENABLED kill switch; no signer is injected. */
  instantWithdrawalsEnabled?: boolean;
  /** Dark-launch gate for starting lost-authenticator recovery. Existing rows
   * remain operable when false. */
  totpRecoveryEnabled?: boolean;
  /** Live hot-ATA KEEP balance reader (whole KEEP) — /por publishes reserve
   * coverage when present; absent (tests, no hot wallet) → coverage: null. */
  reserveReader?: ReserveReader;
  /** Email transport for 2FA codes + alpha invites. Dev logs to console; prod
   * wires a provider (lib/resend.ts). */
  emailSender?: EmailSender;
  /** Normalized public profile avatars. Kept separate from the deed R2 writer
   * so neither namespace guard can be widened by the other feature. */
  avatarStorage?: AvatarStorage;
  /** Read-only public URL is separate from write availability: a credential
   * outage must reject new uploads without making existing avatars disappear. */
  avatarPublicBaseUrl?: string;
  /** Focused lifecycle-test override; production always uses the shared bound. */
  avatarUploadReceiveTimeoutMs?: number;
  /** Transport for the server-side Turnstile verify on POST /alpha/apply.
   * Defaults to global fetch; tests inject a fake. */
  turnstileFetch?: typeof fetch;
  /** Transport for the READ-ONLY mainnet Seeker (SGT / `.skr`) reads. Omitted
   *  in production (global fetch); tests inject a fake mainnet. */
  seekerFetch?: typeof fetch;
  /** Closed owner capability for complete resource claims on restricted runtimes. */
  seekerResourceClaimProvider?: SeekerResourceClaimProvider | null;
  /** Reviewed server-only Seeker term connector. Absent/null refuses new departures. */
  starterExpeditionProvider?: StarterExpeditionProvider | null;
  starterExpeditionWorkflow?: StarterExpeditionWorkflow | null;
  /** Phase E: current-term physical Mine source, independent of fixed-round departures. */
  physicalMineSourceProvider?: PhysicalMineSourceProvider | null;
  /** Phase E: separately constructed owner-only historical repair capability. */
  physicalMineRecoveryProvider?: PhysicalMineRecoveryProvider | null;
  /** Phase E: separate owner capability captures first registered roster after base loading. */
  miningRosterEnrollmentProvider?: MiningRosterEnrollmentProvider | null;
  /** Phase E: authenticated original-actor burn workflow via a private owner capability. */
  vehicleWorkflowProvider?: VehicleWorkflowProvider | null;
  /** D153.182 injected ordinary vehicle clients; no production provider default. */
  vehicleClientProvider?: VehicleClientProvider | null;
  vehicleCraftClientProvider?: VehicleCraftClientProvider | null;
  /** Phase E: original-actor service consent/recovery through a private owner capability. */
  vehicleServiceWorkflowProvider?: VehicleServiceWorkflowProvider | null;
  /** Phase E: redacted current-owner fleet state through a closed owner capability. */
  advancedFleetViewProvider?: AdvancedFleetViewProvider | null;
  /** Phase E: closed owner capability for advanced dispatch/history/collection. */
  ordinaryEquipment?: OrdinaryEquipmentProvider | null;
  /** D153.190 default-off owner capability; no implicit RPC or payment rail. */
  keepEquipmentMarket?: KeepEquipmentMarketProvider | null;
  advancedExpeditionWorkflowProvider?: AdvancedExpeditionWorkflowProvider | null;
  /** Phase E: owner collection completes before the ordinary base read starts. */
  advancedExpeditionGameplay?: AdvancedExpeditionGameplayProvider | null;
  boundCosmeticWakeViews?: BoundCosmeticWakeViews | null;
  boundCosmeticWorkshop?: BoundCosmeticWorkshop | null;
  /** Phase E: owner-isolated occupancy projection, including while admissions pause. */
  vehicleBerthOccupancyProvider?: VehicleBerthOccupancyProvider | null;
  /** Independent reviewed owned-coverage source; absent keeps paid starts dark. */
  starterExpeditionAccessProvider?: StarterExpeditionAccessProvider | null;
  /** Separate explicit admission dependency; absent keeps Harvester starts dark. */
  harvesterProvider?: StarterExpeditionProvider | null;
  /** Inbound KEEP-deposit target: the hot wallet's KEEP ATA (destination) + mint
   * + decimals the client needs to build the SPL transfer. Present only when the
   * hot wallet is provisioned; absent → KEEP deposits are unavailable. */
  keepDeposit?: { hotWalletAta: string; keepMint: string; decimals: number };
  /** PROFILE › WALLET server-side balance reads (M23 round-3). Defaults from
   * config in buildApp; tests may inject fake URLs. Mainnet absent → those
   * token rows answer null (unavailable), never 0. `extraGameTokens`: QA chain lane only
   * (scripts/candidate/api.mjs), validated by assertExtraGameTokens. */
  walletHub?: { gameRpcUrl: string; mainnetRpcUrl?: string | undefined;
    extraGameTokens?: readonly ExtraGameToken[] | undefined } | undefined;
  /** Mine-build SOL destination: the liquidity pool wallet (100% of the SOL). */
  mineBuild?: { liquidityWallet: string };
  basePurchaseNetwork?: BasePurchaseNetwork | undefined;
  /** Marketplace: Lane A (Helius DAS + deed collection) + the item market's SOL
   * settlement (fee treasury + confirmed commit and finalized settlement
   * verifiers). All optional — Lane A degrades to links, and item-market payment
   * actions answer 503 until their exact verifier is wired. */
  market?: {
    cluster?: Config['SOLANA_CLUSTER'];
    heliusApiKey?: string;
    /** Finalized RPC used for authoritative Core ownership; DAS only discovers
     * candidates and never grants base mutation authority. */
    rpcUrl?: string;
    deedCollection?: string;
    feeTreasury?: string;
    verifyPayment?: MarketPaymentVerifier;
    verifyPaymentCommit?: MarketPaymentCommitVerifier;
    /** Pull-based base claim (S1-Q): DAS readers for /base/claim. Built from
     *  heliusApiKey + deedCollection when omitted; tests inject fakes. Null
     *  readers → claiming is unavailable (never a transfer on an unread deed). */
    deedReaders?: DeedReaders;
    /** Direct finalized Core reader for base mutation authority. Production
     * derives it from rpcUrl; tests inject deterministic ownership changes. */
    finalizedDeedReader?: FinalizedDeedReader;
  };
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}): Promise<FastifyInstance> {
  if (multiBaseEnabled()) await completePendingBaseEconomyBackfills(db);
  if (multiBaseEnabled()) await assertDeedObserverCapacityReady(db);
  const app = Fastify({
    logger: config.NODE_ENV !== 'test',
    /**
     * TRUST EXACTLY ONE PROXY HOP (Caddy).
     *
     * Without this, `req.ip` is the socket peer — which behind infra/Caddyfile is
     * the Caddy container, identically, for every request in the game. The rate
     * limiter below keys on `req.ip`, so the ENTIRE PLAYERBASE would share one
     * 300-req/min bucket and the login route's 20/min would be 20 sign-ins per
     * minute globally. At launch that is not a slow degradation, it is an
     * immediate self-inflicted outage: a hundred players with the map open
     * (WORLD.mapPollSec) saturate it in seconds. It also means the limiter
     * offers no per-attacker protection at all, since one abuser is
     * indistinguishable from everyone else.
     *
     * `1`, not `true`: trusting ALL proxies would let a client forge
     * X-Forwarded-For and mint itself a fresh bucket per request. One hop is
     * safe here specifically because Caddy REPLACES the header
     * (`header_up X-Forwarded-For {remote_host}`) rather than appending to it,
     * so a client-supplied value never survives.
     *
     * Direct-to-API deployments (no proxy) are unaffected: with no XFF present
     * Fastify falls back to the socket address.
     */
    trustProxy: 1,
  });

  // @fastify/cors v11 defaults methods to 'GET,HEAD,POST' — that blocks the
  // PUT /base/layouts/:slot, PATCH /move and DELETE routes browser-side
  // (preflight OK, real request ERR_FAILED). List every verb routes use.
  //
  // PER-REQUEST DELEGATION, not a static config (security review 2026-08-05
  // finding 5). Two CORS worlds must never mix:
  //  - WEB_ORIGIN: the game app's origins, CREDENTIALED — cookies ride along,
  //    so this list gates who can act as a signed-in player/admin.
  //  - LANDING_ORIGINS: the marketing site, allowed to reach EXACTLY ONE
  //    route (/alpha/apply, its preflight included) with credentials OFF.
  // Putting the landing site into WEB_ORIGIN instead would have let a
  // compromised Pages deploy (or a script it loads) make cookie-authed calls
  // to admin and money routes from a visiting admin's browser.
  await app.register(cors, () => (req: { url?: string }, cb: (err: Error | null, opts: object) => void) => {
    const path = (req.url ?? '').split('?')[0];
    // Tester board (owner 2026-08-21) and playtest statistics (D-103): the
    // landing page reads three public, uncredentialed GET routes. Same posture
    // as /alpha/apply — the landing origin is never added to WEB_ORIGIN and
    // never gets cookies.
    if (LANDING_READ_PATHS.includes(path ?? '')) {
      cb(null, {
        origin: [...config.WEB_ORIGIN, ...config.LANDING_ORIGINS],
        credentials: false,
        methods: ['GET', 'HEAD'],
      });
      return;
    }
    if (path === '/alpha/apply') {
      cb(null, {
        origin: [...config.WEB_ORIGIN, ...config.LANDING_ORIGINS],
        credentials: false,
        methods: ['POST'],
      });
      return;
    }
    cb(null, {
      // An exact-match allowlist (array), never a wildcard — credentials are sent.
      origin: config.WEB_ORIGIN,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      // Response provenance for the same two authenticated journey commands only.
      ...((path === '/starter-expeditions' || path === '/advanced-expeditions')
        ? { exposedHeaders: ['x-pkw-journey-created'] } : {}),
    });
  });
  await app.register(cookie);

  // Rate limiting (security review P0 api/no-rate-limit + deposit F1). Global
  // per-IP default; sensitive routes tighten it via `config.rateLimit`.
  // Skipped under test so the suite's rapid app.inject calls don't 429.
  //
  // REDIS-BACKED so the bucket is shared. An in-memory store gives each API
  // container its own counters, and the effective limit becomes N x max — the
  // limit silently loosens exactly when you add capacity because you are under
  // load. Wiring it now means a second container is a compose change rather
  // than a code change with a security consequence.
  if (config.NODE_ENV !== 'test') {
    const redis = new Redis(config.REDIS_URL, {
      // The plugin's own guidance: ioredis defaults are wrong for rate limiting.
      // A limiter must never become the slow part of a request — fail fast and
      // let skipOnError decide, rather than queueing commands behind a dead
      // socket while the player waits.
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    redis.on('error', (e: Error) => app.log.warn({ err: e }, 'rate-limit redis error'));
    // Close with the app, or tests and reloads leak connections.
    app.addHook('onClose', async () => { await redis.quit().catch(() => undefined); });

    await app.register(rateLimit, {
      global: true,
      max: config.RATE_LIMIT_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      redis,
      nameSpace: 'pkw-rl:',
      // A Redis blip must degrade to "unlimited", never to "500 on every
      // request". Losing rate limiting for a few seconds is a smaller problem
      // than taking the game down; the alternative makes Redis a hard dependency
      // of every single request, which it is not.
      skipOnError: true,
    });
  }

  await registerSolanaRpcRoutes(app, config, db, deps.solanaRpcRelay);

  app.decorate('authenticate', makeAuthenticate(config, db));
  app.decorate('authenticateLoginRecovery', makeAuthenticateLoginRecovery(config, db));
  app.decorate('assertRecentAuth', (req, purpose, intent) =>
    assertRecentAuth(config, req, purpose, intent));
  app.decorate('requireLandOwned', makeRequireLandOwned(db));
  // D-152: which in-game currency the client understands (E2-GEMS-CONTRACT §3).
  app.addHook('onRequest', async (req) => {
    enterClientCurrency(undefined); // Clear both fields even if parsing refuses this request.
    enterClientCurrency(parseClientCurrency(req.headers[CLIENT_CURRENCY_HEADER]),
      parseExpectedCurrency(req.headers[EXPECTED_CURRENCY_HEADER], req.raw.rawHeaders, req.method));
  });
  app.decorateRequest('wallet', '');
  app.decorateRequest('sessionId', '');

  // Errors: only HttpError messages (and benign ledger codes) reach clients —
  // everything else is logged in full and answered with an opaque 500.
  app.setErrorHandler((err, req, reply) => {
    const custodyError = custodyRefusal(err);
    if (custodyError) {
      return reply.status(custodyError.statusCode)
        .send({ error: { message: custodyError.message, code: custodyError.code } });
    }
    if (err instanceof HttpError) {
      // `code` is the optional machine-readable reason (e.g. ALPHA_GATED) —
      // present only when a client has to branch on WHY, never a new default.
      return reply.status(err.statusCode)
        .send({ error: { ...err.details, message: err.message, code: err.code } });
    }
    if (err instanceof LedgerError) {
      // Keep the stable client code, but not account IDs, balances or deltas
      // from the internal ledger exception. Domain-specific funds copy comes
      // from HttpError above when the action knows its currency and price.
      const message = err.code === 'ledger.insufficient_funds'
        ? 'Not enough funds for this action. Refresh your balances and try again.'
        : 'This transaction could not be completed. Please try again.';
      return reply.status(422).send({ error: { code: err.code, message } });
    }
    // Framework errors that carry a client 4xx (rate-limit 429, body-parse 400,
    // validation) are safe to surface with their own status — otherwise the
    // rate limiter's 429 would masquerade as a 500.
    const sc = (err as { statusCode?: number }).statusCode;
    if (typeof sc === 'number' && sc >= 400 && sc < 500) {
      return reply.status(sc).send({ error: { message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    // Sentry sees the API's own 500s too (audit 2026-09-05 SENTRY-02) — the
    // route PATTERN and a pseudonym, never the URL, body or wallet. Enqueue
    // only; the send is fire-and-forget and rate-limited inside the relay.
    relayServerError(err, {
      route: req.routeOptions.url ?? undefined, method: req.method, statusCode: 500,
      reqId: String(req.id), wallet: req.wallet || null,
    });
    return reply.status(500).send({ error: { message: 'Internal Server Error' } });
  });

  /**
   * Liveness. Fails loudly on an unreachable DB, and also reports BOTH deed
   * loops: the R2 metadata sync and the on-chain URI sync.
   *
   * WHY THE DEED SYNCS ARE HERE. On 2026-07-30 the R2 leg stopped running — the
   * R2_* vars were missing from the env file the container actually reads — and
   * nothing noticed for five days. The game was healthy the whole time; only
   * the NFTs were frozen, and it took a player looking at their own deed to
   * find it. The chain leg has the SAME silent failure shape (a stopped loop or
   * an empty payer freezes every wallet's view while R2 keeps publishing), so
   * it reports the same way (security review 2026-08-03 follow-up #5). Internal
   * warnings only help someone reading logs; the state has to be reachable from
   * OUTSIDE, by whatever polls this.
   *
   * 503 when a sync is supposed to be running and has visibly stopped, so an
   * ordinary HTTP uptime check catches it with no extra tooling. A process that
   * legitimately does not run a loop (an api container — the worker owns it;
   * a dev box with DEED_CHAIN_SYNC unset, the default) stays 200 with a reason,
   * or every developer's health check goes red and the signal is worthless.
   */
  app.get('/health', async (_req, reply) => {
    await db.execute(sql`select 1`); // db reachable or this route fails loudly
    const deedSync = deedSyncHealth();
    const deedChainSync = deedChainSyncHealth();
    const deedObserver = multiBaseEnabled() ? await deedObserverCoverage(db) : null;
    // `relay` = analytics relay outcomes since boot (events sent / rejected by
    // the vendor / network-failed). Informational, never a 503: a rejected
    // PostHog key is an ops signal, not an outage — but it was invisible
    // before this (audit 2026-09-05 POSTHOG-01).
    const relay = { ...relayStats };
    if (!deedSync.ok || !deedChainSync.ok || deedObserver?.ok === false) {
      return reply.status(503).send({ ok: false, deedSync, deedChainSync, deedObserver, relay });
    }
    return { ok: true, deedSync, deedChainSync, deedObserver, relay };
  });

  // What is running here. Unauthenticated and cheap on purpose: the client polls
  // it to notice a deploy, and it is the first thing to curl when production is
  // behaving strangely. `simVersion` is the one clients act on — see version.ts.
  app.get('/version', async () => BUILD);

  // Client telemetry sink (M23 a13). Validated no-op when no analytics keys
  // are configured; otherwise relays to PostHog under a pseudonymous id and
  // forwards the reliability tier to Sentry. Session cookie is OPTIONAL —
  // title/gate-screen events are pre-auth. Always 204: a telemetry failure
  // must never surface to a player, and the response must not confirm
  // whether relays are armed. Bounded and rate-limited: this is a sink, not
  // a general ingest surface.
  initTelemetry(config);
  // Deploys SIGTERM this process ~7 times a day; without a drain each one
  // dropped up to 10 s of buffered events (audit 2026-09-05 POSTHOG-01).
  app.addHook('onClose', async () => { await flushTelemetry(); });
  // PostHog's stock dashboards are built on `$pageview`; a custom-events-only
  // stream leaves them empty (audit OPS-01). The game is a single-URL app, so
  // its one page view is the app opening, at the play address (PLAY_URL, else
  // WEB_ORIGIN[0] — see pageviewProps).
  const pageview = pageviewProps(config);
  const telemetryLimit = { config: { rateLimit: { max: 30, timeWindow: 60_000 } } };
  const loadFailurePattern = new RegExp(`^(?:(?:${ATLAS_PREFIXES.join('|')})-(?:img|json)|sprite-meta):(image|json):(queued|loading|processing|complete|failed):(-|[0-9]{1,2}):(-|[0-5]?[0-9]{1,2}):([0-9]{1,9})/([0-9]{1,9})$`);
  // Independently validate every optional field: malformed diagnostics must not
  // discard the error itself or allow arbitrary provider/request data into Sentry.
  const clientErrorDiagnostics = z.object({
    renderState: z.enum(['loop-stopped', 'context-lost']).optional().catch(undefined),
    contextState: z.enum(['available', 'lost', 'restored']).optional().catch(undefined),
    activeScene: z.enum(['base', 'battle', 'none']).optional().catch(undefined),
    sceneState: z.enum(['loading', 'ready', 'failed']).optional().catch(undefined),
    prepLoadProtocol: z.enum(['h1', 'h2', 'h3', 'unknown']).optional().catch(undefined),
    prepLoadReason: z.enum(['complete', 'idle-timeout', 'active-deadline', 'network', 'http', 'range', 'size', 'integrity', 'decode']).optional().catch(undefined),
    prepLoadAttempt: z.number().int().min(1).max(3).optional().catch(undefined),
    prepLoadActiveMs: z.number().int().min(0).max(120000).optional().catch(undefined),
    prepPhase: z.enum(['base', 'download', 'verify', 'decode', 'terrain', 'upload', 'walls', 'ready']).optional().catch(undefined),
    stepAgeMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    renderAgeMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    prepCompleted: z.number().int().min(0).max(100000000).optional().catch(undefined),
    prepTotal: z.number().int().min(0).max(100000000).optional().catch(undefined),
    prepWidth: z.number().int().min(0).max(16384).optional().catch(undefined),
    prepHeight: z.number().int().min(0).max(16384).optional().catch(undefined),
    prepDownloadMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    prepVerifyMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    prepDecodeMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    prepPaintMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    prepUploadMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    prepMaxPaintBatchMs: z.number().int().min(0).max(600000).optional().catch(undefined),
    sceneActive: z.boolean().optional().catch(undefined),
    sceneVisible: z.boolean().optional().catch(undefined),
    prepCacheHit: z.boolean().optional().catch(undefined),
    loadProfile: z.enum(['full', 'constrained']).optional().catch(undefined),
    loadReason: z.enum(['complete', 'idle-timeout', 'active-deadline']).optional().catch(undefined),
    loadFirstReason: z.enum(['complete', 'idle-timeout', 'active-deadline']).optional().catch(undefined),
    loadFirstActiveMs: z.number().int().min(0).max(600_000).optional().catch(undefined),
    loadFirstLoadedBytes: z.number().int().min(0).max(100_000_000).optional().catch(undefined),
    loadAttempt: z.number().int().min(1).max(2).optional().catch(undefined),
    loadActiveMs: z.number().int().min(0).max(600_000).optional().catch(undefined),
    loadBudgetMs: z.number().int().min(0).max(600_000).optional().catch(undefined),
    loadQueued: z.number().int().min(0).max(1_000).optional().catch(undefined),
    loadInflight: z.number().int().min(0).max(1_000).optional().catch(undefined),
    loadProcessing: z.number().int().min(0).max(1_000).optional().catch(undefined),
    loadFailures: z.string().max(200).refine(value => value.split(';').every(entry => {
      const match = loadFailurePattern.exec(entry);
      return match !== null && Number(match[5]) <= 100_000_000 && Number(match[6]) <= 100_000_000;
    })).optional().catch(undefined),
    workerState: z.enum(['none', 'current', 'previous']).optional().catch(undefined),
    restoreReason: z.enum(['timeout', 'changed', 'request']).optional().catch(undefined),
    restoreStage: z.enum(['base_snapshot', 'raid_recovery']).optional().catch(undefined),
    httpStatus: z.number().int().min(0).max(599).optional().catch(undefined),
  });
  app.post('/telemetry', telemetryLimit, async (req, reply) => {
    const Body = z.object({
      context: z.record(z.string().max(32), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
      events: z.array(z.object({
        event: z.string().min(1).max(64),
        eventId: z.string().max(64).optional(),
        ts: z.string().max(40).optional(),
        props: z.record(z.string().max(32), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
      })).max(40),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.status(204).send();
    let wallet: string | null = null;
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      try { wallet = (await verifyActiveSession(config, db, token)).wallet; } catch { /* anon */ }
    }
    const rawContext = parsed.data.context ?? {};
    // Native reports are anonymous and contain only a bounded binary context.
    // Sanitize before IDs, logs, Sentry and the PostHog error-count summary;
    // filtering only the Sentry payload leaves the parallel relay exposed.
    const ctx = rawContext['platform'] === 'android-native' ? sanitizeNativeTelemetryContext(rawContext) : rawContext;
    const sessionId = typeof ctx['sessionId'] === 'string' ? ctx['sessionId'] : undefined;
    const deviceId = typeof ctx['deviceId'] === 'string' ? ctx['deviceId'] : undefined;
    const ids = {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
    const userAgent = req.headers['user-agent'];
    let clientErrors = 0;
    for (const e of parsed.data.events) {
      // Wallet-connection diagnostics must survive an unarmed PostHog relay:
      // the Phantom mobile two-account failure could only be triaged from
      // device screenshots because the client phase never reached a log.
      // Bounded props, no account, and `authed` instead of the wallet itself.
      if (e.event.startsWith('phantom_mobile_')) {
        // Allowlisted fields only: client props are caller-controlled text.
        const p = e.props ?? {};
        req.log.info({
          telemetry: e.event, ts: e.ts, authed: wallet !== null,
          phase: p['phase'], manual: p['manual'], primed: p['primed'], live: p['live'], reason: p['reason'],
          platform: ctx['platform'], buildVersion: ctx['buildVersion'],
        }, 'client wallet diagnostic');
      }
      if (e.event === 'auth_session_phase') {
        // Fixed categories only: a caller cannot put a signature, provider
        // payload or arbitrary error text into retained authentication logs.
        const diagnostic = z.object({
          operation: z.enum(['wallet', 'cookie', 'session', 'game']),
          phase: z.enum(['start', 'checking', 'approval', 'waiting', 'verifying', 'accepted', 'cancelled', 'failed', 'blocked', 'invalidated', 'cleanup', 'loading', 'retry', 'signed_out']),
          reason: z.enum(['login', 'logout', 'cross_tab', 'session_revision', 'dirty_cookie', 'local_transition', 'interrupted_response', 'superseded_verification', 'wallet_change', 'user_cancelled', 'challenge_expired', 'session_expired']).optional(),
        }).safeParse(e.props);
        if (!diagnostic.success) continue;
        req.log.info({ telemetry: e.event, ...diagnostic.data, authed: wallet !== null }, 'client authentication diagnostic');
        // The vendor payload has the same privacy boundary as retained logs.
        // Reconstruct context and stamps; never fall through to raw props/ctx.
        const authContext = z.object({
          platform: z.enum(['android', 'ios', 'desktop', 'unknown']).optional().catch(undefined),
          solanaMobile: z.boolean().optional().catch(undefined),
          buildVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).max(40).optional().catch(undefined),
          gitSha: z.string().regex(/^[a-f0-9]{7,40}$/i).optional().catch(undefined),
        }).parse(ctx);
        const authStamp = z.object({
          sessionId: z.uuid().optional().catch(undefined), deviceId: z.uuid().optional().catch(undefined),
          eventId: z.uuid().optional().catch(undefined), timestamp: z.iso.datetime().optional().catch(undefined),
        }).parse({ sessionId, deviceId, eventId: e.eventId, timestamp: e.ts });
        serverTrack(e.event, wallet, { ...authContext, ...diagnostic.data, source: 'client' }, {
          ...(authStamp.sessionId ? { sessionId: authStamp.sessionId } : {}),
          ...(authStamp.deviceId ? { deviceId: authStamp.deviceId } : {}),
          ...(authStamp.eventId ? { eventId: authStamp.eventId } : {}),
          ...(authStamp.timestamp ? { timestamp: authStamp.timestamp } : {}),
        });
        continue;
      }
      const stamp = {
        ...ids,
        ...(e.eventId !== undefined ? { eventId: e.eventId } : {}),
        ...(e.ts !== undefined ? { timestamp: e.ts } : {}),
      };
      if (e.event === 'app_error' || e.event === 'app_unhandled_rejection') {
        // Reliability tier → Sentry only. Relaying each one to PostHog as a
        // product event let every deploy's chunk-load burst flood the event
        // list (audit PA-05); PostHog gets ONE `client_errors` count per batch.
        clientErrors += 1;
        const p = e.props ?? {};
        const optStr = (k: string): string | undefined => (typeof p[k] === 'string' ? String(p[k]) : undefined);
        const diagnostics = Object.fromEntries(Object.entries(clientErrorDiagnostics.parse(p))
          .filter(([, value]) => value !== undefined));
        const errorContext: Record<string, unknown> = { ...ctx };
        // A caller-controlled context value cannot bypass the diagnostic parser.
        delete errorContext['diagnostics'];
        if (Object.keys(diagnostics).length > 0) errorContext['diagnostics'] = diagnostics;
        relayClientError({
          kind: e.event === 'app_error' ? 'error' : 'unhandledrejection',
          message: String(p['message'] ?? e.event),
          source: optStr('source'),
          name: optStr('name'),
          code: optStr('code'),
          count: typeof p['count'] === 'number' ? p['count'] : undefined,
          context: errorContext,
          pseudonym: analyticsId(wallet, sessionId, deviceId),
          userAgent,
        });
        continue;
      }
      serverTrack(e.event, wallet, { ...ctx, ...e.props, source: 'client' }, stamp);
      if (e.event === 'app_opened') {
        serverTrack('$pageview', wallet, { ...pageview, ...ctx, source: 'client' }, {
          ...stamp,
          ...(e.eventId !== undefined ? { eventId: `${e.eventId}:pageview` } : {}),
        });
      }
    }
    if (clientErrors > 0) {
      serverTrack('client_errors', wallet, {
        count: clientErrors, ...(ctx['gitSha'] !== undefined ? { gitSha: ctx['gitSha'] } : {}), source: 'client',
      }, ids);
    }
    return reply.status(204).send();
  });

  // emailSender: the key-EXPORT email challenge lives on the auth surface because
  // export is a custody right and must not sit behind the land gate (F8) — so the
  // auth routes need the same transport the game routes' 2FA uses.
  registerPlaytestCampaignRoutes(app, config, db);
  registerAuthRoutes(app, config, db, {
    socialTokenVerifier: deps.socialTokenVerifier,
    seekerFetch: deps.seekerFetch,
    emailSender: deps.emailSender,
    avatarStorage: deps.avatarStorage,
    avatarPublicBaseUrl: deps.avatarPublicBaseUrl ?? deps.avatarStorage?.publicBaseUrl,
    avatarUploadReceiveTimeoutMs: deps.avatarUploadReceiveTimeoutMs,
  });
  registerChatRoutes(app, config, db);
  registerMailRoutes(app, config, db, {
    rpcUrl: deps.market?.rpcUrl,
    deedCollection: deps.market?.deedCollection,
    finalizedDeedReader: deps.market?.finalizedDeedReader,
  });
  registerNotificationRoutes(app, config, db);
  registerNativeNotificationRoutes(app, config, db);
  // Both the API and worker build this app with their process-owned DB handle.
  // The same bus therefore covers worker recovery commits as request commits.
  let raidEvents: RaidEventHub | undefined;
  if (config.RAID_EVENTS_ENABLED === 'true') {
    const bus = new RedisRaidEventBus(config.REDIS_URL, (err) => {
      app.log.warn({ err }, 'raid event redis unavailable; database reconciliation remains active');
    });
    const unregister = registerRaidEventPublisher(db, bus);
    raidEvents = new RaidEventHub(bus, async (baseId) => {
      await recoverLiveRaidLifecycle(db, undefined, baseId);
      return getActiveBaseRaid(db, baseId);
    }, (err) => { app.log.warn({ err }, 'raid stream reconciliation failed'); });
    const hub = raidEvents;
    // Hijacked responses must close BEFORE Fastify waits for open connections.
    app.addHook('preClose', async () => { hub.close(); });
    app.addHook('onClose', async () => { unregister(); bus.close(); });
  }
  registerNativeRoutes(app, config, db);
  // Phase E: first roster capture after the normal authenticated base handler.
  registerMiningRosterEnrollment(app, { provider: deps.miningRosterEnrollmentProvider ?? null });
  registerVehicleBerthOccupancy(app, deps.vehicleBerthOccupancyProvider);
  registerVehicleRoutes(app, deps.vehicleWorkflowProvider);
  registerVehicleClientRoutes(app, deps.vehicleClientProvider);
  registerVehicleCraftClientRoutes(app, deps.vehicleCraftClientProvider);
  registerCharterClientRoutes(app, deps.charterClientProvider);
  registerCharterRetirementRoutes(app, deps.charterRetirementClientProvider);
  registerCharterMigrationRoutes(app, deps.charterMigrationClientProvider);
  registerCharterTournamentRoutes(app, deps.charterTournamentProvider);
  registerCharterTournamentEventsRoutes(app, deps.charterTournamentEventsProvider);
  registerDivineTrialRoutes(app, deps.divineTrialProvider);
  registerDivineFragmentRoutes(app, deps.divineFragmentProvider);
  registerRealmPassportRoutes(app, deps.realmPassportProvider);
  registerVehicleServiceRoutes(app, deps.vehicleServiceWorkflowProvider);
  registerAdvancedFleetRoutes(app, deps.advancedFleetViewProvider);
  registerBoundCosmeticCollection(app, deps.boundCosmeticWorkshop);
  registerBoundCosmeticWakeRoutes(app, deps.boundCosmeticWakeViews);
  registerBoundCosmeticRoutes(app, deps.boundCosmeticWorkshop);
  registerBoundCosmeticWakeWorkshopRoutes(app, deps.boundCosmeticWorkshop?.wake);
  registerOrdinaryEquipmentRoutes(app, deps.ordinaryEquipment);
  registerKeepEquipmentMarketRoutes(app, deps.keepEquipmentMarket);
  registerAdvancedExpeditionRoutes(app, deps.advancedExpeditionWorkflowProvider);
  registerAdvancedExpeditionGameplay(app, deps.advancedExpeditionGameplay);
  // Phase E: append source preparation after the existing collection auth hooks.
  registerShardsTaxMineGameplay(app, db, { provider: deps.physicalMineSourceProvider ?? null,
    recoveryProvider: deps.physicalMineRecoveryProvider ?? null,
    finalizedDeedReader: () => game.finalizedDeedReader, deedCollection: deps.market?.deedCollection ?? null });
  const game = registerGameRoutes(app, db, {
    ...deps,
    basePurchaseNetwork: deps.basePurchaseNetwork?.cluster === config.SOLANA_CLUSTER ? deps.basePurchaseNetwork : undefined,
    market: { ...deps.market, cluster: config.SOLANA_CLUSTER },
    raidEvents,
    liveRaidV2Enabled: config.LIVE_RAID_V2_ENABLED === 'true',
    totpRecoveryEnabled: config.TOTP_RECOVERY_ENABLED === 'true',
    withdrawalNetwork: {
      cluster: config.SOLANA_CLUSTER,
      keepMint: currentKeepMint(config.SOLANA_CLUSTER),
    },
    // No default under test: TEST_CONFIG carries the real devnet URL, and a
    // /wallet/balances probe must never do live RPC from the suite — the route
    // answers 503 there unless a test injects its own walletHub.
    walletHub: deps.walletHub ?? (config.NODE_ENV === 'test' ? undefined : {
      gameRpcUrl: config.SOLANA_RPC_URL,
      mainnetRpcUrl: config.SOLANA_MAINNET_RPC_URL,
    }),
  });
  // The Workshop shares the game routes' paced deed reader (deed RPC budget).
  registerWorkshopRoutes(app, db, { market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader } });
  registerFreeBasePurchaseRoutes(app, deps.freeBasePurchaseProvider);
  registerMiningClaimRoutes(app, db, deps.miningClaimsProvider);
  registerMiningTaxClaimRoutes(app, db, deps.miningTaxPreparationSources, deps.miningTaxRelaySources);
  registerShardsTaxMineRoutes(app, db, { market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader },
    provider: deps.starterExpeditionProvider ?? null });
  registerOrdinaryCraftingRoutes(app, db, { cosmeticCollection: deps.boundCosmeticWorkshop ?? null, market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader } });
  registerStarterFleetRoutes(app, db, { market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader } });
  registerStarterExpeditionRoutes(app, db, { market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader },
    provider: deps.starterExpeditionProvider ?? null, accessProvider: deps.starterExpeditionAccessProvider ?? null }, deps.starterExpeditionWorkflow);
  registerHarvesterRoutes(app, db, { market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader },
    provider: deps.harvesterProvider ?? null });
  registerSeekerResourceClaimRoutes(app, db, { market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader } }, deps.seekerResourceClaimProvider);
  registerSeekerShardsRoutes(app, db, { market: { ...deps.market, finalizedDeedReader: game.finalizedDeedReader } });
  registerRealmSaleRoutes(app, db, deps.realmSalePreparationSources, deps.realmSaleRelaySources);
  if (config.PHASE_E_SEEKER_AUCTION_ENABLED === 'true') registerSeekerAuctionRoutes(app, deps.seekerAuctionSource);
  registerLeagueRoutes(app, config, db);
  registerTesterRoutes(app, config, db);
  registerFeedbackManagementRoutes(app, config, db);
  registerFeedbackExportRoutes(app, config, db, deps);
  registerFeedbackAttachmentRoutes(app, config, db, deps);
  registerStatsRoutes(app, db);
  registerReleaseRoutes(app, config, db); // M47 §5 public changelog + Android feed (read-only)
  // DEVNET PLAYTEST ONLY (owner 2026-08-22): remove with money/devnetFaucet.ts
  // before mainnet. Config refuses the flag on any other cluster.
  registerDevnetFaucetRoutes(app, config, db,
    deps.devnetFaucetConnection === undefined ? {} : { connection: deps.devnetFaucetConnection });
  await loadDevnetOnlyRoutes(app, { cluster: config.SOLANA_CLUSTER, enabled: config.DEVNET_SKR_FAUCET_ENABLED,
    ...(deps.devnetOnlyImporter ? { importer: deps.devnetOnlyImporter } : {}),
    options: { config, db, addresses: deps.devnetOnlyAddresses ?? null,
      deedReader: game.finalizedDeedReader ?? null, deedCollection: deps.market?.deedCollection ?? null } });
  registerAlphaRoutes(app, config, db, {
    emailSender: deps.emailSender,
    turnstileFetch: deps.turnstileFetch,
    seekerFetch: deps.seekerFetch,
  });

  return app;
}
