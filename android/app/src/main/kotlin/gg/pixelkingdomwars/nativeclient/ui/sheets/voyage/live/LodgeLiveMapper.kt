package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRoute
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionView
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.Access
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ChartMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ChartTripUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.CollectActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.CollectState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.CollectUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.FittingUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.IslandTileState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeLockedActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeLockedUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeLockedVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgePickerActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgePickerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSendActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSendUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeTripsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeTripsUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PendingDepartureUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PermitUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PreviewState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PreviewUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RewardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteFilter
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.StarterRouteUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.SupplyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripRef
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageChartUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageResourceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.defaultVehicle
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyShortName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.gradeNumeral
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.isWornOut
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.islandTileState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.orderTrips
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.tripsSummary
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoute
import java.math.BigInteger
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/*
 * LIVE mapper of the Lodge sheet (K/ui/sheets/voyage/LodgeSheet.kt: SEND · CHOOSE AN ISLAND · locked SEND · TRIPS, the
 * VoyageChart header and the collect card VoyageCollectCard.kt). State source: [VoyageLiveInputs] — the starter
 * expedition + starter fleet repositories' states and the crafted `VehicleState` (fleet, route previews, journal), plus
 * the policy's island catalogue. Pure: the host re-calls it on every state emission and every 5 s while a trip is at sea.
 *
 * What is never invented here: durations, cargo, supplies, trips left and permit prices are the server's own figures,
 * formatted; an unknown one reads "…". Starter trips return automatically (the server credits them), so only crafted
 * trips ever become READY / collectable. Every money step (a realm permit, a paid starter realm) is refused by the
 * Actions stub with [VOYAGE_MONEY_PENDING] until MS-M3 wires the Seal.
 */

/** The Lodge's local, non-server state (the host keeps it in SavedStateHandle; Destination.Lodge seeds tab + routeId). */
data class LodgeLocalState(
    /** "SEND", "UNDER_WAY" or "PASSPORT" (LodgeSheetUi tab ids). */
    val tab: String = LodgeSheetUi.TAB_SEND,
    /** The chosen island (Destination `routeId`, a picker tap, collect SEND AGAIN). */
    val routeId: String? = null,
    /** The chosen starter route ("coastal_survey") in starter mode. */
    val starterRouteId: String? = null,
    /** The player's own vehicle pick; null lets [defaultVehicle] choose. */
    val installationId: String? = null,
    /** CHANGE was tapped: CHOOSE AN ISLAND shows over SEND. */
    val pickerOpen: Boolean = false,
    val filter: RouteFilter = RouteFilter.ALL,
    val expandedTripId: String? = null,
    /** The COLLECT request as the host tracks it. */
    val collectState: CollectState = CollectState.IDLE,
)

// ---------- the sheet ----------

/** The whole Lodge sheet for [i] and the player's [local] choices. */
fun lodgeSheetUi(i: VoyageLiveInputs, local: LodgeLocalState): LodgeSheetUi {
    val vehicles = installedVehicles(i)
    val previews = routePreviews(i)
    val home = homeRealmId(i, previews)
    val baseRoutes = i.policy.routes?.map { baseRouteUi(it, home, anyPreview(previews, it.id)) }
    val routeIndex = baseRoutes.orEmpty().associateBy { it.routeId }
    val trips = lodgeTrips(i, vehicles, routeIndex)
    val routes = baseRoutes?.map { withMyTrip(it, trips) }
    val locked = lodgeLockedUi(i, vehicles)
    val send = if (locked != null) null else lodgeSendUi(i, local, vehicles, routes.orEmpty(), previews)
    val picker = if (locked != null || send == null) null else lodgePickerUi(local, vehicles, routes, send)
    val tripsUi = lodgeTripsUi(i, local, vehicles, trips)
    val chart = lodgeChartUi(send, tripsUi, local.tab, locked = locked != null, lodgeTier = lodgeArtTier(i.buildings))
    return LodgeSheetUi(
        level = voyageLevelTag(i.buildings, LODGE_TYPE),
        tab = local.tab,
        // send-locked.png: the empty sea still shows the nearest home-realm Grade I island (never a blank header).
        chart = if (chart.mode == ChartMode.EMPTY && chart.route == null) chart.copy(route = nearestHomeIsland(routes)) else chart,
        send = send,
        picker = picker,
        locked = locked,
        trips = tripsUi,
        supplyStack = supplyStack(send),
        history = hasLodgeHistory(i, trips),
    )
}

// ---------- vehicles ----------

/** Every installed vehicle of this base: the starter boat first, then crafted ones in quay order. */
internal fun installedVehicles(i: VoyageLiveInputs): List<VehicleUi> {
    val installation = i.starterFleetView?.installation ?: i.starterView?.installation
    val flightBack = i.starterView?.flight?.takeIf { it.installationId == installation?.installationId }?.returnsAt
    val starter = installation?.let { starterVehicle(it, flightBack, i.nowMs) }
    val records = expeditionRecords(i.vehicles, i.baseId)
    // Crafted vehicles switched off on this server: none can sail, so SEND and CAN SAIL count the starter boat alone.
    val crafted = (if (i.vehicles?.unavailable != null) null else fleetRows(i.vehicles, i.baseId)).orEmpty()
        .mapNotNull { craftedVehicle(it, i.policy.tripsPerInstall, records, i.nowMs) }
        .sortedBy { it.family.ordinal }
    return listOfNotNull(starter) + crafted
}

/** True when the starter side is known to hold no starter boat (a view for this base says so). */
internal fun starterKnownAbsent(i: VoyageLiveInputs): Boolean =
    (i.starterFleetView != null || i.starterView != null) && (i.starterFleetView?.installation ?: i.starterView?.installation) == null

/** True when the crafted side is known: no vehicle client on this build, the server says crafted vehicles are not open
 *  (none can be used, so the locked SEND may say "No boat at the Berth yet"), or a fleet snapshot for this base. */
internal fun craftedKnown(i: VoyageLiveInputs): Boolean =
    i.vehicles == null || i.vehicles?.unavailable != null || fleetRows(i.vehicles, i.baseId) != null

// ---------- routes ----------

/** `/vehicles/client/routes` for this base: installationId → its server previews; null while there is no snapshot. */
internal fun routePreviews(i: VoyageLiveInputs): Map<String, List<JsonObject>>? {
    val routes = i.vehicles?.routes ?: return null
    if (i.baseId == null || routes.prim("baseId") != i.baseId) return null
    return routes.children("items").mapNotNull { item -> item.prim("installationId")?.let { it to item.children("previews") } }.toMap()
}

private fun anyPreview(previews: Map<String, List<JsonObject>>?, routeId: String): JsonObject? =
    previews?.values?.firstNotNullOfOrNull { list -> list.firstOrNull { it.prim("routeId") == routeId } }

/** The kingdom's HOME realm: the server previews' `homeRealmId`, else the starter view's home; null when unknown. */
internal fun homeRealmId(i: VoyageLiveInputs, previews: Map<String, List<JsonObject>>?): String? =
    previews?.values?.flatten()?.firstNotNullOfOrNull { it.prim("homeRealmId") } ?: i.starterView?.home?.realmId

/**
 * One catalogue island → [RouteUi] (without `myTrip`). Access is the server preview's `accessRequirement` when one exists,
 * else HOME exactly when the realm is the kingdom's home. A PAID_REALM island carries a permit reason: the permit is a
 * SOL purchase, so it is [VOYAGE_MONEY_PENDING] until MS-M3; with the home realm unknown, every island is held as
 * PAID_REALM "Checking your home realm" (never shown as free before the server says so).
 */
internal fun baseRouteUi(r: OrdinaryRoute, homeRealmId: String?, preview: JsonObject?): RouteUi {
    val resource = preview?.prim("resourceId") ?: REALM_RESOURCE[r.realmId] ?: ""
    val access = when (preview?.prim("accessRequirement")) {
        "home" -> Access.HOME
        "paid_realm" -> Access.PAID_REALM
        else -> if (homeRealmId != null && homeRealmId == r.realmId) Access.HOME else Access.PAID_REALM
    }
    val permitReason = when {
        access == Access.HOME -> null
        homeRealmId == null && preview == null -> HOME_REALM_CHECKING
        else -> VOYAGE_MONEY_PENDING
    }
    return RouteUi(r.id, r.chain, r.index, routeDisplayName(r.id), r.realmId, voyageRealmName(r.realmId), resource,
        r.grade.toInt(), access, null,
        resourceIcon = if (resource.isEmpty()) "" else voyageIcon(resource),
        resourceName = if (resource.isEmpty()) UNKNOWN else voyageResourceName(resource),
        permitReason = permitReason)
}

/** The hold reason of every non-home island while the kingdom's home realm is not known yet. */
internal const val HOME_REALM_CHECKING = "Checking your home realm"

private fun withMyTrip(route: RouteUi, trips: List<TripUi>): RouteUi {
    val mine = trips.firstOrNull { it.route?.routeId == route.routeId && it.state != TripState.COLLECTED } ?: return route
    return route.copy(myTrip = TripRef(mine.tripId, mine.state))
}

// ---------- trips ----------

/** Every trip of this base: the starter's flight (if any) and every crafted expedition with a server receipt. */
internal fun lodgeTrips(i: VoyageLiveInputs, vehicles: List<VehicleUi>, routes: Map<String, RouteUi>): List<TripUi> {
    val starter = i.starterView?.let { view -> starterTrip(view, vehicles.firstOrNull { it.family == VehicleFamily.STARTER }, i.nowMs, i.zone) }
    val crafted = expeditionRecords(i.vehicles, i.baseId).mapNotNull { craftedTrip(it, vehicles, routes, i.nowMs, i.zone) }
    return listOfNotNull(starter) + crafted
}

/** The starter's current flight. Starter returns are automatic: past its scheduled time it stays AT_SEA with
 *  "Due back · checking" until the next starter snapshot drops the flight; it never becomes a COLLECT. */
internal fun starterTrip(view: StarterExpeditionView, starter: VehicleUi?, nowMs: Long, zone: ZoneId): TripUi? {
    val f = view.flight ?: return null
    val vehicle = starter ?: VehicleUi(VehicleFamily.STARTER, null, f.installationId, "", VehicleStatus.AWAY, null, null, null, 0)
    val left = secondsLeft(f.returnsAt, nowMs)
    return TripUi(
        tripId = f.expeditionId,
        vehicle = vehicle,
        route = null,
        starterRouteId = f.route.routeId,
        progress = tripProgress(f.departedAt, f.returnsAt, nowMs),
        returnsAt = if (left == 0L) null else voyageDuration(left),
        state = TripState.AT_SEA,
        expected = starterRewards(f.route),
        returned = null,
        title = voyageRealmName(f.route.routeId),
        secondsLeft = left,
        dueChecking = left == 0L,
        departedLine = isoMs(f.departedAt)?.let { "Sailed ${localClock(it, zone)}" },
    )
}

/**
 * One crafted expedition record → [TripUi]. No receipt (request in flight / outcome unknown) is not a trip — it is the
 * SEND panel's pending departure. A server `return` is COLLECTED; a receipt past its scheduled return with no `return`
 * yet is READY: the COLLECT request is what turns it into a return (VehicleScreen "collect completed expeditions").
 */
internal fun craftedTrip(r: VehicleRecord, fleet: List<VehicleUi>, routes: Map<String, RouteUi>, nowMs: Long, zone: ZoneId): TripUi? {
    val response = r.response ?: return null
    val receipt = response.child("receipt") ?: return null
    val route = receipt.child("route")
    val ret = response.child("return")
    val installationId = receipt.prim("installationId") ?: return null
    val left = secondsLeft(receipt.prim("returnsAt"), nowMs)
    val state = when {
        ret != null -> TripState.COLLECTED
        left == 0L -> TripState.READY
        else -> TripState.AT_SEA
    }
    val vehicle = fleet.firstOrNull { it.installationId == installationId } ?: run {
        val family = vehicleFamilyOf(route?.prim("family"))?.takeIf { it != VehicleFamily.STARTER } ?: return null
        val tier = route?.long("tier")?.toInt()
        VehicleUi(family, tier, installationId, "", if (state == TripState.AT_SEA) VehicleStatus.AWAY else VehicleStatus.DOCKED,
            null, null, null, tier ?: 0)
    }
    val routeId = route?.prim("routeId")
    val routeUi = routeId?.let { routes[it] }
    return TripUi(
        tripId = receipt.prim("expeditionId") ?: r.key,
        vehicle = vehicle,
        route = routeUi,
        starterRouteId = null,
        progress = tripProgress(receipt.prim("departedAt"), receipt.prim("returnsAt"), nowMs),
        returnsAt = if (state == TripState.AT_SEA) voyageDuration(left) else null,
        state = state,
        expected = routeRewards(route, route?.child("secondaryOutput")),
        returned = ret?.let { routeRewards(route, it.child("secondaryOutput")) },
        title = routeUi?.displayName ?: routeId?.let(::routeDisplayName) ?: UNKNOWN,
        secondsLeft = left,
        departedLine = isoMs(receipt.prim("departedAt"))?.let { "Sailed ${localClock(it, zone)}" },
    )
}

/** What a starter route brings: its net cargo, plus the fitted secondary output when the server lists one. */
internal fun starterRewards(route: StarterExpeditionRoute): List<RewardUi> = listOfNotNull(
    RewardUi(route.resourceId, voyageAmount(route.netQuantity), RewardUi.Kind.CARGO, voyageIcon(route.resourceId), voyageResourceName(route.resourceId)),
    route.secondaryOutput?.let { RewardUi(it.resourceId, voyageAmount(it.netQuantity), RewardUi.Kind.SURVEY_FIND, voyageIcon(it.resourceId), voyageResourceName(it.resourceId)) },
)

// ---------- SEND ----------

/** What SEND has chosen: starter mode (coast routes), the island, the vehicle. */
internal data class LodgeSelection(val starterMode: Boolean, val route: RouteUi?, val vehicle: VehicleUi?)

/**
 * The selection rule (SPEC §3 item 6, §3a): the player's own vehicle pick wins; an island chosen without a pick defaults
 * with [defaultVehicle]; a starter route, or a kingdom whose only vehicle is the starter boat, is starter mode.
 */
internal fun lodgeSelection(local: LodgeLocalState, vehicles: List<VehicleUi>, routes: List<RouteUi>): LodgeSelection {
    val picked = local.installationId?.let { id -> vehicles.firstOrNull { it.installationId == id } }
    val route = local.routeId?.let { id -> routes.firstOrNull { it.routeId == id } }
    val starter = vehicles.firstOrNull { it.family == VehicleFamily.STARTER }
    val crafted = vehicles.filter { it.family != VehicleFamily.STARTER }
    val starterMode = when {
        picked != null -> picked.family == VehicleFamily.STARTER
        route != null -> false
        local.starterRouteId != null -> starter != null
        else -> crafted.isEmpty() && starter != null
    }
    val vehicle = when {
        picked != null -> picked
        starterMode -> starter
        route != null -> defaultVehicle(vehicles, route.grade)
        else -> null
    }
    return LodgeSelection(starterMode, if (starterMode) null else route, vehicle)
}

/**
 * SPEC §3a segment labels. Order: COAST, LONG, INTRO, then the `common_<realm>` routes the server advertises. The server
 * advertises all eight commons; each one sails to another realm and brings that realm's resource, so it is named by its
 * realm and carries that resource's icon (morning gap audit: eight chips all reading "COMMON" were indistinguishable).
 */
internal fun starterRouteChoices(view: StarterExpeditionView?): List<StarterRouteUi> {
    val routes = view?.routes.orEmpty().filter { !it.routeId.startsWith("paid_") }
    fun rank(id: String) = when (id) { "coastal_survey" -> 0; "long_survey" -> 1; "introduction" -> 2; else -> 3 }
    return routes.sortedWith(compareBy<StarterExpeditionRoute> { rank(it.routeId) }.thenBy { it.routeId }).map {
        val label = when (it.routeId) { "coastal_survey" -> "COAST"; "long_survey" -> "LONG"; "introduction" -> "INTRO"
            else -> voyageRealmName(it.realmId) }
        val name = if (rank(it.routeId) < 3) voyageRealmName(it.routeId)
            else "${voyageRealmName(it.realmId)} · ${voyageResourceName(it.resourceId)}"
        StarterRouteUi(it.routeId, label, name, icon = voyageIcon(it.resourceId), common = rank(it.routeId) == 3)
    }
}

/** The SEND panel. */
internal fun lodgeSendUi(i: VoyageLiveInputs, local: LodgeLocalState, vehicles: List<VehicleUi>, routes: List<RouteUi>,
    previews: Map<String, List<JsonObject>>?): LodgeSendUi {
    val sel = lodgeSelection(local, vehicles, routes)
    val view = i.starterView
    val haves = view?.rawStock?.associate { it.resourceId to it.available }
    val starterChoices = if (sel.starterMode) starterRouteChoices(view) else null
    val starterRouteId = starterChoices?.let { list ->
        local.starterRouteId?.takeIf { id -> list.any { it.id == id } } ?: list.firstOrNull()?.id
    }
    val vehicleId = sel.vehicle?.installationId
    val islandId = sel.route?.routeId
    var previewError: String? = null
    val (preview, previewState) = when {
        sel.starterMode -> {
            val route = view?.routes?.firstOrNull { it.routeId == starterRouteId }
            when {
                view == null -> null to PreviewState.LOADING
                route == null -> { previewError = "This route isn't offered right now. Refresh to check again."; null to PreviewState.ERROR }
                else -> starterPreview(route, i.nowMs, i.zone) to PreviewState.READY
            }
        }
        islandId == null || vehicleId == null -> null to PreviewState.READY
        else -> {
            val p = previews?.get(vehicleId)?.firstOrNull { it.prim("routeId") == islandId }
            when {
                p != null -> craftedPreview(p, haves, i.nowMs, i.zone) to PreviewState.READY
                previews == null && i.vehicles?.error == null -> null to PreviewState.LOADING
                else -> {
                    previewError = i.vehicles?.error?.takeIf { previews == null } ?: "The Lodge can't reach the route chart. Try again."
                    null to PreviewState.ERROR
                }
            }
        }
    }
    // Morning gap audit: a chosen vehicle that is at sea, in service or worn out cannot sail now, so SEND says why (SPEC E1.3
    // "vehicle away: SEND X 'Back in 1h 12m'"). Before, the starter boat at sea left SEND gold and a tap only explained later.
    val ordersReason = sendOrdersReason(i, sel.starterMode) ?: sendVehicleReason(sel.vehicle)
    return LodgeSendUi(
        routes = routes,
        selectedRouteId = sel.route?.routeId,
        vehicles = vehicles,
        selectedInstallationId = sel.vehicle?.installationId,
        preview = preview,
        previewState = previewState,
        starterRoutes = starterChoices,
        ordersAllowed = ordersReason == null,
        pending = pendingDeparture(i),
        selectedStarterRouteId = starterRouteId,
        // "Sending" only while a departure of this kingdom is actually in flight; a routine read of the owner is not one.
        busy = departureInFlight(i, sel.starterMode),
        lockedReason = if (sel.starterMode && i.starter == null) "Expeditions are not open on this server yet" else null,
        ordersReason = ordersReason,
        previewError = previewError,
    )
}

/** Why the chosen vehicle cannot sail right now (at sea, in service, no trips left); null when it can or none is chosen. */
internal fun sendVehicleReason(vehicle: VehicleUi?): String? = when (vehicle?.status) {
    VehicleStatus.AWAY -> vehicle?.returnsAt.let { back -> if (back == DUE_BACK) "$DUE_BACK · checking" else "Back in ${back ?: UNKNOWN}" }
    VehicleStatus.BUSY_SERVICE -> "In service at the Berth"
    VehicleStatus.WORN_OUT -> "No trips left · service it at the Berth"
    else -> null
}

/** [backInText]'s word once a scheduled return has passed. */
internal const val DUE_BACK = "Due back"

/**
 * True only while a departure of this kingdom is in flight: the starter owner is confirming its reviewed request (the Seal
 * is up, or the saved request has no outcome yet), or the vehicle owner holds a saved expedition with no server answer.
 * Each owner also turns busy for every routine read; that must never paint SEND as "Sending".
 */
internal fun departureInFlight(i: VoyageLiveInputs, starterMode: Boolean): Boolean = if (starterMode) {
    val s = i.starter
    s != null && s.busy && (s.review != null || s.journal.operation?.let { it.proof == null && it.refusal == null } == true)
} else i.vehicles?.busy == true && i.vehicles?.journal?.pending.orEmpty().any { r ->
    r.kind == "expedition" && r.request.prim("baseId") == i.baseId && r.response == null
}

/** Every trip of this base in TRIPS order, without the rest of the sheet. Home reads it every second for the Lodge plate,
 *  the return bubble, the Berth timer and the herald, so it must not rebuild SEND, the picker and the chart each time. */
internal fun lodgeTripsOnly(i: VoyageLiveInputs): List<TripUi> {
    val vehicles = installedVehicles(i)
    val previews = routePreviews(i)
    val home = homeRealmId(i, previews)
    val index = i.policy.routes?.associate { it.id to baseRouteUi(it, home, anyPreview(previews, it.id)) }.orEmpty()
    return orderTrips(lodgeTrips(i, vehicles, index))
}

/** Why SEND is off for this base right now (orders gate, Lodge unfinished, server paused); null when it may send. */
internal fun sendOrdersReason(i: VoyageLiveInputs, starterMode: Boolean): String? {
    i.ordersBlockedReason?.let { return it }
    if (hasCompleted(i.buildings, LODGE_TYPE) == false) return "Finish building the Lodge first"
    return if (starterMode) {
        val view = i.starterView
        when {
            view != null && view.lodgeCompletedAt == null -> "Finish building the Lodge first"
            view != null && !view.acceptingDepartures -> "New departures are paused. Trips at sea still come back."
            else -> null
        }
    } else {
        if (i.vehicles?.fleet?.takeIf { it.prim("baseId") == i.baseId }?.flag("acceptingNewActions") == false)
            "New expeditions are paused on this server. Trips at sea still come back." else null
    }
}

/** A departure from a previous session whose outcome is not known yet: CHECK it, never send again. */
internal fun pendingDeparture(i: VoyageLiveInputs): PendingDepartureUi? {
    val op = i.starter?.journal?.operation
    if (op != null && op.attemptRevision != null && op.proof == null && op.refusal == null)
        return PendingDepartureUi("Your Starter Boat's departure is being checked", checking = i.starter?.busy == true)
    val crafted = i.vehicles?.journal?.pending.orEmpty().firstOrNull { r ->
        r.kind == "expedition" && r.request.prim("baseId") == i.baseId && (r.response == null || r.response.prim("status") == "unknown")
    } ?: return null
    val family = vehicleFamilyOf(crafted.preview?.prim("family"))
    val who = family?.let { familyShortName(it) } ?: "vehicle"
    return PendingDepartureUi("Your $who's departure is being checked", checking = i.vehicles?.busy == true)
}

/** The server's starter route terms as a preview (no supplies: starter trips use none; no permit). */
internal fun starterPreview(route: StarterExpeditionRoute, nowMs: Long, zone: ZoneId): PreviewUi = PreviewUi(
    duration = voyageDuration(route.durationSec),
    returnsAtLocal = localClock(nowMs + route.durationSec * 1000L, zone),
    grossQuantity = voyageAmount(route.grossQuantity),
    islandPoolQuantity = voyageAmount(route.islandPoolQuantity),
    netQuantity = voyageAmount(route.netQuantity),
    supplies = emptyList(),
    fitting = route.fitting?.let { fit ->
        fittingUi(fit.itemId, route.secondaryOutput?.let { it.resourceId to it.netQuantity })
    },
    permit = null,
    resourceIcon = voyageIcon(route.resourceId),
    resourceName = voyageResourceName(route.resourceId),
)

/** A crafted route preview (`/vehicles/client/routes` item) as the reward card shows it. */
internal fun craftedPreview(p: JsonObject, haves: Map<String, String>?, nowMs: Long, zone: ZoneId): PreviewUi {
    val seconds = p.long("durationSec")
    val resource = p.prim("resourceId")
    val secondary = p.child("secondaryOutput")
    return PreviewUi(
        duration = voyageDuration(seconds),
        returnsAtLocal = seconds?.let { localClock(nowMs + it * 1000L, zone) } ?: UNKNOWN,
        grossQuantity = voyageAmount(p.prim("grossQuantity")),
        islandPoolQuantity = voyageAmount(p.prim("islandPoolQuantity")),
        netQuantity = voyageAmount(p.prim("netQuantity")),
        supplies = p.children("supplies").mapNotNull { s -> s.prim("resourceId")?.let { supplyUi(it, s.prim("quantity"), haves) } },
        fitting = p.child("fitting")?.prim("itemId")?.let { item ->
            fittingUi(item, secondary?.let { s -> s.prim("resourceId")?.let { it to (s.prim("netQuantity") ?: "") } })
        },
        permit = if (p.prim("accessRequirement") == "paid_realm") permitUi(p.prim("realmId")) else null,
        resourceIcon = resource?.let(::voyageIcon) ?: "",
        resourceName = resource?.let(::voyageResourceName) ?: UNKNOWN,
    )
}

/** One supply row: need from the preview, have from the starter view's raw stock (`available`). Short only when both
 *  are known and have < need; an unknown have is "…" and never short (SEND then relies on the server's own check). */
internal fun supplyUi(resourceId: String, need: String?, haves: Map<String, String>?): SupplyUi {
    val needN = serverAmount(need)
    val haveN = serverAmount(haves?.get(resourceId))
    val short = needN != null && haveN != null && haveN < needN
    val name = voyageResourceName(resourceId)
    return SupplyUi(resourceId, voyageIcon(resourceId), name, voyageAmount(need), voyageAmount(haves?.get(resourceId)), short,
        if (short) "Need ${"%,d".format(Locale.US, needN!! - haveN!!)} more $name" else null, VoyageLiveIds.HARVESTER)
}

/** A fitted equipment row: the item, and the server's secondary output when it states one. */
internal fun fittingUi(itemId: String, secondary: Pair<String, String>?): FittingUi = FittingUi(
    icon = voyageIcon(itemId),
    line = secondary?.let { (res, net) -> "+ ${voyageAmount(net)} ${voyageResourceName(res)}" } ?: "+ a survey find",
    fitted = "${voyageResourceName(itemId)} fitted",
)

/** A realm permit whose SOL price only the Seal's server quote may state: CHECKING ("… SOL"), never a guessed figure. */
internal fun permitUi(realmId: String?): PermitUi =
    PermitUi(PriceUi(Currency.SOL, null, PriceStatus.CHECKING, description = "Permit price is shown when you confirm"),
        realmId?.let(::voyageRealmName) ?: UNKNOWN)

// ---------- CHOOSE AN ISLAND ----------

/**
 * The picker, shown when CHANGE was tapped or SEND has no island yet (outside starter mode). Tiles come from the policy's
 * own catalogue at once, before any server preview (SPEC §4 loading). It is `loading` while that catalogue is missing, or
 * while the home realm is still unknown (every island held "Checking your home realm"): the counts, realm tags and PERMIT
 * tags then read "…" instead of "HOME 0" and eight PERMIT realms.
 */
internal fun lodgePickerUi(local: LodgeLocalState, vehicles: List<VehicleUi>, routes: List<RouteUi>?, send: LodgeSendUi): LodgePickerUi? {
    val starterMode = send.starterRoutes != null
    if (!local.pickerOpen && (starterMode || send.selectedRouteId != null)) return null
    val docked = vehicles.filter { it.family != VehicleFamily.STARTER && it.status == VehicleStatus.DOCKED && !isWornOut(it) }
    val away = vehicles.filter { it.family != VehicleFamily.STARTER && it.status == VehicleStatus.AWAY && it.tier != null }
    val awayTierReturn = away.groupBy { it.tier!! }.mapValues { (_, vs) ->
        vs.mapNotNull { it.returnsAt }.firstOrNull() ?: UNKNOWN
    }
    return LodgePickerUi(
        routes = routes.orEmpty(),
        homeRealmId = routes?.firstOrNull { it.access == Access.HOME }?.realmId,
        bestDockedTier = docked.mapNotNull { it.tier }.maxOrNull(),
        awayTierReturn = awayTierReturn,
        filter = local.filter,
        selectedRouteId = send.selectedRouteId,
        loading = routes == null || (routes.isNotEmpty() && routes.all { it.permitReason == HOME_REALM_CHECKING }),
    )
}

// ---------- locked SEND ----------

/** The no-vehicle state, only when BOTH sides are known to hold nothing (never while a snapshot is still loading). */
internal fun lodgeLockedUi(i: VoyageLiveInputs, vehicles: List<VehicleUi>): LodgeLockedUi? {
    if (vehicles.isNotEmpty() || !starterKnownAbsent(i) || !craftedKnown(i)) return null
    val variant = when (hasCompleted(i.buildings, BERTH_TYPE)) {
        true -> LodgeLockedVariant.NO_VEHICLE
        false -> if (i.berthUnlockReason != null) LodgeLockedVariant.BERTH_LOCKED else LodgeLockedVariant.NO_BERTH
        null -> return null
    }
    val resourceIds = i.starterView?.rawStock?.map { it.resourceId } ?: REALM_RESOURCE.values.toList()
    return LodgeLockedUi(
        variant = variant,
        unlockReason = i.berthUnlockReason.takeIf { variant == LodgeLockedVariant.BERTH_LOCKED },
        resources = resourceIds.map { VoyageResourceUi(it, voyageIcon(it), voyageResourceName(it)) },
        islandCount = i.policy.routes?.size?.toString() ?: UNKNOWN,
    )
}

// ---------- TRIPS ----------

/** The TRIPS tab. Empty-berth rows only once the fleet, the starter side and the Berth are all known. */
internal fun lodgeTripsUi(i: VoyageLiveInputs, local: LodgeLocalState, vehicles: List<VehicleUi>, trips: List<TripUi>): LodgeTripsUi {
    val known = hasCompleted(i.buildings, BERTH_TYPE) == true && (starterKnownAbsent(i) || vehicles.any { it.family == VehicleFamily.STARTER }) && craftedKnown(i)
    val empty = if (!known) emptyList() else VehicleFamily.entries.filter { f -> vehicles.none { it.family == f } }
    val nextBack = trips.filter { it.state == TripState.AT_SEA }.mapNotNull { it.secondsLeft }.filter { it > 0 }.minOrNull()
    return LodgeTripsUi(
        trips = orderTrips(trips),
        docked = vehicles.filter { it.status == VehicleStatus.DOCKED && !isWornOut(it) },
        emptyBerths = empty,
        collectState = local.collectState,
        nextBackIn = nextBack?.let(::voyageDuration),
        expandedTripId = local.expandedTripId,
        refreshing = i.starter?.busy == true || i.vehicles?.busy == true,
    )
}

// ---------- header, supply stack, history ----------

/** The VoyageChart for the active tab and SEND state (MOUNT-VOYAGE.md signature, plus [locked] for the EMPTY sea and
 *  [lodgeTier] for the shore's Lodge art). */
fun lodgeChartUi(send: LodgeSendUi?, trips: LodgeTripsUi, tab: String, locked: Boolean = false, lodgeTier: Int? = null): VoyageChartUi {
    if (tab == LodgeSheetUi.TAB_TRIPS) {
        val shown = orderTrips(trips.trips).take(3)
        return VoyageChartUi(ChartMode.TRIPS, trips = shown.map {
            ChartTripUi(it.route, it.vehicle.family, it.vehicle.tier, it.progress, it.state == TripState.READY || it.state == TripState.COLLECTING)
        }, description = tripsSummary(trips.trips), lodgeTier = lodgeTier)
    }
    if (locked || send == null) return VoyageChartUi(ChartMode.EMPTY, description = "The Lodge shore and the open sea", lodgeTier = lodgeTier)
    val vehicle = send.vehicles.firstOrNull { it.installationId == send.selectedInstallationId }
    val duration = send.preview?.duration?.let { TimerUi(it, "The trip takes $it") }
    if (send.starterRoutes != null) {
        return VoyageChartUi(ChartMode.STARTER_LOOP, vehicle = vehicle, duration = duration,
            description = "The starter boat's coast loop" + (send.preview?.duration?.let { ", $it" } ?: ""), lodgeTier = lodgeTier)
    }
    val route = send.routes.firstOrNull { it.routeId == send.selectedRouteId }
        ?: return VoyageChartUi(ChartMode.EMPTY, description = "The Lodge shore and the open sea", lodgeTier = lodgeTier)
    val who = vehicle?.let { familyName(it.family) } ?: "No vehicle"
    return VoyageChartUi(ChartMode.ROUTE, route = route, vehicle = vehicle, duration = duration,
        description = "$who to ${route.displayName}, Grade ${gradeNumeral(route.grade)}" + (send.preview?.duration?.let { ", $it" } ?: ""),
        lodgeTier = lodgeTier)
}

/** The Lodge's art tier for the header shore: its completed level clamped to the four authored tiers (the passport
 *  header's rule); null while the base is not loaded or has no finished Lodge. */
internal fun lodgeArtTier(buildings: List<Building>?): Int? =
    buildings?.filter { it.type == LODGE_TYPE && !it.underConstruction }?.maxOfOrNull { it.level }?.coerceIn(1, 4)

/** The island an empty header shows (SPEC §6 item 1): the lowest-grade island of the home realm, or none while the home
 *  realm is unknown (an empty sea, never a guessed realm). */
internal fun nearestHomeIsland(routes: List<RouteUi>?): RouteUi? =
    routes?.filter { it.access == Access.HOME }?.minByOrNull { it.grade }

/** The world strip's supply rows: the chosen trip's supplies, max 2, from the same server figures as SEND. */
internal fun supplyStack(send: LodgeSendUi?): List<ResourceChipUi> = send?.preview?.supplies.orEmpty().take(2).map {
    ResourceChipUi(it.earnedAt ?: VoyageLiveIds.HARVESTER, it.icon, it.have, null, false, null, it.name)
}

private fun hasLodgeHistory(i: VoyageLiveInputs, trips: List<TripUi>): Boolean =
    trips.isNotEmpty() || i.starter?.journal?.archives.orEmpty().isNotEmpty() || i.starter?.journal?.operation != null ||
        expeditionRecords(i.vehicles, i.baseId).isNotEmpty()

// ---------- collect ----------

/**
 * The collect card after a COLLECT request. [collect] is the journal's "collect" record (VehicleState.selected right
 * after `VehicleViewModel.collect(base)`); [collectedTripIds] are the READY trip ids the player collected. Null — so
 * nothing celebrates — without a server response, when the server returned 0, or when no collected expedition carries
 * its server `return` yet (the host then toasts "n trips back" from the response instead).
 */
fun collectUi(collect: VehicleRecord?, i: VoyageLiveInputs, collectedTripIds: Set<String>): CollectUi? {
    if (collect == null || collect.kind != "collect") return null
    val count = collect.response?.long("returned") ?: return null
    if (count <= 0) return null
    val records = expeditionRecords(i.vehicles, i.baseId).filter { r ->
        expeditionReceipt(r)?.prim("expeditionId") in collectedTripIds && r.response?.child("return") != null
    }
    if (records.isEmpty()) return null
    val vehicles = installedVehicles(i)
    val home = homeRealmId(i, routePreviews(i))
    val routes = i.policy.routes?.associate { it.id to baseRouteUi(it, home, null) }.orEmpty()
    val trips = records.mapNotNull { craftedTrip(it, vehicles, routes, i.nowMs, i.zone) }
    if (trips.isEmpty()) return null
    val parts = records.flatMap { r ->
        val route = expeditionReceipt(r)?.child("route")
        val secondary = r.response?.child("return")?.child("secondaryOutput")
        listOfNotNull(
            route?.let { rt -> rt.prim("resourceId")?.let { Triple(RewardUi.Kind.CARGO, it, rt.prim("netQuantity")) } },
            secondary?.let { s -> s.prim("resourceId")?.let { Triple(RewardUi.Kind.SURVEY_FIND, it, s.prim("netQuantity")) } },
        )
    }
    val first = trips.first()
    val after = vehicles.firstOrNull { it.installationId == first.vehicle.installationId } ?: first.vehicle
    return CollectUi(trips, mergeRewards(parts), after, receiptId = collect.id)
}

/** Rewards summed per (kind, resource), cargo first. One unknown amount makes that line "…", never a partial sum. */
internal fun mergeRewards(parts: List<Triple<RewardUi.Kind, String, String?>>): List<RewardUi> =
    parts.groupBy { it.first to it.second }.entries
        .sortedBy { it.key.first.ordinal }
        .map { (key, rows) ->
            val amounts = rows.map { serverAmount(it.third) }
            val total = if (amounts.any { it == null }) null else amounts.filterNotNull().fold(BigInteger.ZERO, BigInteger::add)
            RewardUi(key.second, total?.let { "%,d".format(Locale.US, it) } ?: UNKNOWN, key.first, voyageIcon(key.second), voyageResourceName(key.second))
        }

// ---------- Actions stub ----------

/** Where a Lodge tap leads (the host maps each to its Destination / HomeRequest; HOOKUP-lodge-live.md). */
enum class LodgeLiveDoor {
    /** WalletHistory(lodge); arg = a trip id for that trip's receipt, or null. */
    HISTORY,
    /** Berth › FLEET. */
    BERTH_FLEET,
    /** FocusBuilding("berth", Berth(FLEET, "starter")). */
    BERTH_STARTER,
    /** Berth › SERVICE; arg = installation id, or null. */
    BERTH_SERVICE,
    /** Build shop focused on the Berth. */
    BUILD_BERTH,
    /** Workshop › EQUIPMENT (fit a Route Compass). */
    WORKSHOP_EQUIPMENT,
    /** Where a short supply is earned; arg = resource id. */
    EARN_RESOURCE,
    /** The resource drawer at a row; arg = resource id or registry id. */
    RESOURCE_DRAWER,
}

/**
 * The host's hooks for [lodgeSheetActions]. Every server call names the EXISTING function it maps to; none of them
 * spends money. MONEY taps never reach a hook: they call [toast] with [VOYAGE_MONEY_PENDING].
 */
data class LodgeLiveCallbacks(
    /** Updates the host's [LodgeLocalState]. */
    val update: ((LodgeLocalState) -> LodgeLocalState) -> Unit,
    /** Shows a toast (the refusal / reason lines). */
    val toast: (String) -> Unit,
    /** Starter SEND → `StarterExpeditionViewModel.start(routeId)`, which opens the EXISTING reviewed confirmation. */
    val reviewStarterDeparture: (starterRouteId: String) -> Unit,
    /** Crafted SEND to a HOME island → `VehicleViewModel.dispatch(baseId, installationId, routeId)` (supplies only). */
    val dispatchCrafted: (installationId: String, routeId: String) -> Unit,
    /** CHECK a pending departure → `StarterExpeditionViewModel.check()` / `VehicleViewModel.check()` (GET by key). */
    val checkPending: () -> Unit,
    /** COLLECT → `VehicleViewModel.collect(baseId)`; the host then builds [collectUi]. */
    val collectAll: () -> Unit,
    /** RETRY the preview → `VehicleViewModel.fleet(baseId)` / `StarterExpeditionViewModel.refresh()`. */
    val retryPreview: () -> Unit,
    val go: (door: LodgeLiveDoor, arg: String?) -> Unit,
    val close: () -> Unit,
    /** RETRY on the island-art pill (the route art loader). */
    val retryArt: () -> Unit = {},
    /** Dismisses the collect card. */
    val dismissCollect: () -> Unit = {},
    /** The current Home host lends the existing permit review; absent owners retain the original refusal. */
    val reviewPermit: ((installationId: String, routeId: String) -> Unit)? = null,
)

/** The Lodge's Actions, built against the [ui] being shown (state-in, callbacks-out). */
fun lodgeSheetActions(ui: LodgeSheetUi, cb: LodgeLiveCallbacks): LodgeSheetActions = LodgeSheetActions(
    onTab = { tab -> cb.update { it.copy(tab = tab, pickerOpen = false) } },
    onHistory = { cb.go(LodgeLiveDoor.HISTORY, null) },
    onClose = cb.close,
    onSupplyStack = { id -> cb.go(LodgeLiveDoor.RESOURCE_DRAWER, id.value) },
    send = LodgeSendActions(
        onChangeIsland = { cb.update { it.copy(pickerOpen = true) } },
        onPickVehicle = { id -> pickVehicle(ui, id, cb) },
        onVehicleBlocked = { id, state -> vehicleBlocked(ui, id, state, cb) },
        onStarterRoute = { id -> cb.update { it.copy(starterRouteId = id) } },
        onFittingLink = { cb.go(LodgeLiveDoor.WORKSHOP_EQUIPMENT, null) },
        onSupplyGo = { id -> cb.go(LodgeLiveDoor.EARN_RESOURCE, id) },
        onSend = { sendTapped(ui, cb) },
        onSendRefused = { reason -> cb.toast(reason ?: UNKNOWN) },
        onRetryPreview = cb.retryPreview,
        onCheckPending = cb.checkPending,
    ),
    picker = LodgePickerActions(
        onBack = { cb.update { it.copy(pickerOpen = false) } },
        onFilter = { f -> cb.update { it.copy(filter = f) } },
        onPickRoute = { id -> cb.update { it.copy(routeId = id, pickerOpen = false, installationId = null, starterRouteId = null) } },
        onLockedTile = { id -> lockedTile(ui, id, cb) },
        onTripTile = { tripId ->
            val trip = ui.trips.trips.firstOrNull { it.tripId == tripId }
            if (trip?.state == TripState.READY) cb.collectAll()
            else cb.update { it.copy(tab = LodgeSheetUi.TAB_TRIPS, pickerOpen = false, expandedTripId = tripId) }
        },
        onArtRetry = cb.retryArt,
    ),
    locked = LodgeLockedActions(
        onGoBerth = { cb.go(LodgeLiveDoor.BERTH_STARTER, null) },
        onBuildBerth = {
            if (ui.locked?.variant == LodgeLockedVariant.BERTH_LOCKED) cb.toast(ui.locked?.unlockReason ?: UNKNOWN)
            else cb.go(LodgeLiveDoor.BUILD_BERTH, null)
        },
        onResource = { id -> cb.go(LodgeLiveDoor.RESOURCE_DRAWER, id) },
    ),
    trips = LodgeTripsActions(
        onCollectAll = cb.collectAll,
        onTrip = { id -> cb.update { it.copy(expandedTripId = if (it.expandedTripId == id) null else id) } },
        onSendWith = { id -> cb.update { it.copy(tab = LodgeSheetUi.TAB_SEND, installationId = id, pickerOpen = false) } },
        onGoBerth = { cb.go(LodgeLiveDoor.BERTH_FLEET, null) },
        onSendAnother = { cb.update { it.copy(tab = LodgeSheetUi.TAB_SEND) } },
        onTripHistory = { id -> cb.go(LodgeLiveDoor.HISTORY, id) },
    ),
)

/** The collect card's Actions: SEND AGAIN preselects the same island (or starter route) and vehicle. */
fun collectActions(ui: CollectUi, cb: LodgeLiveCallbacks): CollectActions = CollectActions(
    onOk = cb.dismissCollect,
    onSendAgain = {
        val first = ui.trips.firstOrNull()
        cb.dismissCollect()
        cb.update { it.copy(tab = LodgeSheetUi.TAB_SEND, pickerOpen = false, routeId = first?.route?.routeId,
            starterRouteId = first?.starterRouteId, installationId = first?.vehicle?.installationId) }
    },
    onGoBerth = { cb.dismissCollect(); cb.go(LodgeLiveDoor.BERTH_SERVICE, ui.vehicleAfter.installationId) },
)

/** SEND. Order: a pending departure is CHECKed (never re-sent); a permit route is MONEY → refused with
 *  [VOYAGE_MONEY_PENDING]; the starter opens its existing review; a crafted HOME route dispatches. */
internal fun sendTapped(ui: LodgeSheetUi, cb: LodgeLiveCallbacks) {
    val s = ui.send ?: return cb.toast("Choose an island first")
    if (s.pending != null) return cb.checkPending()
    val vehicle = s.vehicles.firstOrNull { it.installationId == s.selectedInstallationId }
        ?: return cb.toast("Choose a vehicle that can sail there")
    if (vehicle.family == VehicleFamily.STARTER) {
        val route = s.selectedStarterRouteId ?: return cb.toast("Choose a route first")
        return cb.reviewStarterDeparture(route)
    }
    val route = s.routes.firstOrNull { it.routeId == s.selectedRouteId } ?: return cb.toast("Choose an island first")
    val installation = vehicle.installationId ?: return cb.toast("Choose a vehicle that can sail there")
    if (route.access == Access.PAID_REALM || s.preview?.permit != null) {
        return cb.reviewPermit?.invoke(installation, route.routeId) ?: cb.toast(VOYAGE_MONEY_PENDING)
    }
    cb.dispatchCrafted(installation, route.routeId)
}

private fun pickVehicle(ui: LodgeSheetUi, id: String, cb: LodgeLiveCallbacks) {
    val v = ui.send?.vehicles?.firstOrNull { it.installationId == id }
    // The starter card on an island route switches the destination to the starter routes (SPEC §3a); a crafted card
    // picked in starter mode hands the destination back to the islands.
    if (v?.family == VehicleFamily.STARTER) cb.update { it.copy(installationId = id, routeId = null, pickerOpen = false) }
    else cb.update { it.copy(installationId = id, starterRouteId = null) }
}

private fun vehicleBlocked(ui: LodgeSheetUi, id: String, state: VehicleCardState, cb: LodgeLiveCallbacks) {
    val s = ui.send
    val v = s?.vehicles?.firstOrNull { it.installationId == id }
    val selectedRoute = s?.selectedRouteId
    val grade = s?.routes?.firstOrNull { it.routeId == selectedRoute }?.grade
    when (state) {
        VehicleCardState.AWAY -> cb.toast("Back in ${v?.returnsAt ?: UNKNOWN}")
        VehicleCardState.TOO_LOW_TIER ->
            cb.toast("Grade ${gradeNumeral(grade)} islands need a Tier ${grade ?: UNKNOWN} vehicle. Upgrade at the Berth ▸")
        VehicleCardState.WORN_OUT -> cb.go(LodgeLiveDoor.BERTH_SERVICE, id)
        VehicleCardState.COAST_ONLY -> cb.update { it.copy(installationId = id, routeId = null, pickerOpen = false) }
        VehicleCardState.BUSY -> cb.toast("In service at the Berth")
        VehicleCardState.SELECTED, VehicleCardState.ELIGIBLE -> pickVehicle(ui, id, cb)
    }
}

private fun lockedTile(ui: LodgeSheetUi, routeId: String, cb: LodgeLiveCallbacks) {
    val picker = ui.picker ?: return cb.toast(UNKNOWN)
    val route = picker.routes.firstOrNull { it.routeId == routeId } ?: return cb.toast(UNKNOWN)
    when (islandTileState(route, picker.bestDockedTier, picker.selectedRouteId)) {
        IslandTileState.LOCKED_TIER -> cb.toast("Needs a Tier ${route.grade} vehicle. Upgrade at the Berth ▸")
        IslandTileState.LOCKED_PERMIT -> if (cb.reviewPermit == null) cb.toast(route.permitReason ?: VOYAGE_MONEY_PENDING)
            else cb.update { it.copy(routeId = routeId, pickerOpen = false, installationId = null, starterRouteId = null) }
        else -> cb.update { it.copy(routeId = routeId, pickerOpen = false, installationId = null, starterRouteId = null) }
    }
}
