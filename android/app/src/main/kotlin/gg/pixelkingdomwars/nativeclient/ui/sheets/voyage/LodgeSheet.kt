package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.graphicsLayer
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.ResourceStack
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi

/**
 * Design component: the Lodge tall sheet (design/final/voyage SPEC §0.2 skeleton, §3 SEND, §4 CHOOSE AN ISLAND, §5a TRIPS,
 * §6 locked SEND): the living `VoyageChart` header, the SEND · TRIPS · PASSPORT tabs, and the panel of the active tab with
 * its pinned primary. It renders `Destination.Lodge(tab, mode, routeId)`; tab ids are the Destination's ("SEND",
 * "UNDER_WAY", "PASSPORT"); the TRIPS label keeps the id UNDER_WAY (SPEC §11 row 2).
 *
 * Which SEND panel shows: [LodgeSheetUi.locked] (no vehicle / no Berth) wins, then [LodgeSheetUi.picker] (CHOOSE AN ISLAND,
 * also the first visit with no route), else [LodgeSheetUi.send]. CHANGE → picker is a 120 ms cross-fade of the panel (SheetFrame
 * cross-fades on tab changes; [LodgeSheetUi.panelKey] makes it cross-fade on panel changes too), never a new page. PASSPORT
 * is not in this cluster: the host passes its body through [passport].
 *
 * Pointer rule: the root is the kit [SheetFrame], a painted wood panel; nothing here is a full-screen clickable, pointer
 * input or scrim. The TALL sheet's 40 % scrim belongs to the SheetHost, under this frame, only while the sheet is shown;
 * empty space outside the frame reaches the kingdom. The world-strip supply stack ([LodgeSupplyStack]) is one painted hit
 * region, mounted by the host.
 */
@Immutable data class LodgeSheetUi(
    /** The level tag beside "LODGE" ("LV 4", "…"). */
    val level: String,
    /** The active tab id: "SEND", "UNDER_WAY" or "PASSPORT". */
    val tab: String,
    /** The header picture. */
    val chart: VoyageChartUi,
    /** SEND's normal panel; null while it has no data (the picker or locked panel shows instead). */
    val send: LodgeSendUi?,
    /** Non-null: SEND shows CHOOSE AN ISLAND. */
    val picker: LodgePickerUi?,
    /** Non-null: SEND shows the no-vehicle / no-Berth state. */
    val locked: LodgeLockedUi?,
    /** TRIPS (also feeds the tab badge). */
    val trips: LodgeTripsUi,
    /** The world strip's resource stack: the selected trip's supply rows, max 2, the last with the drawer caret. */
    val supplyStack: List<ResourceChipUi> = emptyList(),
    /** False hides History (a new player has nothing to show, SPEC §6). */
    val history: Boolean = true,
    /** True when the PASSPORT tab is gated (padlock; it still calls back so the caller can say why). */
    val passportLocked: Boolean = false,
) {
    /** Which panel the SEND tab shows (for the host's Back handling: Back on the picker returns to SEND). */
    val panelKey: String get() = when {
        tab == TAB_TRIPS -> TAB_TRIPS
        tab == TAB_PASSPORT -> TAB_PASSPORT
        locked != null -> "SEND_LOCKED"
        picker != null || send == null -> "SEND_PICKER"
        else -> TAB_SEND
    }

    companion object {
        const val TAB_SEND = "SEND"
        const val TAB_TRIPS = "UNDER_WAY"
        const val TAB_PASSPORT = "PASSPORT"
    }
}

/** The Lodge sheet's callbacks: frame-level ones plus each panel's. */
@Immutable data class LodgeSheetActions(
    val onTab: (tabId: String) -> Unit = {},
    /** History → WalletHistory(lodge). */
    val onHistory: () -> Unit = {},
    val onClose: () -> Unit = {},
    /** A tap on the world-strip supply stack → the resource drawer at that row. */
    val onSupplyStack: (FeatureId) -> Unit = {},
    val send: LodgeSendActions = LodgeSendActions(),
    val picker: LodgePickerActions = LodgePickerActions(),
    val locked: LodgeLockedActions = LodgeLockedActions(),
    val trips: LodgeTripsActions = LodgeTripsActions(),
)

/** The Lodge tabs: SEND (lodge-menu), TRIPS (queue-status + red count / green "!"), PASSPORT. */
fun lodgeTabs(ui: LodgeSheetUi): List<TabUi> {
    val badge = tripsTabBadge(ui.trips.trips)?.let { (text, ready) ->
        BadgeUi(text, if (ready) BadgeTone.READY else BadgeTone.COUNT, if (ready) "A trip is back" else "$text at sea")
    }
    return listOf(
        TabUi(LodgeSheetUi.TAB_SEND, "ui:lodge-menu", "SEND", null, false),
        TabUi(LodgeSheetUi.TAB_TRIPS, "ui:queue-status", "TRIPS", badge, false),
        TabUi(LodgeSheetUi.TAB_PASSPORT, PASSPORT_TAB_ICON, "PASSPORT", null, ui.passportLocked),
    )
}

/** The PASSPORT tab icon (SPEC §3 item 3: realm-passport 32); the kit's PkwIcon resolves `ui:realm-passport`. */
const val PASSPORT_TAB_ICON = "ui:realm-passport"

/**
 * The Lodge sheet. [modifier] must give it a bounded height (the SheetHost: TALL, from y 104 to the bottom). [passport] is
 * the PASSPORT tab's body (another cluster); null shows nothing there.
 *
 * Pointer rule: the root is the kit [SheetFrame] (a painted wood panel); no full-screen clickable, pointerInput, scrim or
 * draggable here. The TALL 40 % scrim is the SheetHost's, only while shown; empty space outside reaches the kingdom.
 */
@Composable fun LodgeSheet(ui: LodgeSheetUi, on: LodgeSheetActions, modifier: Modifier = Modifier,
    passport: (@Composable ColumnScope.() -> Unit)? = null) {
    val key = ui.panelKey
    // CHANGE ↔ picker ↔ locked swap the SEND panel in place: a 120 ms fade-in (SPEC §3 motion 2), never a new page.
    val reduced = LocalReducedMotion.current
    val fade = remember { Animatable(1f) }
    var lastKey by remember { mutableStateOf(key) }
    LaunchedEffect(key) {
        if (lastKey != key) {
            lastKey = key
            fade.snapTo(0f)
            fade.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH))
        }
    }
    val footerContent: @Composable ColumnScope.() -> Unit = {
        when (key) {
            LodgeSheetUi.TAB_TRIPS -> LodgeTripsFooter(ui.trips, on.trips)
            "SEND_LOCKED" -> ui.locked?.let { LodgeLockedFooter(it, on.locked) }
            LodgeSheetUi.TAB_SEND -> ui.send?.let { LodgeSendFooter(it, on.send) }
            else -> Unit
        }
    }
    // The picker and PASSPORT have no pinned primary (a tile tap chooses; PASSPORT brings its own).
    val hasFooter = key == LodgeSheetUi.TAB_TRIPS || (key == "SEND_LOCKED" && ui.locked != null) || (key == LodgeSheetUi.TAB_SEND && ui.send != null)
    SheetFrame(SheetFrameUi("LODGE", null, SheetSize.TALL, lodgeTabs(ui), key.takeIf { it != "SEND_LOCKED" && it != "SEND_PICKER" } ?: LodgeSheetUi.TAB_SEND,
        titleTag = ui.level, history = ui.history && ui.locked == null), onClose = on.onClose, modifier = modifier,
        onTab = on.onTab, onHistory = on.onHistory,
        header = { VoyageChart(ui.chart) },
        footer = if (hasFooter) footerContent else null) {
        Column(Modifier.fillMaxWidth().graphicsLayer { alpha = fade.value }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when (key) {
                LodgeSheetUi.TAB_TRIPS -> LodgeTripsBody(ui.trips, on.trips)
                LodgeSheetUi.TAB_PASSPORT -> passport?.invoke(this)
                "SEND_LOCKED" -> ui.locked?.let { LodgeLockedBody(it, on.locked) }
                "SEND_PICKER" -> LodgeRoutePickerBody(ui.picker ?: LodgePickerUi(ui.send?.routes.orEmpty(), null, null, emptyMap(), RouteFilter.ALL, loading = true), on.picker)
                else -> ui.send?.let { LodgeSendBody(it, on.send) }
            }
        }
    }
}

/** The world strip's stack while the Lodge sheet is up (SPEC §0.2 item 4): the trip's supplies, max 2 rows.
 *  Pointer rule: the kit ResourceStack is one painted hit region; nothing around it takes touches. */
@Composable fun LodgeSupplyStack(rows: List<ResourceChipUi>, onOpen: (FeatureId) -> Unit, modifier: Modifier = Modifier) {
    ResourceStack(rows.take(2), onOpen, modifier)
}

// ---------- previews (sample data; every number is a placeholder, SPEC header) ----------

internal val previewCutter = VehicleUi(VehicleFamily.CARGO_CUTTER, 2, "inst-cutter", "berth-cutter", VehicleStatus.DOCKED, 7, 10, null, 2)
internal val previewAirship = VehicleUi(VehicleFamily.COURIER_AIRSHIP, 3, "inst-airship", "berth-airship", VehicleStatus.AWAY, 7, 10, "1h 12m", 3)
internal val previewBalloon = VehicleUi(VehicleFamily.SURVEY_BALLOON, 1, "inst-balloon", "berth-balloon", VehicleStatus.DOCKED, 9, 10, null, 1)
internal val previewStarter = VehicleUi(VehicleFamily.STARTER, null, "inst-starter", "berth-starter", VehicleStatus.DOCKED, null, null, null, 0)

private val sampleRoutes = previewRoutes()
private val sampleRoute = sampleRoutes[1]

private val samplePreview = PreviewUi("3h 20m", "21:40", "120", "12", "108", listOf(
    SupplyUi("thorn_fibre", "voyage:thorn-fibre", "Thorn Fibre", "6", "46", false),
    SupplyUi("ember_nodules", "voyage:ember-nodules", "Ember Nodules", "2", "18", false)),
    FittingUi("voyage:route-compass", "+ a survey find", "Route Compass fitted"), null, "voyage:heartwood-logs", "Heartwood Logs")

private val sampleSend = LodgeSendUi(sampleRoutes, sampleRoute.routeId, listOf(previewCutter, previewAirship, previewBalloon, previewStarter),
    previewCutter.installationId, samplePreview, PreviewState.READY, null, ordersAllowed = true, pending = null)

private val sampleTrips = LodgeTripsUi(listOf(
    TripUi("t-coast", previewStarter, null, "coastal_survey", null, null, TripState.READY,
        listOf(RewardUi("heartwood_logs", "40", RewardUi.Kind.CARGO, "voyage:heartwood-logs", "Heartwood Logs")),
        listOf(RewardUi("heartwood_logs", "40", RewardUi.Kind.CARGO, "voyage:heartwood-logs", "Heartwood Logs")), title = "Coastal Survey"),
    TripUi("t-ember", previewAirship, sampleRoutes[4], null, 0.6f, "1h 12m", TripState.AT_SEA,
        listOf(RewardUi("ember_nodules", "86", RewardUi.Kind.CARGO, "voyage:ember-nodules", "Ember Nodules")), null, secondsLeft = 4320),
    TripUi("t-glass", previewCutter.copy(status = VehicleStatus.AWAY), sampleRoute, null, 0.05f, "3h 08m", TripState.AT_SEA,
        listOf(RewardUi("heartwood_logs", "108", RewardUi.Kind.CARGO, "voyage:heartwood-logs", "Heartwood Logs")), null, secondsLeft = 11280),
), docked = listOf(previewBalloon), emptyBerths = listOf(VehicleFamily.EXPEDITION_BARGE), collectState = CollectState.IDLE)

private val sampleStack = listOf(
    ResourceChipUi(FeatureId("drawer.thorn_fibre"), "shards", "46", null, false, null, name = "Thorn Fibre"),
    ResourceChipUi(FeatureId("drawer.ember_nodules"), "shards", "18", null, false, null, name = "Ember Nodules", drawerHandle = true),
)

private val sampleLodge = LodgeSheetUi("LV 4", LodgeSheetUi.TAB_SEND,
    VoyageChartUi(ChartMode.ROUTE, sampleRoute, previewCutter, TimerUi("3h 20m", "Back in 3 hours 20 minutes"), description = "Cargo Cutter to Glasswake Keys 2"),
    sampleSend, null, null, sampleTrips, sampleStack)

@Composable private fun LodgePreviewHost(ui: LodgeSheetUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        LodgeSupplyStack(ui.supplyStack, {}, Modifier.align(Alignment.TopEnd).padding(top = 14.dp, end = 8.dp))
        LodgeSheet(ui, LodgeSheetActions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}

@Preview(name = "Lodge › SEND (send.png)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendPreview() = LodgePreviewHost(sampleLodge)

@Preview(name = "Lodge › SEND, preview loading (keeps the last view)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendLoadingPreview() =
    LodgePreviewHost(sampleLodge.copy(send = sampleSend.copy(previewState = PreviewState.LOADING)))

@Preview(name = "Lodge › SEND, preview error", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendErrorPreview() =
    LodgePreviewHost(sampleLodge.copy(send = sampleSend.copy(preview = null, previewState = PreviewState.ERROR)))

@Preview(name = "Lodge › SEND, supplies short", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendShortPreview() = LodgePreviewHost(sampleLodge.copy(send = sampleSend.copy(preview = samplePreview.copy(supplies = listOf(
    SupplyUi("thorn_fibre", "voyage:thorn-fibre", "Thorn Fibre", "6", "2", true, "Need 4 more Thorn Fibre", FeatureId("building.harvester")),
    SupplyUi("ember_nodules", "voyage:ember-nodules", "Ember Nodules", "2", "18", false))))))

@Preview(name = "Lodge › SEND, feature locked", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendLockedFeaturePreview() =
    LodgePreviewHost(sampleLodge.copy(send = sampleSend.copy(lockedReason = "Expeditions are not open on this server yet")))

@Preview(name = "Lodge › SEND, busy (Sending)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendBusyPreview() = LodgePreviewHost(sampleLodge.copy(send = sampleSend.copy(busy = true)))

@Preview(name = "Lodge › SEND, pending departure (CHECK, never re-send)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendPendingPreview() =
    LodgePreviewHost(sampleLodge.copy(send = sampleSend.copy(pending = PendingDepartureUi("Your Cutter's departure is being checked"))))

@Preview(name = "Lodge › SEND, starter routes (§3a)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeSendStarterPreview() = LodgePreviewHost(sampleLodge.copy(
    chart = VoyageChartUi(ChartMode.STARTER_LOOP, vehicle = previewStarter, duration = TimerUi("40m", "Back in 40 minutes")),
    send = sampleSend.copy(selectedInstallationId = previewStarter.installationId, selectedStarterRouteId = "coastal_survey",
        starterRoutes = listOf(StarterRouteUi("coastal_survey", "COAST", "Coastal Survey"), StarterRouteUi("long_survey", "LONG", "Long Survey"),
            StarterRouteUi("introduction", "INTRO", "Introduction")),
        preview = samplePreview.copy(duration = "40m", returnsAtLocal = "19:00", grossQuantity = "44", islandPoolQuantity = "4", netQuantity = "40", fitting = null,
            supplies = listOf(SupplyUi("thorn_fibre", "voyage:thorn-fibre", "Thorn Fibre", "1", "46", false))))))

@Preview(name = "Lodge › CHOOSE AN ISLAND (route-picker.png)", widthDp = 412, heightDp = 915)
@Composable private fun LodgePickerPreview() = LodgePreviewHost(sampleLodge.copy(picker = LodgePickerUi(
    sampleRoutes.mapIndexed { i, r -> if (i == 1) r.copy(myTrip = null) else r }, "elderwood", 2, mapOf(3 to "1h"), RouteFilter.ALL,
    selectedRouteId = sampleRoute.routeId)))

@Preview(name = "Lodge › CHOOSE AN ISLAND, loading + art missing", widthDp = 412, heightDp = 915)
@Composable private fun LodgePickerLoadingPreview() = LodgePreviewHost(sampleLodge.copy(picker = LodgePickerUi(
    sampleRoutes.map { if (it.realmId == "frostveil") it.copy(artAvailable = false) else it }, "elderwood", 2, emptyMap(), RouteFilter.ALL,
    loading = true, artRetry = true)))

@Preview(name = "Lodge › CHOOSE AN ISLAND, empty filter", widthDp = 412, heightDp = 915)
@Composable private fun LodgePickerEmptyPreview() = LodgePreviewHost(sampleLodge.copy(picker = LodgePickerUi(
    sampleRoutes, "elderwood", null, emptyMap(), RouteFilter.CAN_SAIL)))

@Preview(name = "Lodge › TRIPS (trips.png)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeTripsPreview() = LodgePreviewHost(sampleLodge.copy(tab = LodgeSheetUi.TAB_TRIPS,
    chart = VoyageChartUi(ChartMode.TRIPS, trips = listOf(
        ChartTripUi(sampleRoute, VehicleFamily.CARGO_CUTTER, 2, 0.05f, false),
        ChartTripUi(sampleRoutes[4], VehicleFamily.COURIER_AIRSHIP, 3, 0.6f, false),
        ChartTripUi(null, VehicleFamily.STARTER, null, null, true)))))

@Preview(name = "Lodge › TRIPS, collecting / refresh line", widthDp = 412, heightDp = 915)
@Composable private fun LodgeTripsBusyPreview() = LodgePreviewHost(sampleLodge.copy(tab = LodgeSheetUi.TAB_TRIPS,
    trips = sampleTrips.copy(collectState = CollectState.BUSY, refreshing = true, expandedTripId = "t-ember")))

@Preview(name = "Lodge › TRIPS, collect error", widthDp = 412, heightDp = 915)
@Composable private fun LodgeTripsErrorPreview() = LodgePreviewHost(sampleLodge.copy(tab = LodgeSheetUi.TAB_TRIPS,
    trips = sampleTrips.copy(collectState = CollectState.ERROR)))

@Preview(name = "Lodge › TRIPS, nothing at sea", widthDp = 412, heightDp = 915)
@Composable private fun LodgeTripsEmptyPreview() = LodgePreviewHost(sampleLodge.copy(tab = LodgeSheetUi.TAB_TRIPS,
    trips = LodgeTripsUi(emptyList(), listOf(previewBalloon, previewStarter), emptyList(), CollectState.IDLE)))

@Preview(name = "Lodge › TRIPS, all away (no primary)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeTripsAllAwayPreview() = LodgePreviewHost(sampleLodge.copy(tab = LodgeSheetUi.TAB_TRIPS,
    trips = LodgeTripsUi(sampleTrips.trips.drop(1).map { it.copy(dueChecking = it.tripId == "t-ember") }, emptyList(), emptyList(), CollectState.IDLE, nextBackIn = "1h 12m")))

@Preview(name = "Lodge › SEND locked, no vehicle (send-locked.png)", widthDp = 412, heightDp = 915)
@Composable private fun LodgeLockedPreview() = LodgePreviewHost(sampleLodge.copy(level = "LV 1", history = false,
    chart = VoyageChartUi(ChartMode.EMPTY, sampleRoutes[0]), send = null,
    locked = LodgeLockedUi(LodgeLockedVariant.NO_VEHICLE, null, listOf("heartwood-logs", "ember-nodules", "frost-quartz", "rough-prism",
        "crown-iron-ore", "storm-ore", "sunstone-rubble", "thorn-fibre").map { VoyageResourceUi(it, "voyage:$it", it.replace('-', ' ')) }, "32"),
    trips = LodgeTripsUi(emptyList(), emptyList(), emptyList(), CollectState.IDLE), supplyStack = emptyList()))

@Preview(name = "Lodge › SEND locked, Berth needs Keep 5", widthDp = 412, heightDp = 915)
@Composable private fun LodgeBerthLockedPreview() = LodgePreviewHost(sampleLodge.copy(level = "LV 1", history = false,
    chart = VoyageChartUi(ChartMode.EMPTY, sampleRoutes[0]), send = null,
    locked = LodgeLockedUi(LodgeLockedVariant.BERTH_LOCKED, "Unlocks at Keep 5"),
    trips = LodgeTripsUi(emptyList(), emptyList(), emptyList(), CollectState.IDLE), supplyStack = emptyList()))

/** A permit price for previews that need one (SEND on a PAID_REALM island). */
internal val previewPermit = PermitUi(PriceUi(Currency.SOL, "0.03", PriceStatus.OK), "Cinderfall")
