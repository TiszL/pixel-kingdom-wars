package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * The pure rules of the voyage cluster's round-2 frames (design/final/voyage/SPEC.md "Round 2 additions (2026-10-03)":
 * E1.1 Lodge PASSPORT, E1.2 paid expedition, E1.3 send a crafted vehicle, and "Part two — network cost only inside the
 * Seal" for berth install / service). No Compose. JVM-tested in `VoyageR2LogicTest`.
 *
 * Rule for every voyage surface: SOL network cost, rent or setup lines appear only inside a Seal's fine print; sheets
 * and buttons say what you give and what you get. Money copy follows design correction 7 (only an authoritative refusal
 * may say nothing was sent).
 */

// ---------------------------------------------------------------------------------------------------------------- Seal v2

/** "Paid from your wallet with a tiny network cost (about 0.00002 SOL). You sign once." / "(network cost being checked)". */
fun networkCostLine(feeSol: String?): String {
    val fee = feeSol?.trim()?.takeIf { it.isNotEmpty() && it != UNKNOWN }
    return if (fee == null) "Paid from your wallet (network cost being checked). You sign once."
    else "Paid from your wallet with a tiny network cost (about $fee SOL). You sign once."
}

/** Which primary a round-2 voyage Seal draws, in priority order. */
enum class SealV2Primary {
    /** PAUSED: LOCKED with the reason. */
    LOCKED,
    /** ERROR not known to be a refusal: stone CHECK (by-key read), never a fresh request. */
    CHECK,
    /** ERROR, authoritative: red RETRY. */
    RETRY,
    /** CHECK_WALLET / SENDING / SENT: the kit money face. */
    MONEY,
    /** The price is unavailable: off. */
    UNAVAILABLE,
    /** Not enough SOL: off with "Add SOL to your wallet first" (GO WALLET in the box). */
    SHORT,
    /** The quote / fee is still being checked: stone "Checking", not armed. */
    CHECKING,
    /** The gold primary with its 450 ms arming bar. */
    ARMING,
}

/** The round-2 Seal's primary (see [SealV2Primary]). */
fun sealV2Primary(ui: VoyageSealV2Ui): SealV2Primary = when {
    ui.pausedReason != null -> SealV2Primary.LOCKED
    ui.state == VoyageSealState.ERROR && (ui.error == null || ui.error.recoverable) -> SealV2Primary.CHECK
    ui.state == VoyageSealState.ERROR -> SealV2Primary.RETRY
    ui.state == VoyageSealState.CHECK_WALLET || ui.state == VoyageSealState.SENDING || ui.state == VoyageSealState.SENT -> SealV2Primary.MONEY
    ui.unavailable != null -> SealV2Primary.UNAVAILABLE
    ui.shortLine != null -> SealV2Primary.SHORT
    !ui.quoteReady -> SealV2Primary.CHECKING
    else -> SealV2Primary.ARMING
}

/**
 * The install Seal, re-done (berth-install.png): the wallet vehicle → the family berth with it docked, "Balloon T2 goes
 * into this Berth for good. The wallet item is used up.", the network cost in the fine print, INSTALL. Not armed until
 * the fee has been reviewed ([feeSol] non-null).
 */
fun installSealV2(family: VehicleFamily, asset: OwnedVehicleUi, feeSol: String?, state: VoyageSealState, armedAtMs: Long,
    error: VoyageMoneyErrorUi? = null, shortLine: String? = null, pausedReason: String? = null): VoyageSealV2Ui = VoyageSealV2Ui(
    title = "INSTALL ${familyName(family).uppercase(Locale.US)}",
    pay = VoyageSealSideUi(VoyageSealSideUi.Kind.VEHICLE, family, asset.tier),
    gets = VoyageSealSideUi(VoyageSealSideUi.Kind.BERTH, family, asset.tier),
    lines = listOf("${familyShortName(family)} ${tierTag(asset.tier)} goes into this Berth for good. The wallet item is used up."),
    cut = null, note = null, network = NetworkCostUi(feeSol), shortLine = shortLine,
    confirmLabel = "INSTALL", confirmSub = null, armedAtMs = armedAtMs, state = state, error = error,
    quoteReady = feeSol != null, pausedReason = pausedReason,
)

/**
 * The service Seal, re-done (berth-service.png): the matching wallet vehicle → RESTORE "1 → 10 trips" or the Tn+1 idle,
 * "A Cargo Cutter T2 from your wallet is used up. This Cutter keeps its berth.", the network cost in the fine print.
 * Null without a selected vehicle or service.
 */
fun serviceSealV2(ui: BerthServiceUi, armedAtMs: Long, shortLine: String? = null, pausedReason: String? = null): VoyageSealV2Ui? {
    val v = ui.installed.firstOrNull { it.installationId == ui.selectedInstallationId } ?: ui.installed.firstOrNull() ?: return null
    val op = ui.selectedOp ?: return null
    val opt = ui.options.firstOrNull { it.op == op }
    val restore = op == ServiceOp.RESTORE_USES
    return VoyageSealV2Ui(
        title = (if (restore) "RESTORE " else "UPGRADE ") + familyName(v.family).uppercase(Locale.US),
        pay = VoyageSealSideUi(VoyageSealSideUi.Kind.VEHICLE, v.family, v.tier),
        gets = if (restore) VoyageSealSideUi(VoyageSealSideUi.Kind.TRIPS, text = "${v.tripsLeft ?: UNKNOWN} → ${opt?.resultTrips ?: UNKNOWN} trips")
            else VoyageSealSideUi(VoyageSealSideUi.Kind.VEHICLE, v.family, opt?.resultTier),
        lines = listOf("A ${vehicleTitle(v)} from your wallet is used up. This ${familyShortName(v.family)} keeps its berth."),
        cut = null, note = null, network = NetworkCostUi(ui.feeSol), shortLine = shortLine,
        confirmLabel = if (restore) "RESTORE" else "UPGRADE", confirmSub = null, armedAtMs = armedAtMs, state = ui.sealState, error = ui.error,
        quoteReady = ui.feeSol != null, pausedReason = pausedReason,
    )
}

/**
 * SERVICE's primary, re-done (berth-service.png): "RESTORE TRIPS" / "UPGRADE TO T3" with the sub-line "uses up 1 Cargo
 * Cutter T2" (what the player gives) instead of the network fee, which moved into the Seal. DISABLED when the hand-in is
 * missing ("You need a Cargo Cutter T2 in your wallet") or the vehicle is away; LOCKED when the option is unavailable.
 */
fun servicePrimaryV2(op: ServiceOp?, optionAvailable: Boolean, optionReason: String?, resultTier: Int?, handInPresent: Boolean,
    handInName: String, vehicleAway: Boolean, awayLine: String?): PrimaryLook? {
    if (op == null) return null
    val label = if (op == ServiceOp.RESTORE_USES) "RESTORE TRIPS" else "UPGRADE TO ${tierTag(resultTier)}"
    val sub = "uses up 1 $handInName"
    return when {
        vehicleAway -> PrimaryLook(label, null, Verb.GOLD, CommandState.DISABLED, awayLine ?: "Service when it is docked")
        !optionAvailable -> PrimaryLook(label, null, Verb.GOLD, CommandState.LOCKED, optionReason ?: "Not available")
        !handInPresent -> PrimaryLook(label, sub, Verb.GOLD, CommandState.DISABLED, "You need a $handInName in your wallet")
        else -> PrimaryLook(label, sub, Verb.GOLD, CommandState.ENABLED, null)
    }
}

// ------------------------------------------------------------------------------------------------------- paid expedition

/** The SEND sub-line on a permit route: "with a 7-day permit" (the price lives only in the Seal). */
fun permitSubLine(days: Int?): String = if (days != null && days > 0) "with a $days-day permit" else "with a permit"

/**
 * SEND's look, round 2: [sendLook] with the permit sub-line replaced by [permitSubLine] (send-paid.png: "SEND · with a
 * 7-day permit"); the SOL amount no longer shows on the sheet. Every other state is unchanged.
 */
fun sendLookV2(ui: LodgeSendUi, permitDays: Int?): PrimaryLook {
    val look = sendLook(hasRoute = ui.selectedRouteId != null || ui.selectedStarterRouteId != null,
        hasVehicle = ui.selectedInstallationId != null, previewState = ui.previewState, preview = ui.preview,
        ordersAllowed = ui.ordersAllowed, ordersReason = ui.ordersReason, lockedReason = ui.lockedReason, busy = ui.busy,
        pending = ui.pending != null, previewError = ui.previewError)
    return if (ui.preview?.permit != null && look.state == CommandState.ENABLED) look.copy(sub = permitSubLine(permitDays)) else look
}

/**
 * The permit Seal (send-paid.png; SPEC E1.2): SOL → the island + "7 DAYS", "Any of your boats may sail to Cinderfall for
 * 7 days.", the realm's cut box with the Seeker spot icon (the only place the split appears), the note "Paid from your
 * wallet. You sign once. The Cutter sails as soon as it is paid.", BUY & SEND with the price. A CHECKING price shows "…"
 * and does not arm; UNAVAILABLE shows "No spot sells … permits today" + SEEKER ISLAND; SHORT shows the Need-more line.
 * Honest when nothing was quoted: an unknown length claims no duration line (nothing is checking it) and the island side
 * reads "PERMIT"; a blank split draws no cut box; an unavailable price puts no amount under BUY & SEND.
 */
fun permitSealV2(ui: PermitSealUi): VoyageSealV2Ui {
    val amount = priceText(ui.price)
    val status = ui.price.status
    return VoyageSealV2Ui(
        title = "PERMIT FOR ${ui.realm.uppercase(Locale.US)}",
        pay = VoyageSealSideUi(VoyageSealSideUi.Kind.SOL, text = amount, caption = "SOL"),
        gets = VoyageSealSideUi(VoyageSealSideUi.Kind.ISLAND, text = ui.days?.let { "$it DAYS" } ?: "PERMIT", caption = ui.realm, route = ui.route),
        lines = if (ui.days != null) listOf("Any of your boats may sail to ${ui.realm} for ${ui.days} days.") else emptyList(),
        cut = ui.splitLine.takeIf { it.isNotBlank() }?.let { VoyageCutUi(ui.spotIcon, "The realm's cut:", it) },
        note = ui.note ?: "Paid from your wallet. You sign once. The ${ui.vehicleName} sails as soon as it is paid.",
        network = null,
        shortLine = if (status == PriceStatus.SHORT) "Add SOL in Profile › WALLET" else null,
        confirmLabel = "BUY & SEND",
        confirmSub = if (status == PriceStatus.UNAVAILABLE) null else "$amount SOL",
        armedAtMs = ui.armedAtMs,
        state = ui.state,
        error = ui.error,
        quoteReady = status == PriceStatus.OK || status == PriceStatus.SERVER_ZERO,
        unavailable = if (status == PriceStatus.UNAVAILABLE) VoyageUnavailableUi(ui.unavailableLine ?: "No spot sells ${ui.realm} permits today", "SEEKER ISLAND") else null,
    )
}

// -------------------------------------------------------------------------------------------------------------- PASSPORT

/** A stamp is earned when the realm recorded at least one return there. */
fun stampReached(stamp: StampUi): Boolean = stamp.trips > 0

/** "×9" under an earned stamp; "not yet" otherwise. */
fun stampCaption(stamp: StampUi): String = if (stampReached(stamp)) "×${stamp.trips}" else "not yet"

/** The header live chip: "4 of 8 realms" ("… realms" before the first read). */
fun passportRealmsLine(stamps: List<StampUi>): String =
    if (stamps.isEmpty()) "$UNKNOWN realms" else "${stamps.count(::stampReached)} of ${stamps.size} realms"

/** The source line (native `RealmPassportScreen` copy): null while OK. */
fun passportSourceLine(state: SourceState): String? = when (state) {
    SourceState.OK -> null
    SourceState.NOT_CONFIGURED -> "The passport is not open on this server yet."
    SourceState.CONFLICT, SourceState.UNAVAILABLE -> "These records could not be verified. Check again later."
}

/** REFRESH STAMPS exists only in the error state (2026-10-03 critic pass: stamps update on their own). */
fun passportShowsRefresh(state: SourceState): Boolean = state == SourceState.CONFLICT || state == SourceState.UNAVAILABLE

/** No trip yet: every stamp dashed, "Your first trip stamps your home realm". */
fun passportIsEmpty(ui: PassportUi): Boolean = !ui.loading && ui.stamps.none(::stampReached) && ui.recent.isEmpty()

/** Long realm names ("Solana Reach") get −0.5 px tracking to fit the 98 dp tile; names are never shortened. */
fun stampNameNeedsTightTracking(name: String): Boolean = name.length > 10

// ------------------------------------------------------------------------------------------------------ advanced dispatch

/** How a route row of "WHERE IT CAN SAIL" draws. */
enum class RouteRowState { SELECTED, AVAILABLE, PERMIT, BLOCKED }

/** A blocked row (grade above the vehicle tier) wins; then the selection; then the PERMIT tag. */
fun routeRowState(row: RouteRowUi, selectedRouteId: String?): RouteRowState = when {
    row.blockedReason != null -> RouteRowState.BLOCKED
    row.route.routeId == selectedRouteId -> RouteRowState.SELECTED
    row.needsPermit -> RouteRowState.PERMIT
    else -> RouteRowState.AVAILABLE
}

/** "Grade III or lower" for the vehicle's tier; the starter sails starter routes only. */
fun vehicleGradeLine(vehicle: VehicleUi?): String = when {
    vehicle == null -> UNKNOWN
    vehicle.maxGrade <= 0 -> "Starter routes only"
    else -> "Grade ${gradeNumeral(vehicle.maxGrade)} or lower"
}

/** "+140", or "…" while the preview is unknown. */
fun yieldText(yield: String?): String = yield?.takeIf { it.isNotBlank() && it != UNKNOWN }?.let { if (it.startsWith("+")) it else "+$it" } ?: UNKNOWN

/** What the advanced SEND primary does. */
enum class AdvancedAction { SEND, PERMIT, CHECK, EXPLAIN, NONE }

/** The advanced SEND look, its route and whether the green RESTORE shows beside it. */
data class AdvancedLook(val look: PrimaryLook, val action: AdvancedAction, val restore: Boolean = false)

/**
 * The advanced SEND primary (send-advanced.png; SPEC E1.3 states), in priority order: a saved departure is checked, never
 * re-sent; a server-off feature is LOCKED; in flight "Sending"; vehicle away "Back in 1h 12m"; 0 trips left → off + green
 * RESTORE (→ Berth › SERVICE); no route / a blocked route explains; a loading preview "Checking route"; a preview error
 * offers CHECK; short supplies explain; a permit route opens the permit Seal ("with a 7-day permit"); otherwise gold
 * "SEND AIRSHIP" / "uses 1 trip · back at 03:20". Null when there is no crafted vehicle (the empty state shows).
 */
fun advancedSendLook(ui: AdvancedSendUi): AdvancedLook? {
    val v = ui.vehicle ?: return null
    val label = "SEND ${familyShortName(v.family).uppercase(Locale.US)}"
    val row = ui.routes.firstOrNull { it.route.routeId == ui.selectedRouteId }
    fun off(reason: String, restore: Boolean = false) =
        AdvancedLook(PrimaryLook(label, null, Verb.GOLD, CommandState.DISABLED, reason), AdvancedAction.EXPLAIN, restore)
    val short = ui.preview?.supplies?.firstOrNull { it.short }
    return when {
        ui.pending != null -> AdvancedLook(PrimaryLook("Checking departure", null, Verb.STONE, CommandState.BUSY, null), AdvancedAction.NONE)
        ui.lockedReason != null -> AdvancedLook(PrimaryLook(label, null, Verb.GOLD, CommandState.LOCKED, ui.lockedReason), AdvancedAction.EXPLAIN)
        ui.busy -> AdvancedLook(PrimaryLook("Sending", null, Verb.STONE, CommandState.BUSY, null), AdvancedAction.NONE)
        v.status == VehicleStatus.AWAY -> off("Back in ${v.returnsAt ?: UNKNOWN}")
        isWornOut(v) -> off("No trips left. Restore them at the Berth.", restore = true)
        row == null -> off("Choose where it sails")
        row.blockedReason != null -> off(row.blockedReason)
        ui.previewState == PreviewState.LOADING -> AdvancedLook(PrimaryLook("Checking route", null, Verb.STONE, CommandState.BUSY, null), AdvancedAction.NONE)
        ui.previewState == PreviewState.ERROR || ui.preview == null ->
            AdvancedLook(PrimaryLook("CHECK", null, Verb.STONE, CommandState.ENABLED, ui.previewError ?: "The Lodge can't reach the route chart."), AdvancedAction.CHECK)
        short != null -> off(short.shortLine ?: "Need more ${short.name}")
        row.needsPermit -> AdvancedLook(PrimaryLook(label, permitSubLine(ui.permitDays), Verb.GOLD, CommandState.ENABLED, null), AdvancedAction.PERMIT)
        else -> AdvancedLook(PrimaryLook(label, "uses 1 trip · back at ${ui.preview?.returnsAtLocal ?: UNKNOWN}", Verb.GOLD, CommandState.ENABLED, null),
            AdvancedAction.SEND)
    }
}
