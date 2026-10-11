package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.ContextChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RewardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.orderTrips
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.backInText
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.lodgeTripsOnly
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyagePolicyFacts
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Home trip signals (voyage SPEC §2 `home-return.png`; DESIGN-SYSTEM §6 WorldBubble / TimerPlate, Banner, ContextChip).
 * One read of the borrowed voyage owners feeds the scene markers (VoyageReturnLayer), the herald banner and the context
 * chip. Pure mappers below; the composables only read the owners exactly like the Lodge sheet does.
 *
 * Honesty: only crafted trips become READY (starter returns are automatic, LodgeLiveMapper.starterTrip), so a starter
 * flight is a TimerPlate and never a bubble or a herald. The bubble's reward badge is the server's own net cargo of the
 * first returned trip; several returns add a "+n" count, never a client-side sum. Unknown amounts read "…".
 */

/** The one icon of every trip-back signal: bubble, herald and chip (SPEC §2). */
internal const val VOYAGE_READY_ICON = "ui:ready-status"

/** DESIGN-SYSTEM §6 ContextChip: it shows 6 s on a new opportunity, then hides. No kit token carries it. */
private const val VOYAGE_CHIP_HOLD_MS = 6_000L

/** What the HUD adds for the voyage cluster: the herald (4 s) and the context chip (6 s); null while not showing. */
internal data class HomeVoyageSignals(
    val herald: HeraldUi? = null,
    val context: ContextChipUi? = null,
)

/** The green bubble over the Lodge roof (SPEC §2): every READY trip of this base, the first trip's main cargo
 *  ("+40", or "…" when unknown) and how many more trips are back. */
internal data class VoyageReadyMarker(val tripIds: List<String>, val mainReward: String, val extraCount: Int, val icon: String)

/** The TimerPlate over the Berth (SPEC §2): the soonest-returning vehicle at sea only. [returnsIn] is the mapper's own
 *  text ("1h 12m", "Due back", "…"); [progress] null draws an empty meter, never zero done. */
internal data class VoyageAwayMarker(val family: VehicleFamily, val tier: Int?, val returnsIn: String, val progress: Float?)

/** Both scene markers; a null side draws nothing. */
internal data class VoyageReturnMarkers(val ready: VoyageReadyMarker?, val away: VoyageAwayMarker?)

/**
 * The live voyage inputs for Home, read exactly like VoyageReturnLayer and the Lodge sheet read them: each borrowed
 * owner's emission, kept only while its projection is current. No owner, read or job is created here.
 */
@Composable internal fun rememberHomeVoyageInputs(buildings: List<Building>?, baseId: String?): VoyageLiveInputs {
    val owners = LocalHomeOwnerProjections.current
    val vehicle = owners.vehicle
    val vehicles = vehicle?.projection?.let { p -> p.state.collectAsState().value.takeIf { p.currentState() != null } }
    val starter = owners.starter?.projection?.let { p -> p.state.collectAsState().value.takeIf { p.currentState() != null } }
    val starterFleet = owners.starterFleet?.projection?.let { p -> p.state.collectAsState().value.takeIf { p.currentState() != null } }
    val now = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.rememberNow(clock = { System.currentTimeMillis() })
    // The plate, bubble and Berth timer keep the last view while an owner re-reads (HomeVoyageSnapshots.kt).
    val shown = retainVoyage(remember(baseId) { VoyageSnapshotMemory(baseId) }, starter, starterFleet, vehicles)
    return VoyageLiveInputs(buildings, baseId, shown.starter, shown.starterFleet, shown.vehicles,
        voyagePolicyFacts(vehicle?.policy?.invoke()), nowMs = now)
}

/** The trips of this base as the Lodge sheet lists them (starter flight + crafted receipts, COLLECTED dropped). Home calls
 *  this every second from three places, so it maps the trips only, never the whole Lodge sheet. */
internal fun homeVoyageTrips(input: VoyageLiveInputs): List<TripUi> = lodgeTripsOnly(input)

/** The READY trips, in TRIPS order ([orderTrips]). */
internal fun homeVoyageReadyTrips(trips: List<TripUi>): List<TripUi> = orderTrips(trips).filter { it.state == TripState.READY }

/** Both scene markers for [trips] (SPEC §2 data: ReturnMarkerUi, AwayMarkerUi). */
internal fun voyageReturnMarkers(trips: List<TripUi>): VoyageReturnMarkers {
    val ready = homeVoyageReadyTrips(trips)
    val readyMarker = ready.firstOrNull()?.let { first ->
        VoyageReadyMarker(ready.map { it.tripId }, mainCargo(first), ready.size - 1, VOYAGE_READY_ICON)
    }
    // SPEC §2: "the soonest-returning vehicle only"; an unknown time sorts last, a starter flight counts like any other.
    val away = orderTrips(trips).filter { it.state == TripState.AT_SEA }.minByOrNull { it.secondsLeft ?: Long.MAX_VALUE }
    val awayMarker = away?.let {
        VoyageAwayMarker(it.vehicle.family, it.vehicle.tier, it.returnsAt ?: backInText(it.secondsLeft), it.progress)
    }
    return VoyageReturnMarkers(readyMarker, awayMarker)
}

/** "+40": the trip's main cargo as the server stated it (its return when present, else the receipt's net); "…" unknown. */
private fun mainCargo(trip: TripUi): String {
    val rewards = trip.returned ?: trip.expected
    val cargo = rewards.firstOrNull { it.kind == RewardUi.Kind.CARGO } ?: rewards.firstOrNull()
    val quantity = cargo?.quantity?.takeIf { it.isNotBlank() && it != UNKNOWN } ?: return UNKNOWN
    return "+$quantity"
}

/**
 * The herald for READY trips (SPEC §2 Banner): "<Vehicle> is back ▸", naming the first trip given. Its key is every
 * READY trip id, so a new return restarts the banner and an unchanged set does not. A tap opens the Lodge on TRIPS
 * (`lodge.underway`, a Home-mounted row). No READY trip, no herald.
 */
internal fun homeVoyageHerald(ready: List<TripUi>): HeraldUi? {
    val back = ready.filter { it.state == TripState.READY }
    val first = back.firstOrNull() ?: return null
    return HeraldUi(key = "voyage:" + back.map { it.tripId }.sorted().joinToString(","), icon = VOYAGE_READY_ICON,
        text = "${familyName(first.vehicle.family)} is back ▸", target = FeatureId("lodge.underway"))
}

/** The context chip for READY trips (SPEC §2, DS ContextChip): "Ready" / "Lodge ▸"; a tap flies the camera to the
 *  Lodge (`lodge.focus`, mapped by the Home scaffold). No READY trip, no chip. */
internal fun homeVoyageContextChip(ready: List<TripUi>): ContextChipUi? =
    if (ready.none { it.state == TripState.READY }) null
    else ContextChipUi(FeatureId("lodge.focus"), VOYAGE_READY_ICON, "Ready", "Lodge ▸")

/**
 * The herald and context chip for this base. A READY trip announces itself once per composition: the banner for the
 * kit's banner hold (4 s, one at a time) and the chip for 6 s, then both hide. Newly returned trips are named first.
 * When the READY set shrinks (collected) both hide at once, so nothing says "is back" after the cargo is home.
 */
@Composable internal fun rememberHomeVoyageSignals(buildings: List<Building>?, baseId: String?): HomeVoyageSignals {
    val input = rememberHomeVoyageInputs(buildings, baseId)
    val ready = homeVoyageReadyTrips(homeVoyageTrips(input))
    val ids = ready.map { it.tripId }
    val announced = remember(baseId) { mutableSetOf<String>() }
    var herald by remember(baseId) { mutableStateOf<HeraldUi?>(null) }
    var chip by remember(baseId) { mutableStateOf<ContextChipUi?>(null) }
    LaunchedEffect(baseId, ids.sorted().joinToString(",")) {
        val fresh = ids.filter { it !in announced }
        if (fresh.isEmpty()) { herald = null; chip = null; return@LaunchedEffect }
        announced += fresh
        val newestFirst = ready.sortedBy { it.tripId !in fresh }
        herald = homeVoyageHerald(newestFirst)
        chip = homeVoyageContextChip(newestFirst)
        coroutineScope {
            launch { delay(PkwTokens.Motion.BANNER_HOLD.toLong()); herald = null }
            launch { delay(VOYAGE_CHIP_HOLD_MS); chip = null }
        }
    }
    return HomeVoyageSignals(herald, chip)
}
