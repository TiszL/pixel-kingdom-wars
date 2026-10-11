package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandEntry
import gg.pixelkingdomwars.nativeclient.ui.command.BuildingCommandPresentation
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi

/** b47d0a95: the selected-building producer borrows exactly these two C3-owned operations.
 * No registry facts, navigation callback, legacy owner or mutation authority live in this adapter. */
internal interface PhaseEBuildingCommands {
    fun buildingCommandBar(building: Building,
        presentation: BuildingCommandPresentation = BuildingCommandPresentation()): CommandBarUi?
    fun openBuildingDoor(id: FeatureId, selection: BuildingSelection)
    /** craft SPEC §2.0 badge facts of the selected Workshop/Market/Harvester door ([craftBuildingCommands]); null = no badge. */
    fun craftFacts(type: String): CraftCommandFacts? = null
}

internal fun phaseEBuildingCommands(dispatcher: HomeRouteDispatcher): PhaseEBuildingCommands =
    object : PhaseEBuildingCommands {
        override fun buildingCommandBar(building: Building, presentation: BuildingCommandPresentation) =
            dispatcher.buildingCommandBar(building, presentation)
        override fun openBuildingDoor(id: FeatureId, selection: BuildingSelection) = dispatcher.openBuildingDoor(id, selection)
    }

/** The rendered instance, retained through the tap. C3 compares it to its fresh selection before opening anything. */
internal fun phaseEBuildingSelection(baseId: String?, building: Building): BuildingSelection? =
    if (baseId.isNullOrBlank() || building.id.isBlank() || building.type.isBlank()) null
    else BuildingSelection(baseId, building.id, building.type)

internal fun phaseEBuildingFeature(type: String): FeatureId? = when (type) {
    "workshop" -> FeatureId("workshop.craft")
    "market" -> FeatureId("market.trade")
    "harvester" -> FeatureId("harvester.harvest")
    "lodge" -> FeatureId("lodge.expedition")
    "berth" -> FeatureId("berth.fleet")
    // The selected Clan Hall's CLAN door reaches the Home Clan sheet (C3's openBuildingDoor clanhall branch).
    "clanhall" -> FeatureId("clan.open")
    else -> null
}

internal fun phaseEBuildingFeatures(type: String): Set<FeatureId> =
    if (type == "lodge") setOf(FeatureId("lodge.passport"), FeatureId("lodge.expedition"))
    else setOfNotNull(phaseEBuildingFeature(type))

/** Keep the existing payloads and registry admission. Lodge adds Passport before Upgrade and Explore last (5162b8bf).
 * Resolved icons are the existing kit menu assets/glyph, not scene art or a fabricated capability.
 * These doors only navigate; declaring them nonspending does not grant any server/owner gate.
 * [fact] (2026-10-06, commands-4 / commands-5) is the door owner's current observation from the mount: its badge, the
 * COLLECT caption ([BarDoorFact.readyToCollect]), the primary value and timer, and an item icon. It decorates the door
 * only; it never changes the door's admission, state or route. The craft facts ([craftCommandPresentation]) are applied
 * after it, so a known craft badge replaces the fact's badge for Workshop, Market and Harvester.
 * Workshop, Market and Harvester make their door the gold primary (craft SPEC §2.0; [mergeCraftCommands]). */
internal fun mergePhaseEBuildingCommands(bar: CommandBarUi, building: Building, selection: BuildingSelection?,
    host: PhaseEBuildingCommands?, fact: BarDoorFact? = null): CommandBarUi {
    if (host == null || selection == null || bar.buildingId != building.id ||
        selection.buildingId != building.id || selection.type != building.type) return bar
    val feature = phaseEBuildingFeature(building.type) ?: return bar
    val icon = when (building.type) {
        "workshop" -> "ui:workshop-menu"
        "market" -> "ui:market-menu"
        "harvester" -> "ui:harvester-menu"
        "lodge" -> "ui:lodge-menu"
        "berth" -> "shape:anchor"
        "clanhall" -> "itm_banner"
        else -> return bar
    }
    val presentation = BuildingCommandPresentation(selection = selection,
        entries = buildMap {
            put(feature, BuildingCommandEntry(icon = fact?.icon ?: icon, spending = false,
                usableWhileUpgrading = if (building.type == "lodge") GateFact.Allowed else GateFact.Unknown,
                badge = fact?.badge, readyToCollect = fact?.readyToCollect == true, value = fact?.value, timer = fact?.timer))
            if (building.type == "lodge") put(FeatureId("lodge.passport"),
                BuildingCommandEntry(icon = "ui:realm-passport", spending = false, usableWhileUpgrading = GateFact.Allowed))
        })
    val admitted = craftCommandPresentation(presentation, building.type, feature, host)
    val projected = host.buildingCommandBar(building, admitted)?.takeIf { it.buildingId == building.id } ?: return bar
    val existing = bar.commands.map { it.id }.toSet()
    val doors = phaseEBuildingFeatures(building.type)
    val projectedDoors = projected.commands.filter { it.id in doors && it.id !in existing }.distinctBy { it.id }
    if (building.type == "lodge") {
        if (projectedDoors.isEmpty()) return bar
        val explore = projectedDoors.firstOrNull { it.id == feature }
        val passport = projectedDoors.firstOrNull { it.id == FeatureId("lodge.passport") }
        val original = bar.commands.map {
            if (it.id == BuildingCommandIds.UPGRADE) it.copy(primary = false) else it
        }
        // An active FINISH retains its owner designation; never manufacture a new primary during a job.
        val primary = explore?.let { row -> if (original.any { it.primary }) row.copy(primary = false) else row }
        return bar.copy(commands = original.filter { it.id == BuildingCommandIds.INFO } + listOfNotNull(passport) +
            original.filter { it.id != BuildingCommandIds.INFO } + listOfNotNull(primary))
    }
    if (building.type in CRAFT_COMMAND_TYPES) return mergeCraftCommands(bar, projectedDoors)
    val primaryIndex = bar.commands.indexOfFirst { it.primary }
    val additions = projectedDoors
        .map { if (primaryIndex >= 0 && it.primary) it.copy(primary = false) else it }
    if (additions.isEmpty()) return bar
    val insertion = if (primaryIndex >= 0) primaryIndex else bar.commands.size
    return bar.copy(commands = bar.commands.take(insertion) + additions + bar.commands.drop(insertion))
}
