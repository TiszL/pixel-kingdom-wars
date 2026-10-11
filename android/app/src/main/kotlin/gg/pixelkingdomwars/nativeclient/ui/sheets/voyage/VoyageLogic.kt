package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: the pure rules of the voyage cluster (SPEC §3-§10): names, grade numerals, trip meters, the vehicle
 * card and island tile states, the default vehicle, picker filters and realm order, trip order, the contextual primaries of
 * SEND / TRIPS / FLEET / SERVICE, the money-error wording, and the pixel-art scale and window maths.
 *
 * Plain Kotlin (no Compose), JVM-tested in app/src/test/kotlin/…/ui/sheets/voyage/VoyageLogicTest.kt. Nothing here reads a
 * clock or computes a game number: amounts, durations and tiers come from the server through the mapper.
 */

// ---------- names ----------

/** "Cargo Cutter". */
fun familyName(family: VehicleFamily): String = when (family) {
    VehicleFamily.STARTER -> "Starter Boat"
    VehicleFamily.SURVEY_BALLOON -> "Survey Balloon"
    VehicleFamily.CARGO_CUTTER -> "Cargo Cutter"
    VehicleFamily.COURIER_AIRSHIP -> "Courier Airship"
    VehicleFamily.EXPEDITION_BARGE -> "Expedition Barge"
}

/** "Cutter" (vehicle cards, chips, the starter teasers). */
fun familyShortName(family: VehicleFamily): String = when (family) {
    VehicleFamily.STARTER -> "Starter"
    VehicleFamily.SURVEY_BALLOON -> "Balloon"
    VehicleFamily.CARGO_CUTTER -> "Cutter"
    VehicleFamily.COURIER_AIRSHIP -> "Airship"
    VehicleFamily.EXPEDITION_BARGE -> "Barge"
}

/** "Cargo Cutter T2"; the starter has no tier; an unknown tier is "T…". */
fun vehicleTitle(v: VehicleUi): String =
    if (v.family == VehicleFamily.STARTER) familyName(v.family) else "${familyName(v.family)} ${tierTag(v.tier)}"

/** "T2", or "T…" when unknown. */
fun tierTag(tier: Int?): String = "T${tier ?: UNKNOWN}"

/** Grade 1..4 as the roman numeral the design prints; anything else is "…". */
fun gradeNumeral(grade: Int?): String = when (grade) { 1 -> "I"; 2 -> "II"; 3 -> "III"; 4 -> "IV"; else -> UNKNOWN }

/** "Grade II needs Tier 2 or higher" (SPEC §3 item 5). */
fun gradeRuleLine(grade: Int?): String =
    if (grade == null || grade !in 1..4) "Choose an island" else "Grade ${gradeNumeral(grade)} needs Tier $grade or higher"

// ---------- trips meter ----------

/** "7/10 left"; unknowns stay "…" (never 0). */
fun tripsLeftShort(left: Int?, max: Int?): String = "${left ?: UNKNOWN}/${max ?: UNKNOWN} left"

/** "7 of 10 trips left" / "1 of 10 trips left". */
fun tripsLeftLong(left: Int?, max: Int?): String = "${left ?: UNKNOWN} of ${max ?: UNKNOWN} trips left"

/** The mini meter's fill (0..1), or null when either side is unknown (an empty track, never "0 done"). */
fun tripsFraction(left: Int?, max: Int?): Float? =
    if (left == null || max == null || max <= 0) null else (left.toFloat() / max).coerceIn(0f, 1f)

/** Gold at two trips or fewer (service soon), green otherwise (SPEC §7 item 5, §9 item 3). */
fun tripsMeterVerb(left: Int?): Verb = if (left != null && left <= 2) Verb.GOLD else Verb.GREEN

/** True when a vehicle has no trips left (worn out). */
fun isWornOut(v: VehicleUi): Boolean = v.status == VehicleStatus.WORN_OUT || v.tripsLeft == 0

// ---------- SEND: vehicle cards ----------

/** A vehicle card's state on SEND (SPEC §3 item 6 table). */
enum class VehicleCardState { SELECTED, ELIGIBLE, AWAY, TOO_LOW_TIER, COAST_ONLY, WORN_OUT, BUSY }

/**
 * The card state of [v] for an island of [routeGrade] (null = a starter route is chosen). Order matters: a vehicle at sea
 * reads AWAY whatever else is true; a worn vehicle reads Service before a tier problem, because service is the fix.
 */
fun vehicleCardState(v: VehicleUi, selectedInstallationId: String?, routeGrade: Int?): VehicleCardState = when {
    v.status == VehicleStatus.AWAY -> VehicleCardState.AWAY
    v.status == VehicleStatus.BUSY_SERVICE -> VehicleCardState.BUSY
    isWornOut(v) -> VehicleCardState.WORN_OUT
    routeGrade != null && v.family == VehicleFamily.STARTER -> VehicleCardState.COAST_ONLY
    routeGrade != null && v.maxGrade < routeGrade -> VehicleCardState.TOO_LOW_TIER
    // On a starter route an advanced card stays selectable: picking it hands the destination back to the islands.
    else -> eligibleOrSelected(v, selectedInstallationId)
}

private fun eligibleOrSelected(v: VehicleUi, selected: String?): VehicleCardState =
    if (v.installationId != null && v.installationId == selected) VehicleCardState.SELECTED else VehicleCardState.ELIGIBLE

/** Whether a card may become the selection. */
fun canSelect(state: VehicleCardState): Boolean = state == VehicleCardState.ELIGIBLE || state == VehicleCardState.SELECTED

/**
 * The default vehicle for an island of [routeGrade] (SPEC §3 item 6): the lowest tier that reaches the grade among docked,
 * unworn vehicles, then the most trips left (unknown counts least). Null when none can sail it. A starter route
 * ([routeGrade] null) defaults to the starter.
 */
fun defaultVehicle(vehicles: List<VehicleUi>, routeGrade: Int?): VehicleUi? {
    val ready = vehicles.filter { it.status == VehicleStatus.DOCKED && !isWornOut(it) && it.installationId != null }
    if (routeGrade == null) return ready.firstOrNull { it.family == VehicleFamily.STARTER }
    return ready.filter { it.family != VehicleFamily.STARTER && it.maxGrade >= routeGrade }
        .sortedWith(compareBy<VehicleUi> { it.maxGrade }.thenByDescending { it.tripsLeft ?: -1 })
        .firstOrNull()
}

/** The card's VT line (SPEC §3 table): trips left, time back, or the danger reason. */
fun vehicleCardLine(v: VehicleUi, state: VehicleCardState, routeGrade: Int?): String = when (state) {
    VehicleCardState.AWAY -> v.returnsAt ?: UNKNOWN
    VehicleCardState.TOO_LOW_TIER -> "Needs ${tierTag(routeGrade)}"
    VehicleCardState.COAST_ONLY -> "Coast only"
    VehicleCardState.WORN_OUT -> "Service"
    VehicleCardState.BUSY -> "In service"
    VehicleCardState.SELECTED, VehicleCardState.ELIGIBLE -> tripsLeftShort(v.tripsLeft, v.tripsMax)
}

// ---------- CHOOSE AN ISLAND ----------

/** The three picker filters (SPEC §4 item 2). */
enum class RouteFilter { ALL, CAN_SAIL, HOME }

/** Can a docked vehicle of [bestDockedTier] reach [route]? (Any access: a permit is a separate question.) */
fun canSail(route: RouteUi, bestDockedTier: Int?): Boolean = bestDockedTier != null && route.grade <= bestDockedTier

/** The routes a filter keeps. */
fun filterRoutes(routes: List<RouteUi>, filter: RouteFilter, bestDockedTier: Int?): List<RouteUi> = when (filter) {
    RouteFilter.ALL -> routes
    RouteFilter.CAN_SAIL -> routes.filter { canSail(it, bestDockedTier) }
    RouteFilter.HOME -> routes.filter { it.access == Access.HOME }
}

/** The count on a filter chip ("…" while loading, never a guessed 0). */
fun filterCount(routes: List<RouteUi>, filter: RouteFilter, bestDockedTier: Int?, loading: Boolean): String =
    if (loading) UNKNOWN else filterRoutes(routes, filter, bestDockedTier).size.toString()

/** One realm block of the picker. */
data class RealmBlock(val realmId: String, val realmName: String, val resourceIcon: String, val resourceName: String,
    val access: Access, val routes: List<RouteUi>)

/** Realm blocks: the home realm first, then the rest alphabetically; each block's islands by grade (SPEC §4 item 4). */
fun realmBlocks(routes: List<RouteUi>, homeRealmId: String?): List<RealmBlock> =
    routes.groupBy { it.realmId }.map { (id, rs) ->
        val first = rs.first()
        RealmBlock(id, first.realmName, first.resourceIcon, first.resourceName,
            if (rs.all { it.access == Access.HOME }) Access.HOME else Access.PAID_REALM, rs.sortedBy { it.grade })
    }.sortedWith(compareBy<RealmBlock> { if (it.realmId == homeRealmId) 0 else 1 }.thenBy { it.realmName.lowercase() })

/** An island tile's state (SPEC §4 tile table). */
enum class IslandTileState { AVAILABLE, SELECTED, MY_TRIP_AWAY, MY_TRIP_BACK, LOCKED_TIER, LOCKED_PERMIT }

/** My own trip wins (it is a door to TRIPS / collect), then the tier lock, then the permit lock, then selection. */
fun islandTileState(route: RouteUi, bestDockedTier: Int?, selectedRouteId: String?): IslandTileState = when {
    route.myTrip?.state == TripState.READY -> IslandTileState.MY_TRIP_BACK
    route.myTrip?.state == TripState.AT_SEA || route.myTrip?.state == TripState.COLLECTING -> IslandTileState.MY_TRIP_AWAY
    !canSail(route, bestDockedTier) -> IslandTileState.LOCKED_TIER
    route.access == Access.PAID_REALM && route.permitReason != null -> IslandTileState.LOCKED_PERMIT
    route.routeId == selectedRouteId -> IslandTileState.SELECTED
    else -> IslandTileState.AVAILABLE
}

/**
 * The grade header's second line (SPEC §4 item 3): "needs T3+", or blue "T3+ in 1h" when the player has no docked vehicle
 * of that grade but one is away. [awayTierReturn] is keyed by tier with that tier's soonest return ("1h"); the lowest
 * away tier that reaches the grade is used. Returns the text and whether it is the blue "away" variant.
 */
fun gradeHeaderLine(grade: Int, bestDockedTier: Int?, awayTierReturn: Map<Int, String>): Pair<String, Boolean> {
    if (bestDockedTier != null && bestDockedTier >= grade) return "needs T$grade+" to false
    val away = awayTierReturn.keys.filter { it >= grade }.minOrNull()
    return if (away != null) "T$grade+ in ${awayTierReturn.getValue(away)}" to true else "needs T$grade+" to false
}

// ---------- TRIPS ----------

/** READY (and collecting) trips first, then the soonest return; unknown times last; stable otherwise. */
fun orderTrips(trips: List<TripUi>): List<TripUi> = trips.filter { it.state != TripState.COLLECTED }
    .sortedWith(compareBy<TripUi> { if (it.state == TripState.READY || it.state == TripState.COLLECTING) 0 else 1 }
        .thenBy { it.secondsLeft ?: Long.MAX_VALUE })

/** "2 at sea · 1 back" (SPEC §5a item 3). */
fun tripsSummary(trips: List<TripUi>): String {
    val atSea = trips.count { it.state == TripState.AT_SEA }
    val back = trips.count { it.state == TripState.READY || it.state == TripState.COLLECTING }
    return "$atSea at sea · $back back"
}

/** The TRIPS tab's pinned primary (SPEC §5a item 7). */
enum class TripsPrimary { COLLECT, SEND_ANOTHER, NONE }

fun tripsPrimary(trips: List<TripUi>, docked: List<VehicleUi>): TripsPrimary = when {
    trips.any { it.state == TripState.READY || it.state == TripState.COLLECTING } -> TripsPrimary.COLLECT
    docked.any { it.status == VehicleStatus.DOCKED && !isWornOut(it) } -> TripsPrimary.SEND_ANOTHER
    else -> TripsPrimary.NONE
}

/** What TRIPS shows when nothing is at sea or back (SPEC §5a empty state). */
enum class TripsEmpty {
    /** There are trips: the list shows. */
    NONE,
    /** "Nothing at sea" + blue SEND: a docked vehicle can sail now. */
    SEND,
    /** "Nothing at sea" + blue GO to the Berth: no vehicle can sail (none installed, or every one needs service). */
    BERTH,
}

/** The empty state of TRIPS: SEND only when a docked vehicle can sail, else the Berth, where installs and service happen. */
fun tripsEmpty(trips: List<TripUi>, docked: List<VehicleUi>): TripsEmpty = when {
    orderTrips(trips).isNotEmpty() -> TripsEmpty.NONE
    docked.any { it.status == VehicleStatus.DOCKED && !isWornOut(it) } -> TripsEmpty.SEND
    else -> TripsEmpty.BERTH
}

/**
 * The line TRIPS pins when it has no primary (SPEC §5a item 7: "Next back in 1h 12m"). Only while something is at sea:
 * with nothing out, "Next back in …" would promise a return that is not coming. An unknown time at sea stays "…".
 */
fun tripsFooterLine(trips: List<TripUi>, docked: List<VehicleUi>, nextBackIn: String?): String? = when {
    tripsPrimary(trips, docked) != TripsPrimary.NONE -> null
    trips.none { it.state == TripState.AT_SEA } -> null
    else -> "Next back in ${nextBackIn ?: UNKNOWN}"
}

/** COLLECT's sub-line: the first reward line of a single return ("+40 Heartwood Logs"), else "3 trips back". */
fun collectSubLine(trips: List<TripUi>): String {
    val ready = orderTrips(trips).filter { it.state == TripState.READY || it.state == TripState.COLLECTING }
    if (ready.size != 1) return "${ready.size} trips back"
    val first = (ready[0].returned ?: ready[0].expected).firstOrNull() ?: return "1 trip back"
    return "+${first.quantity} ${first.name}".trimEnd()
}

/** The trips-tab badge: green "!" when one is back, else the red count at sea, else none (SPEC §3 item 3). */
fun tripsTabBadge(trips: List<TripUi>): Pair<String, Boolean>? {
    if (trips.any { it.state == TripState.READY }) return "!" to true
    val atSea = trips.count { it.state == TripState.AT_SEA }
    return if (atSea > 0) (if (atSea > 99) "99+" else atSea.toString()) to false else null
}

// ---------- SEND primary ----------

/** How the route preview stands (SPEC §3 `previewState`). */
enum class PreviewState { LOADING, READY, ERROR }

/** The look of a pinned primary. */
data class PrimaryLook(val label: String, val sub: String?, val verb: Verb, val state: CommandState, val reason: String?)

/**
 * SEND's look (SPEC §3 states table), in priority order: a pending departure is checked, never re-sent; a server-off
 * feature is LOCKED; a read-only base or nothing chosen is DISABLED with its reason; a request in flight is BUSY
 * "Sending"; a loading preview is BUSY "Checking route"; a preview error and short supplies are DISABLED with their
 * sentence. A permit route keeps SEND enabled with "permit about …" (the tap opens the Seal).
 */
fun sendLook(
    hasRoute: Boolean, hasVehicle: Boolean, previewState: PreviewState, preview: PreviewUi?, ordersAllowed: Boolean,
    ordersReason: String?, lockedReason: String?, busy: Boolean, pending: Boolean, previewError: String?,
): PrimaryLook {
    val back = preview?.returnsAtLocal?.let { "back at $it" }
    val shortSupply = preview?.supplies?.firstOrNull { it.short }
    val permit = preview?.permit
    return when {
        pending -> PrimaryLook("Checking departure", null, Verb.STONE, CommandState.BUSY, null)
        lockedReason != null -> PrimaryLook("SEND", null, Verb.GOLD, CommandState.LOCKED, lockedReason)
        !ordersAllowed -> PrimaryLook("SEND", null, Verb.GOLD, CommandState.DISABLED, ordersReason ?: "This base is read-only")
        busy -> PrimaryLook("Sending", null, Verb.STONE, CommandState.BUSY, null)
        !hasRoute -> PrimaryLook("SEND", null, Verb.GOLD, CommandState.DISABLED, "Choose an island first")
        !hasVehicle -> PrimaryLook("SEND", null, Verb.GOLD, CommandState.DISABLED, "Choose a vehicle that can sail there")
        previewState == PreviewState.LOADING -> PrimaryLook("Checking route", null, Verb.STONE, CommandState.BUSY, null)
        previewState == PreviewState.ERROR || preview == null ->
            PrimaryLook("SEND", null, Verb.GOLD, CommandState.DISABLED, previewError ?: "The Lodge can't reach the route chart. Try again.")
        shortSupply != null -> PrimaryLook("SEND", back, Verb.GOLD, CommandState.DISABLED,
            shortSupply.shortLine ?: "Need more ${shortSupply.name}")
        permit != null -> PrimaryLook("SEND", "permit about ${permitAmount(permit)}", Verb.GOLD, CommandState.ENABLED, null)
        else -> PrimaryLook("SEND", back, Verb.GOLD, CommandState.ENABLED, null)
    }
}

/** "0.03 SOL", or "… SOL" while unpriced (a permit is never shown as free). */
fun permitAmount(permit: PermitUi): String = "${permit.price.amount?.takeIf { it.isNotBlank() } ?: UNKNOWN} SOL"

// ---------- FLEET primary ----------

/** What FLEET's primary does for the selected berth (SPEC §7 item 7). */
enum class FleetAction { INSTALL, SEND_FROM_LODGE, SERVICE, CHECK, NONE }

/** FLEET's primary and its look. */
data class FleetPrimary(val action: FleetAction, val look: PrimaryLook?)

/**
 * The selected berth's primary: an install in flight is checked by key, never re-sent; EMPTY installs (LOCKED when the
 * feature is off or no wallet is linked); worn out services; docked sends from the Lodge; away has none (the reason line
 * "Back in 1h 12m" replaces it).
 */
fun fleetPrimary(selected: VehicleUi?, pendingInstall: Boolean, featureOffReason: String?, walletLinked: Boolean,
    ordersAllowed: Boolean): FleetPrimary {
    if (selected == null) return FleetPrimary(FleetAction.NONE, null)
    val family = familyShortName(selected.family).uppercase()
    return when {
        pendingInstall -> FleetPrimary(FleetAction.CHECK, PrimaryLook("CHECK", "Installing · checking wallet", Verb.STONE, CommandState.ENABLED, null))
        selected.status == VehicleStatus.EMPTY -> when {
            featureOffReason != null -> FleetPrimary(FleetAction.INSTALL, PrimaryLook("INSTALL $family", null, Verb.GOLD, CommandState.LOCKED, featureOffReason))
            !walletLinked -> FleetPrimary(FleetAction.INSTALL, PrimaryLook("INSTALL $family", null, Verb.GOLD, CommandState.LOCKED, "Link a wallet in Profile to install vehicles"))
            !ordersAllowed -> FleetPrimary(FleetAction.INSTALL, PrimaryLook("INSTALL $family", null, Verb.GOLD, CommandState.DISABLED, "This base is read-only"))
            else -> FleetPrimary(FleetAction.INSTALL, PrimaryLook("INSTALL $family", "pick one from your wallet", Verb.GOLD, CommandState.ENABLED, null))
        }
        selected.status == VehicleStatus.AWAY -> FleetPrimary(FleetAction.NONE, null)
        selected.status == VehicleStatus.BUSY_SERVICE -> FleetPrimary(FleetAction.NONE, null)
        isWornOut(selected) -> FleetPrimary(FleetAction.SERVICE, PrimaryLook("SERVICE", null, Verb.GOLD, CommandState.ENABLED, null))
        else -> FleetPrimary(FleetAction.SEND_FROM_LODGE, PrimaryLook("SEND FROM LODGE", null, Verb.BLUE, CommandState.ENABLED, null))
    }
}

/** A berth row's VT line (SPEC §7 item 5). */
fun berthRowLine(v: VehicleUi): String = when {
    v.status == VehicleStatus.EMPTY -> if (v.family == VehicleFamily.STARTER) "Empty · free to install"
        else "Empty · flies to Grade ${gradeNumeral(minGradeOf(v.family))}+"
    v.family == VehicleFamily.STARTER -> if (v.status == VehicleStatus.AWAY) "At sea · coast trips" else "Coast trips · always free"
    v.status == VehicleStatus.AWAY -> "At sea · ${tripsLeftLong(v.tripsLeft, v.tripsMax)}"
    v.status == VehicleStatus.BUSY_SERVICE -> "In service · checking wallet"
    else -> tripsLeftLong(v.tripsLeft, v.tripsMax)
}

/** The lowest grade a T1 of this family reaches (every advanced family starts at Grade I). */
private fun minGradeOf(family: VehicleFamily): Int = if (family == VehicleFamily.STARTER) 0 else 1

/** A berth row's right tag text and verb (SPEC §7 item 5). */
fun berthRowTag(v: VehicleUi): Pair<String, Verb> = when {
    v.status == VehicleStatus.EMPTY -> "EMPTY" to Verb.STONE
    v.status == VehicleStatus.AWAY -> "AWAY" to Verb.BLUE
    v.status == VehicleStatus.BUSY_SERVICE -> "BUSY" to Verb.STONE
    isWornOut(v) -> "SERVICE" to Verb.RED
    else -> "DOCKED" to Verb.GREEN
}

/** SERVICE tab's red count: installed advanced vehicles with one trip or fewer left (SPEC §7 item 3). */
fun serviceBadgeCount(berths: List<VehicleUi>): Int = berths.count {
    it.family != VehicleFamily.STARTER && it.status != VehicleStatus.EMPTY && it.tripsLeft != null && it.tripsLeft <= 1
}

// ---------- SERVICE ----------

/** The two services (server `restore_uses` / `upgrade`). */
enum class ServiceOp { RESTORE_USES, UPGRADE }

/**
 * SERVICE's primary: "RESTORE TRIPS" / "UPGRADE TO T3" with the fee line; DISABLED when the hand-in is missing (with "You
 * need a Cargo Cutter T2 in your wallet") or the option is unavailable (its reason); none while away.
 */
fun servicePrimary(op: ServiceOp?, optionAvailable: Boolean, optionReason: String?, resultTier: Int?, handInPresent: Boolean,
    handInName: String, feeText: String?, vehicleAway: Boolean, awayLine: String?): PrimaryLook? {
    if (op == null) return null
    if (vehicleAway) return PrimaryLook(serviceLabel(op, resultTier), null, Verb.GOLD, CommandState.DISABLED, awayLine ?: "Service when it is docked")
    val label = serviceLabel(op, resultTier)
    val sub = "network fee about ${feeText ?: UNKNOWN} SOL"
    return when {
        !optionAvailable -> PrimaryLook(label, null, Verb.GOLD, CommandState.LOCKED, optionReason ?: "Not available")
        !handInPresent -> PrimaryLook(label, sub, Verb.GOLD, CommandState.DISABLED, "You need a $handInName in your wallet")
        else -> PrimaryLook(label, sub, Verb.GOLD, CommandState.ENABLED, null)
    }
}

private fun serviceLabel(op: ServiceOp, resultTier: Int?): String =
    if (op == ServiceOp.RESTORE_USES) "RESTORE TRIPS" else "UPGRADE TO ${tierTag(resultTier)}"

// ---------- money ----------

/** The kit money stage for a voyage seal state (ARMED and IDLE are the gold READY face). */
fun moneyStage(state: VoyageSealState): MoneyStage = when (state) {
    VoyageSealState.IDLE, VoyageSealState.ARMED -> MoneyStage.READY
    VoyageSealState.CHECK_WALLET -> MoneyStage.CHECK_WALLET
    VoyageSealState.SENDING -> MoneyStage.SENDING
    VoyageSealState.SENT -> MoneyStage.SENT
    VoyageSealState.ERROR -> MoneyStage.FAILED
}

/**
 * The sentence for a failed or uncertain money step (design correction 7): only an authoritative refusal may add "Nothing
 * was sent."; an uncertain one says it is being checked, and the caller keeps CHECK (recovery) on screen.
 */
fun moneyErrorLine(error: VoyageMoneyErrorUi): String = when {
    error.authoritative -> "${error.message.trimEnd('.', ' ')}. Nothing was sent."
    else -> "${error.message.trimEnd('.', ' ')}. Your request is being checked."
}

// ---------- pixel art ----------

/**
 * The integer device scale for SPEC §0.4's "k" (written at density 2.0, where dp = art px × k / 2): the nearest whole
 * number of device pixels per art pixel at [density], at least 1.
 */
fun deviceArtScale(designK: Int, density: Float): Int = maxOf(1, (designK * density / 2f).roundToInt())

/** A sprite's painted box in art px (left, top, right, bottom; right/bottom exclusive), from SPEC §0.4 (PIL getbbox). */
fun vehicleBbox(family: VehicleFamily): IntArray = when (family) {
    VehicleFamily.STARTER -> intArrayOf(47, 71, 65, 105)
    VehicleFamily.SURVEY_BALLOON -> intArrayOf(36, 34, 76, 110)
    VehicleFamily.CARGO_CUTTER -> intArrayOf(36, 52, 77, 108)
    VehicleFamily.COURIER_AIRSHIP -> intArrayOf(21, 52, 94, 102)
    VehicleFamily.EXPEDITION_BARGE -> intArrayOf(28, 66, 85, 105)
}

/**
 * Where to draw a [artSize]-px sprite at [scale] device px per art px inside a [windowW] × [windowH] px window, in whole
 * device pixels. With [bottomArtY] the art row [bottomArtY] sits on the window's bottom edge and the art is centred
 * horizontally on [centreArtX]; otherwise the art point ([centreArtX], [centreArtY]) sits on the window's centre.
 * Returns (x, y) of the art's top-left corner.
 */
fun spriteOrigin(windowW: Int, windowH: Int, scale: Int, centreArtX: Float, centreArtY: Float, bottomArtY: Int? = null): Pair<Int, Int> {
    val x = (windowW / 2f - centreArtX * scale).roundToInt()
    val y = if (bottomArtY != null) windowH - bottomArtY * scale else (windowH / 2f - centreArtY * scale).roundToInt()
    return x to y
}

/**
 * A 4 × 5 colour matrix (row-major, the layout `androidx.compose.ui.graphics.ColorMatrix` takes) that removes [grey] of the
 * colour (0 = none, 1 = full grey, Rec. 709 luma) and then scales brightness by [brightness]. Alpha is untouched.
 * Locked island tiles use (0.85, 0.45); empty quay slots (0.70, 0.55).
 */
fun dimMatrix(grey: Float, brightness: Float): FloatArray {
    val s = 1f - grey.coerceIn(0f, 1f)
    val b = brightness.coerceAtLeast(0f)
    val lr = 0.2126f; val lg = 0.7152f; val lb = 0.0722f
    fun row(r: Float, g: Float, bl: Float) = floatArrayOf(r * b, g * b, bl * b, 0f, 0f)
    return row(lr * (1 - s) + s, lg * (1 - s), lb * (1 - s)) +
        row(lr * (1 - s), lg * (1 - s) + s, lb * (1 - s)) +
        row(lr * (1 - s), lg * (1 - s), lb * (1 - s) + s) +
        floatArrayOf(0f, 0f, 0f, 1f, 0f)
}

/**
 * A point along the header's stepped route (H → V → H, SPEC §3 item 2): from [from] across to [turnX] (the midpoint x when
 * null), then up or down, then across to [to]. [t] (0..1) is the share of the whole path length. Returns (x, y) in the
 * same units. send.html turns at x 176 on a 126 → 262 route, so the header passes its own [turnX].
 */
fun steppedRoutePoint(fromX: Float, fromY: Float, toX: Float, toY: Float, t: Float, turnX: Float? = null): Pair<Float, Float> {
    val midX = turnX ?: ((fromX + toX) / 2f)
    val a = kotlin.math.abs(midX - fromX); val b = kotlin.math.abs(toY - fromY); val c = kotlin.math.abs(toX - midX)
    val total = a + b + c
    if (total <= 0f) return fromX to fromY
    var d = t.coerceIn(0f, 1f) * total
    if (d <= a) return (fromX + (midX - fromX) * (if (a == 0f) 0f else d / a)) to fromY
    d -= a
    if (d <= b) return midX to (fromY + (toY - fromY) * (if (b == 0f) 0f else d / b))
    d -= b
    return (midX + (toX - midX) * (if (c == 0f) 0f else d / c)) to toY
}
