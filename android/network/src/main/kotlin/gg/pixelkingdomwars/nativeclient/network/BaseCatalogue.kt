package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

/** Display copy for building types (web `ui/sheets.tsx` TRAY_LABELS / trayLabel). */
private val TRAY_LABELS = mapOf(
    "heroaltar" to "VEX · ALTAR", "siegestool" to "THEODOR · STOOL", "archertower" to "ARCHER TWR", "electrictower" to "TESLA TWR",
    "lasertower" to "LASER TWR", "magetower" to "MAGE TWR", "dragonnest" to "DRAGON NEST", "airdefence" to "AIR DEFENCE",
    "powdermine" to "POWDER MINE", "airmine" to "AIR MINE", "clanhall" to "CLAN HALL", "forge" to "ALCHEMY LAB", "goldforge" to "GOLD FORGE",
    "workshop" to "WORKSHOP", "lodge" to "EXPLORATION LODGE", "market" to "MARKET", "harvester" to "REALM HARVESTER", "berth" to "BERTH",
)
fun trayLabel(type: String): String = TRAY_LABELS[type] ?: type.uppercase()

/** Web `ui/copy.ts` TROOP_DISPLAY. */
private val TROOP_DISPLAY = mapOf(
    "highlander" to "HIGHLANDER", "bowman" to "BOWMAN", "kegrunner" to "KEG RUNNER", "tunneler" to "TUNNELER", "turrider" to "TUR RIDER",
    "plunderer" to "PLUNDERER", "giant" to "GIANT", "troll" to "TROLL", "dragon" to "DRAGON", "mage" to "MAGE", "bilgewraith" to "BILGEWRAITH",
    "gloamfang" to "GLOAMFANG", "direwyvern" to "DIREWYVERN", "hexbarrow" to "HEXBARROW", "barrowling" to "BARROWLING", "wyrmling" to "WYRMLING",
)
fun troopLabel(troop: String): String = TROOP_DISPLAY[troop] ?: troop.uppercase()

// Every number below is read from the generated constants catalogue by the name `constants.ts`
// exports it under. Nothing is defaulted: a pack without a table yields null and the control that
// needs it is not offered.
private fun JsonObject.table(key: String): JsonObject? = (this["constants"] as? JsonObject)?.get(key) as? JsonObject
private fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.contentOrNull?.toIntOrNull()
private fun JsonElement?.long(): Long? = (this as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
private fun JsonElement?.num(): Double? = (this as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
private fun JsonElement?.ints(): List<Int> = (this as? JsonArray)?.mapNotNull { it.int() }.orEmpty()
private fun JsonElement?.longs(): List<Long> = (this as? JsonArray)?.mapNotNull { it.long() }.orEmpty()
/** JS number → text: integral values print without a fraction, others as their shortest form. */
private fun jsNumber(value: Double): String = if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()

/** `packages/shared/src/types.ts` TRAP_TYPES: the single-use defences are exactly the `DEFENSES`
 * rows flagged `oneUse`, which is what the repair table and the trap cap key off. */
fun isTrapType(catalogue: JsonObject, type: String): Boolean = (catalogue.table("DEFENSES")?.get(type) as? JsonObject)?.flag("oneUse") == true

/** `constants.ts` artTierOfLevel: the four-tier art family a gameplay level draws from. */
fun artTierOfLevel(catalogue: JsonObject, level: Int): Int? {
    val art = catalogue.table("ART_V2") ?: return null
    val tiers = art["tiers"].int() ?: return null; val perTier = art["levelsPerTier"].int()?.takeIf { it > 0 } ?: return null
    val l = maxOf(1, level)
    return minOf(tiers, (l + perTier - 1) / perTier)
}

/** Web `maxLevelFor` (sheets.tsx): walls use `STRUCTURES.wall.maxTier`, defences `DEFENSE_LEVELING.maxLevel`,
 * structures their own `maxLevel`; a type with no table reads 1, exactly like the web. */
fun maxLevelFor(catalogue: JsonObject, type: String): Int {
    if (type == "wall") return (catalogue.table("STRUCTURES")?.get("wall") as? JsonObject)?.get("maxTier").int() ?: 1
    if (catalogue.table("DEFENSES")?.containsKey(type) == true) return catalogue.table("DEFENSE_LEVELING")?.get("maxLevel").int() ?: 1
    return (catalogue.table("STRUCTURES")?.get(type) as? JsonObject)?.get("maxLevel").int() ?: 1
}

/** `packages/shared/src/raidLoot.ts` vaultProtectionBps: linear in level up to `LOOT.vaultProtectionMaxBps`. */
fun vaultProtectionBps(catalogue: JsonObject, level: Int): Int? {
    if (level <= 0) return 0
    val max = catalogue.table("LOOT")?.get("vaultProtectionMaxBps").int() ?: return null
    val maxLevel = (catalogue.table("STRUCTURES")?.get("vault") as? JsonObject)?.get("maxLevel").int()?.takeIf { it > 0 } ?: return null
    return Math.floorDiv(max * minOf(level, maxLevel), maxLevel)
}

data class StatRow(val label: String, val current: String, val next: String?)
/** [caption] names the gold column ("AT LEVEL n"); null at max level, where there is nothing to quote. */
data class LevelStats(val caption: String?, val rows: List<StatRow>)

/** Web `levelStats` (sheets.tsx): HP / DMG / RNG / SHIELDS / CAP / PWR at this level and at the next,
 * from the tables the server prices with. Null when the type has no stat table. */
fun levelStats(catalogue: JsonObject, type: String, level: Int, previewUpgrade: Boolean = true): LevelStats? {
    val def = catalogue.table("DEFENSES")?.get(type) as? JsonObject
    val struct = catalogue.table("STRUCTURES")?.get(type) as? JsonObject
    val mult = catalogue.table("DEFENSE_LEVELING")?.get("statMultPerLevel").num() ?: return null
    val atMax = level >= maxLevelFor(catalogue, type) || !previewUpgrade
    val rows = mutableListOf<StatRow>()
    fun scaled(base: Double, at: Int) = java.lang.Math.round(base * Math.pow(mult, (at - 1).toDouble())).toString()
    if (type == "wall") {
        val hp = struct?.get("hpByTier").ints()
        if (hp.isNotEmpty()) rows += StatRow("HP", (hp.getOrNull(level - 1) ?: hp.last()).toString(), if (atMax) null else hp.getOrNull(level)?.toString())
    } else {
        val hp = (def?.get("hp") ?: struct?.get("hp")).num()
        if (hp != null && hp > 0) rows += StatRow("HP", scaled(hp, level), if (atMax) null else scaled(hp, level + 1))
    }
    def?.get("dps").num()?.takeIf { it > 0 }?.let { rows += StatRow("DMG", scaled(it, level), if (atMax) null else scaled(it, level + 1)) }
    def?.get("rangeTiles").num()?.takeIf { it > 0 }?.let { rows += StatRow("RNG", jsNumber(it), null) }
    if (type == "vault") vaultProtectionBps(catalogue, level)?.let { now ->
        rows += StatRow("SHIELDS", "${jsNumber(now / 100.0)}%", if (atMax) null else vaultProtectionBps(catalogue, level + 1)?.let { "${jsNumber(it / 100.0)}%" })
    }
    val cap = if (type == "vault") emptyList() else (struct?.get("capacity") ?: struct?.get("capacityPts") ?: struct?.get("queuePts")).longs()
    if (cap.isNotEmpty()) rows += StatRow("CAP", fmtN(cap.getOrNull(level - 1) ?: cap.last()), if (atMax || cap.getOrNull(level) == null) null else fmtN(cap[level]))
    if (type == "mine") {
        val mining = catalogue.table("MINING"); val bps = mining?.get("MINE_MULT_BPS").ints(); val one = mining?.get("BPS_ONE").int()?.takeIf { it > 0 }
        val cur = bps.getOrNull(level - 1); val next = bps.getOrNull(level)
        if (cur != null && one != null) rows += StatRow("PWR", "×${jsNumber(cur.toDouble() / one)}", if (atMax || next == null) null else "×${jsNumber(next.toDouble() / one)}")
    }
    if (rows.isEmpty()) return null
    return LevelStats(if (atMax) null else "AT LEVEL ${level + 1}", rows)
}

data class TrapRepair(val costShards: Long, val repairSec: Long)
/** Web `trapRepairDetails`: the rearm price for a spent trap (`TRAP_REPAIR[type]` by art tier), null when armed. */
fun trapRepairDetails(catalogue: JsonObject, type: String, level: Int, trapSpentAt: String?): TrapRepair? {
    if (trapSpentAt == null) return null
    val repair = catalogue.table("TRAP_REPAIR")?.get(type) as? JsonObject ?: return null
    val tier = artTierOfLevel(catalogue, level) ?: return null
    val cost = repair["costShardsByTier"].longs().getOrNull(tier - 1) ?: return null
    return TrapRepair(cost, repair["repairSec"].long() ?: return null)
}

/** One `OBSTACLES.tiers` row for a sprite key. `costShards` is the tier's `costKeep` field — a shard
 * price under a pre-split name (web `ObstacleSheet`); `sizeTiles` is the square footprint. */
data class ObstacleTier(val name: String, val costShards: Long, val clearSec: Long, val sizeTiles: Int)
fun obstacleTier(catalogue: JsonObject, spriteKey: String): ObstacleTier? {
    val tiers = catalogue.table("OBSTACLES")?.get("tiers") as? JsonObject ?: return null
    for ((name, value) in tiers) {
        val tier = value as? JsonObject ?: continue
        if ((tier["kinds"] as? JsonArray)?.any { (it as? JsonPrimitive)?.contentOrNull == spriteKey } != true) continue
        return ObstacleTier(name, tier["costKeep"].long() ?: return null, tier["clearSec"].long() ?: return null, tier["sizeTiles"].int() ?: return null)
    }
    return null
}
fun obstacleClearRewardShards(catalogue: JsonObject): Long? = catalogue.table("OBSTACLES")?.get("clearRewardShards").long()
/** Web `layoutEditor/model.ts` obstacleSize: an unknown sprite occupies one tile. */
fun obstacleSize(catalogue: JsonObject, spriteKey: String): Int = obstacleTier(catalogue, spriteKey)?.sizeTiles ?: 1

/** `apps/web/src/game/fx/stats.ts` footprintOf: the Keep by `BUILDING_GEOMETRY.keepFootprintByVersion`,
 * everything else from its `DEFENSES` / `STRUCTURES` row; an unknown type is drawn conservatively as 1×1. */
fun footprintOf(catalogue: JsonObject, type: String, geometryVersion: Int? = null): Pair<Int, Int> {
    val fallback = 1 to 1
    if (type == "keep") {
        val geometry = catalogue.table("BUILDING_GEOMETRY") ?: return fallback
        val version = geometryVersion ?: geometry["legacyVersion"].int() ?: return fallback
        val byVersion = geometry["keepFootprintByVersion"] as? JsonObject
        val footprint = (byVersion?.get(version.toString()) ?: byVersion?.get(geometry["legacyVersion"].int().toString())).ints()
        return if (footprint.size == 2) footprint[0] to footprint[1] else fallback
    }
    val row = (catalogue.table("DEFENSES")?.get(type) ?: catalogue.table("STRUCTURES")?.get(type)) as? JsonObject
    val footprint = row?.get("footprint").ints()
    return if (footprint.size == 2) footprint[0] to footprint[1] else fallback
}

/** Web `keepLevelValue`: a per-Keep-level table read at this level, clamped to the table. */
private fun keepLevelValue(values: List<Int>, keepLevel: Int): Int? {
    if (values.isEmpty()) return null
    return values[minOf(maxOf(keepLevel, 1), values.size) - 1]
}
data class BuildCount(val owned: Int, val max: Int, val familyOwned: Int?, val atCap: Boolean)
/** Web `buildCountPresentation`: the count contract `placeBuilding` enforces, per card. Traps share one
 * cap (`CAPS.trapsByKeepLevel`), mines use `MINING.MAX_MINES_BY_KEEP`, everything else `BUILD_COUNT_CAP_BY_KEEP`.
 * Null when the pack lacks the table for this type — the card then shows no count and no cap. */
fun buildCountPresentation(catalogue: JsonObject, type: String, keepLevel: Int, buildingTypes: List<String>, capacity: JsonElement? = null): BuildCount? {
    val owned = buildingTypes.count { it == type }
    if (isTrapType(catalogue, type)) {
        val familyOwned = buildingTypes.count { isTrapType(catalogue, it) }
        val max = keepLevelValue(catalogue.table("CAPS")?.get("trapsByKeepLevel").ints(), keepLevel) ?: return null
        return BuildCount(owned, max, familyOwned, familyOwned >= max)
    }
    val max = if (type == "mine") keepLevelValue(catalogue.table("MINING")?.get("MAX_MINES_BY_KEEP").ints(), keepLevel)
        else (if (type == "berth") advertisedBerthBuildCapacity(capacity) else null)
            ?: keepLevelValue(catalogue.table("BUILD_COUNT_CAP_BY_KEEP")?.get(type).ints(), keepLevel)
    return BuildCount(owned, max ?: return null, null, owned >= max)
}

/** Current GET /base authority overrides only berth count; old/invalid snapshots
 * preserve the pack's existing table and never infer an enabled vehicle flag. */
fun advertisedBerthBuildCapacity(capacity: JsonElement?): Int? {
    val value = capacity as? JsonObject ?: return null
    val version = value["version"] as? JsonPrimitive ?: return null
    if (version.isString || version.content != "1") return null
    val max = (value["berth"] as? JsonObject)?.get("max") as? JsonPrimitive ?: return null
    if (max.isString || !max.content.matches(Regex("0|[1-9][0-9]*"))) return null
    return max.content.toIntOrNull()
}

/** `packages/shared/src/unlocks.ts` KeepLevelUnlock. */
data class KeepUnlock(val kind: String, val id: String? = null, val delta: Int? = null, val value: Int? = null)

/** `unlocks.ts` unlocksAtKeepLevel: everything that becomes available when the Keep reaches [level],
 * derived from the gates and cap tables the server enforces and never written down a second time. */
fun unlocksAtKeepLevel(catalogue: JsonObject, level: Int): List<KeepUnlock> {
    val out = mutableListOf<KeepUnlock>()
    val newBuildings = mutableSetOf<String>()
    catalogue.table("BUILD_COSTS")?.forEach { (type, spec) ->
        if ((spec as? JsonObject)?.get("requiresKeepLevel").int() == level) { newBuildings += type; out += KeepUnlock("building", type) }
    }
    catalogue.table("TROOPS")?.forEach { (troop, spec) -> if ((spec as? JsonObject)?.get("requiresKeepLevel").int() == level) out += KeepUnlock("troop", troop) }
    catalogue.table("HEROES")?.forEach { (hero, spec) -> if ((spec as? JsonObject)?.get("unlockKeepLevel").int() == level) out += KeepUnlock("hero", hero) }
    if (catalogue.table("RALLY")?.get("unlockKeepLevel").int() == level) out += KeepUnlock("rally")
    val batteries = catalogue.table("KEEP_BATTERIES")
    if (batteries?.get("highRangeUnlockLevel").int() == level) out += KeepUnlock("keepBattery", "high")
    if (batteries?.get("lowRangeUnlockLevel").int() == level) out += KeepUnlock("keepBattery", "low")
    fun growth(caps: List<Int>): Pair<Int, Int>? {
        val prev = caps.getOrNull(level - 2) ?: 0; val next = caps.getOrNull(level - 1) ?: prev
        return if (next > prev) (next - prev) to next else null
    }
    catalogue.table("BUILD_COUNT_CAP_BY_KEEP")?.forEach { (type, caps) ->
        if (type in newBuildings) return@forEach
        growth(caps.ints())?.let { (delta, value) -> out += KeepUnlock("buildCount", type, delta, value) }
    }
    growth(catalogue.table("MINING")?.get("MAX_MINES_BY_KEEP").ints())?.let { (delta, value) -> out += KeepUnlock("mineCap", null, delta, value) }
    growth(catalogue.table("CAPS")?.get("trapsByKeepLevel").ints())?.let { (delta, value) -> out += KeepUnlock("trapCap", null, delta, value) }
    val caps = catalogue.table("CAPS")
    val required = caps?.get("expansionReqKeepLevel").ints(); val claims = caps?.get("claimTilesByExpansion").ints()
    required.forEachIndexed { i, req -> val claim = claims.getOrNull(i + 1); if (req == level && claim != null) out += KeepUnlock("expansion", null, null, claim) }
    return out
}

/** Web `BuildingInfo.tsx` unlockLabel. Hero names come from `HEROES[id].name`, exactly as the web reads them. */
fun unlockLabel(catalogue: JsonObject, unlock: KeepUnlock): String = when (unlock.kind) {
    "building" -> "NEW BUILDING — ${trayLabel(unlock.id.orEmpty())}"
    "troop" -> "NEW TROOP — ${troopLabel(unlock.id.orEmpty())}"
    "hero" -> "HERO — ${((catalogue.table("HEROES")?.get(unlock.id.orEmpty()) as? JsonObject)?.string("name") ?: unlock.id.orEmpty()).uppercase()}"
    "rally" -> "RALLY — RAGE PULSE IN RAIDS"
    "keepBattery" -> if (unlock.id == "high") "KEEP BATTERY — LONG-RANGE GUN" else "KEEP BATTERY — CLOSE-RANGE GUN"
    "buildCount" -> "+${unlock.delta} ${trayLabel(unlock.id.orEmpty())} (MAX ${unlock.value})"
    "mineCap" -> "+${unlock.delta} MINE (MAX ${unlock.value})"
    "trapCap" -> "+${unlock.delta} TRAPS (MAX ${unlock.value})"
    "expansion" -> "LAND EXPANSION AVAILABLE (${unlock.value}×${unlock.value})"
    else -> unlock.kind.uppercase()
}

/** `display.upgradeSolLamports[type][targetLevel]` (D-057): a positive value marks a SOL-priced step. */
fun upgradeSolLamports(catalogue: JsonObject, type: String, targetLevel: Int): Long? =
    ((catalogue["display"] as? JsonObject)?.get("upgradeSolLamports") as? JsonObject)?.get(type)?.jsonObject?.get(targetLevel.toString()).long()

data class ExpansionOffer(val expansions: Int, val size: Int, val maxed: Boolean, val next: Int?, val requiredKeepLevel: Int?, val priceSol: String?)
/** Web `ExpandScreen`: the current claim, the next ring, its Keep gate and SOL price from `CAPS`. Null
 * when the pack lacks the expansion tables. */
fun expansionOffer(catalogue: JsonObject, expansions: Int): ExpansionOffer? {
    val caps = catalogue.table("CAPS") ?: return null
    val max = caps["expansionsMax"].int()?.takeIf { it > 0 } ?: return null
    if (expansions !in 0..max) return null
    // Never drop an invalid entry: each index identifies a specific purchased ring.
    val sizes = (caps["claimTilesByExpansion"] as? JsonArray)?.map { it.int() ?: return null } ?: return null
    val gates = (caps["expansionReqKeepLevel"] as? JsonArray)?.map { it.int() ?: return null } ?: return null
    if (sizes.size.toLong() != max.toLong() + 1 || gates.size != max
        || sizes.any { it <= 0 || it % 2 != 0 } || sizes.zipWithNext().any { (a, b) -> b <= a }
        || gates.any { it <= 0 }) return null
    if (expansions == max) return ExpansionOffer(expansions, sizes[expansions], true, null, null, null)
    fun price(raw: JsonElement?): String? = (raw as? JsonPrimitive)?.contentOrNull?.takeIf { text ->
        runCatching { java.math.BigDecimal(text).movePointRight(9).toBigIntegerExact().signum() > 0 }.getOrDefault(false)
    }
    val prices = if (caps.containsKey("expansionPriceSolByIndex")) {
        // Only old packs without an indexed table may use their legacy flat price.
        val indexed = caps["expansionPriceSolByIndex"] as? JsonArray ?: return null
        if (indexed.size != max) return null
        indexed.map { price(it) ?: return null }
    } else List(max) { price(caps["expansionPriceSol"]) ?: return null }
    return ExpansionOffer(expansions, sizes[expansions], false, sizes[expansions + 1], gates[expansions], prices[expansions])
}
