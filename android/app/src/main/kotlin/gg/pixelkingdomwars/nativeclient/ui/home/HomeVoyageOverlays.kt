package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionView
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.LocalBackRegistry
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.isoMs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.starterRewards
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageRealmName
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** One Home overlay presentation, with no request, repository or signing lifetime. */
internal class HomeVoyageOverlays {
    val presence = HomeStarterReviewPresence()
    var starter by mutableStateOf<HomeStarterDepartureController?>(null)
    var collector by mutableStateOf<HomeVoyageCollector?>(null)
    var repeatTrip by mutableStateOf<TripUi?>(null)
    var collect by mutableStateOf<CollectUi?>(null)
    var permit by mutableStateOf<PermitSealUi?>(null)
    var collectActions by mutableStateOf(CollectActions())
    var permitActions by mutableStateOf(PermitSealActions())
    /** The key of a starter departure the server just accepted; the open Lodge turns to TRIPS once and clears it. */
    var departed by mutableStateOf<String?>(null)
    /** The starter flights this Home has seen, so an automatic return is celebrated once (presentation memory only). */
    val returnWatch = StarterReturnWatch()
    /** True while the Lodge body is composed (it consumes [repeatTrip] itself). */
    var lodgeMounted = false
    val shown: Boolean get() = starter?.review != null || collect != null || permit != null
    fun dismissCollect() { collect = null; if (starter?.review == null && permit == null) presence.painted = false }
    fun close(force: Boolean = false) {
        val sealWasVisible = starter?.review != null || permit != null
        starter?.cancel(force)
        collect = null
        permit = null
        if (force || !sealWasVisible) presence.painted = false
    }
}

/**
 * The starter flight each kingdom was last seen with. The server's starter view keeps a flight until its return is settled
 * (the in-flight row is deleted only by that settlement, which credits the departure receipt's net cargo in full), so a
 * flight this Home saw, gone from a later view of the same kingdom and boat after its return time, came back. [observe]
 * answers it once. A first look (nothing seen yet) never celebrates history.
 */
internal class StarterReturnWatch {
    private val flights = mutableMapOf<String, StarterExpeditionFlight>()

    fun observe(view: StarterExpeditionView?): StarterExpeditionFlight? {
        if (view == null) return null
        val previous = flights[view.baseId]
        val flight = view.flight
        if (flight != null) flights[view.baseId] = flight else flights.remove(view.baseId)
        if (previous == null || previous.expeditionId == flight?.expeditionId) return null
        val due = isoMs(previous.returnsAt) ?: return null
        val now = isoMs(view.serverNow) ?: return null
        return previous.takeIf { now >= due && view.installation?.installationId == previous.installationId }
    }
}

/** The collect card for a starter flight that came back: the receipt's own cargo, the starter boat, its coast route. */
internal fun homeStarterReturnCollect(flight: StarterExpeditionFlight, berthId: String?): CollectUi {
    val boat = VehicleUi(VehicleFamily.STARTER, null, flight.installationId, berthId ?: "", VehicleStatus.DOCKED, null, null, null, 0)
    val rewards = starterRewards(flight.route)
    val trip = TripUi(flight.expeditionId, boat, null, flight.route.routeId, 1f, null, TripState.COLLECTED, rewards, rewards,
        title = voyageRealmName(flight.route.routeId))
    return CollectUi(listOf(trip), rewards, boat, receiptId = "starter:" + flight.expeditionId)
}

/** Full viewport mount outside the bounded Lodge sheet. Back never confirms a command. */
@Composable internal fun HomeVoyageOverlayHost(overlays: HomeVoyageOverlays, state: StarterExpeditionState?,
    modifier: Modifier = Modifier, explain: (String) -> Unit) {
    val controller = overlays.starter
    val review = controller?.review
    val armedAt = remember(review) { System.currentTimeMillis() }
    val ui = review?.let { homeStarterDepartureSeal(it, state?.busy == true, armedAt) }
    val registry = LocalBackRegistry.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val visible = overlays.shown || overlays.presence.painted
    SideEffect { if (overlays.shown) overlays.presence.painted = true }
    DisposableEffect(overlays, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) overlays.close(force = true) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); overlays.close(force = true) }
    }
    DisposableEffect(registry, overlays, visible) {
        val registration = registry.register(BackPriority.CONFIRM, visible) { overlays.close() }
        overlays.presence.back = registration
        onDispose { registry.unregister(registration); if (overlays.presence.back === registration) overlays.presence.back = null }
    }
    BackHandler(visible) { registry.dispatch() }
    val admitted = controller?.currentAndAdmitted() == true
    LaunchedEffect(controller, state?.review, admitted) { if (!admitted) controller?.cancel() }
    // SPEC §3 motion 4 step 5: the departure toast waits for the server's accepted proof of the confirmed request. A
    // finished confirm alone is not acceptance (the owner keeps refusals and lost answers as its own notices).
    var sailing by remember(overlays) { mutableStateOf<String?>(null) }
    LaunchedEffect(sailing, state) {
        val key = sailing ?: return@LaunchedEffect
        when (homeStarterSailed(state, key)) {
            true -> {
                Toasts.post(homeLodgeDepartureLine(VehicleFamily.STARTER)); sailing = null
                // Exploration end to end: archive the accepted proof and re-read the kingdom, so the boat shows at sea and
                // the open Lodge turns to TRIPS. Its own scope: this effect restarts as soon as `sailing` clears.
                overlays.departed = key
                val settling = overlays.starter
                if (settling != null) scope.launch {
                    try { settling.settleAccepted() }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* The Lodge's own open re-checks the saved proof; nothing was sent. */ }
                }
            }
            false -> {
                // A definitive refusal used to end silently: the Seal closed and nothing said why the boat stayed.
                if (state?.journal?.operation?.takeIf { it.command.key == key }?.refusal != null)
                    explain("The departure was declined. The boat stays at the Berth.")
                sailing = null
            }
            null -> Unit
        }
    }
    // The starter boat's return card is played by HomeStarterReturnWatcher (HomeStarterReturns.kt), which also holds the
    // owner's read lease on Home; this host only draws it.
    val exited: () -> Unit = { if (!overlays.shown) overlays.presence.painted = false }
    VoyageSealV2(ui, VoyageSealV2Actions(onConfirm = {
        if (controller != null && review != null) scope.launch {
            try {
                if (!controller.confirm(review)) explain("Review this departure again before confirming.")
                else { sailing = review.command.key }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The departure needs checking. Its original request has been kept.") }
        }
    }, onBack = { controller?.cancel() }), modifier, onExitFinished = exited)
    PermitSeal(overlays.permit, overlays.permitActions, modifier, onExitFinished = exited)
    overlays.collect?.let { collect ->
        // collect.png: the card (centred x, top 276) under the gain pip, which sits right 8, top 128 below the HUD stack.
        Box(modifier) {
            VoyageCollectCard(collect, overlays.collectActions)
            CollectGainPip(collect.rewards, Modifier.align(Alignment.TopEnd).padding(top = 128.dp, end = 8.dp))
        }
    }
}
