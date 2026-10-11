package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `GET /base`. The typed head serves the HUD; [raw] stays available for the scene mapper, which
 * reads server building rows against the render catalogue without a second network call. */
data class BaseSnapshot(
    val baseId: String?,
    val visualContext: VisualContext?,
    val player: PlayerSummary,
    val energy: Energy?,
    val armyStatus: ArmyStatus?,
    val claim: Claim?,
    val buildings: List<Building>,
    val obstacles: List<Obstacle>,
    val jobs: List<BaseJob>,
    val freeBuilders: Int,
    val raw: JsonObject,
    val plotVersion: Int? = null,
    val phaseEArt: PhaseEArtCapability? = null,
    val servicePresentation: BaseServicePresentation? = null,
    val serviceActivity: BaseServiceActivity? = null,
    val advancedServicePresentation: AdvancedServicePresentation? = null,
) {
    companion object {
        fun from(raw: JsonObject): BaseSnapshot {
            // Committed-read callbacks are never base state, even when malformed.
            val state = if (raw.containsKey("fleetJourneyEvents")) JsonObject(raw - "fleetJourneyEvents") else raw
            val head = state.decode<BaseHead>()
            val services = BaseServiceFacts.current(state)
            return BaseSnapshot(head.baseId, VisualContext.of(state), head.player, head.energy, head.armyStatus, head.claim,
                head.buildings, head.obstacles, head.jobs, head.freeBuilders, state, head.plotVersion,
                services.phaseEArt, services.presentation, services.activity, services.advancedPresentation)
        }
    }
}

@Serializable internal data class BaseHead(
    val plotVersion: Int? = null,
    val baseId: String? = null,
    val player: PlayerSummary,
    val energy: Energy? = null,
    val armyStatus: ArmyStatus? = null,
    val claim: Claim? = null,
    val buildings: List<Building> = emptyList(),
    val obstacles: List<Obstacle> = emptyList(),
    val jobs: List<BaseJob> = emptyList(),
    @Serializable(LenientIntSerializer::class) val freeBuilders: Int = 0,
)

@Serializable data class PlayerSummary(
    val wallet: String? = null,
    val name: String? = null,
    @Serializable(LenientIntSerializer::class) val keepLevel: Int,
    @Serializable(DecimalStringSerializer::class) val trophies: String? = null,
    val league: String? = null,
    @Serializable(LenientIntSerializer::class) val builders: Int? = null,
    @Serializable(LenientIntSerializer::class) val expansions: Int? = null,
)
@Serializable data class Energy(
    @Serializable(LenientIntSerializer::class) val used: Int,
    @Serializable(LenientIntSerializer::class) val free: Int? = null,
    @Serializable(LenientIntSerializer::class) val max: Int,
)
@Serializable data class ArmyStatus(
    @Serializable(LenientIntSerializer::class) val readyTroopCount: Int = 0,
    @Serializable(LenientIntSerializer::class) val readyPts: Int = 0,
    @Serializable(LenientIntSerializer::class) val campCapacityPts: Int = 0,
    @Serializable(LenientIntSerializer::class) val trainingTroopCount: Int = 0,
    /** Queued housing points and the base-wide Barracks queue capacity, as sent; an older server omits both. */
    @Serializable(LenientIntSerializer::class) val trainingPts: Int? = null,
    @Serializable(LenientIntSerializer::class) val barracksQueuePts: Int? = null,
    val nextReadyAt: String? = null,
    val allReadyAt: String? = null,
)
@Serializable data class Claim(@Serializable(LenientIntSerializer::class) val min: Int, @Serializable(LenientIntSerializer::class) val max: Int)
@Serializable data class Building(
    val id: String,
    val type: String,
    @Serializable(LenientIntSerializer::class) val level: Int,
    @Serializable(LenientIntSerializer::class) val tx: Int,
    @Serializable(LenientIntSerializer::class) val ty: Int,
    val underConstruction: Boolean = false,
    val trapSpentAt: String? = null,
)
@Serializable data class Obstacle(val id: String, val spriteKey: String? = null, @Serializable(LenientIntSerializer::class) val tx: Int, @Serializable(LenientIntSerializer::class) val ty: Int)
@Serializable data class BaseJob(
    val id: String,
    val kind: String,
    val buildingId: String? = null,
    val obstacleId: String? = null,
    val startedAt: String? = null,
    val finishesAt: String? = null,
    /** `"0"` marks the free onboarding finish (web: FINISH NOW · FREE). */
    @Serializable(DecimalStringSerializer::class) val finishCostKeep: String? = null,
    val canCancel: Boolean = false,
    @Serializable(DecimalStringSerializer::class) val refundShards: String? = null,
)

/** `GET /balances`: decimal strings only. */
@Serializable data class Balances(
    @Serializable(DecimalStringSerializer::class) val shards: String,
    @Serializable(DecimalStringSerializer::class) val keep: String,
    /** Absent on old servers and old saved snapshots; absence never activates Gems. */
    val gems: String? = null,
    val gemsRate: GemsRate? = null,
    val features: BalanceFeatures? = null,
) { companion object { fun from(raw: JsonObject): Balances = raw.decode<Balances>().also { it.gems?.let(::wholeGemsAmount) } } }

/** `GET /tutorial` (optional guidance; a missing route never blocks the base). */
@Serializable data class TutorialState(
    @Serializable(LenientIntSerializer::class) val step: Int,
    val completedAt: String? = null,
    val guideSkipped: Boolean = false,
    val onboarding: Quest? = null,
) {
    val completed: Boolean get() = completedAt != null
    companion object { fun from(raw: JsonObject): TutorialState = raw.decode() }
}

/** `GET /quests`. `day` is the server's daily-board key as sent (production sends a calendar date such as `"2026-09-11"`). */
@Serializable data class QuestBoard(
    @Serializable(DecimalStringSerializer::class) val day: String? = null,
    val quests: List<Quest> = emptyList(),
    @Serializable(DecimalStringSerializer::class) val allThreeBonus: String? = null,
) { companion object { fun from(raw: JsonObject): QuestBoard = raw.decode() } }

@Serializable data class Quest(
    val id: String? = null,
    val questId: String? = null,
    val scope: String? = null,
    val templateCode: String = "",
    @Serializable(DecimalStringSerializer::class) val target: String? = null,
    @Serializable(DecimalStringSerializer::class) val rewardShards: String? = null,
    @Serializable(DecimalStringSerializer::class) val rewardKeep: String? = null,
    @Serializable(DecimalStringSerializer::class) val progress: String? = null,
    val completed: Boolean = false,
    val claimed: Boolean = false,
) { val questIdentity: String? get() = id ?: questId }

/** `GET /mine/status`: aggregate per deed, never per physical mine. */
@Serializable data class MineStatus(val mining: Mining? = null, val cache: DailyCache? = null) {
    companion object { fun from(raw: JsonObject): MineStatus = raw.decode() }
}
@Serializable data class Mining(
    @Serializable(DecimalStringSerializer::class) val accrued: String = "0",
    @Serializable(DecimalStringSerializer::class) val storageCap: String = "0",
    @Serializable(DecimalStringSerializer::class) val ratePerHour: String = "0",
    @Serializable(LenientIntSerializer::class) val mineCount: Int = 0,
    @Serializable(LenientIntSerializer::class) val maxMines: Int = 0,
)
@Serializable data class DailyCache(
    val claimable: Boolean = false,
    @Serializable(DecimalStringSerializer::class) val cacheShards: String? = null,
    val nextClaimAt: String? = null,
    @Serializable(LenientIntSerializer::class) val streakDays: Int = 0,
    /** The lit day on the 7-day track (`getBaseMineStatus` currentDay); 0 before the first claim. */
    @Serializable(LenientIntSerializer::class) val currentDay: Int = 0,
)
/** `POST /mine/claim`: the paid cache and the streak it advanced to. */
@Serializable data class DailyCacheClaim(
    @Serializable(DecimalStringSerializer::class) val amount: String = "0",
    @Serializable(LenientIntSerializer::class) val streakDays: Int = 0,
    val everCompletedWeek1: Boolean = false,
) { companion object { fun from(raw: JsonObject): DailyCacheClaim = raw.decode() } }

/** `POST /mine/collect`. */
@Serializable data class CollectReceipt(@Serializable(DecimalStringSerializer::class) val amount: String = "0") {
    companion object { fun from(raw: JsonObject): CollectReceipt = raw.decode() }
}

/** Raid, replay, campaign-preview and scout payloads share this head; everything else stays raw for
 * the battle transport and the scene mapper. */
data class PresentationHead(val visualContext: VisualContext?, val simVersion: Int?, val raw: JsonObject) {
    val servicePresentation: BaseServicePresentation? = BaseServiceFacts.frozen(raw,
        if (raw.containsKey("snapshot")) raw["snapshot"] as? JsonObject else raw).presentation
    val advancedServicePresentation: AdvancedServicePresentation? =
        BaseServiceFacts.frozen(raw, raw["snapshot"] as? JsonObject).advancedPresentation
    companion object {
        fun from(raw: JsonObject): PresentationHead = PresentationHead(VisualContext.of(raw),
            (raw["simVersion"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull(), raw)
    }
}

/** Keeps an unknown-shaped server object addressable without re-parsing. */
fun JsonObject.child(key: String): JsonObject? = get(key) as? JsonObject
fun JsonObject.element(key: String): JsonElement? = get(key)

/** `GET /base/layouts` (apps/api/src/game/layouts.ts getBaseLayouts). Slot ids are the wire contract
 * (`HOME` | `FARM`, D-087); what a player reads goes through [gg.pixelkingdomwars.nativeclient.network.layoutSlotLabel] (D-099). */
@Serializable data class LayoutPosition(val buildingId: String, @Serializable(LenientIntSerializer::class) val tx: Int, @Serializable(LenientIntSerializer::class) val ty: Int)
@Serializable data class LayoutSlot(
    val slot: String,
    val locked: Boolean = false,
    val etag: String = "",
    val positions: List<LayoutPosition> = emptyList(),
    /** `empty` | `ready` | `needs_repair`: only a ready slot seeds the draft; the others start from the live base. */
    val compatibility: String = "empty",
    val unplacedBuildingIds: List<String> = emptyList(),
    val removedBuildingIds: List<String> = emptyList(),
)
@Serializable data class LayoutClaim(@Serializable(LenientIntSerializer::class) val min: Int, @Serializable(LenientIntSerializer::class) val max: Int, @Serializable(LenientIntSerializer::class) val size: Int)
@Serializable data class LayoutActive(val slot: String? = null, val etag: String = "")
@Serializable data class FarmUnlock(val locked: Boolean = true, @Serializable(DecimalStringSerializer::class) val costShards: String = "0")
@Serializable data class Layouts(
    val baseId: String,
    @Serializable(LenientIntSerializer::class) val geometryVersion: Int,
    val claim: LayoutClaim,
    val active: LayoutActive = LayoutActive(),
    val farmUnlock: FarmUnlock = FarmUnlock(),
    val slots: List<LayoutSlot> = emptyList(),
    val plotVersion: Int? = null,
) {
    fun slot(id: String): LayoutSlot? = slots.firstOrNull { it.slot == id }
    companion object { fun from(raw: JsonObject): Layouts = raw.decode() }
}
/** `PUT /base/layouts/:slot`. */
@Serializable data class LayoutSaveResult(
    val baseId: String,
    val slot: String,
    @Serializable(LenientIntSerializer::class) val geometryVersion: Int,
    val slotEtag: String,
    val activeEtag: String,
    val activeSlot: String? = null,
    @Serializable(LenientIntSerializer::class) val moved: Int = 0,
    @Serializable(LenientIntSerializer::class) val unchanged: Int = 0,
    val replayed: Boolean = false,
) { companion object { fun from(raw: JsonObject): LayoutSaveResult = raw.decode() } }
/** `POST /base/layouts/FARM/unlock`: `chargedShards` is `"0"` when the slot was already unlocked. */
@Serializable data class FarmUnlockResult(
    val baseId: String,
    val slot: String,
    val locked: Boolean,
    @Serializable(DecimalStringSerializer::class) val chargedShards: String,
    @Serializable(DecimalStringSerializer::class) val balanceShards: String,
) { companion object { fun from(raw: JsonObject): FarmUnlockResult = raw.decode() } }

/** `POST /base/walls/:id/upgrade-quote` (`packages/shared/src/wallConnect.ts` WallRowUpgradeQuote): one
 * frozen purchase for the row through the tapped wall. [raw] travels on the intent as the consented quote. */
@Serializable data class WallRowWall(
    val id: String,
    @Serializable(LenientIntSerializer::class) val tx: Int,
    @Serializable(LenientIntSerializer::class) val ty: Int,
    @Serializable(LenientIntSerializer::class) val level: Int,
    @Serializable(LenientIntSerializer::class) val targetLevel: Int? = null,
    @Serializable(DecimalStringSerializer::class) val costShards: String = "0",
    /** `max_level` | `keep_level` | `busy` | null: why this wall is left unchanged. */
    val excluded: String? = null,
)
@Serializable internal data class WallRowQuoteHead(
    val baseId: String? = null,
    val selectedWallId: String,
    val quoteId: String,
    @Serializable(LenientIntSerializer::class) val keepLevel: Int,
    val walls: List<WallRowWall> = emptyList(),
    @Serializable(DecimalStringSerializer::class) val totalCostShards: String,
    @Serializable(DecimalStringSerializer::class) val balanceShards: String,
    val canAfford: Boolean = false,
)
data class WallRowQuote(
    val baseId: String?, val selectedWallId: String, val quoteId: String, val keepLevel: Int, val walls: List<WallRowWall>,
    val totalCostShards: String, val balanceShards: String, val canAfford: Boolean, val raw: JsonObject,
) {
    val eligible: List<WallRowWall> get() = walls.filter { it.targetLevel != null }
    companion object {
        fun from(raw: JsonObject): WallRowQuote {
            val head = raw.decode<WallRowQuoteHead>()
            require(head.quoteId.matches(Regex("[a-f0-9]{64}"))) { "The wall row quote is malformed" }
            return WallRowQuote(head.baseId, head.selectedWallId, head.quoteId, head.keepLevel, head.walls, head.totalCostShards, head.balanceShards, head.canAfford, raw)
        }
    }
}
@Serializable data class WallRowUpgraded(val id: String, @Serializable(LenientIntSerializer::class) val level: Int)
/** `POST /base/walls/:id/upgrade-row`: `duplicate` marks the server's replay of an already-committed key. */
@Serializable data class WallRowResult(
    val upgraded: List<WallRowUpgraded> = emptyList(),
    @Serializable(DecimalStringSerializer::class) val costShards: String = "0",
    val duplicate: Boolean = false,
) { companion object { fun from(raw: JsonObject): WallRowResult = raw.decode() } }
