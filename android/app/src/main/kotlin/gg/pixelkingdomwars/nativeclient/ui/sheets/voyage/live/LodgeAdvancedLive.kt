package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*

/** Vehicle-first view over the same validated fleet/routes used by the ordinary send mapper. */
fun lodgeAdvancedUi(i: VoyageLiveInputs, local: LodgeLocalState): AdvancedSendUi {
    val vehicles = installedVehicles(i).filter { it.family != VehicleFamily.STARTER }
    val selected = vehicles.firstOrNull { it.installationId == local.installationId }
        ?: vehicles.firstOrNull { it.status == VehicleStatus.DOCKED && !isWornOut(it) } ?: vehicles.firstOrNull()
    val previews = routePreviews(i)
    val home = homeRealmId(i, previews)
    val available = previews?.get(selected?.installationId).orEmpty()
    val routes = i.policy.routes.orEmpty().mapNotNull { route ->
        val preview = available.firstOrNull { it.prim("routeId") == route.id } ?: return@mapNotNull null
        val mapped = baseRouteUi(route, home, preview)
        RouteRowUi(mapped, voyageIcon(preview.prim("resourceId") ?: ""), voyageAmount(preview.prim("netQuantity")),
            voyageDuration(preview.long("durationSec")), mapped.access == Access.PAID_REALM,
            // send-advanced.png "Needs T4": the same "T<grade>" convention as the SEND vehicle cards (vehicleCardLine).
            if (selected?.tier != null && route.grade > selected.tier) "Needs T${route.grade}" else null)
    }
    val routeId = local.routeId?.takeIf { id -> routes.any { it.route.routeId == id } }
        ?: routes.firstOrNull { it.blockedReason == null }?.route?.routeId
    val raw = available.firstOrNull { it.prim("routeId") == routeId }
    val preview = raw?.let { craftedPreview(it, i.starterView?.rawStock?.associate { row -> row.resourceId to row.available }, i.nowMs, i.zone) }
    return AdvancedSendUi(selected, routes, routeId, preview, preview?.fitting,
        previewState = when { previews == null && i.vehicles?.error == null -> PreviewState.LOADING
            raw == null -> PreviewState.ERROR; else -> PreviewState.READY },
        busy = i.vehicles?.busy == true, pending = pendingDeparture(i),
        lockedReason = sendOrdersReason(i, false) ?: if (i.policy.routes == null) "Crafted routes are not open on this server yet." else null,
        previewError = if (raw == null && previews != null) "No current route preview is available. Check again." else null,
        hasBerth = i.buildings?.any { it.type == BERTH_TYPE && !it.underConstruction } == true)
}

/** A collect response belongs to this explicit tap only if its record is new and binds the selected base. */
fun voyageCollectMatches(record: VehicleRecord?, base: String, priorIds: Set<String>): Boolean =
    record != null && record.kind == "collect" && record.id !in priorIds && record.request.prim("baseId") == base &&
        record.response?.long("returned") != null

fun voyageCollectNeedsCheck(state: VehicleState?, base: String): Boolean = state?.journal?.pending.orEmpty().any {
    it.kind == "collect" && it.request.prim("baseId") == base && it.response == null
}
