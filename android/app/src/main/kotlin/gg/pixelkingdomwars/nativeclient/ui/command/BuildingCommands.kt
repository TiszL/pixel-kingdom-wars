package gg.pixelkingdomwars.nativeclient.ui.command

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureIconState
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureProjection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSurface
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.features.GateResult
import gg.pixelkingdomwars.nativeclient.ui.features.HostKind
import gg.pixelkingdomwars.nativeclient.ui.features.check
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Collections

/**
 * Rule 7 (2026-10-06): the Home bar's producer is `ui/kingdom/BuildingCommandAdapter.kt`; this projection is only where it borrows the Phase E doors.
 *
 * Pure selected-building projection. No callback, navigation or mutation is performed.
 * The owner of a tapped FeatureId must revalidate its fresh context before dispatch.
 *
 * `building.jobRunning` is an admitted selected-building construction/upgrade fact;
 * training, research, crafting and trip queues remain separate owner observations.
 * This function does not classify a raw job, infer a wire flag or calculate a cap.
 */
fun buildingCommands(
    building: Building,
    ctx: GateContext,
    registry: FeatureRegistry,
    presentation: BuildingCommandPresentation = BuildingCommandPresentation(),
): CommandBarUi {
    val selection = ctx.selection.building
    if (selection == null || selection.baseId != ctx.baseId ||
        selection.buildingId != building.id || selection.type != building.type
    ) return CommandBarUi(building.id, emptyList())

    // Never retain a stale icon, price, readiness, badge or permission from another selection.
    val current = presentation.takeIf { it.selection == selection } ?: BuildingCommandPresentation()
    val complete = building.level > 0 && !building.underConstruction
    val upgrading = complete && ctx.ownerFacts["building.jobRunning"] == GateFact.Allowed
    val maxed = current.atMaxLevel == GateFact.Allowed

    val rows = registry.forSurface(HostKind.BUILDING, building.type, FeatureSurface.COMMAND, ctx)
        .filter { it.visible }
        // Completion of another instance of this type cannot unlock the selected construction.
        .filter { complete || it.feature.id == INFO || it.feature.id == FINISH }
        .filter { !maxed || it.feature.id != UPGRADE }
    // Beacon5ed31eb8: a visual designation survives its feature being locked.
    // Conditional primaryGate still selects the current canonical command; it is
    // not replaced by a type-specific priority or by FeatureProjection.enabled.
    val designations = rows.filter { it.feature.primary && it.feature.primaryGate.check(ctx) == GateResult.Pass }
    val conflict = designations.size > 1
    val primaryId = if (current.ordersAllowed is GateFact.Denied || conflict) null
        else designations.singleOrNull()?.feature?.id
    val commands = rows.mapNotNull { projectCommand(it, current, upgrading, primaryId) }

    val primaryResolved = if (conflict) commands else maxLevelFallback(commands, building.type, complete, current)
    return CommandBarUi(building.id, orderedCommands(primaryResolved))
}

private fun projectCommand(
    row: FeatureProjection,
    presentation: BuildingCommandPresentation,
    upgrading: Boolean,
    visualPrimary: FeatureId?,
): CommandUi? {
    val feature = row.feature
    val entry = presentation.entries[feature.id] ?: BuildingCommandEntry()
    val icon = when {
        entry.icon != null -> entry.icon.takeIf { it.isNotBlank() }
        feature.icon.state == FeatureIconState.RESOLVED -> feature.icon.key?.takeIf { it.isNotBlank() }
        else -> null // Source asset names, dynamic candidates and shape contracts are not resolver admission.
    } ?: return null

    val isInfo = feature.id == INFO
    val spending = !isInfo && entry.spending
    val availability = when {
        !row.enabled -> Availability(CommandState.LOCKED,
            (row.gate as? GateResult.Locked)?.reason ?: "This feature is not available")
        isInfo -> Availability(CommandState.ENABLED)
        spending && presentation.ordersAllowed is GateFact.Denied ->
            Availability(CommandState.DISABLED, presentation.ordersAllowed.reason)
        spending && presentation.ordersAllowed == GateFact.Unknown ->
            Availability(CommandState.LOCKED, "Checking whether orders are available")
        upgrading && !isInfo && feature.id != FINISH && entry.usableWhileUpgrading != GateFact.Allowed ->
            Availability(CommandState.DISABLED, "Upgrading")
        entry.price?.status == PriceStatus.UNAVAILABLE ->
            Availability(CommandState.DISABLED, "Price unavailable")
        entry.busy -> Availability(CommandState.BUSY)
        else -> Availability(CommandState.ENABLED)
    }
    val caption = when {
        entry.readyToCollect && feature.id in COLLECT_CAPTION_OWNERS -> "COLLECT"
        feature.id == LODGE_EXPEDITION -> "EXPLORE" // Final voyage/buildings SPEC: visible label only.
        else -> feature.title
    }
    val command = CommandUi(
        id = feature.id,
        icon = icon,
        caption = caption,
        price = if (isInfo) null else entry.price,
        primary = feature.id == visualPrimary,
        state = availability.state,
        reason = availability.reason,
        badge = entry.badge,
        verb = when (feature.id) {
            INFO -> Verb.BLUE
            UPGRADE -> Verb.GREEN
            else -> Verb.STONE
        },
        sub = entry.sub,
        iconSecondary = entry.iconSecondary?.takeIf { it.isNotBlank() },
        value = entry.value,
        timer = entry.timer,
    )
    // Kit price drawing runs after admission; it cannot reopen a locked, disabled or busy command.
    val drawState = commandDrawState(command)
    return if (drawState == command.state) command else command.copy(state = drawState)
}

private fun maxLevelFallback(
    commands: List<CommandUi>,
    type: String,
    complete: Boolean,
    presentation: BuildingCommandPresentation,
): List<CommandUi> {
    if (!complete || presentation.atMaxLevel != GateFact.Allowed ||
        presentation.ordersAllowed != GateFact.Allowed || commands.any { it.primary }
    ) return commands

    // Only the explicitly specified max-level fallbacks; never promote a locked type action.
    val fallback = when {
        type == "keep" -> commands.singleOrNull { it.id == KEEP_STORES && it.state == CommandState.ENABLED }
        commands.all { it.id == INFO } -> commands.singleOrNull { it.id == INFO && it.state == CommandState.ENABLED }
        else -> null
    } ?: return commands
    return commands.map { if (it.id == fallback.id) it.copy(primary = true) else it }
}

/** Registry order is already stable. Reserve INFO and the one primary before trimming secondaries. */
private fun orderedCommands(commands: List<CommandUi>): List<CommandUi> {
    val primary = commands.singleOrNull { it.primary }
    val info = commands.singleOrNull { it.id == INFO && it.id != primary?.id }
    val secondary = commands.filter { it.id != primary?.id && it.id != info?.id }
    val available = PkwTokens.Budget.MAX_COMMANDS_PORTRAIT -
        (if (info != null) 1 else 0) - (if (primary != null) 1 else 0)
    val result = buildList {
        if (info != null) add(info)
        addAll(secondary.take(available))
        if (primary != null) add(primary)
    }
    return Collections.unmodifiableList(ArrayList(result))
}

private data class Availability(val state: CommandState, val reason: String? = null)

private val INFO = FeatureId("building.info")
private val UPGRADE = FeatureId("building.upgrade")
private val FINISH = FeatureId("building.finish")
private val KEEP_STORES = FeatureId("keep.stores")
private val LODGE_EXPEDITION = FeatureId("lodge.expedition")
private val COLLECT_CAPTION_OWNERS = setOf(
    FeatureId("workshop.craft"), LODGE_EXPEDITION, FeatureId("market.trade"), FeatureId("harvester.harvest"),
)
