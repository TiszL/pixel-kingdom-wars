import { readCustodyTransparency } from '../money/custodyTransparency';
import { MinePurchaseConsentSchema } from '@shardkeep/shared/minePurchase';
import { BuilderJobSpeedupConsentSchema } from '@shardkeep/shared/builderJobSpeedup';
import { ItemPurchaseConsentSchema } from '@shardkeep/shared/itemPurchase';
import { LandReservationReceiptQuerySchema, readLandReservationReceipt } from '../money/landReservationReceipt';
import { ItemPurchaseReceiptQuerySchema, assertItemPurchaseScope, readItemPurchaseReceipt,
  itemPurchaseIntent, replayItemPurchase } from './itemPurchaseReceipt';
import { builderJobSpeedupIntent, assertBuilderJobSpeedupScope, replayBuilderJobSpeedup, getBuilderJobSpeedupReceipt, BuilderJobSpeedupReceiptQuerySchema } from './builderJobSpeedupReceipt';
import { BaseClaimKeySchema, BaseClaimRequestSchema } from '@shardkeep/shared/baseClaims';
import { cancelUnacceptedBaseClaim, executeBaseClaim, getBaseClaim, getClaimableBaseV1 } from './baseClaimCommands';
import { BasePurchaseKeySchema, BasePurchaseEnergyQuerySchema, BasePurchaseShieldQuerySchema, BasePurchaseRequestSchema } from '@shardkeep/shared/basePurchases';
import { cancelUnquotedBasePurchase, getBasePurchase, quoteBasePurchase } from '../money/basePurchases';
import { GEMS, PLOT_GEOMETRY, plotBounds } from '@shardkeep/shared';
import { battlefieldBounds } from '@shardkeep/shared/battlefield';
import { openRaidEventStream } from './raidEvents';
import { resolveBaseVisualContext } from '@shardkeep/shared/baseVisual';
/**
 * Base-state routes (PLAN.md 4a/4b). All authenticated; all mutations take a
 * client idempotency key so retries can never double-spend (ARCHITECTURE §5).
 */
import { createHash } from 'node:crypto';
import { BASE_OWNERSHIP, BuildingType, CAMPAIGN, ECONOMY, GEAR_SLOTS, GLOBE, GRID, HERO_KEYS, ITEMS, LIVE_RAID, MARKETPLACE, RAID_REPLAY_LIMITS, RAID_BATTLEFIELD, RAID_RULES, REFERRALS, RESEARCH_CANCELLATION, TRAINING_CANCELLATION, TRAINING_PRESETS, TROOP_TYPES, TUTORIAL_STEPS, TWOFA, UPGRADE_CANCELLATION, WORLD } from '@shardkeep/shared';
import { isCanonicalSolanaSignature, keepAta } from '@shardkeep/chain';
import { PublicKey } from '@solana/web3.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { clansEnabled, freeOnboardingEnabled, gemsEnabled, gemsWalletBuyEnabled, multiBaseEnabled } from '../config';
import { gemsReserveAta } from '../money/economyIdentity';
import { registerGemsBuyRecoveryRoutes } from '../money/gemsBuyRecoveryRoutes';
// Phase E resource mining admission: dedicated authenticated route module.
import { registerMiningContributionRoutes } from './miningContributionRoutes';
// End Phase E resource mining admission import.
import { GAME_CURRENCY_FEATURE } from './clientCurrency';
import { bases, baseSlots, buildings, itemListings, players } from '../db/schema';
import { mintDeedIfConfigured } from './deed';
import { hasLand } from './land';
import { buildDeedMetadata, buildDeedMetadataForAsset, deedHolderWallet } from './deedMetadata';
import { createClan, getMyClan, joinClan, kickMember, leaveClan, listClans } from './clans';
import { executeClanCommand, getClanCommand } from './clanCommands';
import { ClanCommandKeySchema, ClanKickRequestSchema, ClanLeaveRequestSchema } from '@shardkeep/shared/clanCommands';
import { buyItem, equipHeroItem, getItems, markItemSeen, useItem } from './items';
import { getMarketAssets, getMarketCollection } from './market';
import { claimBase, findClaimableBase, makeDeedReaders } from './baseClaim';
import { abandonFreeBase } from './baseTransfer';
import {
  activateBase, assertFreshLockedActiveBaseAuthorities, assertFreshLockedBaseAuthority,
  ensureWalletBaseIdentity, hasActivePaidStableBase, listWalletBases, lockActiveBase, makeFinalizedDeedReader,
  type FinalizedDeedReader,
  refreshOwnedBaseOwnership, requireExactFinalizedOwnedBaseAuthority,
  requireFreshActiveBaseAuthorities, requireFreshBaseAuthority,
} from './baseOwnership';
import {
  cancelListing, getListings, getMyListings, getPendingMarketPurchases, getMarketTradeHistory,
  listItem, reserveListing, settleListing, submitPayment,
  type MarketLandAuthority, type RecoverableListingBaseContext,
} from './itemMarket';
import { ForgeClaimKeySchema, ForgeClaimRequestSchema } from '@shardkeep/shared/forgeClaims';
import { executeForgeClaimCommand, getForgeClaimCommand } from './forgeClaimCommands';
import { WallBatchKeySchema, WallBatchRequestSchema } from '@shardkeep/shared/wallBatch';
import { executeWallBatchCommand, getWallBatchCommand, wallBatchEnabled } from './wallBatch';
import { HeroRecruitmentKeySchema, HeroRecruitmentRequestSchema } from '@shardkeep/shared/heroRecruitment';
import { executeHeroRecruitmentCommand, getHeroRecruitmentCommand, heroRecruitmentEnabled, readHeroRecruitmentCommand } from './heroRecruitment';
import { claimForgeDays, contributeToForge, convertKeepToShards, getForgeAllocations, getForgeGlobalDay, getForgeStatus, getRecentForgeDrops, settleDueForgeDays } from './forge';
import { parse } from '../lib/validation';
import { ITEM_MARKET_FEATURE, MarketKeySchema, MarketListRequestSchema, MarketReserveRequestSchema,
  MarketPaidRequestSchema, MarketSettleRequestSchema, MarketCancelRequestSchema } from '@shardkeep/shared/market';
import { cancellationByKey, cancellationReceipt, listingCreationReceipt, reservationByKey,
  reservationReceipt, requireReserveRequest } from './itemMarketReceipts';
import { cancelListingV1, ownListingsV1, payReservation, requireMarketV1 } from './itemMarketV1';
import { getWithdrawalReceipt, WITHDRAWAL_RECEIPT_FEATURE, WithdrawalReceiptQuerySchema } from '../money/withdrawalReceipt';
import { CONVERSION_RECEIPT_FEATURE, ConversionReceiptQuerySchema, getConversionReceipt } from './conversionReceipt';
import { FORGE_CONTRIBUTION_RECEIPT_FEATURE, ForgeContributionReceiptQuerySchema, getForgeContributionReceipt } from './forgeContributionReceipt';
import { isValleyWarm } from '../lib/mapCache';
import {
  cancelUpgrade,
  clearObstacle,
  ensureStartingBase,
  getBaseState,
  moveBuilding,
  moveWallsBatch, quoteWallRowUpgrade, upgradeWallRow,
  placeBuilding, executeMinePurchase,
  placeWallsBatch,
  repairTrap,
  speedupJob,
  upgradeBuilding,
} from './base';
import { getBaseLayouts, saveBaseLayout, unlockFarmLayout } from './layouts';
import { cancelResearch, cancelTraining, getArmyState, researchSpeedup, researchTroop, trainSpeedup, trainTroop, quoteTraining, trainBatch } from './army';
import { getResearchSpeedupReceipt, ResearchSpeedupReceiptQuerySchema, researchSpeedupIntent, replayResearchSpeedup } from './researchReceipt';
import { getTrainingFinishReceipt, TrainingFinishReceiptQuerySchema, trainingFinishIntent, replayTrainingFinish, assertTrainingFinishScope } from './trainingFinishReceipt';
import { ResearchEpisodeConsentSchema, ResearchFinishConsentSchema, ResearchStartConsentSchema } from './researchConsent';
import { deleteArmyPreset, listArmyPresets, previousAttackArmy, saveArmyPreset } from './armyPresets';
import { closeTrainingBatch, getTrainingReceipt, TrainingCloseBodySchema, TrainingReceiptQuerySchema } from './trainingRecovery';
import { getTrainingCancellationReceipt, TrainingCancellationBodySchema, TrainingCancellationPathSchema, TrainingCancellationReceiptQuerySchema } from './trainingCancellationReceipt';
import { TrainingScheduleConsentSchema, TrainingFinishAllConsentSchema } from './trainingSchedule';
import { listHeroes, speedupHeroRecovery, upgradeHero } from './heroes';
import { HeroUpgradeConsentSchema, HeroRecoveryConsentSchema } from './heroConsent';
import { getHeroUpgradeReceipt, getHeroRecoveryReceipt, HeroUpgradeReceiptQuerySchema, HeroRecoveryReceiptQuerySchema } from './heroReceipt';
import { claimDailyCache, collectMine, getMineStatus, type MineMutationContext } from './emission';
import { claimBaseDailyCache, collectBaseMines, getBaseMineStatus } from './baseMining';
// Phase E daily-cache source: server-owned finalized term only.
import { prefetchOperatingExpeditionTermReader } from './operatingExpeditionTermReader';
// End Phase E daily-cache source import.
import { getEconomyStats } from './economy';
import { getGameConfig } from './gameConfig';
import { getPhaseECatalogue } from './phaseE';
import { isWarzoneActive, warzoneStatus } from './warzone';
import { createCampaignRaid, createRaid, getCampaignBoard, getPendingRaidResumes, getPendingRaidResume, getRaidLog, getReplay, OrdersBodySchema, recoverLiveRaidLifecycle, submitOrders } from './raids';
import { campaignBaseVisualHere } from './baseVisual';
import {
  acceptLiveRaidCommandReceipt, closeLiveRaidStream, getActiveBaseRaid, getLiveRaidCommands,
  RaidClockStaleError, retreatLiveRaid, setLiveRaidSpeed, startLiveRaid,
} from './liveRaids';
import {
  getBaseBattleHistory, getBaseBattleReplay,
  getParticipantBattleHistory, getParticipantBattleReplay,
} from './baseBattleHistory';
import {
  createDepositIntent, getDeposit, isEntryPaid, listKeepDeposits, nextLandPurchaseKind, submitDepositPayment,
  throwKeepVendUnavailable,
} from '../money/deposits';
import { verifyDepositNow } from '../money/depositWatcher';
import type { AppDeps } from '../app';
import { getInclusionProof, getProofOfReserves } from '../money/snapshot';
import {
  cancelWithdrawal, getPersonalWithdrawalLimit, isFailedWithdrawalRefundable, listWithdrawals, preflightWithdrawal,
  refundFailedWithdrawal, requestWithdrawal,
} from '../money/withdrawals';
import {
  consoleEmailSender, disableTotp, enrollTotp, factorChangeEmailChallengeContext, get2faStatus,
  sendFactorStepUpEmailCode, startEmailEnroll, verifyEmailEnroll,
  verifyInstantWithdrawalTotpTx, verifyTotpEnroll,
} from '../auth/twofa';
import {
  assertTotpFactorActionAllowed, cancelTotpRecovery, completeTotpRecovery,
  confirmTotpRecovery, getTotpRecoveryStatus, sendTotpRecoveryCompletionCode,
  startTotpRecovery,
} from '../auth/totpRecovery';
import { assertTotpRecoveryAllows } from '../auth/totpRecoveryPolicy';
import { SESSION_COOKIE, WITHDRAWAL_IDEMPOTENCY_KEY_RE } from '../auth/session';
import type { WithdrawalRecentAuthIntent } from '../auth/session';
import { claimQuest, getOnboardingStep, getQuestBoard } from './quests';
import {
  advanceTutorial, getTutorial, resetTutorial, resumeGuidance, skipGuidance, skipTutorial,
} from './tutorial';
import { getBaseCampaignBoard } from './campaign';
import { makeCampaignSnapshot } from './world';
import { getBalances } from './shop';
import { GEMS_FEATURE, GemsFromKeepReceiptQuerySchema, GemsToShardsReceiptQuerySchema, convertGemsToShards, convertKeepToGems, getGemsBalance, getGemsFromKeepReceipt, getGemsToShardsReceipt } from './gems';
import { GemsConversionExpectedSchema, GemsTaskExpectedSchema } from './gemsConsent';
import { claimGemsTask, getGemsTaskClaimReceipt, listGemsTasks } from './gemsGrants';
import { HttpError } from '../lib/errors';
import { ConstructionReceiptQuerySchema, readConstructionReceipt, minePurchaseIntent, replayMinePurchase, assertMinePurchaseScope } from './constructionReceipt';
import { isOutdatedClient, SIM_VERSION_HEADER } from '../version';
import { activeReferralBonusBps, getOrCreateReferralCode, referralStatusV1, useReferralCode, useReferralCodeV1 } from './social';
import { ReferralStatusV1Schema, ReferralUseV1RequestSchema, ReferralUseV1ResponseSchema } from '@shardkeep/shared/referrals';
import { getWalletBalances } from './walletBalances';
import {
  earthViewportCellRanges, ensureBasePlotAssigned, ensurePlotAssigned, getMapChunk,
  getParcelDetail, getViewportParcels, scoutBase, searchPlayers,
} from './world';
import {
  buildGlobeResponse, buildGlobeSectorResponse, globeContext, globeEtagInput, type GlobeContext,
} from './globe';

import { fantasyPresentationActive, requireLegacyWorldPresentation } from './fantasyLocationRead';
import { getFantasyGlobe, getFantasyParcel, getFantasyViewport, searchFantasyPlayers } from './fantasyGlobe';
import { fantasyWorldEnabled } from '../config';

const IdemKey = z.string().min(8).max(128);
const BaseId = z.uuid().optional();
const BaseQuery = z.object({ baseId: BaseId });
const currentPlot = plotBounds(PLOT_GEOMETRY.currentVersion);
// Wire admission is wider than the owned claim; geometryCheck remains the
// authority for every placement/move. This cannot grant an expansion.
const Tile = z.number().int().min(currentPlot.min).max(currentPlot.max - 1);
// The owner widened deployment and building space, not rally targeting.
const rallyPlot = plotBounds(PLOT_GEOMETRY.legacyVersion);
const RallyTile = z.number().int().min(rallyPlot.min).max(rallyPlot.max - 1);
const RaidDeployTile = z.number().int()
  .min(battlefieldBounds(RAID_BATTLEFIELD.currentVersion).min)
  .max(battlefieldBounds(RAID_BATTLEFIELD.currentVersion).max - 1);

const PlaceBody = z.object({
  type: z.nativeEnum(BuildingType),
  tx: Tile,
  ty: Tile,
  idempotencyKey: IdemKey,
  baseId: BaseId,
  heroContractOnly: z.boolean().optional(),
  mineConsent: MinePurchaseConsentSchema.optional(),
});
/** Swipe/drag wall placement (#59): a bounded batch of tiles + one idempotency key. */
const WallBatchBody = z.object({
  tiles: z.array(z.object({ tx: Tile, ty: Tile })).min(1).max(250),
  idempotencyKey: IdemKey,
  baseId: BaseId,
});
const MoveBody = z.object({ tx: Tile, ty: Tile, baseId: BaseId });
/** Line-move a whole run of walls together (#61): {id → new tile} for each wall. */
const MoveBatchBody = z.object({
  moves: z.array(z.object({ id: z.string().min(8).max(64), tx: Tile, ty: Tile })).min(1).max(250),
  baseId: BaseId,
});
const LayoutBase = z.object({ baseId: z.uuid() });
const LayoutEtag = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const LayoutPosition = z.object({ buildingId: z.uuid(), tx: Tile, ty: Tile });
const SaveLayoutBody = z.object({
  baseId: z.uuid(),
  geometryVersion: z.number().int().positive(),
  plotVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  mode: z.enum(['save', 'save_apply']),
  expectedSlotEtag: LayoutEtag,
  expectedActiveEtag: LayoutEtag.optional(),
  positions: z.array(LayoutPosition).min(1).max((currentPlot.max - currentPlot.min) ** 2),
});
const KeyBody = z.object({ idempotencyKey: IdemKey });
const BaseKeyBody = z.object({ idempotencyKey: IdemKey, baseId: BaseId });
/** D-099 batch journal offset: the client owns that battle clock, so a journaled
 *  order carries the offset it was placed at, bounded to the battle. Live
 *  streams refuse it in the service (the server clock is the only authority). */
const RaidCommandOffset = z.number().int().min(0).max(RAID_RULES.battleDurationSec * 1_000);
const LiveRaidCommandBody = z.object({
  clientCommandId: z.string().min(1).max(LIVE_RAID.clientCommandIdMaxLength),
  command: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('deploy'),
      payload: z.object({
        troop: z.enum(TROOP_TYPES), tx: RaidDeployTile, ty: RaidDeployTile,
        tMs: RaidCommandOffset.optional(),
      }),
    }),
    z.object({
      kind: z.literal('hero'),
      payload: z.object({
        hero: z.enum(HERO_KEYS), tx: RaidDeployTile, ty: RaidDeployTile,
        tMs: RaidCommandOffset.optional(),
      }),
    }),
    z.object({
      kind: z.literal('rally'),
      payload: z.object({ tx: RallyTile, ty: RallyTile, tMs: RaidCommandOffset.optional() }),
    }),
    z.object({
      kind: z.literal('buff'),
      payload: z.object({ buff: z.enum(['warhorn', 'swiftboots', 'powdercharge']) }),
    }),
  ]),
});
const LiveRaidControlBody = z.object({
  clientCommandId: z.string().min(1).max(LIVE_RAID.clientCommandIdMaxLength),
  expectedClockRevision: z.number().int().nonnegative(),
});
const LiveRaidSpeedBody = LiveRaidControlBody.extend({ rate: z.union([z.literal(1), z.literal(2)]) });
const FinishRaidBody = z.object({
  retreat: z.literal(true).optional(),
  clientCommandId: z.string().min(1).max(LIVE_RAID.clientCommandIdMaxLength).optional(),
}).superRefine((body, ctx) => {
  if ((body.retreat === true) !== (body.clientCommandId !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'retreat and clientCommandId are required together' });
  }
});
/** Hero path param — validated against HERO_KEYS so an unknown hero is a 400
 *  at the edge rather than reaching the money path. */
const HeroParams = z.object({ hero: z.enum(HERO_KEYS) });
const HeroGearParams = z.object({ hero: z.enum(HERO_KEYS), slot: z.enum(GEAR_SLOTS) });

/** Final stable-land fence for market listing/reservation creation. The caller
 * already owns the canonical sorted player locks; this locks every qualifying
 * paid active slot/base and uses the shared observation assertion rather than
 * recreating its ten-second finalized-owner policy here. */
export const assertLockedMarketLandAuthority: MarketLandAuthority = async (tx: DbTx, wallet: string) => {
  const qualifying = await tx.select({ id: bases.id }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
      eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      isNotNull(bases.landPaidAt), isNotNull(bases.deedAssetId), ne(bases.deedAssetId, ''),
    ))
    .orderBy(asc(baseSlots.slot), asc(bases.id))
    .for('update');
  if (qualifying.length === 0) {
    throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
  }
  for (const base of qualifying) {
    await assertFreshLockedBaseAuthority(tx, wallet, base.id, new Date());
  }
  // Fence the actual mutation boundary after every candidate row/observation is
  // locked. There is no RPC in this transaction, and no first proof may age out
  // while a later candidate is checked.
  const completedAt = new Date();
  for (const base of qualifying) {
    await assertFreshLockedBaseAuthority(tx, wallet, base.id, completedAt);
  }
};

/** The valley a /map read NAMES, if any. The rate limiter runs at `onRequest`,
 *  where `req.query` is already parsed, so this is readable there. */
const visitValleyId = (req: FastifyRequest): string | null => {
  const v = (req.query as { valleyId?: unknown } | undefined)?.valleyId;
  // UUID-shaped only, matching the handler's own MapQuery schema. A bare
  // `typeof v === 'string'` disagreed with it, and the disagreement decided
  // which BUDGET a request spends and whether the own-valley land gate runs:
  // `?valleyId=x` looked like a visit here (skipping the gate) and like a
  // malformed request there. Harmless today because parse() rejects it before
  // any work happens, but a gate that can be stepped around by sending a
  // non-uuid is not a gate — it just happened to be standing behind one.
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
};

/** RFC 4122 shape, the same thing zod's .uuid() accepts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which of the three /map budgets this request spends. NOT a URL classification —
 * a COST classification, which is why it asks mapCache rather than guessing:
 *
 *  - `own`  no valleyId: the valley you live in. Poll + pan.
 *  - `view` a foreign valley whose roster is ALREADY loaded: the poll and the pan
 *           refetches you spend while sitting in a valley you have opened. A cache
 *           hit — the same shape and the same cost as `own`, so it gets the same
 *           allowance in its own counter.
 *  - `open` a foreign valley that is NOT loaded: the ≤500-row cold roster load plus
 *           an LRU slot. The only expensive shape, so the only tightly metered one.
 *
 * Splitting `view` out of `open` is the whole point. With one visit bucket, the
 * UNCONDITIONAL poll (WORLD.mapPollSec) and every quantised pan refetch spent the
 * same tiny allowance as opening a new place, so a player who tapped a distant
 * valley on the globe and looked around got 429s for doing exactly what the globe
 * invites — while a scraper's cost, the cold load, was capped no tighter.
 */
type MapBudget = 'own' | 'view' | 'open';

const mapBudget = (req: FastifyRequest): MapBudget => {
  // DECIDED ONCE PER REQUEST, then remembered. @fastify/rate-limit calls
  // keyGenerator and max at different moments (the counter increment sits between
  // them), so re-deriving would let a request whose valley's TTL lapses in that gap
  // be COUNTED as 'view' and JUDGED against the open cap — a 429 arriving at a
  // player mid-pan, a few times a minute, unreproducible. The two must be the same
  // answer, so there is exactly one answer.
  const r = req as FastifyRequest & { mapBudgetKind?: MapBudget };
  if (r.mapBudgetKind !== undefined) return r.mapBudgetKind;
  const id = visitValleyId(req);
  r.mapBudgetKind = id === null ? 'own' : (isValleyWarm(id) ? 'view' : 'open');
  return r.mapBudgetKind;
};

/**
 * RATE LIMITS FOR THE MAP READS (docs/WORLDMAP-GLOBE-PLAN.md P4).
 *
 * The global limiter (app.ts: 300 / 60 s per IP, `skipOnError: true`) is a DDoS
 * floor, not a cost ceiling, and these routes are the expensive reads:
 *  - `GET /map?valleyId=<any uuid>` builds a full ≤500-row roster into mapCache for
 *    every DISTINCT valley id it is handed. Under the global cap alone one IP can
 *    drive ~5 COLD roster loads per second and churn the whole
 *    WORLD.mapCacheMaxValleys LRU, evicting the valleys real players are looking at.
 *  - `GET /globe` can miss the 60 s snapshot and run the planet aggregate.
 *
 * `/map` carries THREE PER-IP BUDGETS IN ONE ROUTE, separated by `keyGenerator` (see
 * mapBudget): they are different counters, so browsing the planet can never lock you
 * out of your own map, sitting in a valley you opened cannot be mistaken for abuse,
 * and a script walking valley ids cannot borrow either of the larger allowances.
 * `/map/parcel/:earthCell` is the identity-bearing exception: it carries TWO
 * independent Redis buckets. Its onRequest IP budget survives route-config
 * replacement of the global limiter; its post-auth wallet budget follows a
 * landowner across IP rotation. Neither rotation strategy widens the single-cell
 * inspection allowance.
 *
 * Exported because under NODE_ENV=test app.ts does not register the rate-limit
 * plugin at all, which makes `config.rateLimit` inert — a test that only injected
 * requests at the built app would assert nothing. See test/map-rate-limit.test.ts.
 */
export const MAP_RATE_LIMITS = {
  /** GET /globe and GET /globe/sector/:id. Each route keeps its OWN counter: the
   *  plugin's per-route store child is namespaced by method + url. */
  globe: { max: GLOBE.rateLimitPerMin, timeWindow: 60_000 },
  /** GET /globe/parcels. The response is bounded by fine-grid area, while this
   * fail-closed IP budget bounds repeated indexed viewport scans. */
  viewportParcelIp: {
    max: GLOBE.parcelViewportIpRateLimitPerMin,
    timeWindow: 60_000,
    hook: 'onRequest' as const,
    keyGenerator: (req: FastifyRequest): string => `globe-parcels-ip:${req.ip}`,
    skipOnError: false,
  },
  /** Independent post-auth budget follows one admitted wallet across IPs. */
  viewportParcelWallet: {
    max: GLOBE.parcelViewportWalletRateLimitPerMin,
    timeWindow: 60_000,
    keyGenerator: (req: FastifyRequest): string => `globe-parcels-wallet:${req.wallet}`,
    skipOnError: false,
  },
  /** GET /map/search. Its own explicit ceiling rather than the global 300/60 s
   *  floor (security review F11): free onboarding moved this route from the paid
   *  group to the free one, so reaching it no longer costs 0.2 SOL, and its name
   *  predicate is a LEADING-wildcard ilike that no index can serve. The value and
   *  its arithmetic (48/min honest peak × 1.25) live on the constant. */
  search: { max: WORLD.mapSearchRateLimitPerMin, timeWindow: 60_000 },
  /** The first half of the selected-parcel limiter: admit by IP at onRequest,
   *  before auth/land lookups. A route rate-limit config REPLACES (rather than
   *  layers over) the global plugin config, so this explicit counter is what keeps
   *  one IP from buying fresh wallet buckets. */
  parcelIp: {
    max: WORLD.mapVisitOpenRateLimitPerMin,
    timeWindow: 60_000,
    hook: 'onRequest' as const,
    keyGenerator: (req: FastifyRequest): string => `parcel-ip:${req.ip}`,
    // Identity/avatar/shield/loot detail is intentionally selectable, not a
    // bulk directory. If Redis cannot enforce that privacy budget, fail closed.
    skipOnError: false,
  },
  /** The second half: manually applied with app.createRateLimit after the existing
   *  authenticate → requireLandOwned chain. It follows one landowner across IPs,
   *  so neither proxy rotation nor a botnet creates extra inspection capacity. */
  parcelWallet: {
    max: WORLD.mapVisitOpenRateLimitPerMin,
    timeWindow: 60_000,
    keyGenerator: (req: FastifyRequest): string => `parcel-wallet:${req.wallet}`,
    skipOnError: false,
  },
  /** GET /map — own / continuing-view / cold-open, in separate buckets (above). */
  map: {
    max: (req: FastifyRequest): number =>
      mapBudget(req) === 'open' ? WORLD.mapVisitOpenRateLimitPerMin : WORLD.mapRateLimitPerMin,
    keyGenerator: (req: FastifyRequest): string => `${req.ip}:${mapBudget(req)}`,
    timeWindow: 60_000,
  },
};

/** Secondary request shield for the cancellation mutation. The fixed UTC-day
 * database counters in army.ts remain authoritative even if Redis fails open. */
export const TRAINING_CANCEL_RATE_LIMIT = {
  max: TRAINING_CANCELLATION.ipRateLimitPerMin,
  timeWindow: TRAINING_CANCELLATION.ipRateLimitWindowMs,
  hook: 'onRequest' as const,
  skipOnError: false,
  keyGenerator: (req: FastifyRequest): string => `army-train-cancel-ip:${req.ip}`,
};

/** Same shield shape for the two dialog-gated cancellations; the durable
 * UTC-day counters in base.ts / army.ts remain the authority. */
export const UPGRADE_CANCEL_RATE_LIMIT = {
  max: UPGRADE_CANCELLATION.ipRateLimitPerMin,
  timeWindow: UPGRADE_CANCELLATION.ipRateLimitWindowMs,
  hook: 'onRequest' as const,
  skipOnError: false,
  keyGenerator: (req: FastifyRequest): string => `base-upgrade-cancel-ip:${req.ip}`,
};
export const RESEARCH_CANCEL_RATE_LIMIT = {
  max: RESEARCH_CANCELLATION.ipRateLimitPerMin,
  timeWindow: RESEARCH_CANCELLATION.ipRateLimitWindowMs,
  hook: 'onRequest' as const,
  skipOnError: false,
  keyGenerator: (req: FastifyRequest): string => `army-research-cancel-ip:${req.ip}`,
};

/** One per-IP budget used by the single limiter instance shared by both
 * authoritative clock mutations. Fastify creates a distinct child store for
 * every route-level config, so `groupId` alone is not enough to combine them. */
export const RAID_CLOCK_CONTROL_RATE_LIMIT = {
  max: LIVE_RAID.controlRateLimitPerMin,
  timeWindow: LIVE_RAID.controlRateLimitWindowMs,
  groupId: 'raid-clock-control',
} as const;

/** Both public image routes use one coherent current drawing after their paid
 * and retired-image guards. No collection, chain query or lock spans painting. */
async function renderPublicDeedPng(
  db: Db, wallet: string, baseId: string | undefined, deedAssetId: string | null | undefined,
  walletAlias = false,
): Promise<Buffer | null> {
  const { renderBasePng, baseRenderFleetArtFingerprint } = await import('./baseRender');
  const [berth] = await db.select({ id: buildings.id }).from(buildings).where(and(
    baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet), eq(buildings.type, 'berth'),
  )).limit(1);
  // Keep ordinary legacy/no-berth pictures unchanged. The sentinel refuses a
  // berth added before the painter's row read, without inventing empty fleet.
  if (!berth) return renderBasePng(db, wallet, baseId, undefined, undefined, null);
  if (!baseId || !deedAssetId || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(deedAssetId)) return null;
  const fingerprint = baseRenderFleetArtFingerprint();
  if (!fingerprint) return null;
  const { captureDeedFleetDrawing, deedDrawingIdentityCurrent } = await import('./deedFleetCapture');
  const drawing = await captureDeedFleetDrawing(db, wallet, baseId, deedAssetId, fingerprint);
  if (!drawing) return null;
  const png = await renderBasePng(db, wallet, baseId, undefined, undefined, drawing);
  if (!png) return null;
  if (walletAlias) {
    // Repeat the existing all-owned-base ambiguity rule after asynchronous
    // painting; an inactive second base still makes this alias ambiguous.
    const owned = await db.select({ id: bases.id, paid: bases.landPaidAt, deedAssetId: bases.deedAssetId })
      .from(bases).where(eq(bases.ownerWallet, wallet)).limit(2);
    if (owned.length !== 1 || !owned[0]?.paid || owned[0].id !== baseId || owned[0].deedAssetId !== deedAssetId) {
      throw new HttpError(404, 'no such deed');
    }
  }
  // Persisted identity only. A transfer can still follow this final check;
  // this is a coherent earlier picture, not database/network atomicity.
  if (!await deedDrawingIdentityCurrent(db, drawing)) return null;
  return png;
}

/** Returns the ONE paced finalized-deed reader the game routes own, so sibling
 *  registrars (Workshop) share it instead of adding a foreground reader to the
 *  deed RPC budget (`baseOwnershipPacing.test.ts` pins the call sites). */
export function registerGameRoutes(app: FastifyInstance, db: Db, deps: AppDeps = {}): { finalizedDeedReader: FinalizedDeedReader | null } {
  registerGemsBuyRecoveryRoutes(app, db);
  /**
   * THE TWO GROUPS (docs/LAND-DEED-ONBOARDING-PLAN.md §2.2 + LOCKED OWNER
   * DECISIONS 2026-08-09). Onboarding stops being a paywall:
   *
   *  - `free`  — BUILD, PROGRESS, LOOK. Everything a player does to their own
   *              base, plus read-only browsing. Nothing here can mint
   *              withdrawable KEEP or touch another player's base.
   *  - `owned` — the deed unlocks it: the Gold Forge, SELLING on the market,
   *              PvE bounty raids, clans, withdrawals + withdrawal-code issuing,
   *              and the two parcel surfaces (/map/me, /map/scout). Profile
   *              email/authenticator management is auth-only + fresh-wallet-
   *              gated because account security is not a land privilege.
   *
   * WHY FREE ACCUMULATION IS SAFE, IN ONE FACT: only `player_keep` is
   * withdrawable, `player_shards` is not. The withdrawable gameplay/deposit
   * paths reachable from this router are land-gated or closed at their source:
   *   1. Gold Forge claim  → `owned` routes AND a per-BUILDING check in
   *      game/base.ts (the forge is placeable through the now-free POST
   *      /base/buildings, so route gating alone would leave the faucet open);
   *   2. PvE bounty        → POST /raids/pve is `owned`;
   *   3. quests            → NOT gated; closed at the source instead, by
   *      re-denominating quest rewards to SHARDS (game/quests.ts, locked owner
   *      decision Q3) so the free board earns nothing extractable;
   *   4. keep_deposit → auth-only: any authenticated wallet may return its own
   *      KEEP to custody, but player_keep is credited only against an observed
   *      on-chain inflow via balanced onchain_inflow/player_keep postings;
   *      withdrawing remains land-gated, and keep_vend remains globally
   *      unavailable until reserve-backed.
   * A free account's shards are therefore worth zero outside the game.
   *
   * WHAT FREE_ONBOARDING=OFF GUARANTEES (narrowed 2026-08-09, security review F2 —
   * the old claim here was "exactly today's behaviour", which overpromised):
   * AUTHORIZATION is unchanged EXCEPT FOR A NAMED LIST OF UN-GATINGS, and NO BASE
   * exists before the entry credit. With the flag unset `free` is registered WITH
   * the land gate, so every route that was gated before the split is gated again and
   * this re-tagging only EXPRESSES the split. Routes that were auth-only keep their
   * own explicit `authOnly` tag and never move: they must not become gated either.
   *
   * THE UN-GATINGS, ALL OF THEM, in both flag states — three market routes that
   * complete an already-paid purchase (`/market/listings/:id/paid`, `/settle`,
   * `/cancel`; security review F6) and the two key-export reads in auth/routes.ts
   * (F8). Each was a stranding bug, not a permission: none of them lets a landless
   * caller do anything but finish or release something that is already theirs.
   * They are asserted in BOTH flag states by test/land-gate.test.ts's AUTH_ONLY set.
   *
   * Several OTHER fixes are also unconditional — the 402's message + code, the
   * deed's payment check, the goldforge building check, baseTransfer's buyer rules,
   * the land-tier partition in raids/scout, the map-search INNER JOIN, the quest
   * re-denomination to shards and listItem's dropOnly refusal. config.ts holds the
   * authoritative list and the reason for each; do not restate a count here, because
   * a count is the part that goes stale. The switch reverts WHO MAY PLAY FOR FREE;
   * it does not un-fix bugs.
   */
  const freeOnboarding = freeOnboardingEnabled();
  const authOnly = { preHandler: [app.authenticate] };
  const owned = { preHandler: [app.authenticate, app.requireLandOwned] };
  const free = freeOnboarding ? authOnly : owned;
  // Tight per-IP cap for sensitive 2FA / instant-withdrawal endpoints (security
  // review 2026-07-19 #5), on top of the per-account lockout in verifyWithdrawal2fa.
  // The rate-limit plugin is off under test, so `config.rateLimit` is a no-op there.
  const ownedRl = {
    preHandler: [app.authenticate, app.requireLandOwned],
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  };
  // Account identity/security belongs to every admitted player, including the
  // deedless free tier. Mutations still take the same tight per-IP ceiling and,
  // inside each handler, a fresh primary-wallet grant. Only money movement
  // remains land-gated below; email is never accepted as instant-withdrawal 2FA.
  const authSensitiveRl = {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  };
  const loginRecoveryRl = { ...authSensitiveRl, preHandler: [app.authenticateLoginRecovery] };
  /**
   * Same cap, NO land gate — for RELEASING money the caller already committed.
   *
   * The rule F6 established on the item market applies with more force here,
   * because this is the one path carrying withdrawable KEEP: gate the CREATION
   * of a commitment, never the completion or UNWINDING of one that already
   * moved money. Cancelling or refunding a withdrawal posts the caller's own
   * escrow back to the caller's own play balance — it takes nothing out of the
   * game and it is the only route home for a stranded row (there is no admin
   * surface). Leaving it land-gated meant a player who withdrew and then sold
   * their base could neither finish nor unwind their own escrow.
   */
  const unwindRl = {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  };
  const finalizedDeedReader = deps.market?.finalizedDeedReader ?? makeFinalizedDeedReader({
    rpcUrl: deps.market?.rpcUrl,
    deedCollection: deps.market?.deedCollection,
  });
  // Phase E resource mining uses the explicitly mounted private-source service.
  registerMiningContributionRoutes(app, deps.miningContributionProvider);
  // End Phase E resource mining registration.
  const mineMutationContext: MineMutationContext = {
    assertActiveAuthority: async (tx, wallet) => {
      await assertFreshLockedActiveBaseAuthorities(tx, wallet);
    },
  };
  const mutationBaseId = async (wallet: string, requestedBaseId?: string): Promise<string | undefined> => {
    if (!multiBaseEnabled()) return undefined;
    const resolved = (await db.transaction((tx) => lockActiveBase(tx, wallet, requestedBaseId))).base.id;
    await requireFreshBaseAuthority(
      db, wallet, resolved, finalizedDeedReader, deps.market?.deedCollection ?? null,
    );
    return resolved;
  };
  const stablePrerequisiteContext = (baseId: string | undefined) => baseId ? ({
    baseId,
    // Phase E daily-cache source dependency. The service invokes this only for
    // admitted new earnings and before it opens its authority transaction.
    shardsCacheSource: {
      prefetch: async () => {
        const provider = deps.starterExpeditionProvider;
        if (!provider) throw new HttpError(503, 'Finalized cache term provider is unavailable', 'SHARDS_SOURCE_UNAVAILABLE');
        try { return await prefetchOperatingExpeditionTermReader(provider.connect, provider.policy); }
        catch { throw new HttpError(503, 'Finalized cache term is unavailable; no claim was made', 'SHARDS_SOURCE_UNAVAILABLE'); }
      },
    },
    // End Phase E daily-cache source dependency.
    assertAuthority: async (tx: DbOrTx, wallet: string, lockedBaseId: string): Promise<void> => {
      await assertFreshLockedBaseAuthority(tx, wallet, lockedBaseId);
    },
  }) : undefined;
  const prepareLayoutContext = async (wallet: string, baseId: string) => {
    // Acquire/refresh finalized deed evidence before entering the write
    // transaction. The stable prerequisite callback rechecks that exact
    // evidence after player/base/slot/raid locks, closing the transfer race.
    await requireFreshBaseAuthority(
      db, wallet, baseId, finalizedDeedReader, deps.market?.deedCollection ?? null,
    );
    return stablePrerequisiteContext(baseId)!;
  };
  const forgeStableContext = (baseId: string) => ({
    baseId,
    assertActiveAuthority: async (tx: DbTx, wallet: string) => {
      const base = await assertFreshLockedBaseAuthority(tx, wallet, baseId);
      return [{ id: base.id, landPaidAt: base.landPaidAt }];
    },
  });
  const paidDepositBaseId = async (wallet: string, requestedBaseId?: string): Promise<string> => {
    // Flag-off rolling upgrade: a legitimate paid legacy wallet may not have its
    // stable row yet. Materialize before resolving, while the helper's transfer
    // evidence guard prevents a seller's stale scalars from resurrecting land.
    if (!requestedBaseId) await ensureWalletBaseIdentity(db, wallet);
    const resolved = await db.transaction((tx) => lockActiveBase(tx, wallet, requestedBaseId));
    if (!resolved.base.landPaidAt) throw new HttpError(402, 'entry not paid');
    await requireFreshBaseAuthority(
      db, wallet, resolved.base.id, finalizedDeedReader, deps.market?.deedCollection ?? null,
    );
    return resolved.base.id;
  };
  const authorizeRaidBase = async (
    wallet: string, baseId: string, lockedDb?: DbOrTx,
  ): Promise<void> => {
    if (lockedDb) {
      await assertFreshLockedBaseAuthority(lockedDb, wallet, baseId);
      return;
    }
    await requireFreshBaseAuthority(
      db, wallet, baseId, finalizedDeedReader, deps.market?.deedCollection ?? null,
    );
  };
  const paidMutationBaseId = async (
    wallet: string, requestedBaseId?: string,
  ): Promise<string | undefined> => {
    if (!multiBaseEnabled()) return undefined;
    const resolved = await db.transaction((tx) => lockActiveBase(tx, wallet, requestedBaseId));
    if (!resolved.base.landPaidAt) {
      throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
    }
    await requireFreshBaseAuthority(
      db, wallet, resolved.base.id, finalizedDeedReader, deps.market?.deedCollection ?? null,
    );
    return resolved.base.id;
  };
  const requireFreshLandAuthority = async (wallet: string): Promise<void> => {
    if (!multiBaseEnabled()) {
      const [legacy] = await db.select({
        deedAssetId: players.deedAssetId, deedMintAssetId: players.deedMintAssetId,
      }).from(players).where(eq(players.wallet, wallet));
      if (!legacy?.deedAssetId && legacy?.deedMintAssetId) {
        throw new HttpError(
          503,
          'deed mint is pending exact on-chain recovery; land authority is quarantined',
          'DEED_AUTHORITY_UNAVAILABLE',
        );
      }
      return;
    }
    const active = await requireFreshActiveBaseAuthorities(
      db, wallet, finalizedDeedReader, deps.market?.deedCollection ?? null,
    );
    if (!active.some((base) => base.landPaidAt !== null)) {
      throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
    }
  };

  app.get('/base', free, async (req, reply) => {
    // Clients read this as proof that a lost legacy order left no effect; a
    // cached copy must never stand in for a fresh read.
    reply.header('cache-control', 'private, no-store');
    // Self-heal: the watcher creates the base right after crediting entry; if
    // that was interrupted, the first /base call finishes it (idempotent).
    // Under multi-base, resolve the stable identity before initializing any
    // structure. A transferred base deliberately retains the seller in legacy
    // child-wallet columns, so wallet-first initialization would duplicate its
    // Keep and terrain into the purchased base.
    let legacyStableBaseId: string | null = null;
    let requestedStableBaseId: string | undefined;
    if (!multiBaseEnabled()) {
      await ensureStartingBase(db, req.wallet);
      legacyStableBaseId = await ensureWalletBaseIdentity(db, req.wallet);
    } else {
      requestedStableBaseId = parse(
        z.object({ baseId: z.uuid().optional() }), req.query ?? {},
      ).baseId;
      // A named base already has a stable identity, and resolving it below is
      // the authority check. Only an omitted first read may create an empty
      // deedless identity. This keeps multiple bases from being mistaken for
      // "no base" and entering the retired wallet-starter ledger path.
      if (!requestedStableBaseId) {
        await ensureWalletBaseIdentity(db, req.wallet, { createEmpty: true });
      }
    }
    // Heartbeat: the client polls /base continuously while playing, so this is
    // where we record activity for social presence only. Being online no longer
    // protects a deed from raids; the live spectator/lock flow owns that state.
    await db.update(players).set({ lastSeenAt: new Date() }).where(eq(players.wallet, req.wallet));
    if (multiBaseEnabled()) {
      let resolved: string;
      try {
        resolved = (await db.transaction((tx) => (
          lockActiveBase(tx, req.wallet, requestedStableBaseId)
        ))).base.id;
      } catch (error) {
        if (!requestedStableBaseId && error instanceof HttpError && error.code === 'BASE_ID_REQUIRED') {
          throw new HttpError(
            426, 'this account has multiple bases; update the client and choose one',
            'BASE_CLIENT_UPGRADE_REQUIRED',
          );
        }
        throw error;
      }
      await requireFreshBaseAuthority(
        db, req.wallet, resolved, finalizedDeedReader, deps.market?.deedCollection ?? null,
      );
      const lockedAuthority = async (tx: DbTx, wallet: string, id: string) => {
        await assertFreshLockedBaseAuthority(tx, wallet, id);
      };
      await ensureStartingBase(db, req.wallet, resolved, lockedAuthority);
      // Deed self-heal targets the exact selected stable land identity.
      void mintDeedIfConfigured(db, req.wallet, resolved);
      return getBaseState(db, req.wallet, new Date(), resolved, lockedAuthority, () => new Date(), undefined,
        deps.boundCosmeticWorkshop ? () => deps.boundCosmeticWorkshop!.collectForBaseRead(req.wallet, resolved) : undefined);
    }
    void mintDeedIfConfigured(db, req.wallet, legacyStableBaseId ?? undefined);
    return getBaseState(db, req.wallet);
  });

  app.get('/bases', authOnly, async (req) => {
    const enabled = multiBaseEnabled();
    const fantasy = await fantasyPresentationActive(db);
    return {
      enabled,
      worldId: fantasy ? 'fantasy-v1' : 'legacy-earth',
      maxActive: BASE_OWNERSHIP.maxActive,
      capabilities: {
        baseScopedReads: enabled,
        baseScopedMutations: enabled,
        cellReservations: enabled,
      },
      nextLandPurchaseKind: await nextLandPurchaseKind(db, req.wallet),
      bases: await listWalletBases(db, req.wallet, fantasy),
    };
  });

  if (multiBaseEnabled()) {
    app.post('/bases/:baseId/activate', authOnly, async (req) => {
      const { baseId } = parse(z.object({ baseId: z.uuid() }), req.params);
      const body = parse(z.object({ replaceBaseId: z.uuid().optional() }), req.body ?? {});
      const status = await refreshOwnedBaseOwnership(
        db, req.wallet, baseId, finalizedDeedReader, deps.market?.deedCollection ?? null,
      );
      if (status !== 'owned') {
        throw new HttpError(503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE');
      }
      return activateBase(
        db, req.wallet, baseId, body.replaceBaseId,
        async (tx, wallet, lockedBaseId) => {
          await assertFreshLockedBaseAuthority(
            tx, wallet, lockedBaseId, new Date(), { allowInactive: true },
          );
        },
      );
    });
  }

  app.get('/base/layouts', free, async (req, reply) => {
    reply.header('cache-control', 'private, no-store'); // read as absence proof, like GET /base
    const { baseId } = parse(LayoutBase, req.query ?? {});
    await prepareLayoutContext(req.wallet, baseId);
    return getBaseLayouts(db, req.wallet, baseId);
  });

  app.post('/base/layouts/FARM/unlock', free, async (req) => {
    const body = parse(z.object({ baseId: z.uuid(), idempotencyKey: IdemKey }), req.body);
    const context = await prepareLayoutContext(req.wallet, body.baseId);
    return unlockFarmLayout(db, req.wallet, context, body.idempotencyKey);
  });

  app.put('/base/layouts/:slot', free, async (req) => {
    const { slot } = parse(z.object({ slot: z.enum(['HOME', 'FARM']) }), req.params);
    const body = parse(SaveLayoutBody, req.body);
    const context = await prepareLayoutContext(req.wallet, body.baseId);
    return saveBaseLayout(db, req.wallet, context, slot, body);
  });

  // Historical proof belongs to the initiating wallet, including after sale.
  // This route does not grant current deed access or replay a placement.
  app.get('/base/buildings/receipt', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readConstructionReceipt(db, req.wallet, parse(ConstructionReceiptQuerySchema, req.query ?? {}));
  });
  app.post('/base/buildings', { preHandler: [app.authenticate, async (req, reply) => {
    // Legacy admission order stays unchanged. Only explicit modern commands can
    // reach historical replay before current land; fresh modern writes gate below.
    if (!freeOnboarding && !(req.body && typeof req.body === 'object' && 'mineConsent' in req.body)) await app.requireLandOwned(req, reply);
  }] }, async (req, reply) => {
    const body = parse(PlaceBody, req.body);
    const request = minePurchaseIntent(body);
    if (request) {
      reply.header('cache-control', 'private, no-store');
      const prior = await replayMinePurchase(db, req.wallet, request);
      if (prior) return reply.status(201).send(prior);
      assertMinePurchaseScope(request, multiBaseEnabled());
      if (!freeOnboarding) await app.requireLandOwned(req, reply);
      const baseId = await mutationBaseId(req.wallet, body.baseId);
      return reply.status(201).send(await executeMinePurchase(db, req.wallet, request, new Date(), stablePrerequisiteContext(baseId)));
    }
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const building = await placeBuilding(db, req.wallet, body.type, body.tx, body.ty, body.idempotencyKey, new Date(), baseId, stablePrerequisiteContext(baseId), body.heroContractOnly);
    return reply.status(201).send({ building });
  });

  // Receipt access belongs to the initiating wallet after a deed sale or pause.
  // Only a fresh command reaches the ordinary placement's admission/deed gates.
  const heroReceiptPrivacy = async (_req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('cache-control', 'private, no-store'); return payload;
  };
  app.get('/heroes/recruit/v1/:key', { ...authOnly, onSend: heroReceiptPrivacy }, async (req) => {
    const { key } = parse(HeroRecruitmentKeySchema, req.params);
    return readHeroRecruitmentCommand(db, req.wallet, key);
  });
  app.post('/heroes/recruit/v1', { ...authSensitiveRl, onSend: heroReceiptPrivacy }, async (req, reply) => {
    const request = parse(HeroRecruitmentRequestSchema, req.body);
    const prior = (await getHeroRecruitmentCommand(db, req.wallet, request.idempotencyKey)).receipt;
    if (prior || !heroRecruitmentEnabled()) return executeHeroRecruitmentCommand(db, req.wallet, request);
    if (!freeOnboarding) await app.requireLandOwned(req, reply);
    // Unlike the legacy auto-selection helper, an explicit original base is
    // honored in both rollout states; null cannot turn into today's selection.
    const context = request.baseId ? await prepareLayoutContext(req.wallet, request.baseId) : undefined;
    const receipt = await executeHeroRecruitmentCommand(db, req.wallet, request, new Date(), context);
    return reply.status(201).send(receipt);
  });

  // Immutable original wall acceptance is accessible after sale or rollout pause.
  const wallBatchPrivacy = async (_req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('cache-control', 'private, no-store'); return payload;
  };
  app.get('/base/walls/batch/v1/:key', { ...authOnly, onSend: wallBatchPrivacy }, async (req) => {
    const { key } = parse(WallBatchKeySchema, req.params);
    return getWallBatchCommand(db, req.wallet, key);
  });
  app.post('/base/walls/batch/v1', { ...authSensitiveRl, onSend: wallBatchPrivacy }, async (req, reply) => {
    const request = parse(WallBatchRequestSchema, req.body);
    const prior = (await getWallBatchCommand(db, req.wallet, request.idempotencyKey)).receipt;
    if (prior || !wallBatchEnabled()) return executeWallBatchCommand(db, req.wallet, request);
    if (!freeOnboarding) await app.requireLandOwned(req, reply);
    const context = request.baseId ? await prepareLayoutContext(req.wallet, request.baseId) : undefined;
    return reply.status(201).send(await executeWallBatchCommand(db, req.wallet, request, new Date(), context));
  });

  // Swipe/drag to place a whole run of walls in one action (#59).
  app.post('/base/buildings/batch', free, async (req, reply) => {
    const body = parse(WallBatchBody, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const res = await placeWallsBatch(db, req.wallet, body.tiles, body.idempotencyKey, new Date(), baseId, stablePrerequisiteContext(baseId));
    return reply.status(201).send(res);
  });

  app.patch('/base/buildings/:id/move', free, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(MoveBody, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const building = await moveBuilding(db, req.wallet, id, body.tx, body.ty, baseId, stablePrerequisiteContext(baseId));
    return { building };
  });

  // Move a whole line/run of walls together (#61).
  app.post('/base/buildings/move-batch', free, async (req) => {
    const body = parse(MoveBatchBody, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return moveWallsBatch(db, req.wallet, body.moves, baseId, stablePrerequisiteContext(baseId));
  });

  app.post('/base/walls/:id/upgrade-quote', free, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(BaseQuery, req.body ?? {});
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return quoteWallRowUpgrade(db, req.wallet, id, baseId, stablePrerequisiteContext(baseId));
  });

  app.post('/base/walls/:id/upgrade-row', free, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ baseId: BaseId, idempotencyKey: IdemKey,
      quoteId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return upgradeWallRow(db, req.wallet, id, body.quoteId, body.idempotencyKey,
      baseId, stablePrerequisiteContext(baseId));
  });

  app.post('/base/buildings/:id/upgrade', free, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(BaseKeyBody, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return upgradeBuilding(db, req.wallet, id, body.idempotencyKey, new Date(), {}, baseId, stablePrerequisiteContext(baseId));
  });

  app.post('/base/buildings/:id/repair', free, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(BaseKeyBody, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return repairTrap(db, req.wallet, id, body.idempotencyKey, new Date(), baseId, stablePrerequisiteContext(baseId));
  });

  app.post('/base/obstacles/:id/clear', free, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(BaseKeyBody, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const job = await clearObstacle(db, req.wallet, id, body.idempotencyKey, new Date(), baseId, stablePrerequisiteContext(baseId));
    return { job };
  });

  app.post('/base/jobs/:id/speedup', free, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(BaseKeyBody.extend({ consent: BuilderJobSpeedupConsentSchema.optional() }), req.body);
    const request = builderJobSpeedupIntent(id, body.idempotencyKey, body.baseId, body.consent);
    const replay = await replayBuilderJobSpeedup(db, req.wallet, request);
    if (replay) return { cost: replay.cost.toString() };
    assertBuilderJobSpeedupScope(request, multiBaseEnabled());
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const { cost } = await speedupJob(db, req.wallet, id, body.idempotencyKey, new Date(), baseId, stablePrerequisiteContext(baseId), body.consent);
    return { cost: cost.toString() };
  });

  app.get('/base/jobs/speedup/receipt', authOnly, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return getBuilderJobSpeedupReceipt(db, req.wallet, parse(BuilderJobSpeedupReceiptQuerySchema, req.query ?? {}));
  });

  // CANCEL a running upgrade (tester request 2026-09-04): frees the builder and
  // refunds the exact recorded SHARD debit. Same auth, base context and
  // per-IP shield pattern as the troop cancel above.
  app.post('/base/jobs/:id/cancel', {
    ...free,
    config: { rateLimit: UPGRADE_CANCEL_RATE_LIMIT },
  }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(BaseKeyBody, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return cancelUpgrade(db, req.wallet, id, body.idempotencyKey, new Date(), baseId, stablePrerequisiteContext(baseId));
  });

  // --- Mining (collect) + Daily Cache (claim) — Economy v2, ECONOMY.md §2/§3 --
  // COLLECT the fixed-quota Mine buffer into the ledger.
  app.post('/mine/collect', free, async (req) => {
    const now = new Date();
    if (multiBaseEnabled()) {
      const body = parse(BaseQuery, req.body ?? {});
      const baseId = await mutationBaseId(req.wallet, body.baseId);
      if (!baseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      const { amount } = await collectBaseMines(
        db, req.wallet, stablePrerequisiteContext(baseId)!, now,
      );
      return { amount: amount.toString() };
    }
    const { amount } = await collectMine(db, req.wallet, now, mineMutationContext);
    return { amount: amount.toString() };
  });

  // CLAIM the Daily Shard Cache (streak ladder reward).
  app.post('/mine/claim', free, async (req) => {
    const now = new Date();
    if (multiBaseEnabled()) {
      const body = parse(BaseQuery, req.body ?? {});
      const baseId = await mutationBaseId(req.wallet, body.baseId);
      if (!baseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      const res = await claimBaseDailyCache(
        db, req.wallet, stablePrerequisiteContext(baseId)!, now,
      );
      return {
        amount: res.amount.toString(),
        streakDays: res.streakDays,
        everCompletedWeek1: res.everCompletedWeek1,
      };
    }
    const res = await claimDailyCache(db, req.wallet, now, mineMutationContext);
    return { amount: res.amount.toString(), streakDays: res.streakDays, everCompletedWeek1: res.everCompletedWeek1 };
  });

  // Read-only mining + cache status for the Mine sheet, Claim screen, HUD pill.
  app.get('/mine/status', free, async (req) => {
    if (multiBaseEnabled()) {
      const query = parse(BaseQuery, req.query ?? {});
      const baseId = await mutationBaseId(req.wallet, query.baseId);
      if (!baseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
      return getBaseMineStatus(db, req.wallet, baseId);
    }
    return getMineStatus(db, req.wallet);
  });

  // Read-only KEEP economy transparency for the in-game dashboard (owner
  // 2026-07-19): pool health, mined/recycled/withdrawn flows, solvency figures.
  app.get('/economy/stats', free, async () => {
    const now = new Date();
    const stats = await getEconomyStats(db, now);
    const cfg = await getGameConfig(db);
    // Surface the live emission multiplier (#45) plus a player-facing warzone
    // clock. Predictable scheduled windows include their next start; an
    // unannounced purge never exposes its start before or during the event.
    return { ...stats, emission: { multBps: cfg.emissionMultBps }, warzone: warzoneStatus(cfg, now) };
  });

  // D-151: a policy read for admitted players, with no land purchase or
  // gameplay activation. Authentication precedes the independent dark gate.
  app.get('/game/phase-e/catalogue', authOnly, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return getPhaseECatalogue();
  });

  // --- Army (PLAN.md 4d) ---------------------------------------------------
  app.get('/army', free, async (req, reply) => {
    reply.header('cache-control', 'private, no-store'); // read as absence proof, like GET /base
    const query = parse(z.object({ baseId: BaseId }), req.query ?? {});
    const baseId = await mutationBaseId(req.wallet, query.baseId);
    return getArmyState(db, req.wallet, new Date(), baseId);
  });

  app.get('/army/presets', free, async (req) => ({ presets: await listArmyPresets(db, req.wallet) }));
  app.put('/army/presets/:slot', free, async (req) => {
    const { slot } = parse(TrainingPresetSlot, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(TRAINING_PRESETS.nameMaxLength), composition: TrainingCompositionBody }), req.body);
    return saveArmyPreset(db, req.wallet, { slot, ...body });
  });
  app.delete('/army/presets/:slot', free, async (req) => {
    const { slot } = parse(TrainingPresetSlot, req.params);
    return deleteArmyPreset(db, req.wallet, slot);
  });
  app.get('/army/previous', free, async (req) => {
    const query = parse(z.object({ baseId: BaseId }), req.query ?? {});
    return previousAttackArmy(db, req.wallet, await mutationBaseId(req.wallet, query.baseId));
  });
  app.post('/army/training/quote', free, async (req) => {
    const body = parse(z.object({ composition: TrainingCompositionBody, baseId: BaseId }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return quoteTraining(db, req.wallet, body.composition, new Date(), stablePrerequisiteContext(baseId));
  });
  // Recovery reads/closes the caller's historical request, even after deed sale.
  // It cannot spend, cancel accepted troops, or grant authority over another base.
  app.get('/army/training/receipt', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = parse(TrainingReceiptQuerySchema, req.query ?? {});
    return getTrainingReceipt(db, req.wallet, query.idempotencyKey);
  });
  app.post('/army/training/close', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = parse(TrainingCloseBodySchema, req.body);
    return closeTrainingBatch(db, req.wallet, body.idempotencyKey);
  });
  app.post('/army/training/batch', free, async (req) => {
    const body = parse(z.object({ composition: TrainingCompositionBody, confirmedCostShards: z.string().max(32).regex(/^(0|[1-9][0-9]*)$/), idempotencyKey: IdemKey, baseId: BaseId, consent: TrainingScheduleConsentSchema.optional() }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return trainBatch(db, req.wallet, body.composition, body.confirmedCostShards, body.idempotencyKey, new Date(), stablePrerequisiteContext(baseId), body.consent);
  });

  app.post('/army/train', free, async (req) => {
    const body = parse(TrainBody.extend({ consent: TrainingScheduleConsentSchema.optional(), confirmedCostShards: z.string().max(32).regex(/^(0|[1-9][0-9]*)$/).optional() }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return trainTroop(
      db, req.wallet, body.troop, body.idempotencyKey, new Date(),
      stablePrerequisiteContext(baseId), body.consent, body.confirmedCostShards,
    );
  });

  app.get('/army/train/:queueId/cancel/receipt', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { queueId } = parse(TrainingCancellationPathSchema, req.params);
    const query = parse(TrainingCancellationReceiptQuerySchema, req.query ?? {});
    return getTrainingCancellationReceipt(db, req.wallet, queueId, query);
  });
  app.post('/army/train/:queueId/cancel', {
    ...free,
    config: { rateLimit: TRAINING_CANCEL_RATE_LIMIT },
  }, async (req) => {
    const { queueId } = parse(TrainingCancellationPathSchema, req.params);
    const body = parse(TrainingCancellationBodySchema, req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return cancelTraining(
      db, req.wallet, queueId, body.idempotencyKey, new Date(),
      stablePrerequisiteContext(baseId),
    );
  });

  // ⚡ FINISH the whole training queue (owner F1: attack prep) — same super-
  // linear KEEP pricing as the builder/research speedups, recomputed by the
  // server from the LAST row's remaining time. Alongside deed/idempotency keys,
  // consent bounds the displayed queue and maximum price;
  // the server recomputes the actual charge under the lane lock.
  app.post('/army/train/speedup', free, async (req) => {
    const body = parse(BaseKeyBody.extend({ consent: TrainingFinishAllConsentSchema.optional(), freeOffer: z.literal('first_troops').optional() }), req.body);
    const request = trainingFinishIntent(body.idempotencyKey, body.baseId, body.consent, body.freeOffer);
    const replay = await replayTrainingFinish(db, req.wallet, request);
    if (replay) return { ...replay, cost: replay.cost.toString() };
    assertTrainingFinishScope(request, multiBaseEnabled());
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const { cost, completed } = await trainSpeedup(
      db, req.wallet, body.idempotencyKey, new Date(), stablePrerequisiteContext(baseId), body.consent, body.freeOffer,
    );
    return { cost: cost.toString(), completed };
  });

  // Original paid evidence is independent of today's selected deed and new-order gates.
  app.get('/army/train/speedup/receipt', authOnly, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return getTrainingFinishReceipt(db, req.wallet, parse(TrainingFinishReceiptQuerySchema, req.query ?? {}));
  });

  app.post('/army/research', free, async (req) => {
    const body = parse(TrainBody.extend({ consent: ResearchStartConsentSchema.optional() }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return researchTroop(
      db, req.wallet, body.troop, body.idempotencyKey, new Date(),
      stablePrerequisiteContext(baseId), body.consent,
    );
  });

  // ⚡ FINISH the running research — same super-linear KEEP pricing as the
  // builder-job speedup. The server recomputes the cost from remaining time;
  // optional consent limits the charge and selects the exact displayed episode.
  // Clients never supply the actual price; legacy requests remain compatible.
  app.post('/army/research/speedup', free, async (req) => {
    const body = parse(TrainBody.extend({ consent: ResearchFinishConsentSchema.optional() }), req.body);
    const replay = await replayResearchSpeedup(db, req.wallet, researchSpeedupIntent(body.troop, body.idempotencyKey, body.baseId, body.consent));
    if (replay) return { ...replay, cost: replay.cost.toString() };
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const { cost, troop, toLevel } = await researchSpeedup(
      db, req.wallet, body.troop, body.idempotencyKey, new Date(), stablePrerequisiteContext(baseId), body.consent,
    );
    return { cost: cost.toString(), troop, toLevel };
  });

  // Private immutable evidence is readable without today's selected deed or feature admission.
  app.get('/army/research/speedup/receipt', authOnly, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return getResearchSpeedupReceipt(db, req.wallet, parse(ResearchSpeedupReceiptQuerySchema, req.query ?? {}));
  });

  // CANCEL the running research of one troop (tester request 2026-09-04):
  // frees the Forge lane and refunds the exact recorded SHARD debit.
  app.post('/army/research/:troop/cancel', {
    ...free,
    config: { rateLimit: RESEARCH_CANCEL_RATE_LIMIT },
  }, async (req) => {
    const { troop } = parse(z.object({ troop: z.enum(TROOP_TYPES) }), req.params);
    const body = parse(BaseKeyBody.extend({ consent: ResearchEpisodeConsentSchema.optional() }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return cancelResearch(
      db, req.wallet, troop, body.idempotencyKey, new Date(), stablePrerequisiteContext(baseId), body.consent,
    );
  });

  // --- Heroes (D-Q1, owner 2026-07-28) ---------------------------------------
  // Read model is server-authoritative: costs/stats come from HERO_LEVELING on
  // the server, the client only renders what it is handed.
  app.get('/heroes', free, async (req) => {
    const query = parse(z.object({ baseId: BaseId }), req.query ?? {});
    const baseId = await mutationBaseId(req.wallet, query.baseId);
    return listHeroes(db, req.wallet, new Date(), baseId);
  });

  app.post('/heroes/:hero/upgrade', free, async (req) => {
    const { hero } = parse(HeroParams, req.params);
    const body = parse(BaseKeyBody.extend({ consent: HeroUpgradeConsentSchema.optional() }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return upgradeHero(
      db, req.wallet, hero, body.idempotencyKey, new Date(),
      stablePrerequisiteContext(baseId), body.consent,
    );
  });

  app.post('/heroes/:hero/recovery/speedup', free, async (req) => {
    const { hero } = parse(HeroParams, req.params);
    const body = parse(BaseKeyBody.extend({ consent: HeroRecoveryConsentSchema.optional() }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return speedupHeroRecovery(
      db, req.wallet, hero, body.idempotencyKey, undefined,
      stablePrerequisiteContext(baseId), body.consent,
    );
  });

  // Historical acceptance remains readable after the selected deed moves.
  // These authenticated GETs never resolve today's base or authorize a mutation.
  app.get('/heroes/:hero/upgrade/receipt', authOnly, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { hero } = parse(HeroParams, req.params);
    return getHeroUpgradeReceipt(db, req.wallet, { hero, ...parse(HeroUpgradeReceiptQuerySchema, req.query ?? {}) });
  });
  app.get('/heroes/:hero/recovery/speedup/receipt', authOnly, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { hero } = parse(HeroParams, req.params);
    return getHeroRecoveryReceipt(db, req.wallet, { hero, ...parse(HeroRecoveryReceiptQuerySchema, req.query ?? {}) });
  });

  app.put('/heroes/:hero/equipment/:slot', free, async (req) => {
    const { hero, slot } = parse(HeroGearParams, req.params);
    const body = parse(z.object({
      itemId: z.string().min(1).max(64).nullable(),
      expectedVersion: z.number().int().nonnegative(),
      baseId: BaseId,
    }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return equipHeroItem(db, req.wallet, hero, slot, body.itemId, body.expectedVersion, new Date(), {
      baseId,
      ...(baseId ? { authorizeBaseMutation: async (tx: DbTx, wallet: string, id: string) => {
        await assertFreshLockedBaseAuthority(tx, wallet, id);
      } } : {}),
    });
  });

  // --- Raids (PLAN.md 4d) ----------------------------------------------------
  /**
   * Refuse to START or SUBMIT a raid for a client that would simulate it differently.
   *
   * The client runs the sim locally while the player deploys — that is the whole
   * battle they watch — and the server re-runs it authoritatively at submit. If
   * the two simulators disagree (a phone holding a bundle cached from before a
   * deploy), the player watches one battle and is awarded the outcome of another.
   * Catching it at CREATE means they lose nothing: no energy spent, no raid row,
   * just "update and try again". Submission is gated too because a cached client
   * can create just before a rollout and submit just after it; submitOrders also
   * checks the raid row's creation-time pin before simulation or mutation.
   */
  // onRequest, NOT preHandler: it has to beat the auth/land preHandlers. A stale client's session
  // has usually expired too, and if auth answers first the player is told to log
  // in — which they can do, forever, without ever fixing the actual problem. The
  // 426 has to be the first thing they hear.
  const simGate = async (req: { headers: Record<string, unknown> }): Promise<void> => {
    const raw = req.headers[SIM_VERSION_HEADER];
    if (isOutdatedClient(typeof raw === 'string' ? raw : undefined)) {
      throw new HttpError(426, 'OUTDATED_CLIENT');
    }
  };
  /** A group, plus "your simulator agrees with mine". Every route that STARTS or
   *  SUBMITS a battle the client simulates locally. Two variants because PvP
   *  auto-match + the campaign are FREE while the PvE BOUNTY (which mints
   *  withdrawable KEEP) is land-gated. */
  // The rate-limit plugin appends to onRequest arrays during route registration.
  // A shared array leaks the first route's global limiter into every later raid
  // route, shadowing its own finish/command/read budget. A function is wrapped
  // independently for each route, keeping admission isolated.
  const freeCurrentSim = { onRequest: simGate, preHandler: free.preHandler };
  const ownedCurrentSim = { onRequest: simGate, preHandler: owned.preHandler };

  /**
   * FREE, and that is deliberate — it is the one place §2.2's table is
   * superseded by the LOCKED OWNER DECISIONS (Q5): "deedless players fight each
   * other", auto-match is their only PvP, so a 402 here would leave the free tier
   * with no opponents at all. Route gating CANNOT express the rule, because the
   * rule is about the DEFENDER: the boundary is enforced per-defender inside
   * createRaid via game/land.ts's tier partition (a deedless attacker only ever
   * meets deedless bases, and vice versa), which also covers revenge and any
   * future route that names a target. Target PICKING is still closed off — it
   * needs the map (/map own-valley) or the scout (/map/scout), both land-gated.
   */
  app.post('/raids', freeCurrentSim, async (req, reply) => {
    const body = parse(CreateRaidBody, req.body);
    const stable = multiBaseEnabled();
    if (body.excludeBaseId && !stable) {
      throw new HttpError(400, 'target exclusion requires stable-base matchmaking');
    }
    const attackerBaseId = stable
      ? await mutationBaseId(req.wallet, body.attackerBaseId)
      : undefined;
    const raid = await createRaid(db, req.wallet, stable ? {
      defenderWallet: body.defenderWallet,
      defenderBaseId: body.defenderBaseId,
      excludeBaseId: body.excludeBaseId,
      attackerBaseId,
      idempotencyKey: body.idempotencyKey,
      authorizeAttackerBase: authorizeRaidBase,
      authorizeDefenderBase: authorizeRaidBase,
      raidProtocolVersion: body.raidProtocolVersion,
      allowRaidProtocolV2: deps.liveRaidV2Enabled === true,
    } : {
      defenderWallet: body.defenderWallet,
      idempotencyKey: body.idempotencyKey,
      raidProtocolVersion: body.raidProtocolVersion,
      allowRaidProtocolV2: deps.liveRaidV2Enabled === true,
    });
    return reply.status(201).send({
      raid: {
        id: raid.id,
        defenderWallet: raid.defenderWallet,
        attackerBaseId: raid.attackerBaseId,
        defenderBaseId: raid.defenderBaseId,
        snapshot: raid.snapshot,
        visualContext: resolveBaseVisualContext(raid.visualContext),
        ...(raid.boundCosmeticVisual === undefined ? {} : { boundCosmeticVisual: raid.boundCosmeticVisual }),
        ...(raid.servicePresentation===undefined?{}:{servicePresentation:raid.servicePresentation}),
        ...(raid.advancedServicePresentation===undefined?{}:{advancedServicePresentation:raid.advancedServicePresentation}),
        armySnapshot: raid.armySnapshot,
        ordersDeadlineAt: raid.ordersDeadlineAt,
        seed: Number(raid.seed),
        simVersion: raid.simVersion,
        raidProtocolVersion: raid.raidProtocolVersion,
      },
    });
  });

  app.post('/raids/:id/orders', {
    ...freeCurrentSim,
    config: {
      rateLimit: { max: RAID_REPLAY_LIMITS.submitRateLimitPerMin, timeWindow: 60_000 },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(OrdersBodySchema, req.body);
    const { result } = await submitOrders(db, req.wallet, id, body);
    return { result };
  });

  app.post('/raids/:id/commands', {
    ...freeCurrentSim,
    config: {
      rateLimit: { max: LIVE_RAID.commandRateLimitPerMin, timeWindow: 60_000 },
    },
  }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(LiveRaidCommandBody, req.body);
    return acceptLiveRaidCommandReceipt(
      db, req.wallet, id, body.clientCommandId, body.command,
    );
  });

  const sendClockControlError = (
    error: unknown,
    reply: FastifyReply,
  ) => {
    if (!(error instanceof RaidClockStaleError)) throw error;
    return reply.status(409).send({
      error: { message: error.message, code: error.code, clock: error.clock },
    });
  };

  // Reuse this exact hook for /start and /speed. Calling app.rateLimit once is
  // load-bearing: two route-level configs receive two store children even with
  // the same groupId and would silently allow 60 combined requests per minute.
  // The normal test app intentionally omits the plugin; focused admission tests
  // mount it and exercise this production path.
  const raidClockControlLimit = app.hasDecorator('rateLimit')
    ? app.rateLimit(RAID_CLOCK_CONTROL_RATE_LIMIT)
    : undefined;
  const raidClockControlRoute = {
    onRequest: [simGate, ...(raidClockControlLimit ? [raidClockControlLimit] : [])],
    preHandler: free.preHandler,
    config: { rateLimit: false as const },
  };

  app.post('/raids/:id/start', raidClockControlRoute, async (req, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(LiveRaidControlBody, req.body);
    try {
      return await startLiveRaid(
        db, req.wallet, id, body.clientCommandId, body.expectedClockRevision,
      );
    } catch (error) {
      return sendClockControlError(error, reply);
    }
  });

  app.post('/raids/:id/speed', raidClockControlRoute, async (req, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(LiveRaidSpeedBody, req.body);
    try {
      return await setLiveRaidSpeed(
        db, req.wallet, id, body.clientCommandId, body.expectedClockRevision,
        body.rate, deps.liveRaidV2Enabled === true,
      );
    } catch (error) {
      return sendClockControlError(error, reply);
    }
  });

  app.get('/raids/:id/live', {
    ...freeCurrentSim,
    config: {
      rateLimit: { max: LIVE_RAID.reconnectRateLimitPerMin, timeWindow: 60_000 },
    },
  }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { afterSequence } = parse(z.object({
      afterSequence: z.coerce.number().int().min(-1).default(-1),
    }), req.query ?? {});
    return getLiveRaidCommands(db, req.wallet, id, afterSequence);
  });

  app.post('/raids/:id/finish', {
    ...freeCurrentSim,
    config: {
      rateLimit: { max: RAID_REPLAY_LIMITS.submitRateLimitPerMin, timeWindow: 60_000 },
    },
  }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(FinishRaidBody, req.body ?? {});
    if (body.retreat) {
      const retreat = await retreatLiveRaid(db, req.wallet, id, body.clientCommandId!);
      if (retreat.terminal) return retreat;
      const { result } = await submitOrders(
        db, req.wallet, id, retreat.orders!, undefined, true, false, true,
      );
      return {
        retreated: true,
        terminal: true,
        result,
        command: retreat.command,
        clock: retreat.clock,
      };
    }
    const orders = await closeLiveRaidStream(db, req.wallet, id);
    const { result } = await submitOrders(
      db, req.wallet, id, orders, undefined, true, false, orders.retreated === true,
    );
    return { result };
  });

  /** Selected-deed raid interlock. The base screen uses this to replace every
   * mutation affordance with the approved live-watch notice. */
  app.get('/bases/:baseId/active-raid', freeCurrentSim, async (req) => {
    const { baseId } = parse(z.object({ baseId: z.uuid() }), req.params);
    const owned = await mutationBaseId(req.wallet, baseId);
    if (!owned) throw new HttpError(404, 'base not found');
    await recoverLiveRaidLifecycle(db, undefined, owned);
    return { activeRaid: await getActiveBaseRaid(db, owned) };
  });

  app.get('/bases/:baseId/raid-events', freeCurrentSim, async (req, reply) => {
    if (!deps.raidEvents) throw new HttpError(404, 'raid streaming is unavailable', 'RAID_EVENTS_DISABLED');
    const { baseId } = parse(z.object({ baseId: z.uuid() }), req.params);
    deps.raidEvents.assertCapacity(req.wallet);
    const validate = async () => {
      await app.authenticate(req, reply);
      if (!freeOnboarding) await app.requireLandOwned(req, reply);
      if (!await mutationBaseId(req.wallet, baseId)) throw new HttpError(404, 'base not found');
    };
    await validate();
    openRaidEventStream(deps.raidEvents, reply, baseId, req.wallet, validate);
  });

  /** Permanent deed-owned history. Current finalized deed authority inherits
   * replays after sale; the service redacts the prior owner's exact loot. */
  app.get('/bases/:baseId/battles', free, async (req) => {
    const { baseId } = parse(z.object({ baseId: z.uuid() }), req.params);
    const query = parse(z.object({
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().positive().optional(),
    }), req.query ?? {});
    const ownedBaseId = await mutationBaseId(req.wallet, baseId);
    if (!ownedBaseId) throw new HttpError(404, 'base not found');
    return getBaseBattleHistory(db, req.wallet, ownedBaseId, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });

  app.get('/bases/:baseId/battles/:raidId/replay', free, async (req) => {
    const { baseId, raidId } = parse(z.object({ baseId: z.uuid(), raidId: z.uuid() }), req.params);
    const ownedBaseId = await mutationBaseId(req.wallet, baseId);
    if (!ownedBaseId) throw new HttpError(404, 'replay not found');
    return getBaseBattleReplay(db, req.wallet, ownedBaseId, raidId);
  });

  /** A wallet's immutable participant scope is intentionally auth-only rather
   * than deed-gated: a seller must retain their exact private history after the
   * deed (and possibly their last active base slot) leaves the wallet. */
  app.get('/battles/participated', authOnly, async (req) => {
    const query = parse(z.object({
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().positive().optional(),
    }), req.query ?? {});
    return getParticipantBattleHistory(db, req.wallet, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });

  app.get('/battles/participated/:raidId/replay', authOnly, async (req) => {
    const { raidId } = parse(z.object({ raidId: z.uuid() }), req.params);
    return getParticipantBattleReplay(db, req.wallet, raidId);
  });

  // Buying raid energy is pay-per-action on-chain (v3): the client mints an
  // 'energy' deposit intent (POST /deposits), pays via shardkeep-core buy_sink,
  // and the +1 is granted when the payment finalizes. There is no server-side
  // debit route anymore.

  app.get('/raids', free, async (req) => {
    if (multiBaseEnabled()) {
      throw new HttpError(
        410,
        'battle history belongs to a deed; use /bases/:baseId/battles',
        'BASE_BATTLE_HISTORY_REQUIRED',
      );
    }
    return { raids: await getRaidLog(db, req.wallet) };
  });

  // A create response can be lost while its raid/hero reservations correctly
  // survive. This is the attacker-only continuation surface; unlike a replay,
  // it returns only still-pending CURRENT-simulator marches.
  app.get('/raids/pending', freeCurrentSim, async (req) => {
    return { raids: await getPendingRaidResumes(db, req.wallet) };
  });

  app.get('/raids/pending/:id', freeCurrentSim, async (req) => {
    const { id } = req.params as { id: string };
    return { raid: await getPendingRaidResume(db, req.wallet, id) };
  });

  app.get('/raids/:id/replay', free, async (req) => {
    if (multiBaseEnabled()) {
      throw new HttpError(
        410,
        'battle replays belong to a deed; use /bases/:baseId/battles/:raidId/replay',
        'BASE_BATTLE_REPLAY_REQUIRED',
      );
    }
    const { id } = req.params as { id: string };
    return getReplay(db, req.wallet, id);
  });

  // --- World map + PvE (PLAN.md 4e) ----------------------------------------
  /** The legacy tactical board is gone. GET /map survives only as the narrow
   * parcel-band projection used by rolling globe clients; that projection keeps
   * its prior land gate for an own-area read and in flag-off deployments. */
  const requireLandForParcelBand = async (
    req: FastifyRequest, reply: Parameters<typeof app.requireLandOwned>[1],
  ): Promise<void> => {
    // The old tactical valley board is retired. Do not spend a land lookup on a
    // request the handler will answer 410; only the globe's narrow parcel-band
    // projection remains on this URL during the rolling client transition.
    const query = req.query as { parcelBand?: unknown } | undefined;
    if (query?.parcelBand !== '1') return;
    if (!freeOnboarding || visitValleyId(req) === null) await app.requireLandOwned(req, reply);
  };
  const mapPreHandler = [app.authenticate, requireLandForParcelBand];

  // ETag + `private, no-cache`: the browser revalidates every poll and the server
  // answers 304 (~200 B) whenever the valley has not changed — the roster only
  // moves on a raid resolution, a shield expiry or a new keep. The ETag is over
  // the VIEWER'S payload, so one browser's cached body can never be served to a
  // different account (a mismatched If-None-Match simply gets a fresh 200).
  app.get('/map', { preHandler: mapPreHandler, config: { rateLimit: MAP_RATE_LIMITS.map } }, async (req, reply) => {
    await requireLegacyWorldPresentation(db);
    const rect = clampMapRect(parse(MapQuery, req.query), req.log);
    if (!rect.parcelBand) {
      throw new HttpError(
        410,
        'the legacy valley view is retired; use the globe',
        'VALLEY_VIEW_RETIRED',
      );
    }
    const body = JSON.stringify(await getMapChunk(db, req.wallet, rect));
    const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
    reply.header('cache-control', 'private, no-cache').header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });

  // LAND-GATED because this route IS the plot assignment: ensurePlotAssigned is
  // the one call that hands out a parcel, and the locked decision keeps it on the
  // paid side (a deedless player has a base, not a place). §2.2 listed it FREE
  // under the earlier shield model, which the owner's Q5 refinement replaced.
  app.get('/map/me', owned, async (req) => {
    await requireLegacyWorldPresentation(db);
    const { baseId } = parse(z.object({ baseId: BaseId }), req.query ?? {});
    if (!multiBaseEnabled()) return ensurePlotAssigned(db, req.wallet);
    const stableBaseId = await paidMutationBaseId(req.wallet, baseId);
    if (!stableBaseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
    return ensureBasePlotAssigned(
      db, req.wallet, stableBaseId,
      async (tx, wallet, id) => { await assertFreshLockedBaseAuthority(tx, wallet, id); },
    );
  });

  // Deedless players get AUTO-MATCH ONLY — no target picking, no scouting
  // (locked decision Q5). game/land.ts's tier partition is the second, deeper
  // guard inside scoutBase; this gate is the first.
  app.get('/map/scout/:wallet', owned, async (req) => {
    const { wallet } = req.params as { wallet: string };
    const { baseId } = parse(BaseQuery, req.query ?? {});
    return scoutBase(db, req.wallet, wallet, new Date(), baseId);
  });

  // The ONLY globe/map read that resolves a foreign parcel to actionable detail.
  // Route-level @fastify/rate-limit configuration replaces the global limiter,
  // so the route config below supplies its own fail-closed IP counter. A second,
  // manually-created counter runs after the unchanged authenticate → land-owner
  // gates and follows that wallet across IP rotation. In NODE_ENV=test buildApp
  // intentionally omits the plugin; focused production-like tests register it.
  const parcelWalletRateLimit = app.hasDecorator('createRateLimit')
    ? app.createRateLimit(MAP_RATE_LIMITS.parcelWallet)
    : null;
  const enforceParcelWalletRateLimit = async (req: FastifyRequest): Promise<void> => {
    if (parcelWalletRateLimit === null) return;
    const limit = await parcelWalletRateLimit(req);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new HttpError(429, `parcel inspection limit reached; try again in ${limit.ttlInSeconds}s`);
    }
  };

  const viewportParcelWalletRateLimit = app.hasDecorator('createRateLimit')
    ? app.createRateLimit(MAP_RATE_LIMITS.viewportParcelWallet)
    : null;
  const enforceViewportParcelWalletRateLimit = async (req: FastifyRequest): Promise<void> => {
    if (viewportParcelWalletRateLimit === null) return;
    const limit = await viewportParcelWalletRateLimit(req);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new HttpError(429, `parcel viewport limit reached; try again in ${limit.ttlInSeconds}s`);
    }
  };

  // Authentication + land ownership establish who may inspect. Preserve this
  // ordering. The response omits presence times, raw balance, army and layout;
  // scout/raid still re-check every rule authoritatively.
  app.get('/map/parcel/:earthCell', {
    preHandler: [...owned.preHandler, enforceParcelWalletRateLimit],
    config: { rateLimit: MAP_RATE_LIMITS.parcelIp },
  }, async (req, reply) => {
    await requireLegacyWorldPresentation(db);
    const { earthCell } = parse(ParcelParams, req.params);
    const query = parse(BaseQuery, req.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return getParcelDetail(
      db, req.wallet, earthCell, new Date(), query.baseId,
      deps.avatarPublicBaseUrl ?? deps.avatarStorage?.publicBaseUrl,
    );
  });

  // --- Globe bands (docs/WORLDMAP-GLOBE-PLAN.md §1.4) -----------------------
  // Both routes are AGGREGATES ONLY — a count, a place, a valley name. Profile
  // identity begins only in the separately loaded parcel band (owner supersession
  // 2026-08-13). Both also carry
  // an EXPLICIT per-IP cap (MAP_RATE_LIMITS.globe) rather than relying on the
  // global 300/60 s floor — /globe can miss the snapshot and run the aggregate.
  //
  // THE ETAG IS DONE RIGHT HERE, and that is the point. The validator is
  // (cache stamp, warzone flag, viewer overlay) and it is matched BEFORE the
  // payload exists, so a 304 costs a cache read, bounded indexed viewer reads and
  // a string compare. GET /map above hashes its FINISHED ~48 KB body, so a 304 there still
  // pays for the whole assembly + stringify + sha1; that is left alone
  // deliberately (Rule 3) and fixed in its own change.
  const globeEtag = (ctx: GlobeContext, scope: string): string =>
    `W/"${createHash('sha1').update(globeEtagInput(ctx, scope)).digest('base64url')}"`;

  const freeGlobe = { ...free, config: { rateLimit: MAP_RATE_LIMITS.globe } };

  // Additive rolling-safe feed for the readable parcel band. It uses the same
  // authenticate/alpha/flag-off land gate as the existing public globe reads,
  // but spans every Earth valley intersecting the bounded fine-grid viewport.
  app.get('/globe/parcels', {
    preHandler: [...free.preHandler, enforceViewportParcelWalletRateLimit],
    config: { rateLimit: MAP_RATE_LIMITS.viewportParcelIp },
  }, async (req, reply) => {
    await requireLegacyWorldPresentation(db);
    const { cx, cy, ...rect } = parse(ViewportParcelsQuery, req.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return getViewportParcels(
      db, rect, cx !== undefined && cy !== undefined ? { lon: cx, lat: cy } : null,
    );
  });

  const requireFantasy = () => {
    if (!fantasyWorldEnabled()) throw new HttpError(503, 'Fantasy world is not enabled', 'FANTASY_WORLD_NOT_READY');
  };
  app.get('/globe/fantasy', freeGlobe, async (req, reply) => {
    requireFantasy();
    const { baseId } = parse(BaseQuery, req.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return getFantasyGlobe(db, req.wallet, baseId);
  });
  app.get('/globe/fantasy/search', { ...free, config: { rateLimit: MAP_RATE_LIMITS.search } }, async req => {
    requireFantasy();
    const { q } = parse(z.object({ q: z.string().max(128).default('') }), req.query ?? {});
    return searchFantasyPlayers(db, q);
  });
  app.get('/globe/fantasy/parcels', {
    preHandler: [...free.preHandler, enforceViewportParcelWalletRateLimit],
    config: { rateLimit: MAP_RATE_LIMITS.viewportParcelIp },
  }, async (req, reply) => {
    requireFantasy();
    const { cx, cy, baseId: _baseId, ...rect } = parse(ViewportParcelsQuery, req.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return getFantasyViewport(db, rect, cx !== undefined && cy !== undefined ? { lon: cx, lat: cy } : undefined);
  });
  app.get('/globe/fantasy/parcels/:tileId', {
    preHandler: [...free.preHandler, enforceParcelWalletRateLimit],
    config: { rateLimit: MAP_RATE_LIMITS.parcelIp },
  }, async (req, reply) => {
    requireFantasy();
    const { tileId } = parse(z.object({ tileId: z.coerce.number().int().min(0).max(GLOBE.fineCols * GLOBE.fineRows - 1) }), req.params);
    const { baseId } = parse(BaseQuery, req.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return getFantasyParcel(db, req.wallet, tileId, new Date(), baseId);
  });

  app.get('/globe', freeGlobe, async (req, reply) => {
    await requireLegacyWorldPresentation(db);
    const { baseId } = parse(BaseQuery, req.query ?? {});
    const ctx = await globeContext(db, req.wallet, new Date(), baseId);
    const etag = globeEtag(ctx, 'globe');
    reply.header('cache-control', 'private, no-cache').header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return buildGlobeResponse(ctx);
  });

  // WIRE SHAPE (D-096, final since D-097): `{ id, name, clusters: [{ id, lon, lat,
  // players, active?, warzone }] }`. `clusters` are the bases inside each 2° coarse
  // cell of this sector (`id` is the coarse cell), pinned ON the counted base cell
  // nearest their centroid. There is no `valleys` list: the one-release
  // compatibility ended with D-097 because deploy.sh drains traffic and every
  // client reloads on the version change, so no client can be mid-flight on the
  // old shape.
  app.get('/globe/sector/:id', freeGlobe, async (req, reply) => {
    await requireLegacyWorldPresentation(db);
    // Range-checked at the edge against the sector grid, so an absurd id is a 400
    // rather than an empty 200 that looks like "nobody lives there".
    const { id } = parse(SectorParams, req.params);
    const { baseId } = parse(BaseQuery, req.query ?? {});
    const ctx = await globeContext(db, req.wallet, new Date(), baseId);
    const etag = globeEtag(ctx, `sector:${id}`);
    reply.header('cache-control', 'private, no-cache').header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return buildGlobeSectorResponse(ctx, id);
  });

  // --- Shop, balances, money plumbing (PLAN.md 4g) --------------------------
  app.get('/balances', authOnly, async (req) => {
    const { baseId: requestedBaseId } = parse(BaseQuery, req.query ?? {});
    const baseId = await mutationBaseId(req.wallet, requestedBaseId);
    // D-152: with Gems on, `features.conversionReceipts` is DROPPED so an
    // installed code-25 client refuses the retired KEEP→SHARDS rail at
    // `validate` (before any request), and `features.gems` advertises the new
    // family. Exact command consent is additive and available even with Gems
    // paused, so a previously reviewed KEEP command can still pin its currency.
    const custody = await readCustodyTransparency(db);
    return { ...await getBalances(db, req.wallet, baseId), features: {
      keepCustody: { version: 1, phase: custody.phase },
      gameCurrency: GAME_CURRENCY_FEATURE,
      ...(gemsEnabled() ? { gems: GEMS_FEATURE } : { conversionReceipts: CONVERSION_RECEIPT_FEATURE }),
      forgeContributionReceipts: FORGE_CONTRIBUTION_RECEIPT_FEATURE,
    } };
  });

  // Recovery stays available after transfer and when the reverse Forge rail is off.
  app.get('/forge/convert/receipt', {
    ...authSensitiveRl,
    onSend: async (_req, reply, payload) => {
      reply.header('Cache-Control', 'private, no-store');
      return payload;
    },
  }, async (req) => getConversionReceipt(db, req.wallet, parse(ConversionReceiptQuerySchema, req.query)));

  app.get('/forge/contribute/receipt', {
    ...authSensitiveRl,
    onSend: async (_req, reply, payload) => {
      reply.header('Cache-Control', 'private, no-store');
      return payload;
    },
  }, async (req) => getForgeContributionReceipt(db, req.wallet, parse(ForgeContributionReceiptQuerySchema, req.query)));

  // Deposited/earned in-game KEEP may always move one-way into non-withdrawable
  // SHARDS at 1:1. This is auth-only and deliberately outside FORGE_ENABLED:
  // only the reverse SHARDS→KEEP extraction path requires land + Gold Forge.
  app.post('/forge/convert', authSensitiveRl, async (req, reply) => {
    // D-152: once Gems are on, KEEP no longer converts to SHARDS directly —
    // Gems do (`POST /gems/to-shards`). 409 is a MoneyOp-DEFINITIVE code for
    // installed code-25 clients (never 410/423), so a retry loop ends cleanly;
    // the historical receipt route above stays readable.
    if (gemsEnabled()) {
      throw new HttpError(409, 'KEEP no longer converts to SHARDS directly — convert Gems instead', 'KEEP_CONVERSION_RETIRED');
    }
    const body = parse(z.object({
      keep: z.coerce.bigint().positive(),
      idempotencyKey: IdemKey,
      baseId: BaseId,
    }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const res = await convertKeepToShards(
      db, req.wallet, body.keep, body.idempotencyKey,
      baseId, stablePrerequisiteContext(baseId),
    );
    return reply.status(201).send(res);
  });

  // --- Gems (D-152; docs/phase-e/E2-GEMS-CONTRACT.md §2) --------------------
  // New operations/catalogue are behind GEMS_ENABLED; historical receipts
  // survive a pause so an accepted debit with a lost response can recover.
  // All routes authenticate (Gems are free-tier too); money POSTs also use the
  // sensitive per-IP ceiling. Receipts are historical evidence only (E1 §4.0).
  const gemsOn = async () => {
    if (!gemsEnabled()) throw new HttpError(503, 'Gems are not enabled', 'PHASE_E_DISABLED');
  };
  // The dark gate runs AFTER authentication (like the Phase E catalogue): an
  // anonymous caller always sees 401, so the land-gate probe table can prove
  // the registration, and the surface never becomes a flag oracle.
  const gemsRead = { preHandler: [app.authenticate, gemsOn] };
  const gemsRecovery = { preHandler: [app.authenticate] };
  const gemsMoney = { ...authSensitiveRl, preHandler: [app.authenticate, gemsOn] };
  const noStore = async (_req: unknown, reply: { header: (k: string, v: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  };
  const GemsAmount = z.coerce.bigint().positive();

  app.get('/gems', gemsRead, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const [gems, tasks, custody] = await Promise.all([
      getGemsBalance(db, req.wallet), listGemsTasks(db, req.wallet), readCustodyTransparency(db),
    ]);
    return {
      features: { gems: GEMS_FEATURE },
      gems: gems.toString(),
      tasks,
      // 'wallet-keep' needs both the flag and its destination (E2-GEMS-CONTRACT §4).
      // Unknown custody fails closed for new ledger conversions; wallet purchases and receipts are independent.
      sources: [...(custody.phase === 'open' ? ['ledger-keep' as const] : []),
        ...(gemsWalletBuyEnabled() && gemsReserveAta(db) ? ['wallet-keep' as const] : [])],
      minConvertKeep: GEMS.minConvertKeep,
      maxConvertKeepPerTx: GEMS.maxConvertKeepPerTx,
      gemsPerKeep: GEMS.gemsPerKeep,
      shardsPerGem: GEMS.shardsPerGem,
      serverNow: new Date().toISOString(),
    };
  });

  // Get Gems from the custodial KEEP balance (pre-F ledger source, E3 retires it).
  app.post('/gems/from-keep', gemsMoney, async (req, reply) => {
    const body = parse(z.object({ keep: GemsAmount, idempotencyKey: IdemKey, expected: GemsConversionExpectedSchema.optional() }), req.body);
    const res = await convertKeepToGems(db, req.wallet, body.keep, body.idempotencyKey, body.expected);
    return reply.status(res.duplicate ? 200 : 201).send({ ...res, serverNow: new Date().toISOString() });
  });
  app.get('/gems/from-keep/by-key/:key', { ...gemsRecovery, onSend: noStore }, async (req) => {
    const { key } = parse(z.object({ key: IdemKey }), req.params);
    const receipt = await getGemsFromKeepReceipt(db, req.wallet, { idempotencyKey: key });
    return { wallet: req.wallet, idempotencyKey: key, status: receipt.status,
      receipt: receipt.status === 'accepted' ? receipt : null, serverNow: new Date().toISOString() };
  });
  app.get('/gems/from-keep/receipt', { ...gemsRecovery, onSend: noStore }, async (req) =>
    getGemsFromKeepReceipt(db, req.wallet, parse(GemsFromKeepReceiptQuerySchema, req.query)));

  // Gems → SHARDS at the LOCKED 1:1 rate, unlimited (owner), into the selected base.
  app.post('/gems/to-shards', gemsMoney, async (req, reply) => {
    const body = parse(z.object({ gems: GemsAmount, idempotencyKey: IdemKey, baseId: BaseId, expected: GemsConversionExpectedSchema.optional() }), req.body);
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    const res = await convertGemsToShards(
      db, req.wallet, body.gems, body.idempotencyKey, baseId, stablePrerequisiteContext(baseId), body.expected,
    );
    return reply.status(res.duplicate ? 200 : 201).send({ ...res, serverNow: new Date().toISOString() });
  });
  app.get('/gems/to-shards/receipt', { ...gemsRecovery, onSend: noStore }, async (req) =>
    getGemsToShardsReceipt(db, req.wallet, parse(GemsToShardsReceiptQuerySchema, req.query)));

  // Owner-authored one-time tasks (D-152 amendment): once per wallet, forever.
  app.get('/gems/tasks', gemsRead, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return listGemsTasks(db, req.wallet);
  });
  app.post('/gems/tasks/:taskId/claim', gemsMoney, async (req, reply) => {
    const { taskId } = parse(z.object({ taskId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/) }), req.params);
    const body = parse(z.object({ idempotencyKey: IdemKey, expected: GemsTaskExpectedSchema.optional() }), req.body);
    const res = await claimGemsTask(db, req.wallet, taskId, body.idempotencyKey, body.expected);
    return reply.status(res.duplicate ? 200 : 201).send({ ...res, serverNow: new Date().toISOString() });
  });
  app.get('/gems/tasks/:taskId/claim/by-key/:key', { ...gemsRecovery, onSend: noStore }, async (req) => {
    const { taskId, key } = parse(z.object({
      taskId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/), key: IdemKey,
    }), req.params);
    const receipt = await getGemsTaskClaimReceipt(db, req.wallet, taskId, key);
    return { wallet: req.wallet, idempotencyKey: key, status: receipt.status,
      receipt: receipt.status === 'accepted' ? receipt : null, serverNow: new Date().toISOString() };
  });

  // Shield extension is pay-per-action on-chain (v3): the client mints a
  // 'shield' deposit intent (POST /deposits), pays via shardkeep-core buy_sink,
  // and the extension is granted when the payment finalizes.

  // --- Gold Forge (owner rules 2026-07-24) — ALWAYS ON since the dual-currency
  // split: mining mints shards, and the forge is the ONLY shards→KEEP faucet. ---
  // Ops kill switch on the only KEEP faucet (money review 2026-07-29 #5). When
  // off the routes are not registered at all — a 404 is unambiguous, and no
  // half-open surface can mint or move forge money.
  // Read from env like the sibling WITHDRAWALS_ENABLED switch (withdrawals.ts:58).
  // Historical receipts remain readable under the Forge kill switch and after
  // deed transfer; this route must not invoke lazy settlement or ownership RPC.
  app.get('/forge/claims/v1/:key', {
    ...authOnly,
    onSend: async (_req, reply, payload) => { reply.header('cache-control', 'private, no-store'); return payload; },
  }, async (req) => {
    const { key } = parse(ForgeClaimKeySchema, req.params);
    return getForgeClaimCommand(db, req.wallet, key);
  });
  if (process.env['FORGE_ENABLED'] !== 'false') {
  app.post('/forge/claims/v1', authSensitiveRl, async (req, reply) => {
    const request = parse(ForgeClaimRequestSchema, req.body);
    // Exact historical receipt precedes today's deed gate. No fallback resolves
    // a missing original deed from the currently selected one.
    const prior = (await getForgeClaimCommand(db, req.wallet, request.idempotencyKey)).receipt;
    if (prior) return executeForgeClaimCommand(db, req.wallet, request);
    const baseId = request.baseId ? await paidMutationBaseId(req.wallet, request.baseId) : undefined;
    const receipt = await executeForgeClaimCommand(db, req.wallet, request, new Date(), baseId ? forgeStableContext(baseId) : undefined);
    return reply.status(201).send(receipt);
  });

  app.get('/forge', owned, async (req) => {
    const { baseId } = parse(z.object({ baseId: BaseId }), req.query ?? {});
    const resolved = await paidMutationBaseId(req.wallet, baseId);
    return getForgeStatus(
      db, req.wallet, new Date(), resolved,
      resolved ? forgeStableContext(resolved) : undefined,
    );
  });
  app.post('/forge/contribute', ownedRl, async (req, reply) => {
    const body = parse(z.object({
      shards: z.coerce.bigint().positive(),
      idempotencyKey: IdemKey,
      baseId: BaseId,
    }), req.body);
    const baseId = await paidMutationBaseId(req.wallet, body.baseId);
    await settleDueForgeDays(db); // lazy-settle past days before adding to today
    const res = await contributeToForge(
      db, req.wallet, body.shards, body.idempotencyKey, new Date(), baseId,
      baseId ? forgeStableContext(baseId) : undefined,
    );
    return reply.status(201).send(res);
  });
  // CLAIM settled allocations (forge_payout_escrow → player_keep). No `day` =
  // every claimable day, oldest first, up to FORGE.claimBatchMax; `remaining`
  // tells the UI to offer another tap rather than silently truncating.
  // No 409: a concurrent double-tap loses the row gate and simply reports the
  // day as already claimed (absent from `claimed`).
  // AUTH-ONLY: settlement already moved this wallet's KEEP into payout escrow.
  // A deed sale may stop new contributions, but it must never strand an owed
  // allocation behind the land gate (same unwind rule as withdrawals/market).
  app.post('/forge/claim', authSensitiveRl, async (req, reply) => {
    const body = parse(z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      baseId: BaseId,
    }), req.body ?? {});
    // NOTE: the auto-injected client idempotencyKey is deliberately IGNORED —
    // it is stripped by the zod object. The claim's ledger key is the server's
    // own `forge:${day}:${wallet}:claim` (security review 2026-07-24 #3: a
    // client key must never reach postTransaction on this surface).
    const baseId = body.baseId ? await paidMutationBaseId(req.wallet, body.baseId) : undefined;
    const res = await claimForgeDays(
      db, req.wallet, body.day, new Date(), baseId,
      baseId ? forgeStableContext(baseId) : undefined,
    );
    return reply.status(201).send(res);
  });
  // The caller's OWN allocation history (never anyone else's). Auth-only so a
  // former landowner can still inspect and claim allocations earned beforehand.
  // like the other read endpoints: own rows only, so there is nothing to
  // harvest here, and LOAD MORE paging shouldn't burn the tight ownedRl budget.
  app.get('/forge/allocations', authOnly, async (req) => {
    const q = parse(z.object({
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.coerce.number().int().positive().optional(),
      baseId: BaseId,
    }), req.query ?? {});
    const baseId = q.baseId ? await paidMutationBaseId(req.wallet, q.baseId) : undefined;
    return getForgeAllocations(db, req.wallet, {
      ...(q.before ? { before: q.before } : {}), ...(q.limit ? { limit: q.limit } : {}),
    }, new Date(), baseId, baseId ? forgeStableContext(baseId) : undefined);
  });
  // PUBLIC allocations for one SETTLED cycle — abbreviated wallets, bounded
  // pages, open cycles refused (see getForgeGlobalDay's contract). RATE-LIMITED
  // because it is the one forge surface that returns OTHER players' data:
  // abbreviation stops bulk harvesting, the limit stops grinding it out.
  app.get('/forge/global', ownedRl, async (req) => {
    const q = parse(z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      cursor: z.string().max(256).optional(),
      limit: z.coerce.number().int().positive().optional(),
    }), req.query ?? {});
    return getForgeGlobalDay(db, req.wallet, {
      ...(q.day ? { day: q.day } : {}), ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  });
  // PUBLIC recent relic drops — who won which relic in which cycle (tester
  // 69arc, report 0d1b6d9d "RELICS WON DISPLAY"). Uncredentialed on purpose:
  // transparency that drops really happen is the point. It stays cheap by
  // construction — bounded page (FORGE.recentDropsMaxPageSize), one query
  // per FORGE.recentDropsCacheSec window served from the in-process cache,
  // and a per-IP limit like /playtest/stats. Wallets leave the server already
  // abbreviated (the /forge/global rule); no claim status or base ids.
  app.get('/forge/drops/recent', { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, async (req, reply) => {
    const q = parse(z.object({
      limit: z.coerce.number().int().positive().optional(),
    }), req.query ?? {});
    const feed = await getRecentForgeDrops(db, q.limit ? { limit: q.limit } : {});
    reply.header('cache-control', `public, max-age=${feed.cacheSec}`);
    return feed;
  });
  } // end FORGE_ENABLED

  // --- Items — catalog + inventory + buy + use. (POST /items/equip was the
  // keep-skin equip surface; it was removed with the cosmetics, M23 a8 — an
  // equip request now 404s at the router.) ---
  app.get('/items', free, async (req) => {
    const query = parse(z.object({ baseId: BaseId }), req.query ?? {});
    const baseId = await mutationBaseId(req.wallet, query.baseId);
    return getItems(db, req.wallet, baseId);
  });
  app.post('/items/buy', free, async (req, reply) => {
    const body = parse(z.object({
      itemId: z.string().min(1).max(64), idempotencyKey: IdemKey, baseId: BaseId,
      consent: ItemPurchaseConsentSchema.optional(),
    }), req.body);
    const request = itemPurchaseIntent(body.itemId, body.idempotencyKey, body.baseId, body.consent);
    const replay = await replayItemPurchase(db, req.wallet, request);
    if (replay) return reply.status(201).send(replay);
    assertItemPurchaseScope(request, multiBaseEnabled());
    const item = (ITEMS as Record<string, {
      acquisition?: { type?: string };
    } | undefined>)[body.itemId];
    const baseId = item?.acquisition?.type === 'keep_level'
      ? await paidMutationBaseId(req.wallet, body.baseId)
      : await mutationBaseId(req.wallet, body.baseId);
    const res = await buyItem(db, req.wallet, body.itemId, body.idempotencyKey, {
      baseId, consent: body.consent,
      ...(baseId ? { authorizeBaseMutation: async (tx: DbTx, wallet: string, id: string) => {
        await assertFreshLockedBaseAuthority(tx, wallet, id);
      } } : {}),
    });
    return reply.status(201).send(res);
  });
  app.get('/items/buy/receipt', authOnly, async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return readItemPurchaseReceipt(db, req.wallet, parse(ItemPurchaseReceiptQuerySchema, req.query ?? {}));
  });
  // USE a consumable (owner priority): decrement + effect, atomic. jobId is
  // optional for finish_job — the server targets the soonest active build.
  app.post('/items/use', free, async (req) => {
    const body = parse(z.object({
      itemId: z.string().min(1).max(64),
      jobId: z.string().uuid().optional(),
      idempotencyKey: IdemKey,
      baseId: BaseId,
    }), req.body);
    const item = (ITEMS as Record<string, { effect?: { type?: string } } | undefined>)[body.itemId];
    const baseId = item?.effect?.type === 'warzone_shield' || item?.effect?.type === 'finish_job'
      ? await paidMutationBaseId(req.wallet, body.baseId)
      : await mutationBaseId(req.wallet, body.baseId);
    return useItem(db, req.wallet, body.itemId, body.idempotencyKey, {
      jobId: body.jobId, baseId,
      ...(baseId ? { authorizeBaseMutation: async (tx: DbTx, wallet: string, id: string) => {
        await assertFreshLockedBaseAuthority(tx, wallet, id);
      } } : {}),
    });
  });
  app.post('/items/:itemId/seen', free, async (req) => {
    const { itemId } = parse(z.object({ itemId: z.string().min(1).max(64) }), req.params);
    const body = parse(BaseQuery, req.body ?? {});
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return markItemSeen(db, req.wallet, itemId, new Date(), {
      baseId,
      ...(baseId ? { authorizeBaseMutation: async (tx: DbTx, wallet: string, id: string) => {
        await assertFreshLockedBaseAuthority(tx, wallet, id);
      } } : {}),
    });
  });

  // --- Marketplace Lane A (MARKETPLACE-ESCROW-SPEC §3) — READ-ONLY browse over
  // the deed Core collection + external Tensor/ME links. No program, no custody;
  // gameplay never reads any of this (attackability is server-truth, INV-1). ---
  const marketDeps = deps.market ?? {};
  app.get('/market/collection', free, async () => getMarketCollection(marketDeps));
  app.get('/market/assets', free, async (req) => getMarketAssets(db, marketDeps, req.wallet));

  // --- Sellable bases: the BUYER claims (S1-Q, owner 2026-07-29). Deeds trade
  // on external Core marketplaces (5% royalty, marketplace-honoured — ruleSet
  // None, so it is NOT enforced on chain); these two
  // routes are the only thing that makes a traded deed convey the actual base.
  // AUTH-ONLY, deliberately NOT land-gated: the buyer of a deed has never paid
  // entry, and claiming is exactly what they must be able to do instead.
  // Nothing is read from the request — the claimant is the session wallet and
  // the deed/seller come from DAS + server truth (a body is ignored). ---
  const deedReaders = marketDeps.deedReaders ?? makeDeedReaders(marketDeps);
  const claimRl = {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: MARKETPLACE.claim.rateLimitPerMin, timeWindow: 60_000 } },
  };
  /**
   * LEGACY-ONLY: abandon a free wallet-keyed base — the explicit step that
   * unblocks claiming a purchased one before stable multi-base. `claimRl`, not
   * `free`: a landless caller is exactly who needs it, so it is not land-gated.
   *
   * The typed confirmation is the guard. This is the only destructive route in
   * the game, `abandonFreeBase` refuses anything with land/plot/deed, and a
   * mistap costing someone their whole base is not recoverable — so the client
   * has to say the word, and a body a client sends by accident cannot say it.
   * Stable mode rejects the route before this legacy helper can see conveyed
   * child rows whose compatibility wallet still names a seller.
   */
  app.post('/base/abandon', claimRl, async (req) => {
    if (multiBaseEnabled()) {
      // Legacy abandonment deletes wallet-keyed child rows. After a stable deed
      // transfer those compatibility columns intentionally still name the
      // seller, so allowing this path could erase the buyer's conveyed base.
      throw new HttpError(
        409,
        'legacy free-base abandonment is unavailable in multi-base mode',
        'BASE_ABANDON_UNAVAILABLE',
      );
    }
    parse(z.object({ confirm: z.literal('ABANDON') }), req.body);
    return abandonFreeBase(db, req.wallet);
  });

  app.get('/base/claimable', claimRl, async (req) => {
    const r = await findClaimableBase(db, deedReaders, req.wallet);
    return { claimable: r.claimable !== null, deedAssetId: r.claimable?.deedAssetId ?? null, reason: r.reason };
  });
  app.post('/base/claim', claimRl, async (req) => claimBase(db, deedReaders, req.wallet));
  const exactClaimRead = { ...claimRl,
    onSend: async (_req: FastifyRequest, reply: FastifyReply, payload: unknown) => { reply.header('cache-control', 'private, no-store'); return payload; },
  };
  app.get('/base/claims/v1/claimable', exactClaimRead, async req => getClaimableBaseV1(db, deedReaders, req.wallet));
  app.get('/base/claims/v1/:key', exactClaimRead, async req => {
    const { key } = parse(BaseClaimKeySchema, req.params); return getBaseClaim(db, req.wallet, key);
  });
  app.post('/base/claims/v1', exactClaimRead, async req => executeBaseClaim(db, deedReaders, req.wallet, parse(BaseClaimRequestSchema, req.body)));
  app.post('/base/claims/v1/:key/cancel-unaccepted', exactClaimRead, async req => {
    const { key } = parse(BaseClaimKeySchema, req.params); parse(z.object({}).strict(), req.body);
    return cancelUnacceptedBaseClaim(db, req.wallet, key);
  });


  // In-app item market — stable gear/consumables follow their deed; the
  // fenced flag-off book retains wallet custody. The SOL flow:
  // reserve (lock + get payment params) → buyer pays 95%/5% on-chain → settle
  // (verify finalized + hand over the item). Direct, non-custodial (owner
  // 2026-07-24). The item-market deps carry the fee treasury + payment verifier.
  const itemMarketDeps = {
    cluster: marketDeps.cluster,
    feeTreasury: marketDeps.feeTreasury,
    verifyPayment: marketDeps.verifyPayment,
    verifyPaymentCommit: marketDeps.verifyPaymentCommit,
    authorizeLandMutation: multiBaseEnabled() ? assertLockedMarketLandAuthority : undefined,
    refreshStableSourceAuthority: multiBaseEnabled()
      ? async (wallet: string, baseId: string) => {
        await requireExactFinalizedOwnedBaseAuthority(
          db, wallet, baseId, finalizedDeedReader, deps.market?.deedCollection ?? null,
        );
      }
      : undefined,
  };
  // reserve/settle fan out to Solana RPC (settle does up to 17 calls) and settle
  // is polled every ~2.5s, so rate-limit them like the deposit-verify route
  // (security review 2026-07-24 #4). 40/min settle covers polling + headroom.
  //
  // THE LAND GATE SITS ON creation of `reserve` ALONE, AND THAT IS THE F6 FIX
  // (2026-08-09). The handler performs that gate after recognizing an existing
  // buyer's protected retry; a blanket preHandler would cut off payment-param
  // recovery after land transfer. Carrying the gate on /paid and /settle
  // stranded real SOL: a buyer who reserved, signed and broadcast and then lost
  // their own land (sold their base — `transferBase` nulls `entryPaidAt`) got a 402
  // at /paid and /settle while the SOL was already in the seller's wallet, so the
  // item could only be rescued by a third party's action.
  //
  // GUARANTEE THAT MUST STAY TRUE: once real money has moved, honouring the trade
  // depends on NEITHER party's land state. Reserving is the commitment and the only
  // moment where refusing costs nobody anything, so it is the only gated one.
  // /paid and /settle are safe ungated because they are scoped to a reservation the
  // caller ALREADY HOLDS — `submitPayment` and `settleListing` both require
  // `reservedBy = caller` and 422 otherwise, so a landless caller gains nothing
  // here but the ability to finish their own purchase. The RATE LIMITS are
  // unchanged (20/min reserve + paid, 40/min settle); only the gate moved.
  const reserveRl = { preHandler: [app.authenticate], config: { rateLimit: { max: 20, timeWindow: 60_000 } } };
  const paidRl = { preHandler: [app.authenticate], config: { rateLimit: { max: 20, timeWindow: 60_000 } } };
  const settleRl = { preHandler: [app.authenticate], config: { rateLimit: { max: 40, timeWindow: 60_000 } } };
  // Browse the book with an optional item filter + sort. Unparameterised = the
  // whole open book, cheapest first (the floor a buyer actually pays).
  app.get('/market/listings', free, async (req) => {
    const q = parse(z.object({
      itemId: z.string().min(1).max(64).optional(),
      sort: z.enum(['floor', 'price_desc', 'newest']).optional(),
    }), req.query ?? {});
    const book = await getListings(db, new Date(), {
      ...(q.itemId ? { itemId: q.itemId } : {}),
      ...(q.sort ? { sort: q.sort } : {}),
    });
    return { ...book, features: { itemMarket: ITEM_MARKET_FEATURE } };
  });
  app.get('/market/listings/mine', free, async (req) => ({ listings: await getMyListings(db, req.wallet) }));
  app.post('/market/list', owned, async (req, reply) => {
    const body = parse(z.object({
      itemId: z.string().min(1).max(64),
      priceLamports: z.coerce.bigint().positive(),
      idempotencyKey: IdemKey,
      baseId: BaseId,
    }), req.body);
    const spec = (ITEMS as Record<string, { kind?: string } | undefined>)[body.itemId];
    const baseId = multiBaseEnabled() && spec !== undefined
      ? await paidMutationBaseId(req.wallet, body.baseId)
      : undefined;
    if (!baseId) await requireFreshLandAuthority(req.wallet);
    const res = await listItem(
      db, req.wallet, body.itemId, body.priceLamports, body.idempotencyKey,
      itemMarketDeps.authorizeLandMutation,
      stablePrerequisiteContext(baseId),
    );
    return reply.status(201).send(res);
  });
  /**
   * SELLING IS THE GATED SIDE — BUT ONLY THE START OF A SALE IS GATEABLE.
   *
   * POST /market/list gates the seller at listing time, and a listing is a
   * standing offer. A stable listing follows its deed if that deed transfers,
   * so a NEW purchase commitment rechecks the exact source deed and freezes its
   * current owner as the 95% SOL recipient. Account/legacy listings recheck the
   * wallet's any-land authority. SOL remains direct and never server-custodied.
   *
   * THIS CHECK GUARDS EXACTLY ONE MOMENT: a stranger taking the listing. It ran on
   * SETTLE too, which stranded real SOL (security review F6, 2026-08-09): a buyer
   * who reserved, signed and broadcast BEFORE the seller's base moved got a 409 at
   * settle — money gone, no item, no refund, and `/cancel` was land-gated so the
   * now-landless seller could not release it either. Once a buyer has paid there is
   * no honest answer but "settle": the SOL is already in the seller's wallet, and
   * the only thing the server still controls is handing over the item.
   *
   * THE RULE, IN ONE SENTENCE: gate the CREATION of a listing and the CREATION of a
   * reservation; never the completion of one already paid for. It has TWO halves,
   * because a sale has two parties and either can lose their land mid-flight — this
   * check is the SELLER half, and the reserve handler's conditional buyer gate
   * (`paidRl` / `settleRl` / cancel remain auth-only) is the BUYER half.
   *
   * Hence, per route — and each line below is what the registrations actually say:
   *  - RESERVE  checks both parties in the handler + transaction before a NEW
   *             commitment. Its preHandler is auth-only so it can recognize the
   *             protected retry before applying the buyer land gate.
   *             EXCEPT for the caller who already holds this reservation: re-
   *             reserving is idempotent (reserveListing returns the same payload)
   *             and is how a buyer recovers their payment params mid-purchase, so
   *             an in-flight purchase is never cut off from its own reference.
   *  - PAID     checks NEITHER party (`paidRl` is auth-only, and this helper is not
   *             called): it only pins a reservation the buyer says they have
   *             already broadcast, and `submitPayment` requires that the caller be
   *             the reserver.
   *  - SETTLE   checks NEITHER party (`settleRl` is auth-only, and this helper is
   *             not called). The buyer who reserved can always claim what they paid
   *             for, whatever either side's land state (settleListing's contract).
   *  - CANCEL   is auth-only too: the landless seller is exactly who needs to
   *             release a stranded listing, and cancelling runs `settlePaidExpired`
   *             first, so a lapsed-but-PAID reservation settles to the buyer
   *             instead of being reclaimed.
   * 409, not 402: the caller is the BUYER and there is nothing wrong with them —
   * the listing is stale.
   */
  const assertListingTakeable = async (
    listingId: string, buyer: string,
  ): Promise<{ protectedRetry: boolean; baseId: string | null }> => {
    const [row] = await db.select({
      paid: players.entryPaidAt,
      sellerWallet: itemListings.sellerWallet,
      baseId: itemListings.baseId,
      currentBaseOwner: bases.ownerWallet,
      status: itemListings.status,
      reservedBy: itemListings.reservedBy,
      reservedUntil: itemListings.reservedUntil,
      reference: itemListings.reference,
      paymentSig: itemListings.paymentSig,
    })
      .from(itemListings)
      .innerJoin(players, eq(players.wallet, itemListings.sellerWallet))
      .leftJoin(bases, eq(bases.id, itemListings.baseId))
      .where(eq(itemListings.id, listingId));
    // No row → let the market service produce its own 404/409 for a missing listing.
    if (!row) return { protectedRetry: false, baseId: null };
    // Match reserveListing's protected idempotent branch exactly. A lapsed,
    // uncommitted reservation is a new commitment and must refresh both parties.
    const protectedRetry = row.status === 'reserved' && row.reservedBy === buyer
      && row.reference !== null && row.reservedUntil !== null
      && (row.paymentSig !== null || row.reservedUntil.getTime() > Date.now()
        - MARKETPLACE.itemMarket.reclaimGraceSec * 1_000);
    if (protectedRetry) return { protectedRetry: true, baseId: row.baseId };
    if (multiBaseEnabled()) {
      try {
        if (row.baseId) {
          if (!row.currentBaseOwner) throw new Error('stable listing has no source base');
          await requireFreshBaseAuthority(
            db, row.currentBaseOwner, row.baseId,
            finalizedDeedReader, deps.market?.deedCollection ?? null,
          );
        } else {
          // Outstanding pre-cutover/flag-off listings keep the existing
          // any-land seller gate; they have no stable source deed.
          await requireFreshLandAuthority(row.sellerWallet);
        }
        return { protectedRetry: false, baseId: row.baseId };
      } catch {
        throw new HttpError(409, 'this listing is no longer available — the seller no longer owns land');
      }
    }
    if (row.paid) return { protectedRetry: false, baseId: null };
    throw new HttpError(409, 'this listing is no longer available — the seller no longer owns land');
  };

  // Reserve → payment params the buyer's wallet signs (95% seller / 5% fee).
  app.post('/market/listings/:id/reserve', reserveRl, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(BaseQuery, req.body ?? {});
    const takeable = await assertListingTakeable(id, req.wallet);
    let buyerBaseId: string | undefined;
    if (!takeable.protectedRetry) {
      // Preserve the legacy flag-off gate and refresh finalized stable authority
      // before the in-transaction callback locks/revalidates the exact evidence.
      await app.requireLandOwned(req, reply);
      buyerBaseId = takeable.baseId
        ? await paidMutationBaseId(req.wallet, body.baseId)
        : undefined;
      if (!buyerBaseId) await requireFreshLandAuthority(req.wallet);
    }
    const res = await reserveListing(
      db, itemMarketDeps, req.wallet, id, new Date(),
      stablePrerequisiteContext(buyerBaseId),
    );
    return reply.status(201).send(res);
  });
  // Commit the broadcast payment signature (safeguard): only an exact confirmed
  // buyer/reference/95-5 transaction locks the reservation to this buyer.
  // AUTH-ONLY (F6): the buyer is telling us money has ALREADY left their wallet, so
  // refusing on their land state would strand it. `submitPayment` scopes this to the
  // caller's own live reservation and proves the exact submitted signature.
  app.post('/market/listings/:id/paid', paidRl, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      signature: z.string().refine(
        isCanonicalSolanaSignature,
        'signature must be a canonical 64-byte base58 Solana transaction signature',
      ),
    }), req.body);
    return submitPayment(db, itemMarketDeps, req.wallet, id, body.signature);
  });
  // Settle: verify the finalized split payment, then grant the item. Polled.
  // NO land check on EITHER party here, on purpose — the seller's is skipped by not
  // calling assertListingTakeable, and the buyer's by `settleRl` being auth-only
  // (F6). `settleListing` refuses anyone who is not the reserver, so this hands the
  // item to exactly the wallet that paid for it.
  app.post('/market/listings/:id/settle', settleRl, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return settleListing(db, itemMarketDeps, req.wallet, id);
  });
  // AUTH-ONLY (F6): an account seller or the stable deed's current owner must be
  // able to unwind held custody without a general active-land gate. This path
  // rescues a paid, lapsed reservation first (settlePaidExpired); cancelListing
  // then 404s anyone without the exact wallet/base authority.
  const recoverableMarketContext = (baseId: string): RecoverableListingBaseContext => ({
      baseId,
      // Inactive deeds are outside the bounded observer sweep. Refresh exact
      // finalized ownership only after cancelListing has rescued any paid buyer,
      // then lock/recheck that evidence with the custody mutation below.
      prepareAuthority: async (wallet: string, baseId: string) => {
        const status = await refreshOwnedBaseOwnership(
          db, wallet, baseId, finalizedDeedReader, deps.market?.deedCollection ?? null,
        );
        if (status !== 'owned') {
          throw new HttpError(
            503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE',
          );
        }
      },
      // Cancellation only unwinds existing custody. An inactive transferred
      // deed must still recover its held item; finalized current ownership and
      // the per-base raid lock remain mandatory inside the service transaction.
      assertAuthority: async (tx: DbTx, wallet: string, baseId: string) => {
        await assertFreshLockedBaseAuthority(tx, wallet, baseId, new Date(), { allowInactive: true });
      },
  });
  app.post('/market/listings/:id/cancel', authOnly, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [listing] = await db.select({ baseId: itemListings.baseId })
      .from(itemListings).where(eq(itemListings.id, id));
    const context = listing?.baseId ? recoverableMarketContext(listing.baseId) : undefined;
    return cancelListing(db, itemMarketDeps, req.wallet, id, new Date(), context);
  });

  // V1 is an additive public contract over the same custody transactions. Exact
  // historical keys are authenticated BEFORE any gate for a new commitment.
  const marketRead = { ...authOnly, onSend: async (_req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  } };
  app.get('/market/purchases/pending', marketRead, async (req) => {
    const { after } = parse(z.object({ after: z.uuid().optional() }).strict(), req.query ?? {});
    return getPendingMarketPurchases(db, req.wallet, after);
  });
  app.get('/market/trades', marketRead, async (req) => getMarketTradeHistory(db, req.wallet));
  // Explicit recovery checks exactly the retained reference. No new quote or
  // payment is created, and the existing finalized proof/custody path owns grants.
  app.post('/market/purchases/:id/check', { ...settleRl, onSend: marketRead.onSend }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }).strict(), req.params);
    const { reference } = parse(z.object({ reference: z.string().min(32).max(44) }).strict(), req.body);
    return settleListing(db, itemMarketDeps, req.wallet, id, reference);
  });
  const marketId = z.object({ id: z.uuid() }).strict();
  app.get('/market/v1/list/by-key/:key', marketRead, async (req) => {
    const { key } = parse(MarketKeySchema, req.params);
    const receipt = await listingCreationReceipt(db, req.wallet, key);
    if (!receipt) throw new HttpError(404, 'listing receipt not found');
    return receipt;
  });
  app.post('/market/v1/list', authOnly, async (req, reply) => {
    const body = parse(MarketListRequestSchema, req.body);
    const old = await listingCreationReceipt(db, req.wallet, body.idempotencyKey);
    if (old) {
      if (old.itemId !== body.itemId || old.sourceBaseId !== body.baseId || old.priceLamports !== body.priceLamports) throw new HttpError(409, 'listing key was used for different terms', 'MARKET_KEY_CONFLICT');
      return old;
    }
    requireMarketV1(itemMarketDeps);
    await app.requireLandOwned(req, reply);
    const spec = (ITEMS as Record<string, { kind?: string } | undefined>)[body.itemId];
    const baseId = multiBaseEnabled() && spec !== undefined ? await paidMutationBaseId(req.wallet, body.baseId ?? undefined) : undefined;
    if (body.baseId !== (baseId ?? null)) throw new HttpError(409, 'listing source custody differs from the reviewed source', 'MARKET_CONSENT_CHANGED');
    if (!baseId) await requireFreshLandAuthority(req.wallet);
    await listItem(db, req.wallet, body.itemId, BigInt(body.priceLamports), body.idempotencyKey, itemMarketDeps.authorizeLandMutation, stablePrerequisiteContext(baseId));
    return reply.status(201).send(await listingCreationReceipt(db, req.wallet, body.idempotencyKey));
  });
  app.get('/market/v1/listings/mine', marketRead, async (req) => ownListingsV1(db, req.wallet));
  app.get('/market/v1/reservations/by-key/:key', marketRead, async (req) => {
    const { key } = parse(MarketKeySchema, req.params);
    const row = await reservationByKey(db, req.wallet, key);
    if (!row) throw new HttpError(404, 'reservation receipt not found');
    return reservationReceipt(db, row);
  });
  app.post('/market/v1/listings/:id/reserve', reserveRl, async (req, reply) => {
    const { id } = parse(marketId, req.params); const body = parse(MarketReserveRequestSchema, req.body);
    const old = await reservationByKey(db, req.wallet, body.idempotencyKey);
    if (old) { requireReserveRequest(old, id, body); return reservationReceipt(db, old); }
    requireMarketV1(itemMarketDeps);
    const takeable = await assertListingTakeable(id, req.wallet);
    let buyerBaseId: string | undefined;
    if (!takeable.protectedRetry) {
      await app.requireLandOwned(req, reply);
      buyerBaseId = takeable.baseId ? await paidMutationBaseId(req.wallet, body.buyerBaseId ?? undefined) : undefined;
      if (!buyerBaseId) await requireFreshLandAuthority(req.wallet);
    }
    await reserveListing(db, itemMarketDeps, req.wallet, id, new Date(), stablePrerequisiteContext(buyerBaseId), body);
    return reply.status(201).send(await reservationReceipt(db, (await reservationByKey(db, req.wallet, body.idempotencyKey))!));
  });
  app.post('/market/v1/reservations/:id/paid', paidRl, async (req) => {
    const { id } = parse(marketId, req.params); const body = parse(MarketPaidRequestSchema, req.body);
    return payReservation(db, itemMarketDeps, req.wallet, id, body.reference, body.signature);
  });
  app.post('/market/v1/reservations/:id/settle', settleRl, async (req) => {
    const { id } = parse(marketId, req.params); const body = parse(MarketSettleRequestSchema, req.body);
    return payReservation(db, itemMarketDeps, req.wallet, id, body.reference, body.signature, true);
  });
  app.get('/market/v1/cancellations/by-key/:key', marketRead, async (req) => {
    const { key } = parse(MarketKeySchema, req.params); const row = await cancellationByKey(db, req.wallet, key);
    if (!row) throw new HttpError(404, 'cancellation receipt not found');
    return cancellationReceipt(row);
  });
  app.post('/market/v1/listings/:id/cancel', authOnly, async (req) => {
    const { id } = parse(marketId, req.params); const body = parse(MarketCancelRequestSchema, req.body);
    return cancelListingV1(db, itemMarketDeps, req.wallet, id, body, recoverableMarketContext);
  });

  const basePurchaseRead = { ...authOnly,
    onSend: async (_req: FastifyRequest, reply: FastifyReply, payload: unknown) => { reply.header('cache-control', 'private, no-store'); return payload; },
  };
  app.get('/base/purchases/v1/:key', basePurchaseRead, async req => {
    const { key } = parse(BasePurchaseKeySchema, req.params);
    return getBasePurchase(db, req.wallet, key);
  });
  // An older server ignores unknown query fields on the original route. The
  // distinct path must return 404 there, before a client saves shield consent.
  app.get('/base/purchases/v1/shields/:key', basePurchaseRead, async req => {
    const { key } = parse(BasePurchaseKeySchema, req.params);
    const { kind } = parse(BasePurchaseShieldQuerySchema, req.query);
    return getBasePurchase(db, req.wallet, key, new Date(), kind);
  });
  // Energy needs its own capability path: old v1 servers do not support ABI3/7 quotes.
  app.get('/base/purchases/v1/energy/:key', basePurchaseRead, async req => {
    const { key } = parse(BasePurchaseKeySchema, req.params);
    const { kind } = parse(BasePurchaseEnergyQuerySchema, req.query);
    return getBasePurchase(db, req.wallet, key, new Date(), kind);
  });
  app.post('/base/purchases/v1/:key/cancel-unquoted', { ...basePurchaseRead, config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async req => {
    const { key } = parse(BasePurchaseKeySchema, req.params); parse(z.object({}).strict(), req.body);
    return cancelUnquotedBasePurchase(db, req.wallet, key);
  });
  app.post('/base/purchases/v1/quote', { ...basePurchaseRead, config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async req => {
    const body = parse(BasePurchaseRequestSchema, req.body);
    const network = deps.basePurchaseNetwork && deps.mineBuild?.liquidityWallet === deps.basePurchaseNetwork.treasuryLiquidity
      && deps.depositVerifier && deps.depositPaymentCommitVerifier
      ? deps.basePurchaseNetwork : undefined;
    return quoteBasePurchase(db, req.wallet, body, network, new Date(), async baseId => {
      await paidDepositBaseId(req.wallet, baseId);
      return stablePrerequisiteContext(baseId)!;
    });
  });

  // Deposits stay auth-only: creating/polling the ENTRY intent is exactly what
  // an unpaid player must be able to do (builder/expansion intents are gated
  // downstream by the server's paid-base check (some generic sink instructions
  // intentionally require no Player PDA).
  app.post('/deposits', { ...authOnly, config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req) => {
    const body = parse(DepositBody, req.body);
    // Fail before land/chain checks: no wallet should be invited to create a
    // SOL→KEEP payment while the matching reserve KEEP rail does not exist.
    // Historical rows still use GET/paid/verify below for custody recovery.
    if (body.kind === 'keep_vend') throwKeepVendUnavailable();
    // Already paid → don't mint an intent or prompt another tx (a second
    // pay_entry reverts on the one-per-wallet Player PDA). The client enters.
    if (body.kind === 'entry' && (await isEntryPaid(db, req.wallet))) {
      return { alreadyPaid: true, kind: 'entry' as const };
    }
    // KEEP custody inflow is auth-only: a player may always bring their own
    // token back into custody. Every gameplay SOL quote requires one freshly
    // verified paid active base, even while the multi-base feature flag is off.
    const depositBaseId = body.kind === 'entry' || body.kind === 'deed' || body.kind === 'keep_deposit' || body.kind === 'gems_buy'
      ? undefined
      : await paidDepositBaseId(req.wallet, body.baseId);
    // A gems_buy is a client-built SPL transfer like a KEEP deposit: refuse
    // before minting a row when the mint/decimals it needs are not configured.
    if (body.kind === 'gems_buy' && !deps.keepDeposit) throw new HttpError(503, 'KEEP transfers are temporarily unavailable');
    const quoteNow = new Date();
    const createIntent = () => createDepositIntent(db, req.wallet, body.kind,
      {
        buildingId: body.buildingId, tx: body.tx, ty: body.ty, keepOut: body.keepOut,
        // gems_buy: the SERVER's mint (never the body's) is frozen into the row
        // with the reserve destination; verification reads the row, not the env.
        keepIn: body.keepIn, idempotencyKey: body.idempotencyKey, mint: body.kind === 'gems_buy' ? deps.keepDeposit?.keepMint : undefined,
        baseId: depositBaseId, earthCell: body.earthCell,
        ...(body.landAddress ? { landAddress: { kind: body.landAddress.kind, worldId: body.landAddress.worldId,
          ...(body.landAddress.tileId !== undefined ? { tileId: body.landAddress.tileId } : {}) } } : {}),
      }, quoteNow, depositBaseId ? {
        baseId: depositBaseId,
        assertAuthority: async (tx, wallet, id) => {
          await assertFreshLockedBaseAuthority(tx, wallet, id);
        },
      } : undefined);
    let intent: Awaited<ReturnType<typeof createIntent>>;
    try {
      intent = await createIntent();
    } catch (error) {
      // A closing reservation stays nonpayable. After its full TTL, use the
      // SAME reference verifier and settlement/expiry fences as the worker
      // before allowing another quote. Age alone is never evidence of nonpayment.
      if (!(error instanceof HttpError)
        || (body.kind !== 'entry' && body.kind !== 'deed')
        || !['PAYMENT_WINDOW_CLOSING', 'RESERVATION_MISMATCH'].includes(error.code ?? '')
        || typeof error.details?.depositId !== 'string'
        || typeof error.details.retryAt !== 'string'
        || quoteNow.getTime() <= Date.parse(error.details.retryAt)
        || !deps.depositVerifier) throw error;
      const depositId = error.details.depositId;
      try {
        await verifyDepositNow(db, deps.depositVerifier, req.wallet, depositId, quoteNow);
      } catch {
        // RPC uncertainty leaves the original reservation pending and returns
        // its recovery details; the client resumes verification of that id.
        throw error;
      }
      const recovered = await getDeposit(db, req.wallet, depositId);
      if (recovered.status === 'credited' || recovered.status === 'failed') return recovered;
      if (recovered.status !== 'expired') throw error;
      intent = await createIntent();
    }
    // A KEEP deposit is a client-built SPL transfer, so return the ATAs it needs:
    // source = the player's KEEP ATA, destination = the hot wallet's KEEP ATA.
    if (body.kind === 'keep_deposit') {
      if (!deps.keepDeposit) throw new HttpError(503, 'KEEP deposits are temporarily unavailable');
      const source = keepAta(new PublicKey(req.wallet), new PublicKey(deps.keepDeposit.keepMint)).toBase58();
      return {
        ...intent, source, destination: deps.keepDeposit.hotWalletAta,
        mint: deps.keepDeposit.keepMint, decimals: deps.keepDeposit.decimals,
      };
    }
    // Get Gems from a wallet: the same SPL transfer, into the emission-reserve
    // ATA (E2-GEMS-CONTRACT §2). destination/mint are the values FROZEN in the
    // intent row (createDepositIntent refused without them), never the live env.
    if (body.kind === 'gems_buy') {
      const frozen = intent as { destination?: string | null; mint?: string | null };
      if (!deps.keepDeposit || !frozen.destination || !frozen.mint) throw new HttpError(503, 'Get Gems from a wallet is temporarily unavailable');
      return intent; // Source, decimals, mint and destination are frozen evidence.
    }
    // Paid building upgrades (kind 'mine' = Mine L5+ / Gold Forge L2+, D-057)
    // AND land expansions pay native SOL 100% to the liquidity wallet; the
    // warzone shield (#49) pays 50% directly to it (+ 50% via buy_sink). All
    // need the liquidity destination; the intent carries amountLamports (the
    // per-index/per-target-level price, or the warzone shield's total).
    // 'mine_build' can no longer be CREATED (mine builds are SOL-free since
    // D-057) so its branch here is only reachable for historical responses.
    if (body.kind === 'mine_build' || body.kind === 'mine' || body.kind === 'expansion' || body.kind === 'warzone_shield') {
      if (!deps.mineBuild) throw new HttpError(503, 'SOL payments are temporarily unavailable');
      return { ...intent, destination: deps.mineBuild.liquidityWallet };
    }
    return intent;
  });

  // K-night-A7: what a saved land reservation (POST /deposits entry|deed) did, by its key. Read-only.
  app.get('/deposits/land/receipt', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return readLandReservationReceipt(db, req.wallet, parse(LandReservationReceiptQuerySchema, req.query ?? {}));
  });
  app.get('/deposits/:id', authOnly, async (req) => {
    const { id } = req.params as { id: string };
    return getDeposit(db, req.wallet, id);
  });

  // The public reference account can be spammed. Persist the authenticated
  // wallet adapter signature so verification checks that exact finalized tx
  // before falling back to bounded reference history.
  app.post('/deposits/:id/paid',
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { signature } = parse(z.object({
        signature: z.string().refine(isCanonicalSolanaSignature,
          'signature must be a canonical 64-byte base58 Solana transaction signature'),
      }), req.body);
      return submitDepositPayment(db, deps.depositPaymentCommitVerifier, req.wallet, id, signature);
    });

  // On-demand verification (incident 2026-07-18): the client polls THIS in its
  // pay flow, so a finalized payment is credited (and base+plot created) even
  // when the background watcher is off. Idempotent; returns the fresh row.
  // Tight per-route limit: each call can fan out to 1-16 RPC lookups, so cap it
  // (security review deposit F1 — the on-demand verify amplifier).
  app.post('/deposits/:id/verify',
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (req) => {
      const { id } = req.params as { id: string };
      if (deps.depositVerifier) {
        await verifyDepositNow(db, deps.depositVerifier, req.wallet, id).catch(() => null);
      }
      return getDeposit(db, req.wallet, id);
    });

  // Email transport for 2FA (dev logs; prod injects a provider). Dev echoes the
  // code in responses so the flow is testable without an email service.
  const emailSender = deps.emailSender ?? consoleEmailSender;
  const devEcho = process.env['NODE_ENV'] === 'development';
  // Production supplies only the public availability flag and queues payouts
  // for the signer-isolated worker. A directly injected sender remains a
  // test/local seam, never production server wiring.
  const instantWithdrawalsEnabled = deps.instantWithdrawalsEnabled ?? Boolean(deps.keepSender);

  app.post('/withdrawals', ownedRl, async (req, reply) => {
    await requireFreshLandAuthority(req.wallet);
    const body = parse(WithdrawBody, req.body);
    const instant = body.instant === true;
    const intent = withdrawalIntent(body, instant, deps.withdrawalNetwork!);
    // Every custody withdrawal carries a fresh wallet signature over the exact
    // gross/fee/net/destination/mode request. Instant additionally consumes a
    // mature TOTP inside the escrow transaction.
    await app.assertRecentAuth(req, 'withdrawal', intent);
    if (body.instant) {
      if (!body.method || !body.code) throw new HttpError(422, 'authenticator code is required for an instant withdrawal');
      if (!instantWithdrawalsEnabled) throw new HttpError(503, 'instant withdrawals are temporarily unavailable — use the standard withdrawal or try again shortly');
    }
    const row = await requestWithdrawal(db, req.wallet, BigInt(body.amount), body.destination, body.idempotencyKey, {
      instant,
      ...(instant && deps.keepSender ? { send: deps.keepSender } : {}),
      // Reserve gate input for the instant settlement (money/withdrawals.ts).
      // Absent → the gate fails closed and the row simply queues for the worker.
      readReserve: deps.reserveReader ?? null,
      authorization: body.authorization,
      authorizationNetwork: deps.withdrawalNetwork!,
      ...(instant && body.method && body.code ? {
        authorize: async (tx) => {
          return verifyInstantWithdrawalTotpTx(tx, req.wallet, body.code!, new Date());
        },
      } : {}),
    });
    return reply.status(201).send({
      id: row.id, status: row.status, unbondsAt: row.unbondsAt,
      amount: row.amount.toString(), feeBurned: row.feeBurned.toString(), txSignature: row.txSignature,
    });
  });

  // Receipt access follows history/unwind, not today's land or payout gates.
  // onSend covers private failures too (authentication, validation, rate limit).
  app.get('/withdrawals/receipt', {
    ...authSensitiveRl,
    onSend: async (_req, reply, payload) => {
      reply.header('Cache-Control', 'private, no-store');
      return payload;
    },
  }, async (req) => getWithdrawalReceipt(db, req.wallet, parse(WithdrawalReceiptQuerySchema, req.query)));

  app.get('/withdrawals/status', owned, async (req) => {
    await requireFreshLandAuthority(req.wallet);
    return getPersonalWithdrawalLimit(db, req.wallet);
  });

  // Validate the exact reviewed intent before the wallet signature or email
  // challenge. This executes the same business gates as requestWithdrawal but
  // rolls back before any ledger write or idempotency anchor is created.
  app.post('/withdrawals/prepare', ownedRl, async (req) => {
    await requireFreshLandAuthority(req.wallet);
    await assertTotpRecoveryAllows(db, req.wallet, 'withdrawal');
    const body = parse(WithdrawalPrepareBody, req.body);
    if (body.instant && !instantWithdrawalsEnabled) {
      throw new HttpError(503, 'instant withdrawals are temporarily unavailable — use the standard withdrawal or try again shortly');
    }
    if (body.instant && !(await get2faStatus(db, req.wallet)).instantEligible) {
      throw new HttpError(403, 'a mature authenticator is required for an instant withdrawal');
    }
    await preflightWithdrawal(
      db, req.wallet, BigInt(body.amount), body.destination, body.idempotencyKey,
      { instant: body.instant === true },
    );
    return withdrawalIntent(body, body.instant === true, deps.withdrawalNetwork!);
  });

  // --- Account 2FA (owner 2026-08-11) — verified email remains a contact and
  // factor-management proof; only a mature authenticator unlocks INSTANT withdrawals. Factor/profile management is
  // auth-only; actually moving money and issuing withdrawal codes stays owned.
  //
  // The explicit Profile email/security flow makes these ACCOUNT routes, not a
  // land perk. A deedless admitted player may secure/change their identity and
  // later export their embedded key; this does not let them withdraw. ----------
  app.get('/2fa/status', { preHandler: [app.authenticateLoginRecovery] }, async (req) => ({
    ...(await get2faStatus(db, req.wallet)),
    recovery: await getTotpRecoveryStatus(db, req.wallet),
    recoveryEnabled: deps.totpRecoveryEnabled === true,
    // Factor maturity and payout-system availability are independent facts.
    // Exposing both prevents the client from calling an enrolled authenticator
    // "active" while the signer worker is deliberately unavailable.
    instantWithdrawalsEnabled,
  }));

  app.post('/2fa/step-up/email', loginRecoveryRl, async (req) => {
    await assertTotpFactorActionAllowed(db, req.wallet, 'step_up_email');
    await app.assertRecentAuth(req, 'factor_change');
    const { devCode } = await sendFactorStepUpEmailCode(
      db, req.wallet, emailSender, req.sessionId,
    );
    return devEcho ? { sent: true, devCode } : { sent: true };
  });

  app.post('/2fa/totp/enroll', loginRecoveryRl, async (req) => {
    await assertTotpFactorActionAllowed(db, req.wallet, 'totp_enroll');
    const { stepUp } = parse(StepUpBody, req.body);
    await app.assertRecentAuth(req, 'factor_change');
    return enrollTotp(db, req.wallet, stepUp, factorChangeEmailChallengeContext(req.sessionId));
  });

  app.post('/2fa/totp/verify', loginRecoveryRl, async (req) => {
    await assertTotpFactorActionAllowed(db, req.wallet, 'totp_verify');
    const { code } = parse(CodeBody, req.body);
    await app.assertRecentAuth(req, 'factor_change');
    await verifyTotpEnroll(db, req.wallet, code);
    return { totpEnabled: true };
  });

  app.post('/2fa/totp/disable', authSensitiveRl, async (req) => {
    await assertTotpFactorActionAllowed(db, req.wallet, 'totp_disable');
    const { code } = parse(CodeBody, req.body);
    await app.assertRecentAuth(req, 'factor_change');
    await disableTotp(db, req.wallet, code);
    return { totpEnabled: false };
  });

  app.post('/2fa/email/start', authSensitiveRl, async (req) => {
    await assertTotpFactorActionAllowed(db, req.wallet, 'email_change');
    const { email, stepUp } = parse(EmailBody, req.body);
    await app.assertRecentAuth(req, 'factor_change');
    const { devCode } = await startEmailEnroll(
      db, req.wallet, email, emailSender, undefined, stepUp,
      factorChangeEmailChallengeContext(req.sessionId),
    );
    return devEcho ? { sent: true, devCode } : { sent: true };
  });

  app.post('/2fa/email/verify', authSensitiveRl, async (req) => {
    await assertTotpFactorActionAllowed(db, req.wallet, 'email_change');
    const { code } = parse(CodeBody, req.body);
    await app.assertRecentAuth(req, 'factor_change');
    await verifyEmailEnroll(db, req.wallet, code);
    return { emailVerified: true };
  });

  app.post('/2fa/totp/recovery/start', loginRecoveryRl, async (req) => {
    if (deps.totpRecoveryEnabled !== true) {
      throw new HttpError(503, 'authenticator recovery is temporarily unavailable', 'TOTP_RECOVERY_DISABLED');
    }
    const { recoveryId } = parse(RecoveryIdBody, req.body);
    await app.assertRecentAuth(req, 'totp_recovery', { recoveryId, action: 'start' });
    const result = await startTotpRecovery(
      db, req.wallet, req.sessionId, recoveryId, emailSender,
    );
    return devEcho ? result : { status: result.status };
  });

  app.post('/2fa/totp/recovery/confirm', loginRecoveryRl, async (req) => {
    const { recoveryId, code } = parse(RecoveryCodeBody, req.body);
    return confirmTotpRecovery(
      db, req.wallet, req.sessionId, recoveryId, code, emailSender,
    );
  });

  app.post('/2fa/totp/recovery/cancel', loginRecoveryRl, async (req) => {
    const { recoveryId, code } = parse(RecoveryCodeBody, req.body);
    return {
      status: await cancelTotpRecovery(db, req.wallet, recoveryId, code, emailSender),
    };
  });

  app.post('/2fa/totp/recovery/complete/send-code', loginRecoveryRl, async (req) => {
    const { recoveryId } = parse(RecoveryIdBody, req.body);
    await app.assertRecentAuth(req, 'totp_recovery', { recoveryId, action: 'complete' });
    const result = await sendTotpRecoveryCompletionCode(
      db, req.wallet, req.sessionId, recoveryId, emailSender,
    );
    return devEcho ? result : { sent: true };
  });

  app.post('/2fa/totp/recovery/complete', loginRecoveryRl, async (req, reply) => {
    const { recoveryId, code } = parse(RecoveryCodeBody, req.body);
    await app.assertRecentAuth(req, 'totp_recovery', { recoveryId, action: 'complete' });
    const result = await completeTotpRecovery(
      db, req.wallet, req.sessionId, recoveryId, code, emailSender,
    );
    // Completion revokes every server session, including this one. Clear the
    // now-dead browser credential in the same response so the next screen starts
    // from an honest signed-out state instead of waiting for a 401 round-trip.
    if (result.transitioned) reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { status: result.status, replay: !result.transitioned };
  });

  // NOT land-gated: a cancel only posts the caller's own escrow back to their
  // own play balance (see `unwindRl`). Rate limit added with the un-gating —
  // it had none while the land gate was doing double duty as one.
  app.post('/withdrawals/:id/cancel', unwindRl, async (req) => {
    const { id } = req.params as { id: string };
    const row = await cancelWithdrawal(db, req.wallet, id);
    return { id: row.id, status: row.status };
  });

  // Recover a FAILED payout: the gross goes back from escrow to the play balance.
  // Player-reachable BY DESIGN — there is no admin surface, so an ops-only path
  // would leave DB surgery as the only way a stranded row ever comes back. It is
  // scoped to the caller's own row and refuses anything that may already have
  // been paid on-chain (see refundFailedWithdrawal).
  app.post('/withdrawals/:id/refund', unwindRl, async (req) => {
    const { id } = req.params as { id: string };
    const row = await refundFailedWithdrawal(db, id, { wallet: req.wallet });
    return { id: row.id, status: row.status, amount: row.amount.toString() };
  });

  // Caller-scoped history/unwind discovery is auth-only. Selling a deed must
  // not make already-escrowed KEEP or its cancel/refund controls unreachable.
  app.get('/withdrawals', authOnly, async (req) => {
    const rows = await listWithdrawals(db, req.wallet);
    return {
      features: { withdrawalReceipts: WITHDRAWAL_RECEIPT_FEATURE },
      // Full player-facing track record (M23 a4): every stored fact the OWNER
      // of the row may see — destination, timestamps, paying mint, net after
      // fee, and the on-chain signature. `lastError` stays server-side: it
      // carries the operator SENT/NOT-BROADCAST refund discriminator and raw
      // RPC detail, and isFailedWithdrawalRefundable remains the one
      // authoritative refund answer.
      withdrawals: rows.map((w) => ({
        id: w.id, status: w.status, amount: w.amount.toString(),
        feeBurned: w.feeBurned.toString(),
        netAmount: (w.amount - w.feeBurned).toString(),
        destination: w.destination,
        mint: w.mint,
        createdAt: w.createdAt, completedAt: w.completedAt,
        unbondsAt: w.unbondsAt, txSignature: w.txSignature,
        refundable: isFailedWithdrawalRefundable(w),
      })),
    };
  });

  // --- Land Deed dynamic metadata (ITEMS plan §metadata) — PUBLIC by design:
  // wallet UIs and marketplaces fetch a deed's URI anonymously, so this cannot
  // sit behind auth. Serves live base state, which is what makes the deed
  // "dynamic": upgrade your Keep and the NFT's traits follow on the next fetch.
  // Reveals nothing beyond what raiding already shows any opponent (INV-1:
  // gameplay never reads deed/DAS state, so this is presentation-only).
  //
  // THE CANONICAL URI (F2): addressed by the deed ASSET and resolved to whoever
  // holds that deed's base right now, so a traded deed describes what it
  // actually conveys instead of following the seller.
  app.get('/deed/asset/:assetId.json', async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(assetId)) throw new HttpError(404, 'no such deed');
    const meta = await buildDeedMetadataForAsset(db, assetId);
    if (!meta) throw new HttpError(404, 'no such deed');
    void reply.header('cache-control', 'public, max-age=60');
    return meta;
  });

  app.get('/deed/asset/:assetId.png', async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(assetId)) throw new HttpError(404, 'no such deed');
    const { retiredDeedImageForAsset } = await import('./retiredDeedImages');
    const preserved = await retiredDeedImageForAsset(db, assetId);
    if (preserved) return reply.code(preserved.status).header('cache-control', 'public, max-age=60').type(preserved.contentType).send(preserved.body);
    let wallet: string | null = null;
    let baseId: string | undefined;
    if (multiBaseEnabled()) {
      const [base] = await db.select({ id: bases.id, wallet: bases.ownerWallet, paid: bases.landPaidAt })
        .from(bases).where(eq(bases.deedAssetId, assetId));
      if (base?.paid) { wallet = base.wallet; baseId = base.id; }
    } else {
      wallet = await deedHolderWallet(db, assetId);
    }
    if (!wallet) throw new HttpError(404, 'no such deed');
    const png = await renderPublicDeedPng(db, wallet, baseId, assetId);
    if (!png) throw new HttpError(404, 'renderer unavailable');
    return reply.header('cache-control', 'public, max-age=60').type('image/png').send(png);
  });

  // Legacy WALLET-keyed alias, kept until every minted deed has been re-URI'd
  // (`pnpm --filter @shardkeep/scripts deed:reuri`): deeds minted before the
  // asset-keyed scheme carry this path on chain. It describes THE WALLET's base
  // — which is why it must never be the URI of a tradeable asset.
  app.get('/deed/:wallet.json', async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new HttpError(404, 'no such deed');
    // Metaplex-standard JSON from the shared builder (deedMetadata.ts — the R2
    // pusher publishes the identical document). Cache briefly so marketplace
    // crawls don't hammer the DB while an upgrade still shows within a minute.
    const meta = await buildDeedMetadata(db, wallet);
    // Deed = a PAID base. Unknown or unpaid wallets have no deed to describe.
    if (!meta) throw new HttpError(404, 'no such deed');
    void reply.header('cache-control', 'public, max-age=60');
    return meta;
  });

  // The deed's IMAGE, rendered live from the same pipeline the R2 pusher uses —
  // this is what the in-game profile shows, so it works with or without R2.
  // Public like the JSON above; renderer unavailable (no atlases) → 404 and the
  // client falls back to nothing rather than a broken img.
  app.get('/deed/:wallet.png', async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new HttpError(404, 'no such deed');
    const { retiredDeedImageForWallet } = await import('./retiredDeedImages');
    const preserved = await retiredDeedImageForWallet(db, wallet);
    if (preserved) return reply.code(preserved.status).header('cache-control', 'public, max-age=60').type(preserved.contentType).send(preserved.body);
    let baseId: string | undefined;
    let deedAssetId: string | null | undefined;
    if (multiBaseEnabled()) {
      const owned = await db.select({ id: bases.id, paid: bases.landPaidAt, deedAssetId: bases.deedAssetId }).from(bases)
        .where(eq(bases.ownerWallet, wallet)).limit(2);
      if (owned.length !== 1 || !owned[0]?.paid) throw new HttpError(404, 'no such deed');
      baseId = owned[0].id;
      deedAssetId = owned[0].deedAssetId;
    } else {
      const [p] = await db.select({ paid: players.entryPaidAt }).from(players)
        .where(eq(players.wallet, wallet));
      if (!p?.paid) throw new HttpError(404, 'no such deed');
    }
    const png = await renderPublicDeedPng(db, wallet, baseId, deedAssetId, true);
    if (!png) throw new HttpError(404, 'renderer unavailable');
    return reply.header('cache-control', 'public, max-age=60').type('image/png').send(png);
  });

  // --- Proof of reserves (PLAN.md 4h) — public by design --------------------
  app.get('/por', async () => {
    const custody = await getProofOfReserves(db, deps.reserveReader ?? null);
    return deps.miningTransparencyReader
      ? { ...custody, mining: await deps.miningTransparencyReader() }
      : custody;
  });

  app.get('/por/proof', authOnly, async (req) => {
    return getInclusionProof(db, req.wallet);
  });

  // --- Campaign (MAPS split E1) + map search (E3) ---------------------------
  app.get('/campaign', free, async (req) => {
    if (!multiBaseEnabled()) return getCampaignBoard(db, req.wallet);
    const query = parse(BaseQuery, req.query ?? {});
    const baseId = await mutationBaseId(req.wallet, query.baseId);
    if (!baseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
    return getBaseCampaignBoard(db, req.wallet, baseId);
  });
  // Inspection reads the same selected-base unlocks as the campaign board.
  // It never creates a raid, reserves an army, spends energy or changes progress.
  app.get('/campaign/:stage/preview', free, async (req) => {
    const stage = Number((req.params as { stage: string }).stage);
    if (!Number.isInteger(stage) || stage < 1 || stage > CAMPAIGN.totalStages) {
      throw new HttpError(404, 'no such campaign stage');
    }
    const query = parse(BaseQuery, req.query ?? {});
    const baseId = multiBaseEnabled() ? await mutationBaseId(req.wallet, query.baseId) : undefined;
    if (multiBaseEnabled() && !baseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
    const board = baseId ? await getBaseCampaignBoard(db, req.wallet, baseId) : await getCampaignBoard(db, req.wallet);
    if (!board.stages.find(row => row.stage === stage)?.unlocked) {
      throw new HttpError(422, 'Clear the preceding campaign stage before inspecting this stronghold', 'CAMPAIGN_STAGE_LOCKED');
    }
    return { stage, snapshot: { ...makeCampaignSnapshot(stage), battlefieldVersion: RAID_BATTLEFIELD.currentVersion },
      visualContext: campaignBaseVisualHere(Math.floor((stage - 1) / CAMPAIGN.stagesPerAct) + 1) };
  });
  app.post('/campaign/:stage/raid', freeCurrentSim, async (req, reply) => {
    const stage = Number((req.params as { stage: string }).stage);
    if (!Number.isInteger(stage) || stage < 1) throw new HttpError(404, 'no such campaign stage');
    const body = parse(RaidKeyBody, req.body);
    const attackerBaseId = await mutationBaseId(req.wallet, body.attackerBaseId);
    const raid = await createCampaignRaid(
      db, req.wallet, stage, body.idempotencyKey, new Date(), {
        attackerBaseId, authorizeAttackerBase: authorizeRaidBase,
        raidProtocolVersion: body.raidProtocolVersion,
        allowRaidProtocolV2: deps.liveRaidV2Enabled === true,
      },
    );
    // Same DTO shape as POST /raids — the raw row's BigInt seed cannot serialize.
    return reply.status(201).send({
      raid: {
        id: raid.id,
        campaignStage: raid.campaignStage,
        attackerBaseId: raid.attackerBaseId,
        snapshot: raid.snapshot,
        visualContext: resolveBaseVisualContext(raid.visualContext),
        armySnapshot: raid.armySnapshot,
        ordersDeadlineAt: raid.ordersDeadlineAt,
        seed: Number(raid.seed),
        simVersion: raid.simVersion,
        raidProtocolVersion: raid.raidProtocolVersion,
      },
    });
  });
  /**
   * FIND A LANDOWNER BY NAME OR WALLET PREFIX. Free-tier (look), with its OWN
   * per-IP ceiling (MAP_RATE_LIMITS.search) — the global floor is not a cost
   * ceiling and this is the free tier's most expensive uncached read.
   *
   * A DEEDLESS CALLER GETS NO LOCATIONS (F11). `searchPlayers` only ever returns
   * landowners (`plots INNER JOIN players`), and for a landowner the full row is
   * unchanged. For a deedless caller `valleyId`, `x` and `y` are stripped: they are
   * the only fields that LOCATE another player's parcel, the client never reads
   * them (apps/web map.tsx uses wallet/name/seeker/keepLevel/trophies), and a
   * deedless caller has no route that can act on a landowner anyway — scouting and
   * the own-valley map are land-gated and the raid pools are sealed by land tier
   * (game/land.ts). Before free onboarding this data cost 0.2 SOL to reach; the
   * reduction keeps the coordinate set on the paid side of that line while the
   * search box still works as a look-only preview.
   */
  app.get('/map/search', { ...free, config: { rateLimit: MAP_RATE_LIMITS.search } }, async (req) => {
    await requireLegacyWorldPresentation(db);
    const q = String((req.query as { q?: string }).q ?? '');
    let landOwned: boolean;
    if (multiBaseEnabled()) landOwned = await hasActivePaidStableBase(db, req.wallet);
    else {
      const [me] = await db.select({ entryPaidAt: players.entryPaidAt })
        .from(players).where(eq(players.wallet, req.wallet));
      landOwned = hasLand(me ?? { entryPaidAt: null });
    }
    const { results } = await searchPlayers(db, q);
    if (landOwned) return { results };
    return {
      results: results.map((r) => ({
        wallet: r.wallet, name: r.name, seeker: r.seeker,
        keepLevel: r.keepLevel, trophies: r.trophies,
      })),
    };
  });

  // --- Clans (Phase 3 pulled forward — CLANS-SELLABLE-DEEDS-PLAN C2) --------
  // M23 a17 (owner 2026-08-15): clans are COMING SOON until the post-alpha
  // clan update. Only GROWTH is refused — reads, leave, kick and the weekly
  // chest settle stay live so the existing paid clans are preserved, and no
  // member is ever locked into a clan they can no longer manage.
  const assertClansOpen = (): void => {
    if (!clansEnabled()) throw new HttpError(503, 'clans arrive after the playtest', 'CLANS_COMING_SOON');
  };
  app.post('/clans', owned, async (req, reply) => {
    assertClansOpen();
    const body = parse(z.object({
      name: z.string().min(1).max(64),
      tag: z.string().min(1).max(16),
      inviteMode: z.enum(['open', 'invite']).optional(),
      idempotencyKey: IdemKey,
      baseId: z.string().uuid().optional(),
    }), req.body);
    const baseId = await paidMutationBaseId(req.wallet, body.baseId);
    const clan = await createClan(db, req.wallet,
      { name: body.name, tag: body.tag, ...(body.inviteMode ? { inviteMode: body.inviteMode } : {}) },
      body.idempotencyKey, stablePrerequisiteContext(baseId));
    return reply.status(201).send({ clan: { id: clan.id, name: clan.name, tag: clan.tag, inviteCode: clan.inviteCode } });
  });
  app.post('/clans/:id/join', owned, async (req) => {
    assertClansOpen();
    const { id } = req.params as { id: string };
    const body = parse(z.object({ inviteCode: z.string().max(32).optional() }), req.body ?? {});
    return joinClan(db, req.wallet, id, body.inviteCode);
  });
  app.post('/clans/leave', owned, async (req) => {
    const body = parse(z.object({ baseId: z.string().uuid().optional() }), req.body ?? {});
    const baseId = await paidMutationBaseId(req.wallet, body.baseId);
    return leaveClan(db, req.wallet, stablePrerequisiteContext(baseId));
  });
  app.post('/clans/kick', owned, async (req) => {
    const body = parse(z.object({ wallet: z.string().min(32).max(44) }), req.body);
    return kickMember(db, req.wallet, body.wallet);
  });
  // Versioned management only. Growth stays behind the existing coming-soon
  // gate; historical receipts remain readable after land/membership changes.
  app.get('/clans/v1/commands/:key', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { key } = parse(ClanCommandKeySchema, req.params);
    return getClanCommand(db, req.wallet, key);
  });
  app.post('/clans/v1/leave', owned, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const body = parse(ClanLeaveRequestSchema, req.body);
    if (multiBaseEnabled() !== (body.baseId !== null)) {
      throw new HttpError(409, 'review the original payout base again', 'CLAN_BASE_CONTEXT_MISMATCH');
    }
    const baseId = await paidMutationBaseId(req.wallet, body.baseId ?? undefined);
    return executeClanCommand(db, req.wallet, {
      kind: 'leave', request: body, baseContext: stablePrerequisiteContext(baseId),
    });
  });
  app.post('/clans/v1/kick', owned, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return executeClanCommand(db, req.wallet, { kind: 'kick', request: parse(ClanKickRequestSchema, req.body) });
  });
  app.get('/clans/mine', owned, async (req) => getMyClan(db, req.wallet));
  app.get('/clans', owned, async () => listClans(db));

  // --- Quests + referrals (PLAN.md 4f) -------------------------------------
  app.get('/quests', free, async (req) => {
    const query = parse(BaseQuery, req.query ?? {});
    const baseId = await mutationBaseId(req.wallet, query.baseId);
    return getQuestBoard(db, req.wallet, new Date(), baseId);
  });

  // FREE per the locked owner decision (Q3): the quest board is free-tier
  // progression. Safe ONLY because quest rewards are SHARDS — game/quests.ts
  // credits `rewardShards`, never `player_keep`, so nothing claimable here is
  // withdrawable. If a quest ever pays KEEP again this must move to `owned`;
  // test/land-gate.test.ts asserts a landless claim mints zero player_keep.
  app.post('/quests/:id/claim', free, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(BaseQuery, req.body ?? {});
    const baseId = await mutationBaseId(req.wallet, body.baseId);
    return claimQuest(db, req.wallet, id, new Date(), stablePrerequisiteContext(baseId));
  });

  // PROFILE › WALLET on-chain balances, read server-side (M23 round-3, owner
  // 2026-08-16: browser reads of public RPCs die on CORS/rate limits). Auth
  // only — it reads the CALLER's own wallet, no paywall stake. 30s cache per
  // wallet inside getWalletBalances bounds the RPC load.
  app.get('/wallet/balances', authOnly, async (req) => {
    if (!deps.walletHub) throw new HttpError(503, 'balance reads are not configured');
    return getWalletBalances(req.wallet, deps.walletHub);
  });

  // DEPOSIT KEEP page › RECENT DEPOSITS (tester request 2026-09-16). Auth only
  // and caller-scoped for the same reason as GET /withdrawals: custody history
  // is a wallet right, never a land or base stake. Read-only; no mutation lives
  // here (the deposit rail stays POST /deposits + /deposits/:id/verify).
  app.get('/wallet/keep-deposits', authOnly, async (req) => ({
    deposits: await listKeepDeposits(db, req.wallet),
  }));

  app.get('/referrals/code', free, async (req) => {
    // D-052: the code doubles as the closed-alpha invite, and the profile
    // shows the LIVE bonus — qualified referrals × 50 bps, minus lapsed ones.
    const [code, bonusBps] = await Promise.all([
      getOrCreateReferralCode(db, req.wallet),
      activeReferralBonusBps(db, req.wallet),
    ]);
    return {
      code,
      bonusBps,
      bonusBpsPerReferral: REFERRALS.miningBonusBpsPerReferral,
    };
  });

  // Auth-only: a referral code is redeemed inside the 14-day onboarding
  // window (GDD §5), which starts BEFORE the entry payment.
  app.post('/referrals/use', authOnly, async (req) => {
    const body = parse(ReferralBody, req.body);
    // Stored codes are upper-case `KEEP-XXXXX`; /alpha/referral and the v1
    // route already normalise, so a pasted lower-case or padded code must not
    // read as "unknown" here alone (tester report df3b58bd, 2026-09-16).
    const row = await useReferralCode(db, req.wallet, body.code.trim().toUpperCase());
    return { referrer: row.referrerWallet };
  });
  app.get('/referrals/v1/status', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return ReferralStatusV1Schema.parse(await referralStatusV1(db, req.wallet));
  });
  app.post('/referrals/v1/use', authOnly, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const body = parse(ReferralUseV1RequestSchema, req.body);
    return ReferralUseV1ResponseSchema.parse(await useReferralCodeV1(db, req.wallet, body.code));
  });

  // --- First-run tutorial (M23 a6) -----------------------------------------
  // FREE tier deliberately: the deedless free tier is exactly who needs the
  // tutorial most, and nothing here moves value — the table stores one integer
  // per wallet. The server owns the step (only current+1 or an idempotent
  // replay is accepted; game/tutorial.ts), so the client can render coach
  // marks but never invent progress. /reset is the REPLAYABLE requirement:
  // the settings screen posts it and the whole run plays again.
  // The probe carries the ONBOARDING CHAIN's live step alongside the card deck
  // (owner 2026-08-28). One request, because this is the eager first-paint probe
  // every authed session makes on reaching the base: a second GET for the chain
  // would be a new request on the hottest path in the client, and the base-screen
  // objective strip needs exactly one row.
  app.get('/tutorial', free, async (req) => {
    const query = parse(BaseQuery, req.query ?? {});
    const baseId = await mutationBaseId(req.wallet, query.baseId);
    const [state, onboarding] = await Promise.all([
      getTutorial(db, req.wallet),
      getOnboardingStep(db, req.wallet, baseId),
    ]);
    return { ...state, onboarding };
  });
  app.post('/tutorial/advance', free, async (req) => {
    const body = parse(TutorialAdvanceBody, req.body);
    return advanceTutorial(db, req.wallet, body.step);
  });
  // SKIP completes directly in one request (documented choice over posting
  // N advances from the client, which would race its own responses).
  app.post('/tutorial/skip', free, async (req) => skipTutorial(db, req.wallet));
  // SKIP THE GUIDED FLOW (owner 2026-08-29: players "should be able to skip
  // tutorial if they dont want to"). Separate from /skip above because it
  // outlives the card deck — the coach marks run for the whole first session —
  // and because it is REVERSIBLE: /guide/resume is the settings undo for a
  // mis-tap. Neither touches the onboarding quest rows; a skipper keeps the
  // objectives and their rewards on the board.
  app.post('/tutorial/guide/skip', free, async (req) => skipGuidance(db, req.wallet));
  app.post('/tutorial/guide/resume', free, async (req) => resumeGuidance(db, req.wallet));
  app.post('/tutorial/reset', free, async (req) => resetTutorial(db, req.wallet));

  // The PvE camp route (`POST /raids/pve`) and its KEEP bounty were REMOVED
  // under D-152 (owner 2026-09-20): camps had been dormant since D-069 and the
  // bounty was a custodial KEEP faucet with no place in the Gems economy. The
  // camp content, `createPveRaid` and `markCampCleared` remain for the world
  // map; a request here is a plain 404.

  return { finalizedDeedReader };
}

const TrainingCompositionBody = z.array(z.object({
  troop: z.enum(TROOP_TYPES), count: z.number().int().min(1).max(TRAINING_PRESETS.maxCompositionUnits),
})).min(1).max(TROOP_TYPES.length);
const TrainingPresetSlot = z.object({ slot: z.coerce.number().int().min(1).max(TRAINING_PRESETS.slots) });
const TrainBody = z.object({
  troop: z.enum(TROOP_TYPES),
  idempotencyKey: IdemKey,
  baseId: BaseId,
});
const CreateRaidBody = z.object({
  defenderWallet: z.string().min(32).max(64).optional(),
  attackerBaseId: BaseId,
  defenderBaseId: BaseId,
  excludeBaseId: BaseId,
  idempotencyKey: IdemKey,
  raidProtocolVersion: z.literal(2).optional(),
}).refine((body) => !body.excludeBaseId || (!body.defenderBaseId && !body.defenderWallet), {
  message: 'target exclusion cannot be combined with an explicit defender',
});
const RaidKeyBody = z.object({
  idempotencyKey: IdemKey,
  attackerBaseId: BaseId,
  raidProtocolVersion: z.literal(2).optional(),
});
const ReferralBody = z.object({ code: z.string().min(6).max(16) });
/** M23 a6: 1..final — step 0 is never a target (that is what /tutorial/reset
 *  is for), and nothing past the shared TUTORIAL_STEPS order exists. */
const TutorialAdvanceBody = z.object({
  step: z.number().int().min(1).max(TUTORIAL_STEPS.count - 1),
});
const DepositBody = z.object({
  kind: z.enum(['entry', 'deed', 'builder', 'expansion', 'energy', 'energy_pack', 'shield', 'mine', 'keep_deposit', 'mine_build', 'warzone_shield', 'keep_vend', 'gems_buy']),
  /** gems_buy (E2-GEMS-CONTRACT §2): whole KEEP the wallet will send (bounds
   * checked server-side → 422 GEMS_PURCHASE_*) and the client's intent key. */
  keepIn: z.number().int().optional(),
  idempotencyKey: IdemKey.optional(),
  /** Required for a paid upgrade (kind 'mine': Mine L5+ / Gold Forge L2+,
   * D-057) — which building the SOL payment levels up. */
  buildingId: z.string().uuid().optional(),
  /** Historical: 'mine_build' intents are refused since D-057 (mine builds
   * are SOL-free); the tile fields remain for request-shape compatibility. */
  tx: Tile.optional(),
  ty: Tile.optional(),
  /** Required for a keep_vend — the whole-KEEP amount to buy (server-priced). */
  keepOut: z.number().int().positive().optional(),
  /** Stable land target for builder/expansion quotes. */
  baseId: BaseId,
  /** Optional exact Earth parcel for an entry/deed land purchase. */
  earthCell: z.number().int().nonnegative().optional(),
  landAddress: z.object({ kind: z.literal('fantasy'), worldId: z.literal('fantasy-v1'), tileId: z.number().int().nonnegative().optional() }).strict().optional(),
}).refine(body => !(body.earthCell !== undefined && body.landAddress !== undefined), { message: 'Choose exactly one land address' });
const WithdrawalIntentBody = z.object({
  amount: z.string().regex(/^\d+$/),
  destination: z.string().min(32).max(64),
  idempotencyKey: z.string().regex(WITHDRAWAL_IDEMPOTENCY_KEY_RE),
});
const withdrawalIntent = (
  body: z.infer<typeof WithdrawalIntentBody>, instant: boolean,
  network: NonNullable<AppDeps['withdrawalNetwork']>,
): WithdrawalRecentAuthIntent => {
  if (!network.keepMint) throw new HttpError(503, 'KEEP withdrawal network is not configured');
  const gross = BigInt(body.amount);
  const fee = (gross * BigInt(ECONOMY.withdrawFeeBps)) / 10_000n;
  return {
    version: 1,
    grossAmount: gross.toString(),
    feeBurned: fee.toString(),
    netAmount: (gross - fee).toString(),
    cluster: network.cluster,
    keepMint: network.keepMint,
    destination: body.destination,
    idempotencyKey: body.idempotencyKey,
    mode: instant ? 'instant' : 'standard',
    unbondingHours: instant ? 0 : ECONOMY.unbondingHours,
  };
};
const WithdrawalPrepareBody = WithdrawalIntentBody.extend({
  instant: z.boolean().optional(),
});
const WithdrawBody = WithdrawalIntentBody.extend({
  /** Instant (mature-authenticator-verified) withdrawal — skips unbonding. */
  instant: z.boolean().optional(),
  method: z.literal('totp').optional(),
  code: z.string().regex(/^\d{6,8}$/).optional(),
  authorization: z.object({
    challengeToken: z.string().min(32).max(4096),
    signature: z.string().min(80).max(100).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
  }),
});
const CodeBody = z.object({ code: z.string().regex(/^\d{6,8}$/) });
const RecoveryIdBody = z.object({ recoveryId: z.uuid() });
const RecoveryCodeBody = RecoveryIdBody.extend({ code: z.string().regex(/^\d{6,8}$/) });
// Step-up proof of an EXISTING factor, required to add/change a 2FA method when
// one is already verified (security review 2026-07-19 — enroll takeover).
const StepUpField = z.object({ method: z.enum(['totp', 'email']), code: z.string().regex(/^\d{6,8}$/) }).optional();
const StepUpBody = z.object({ stepUp: StepUpField });
const EmailBody = z.object({ email: z.string().min(3).max(254), stepUp: StepUpField });
/** GET /globe/sector/:id — the sector grid is 24 × 12 = 288 (GLOBE.sectorsLon ×
 *  sectorsLat), derived and never stored, so the valid range is a constant. */
const SectorParams = z.object({
  id: z.coerce.number().int().min(0).max(GLOBE.sectorsLon * GLOBE.sectorsLat - 1),
});
const ParcelParams = z.object({
  // Cell ids index the shared fine grid. Bound at the edge so a value outside
  // PostgreSQL INTEGER cannot turn an untrusted path into a database 500; an
  // in-range but unclaimed cell is still the detail function's generic 404.
  earthCell: z.coerce.number().int().min(0).max(GLOBE.fineCols * GLOBE.fineRows - 1),
});
const ViewportParcelsQuery = z.object({
  /** Accepted for the same selected-base URL compatibility as /globe. Public
   * viewport identity is viewer-independent, so it does not alter the query. */
  baseId: BaseId,
  /** Inclusive fine-grid columns (west→east). x0 > x1 crosses ±180°. */
  x0: z.coerce.number().int().min(0).max(GLOBE.fineCols - 1),
  x1: z.coerce.number().int().min(0).max(GLOBE.fineCols - 1),
  /** Inclusive fine-grid rows (north→south). */
  y0: z.coerce.number().int().min(0).max(GLOBE.fineRows - 1),
  y1: z.coerce.number().int().min(0).max(GLOBE.fineRows - 1),
  /** Where the viewer is looking, in degrees (D-097). The server ranks the rect's
   * bases by distance from here BEFORE the GLOBE.parcelViewportMaxMarkers cut, so
   * a dense window keeps the bases under the viewer's thumb rather than whichever
   * happen to sort first. Optional as a PAIR: absent, the rect's own centre is
   * used; one without the other is a client bug and answers 400. Need not lie
   * inside the rect — a tile fetched at the edge of the camera still ranks from
   * the camera. */
  cx: z.coerce.number().min(-180).max(180).optional(),
  cy: z.coerce.number().min(-90).max(90).optional(),
}).refine((rect) => {
  try {
    earthViewportCellRanges(rect);
    return true;
  } catch {
    return false;
  }
}, {
  message: `viewport must be ordered north-to-south and no larger than ${GLOBE.parcelViewportMaxSpanCells} cells per edge / ${GLOBE.parcelViewportMaxCells} cells total`,
}).refine((q) => (q.cx === undefined) === (q.cy === undefined), {
  message: 'cx and cy must be given together',
});
const MapQuery = z.object({
  baseId: BaseId,
  valleyId: z.string().uuid().optional(),
  /** Explicit narrow wire projection used by the globe deed band. */
  parcelBand: z.literal('1').optional(),
  x0: z.coerce.number().int().min(0).default(0),
  y0: z.coerce.number().int().min(0).default(0),
  x1: z.coerce.number().int().min(0).default(WORLD.gridCols - 1),
  y1: z.coerce.number().int().min(0).default(WORLD.gridRows - 1),
});

/**
 * Warn-and-CLAMP the requested viewport (MAP-SCALE-PLAN S7), never reject: a
 * client that has not shipped the rect yet still asks for the whole valley, and
 * 422-ing it would break the map for everyone mid-deploy. Clamping to the grid
 * also means an absurd rect costs the server nothing. The guard flips to a
 * rejection at L8, once telemetry shows no bare /map calls remain.
 */
function clampMapRect(
  q: z.infer<typeof MapQuery>, log: { warn(o: unknown, m: string): void },
): {
  baseId?: string | undefined; valleyId?: string | undefined;
  parcelBand?: boolean | undefined;
  x0: number; y0: number; x1: number; y1: number;
} {
  const x1 = Math.min(q.x1, WORLD.gridCols - 1);
  const y1 = Math.min(q.y1, WORLD.gridRows - 1);
  let x0 = Math.min(q.x0, x1);
  let y0 = Math.min(q.y0, y1);
  let w = x1 - x0 + 1;
  let h = y1 - y0 + 1;
  if (w * h > WORLD.mapChunkMaxTiles) {
    log.warn({ x0, y0, x1, y1, tiles: w * h }, 'map rect over mapChunkMaxTiles — clamped');
    w = Math.min(w, WORLD.mapChunkMaxTiles);
    h = Math.max(1, Math.floor(WORLD.mapChunkMaxTiles / w));
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  return {
    baseId: q.baseId, valleyId: q.valleyId,
    parcelBand: q.parcelBand === '1',
    x0, y0, x1: x0 + w - 1, y1: y0 + h - 1,
  };
}
