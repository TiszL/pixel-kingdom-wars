package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.Inventory
import gg.pixelkingdomwars.nativeclient.network.defenceBuildingChoices
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.levelStats
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.ordinaryBuildingChoices
import gg.pixelkingdomwars.nativeclient.network.researchRemaining
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.liveTroopName
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.researchProgress
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.realmTradeBuildingTypes
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * The selected-building bar's facts (design final/buildings/SPEC.md §1.4 plate line 2, badges and primary values; §1.6).
 * Pure: no Compose, no repository, no network, no clock (the caller passes `now`). Every value is read from server state
 * or the constants catalogue through the helpers the owning screens already use (researchProgress / armyPortrait /
 * liveTroopName for research, GearLiveMapper's NEW rule, the Workshop mappers' wallet + base admission, levelStats, the
 * BUILD_COSTS Keep gate readTrayFacts reads). An unknown value is the ellipsis or no line at all, never 0.
 */

/** What one building's bar and plate show beyond the gates: the plate's state line, a corner badge for the type's door,
 *  the primary's value / timer, a 0..1 meter, whether the door reads COLLECT, and an icon for the primary. */
internal data class BarDoorFact(
    val stateLine: String? = null,
    val badge: BadgeUi? = null,
    val value: String? = null,
    val timer: String? = null,
    val progress: Float? = null,
    val readyToCollect: Boolean = false,
    /** The primary's icon when the fact names one (the researched troop's portrait); null keeps the bar's own icon. */
    val icon: String? = null,
)

/** The facts that live outside KingdomUiState, read by the mount from their owners' current projections. A null door
 *  fact (or false) draws the plain door: nothing is guessed for an owner that is not reachable. */
internal data class BuildingBarExtras(
    val research: BarDoorFact? = null,
    val gearNew: Boolean = false,
    val workshop: BarDoorFact? = null,
    val lodge: BarDoorFact? = null,
    val market: BarDoorFact? = null,
    val harvester: BarDoorFact? = null,
    val berth: BarDoorFact? = null,
    val goldForge: BarDoorFact? = null,
)

/** Whole seconds from [now] to an ISO instant (the same ceil rule as BuildingSheet's timers); null when unreadable. */
private fun secondsUntil(iso: String?, now: Long): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    ?.let { ((it - now + 999) / 1000).coerceAtLeast(0) }

/** The seconds left on a builder job; null when its finish time is unreadable. */
internal fun jobSecondsLeft(job: BaseJob, now: Long): Long? = secondsUntil(job.finishesAt, now)

/** "ALCHEMY LAB" -> "Alchemy Lab": a catalogue display label inside a sentence. */
internal fun sentenceName(label: String): String =
    label.lowercase().split(' ').joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } }

/** Alchemy Lab: "Giant 3 · 2h 10m", the blue meter, the timer chip and the troop's portrait for the primary. Reads the
 *  active research exactly as the Research sheet's mapper does (the first `research` row of the army read, its `toLevel`,
 *  `researchRemaining`, `researchProgress`). Null when no research runs, or when [baseId] is given and the army read
 *  belongs to another kingdom. */
internal fun researchBarFact(army: ArmyDomainState, catalogue: JsonObject?, nowMs: Long, baseId: String? = null): BarDoorFact? {
    val current = army.army ?: return null
    if (baseId != null && army.armyBaseId != baseId) return null
    val row = current.raw.objects("research").firstOrNull() ?: return null
    val troop = row.string("troop") ?: return null
    val target = row.string("toLevel")?.toIntOrNull() ?: return null
    val remaining = researchRemaining(row, nowMs)
    val time = remaining?.let(::fmtDur) ?: UNKNOWN
    return BarDoorFact(stateLine = "${liveTroopName(troop)} $target · $time", timer = time,
        progress = catalogue?.let { researchProgress(it, target, remaining) },
        icon = armyPortrait(catalogue, troop, current.levels[troop]))
}

/** Hero Altar GEAR's gold NEW badge: GearLiveMapper's `hasNew` rule (an owned gear item the player has not seen). */
internal fun gearNewFact(inventory: Inventory?): Boolean =
    inventory?.let { data -> data.catalog.any { it.kind == "gear" && data.quantity(it.id) > 0 && !data.seen(it.id) } } == true

/** Workshop CRAFT: the red count of refining jobs and "Refining · <time>" to the soonest `readyAt`. Only a view of this
 *  wallet (the journal's identity) and of [baseId]. The clock is floored at the view's `serverNow`, so a phone clock that
 *  runs behind never shows more time than the server said. Null with no view, a foreign view or no job running. A
 *  refining command in flight keeps the last view's line (a routine refresh never blanks what was shown; the repository
 *  itself clears its view when it re-reads). */
internal fun workshopBarFact(state: OrdinaryCraftingState?, baseId: String?, nowMs: Long): BarDoorFact? {
    val crafting = state ?: return null
    val view = crafting.view ?: return null
    if (view.wallet != crafting.journal.identity.wallet) return null
    if (baseId == null || !view.baseId.equals(baseId, ignoreCase = true)) return null
    if (view.pendingJobs.isEmpty()) return null
    val serverNow = runCatching { Instant.parse(view.serverNow).toEpochMilli() }.getOrNull() ?: return null
    val ready = view.pendingJobs.mapNotNull { job -> runCatching { Instant.parse(job.readyAt).toEpochMilli() }.getOrNull() }.minOrNull()
        ?: return null
    val left = ((ready - maxOf(nowMs, serverNow) + 999) / 1000).coerceAtLeast(0)
    val count = view.pendingJobs.size
    return BarDoorFact(stateLine = "Refining · ${fmtDur(left)}",
        badge = badgeCount(count)?.let { BadgeUi(it, BadgeTone.COUNT, if (count == 1) "1 refining job running" else "$count refining jobs running") })
}

/** The plate / bar fact of [building] from KingdomUiState and the mount's [extras]; null shows no line. */
internal fun buildingBarFact(state: KingdomUiState, building: Building, extras: BuildingBarExtras, now: Long): BarDoorFact? =
    when (building.type) {
        "keep" -> keepBarFact(state)
        "barracks" -> barracksBarFact(state, now)
        "camp" -> campBarFact(state)
        "forge" -> extras.research
        "mine" -> mineBarFact(state)
        "heroaltar", "siegestool" -> heroBarFact(state, building.type, now)
        "wall" -> wallBarFact(state)
        "workshop" -> extras.workshop
        "lodge" -> extras.lodge
        "market" -> extras.market
        "harvester" -> extras.harvester
        "berth" -> extras.berth
        "goldforge" -> extras.goldForge
        else -> state.catalogue?.let { defenceBarFact(it, building.type, building.level) }
    }

/** Keep: "Next: Lv N opens the <Name>", the smallest `BUILD_COSTS[type].requiresKeepLevel` above the Keep's level among
 *  the types the BUILD tray offers (readTrayFacts' rule: a priced ordinary or defence type, or an admitted realm-trade
 *  type). Null when the catalogue names none. */
internal fun keepBarFact(state: KingdomUiState): BarDoorFact? = runCatching {
    val catalogue = state.catalogue ?: return@runCatching null
    val keepLevel = state.base?.player?.keepLevel ?: return@runCatching null
    val costs = (catalogue["constants"] as? JsonObject)?.get("BUILD_COSTS") as? JsonObject ?: return@runCatching null
    val admitted by lazy { state.phaseEBuildingChoices }
    val next = (realmTradeBuildingTypes + ordinaryBuildingChoices + defenceBuildingChoices).distinct().mapNotNull { type ->
        val required = (costs[type] as? JsonObject)?.string("requiresKeepLevel")?.toIntOrNull() ?: return@mapNotNull null
        if (required <= keepLevel) return@mapNotNull null
        val offered = if (type in realmTradeBuildingTypes) type == "goldforge" || type in admitted else state.price(type) != null
        if (offered) type to required else null
    }.minByOrNull { it.second } ?: return@runCatching null
    BarDoorFact(stateLine = "Next: Lv ${next.second} opens the ${sentenceName(trayLabel(next.first))}")
}.getOrNull()

/** Barracks: "Training n · <time to the next troop>" and the red count badge, from `armyStatus`. Null while idle. */
internal fun barracksBarFact(state: KingdomUiState, now: Long): BarDoorFact? {
    val army = state.base?.armyStatus ?: return null
    val count = army.trainingTroopCount
    if (count <= 0) return null
    val next = secondsUntil(army.nextReadyAt, now)?.let(::fmtDur) ?: UNKNOWN
    return BarDoorFact(stateLine = "Training $count · $next",
        badge = badgeCount(count)?.let { BadgeUi(it, BadgeTone.COUNT, if (count == 1) "1 troop training" else "$count troops training") })
}

/** Army Camp: "Army ready/capacity · free free" and the camp fill (housing points from `armyStatus`). Null while the
 *  capacity is unknown. */
internal fun campBarFact(state: KingdomUiState): BarDoorFact? {
    val army = state.base?.armyStatus ?: return null
    val capacity = army.campCapacityPts.takeIf { it > 0 } ?: return null
    val ready = army.readyPts.coerceAtLeast(0)
    val free = (capacity - ready).coerceAtLeast(0)
    return BarDoorFact(stateLine = "Army $ready/$capacity · $free free", progress = (ready.toFloat() / capacity).coerceIn(0f, 1f))
}

/** Mine: "Ready · n Shards", COLLECT's "+n" and the green "!" while the deed's mining pool holds Shards. */
internal fun mineBarFact(state: KingdomUiState): BarDoorFact? {
    val accrued = state.home.mine?.mining?.accrued?.trim()?.toBigDecimalOrNull() ?: return null
    if (accrued.signum() <= 0) return null
    val shown = fmtN(accrued.toPlainString()).takeIf { it != "0" } ?: return null
    return BarDoorFact(stateLine = "Ready · $shown Shards", badge = BadgeUi("!", BadgeTone.READY, "$shown Shards ready to collect"),
        value = "+$shown", readyToCollect = true)
}

/** Hero Altar / Siege Stool: "<Hero> · ready to fight" or "Recovering · <time>", from the base read's `heroes` row (the
 *  same `available` / `recoveryUntil` fields BuildingSheet reads). Null when the hero row is absent or says neither. */
internal fun heroBarFact(state: KingdomUiState, type: String, now: Long): BarDoorFact? {
    val key = when (type) { "heroaltar" -> "vex"; "siegestool" -> "theodor"; else -> return null }
    val hero = state.base?.raw?.objects("heroes")?.firstOrNull { it.string("hero") == key } ?: return null
    secondsUntil(hero.string("recoveryUntil"), now)?.takeIf { it > 0 }?.let { return BarDoorFact(stateLine = "Recovering · ${fmtDur(it)}") }
    val available = (hero["available"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
    return if (available == true) BarDoorFact(stateLine = "${if (key == "vex") "Vex" else "Theodor"} · ready to fight") else null
}

/** A defence: two stats in the SPEC wording ("Damage 38 · range 10") from `levelStats` (DMG / RNG at this level). */
internal fun defenceBarFact(catalogue: JsonObject, type: String, level: Int): BarDoorFact? {
    val rows = levelStats(catalogue, type, level)?.rows ?: return null
    val damage = rows.firstOrNull { it.label == "DMG" }?.current
    val range = rows.firstOrNull { it.label == "RNG" }?.current
    val line = when {
        damage != null && range != null -> "Damage $damage · range $range"
        damage != null -> "Damage $damage"
        range != null -> "Range $range"
        else -> return null
    }
    return BarDoorFact(stateLine = line)
}

/** Wall: "<n> owned", or "Row of r · n owned" while the row is selected. */
internal fun wallBarFact(state: KingdomUiState): BarDoorFact? {
    val owned = state.base?.buildings?.count { it.type == "wall" } ?: return null
    val row = state.wallRowIds.size
    return BarDoorFact(stateLine = if (row > 0) "Row of $row · $owned owned" else "$owned owned")
}
