package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Lodge › TRIPS (design/final/voyage/trips.png, SPEC §5a): every vehicle at sea and back (READY first,
 * then the soonest return), the docked vehicles that could sail now, the empty berths, and the pinned COLLECT (or blue
 * SEND ANOTHER, or "Next back in 1h 12m" with no primary). The tab id stays `UNDER_WAY` (SPEC §11 row 2); the label is
 * TRIPS. The collect celebration itself is [VoyageCollectCard], raised by the host after the server's return receipt.
 *
 * States: empty (nothing at sea, vehicles docked → "Nothing at sea" + SEND), loading (the last snapshot + the 2 dp line),
 * collect busy ("Collecting"), collect error (red RETRY; the caller posts the error toast with Report), a scheduled return
 * passed without a server return ("Due back · checking": a scheduled time is not a completed delivery).
 *
 * Pointer rule: only the trip rows, the SEND / GO buttons and the primary take touches.
 */

/** How a COLLECT request stands. */
enum class CollectState { IDLE, BUSY, ERROR, CHECK }

/** Everything TRIPS draws (SPEC §5a Data `LodgeTripsUi`; added fields after `collectState`). */
@Immutable data class LodgeTripsUi(
    /** Trips at sea and back (ordered here with [orderTrips]). */
    val trips: List<TripUi>,
    /** Docked vehicles (an idle row each, with SEND). */
    val docked: List<VehicleUi>,
    /** Families with an empty berth (a GO-to-Berth row each). */
    val emptyBerths: List<VehicleFamily>,
    /** The COLLECT request. */
    val collectState: CollectState,
    /** Added: with nothing back and nothing docked, the soonest return ("1h 12m"). */
    val nextBackIn: String? = null,
    /** Added: the expanded row (route, departure time, History link). */
    val expandedTripId: String? = null,
    /** Added: a refresh runs over this snapshot (the 2 dp line). */
    val refreshing: Boolean = false,
)

/** TRIPS callbacks (SPEC §5a Callbacks). */
@Immutable data class LodgeTripsActions(
    /** COLLECT / RETRY: collects every READY trip at this Lodge in one request. */
    val onCollectAll: () -> Unit = {},
    /** A row tap: expands it (route + departure time + History link). */
    val onTrip: (tripId: String) -> Unit = {},
    /** SEND on an idle-vehicle row: SEND with that vehicle selected. */
    val onSendWith: (installationId: String) -> Unit = {},
    /** GO on an empty-berth row: Berth › FLEET. */
    val onGoBerth: () -> Unit = {},
    /** The blue SEND ANOTHER primary and the empty state's SEND. */
    val onSendAnother: () -> Unit = {},
    /** The expanded row's History link: that trip's receipt in WalletHistory(lodge). */
    val onTripHistory: (tripId: String) -> Unit = {},
)

/** The TRIPS body. */
@Composable fun ColumnScope.LodgeTripsBody(ui: LodgeTripsUi, on: LodgeTripsActions) {
    val trips = orderTrips(ui.trips)
    RefreshLine(ui.refreshing)
    when (tripsEmpty(ui.trips, ui.docked)) {
        TripsEmpty.SEND -> EmptyState(EmptyStateUi("ui:lodge-menu", "Nothing at sea", "Send a vehicle to an island.", "SEND", FeatureId("lodge.expedition")),
            onGo = { on.onSendAnother() })
        // Nothing can sail: the door is the Berth (install a vehicle, or service a worn one), never a SEND that refuses.
        TripsEmpty.BERTH -> EmptyState(EmptyStateUi("ui:lodge-menu", "Nothing at sea", "Install or service a vehicle at the Berth.", "GO TO BERTH",
            FeatureId("berth.fleet")), onGo = { on.onGoBerth() })
        TripsEmpty.NONE -> VoyageLabel("AT SEA AND BACK", tripsSummary(trips))
    }
    // trips.html: rows 6 apart (CreamCard 96 trips, then the 52 dp idle / empty-berth IngredientRows).
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        trips.forEach { TripRow(it, it.tripId == ui.expandedTripId, on) }
        ui.docked.filter { it.status == VehicleStatus.DOCKED && it.installationId != null }.forEach { v ->
            val id = v.installationId.orEmpty()
            VoyageRow {
                SeaWell(Modifier.padding(start = 4.dp).size(44.dp)) { VehicleSprite(v.family, v.tier, 1, Modifier.fillMaxSize()) }
                Column(Modifier.weight(1f)) {
                    PkwText("${familyName(v.family)} is docked", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                    PkwText(if (v.family == VehicleFamily.STARTER) "Coast trips · ready now" else "Grade ${gradeNumeral(v.maxGrade)} islands · ready now",
                        PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                }
                SecondaryButton("SEND", { on.onSendWith(id) }, Modifier.padding(end = 2.dp).size(72.dp, 44.dp), verb = Verb.BLUE,
                    contentDescription = "Send the ${familyName(v.family)}")
            }
        }
        ui.emptyBerths.forEach { f ->
            VoyageRow(tint = VoyageColors.emptyRow) {
                SeaWell(Modifier.padding(start = 4.dp).size(44.dp), grey = true) { VehicleSprite(f, 1, 1, Modifier.fillMaxSize(), dim = EMPTY_ROW_SPRITE) }
                Column(Modifier.weight(1f)) {
                    PkwText("${familyShortName(f)} berth is empty", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
                    PkwText("Install one at the Berth", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                }
                GoButton(on.onGoBerth, "Go to the Berth to install a ${familyShortName(f)}", Modifier.padding(end = 2.dp).size(72.dp, 44.dp))
            }
        }
    }
}

/** The pinned COLLECT / SEND ANOTHER, or the next-return line (only while something is at sea, [tripsFooterLine]). */
@Composable fun ColumnScope.LodgeTripsFooter(ui: LodgeTripsUi, on: LodgeTripsActions) {
    val c = PkwTokens.Colors
    when (tripsPrimary(ui.trips, ui.docked)) {
        TripsPrimary.COLLECT -> {
            when (ui.collectState) {
                CollectState.IDLE -> PrimaryButton("COLLECT", on.onCollectAll, Modifier.fillMaxWidth(), sub = collectSubLine(ui.trips), icon = "ui:ready-status")
                CollectState.BUSY -> PrimaryButton("Collecting", {}, Modifier.fillMaxWidth(), verb = Verb.STONE, state = CommandState.BUSY)
                CollectState.ERROR -> PrimaryButton("RETRY", on.onCollectAll, Modifier.fillMaxWidth(), verb = Verb.RED, sub = collectSubLine(ui.trips))
                CollectState.CHECK -> PrimaryButton("CHECK RETURN", on.onCollectAll, Modifier.fillMaxWidth(), verb = Verb.BLUE,
                    sub = "Your original request is being checked")
            }
            PkwText("Goes to your stores. Tap a trip for its route.", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center)
        }
        TripsPrimary.SEND_ANOTHER -> PrimaryButton("SEND ANOTHER", on.onSendAnother, Modifier.fillMaxWidth(), verb = Verb.BLUE, icon = "ui:lodge-menu")
        TripsPrimary.NONE -> tripsFooterLine(ui.trips, ui.docked, ui.nextBackIn)?.let {
            PkwText(it, PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center)
        }
    }
}

/**
 * One trip row (CreamCard 96): the route card with the vehicle bottom-left (a starter trip shows the starter at k 4), the
 * route name (+ BACK), "Vehicle Tn · Realm", then AT_SEA's 14 dp meter + time left + "brings +n", or READY's reward + "ready"
 * on a green rim and #EEF6D8 body. A tap expands it.
 */
@Composable private fun TripRow(trip: TripUi, expanded: Boolean, on: LodgeTripsActions) {
    val c = PkwTokens.Colors
    val ready = trip.state == TripState.READY || trip.state == TripState.COLLECTING
    val reward = (if (ready) trip.returned ?: trip.expected else trip.expected).firstOrNull()
    val sub = listOfNotNull(vehicleTitle(trip.vehicle), trip.route?.realmName ?: if (ready) "back at the Berth" else null).joinToString(" · ")
    val spoken = listOfNotNull(trip.title, sub, if (ready) "back, ready to collect" else trip.returnsAt?.let { "back in $it" },
        reward?.let { "brings ${it.quantity} ${it.name}" }).joinToString(". ")
    VoyageRow(minHeight = 96.dp, rim = if (ready) c.green.face else null, tint = if (ready) VoyageColors.readyBody else null,
        description = spoken, onClick = { on.onTrip(trip.tripId) }) {
        SeaWell(Modifier.padding(start = 4.dp).size(80.dp), waves = trip.tripId.hashCode()) {
            val route = trip.route
            if (route != null) {
                LocalVoyageArt.current.routeCard(route, Modifier.fillMaxSize())
                VehicleSprite(trip.vehicle.family, trip.vehicle.tier, 1, Modifier.align(Alignment.BottomStart).size(44.dp, 36.dp))
            } else VehicleSprite(trip.vehicle.family, trip.vehicle.tier, 4, Modifier.fillMaxSize())
        }
        Column(Modifier.weight(1f).padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText(trip.title.ifBlank { UNKNOWN }, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = c.textOnParch)
                if (ready) Tag("BACK", Verb.GREEN)
            }
            PkwText(sub, PkwTokens.Type.small, color = c.textOnParch2)
            when {
                ready -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    reward?.let { VoyageIcon(it.icon, 32.dp, contentDescription = it.name) }
                    PkwText("+${reward?.quantity ?: UNKNOWN}", PkwTokens.Type.label, color = c.textOnParch)
                    PkwText(if (trip.state == TripState.COLLECTING) "collecting" else "ready", PkwTokens.Type.small, color = c.textOnParch2)
                }
                trip.dueChecking -> PkwText("Due back · checking", PkwTokens.Type.small, color = c.blue.lo)
                else -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        ProgressBar(trip.progress, "${trip.title}: ${trip.returnsAt ?: UNKNOWN} left", Modifier.weight(1f).padding(end = 2.dp), height = 14.dp)
                        PkwText(trip.returnsAt ?: UNKNOWN, PkwTokens.Type.caption, color = c.textOnParch)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PkwText("brings", PkwTokens.Type.small, color = c.textOnParch2)
                        reward?.let { VoyageIcon(it.icon, 32.dp, contentDescription = it.name) }
                        PkwText("+${reward?.quantity ?: UNKNOWN}", PkwTokens.Type.caption, color = c.textOnParch)
                    }
                }
            }
            if (expanded) {
                trip.departedLine?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
                QuietButton("History", { on.onTripHistory(trip.tripId) }, onParchment = true, contentDescription = "This trip's history")
            }
        }
    }
}
