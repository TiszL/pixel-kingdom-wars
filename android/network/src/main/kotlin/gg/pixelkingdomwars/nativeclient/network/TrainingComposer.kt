package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.TrainingQueueRow
import gg.pixelkingdomwars.nativeclient.model.TroopCount
import java.math.BigInteger
import java.time.Instant
import kotlinx.serialization.json.*

/*
 * Pure DISPLAY rules of the Barracks composer, the training queue and the saved armies, ported from
 * production (apps/web/src/ui/screens/army.helpers.ts, apps/web/src/ui/troopRollout.ts and the
 * validation in apps/api/src/game/armyPresets.ts). Every number is read from the constants catalogue by
 * the name `packages/shared/src/constants.ts` exports; a missing key fails closed (null / locked), nothing
 * is invented. The server re-validates and re-prices every POST.
 */

private fun JsonObject.obj(key: String) = this[key] as? JsonObject
private fun JsonObject.int(key: String) = (this[key] as? JsonPrimitive)?.content?.toIntOrNull()
private fun JsonObject.long(key: String) = (this[key] as? JsonPrimitive)?.content?.toLongOrNull()
private fun JsonObject.bool(key: String) = (this[key] as? JsonPrimitive)?.booleanOrNull
private fun constants(catalogue: JsonObject?, key: String): JsonObject? = catalogue?.obj("constants")?.obj(key)

/** `TROOPS[troop]` from the catalogue, or null when the pack does not know the troop. */
fun troopStats(catalogue: JsonObject?, troop: String): JsonObject? = constants(catalogue, "TROOPS")?.obj(troop)
fun troopPoints(catalogue: JsonObject?, troop: String): Int? = troopStats(catalogue, troop)?.int("pts")

/** The Barracks TRAIN table: production's `TRAIN_ROWS` order is the pack's `display.research.troops`
 * order, restricted to troops the server trains (`isTrainableTroop`: neither defender- nor spawn-only). */
fun trainableTroops(catalogue: JsonObject?): List<String> {
    val troops = constants(catalogue, "TROOPS") ?: return emptyList()
    val ordered = (catalogue?.obj("display")?.obj("research")?.get("troops") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    return (ordered ?: troops.keys.toList()).filter { troop -> troops.obj(troop)?.let { it.bool("defenderOnly") != true && it.bool("spawnOnly") != true } == true }
}

/** Manual selection reserves room in both server capacities (`manualTrainingRoom`). Presets may still
 * request a larger army and use the server's explicit partial quote. */
data class TrainingRoom(val queuePts: Int, val draftPts: Int, val campFreePts: Int, val queueFreePts: Int)
fun manualTrainingRoom(catalogue: JsonObject?, queue: List<TrainingQueueRow>, rosterPts: Int, campCapacityPts: Int, barracksQueuePts: Int, draft: List<TroopCount>): TrainingRoom {
    val queuePts = queue.sumOf { troopPoints(catalogue, it.troop) ?: 0 }
    val draftPts = draft.sumOf { (troopPoints(catalogue, it.troop) ?: 0) * it.count }
    return TrainingRoom(queuePts, draftPts, (campCapacityPts - rosterPts - queuePts - draftPts).coerceAtLeast(0), (barracksQueuePts - queuePts - draftPts).coerceAtLeast(0))
}

/** One lock verdict per troop card (D-058): elite troops are WRIT-gated until the server's `/army`
 * `eliteUnlocks` verdict says the wallet consumed the unlock item (fails closed while it loads); the label
 * names the unlock path exactly. The Keep gate stays for any future Keep-gated troop. */
sealed interface TroopUnlock {
    data object Open : TroopUnlock
    data class Elite(val label: String, val itemAsset: String?) : TroopUnlock
    data class Keep(val label: String, val requiresKeepLevel: Int) : TroopUnlock
    val locked: Boolean get() = this !is Open
}
fun troopUnlockView(catalogue: JsonObject?, troop: String, keepLevel: Int?, eliteUnlocks: Map<String, Boolean>?): TroopUnlock {
    val itemId = constants(catalogue, "ELITE_TROOP_UNLOCKS")?.obj("itemByTroop")?.string(troop)
    if (itemId != null && eliteUnlocks?.get(troop) != true) {
        val spec = constants(catalogue, "ITEMS")?.obj(itemId)
        val drop = spec?.obj("acquisition")?.string("type") == "drop"
        val cost = spec?.get("costKeep")?.let { (it as? JsonPrimitive)?.content }
        return TroopUnlock.Elite(if (drop || cost == null) "DROPS FROM GOLD FORGE" else "UNLOCK: ${fmtN(cost)} KEEP WRIT", spec?.string("asset"))
    }
    val required = troopStats(catalogue, troop)?.int("requiresKeepLevel")
    return if (required != null && (keepLevel == null || keepLevel < required)) TroopUnlock.Keep("KEEP L$required", required) else TroopUnlock.Open
}

/** The SIM6 dark roster is an expand/activate rollout: membership is the pack's `DARK_ATTACKER_TROOPS`,
 * activation is exclusively the `/army` `features.darkAttackerRoster` capability; an old response that
 * omits it fails closed. */
data class RolloutGate(val locked: Boolean, val message: String? = null)
fun troopRolloutGate(catalogue: JsonObject?, troop: String, feature: JsonElement?): RolloutGate {
    val dark = (catalogue?.obj("constants")?.get("DARK_ATTACKER_TROOPS") as? JsonArray)?.any { (it as? JsonPrimitive)?.contentOrNull == troop } ?: false
    if (!dark) return RolloutGate(false)
    val capability = feature as? JsonObject
    if (capability?.bool("enabled") == true) return RolloutGate(false)
    return RolloutGate(true, capability?.string("message")?.trim()?.takeIf { it.isNotEmpty() } ?: "COMING SOON")
}

/** A grouped −1 always removes the least-progressed unit of that type: the refundable row with the latest
 * authoritative `finishesAt`. Exact row ids cross the wire, so duplicate troop identities are never ambiguous. */
data class TrainingCancelTarget(val id: String, val troop: String, val finishesAt: String, val refundShards: String)
fun trainingCancelTarget(queue: List<TrainingQueueRow>, troop: String): TrainingCancelTarget? {
    var target: TrainingCancelTarget? = null
    for (row in queue) {
        val refund = row.refundShards; val finish = row.finishesAt
        if (row.troop != troop || !row.canCancel || refund == null || finish == null) continue
        if (target == null || epochMillis(finish) >= epochMillis(target.finishesAt)) target = TrainingCancelTarget(row.id, row.troop, finish, refund)
    }
    return target
}
/** Tap-tap-tap cancellation (D-096): rows a tap already spoke for are skipped, so N rapid taps resolve N
 * DISTINCT ids latest-first; null once every refundable row of that troop is spoken for (a no-op tap, never
 * a duplicate POST). */
fun nextTrainingCancelTarget(queue: List<TrainingQueueRow>, troop: String, pendingIds: Set<String>): TrainingCancelTarget? =
    trainingCancelTarget(queue.filter { it.id !in pendingIds }, troop)

/** Seconds until the WHOLE queue is done: the TAIL row's `finishesAt` − now (the queue is server-ordered by
 * finish, rows overlap, so summing per-row time would overcharge). ceil like the server; 0 when empty or due. */
fun queueRemainingSec(queue: List<TrainingQueueRow>, nowMs: Long): Long {
    val tail = queue.lastOrNull()?.finishesAt ?: return 0
    return ((epochMillis(tail) - nowMs + 999).floorDiv(1000)).coerceAtLeast(0)
}
private fun epochMillis(iso: String): Long = runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)

/** The shared speed-up curve (`speedupCostKeep`, packages/shared/src/constants.ts) from the catalogue's
 * `ECONOMY.speedupKeepPer30Sec / speedupGranularitySec / speedupQuadraticSoftUnits`: u = max(1, ceil(rem /
 * granularity)); max(1, u·rate + ceil(rate·u² / soft)). Null when the pack lacks a coefficient — no price is
 * shown rather than an invented one; the server still prices every accept. */
fun speedupCostKeep(catalogue: JsonObject?, remainingSec: Long): BigInteger? {
    val economy = constants(catalogue, "ECONOMY") ?: return null
    val rate = economy.long("speedupKeepPer30Sec")?.takeIf { it > 0 }?.toBigInteger() ?: return null
    val granularity = economy.long("speedupGranularitySec")?.takeIf { it > 0 } ?: return null
    val soft = economy.long("speedupQuadraticSoftUnits")?.takeIf { it > 0 }?.toBigInteger() ?: return null
    val u = maxOf(1L, (remainingSec.coerceAtLeast(0) + granularity - 1) / granularity).toBigInteger()
    val quadratic = rate * u * u
    val ceilDiv = (quadratic + soft - BigInteger.ONE) / soft
    return (u * rate + ceilDiv).max(BigInteger.ONE)
}

/** `TRAINING_PRESETS` from the catalogue; null when the pack lacks it (saved armies fail closed). */
data class TrainingPresetRules(val slots: Int, val nameMaxLength: Int, val maxCompositionUnits: Int) {
    companion object {
        fun from(catalogue: JsonObject?): TrainingPresetRules? {
            val rules = constants(catalogue, "TRAINING_PRESETS") ?: return null
            val slots = rules.int("slots")?.takeIf { it > 0 } ?: return null
            val name = rules.int("nameMaxLength")?.takeIf { it > 0 } ?: return null
            val units = rules.int("maxCompositionUnits")?.takeIf { it > 0 } ?: return null
            return TrainingPresetRules(slots, name, units)
        }
    }
    fun validateSlot(slot: Int) { require(slot in 1..slots) { "unknown preset slot" } }
    fun validateName(name: String): String = name.trim().also { require(it.isNotEmpty() && it.length <= nameMaxLength) { "enter a short preset name" } }
    /** `validateTrainingComposition` (armyPresets.ts): one positive whole count per trainable troop, at most
     * [maxCompositionUnits] units — the server's exact refusals, raised before any request leaves. */
    fun validateComposition(composition: List<TroopCount>, trainable: Collection<String>) {
        require(composition.isNotEmpty() && composition.size <= trainable.size) { "choose at least one troop type" }
        val seen = mutableSetOf<String>()
        var total = 0L
        for (row in composition) {
            require(row.troop in trainable && row.count >= 1 && seen.add(row.troop)) { "use one positive whole count per trainable troop type" }
            total += row.count
        }
        require(total <= maxCompositionUnits) { "a plan supports up to $maxCompositionUnits troops" }
    }
}
