package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `GET /army` after training schedule v2 (D-114) and the free first FINISH ALL (D-121). */
data class ArmyState(
    val counts: Map<String, Int>,
    val levels: Map<String, Int>,
    val research: List<ResearchRow>,
    val queue: List<TrainingQueueRow>,
    val rosterPts: Int,
    val queuedPts: Int,
    val campCapacityPts: Int,
    val barracksQueuePts: Int,
    val eliteUnlocks: Map<String, Boolean>,
    val finishAllQuote: FinishAllConsent?,
    val features: ArmyFeatures?,
    val freeFinishAllOffer: FreeFinishOffer?,
    val freeFinishAllReceipt: JsonElement?,
    val freeFinishAllReviewRequired: Boolean,
    val raw: JsonObject,
) {
    val trainingScheduling: TrainingSchedulingFeature? get() = features?.trainingScheduling
    companion object {
        fun from(raw: JsonObject): ArmyState {
            val head = raw.decode<ArmyHead>()
            return ArmyState(head.counts, head.levels, head.research, head.queue, head.rosterPts, head.queuedPts, head.campCapacityPts,
                head.barracksQueuePts, head.eliteUnlocks, head.finishAllQuote, head.features, head.freeFinishAllOffer,
                head.freeFinishAllReceipt, head.freeFinishAllReviewRequired, raw)
        }
    }
}

@Serializable internal data class ArmyHead(
    val counts: Map<String, @Serializable(LenientIntSerializer::class) Int> = emptyMap(),
    val levels: Map<String, @Serializable(LenientIntSerializer::class) Int> = emptyMap(),
    val research: List<ResearchRow> = emptyList(),
    val queue: List<TrainingQueueRow> = emptyList(),
    @Serializable(LenientIntSerializer::class) val rosterPts: Int = 0,
    @Serializable(LenientIntSerializer::class) val queuedPts: Int = 0,
    @Serializable(LenientIntSerializer::class) val campCapacityPts: Int = 0,
    @Serializable(LenientIntSerializer::class) val barracksQueuePts: Int = 0,
    val eliteUnlocks: Map<String, Boolean> = emptyMap(),
    val finishAllQuote: FinishAllConsent? = null,
    val features: ArmyFeatures? = null,
    val freeFinishAllOffer: FreeFinishOffer? = null,
    val freeFinishAllReceipt: JsonElement? = null,
    val freeFinishAllReviewRequired: Boolean = false,
)

@Serializable data class TrainingQueueRow(
    val id: String,
    val troop: String,
    val startedAt: String? = null,
    val finishesAt: String? = null,
    @Serializable(LenientIntSerializer::class) val scheduleVersion: Int? = null,
    val canCancel: Boolean = false,
    @Serializable(DecimalStringSerializer::class) val refundShards: String? = null,
)

@Serializable data class ResearchRow(
    val troop: String,
    @Serializable(LenientIntSerializer::class) val toLevel: Int? = null,
    val finishesAt: String? = null,
    val episodeId: JsonElement? = null,
    val canCancel: Boolean = false,
    @Serializable(DecimalStringSerializer::class) val refundShards: String? = null,
    val finishQuote: JsonElement? = null,
)

@Serializable data class ArmyFeatures(
    val trainingScheduling: TrainingSchedulingFeature? = null,
    val researchConsent: JsonElement? = null,
    val researchSpeedupReceipts: JsonElement? = null,
    val darkAttackerRoster: JsonElement? = null,
    val trainingFinishReceipts: JsonElement? = null,
)
@Serializable data class TrainingSchedulingFeature(
    @Serializable(LenientIntSerializer::class) val version: Int,
    val mode: String,
    @Serializable(LenientIntSerializer::class) val lanes: Int,
    val consentRequired: Boolean,
)

/** Server-frozen queue rows the finish price was computed against; sent back verbatim as consent. */
@Serializable data class QueueConsentRow(val id: String, val startedAt: String, val finishesAt: String)
@Serializable data class FinishAllConsent(
    @Serializable(LenientIntSerializer::class) val version: Int,
    val queue: List<QueueConsentRow> = emptyList(),
    @Serializable(DecimalStringSerializer::class) val maxCostKeep: String,
)
@Serializable data class FreeFinishOffer(val offer: String, val consent: FinishAllConsent)

/** `POST /army/training/quote`. [consent] and [schedule] are forwarded verbatim (never rebuilt). */
data class TrainingQuote(
    val requested: List<TroopCount>,
    val queueable: List<TroopCount>,
    val remaining: List<RemainingTroop>,
    val costShards: String,
    val consent: JsonObject?,
    val schedule: TrainingScheduleWindow?,
    val raw: JsonObject,
    val availableShards: String? = null,
    val camp: TrainingCapacity? = null,
    val barracks: TrainingCapacity? = null,
    /** Server estimate in whole seconds (web REVIEW TRAINING "ALL READY IN"); exact text as sent. */
    val completionSec: String? = null,
) {
    val unitCount: Int get() = queueable.sumOf { it.count }
    companion object {
        fun from(raw: JsonObject): TrainingQuote {
            val head = raw.decode<QuoteHead>()
            return TrainingQuote(head.requested, head.queueable, head.remaining, head.costShards, raw["consent"] as? JsonObject, head.schedule, raw,
                head.availableShards, head.camp, head.barracks, head.completionSec)
        }
    }
}
@Serializable internal data class QuoteHead(
    val requested: List<TroopCount> = emptyList(),
    val queueable: List<TroopCount> = emptyList(),
    val remaining: List<RemainingTroop> = emptyList(),
    @Serializable(DecimalStringSerializer::class) val costShards: String,
    val schedule: TrainingScheduleWindow? = null,
    @Serializable(DecimalStringSerializer::class) val availableShards: String? = null,
    val camp: TrainingCapacity? = null,
    val barracks: TrainingCapacity? = null,
    @Serializable(DecimalStringSerializer::class) val completionSec: String? = null,
)
/** `{used, capacity, after}` points for the camp and the barracks queue in a quote. */
@Serializable data class TrainingCapacity(
    @Serializable(LenientIntSerializer::class) val used: Int,
    @Serializable(LenientIntSerializer::class) val capacity: Int,
    @Serializable(LenientIntSerializer::class) val after: Int,
)

/** `GET /army/presets` → `{presets}`; `PUT /army/presets/:slot {name, composition}`; `DELETE /army/presets/:slot`
 * (apps/api/src/game/armyPresets.ts). Wallet-owned plans, never purchases: every use is re-quoted. */
@Serializable data class TrainingPreset(@Serializable(LenientIntSerializer::class) val slot: Int, val name: String, val composition: List<TroopCount> = emptyList()) {
    companion object { fun from(raw: JsonObject): TrainingPreset = raw.decode() }
}
@Serializable data class TrainingPresetList(val presets: List<TrainingPreset> = emptyList()) {
    companion object { fun from(raw: JsonObject): TrainingPresetList = raw.decode() }
}
/** `GET /army/previous?baseId`: the deployed troops of the last resolved attack on this base, or a message. */
@Serializable data class PreviousArmy(val raidId: String? = null, val composition: List<TroopCount> = emptyList(), val message: String? = null) {
    companion object { fun from(raw: JsonObject): PreviousArmy = raw.decode() }
}
@Serializable data class TroopCount(val troop: String, @Serializable(LenientIntSerializer::class) val count: Int)
@Serializable data class RemainingTroop(val troop: String, @Serializable(LenientIntSerializer::class) val count: Int, val reason: String? = null)
@Serializable data class TrainingScheduleWindow(
    @Serializable(LenientIntSerializer::class) val version: Int,
    val mode: String,
    val serverNow: String,
    val startsAt: String,
    val finishesAt: String,
    val waitMs: Long,
    val durationMs: Long,
)

/** `GET /heroes` (apps/api/src/game/heroes.ts `HeroView`): every number rendered by the roster comes from
 * here — level, stats, prices and even `affordable` — so a button can never offer a price the server refuses. */
@Serializable data class HeroRoster(
    val heroes: List<Hero> = emptyList(),
    @Serializable(DecimalStringSerializer::class) val keepBalance: String? = null,
    @Serializable(LenientIntSerializer::class) val keepLevel: Int? = null,
    val features: JsonObject? = null,
) {
    // Exact JSON generation: missing, string or future versions cannot promise consent enforcement.
    val heroConsentSupported: Boolean get() = (features?.get("heroConsent") as? JsonObject)?.get("version") == kotlinx.serialization.json.JsonPrimitive(1)
    companion object { fun from(raw: JsonObject): HeroRoster = raw.decode() }
}
@Serializable data class Hero(
    val hero: String,
    val name: String,
    val title: String? = null,
    val altar: String? = null,
    @Serializable(LenientIntSerializer::class) val unlockKeepLevel: Int? = null,
    @Serializable(DecimalStringSerializer::class) val recruitCostKeep: String? = null,
    val recruitItemId: String? = null,
    val recruited: Boolean = false,
    @Serializable(LenientIntSerializer::class) val level: Int? = null,
    @Serializable(LenientIntSerializer::class) val tier: Int? = null,
    val tierName: String? = null,
    @Serializable(DecimalStringSerializer::class) val hp: String? = null,
    @Serializable(DecimalStringSerializer::class) val dps: String? = null,
    val recoveryUntil: String? = null,
    val available: Boolean = true,
    /** D-059 gear-modified stats with the server's delta; null while combat rollout is dark or nothing is equipped. */
    val gear: HeroGear? = null,
    /** Exact server-priced KEEP finish for a currently recovering hero. */
    val recoveryFinishNow: HeroRecoveryFinish? = null,
    @Serializable(LenientIntSerializer::class) val maxLevel: Int? = null,
    val next: HeroNext? = null,
    val affordable: Boolean = false,
)
@Serializable data class HeroNext(
    @Serializable(LenientIntSerializer::class) val level: Int,
    @Serializable(LenientIntSerializer::class) val tier: Int? = null,
    val tierName: String? = null,
    @Serializable(DecimalStringSerializer::class) val hp: String? = null,
    @Serializable(DecimalStringSerializer::class) val dps: String? = null,
    @Serializable(DecimalStringSerializer::class) val costKeep: String? = null,
)
@Serializable data class HeroGear(
    @Serializable(DecimalStringSerializer::class) val hp: String,
    @Serializable(DecimalStringSerializer::class) val dps: String,
    @Serializable(DecimalStringSerializer::class) val hpBonus: String,
    @Serializable(DecimalStringSerializer::class) val dpsBonus: String,
)
@Serializable data class HeroRecoveryFinish(
    @Serializable(LenientIntSerializer::class) val remainingSec: Int,
    @Serializable(DecimalStringSerializer::class) val costKeep: String,
    val affordable: Boolean = false,
)

/** `POST /heroes/:hero/upgrade` → `{hero, level, tier, tierName, hp, dps, spentKeep, duplicate}`. */
@Serializable data class HeroUpgradeResult(
    val hero: String,
    @Serializable(LenientIntSerializer::class) val level: Int,
    val tierName: String? = null,
    @Serializable(DecimalStringSerializer::class) val spentKeep: String = "0",
    val duplicate: Boolean = false,
) { companion object { fun from(raw: JsonObject): HeroUpgradeResult = raw.decode() } }

/** `GET /items` (apps/api/src/game/items.ts `getItems`): the catalogue for the shop, what this deed owns,
 * discovery (NEW markers), capacity by weight, the hero loadouts and the read-only deeds. */
@Serializable data class Inventory(
    @Serializable(LenientIntSerializer::class) val catalogRevision: Int? = null,
    val heroGearCombatEnabled: Boolean = false,
    val catalog: List<ItemDefinition> = emptyList(),
    val owned: List<OwnedItem> = emptyList(),
    val discovery: List<ItemDiscovery> = emptyList(),
    val capacity: ItemCapacity? = null,
    val heroLoadouts: List<HeroLoadout> = emptyList(),
    val deeds: List<DeedItem> = emptyList(),
    /** `features.itemPurchase` (night/server 231e6cff9 ITEM_PURCHASE_FEATURE): the server records a consented purchase so its
     * keyed receipt can answer for it. Absent on older servers. */
    val features: JsonObject? = null,
) {
    val itemPurchaseReceipts: Boolean get() = (features?.get("itemPurchase") as? JsonObject)?.let {
        it["version"] == kotlinx.serialization.json.JsonPrimitive(1) && it["receipts"] == kotlinx.serialization.json.JsonPrimitive(1)
    } == true
    fun item(id: String): ItemDefinition? = catalog.firstOrNull { it.id == id }
    fun quantity(id: String): Int = owned.firstOrNull { it.itemId == id }?.quantity ?: 0
    /** Copies worn by any hero; stored (bag) copies are `quantity − equippedCount`. */
    fun equippedCount(id: String): Int = heroLoadouts.sumOf { loadout -> loadout.equipment.values.count { it == id } }
    fun stored(id: String): Int = (quantity(id) - equippedCount(id)).coerceAtLeast(0)
    fun seen(id: String): Boolean = discovery.any { it.itemId == id }
    fun loadout(hero: String): HeroLoadout? = heroLoadouts.firstOrNull { it.hero == hero }
    companion object { fun from(raw: JsonObject): Inventory = raw.decode() }
}
@Serializable data class ItemDefinition(
    val id: String,
    val name: String? = null,
    val kind: String? = null,
    val slot: String? = null,
    val desc: String? = null,
    val description: String? = null,
    val rarity: String? = null,
    @Serializable(LenientIntSerializer::class) val weight: Int = 0,
    @Serializable(DecimalStringSerializer::class) val costKeep: String? = null,
    val asset: String? = null,
    val acquisition: ItemAcquisition? = null,
    @Serializable(LenientIntSerializer::class) val maxOwned: Int? = null,
    val activation: ItemActivation? = null,
    val dropOnly: Boolean = false,
    val modifiers: List<GearModifier> = emptyList(),
) { val text: String get() = desc ?: description.orEmpty() }
@Serializable data class ItemAcquisition(val type: String, @Serializable(LenientIntSerializer::class) val keepLevel: Int? = null,
                                         @Serializable(LenientIntSerializer::class) val stage: Int? = null, val requiresMaxHero: Boolean = false)
/** An unused tradable contract/writ and its activated benefit are different state (D-058/D-110). */
@Serializable data class ItemActivation(val kind: String, val active: Boolean = false, @Serializable(LenientIntSerializer::class) val availableContracts: Int? = null)
@Serializable data class GearModifier(val stat: String, @Serializable(LenientIntSerializer::class) val value: Int)
@Serializable data class OwnedItem(val itemId: String, @Serializable(DecimalStringSerializer::class) val qty: String = "0", val seen: Boolean = true) {
    val quantity: Int get() = qty.toIntOrNull() ?: 0
}
@Serializable data class ItemDiscovery(val itemId: String, val seenAt: String? = null)
@Serializable data class ItemCapacity(@Serializable(LenientIntSerializer::class) val used: Int, @Serializable(LenientIntSerializer::class) val max: Int, val overflow: Boolean = false)
@Serializable data class HeroLoadout(
    val hero: String,
    val recruited: Boolean = false,
    @Serializable(LenientIntSerializer::class) val level: Int = 1,
    val recoveryUntil: String? = null,
    val available: Boolean = true,
    /** Optimistic-concurrency version every `PUT /heroes/:hero/equipment/:slot` must echo. */
    @Serializable(LenientIntSerializer::class) val version: Int = 0,
    val equipment: Map<String, String> = emptyMap(),
    val modifiers: Map<String, @Serializable(LenientIntSerializer::class) Int> = emptyMap(),
    val setBonus: SetBonus? = null,
    val baseStats: HeroStats? = null,
    val effectiveStats: HeroStats? = null,
)
@Serializable data class SetBonus(val id: String? = null, @Serializable(LenientIntSerializer::class) val pieces: Int = 0,
                                  @Serializable(LenientIntSerializer::class) val required: Int = 0, val active: Boolean = false)
@Serializable data class HeroStats(
    @Serializable(DecimalStringSerializer::class) val hp: String,
    @Serializable(DecimalStringSerializer::class) val basicDamage: String,
    @Serializable(DecimalStringSerializer::class) val skillDamageSeed: String,
)
@Serializable data class DeedItem(val id: String? = null, val baseId: String? = null, val name: String? = null, val kind: String? = null, val asset: String? = null, val status: String? = null)

/** `PUT /heroes/:hero/equipment/:slot` → `{hero, slot, itemId, version}`. */
@Serializable data class EquipResult(val hero: String, val slot: String, val itemId: String? = null, @Serializable(LenientIntSerializer::class) val version: Int) {
    companion object { fun from(raw: JsonObject): EquipResult = raw.decode() }
}

/** `GET /campaign`. */
@Serializable data class CampaignState(val baseId: String? = null, val stages: List<CampaignStage> = emptyList()) {
    companion object { fun from(raw: JsonObject): CampaignState = raw.decode() }
}
@Serializable data class CampaignStage(
    @Serializable(LenientIntSerializer::class) val stage: Int,
    @Serializable(LenientIntSerializer::class) val act: Int? = null,
    val name: String,
    val profile: String? = null,
    val defenderHero: String? = null,
    val tactic: String? = null,
    val threat: String? = null,
    @Serializable(LenientIntSerializer::class) val keepLevel: Int? = null,
    @Serializable(LenientIntSerializer::class) val recommendedArmyPoints: Int? = null,
    @Serializable(LenientIntSerializer::class) val maxArmyPoints: Int? = null,
    @Serializable(LenientIntSerializer::class) val bestStars: Int = 0,
    val unlocked: Boolean = false,
    val firstThreeStarClaimed: Boolean = false,
)

/** One page of `GET /bases/:baseId/battles` (deed-scoped) or `GET /battles/participated` (web raidlog.tsx). */
@Serializable data class BattleHistory(val battles: List<BattleRecord> = emptyList(), val nextCursor: String? = null) {
    companion object { fun from(raw: JsonObject): BattleHistory = raw.decode() }
}
@Serializable data class BattleRecord(
    val raidId: String,
    val baseId: String? = null,
    val role: String? = null,
    val mode: String? = null,
    val opponentLabel: String? = null,
    val result: String? = null,
    @Serializable(LenientIntSerializer::class) val stars: Int? = null,
    @Serializable(DecimalStringSerializer::class) val destructionPct: String? = null,
    /** Signed exact settled delta; null is the server's deliberate redaction after a deed sale. */
    @Serializable(DecimalStringSerializer::class) val lootDeltaShards: String? = null,
    @Serializable(DecimalStringSerializer::class) val settledAmount: String? = null,
    /** PvE pays KEEP; PvP and campaign pay SHARDS (server `settledCurrency`). */
    val settledCurrency: String? = null,
    val lootRedacted: Boolean = false,
    val opponent: BattleOpponent? = null,
    val createdAt: String? = null,
    /** Client-only authorization route the row was listed under (web `replayAccess`): `deed` rows replay through
     * `/bases/:baseId/battles/:raidId/replay`, `participant` rows through `/battles/participated/:raidId/replay`. */
    val replayAccess: String? = null,
) {
    /** Web `historyReplayRequestPath` in stable mode: prior-participant authority survives a deed sale. */
    val replayPath: String get() = if (replayAccess == "participant" || baseId.isNullOrBlank()) "/battles/participated/$raidId/replay"
        else "/bases/$baseId/battles/$raidId/replay"
}
@Serializable data class BattleOpponent(val baseId: String? = null, val wallet: String, val name: String = "", val seeker: Boolean = false)

/** `GET /raids/pending` rows (web `PendingRaidIdentity`): the attacker's still-pending marches, current SIM only. */
@Serializable data class PendingMarch(
    val id: String,
    val attackerBaseId: String? = null,
    val defenderWallet: String? = null,
    val defenderBaseId: String? = null,
    val pveCampId: String? = null,
    @Serializable(LenientIntSerializer::class) val campaignStage: Int? = null,
    @Serializable(LenientIntSerializer::class) val simVersion: Int? = null,
    val ordersDeadlineAt: String? = null,
)
@Serializable data class PendingMarches(val raids: List<PendingMarch> = emptyList()) {
    companion object { fun from(raw: JsonObject): PendingMarches = raw.decode() }
}

fun JsonArray?.orEmptyArray(): JsonArray = this ?: JsonArray(emptyList())
