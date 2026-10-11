package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.data.WorkshopState
import gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandEntry
import gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandPresentation
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.READY_BADGE
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterArrived
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterSourceEvents

/*
 * craft SPEC §2.0 (`workshop-selected.png`), with TRADE★ (§3) and HARVEST★ (§4): a selected Workshop, Market or Harvester
 * shows INFO · UPGRADE (green, its price pill and time kept) · the building's own job as the one gold primary, last.
 * The registry designates CRAFT / TRADE / HARVEST primary only while `building.jobRunning` is known false, and Home
 * supplies that fact for the Lodge alone; the adapter's own FINISH / REARM designation is the job fact used here.
 *
 * The badge reads owner observations only (WorkshopRepository / OrdinaryCraftingRepository / HarvesterRepository state):
 * red count = jobs still working, green "!" = output waiting. A missing, foreign-wallet or other-base view gives no facts
 * and no badge, never a zero. Nothing here calls a server, collects, marks seen or spends; the door still only navigates.
 */

/** The three service buildings whose own job (CRAFT / TRADE / HARVEST) is the gold primary of their bar. */
internal val CRAFT_COMMAND_TYPES = setOf("workshop", "market", "harvester")

/** SPEC §2.0: in the ready case the CRAFT icon becomes `ready-status` (the caption becomes COLLECT in the projection). */
private const val READY_ICON = "ui:ready-status"

/** Owner observations behind a craft door's badge. [running] counts jobs still working (null when the owner has no job
 * count, as the Harvester); [ready] is output waiting for the player (a cast batch to collect, an unseen haul). */
internal data class CraftCommandFacts(val running: Int?, val ready: Boolean)

/**
 * The Workshop door's facts for [wallet]'s selected [baseId]: casting Forge Ingot batches plus pending refining jobs are
 * running; a cast batch that is ready and not yet collected is ready. Both views must belong to this wallet and base:
 * one missing view would undercount, so the answer is null rather than a guess.
 */
internal fun workshopCommandFacts(ingots: WorkshopState?, ordinary: OrdinaryCraftingState?, wallet: String,
    baseId: String?): CraftCommandFacts? {
    if (baseId.isNullOrBlank() || wallet.isBlank()) return null
    val ingotView = ingots?.takeIf { it.journal.identity.wallet == wallet }?.view
        ?.takeIf { it.inventory.baseId == baseId } ?: return null
    val refineView = ordinary?.takeIf { it.journal.identity.wallet == wallet }?.view
        ?.takeIf { it.wallet == wallet && it.baseId == baseId } ?: return null
    val open = ingotView.jobs.filter { it.collectedAt == null }
    return CraftCommandFacts(running = open.count { !it.ready } + refineView.pendingJobs.size, ready = open.any { it.ready })
}

/**
 * The Harvester door's facts: ready when a delivered haul is newer than the client-only seen marker (the same
 * [harvesterArrived] rule the Harvester sheet's COLLECT uses; no marker means nothing unseen). Hauls arrive on their
 * own, so there is no running count. Null for a missing, foreign-wallet or other-base view.
 */
internal fun harvesterCommandFacts(state: HarvesterState?, wallet: String, baseId: String?,
    seenThroughSequence: String?): CraftCommandFacts? {
    if (baseId.isNullOrBlank() || wallet.isBlank()) return null
    val current = state?.takeIf { it.journal.identity.wallet == wallet } ?: return null
    val view = current.view?.takeIf { it.wallet == wallet && it.baseId == baseId } ?: return null
    val events = view.source?.let { harvesterSourceEvents(current.journal, it.sourceId) }
    return CraftCommandFacts(running = null, ready = harvesterArrived(events, seenThroughSequence).unseenQuantity > 0L)
}

/** Facts into the door's existing presentation entry (DESIGN-SYSTEM §10 badge grammar): ready wins with the green "!"
 * and readyToCollect (caption COLLECT; Workshop icon `ready-status`), else a red count of running jobs, else nothing. */
internal fun craftCommandEntry(type: String, entry: BuildingCommandEntry, facts: CraftCommandFacts?): BuildingCommandEntry {
    if (type !in CRAFT_COMMAND_TYPES || facts == null) return entry
    if (facts.ready) return entry.copy(badge = READY_BADGE, readyToCollect = true,
        icon = if (type == "workshop") READY_ICON else entry.icon)
    val running = facts.running ?: return entry
    val count = badgeCount(running) ?: return entry
    return entry.copy(badge = BadgeUi(count, BadgeTone.COUNT, if (running == 1) "1 job running" else "$running jobs running"))
}

/** The presentation handed to the registry projection, with the craft door's facts applied. Other types are untouched. */
internal fun craftCommandPresentation(presentation: BuildingCommandPresentation, type: String, feature: FeatureId,
    host: PhaseEBuildingCommands): BuildingCommandPresentation {
    if (type !in CRAFT_COMMAND_TYPES) return presentation
    val entry = presentation.entries[feature] ?: return presentation
    val facts = host.craftFacts(type) ?: return presentation
    return BuildingCommandPresentation(presentation.selection, presentation.ordersAllowed, presentation.atMaxLevel,
        presentation.entries + (feature to craftCommandEntry(type, entry, facts)))
}

/**
 * The Lodge rule for the craft doors: every original payload is kept, UPGRADE gives up the designation (its green verb,
 * price pill and time stay) and the projected door is appended last as the single gold primary. An active FINISH or
 * REARM keeps its owner designation; the door then waits just before it as a secondary, so the bar is already in kit
 * order (INFO, secondaries, primary last).
 */
internal fun mergeCraftCommands(bar: CommandBarUi, doors: List<CommandUi>): CommandBarUi {
    val door = doors.firstOrNull() ?: return bar
    val original = bar.commands.map { if (it.id == BuildingCommandIds.UPGRADE) it.copy(primary = false) else it }
    val owner = original.indexOfFirst { it.primary }
    return bar.copy(commands = if (owner >= 0) original.take(owner) + door.copy(primary = false) + original.drop(owner)
        else original + door.copy(primary = true))
}

/** The Home producer with the craft badge provider. [phaseEBuildingCommands] stays the one-argument form for existing
 * callers; the provider is asked only for Workshop, Market and Harvester, and a null answer shows no badge. */
internal fun craftBuildingCommands(dispatcher: HomeRouteDispatcher,
    craftFacts: (String) -> CraftCommandFacts?): PhaseEBuildingCommands {
    val provider = craftFacts
    return object : PhaseEBuildingCommands by phaseEBuildingCommands(dispatcher) {
        override fun craftFacts(type: String): CraftCommandFacts? = if (type in CRAFT_COMMAND_TYPES) provider(type) else null
    }
}
