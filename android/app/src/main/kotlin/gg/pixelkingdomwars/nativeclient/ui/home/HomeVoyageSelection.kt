package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.Composable
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BuildingCommandIds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.NamePlateUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BERTH_TYPE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LODGE_TYPE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.fleetRows
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.installedVehicles
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.starterKnownAbsent
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageDuration

/*
 * The voyage half of the selected-building UI on Home (voyage SPEC §1 `lodge-selected.png`, §10 entry for the Berth;
 * DESIGN-SYSTEM §6 Selection). It decorates the bar and plate the existing producers made (buildingCommandBar /
 * buildingNamePlate, both read only here) and never changes a command's state:
 * - Lodge NamePlate line 2: "2 at sea · back 1h 12m", "Ready · 1 back", "All docked", "No boat yet" (a job line wins).
 * - Lodge EXPLORE badge: red count at sea, green "!" when a trip is back; with a collect owner mounted, the enabled
 *   EXPLORE becomes COLLECT (ready-status icon), which collects in place without opening the sheet.
 * - Berth: FLEET is the gold primary (UPGRADE steps back, as on the Lodge) and carries the green "!" while the starter
 *   boat is not installed.
 * Every count is the server's own trips; a side that is not known yet never becomes "No boat yet" or "All docked".
 */

private val LODGE_EXPLORE = FeatureId("lodge.expedition")
private val BERTH_FLEET = FeatureId("berth.fleet")
private const val COLLECT_CAPTION = "COLLECT"

/**
 * What the Lodge/Berth selection needs from the voyage owners (SPEC §1 `LodgeSelectionUi`). [nextBackIn] is the
 * soonest positive return ("1h 12m"), null when none is known. [starterInstalled] is null while the starter side is
 * unknown. [complete] is true only when both the starter flights and the crafted fleet of this base are known: only
 * then may "All docked" or "No boat yet" be said.
 */
internal data class VoyageSelectionUi(
    val atSea: Int,
    val ready: Int,
    val nextBackIn: String?,
    val anyVehicle: Boolean,
    val starterInstalled: Boolean?,
    val collectAvailable: Boolean,
    val complete: Boolean,
    /** Trips at sea whose scheduled return has passed (the server has not been read since): "due back", never "back …". */
    val due: Int = 0,
)

/** The selection facts for [input]; null while neither the starter side nor the crafted fleet is known. */
internal fun voyageSelectionUi(input: VoyageLiveInputs, collectAvailable: Boolean): VoyageSelectionUi? {
    val craftedSeen = fleetRows(input.vehicles, input.baseId) != null || input.vehicles?.unavailable != null
    if (input.starterView == null && input.starterFleetView == null && !craftedSeen) return null
    val trips = homeVoyageTrips(input)
    val vehicles = installedVehicles(input)
    val starterInstalled = when {
        vehicles.any { it.family == VehicleFamily.STARTER } -> true
        starterKnownAbsent(input) -> false
        else -> null
    }
    // A starter flight is only known from the expedition view (or when no starter boat exists at all).
    val starterFlightsKnown = input.starterView != null || starterInstalled == false
    val next = trips.filter { it.state == TripState.AT_SEA }.mapNotNull { it.secondsLeft }.filter { it > 0 }.minOrNull()
    return VoyageSelectionUi(
        atSea = trips.count { it.state == TripState.AT_SEA },
        ready = trips.count { it.state == TripState.READY },
        nextBackIn = next?.let(::voyageDuration),
        anyVehicle = vehicles.isNotEmpty(),
        starterInstalled = starterInstalled,
        collectAvailable = collectAvailable,
        complete = starterFlightsKnown && craftedSeen,
        due = trips.count { it.state == TripState.AT_SEA && it.secondsLeft == 0L },
    )
}

/** [voyageSelectionUi] for the selected base; a collect owner is available exactly when Home provides one. */
@Composable internal fun rememberVoyageSelection(buildings: List<Building>?, baseId: String?): VoyageSelectionUi? {
    val input = rememberHomeVoyageInputs(buildings, baseId)
    return voyageSelectionUi(input, collectAvailable = LocalHomeVoyageReturnAction.current != null)
}

/** The Lodge plate's trip line (SPEC §1 states), or null when it cannot be said truthfully yet. READY wins: it is the
 *  line the player can act on (the bar's primary is COLLECT then). */
internal fun lodgeTripLine(selection: VoyageSelectionUi): String? = when {
    selection.ready > 0 -> "Ready · ${selection.ready} back"
    selection.atSea > 0 -> "${selection.atSea} at sea · " +
        (selection.nextBackIn?.let { "back $it" } ?: if (selection.due > 0) "due back" else "back $UNKNOWN")
    !selection.complete -> null
    selection.anyVehicle -> "All docked"
    else -> "No boat yet"
}

/** The Lodge plate with its trip line (SPEC §1 line 2). A building job line (Upgrading, Building) keeps priority;
 *  other buildings and an unknown snapshot leave the plate as it is. */
internal fun voyageNamePlate(plate: NamePlateUi, building: Building, selection: VoyageSelectionUi?): NamePlateUi {
    if (building.type != LODGE_TYPE || selection == null || plate.stateLine != null) return plate
    val line = lodgeTripLine(selection) ?: return plate
    return plate.copy(stateLine = line)
}

/** The bar of a selected Lodge or Berth with the voyage badges, the COLLECT swap and the Berth's FLEET primary. Any
 *  other building, or a bar for another building, is returned unchanged. */
internal fun voyageCommandBar(bar: CommandBarUi, building: Building, selection: VoyageSelectionUi?): CommandBarUi {
    if (bar.buildingId != building.id) return bar
    return when (building.type) {
        LODGE_TYPE -> lodgeBar(bar, selection)
        BERTH_TYPE -> berthBar(bar, selection)
        else -> bar
    }
}

/** SPEC §1: the EXPLORE badge and the COLLECT swap. Primary and state stay exactly as the producer set them (an active
 *  FINISH keeps its primary; a disabled EXPLORE never turns into an enabled COLLECT). */
private fun lodgeBar(bar: CommandBarUi, selection: VoyageSelectionUi?): CommandBarUi {
    if (selection == null) return bar
    return bar.copy(commands = bar.commands.map { command ->
        if (command.id != LODGE_EXPLORE) command else {
            val badge = when {
                selection.ready > 0 -> BadgeUi("!", BadgeTone.READY, "A trip is back")
                selection.atSea > 0 -> badgeCount(selection.atSea)?.let { BadgeUi(it, BadgeTone.COUNT, "${selection.atSea} at sea") }
                else -> command.badge
            }
            val collects = selection.ready > 0 && selection.collectAvailable && command.state == CommandState.ENABLED
            if (collects) command.copy(caption = COLLECT_CAPTION, icon = VOYAGE_READY_ICON, badge = badge) else command.copy(badge = badge)
        }
    })
}

/**
 * SPEC §10 entry: "The Berth's command bar shows a gold FLEET★ with a green ! badge". FLEET becomes the primary and
 * UPGRADE steps back (the Lodge rule in PhaseEBuildingCommands), unless a job owns the primary (FINISH, REARM or any
 * other non-UPGRADE primary). The "!" shows only while the starter boat is known to be not installed.
 */
private fun berthBar(bar: CommandBarUi, selection: VoyageSelectionUi?): CommandBarUi {
    val fleet = bar.commands.firstOrNull { it.id == BERTH_FLEET } ?: return bar
    val badge = if (selection?.starterInstalled == false) BadgeUi("!", BadgeTone.READY, "Starter Boat waiting") else fleet.badge
    val job = bar.commands.any { it.id == BuildingCommandIds.FINISH || it.id == BuildingCommandIds.REARM }
    val otherPrimary = bar.commands.any { it.primary && it.id != BERTH_FLEET && it.id != BuildingCommandIds.UPGRADE }
    if (job || otherPrimary) return bar.copy(commands = bar.commands.map { if (it.id == BERTH_FLEET) it.copy(badge = badge) else it })
    val rest: List<CommandUi> = bar.commands.filter { it.id != BERTH_FLEET }
        .map { if (it.id == BuildingCommandIds.UPGRADE) it.copy(primary = false) else it }
    // The primary goes last (the right thumb), as the kit's orderCommands draws it.
    return bar.copy(commands = rest + fleet.copy(primary = true, badge = badge))
}

/** True when a tap on [id] is the Lodge's swapped COLLECT (SPEC §1: "collects in place without opening the sheet").
 *  Only the enabled command this file renamed qualifies; EXPLORE and every other command keep their own route. */
internal fun voyageCommandCollects(id: FeatureId, bar: CommandBarUi?): Boolean {
    if (id != LODGE_EXPLORE) return false
    val command = bar?.commands?.firstOrNull { it.id == id } ?: return false
    return command.caption == COLLECT_CAPTION && command.state == CommandState.ENABLED
}
