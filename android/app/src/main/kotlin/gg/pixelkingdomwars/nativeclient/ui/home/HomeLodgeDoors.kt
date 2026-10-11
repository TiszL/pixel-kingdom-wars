package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSendMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PermitSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyShortName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BERTH_TYPE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLocalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.REALM_RESOURCE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageRealmName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageResourceName
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * The Lodge host's pure door rules (design/final/voyage SPEC §3 send, E1.3 send-advanced, §6 send-locked, §5b collect,
 * E1.2 send-paid). HomeLodgeLiveSheet and HomeVoyageOverlayHost call these; JVM-tested in HomeLodgeDoorsTest and
 * VoyagePermitHonestTest. No Compose, no repository, no clock: every number is the server's or the catalogue's.
 */

/** SEND AGAIN (SPEC §3 Entry, §5b): the route-first SEND (send.png) with the same island, starter route and vehicle. */
internal fun homeLodgeRepeatLocal(trip: TripUi, base: LodgeLocalState): LodgeLocalState = base.copy(tab = LodgeSheetUi.TAB_SEND,
    pickerOpen = false, expandedTripId = null, routeId = trip.route?.routeId, starterRouteId = trip.starterRouteId,
    installationId = trip.vehicle.installationId)

/** The route-first SEND starts on the starter boat only while nothing is chosen; a chosen island keeps its own vehicle rule
 *  (SPEC §3 item 6 default), so CHANGE → an island never falls back to the starter's coast loop. */
internal fun homeLodgeStarterDefault(local: LodgeLocalState, mode: String, starterInstallation: String?): LodgeLocalState =
    if (mode == LodgeSendMode.STARTER && local.installationId == null && local.routeId == null && starterInstallation != null)
        local.copy(installationId = starterInstallation) else local

/** The STARTER · CRAFTED chips (SPEC E1.3): a finished Berth and an observed vehicle policy. A Berth still under
 *  construction docks nothing, so it offers no crafted mode. */
internal fun homeLodgeCraftedOffered(input: VoyageLiveInputs): Boolean =
    input.buildings?.any { it.type == BERTH_TYPE && !it.underConstruction && it.level > 0 } == true && input.policy.tiers != null

/**
 * send-locked BERTH_LOCKED (SPEC §6 variants): "Unlocks at Keep N" from the catalogue's own `BUILD_COSTS.berth.requiresKeepLevel`
 * (the build tray's gate and wording, LiveBuildTrayMapper). Null once any Berth exists or while any of the three facts is unknown.
 */
internal fun homeBerthUnlockReason(catalogue: JsonObject?, keepLevel: Int?, buildings: List<Building>?): String? {
    if (buildings == null || buildings.any { it.type == BERTH_TYPE } || keepLevel == null) return null
    val costs = (catalogue?.get("constants") as? JsonObject)?.get("BUILD_COSTS") as? JsonObject
    val required = ((costs?.get(BERTH_TYPE) as? JsonObject)?.get("requiresKeepLevel") as? JsonPrimitive)?.content?.toIntOrNull()
        ?: return null
    return if (keepLevel < required) "Unlocks at Keep $required" else null
}

/** Every resource is a door (SPEC §6 item 4, §3 supplies GO): it names the realm whose islands bring it home. Takes a raw id
 *  ("heartwood_logs") or an art name ("voyage:heartwood-logs"); anything else asks for an island. */
internal fun homeLodgeResourceLine(resourceId: String?): String {
    val id = resourceId?.substringAfter(':')?.replace('-', '_')
    val realmId = REALM_RESOURCE.entries.firstOrNull { it.value == id }?.key
    return if (id == null || realmId == null) "Choose an island to see what it brings home."
    else "${voyageResourceName(id)} comes home from ${voyageRealmName(realmId)} islands."
}

/** The tall sheet's resource stack (SPEC §0.2 item 4): the chosen trip's supply rows, max 2, only while SEND shows a trip.
 *  Null hands the HUD back its own rows. */
internal fun homeLodgeSupplyStack(ui: LodgeSheetUi, tab: String): List<ResourceChipUi>? =
    ui.supplyStack.take(2).takeIf { tab == LodgeSheetUi.TAB_SEND && ui.send != null && it.isNotEmpty() }

/** The departure toast (SPEC §3 motion 4 step 5), posted only after the server accepted. It names the vehicle and never
 *  states a return time: the trip's time stays on TRIPS, read from the server receipt. */
internal fun homeLodgeDepartureLine(family: VehicleFamily): String = "${familyName(family)} set sail"

/**
 * Whether the starter departure saved under [key] sailed: true once the server's accepted proof for that exact request is
 * saved, false once it was refused or is no longer the saved request, null while its outcome is still being checked. A
 * finished confirm call alone is not acceptance: the owner keeps refusals and lost answers as its own notices.
 */
internal fun homeStarterSailed(state: StarterExpeditionState?, key: String): Boolean? {
    val journal = state?.journal ?: return null
    val operation = journal.operation?.takeIf { it.command.key == key }
    return when {
        operation?.proof != null -> true
        journal.archives.any { it.reason == "accepted" && it.operation.command.key == key } -> true
        operation == null || operation.refusal != null -> false
        else -> null
    }
}

/**
 * The paid SEND Seal while no Home owner sells realm permits (send-paid.png UNAVAILABLE state, SPEC E1.2): no price, no
 * duration and no realm cut are claimed, because none was quoted. BUY & SEND stays off; nothing is requested or paid.
 */
internal fun homeLodgeUnavailablePermit(route: RouteUi, family: VehicleFamily, nowMs: Long): PermitSealUi = PermitSealUi(
    route.realmName, PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE), null, null, "", familyShortName(family), nowMs, route,
    unavailableLine = "Permit purchases are not available from the Lodge yet. Your vehicle stays at the Berth.",
    note = "No payment or departure has been requested.")
