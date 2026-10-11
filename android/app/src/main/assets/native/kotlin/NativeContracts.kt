// GENERATED from client contract pack at 427381a2adf934bbcc902baefc207a655b185eb6; do not edit.
package gg.pixelkingdomwars.nativeclient.generated

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class VersionDto(
    val version: String,
    val gitSha: String,
    val builtAt: String?,
    val simVersion: Int,
)

@Serializable
data class AuthChallengeDto(
    val nonce: String,
    val message: String,
    val expiresAt: String,
)

@Serializable
data class LoginStatusDto(
    val loginRequired: Boolean,
    val wallet: String? = null,
    val expired: Boolean? = null,
)

@Serializable
data class AuthSessionDto(
    val wallet: String,
    val expiresAt: String? = null,
    val loginRequired: Boolean? = null,
    val entryPaid: Boolean? = null,
)

@Serializable
data class BuildingDto(
    val id: String,
    val type: String,
    val level: Int,
    val tx: Int,
    val ty: Int,
    val underConstruction: Boolean,
)

@Serializable
data class BaseVisualContextDto(
    val version: Int,
    val realmId: String,
    val artVersion: Int,
    val groundRevision: Int? = null,
)

@Serializable
data class BaseDto(
    val plotVersion: Int? = null,
    val baseId: String? = null,
    val visualContext: BaseVisualContextDto,
    val player: JsonElement,
    val claim: JsonElement,
    val buildings: List<BuildingDto>,
    val jobs: JsonElement,
    val army: JsonElement,
    val freeBuilders: Int,
    val obstacles: JsonElement? = null,
    val heroes: JsonElement? = null,
    val armyStatus: JsonElement? = null,
    val energy: JsonElement? = null,
    val shield: JsonElement? = null,
    val warzone: JsonElement? = null,
    val defences: JsonElement? = null,
)

@Serializable
data class FantasyTileDto(
    val worldId: String,
    val tileId: Int,
    val realmId: String,
    val allocation: String,
    val lon: Double,
    val lat: Double,
)

@Serializable
data class BaseSummaryDto(
    val id: String,
    val deedAssetId: String?,
    val status: String,
    val keepLevel: Int,
    val builders: Int,
    val expansions: Int,
    val landPaidAt: String?,
    val slot: Int?,
    val earthCell: Int?,
    val countryA3: String?,
    val fantasyLocation: FantasyTileDto?,
)

@Serializable
data class BasesDirectoryDto(
    val enabled: Boolean,
    val worldId: String,
    val maxActive: Int,
    val capabilities: JsonElement,
    val nextLandPurchaseKind: JsonElement? = null,
    val bases: List<BaseSummaryDto>,
)

@Serializable
data class TrainingCompositionItemDto(
    val troop: String,
    val count: Int,
)

@Serializable
data class ArmyQueueRowDto(
    val id: String,
    val troop: String,
    val startedAt: String,
    val finishesAt: String,
    val scheduleVersion: Int,
    val canCancel: Boolean,
    val refundShards: String?,
)

@Serializable
data class ArmyResearchRowDto(
    val troop: String,
    val toLevel: Int,
    val finishesAt: String,
    val episodeId: String?,
    val canCancel: Boolean,
    val refundShards: String?,
)

@Serializable
data class ArmyFeaturesDto(
    val trainingScheduling: JsonElement,
    val researchConsent: JsonElement,
    val darkAttackerRoster: JsonElement,
)

@Serializable
data class TrainingFreeFinishOfferDto(
    val offer: String,
    val consent: TrainingFinishAllConsentDto,
)

@Serializable
data class TrainingFreeFinishReceiptDto(
    val idempotencyKey: String,
    val baseId: String?,
    val consent: TrainingFinishAllConsentDto,
    val completed: List<TrainingCompositionItemDto>,
)

@Serializable
data class ArmyStateDto(
    val counts: JsonElement,
    val levels: JsonElement,
    val research: List<ArmyResearchRowDto>,
    val queue: List<ArmyQueueRowDto>,
    val rosterPts: Int,
    val queuedPts: Int,
    val campCapacityPts: Int,
    val barracksQueuePts: Int,
    val unsupportedTroops: List<String>,
    val eliteUnlocks: JsonElement,
    val finishAllQuote: TrainingFinishAllConsentDto,
    val features: ArmyFeaturesDto,
    val freeFinishAllOffer: TrainingFreeFinishOfferDto?,
    val freeFinishAllReceipt: TrainingFreeFinishReceiptDto?,
    val freeFinishAllReviewRequired: Boolean,
)

@Serializable
data class TrainingQuoteBodyDto(
    val composition: List<TrainingCompositionItemDto>,
    val baseId: String? = null,
)

@Serializable
data class TrainingQuoteRemainingDto(
    val troop: String,
    val count: Int,
    val reason: String,
)

@Serializable
data class TrainingCapacityDto(
    val used: Int,
    val capacity: Int,
    val after: Int,
)

@Serializable
data class TrainingScheduleDto(
    val version: Int,
    val mode: String,
    val serverNow: String,
    val startsAt: String,
    val finishesAt: String,
    val waitMs: Int,
    val durationMs: Int,
)

@Serializable
data class TrainingQuoteDto(
    val requested: List<TrainingCompositionItemDto>,
    val queueable: List<TrainingCompositionItemDto>,
    val remaining: List<TrainingQuoteRemainingDto>,
    val costShards: String,
    val availableShards: String,
    val camp: TrainingCapacityDto,
    val barracks: TrainingCapacityDto,
    val completionSec: Double,
    val consent: TrainingScheduleConsentDto,
    val schedule: TrainingScheduleDto,
)

@Serializable
data class TrainingBatchBodyDto(
    val composition: List<TrainingCompositionItemDto>,
    val confirmedCostShards: String,
    val idempotencyKey: String,
    val baseId: String? = null,
    val consent: TrainingScheduleConsentDto? = null,
)

@Serializable
data class TrainingBatchQueueItemDto(
    val id: String,
    val troop: String,
    val finishesAt: String,
)

@Serializable
data class TrainingBatchResultDto(
    val queue: List<TrainingBatchQueueItemDto>,
    val costShards: String,
    val replayed: Boolean,
)

@Serializable
data class TrainingSpeedupBodyDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val consent: TrainingFinishAllConsentDto? = null,
    val freeOffer: String? = null,
)

@Serializable
data class TrainingSpeedupResultDto(
    val cost: String,
    val completed: List<TrainingCompositionItemDto>,
)

@Serializable
data class ResearchStartBodyDto(
    val troop: String,
    val idempotencyKey: String,
    val baseId: String? = null,
    val consent: ResearchStartConsentDto? = null,
)

@Serializable
data class ResearchFinishBodyDto(
    val troop: String,
    val idempotencyKey: String,
    val baseId: String? = null,
    val consent: ResearchFinishConsentDto? = null,
)

@Serializable
data class ResearchCancelBodyDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val consent: ResearchEpisodeConsentDto? = null,
)

@Serializable
data class HeroFeaturesDto(
    val heroConsent: JsonElement,
    val heroReceipts: JsonElement,
)

@Serializable
data class HeroesStateDto(
    val heroes: List<JsonElement>,
    val keepBalance: String,
    val keepLevel: Int,
    val features: HeroFeaturesDto? = null,
)

@Serializable
data class HeroUpgradeBodyDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val consent: HeroUpgradeConsentDto? = null,
)

@Serializable
data class HeroRecoveryBodyDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val consent: HeroRecoveryConsentDto? = null,
)

@Serializable
data class RaidCreatedDto(
    val id: String,
    val defenderWallet: String? = null,
    val attackerBaseId: String? = null,
    val defenderBaseId: String? = null,
    val campaignStage: Int? = null,
    val snapshot: JsonElement,
    val visualContext: BaseVisualContextDto,
    val armySnapshot: JsonElement,
    val ordersDeadlineAt: String,
    val seed: Long,
    val simVersion: Int,
    val raidProtocolVersion: Int? = null,
)

@Serializable
data class RaidCreatedEnvelopeDto(
    val raid: RaidCreatedDto,
)

@Serializable
data class PendingRaidResumeDto(
    val id: String,
    val defenderWallet: String? = null,
    val attackerBaseId: String? = null,
    val defenderBaseId: String? = null,
    val pveCampId: JsonElement? = null,
    val campaignStage: Int? = null,
    val snapshot: JsonElement,
    val visualContext: BaseVisualContextDto,
    val armySnapshot: JsonElement,
    val ordersDeadlineAt: String,
    val seed: Long,
    val simVersion: Int,
    val heroReserved: Boolean,
    val raidProtocolVersion: Int? = null,
    val live: JsonElement? = null,
)

@Serializable
data class PendingRaidResumesDto(
    val raids: List<PendingRaidResumeDto>,
)

@Serializable
data class PendingRaidResumeEnvelopeDto(
    val raid: PendingRaidResumeDto,
)

@Serializable
data class BattleReplayDto(
    val id: String,
    val snapshot: JsonElement,
    val visualContext: BaseVisualContextDto,
    val orders: JsonElement? = null,
    val seed: Long,
    val simVersion: Int,
    val events: JsonElement,
    val result: JsonElement? = null,
    val armySnapshot: JsonElement,
    val buildingHealth: JsonElement? = null,
)

@Serializable
data class CampaignPreviewDto(
    val stage: Int,
    val snapshot: JsonElement,
    val visualContext: BaseVisualContextDto,
)

@Serializable
data class FantasyRealmCountDto(
    val realmId: String,
    val total: Int,
    val occupied: Int,
    val held: Int,
    val available: Int,
    val anchorTileId: Int?,
)

@Serializable
data class FantasyOwnedTileDto(
    val baseId: String,
    val tileId: Int,
    val realmId: String,
    val name: String?,
    val avatarUrl: String?,
    val keepLevel: Int,
    val active: Boolean,
    val selected: Boolean,
)

@Serializable
data class FantasyGlobeMeDto(
    val baseId: String?,
    val selectedTileId: Int?,
    val ownedTiles: List<FantasyOwnedTileDto>,
)

@Serializable
data class FantasyGlobeDto(
    val worldId: String,
    val catalogHash: String,
    val ready: Boolean,
    val warzone: JsonElement,
    val realms: List<FantasyRealmCountDto>,
    val me: FantasyGlobeMeDto,
)

@Serializable
data class FantasySearchResultDto(
    val tileId: Int,
    val realmId: String,
    val name: String?,
    val avatarUrl: String?,
    val keepLevel: Int,
    val trophies: Int,
    val seeker: Boolean,
)

@Serializable
data class FantasySearchDto(
    val results: List<FantasySearchResultDto>,
)

@Serializable
data class FantasyMarkerDto(
    val tileId: Int,
    val name: String?,
    val avatarUrl: String?,
    val keepLevel: Int,
)

@Serializable
data class FantasyViewportDto(
    val worldId: String,
    val scope: JsonElement,
    val matched: Int,
    val truncated: Boolean,
    val markers: List<FantasyMarkerDto>,
)

@Serializable
data class FantasyParcelDto(
    val worldId: String,
    val tile: FantasyTileDto,
    val availability: String,
    val detail: JsonElement?,
)

@Serializable
data class PlaytestAccessDto(
    val open: Boolean,
    val playUrl: String,
)

@Serializable
data class NativeClockDto(
    val protocolVersion: Int,
    val revision: Long,
    val rate: Int,
    val anchorWallAt: String?,
    val anchorSimMs: Long,
    val serverNow: String,
    val simNowMs: Long,
    val battleEndsAt: String?,
    val durationMs: Long,
)

@Serializable
data class NativeCommandDto(
    val sequence: Long,
    val clientCommandId: String,
    val kind: String,
    val payload: JsonElement,
    val serverOffsetMs: Long,
    val acceptedAt: String,
)

@Serializable
data class NativePresentationDto(
    val protocolVersion: Int,
    val raidId: String,
    val revision: String,
    val source: String,
    val status: String,
    val simVersion: Long,
    val raidProtocolVersion: Long?,
    val clock: NativeClockDto?,
    val lastSequence: Long,
    val snapshot: JsonElement,
    val armySnapshot: JsonElement,
    val orders: JsonElement? = null,
    val visualContext: JsonElement? = null,
    val servicePresentation: JsonElement? = null,
    val advancedServicePresentation: JsonElement? = null,
    val buildingHealth: List<JsonElement>? = null,
    val commands: List<NativeCommandDto>,
    val events: List<JsonElement>,
    val result: JsonElement?,
    val replaceFromTick: Int,
)

@Serializable
data class NativePresentationStateDto(
    val source: String,
    val status: String,
    val simVersion: Long,
    val raidProtocolVersion: Long?,
    val clock: NativeClockDto?,
    val lastSequence: Long,
    val snapshot: JsonElement,
    val armySnapshot: JsonElement,
    val orders: JsonElement? = null,
    val visualContext: JsonElement? = null,
    val servicePresentation: JsonElement? = null,
    val advancedServicePresentation: JsonElement? = null,
    val buildingHealth: List<JsonElement>? = null,
    val commands: List<NativeCommandDto>,
    val result: JsonElement?,
)

@Serializable
data class NativePresentationPageDto(
    val protocolVersion: Int,
    val raidId: String,
    val revision: String,
    val parentRevision: String?,
    val replaceFromTick: Long,
    val generation: String,
    val eventOffset: Long,
    val totalEvents: Int,
    val commandOffset: Long,
    val totalCommands: Int,
    val commands: List<NativeCommandDto>,
    val events: List<JsonElement>,
    val nextCursor: String?,
    val state: NativePresentationStateDto?,
)

@Serializable
data class NativeCapabilitiesDto(
    val protocolVersion: Int,
    val sourceCommit: String,
    val simVersion: Long,
    val minimumVersionCode: Long,
    val contentManifestUrl: String?,
    val phaseEArt: JsonElement? = null,
    val presentation: JsonElement,
    val notifications: JsonElement,
    val economy: JsonElement,
    val update: JsonElement? = null,
    val worldV2: JsonElement? = null,
)

@Serializable
data class TrainingReceiptQueryDto(
    val idempotencyKey: String,
)

@Serializable
data class TrainingCloseBodyDto(
    val idempotencyKey: String,
    val confirmed: Boolean,
)

@Serializable
data class TrainingCancellationPathDto(
    val queueId: String,
)

@Serializable
data class TrainingCancellationBodyDto(
    val idempotencyKey: String,
    val baseId: String? = null,
)

@Serializable
data class TrainingCancellationResultDto(
    val id: String,
    val troop: String,
    val refundShards: String,
    val cancelledAt: String,
    val replayed: Boolean,
)

@Serializable
data class TrainingCancellationReceiptQueryDto(
    val idempotencyKey: String,
    val baseId: String? = null,
)

@Serializable
data class TrainingScheduleConsentDto(
    val version: Int,
    val queue: List<TrainingQueueConsentRowDto>,
    val unitDurations: List<TrainingScheduleConsentUnitDurationsItemDto>,
)

@Serializable
data class TrainingFinishAllConsentDto(
    val version: Int,
    val queue: List<TrainingQueueConsentRowDto>,
    val maxCostKeep: String,
)

@Serializable
data class ResearchStartConsentDto(
    val currentLevel: Int,
    val maxCostShards: String,
)

@Serializable
data class ResearchEpisodeConsentDto(
    val currentLevel: Int,
    val toLevel: Int,
    val finishesAt: String,
    val episodeId: String?,
)

@Serializable
data class ResearchFinishConsentDto(
    val currentLevel: Int,
    val toLevel: Int,
    val finishesAt: String,
    val episodeId: String?,
    val maxCostKeep: String,
)

@Serializable
data class HeroUpgradeConsentDto(
    val expectedLevel: Int,
    val maxCostKeep: String,
)

@Serializable
data class HeroRecoveryConsentDto(
    val recoveryUntil: String,
    val maxCostKeep: String,
)

@Serializable
data class HeroUpgradeReceiptQueryDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val expectedLevel: Double,
    val maxCostKeep: String,
)

@Serializable
data class HeroRecoveryReceiptQueryDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val recoveryUntil: String,
    val maxCostKeep: String,
)

@Serializable
data class WithdrawalReceiptQueryDto(
    val idempotencyKey: String,
    val grossAmount: String,
    val feeBurned: String,
    val netAmount: String,
    val destination: String,
    val mode: String,
    val cluster: String,
    val keepMint: String,
)

@Serializable
data class ConversionReceiptQueryDto(
    val idempotencyKey: String,
    val keep: String,
    val baseId: String? = null,
)

@Serializable
data class ForgeContributionReceiptQueryDto(
    val idempotencyKey: String,
    val shards: String,
    val baseId: String? = null,
)

@Serializable
data class TrainingRecoveryUnknownDto(
    val version: Int,
    val idempotencyKey: String,
    val status: String,
)

@Serializable
data class TrainingRecoveryClosedDto(
    val version: Int,
    val idempotencyKey: String,
    val status: String,
    val closedAt: String,
)

@Serializable
data class TrainingRecoveryAcceptedDto(
    val version: Int,
    val idempotencyKey: String,
    val status: String,
    val baseId: String?,
    val acceptedAt: String,
    val request: TrainingRecoveryAcceptedRequestDto,
    val result: TrainingRecoveryAcceptedResultDto,
)

@Serializable
data class TrainingRecoveryAcceptedRequestDto(
    val composition: List<TrainingRecoveryAcceptedRequestCompositionItemDto>,
    val confirmedCostShards: String,
)

@Serializable
data class TrainingRecoveryAcceptedRequestCompositionItemDto(
    val troop: String,
    val count: Long,
)

@Serializable
data class TrainingRecoveryAcceptedResultDto(
    val queue: List<TrainingRecoveryAcceptedResultQueueItemDto>,
    val costShards: String,
    val replayed: Boolean,
)

@Serializable
data class TrainingRecoveryAcceptedResultQueueItemDto(
    val id: String,
    val troop: String,
    val finishesAt: String,
)

@Serializable
data class ConstructionReceiptUnknownDto(
    val version: Int,
    val status: String,
    val idempotencyKey: String,
)

@Serializable
data class ConstructionReceiptAcceptedDto(
    val version: Int,
    val status: String,
    val request: ConstructionReceiptAcceptedRequestDto,
    val baseId: String?,
    val receiptId: String,
    val acceptedAt: String,
    val funding: ConstructionReceiptAcceptedFundingDto,
    val minePurchase: ConstructionReceiptAcceptedMinePurchaseDto? = null,
)

@Serializable
data class ConstructionReceiptAcceptedRequestDto(
    val idempotencyKey: String,
    val type: String,
    val tx: Int,
    val ty: Int,
    val baseId: String? = null,
)

@Serializable
data class ConstructionReceiptAcceptedFundingDto(
    val currency: String,
    val amount: String,
)

@Serializable
data class ConstructionReceiptAcceptedMinePurchaseDto(
    val version: Int,
    val wallet: String,
    val request: ConstructionReceiptAcceptedMinePurchaseRequestDto,
    val receiptId: String,
    val acceptedAt: String,
    val funding: ConstructionReceiptAcceptedMinePurchaseFundingDto,
)

@Serializable
data class ConstructionReceiptAcceptedMinePurchaseRequestDto(
    val type: String,
    val tx: Int,
    val ty: Int,
    val baseId: String?,
    val idempotencyKey: String,
    val expectedCurrency: String,
    val mineConsent: ConstructionReceiptAcceptedMinePurchaseRequestMineConsentDto,
)

@Serializable
data class ConstructionReceiptAcceptedMinePurchaseRequestMineConsentDto(
    val version: Int,
    val mineIndex: Long,
    val maxCostKeep: String,
)

@Serializable
data class ConstructionReceiptAcceptedMinePurchaseFundingDto(
    val currency: String,
    val amount: String,
)

@Serializable
data class TrainingCancellationReceiptUnknownDto(
    val version: Int,
    val queueId: String,
    val idempotencyKey: String,
    val baseId: String?,
    val status: String,
)

@Serializable
data class TrainingCancellationReceiptAcceptedDto(
    val version: Int,
    val queueId: String,
    val idempotencyKey: String,
    val baseId: String?,
    val status: String,
    val result: TrainingCancellationReceiptAcceptedResultDto,
)

@Serializable
data class TrainingCancellationReceiptAcceptedResultDto(
    val id: String,
    val troop: String,
    val refundShards: String,
    val cancelledAt: String,
    val replayed: Boolean,
)

@Serializable
data class HeroUpgradeReceiptUnknownDto(
    val version: Int,
    val status: String,
    val idempotencyKey: String,
)

@Serializable
data class HeroUpgradeReceiptAcceptedDto(
    val version: Int,
    val status: String,
    val wallet: String,
    val baseId: String?,
    val receiptId: String,
    val acceptedAt: String,
    val funding: HeroUpgradeReceiptAcceptedFundingDto,
    val request: HeroUpgradeReceiptAcceptedRequestDto,
    val result: HeroUpgradeReceiptAcceptedResultDto,
)

@Serializable
data class HeroUpgradeReceiptAcceptedFundingDto(
    val currency: String,
    val amount: String,
)

@Serializable
data class HeroUpgradeReceiptAcceptedRequestDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val hero: String,
    val expectedLevel: Int,
    val maxCostKeep: String,
)

@Serializable
data class HeroUpgradeReceiptAcceptedResultDto(
    val fromLevel: Int,
    val toLevel: Int,
)

@Serializable
data class HeroRecoveryReceiptAcceptedDto(
    val version: Int,
    val status: String,
    val wallet: String,
    val baseId: String?,
    val receiptId: String,
    val acceptedAt: String,
    val funding: HeroUpgradeReceiptAcceptedFundingDto,
    val request: HeroRecoveryReceiptAcceptedRequestDto,
    val result: HeroRecoveryReceiptAcceptedResultDto,
)

@Serializable
data class HeroRecoveryReceiptAcceptedRequestDto(
    val idempotencyKey: String,
    val baseId: String? = null,
    val hero: String,
    val recoveryUntil: String,
    val maxCostKeep: String,
)

@Serializable
data class HeroRecoveryReceiptAcceptedResultDto(
    val recoveryUntil: String,
)

@Serializable
data class WithdrawalReceiptUnknownDto(
    val version: Int,
    val status: String,
    val idempotencyKey: String,
)

@Serializable
data class WithdrawalReceiptAcceptedDto(
    val version: Int,
    val status: String,
    val wallet: String,
    val request: WithdrawalReceiptQueryDto,
    val receiptId: String,
    val acceptedAt: String,
    val funding: WithdrawalReceiptAcceptedFundingDto,
    val result: WithdrawalReceiptAcceptedResultDto,
)

@Serializable
data class WithdrawalReceiptAcceptedFundingDto(
    val currency: String,
    val amount: String,
)

@Serializable
data class WithdrawalReceiptAcceptedResultDto(
    val withdrawalId: String,
    val unbondsAt: String,
)

@Serializable
data class ConversionReceiptUnknownDto(
    val version: Int,
    val status: String,
    val idempotencyKey: String,
)

@Serializable
data class ConversionReceiptAcceptedDto(
    val version: Int,
    val status: String,
    val wallet: String,
    val baseId: String?,
    val request: ConversionReceiptQueryDto,
    val receiptId: String,
    val acceptedAt: String,
    val funding: ConversionReceiptAcceptedFundingDto,
    val result: ConversionReceiptAcceptedResultDto,
)

@Serializable
data class ConversionReceiptAcceptedFundingDto(
    val currency: String,
    val amount: String,
)

@Serializable
data class ConversionReceiptAcceptedResultDto(
    val converted: String,
    val shards: String,
    val rate: Long,
)

@Serializable
data class ForgeContributionReceiptUnknownDto(
    val version: Int,
    val status: String,
    val idempotencyKey: String,
)

@Serializable
data class ForgeContributionReceiptAcceptedDto(
    val version: Int,
    val status: String,
    val wallet: String,
    val baseId: String?,
    val request: ForgeContributionReceiptQueryDto,
    val receiptId: String,
    val acceptedAt: String,
    val funding: ForgeContributionReceiptAcceptedFundingDto,
    val result: ForgeContributionReceiptAcceptedResultDto,
)

@Serializable
data class ForgeContributionReceiptAcceptedFundingDto(
    val currency: String,
    val amount: String,
)

@Serializable
data class ForgeContributionReceiptAcceptedResultDto(
    val day: String,
    val contributedShards: String,
)

@Serializable
data class TrainingQueueConsentRowDto(
    val id: String,
    val startedAt: String,
    val finishesAt: String,
)

@Serializable
data class TrainingScheduleConsentUnitDurationsItemDto(
    val troop: String,
    val durationMs: Long,
)
