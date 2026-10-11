package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.data.StarterFleetReview
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import gg.pixelkingdomwars.nativeclient.ui.nav.LocalBackRegistry
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** berth-starter.png success banner (SPEC §10 States), shown only after the server accepted the install. */
internal const val STARTER_INSTALLED_LINE = "Starter Boat is in its berth"

/** 9a66094e: borrows only the existing reviewed StarterFleet callbacks, never a repository or command lifetime. */
internal class HomeStarterFleetReviewController(
    private val identity: HomeRouteIdentity,
    private val current: () -> HomeRouteIdentity?,
    private val admitted: () -> Boolean,
    private val state: () -> StarterFleetState,
    private val selectedBerth: () -> String?,
    private val reviewInstall: suspend (String) -> Unit,
    private val reviewSaved: suspend () -> Unit,
    private val confirmReview: suspend (StarterFleetReview) -> Unit,
    private val dismissReview: () -> Unit,
    /** The existing owner's GET-only `finish`: archives an accepted install and re-reads the kingdom. */
    private val finishAccepted: suspend () -> Unit = {},
    /** The existing owner's archive of a declined install (GET by key, then the local archive; never a POST). */
    private val archiveUnused: suspend () -> Unit = {},
) {
    private var owned: StarterFleetReview? by mutableStateOf(null)
    private var confirming = false
    fun currentAndAdmitted() = current() == identity && admitted()
    val review: StarterFleetReview? get() = owned?.takeIf {
        current() == identity && state().review === it && it.generation == identity.baseSelectionGeneration &&
            it.command.request.baseId == identity.baseId
    }

    suspend fun open(): Boolean {
        if (!currentAndAdmitted()) return false
        var before = state()
        if (before.busy || before.review != null) return false
        // Exploration end to end: an install the server declined could only be archived from the old StarterFleet screen,
        // so INSTALL FREE fell there. The existing owner archives it (GET by key, then the local archive) and a fresh review
        // opens in the same tap. An attempted install with no outcome is never archived: it is CHECKed.
        if (before.journal.operation?.let { it.proof == null && it.refusal != null && it.command.request.baseId == identity.baseId } == true) {
            archiveUnused()
            if (!currentAndAdmitted()) return false
            before = state()
            if (before.busy || before.review != null || before.journal.operation != null) return false
        }
        val view = before.view?.takeIf { it.baseId == identity.baseId && it.wallet == before.journal.identity.wallet } ?: return false
        if (!view.acceptingInstallations || view.installation != null) return false
        val selected = selectedBerth()
        val saved = before.journal.operation
        // Owner 2026-10-06 (free placement): players now place several Berths. A saved request keeps its own Berth (same key);
        // else the Berth they opened; else the first vacant one. Before, two vacant Berths and no selection (the sheet opened
        // from the Lodge) left INSTALL FREE doing nothing.
        val berth = saved?.command?.request?.berthId?.let { id -> view.eligibleBerths.singleOrNull { it.berthId == id } }
            ?: selected?.let { id -> view.eligibleBerths.singleOrNull { it.berthId == id } }
            ?: view.eligibleBerths.firstOrNull()
        berth ?: return false
        if (saved == null) reviewInstall(berth.berthId)
        else {
            if (saved.command.request.baseId != identity.baseId || saved.command.request.berthId != berth.berthId ||
                saved.proof != null || saved.refusal != null) return false
            reviewSaved() // Same saved command/key; the existing owner checks its original receipt first.
        }
        val next = state().review ?: return false
        if (!currentAndAdmitted() || next.command.request.baseId != identity.baseId || next.generation != identity.baseSelectionGeneration) {
            if (state().review === next) dismissReview()
            return false
        }
        owned = next
        return true
    }

    suspend fun confirm(rendered: StarterFleetReview): Boolean {
        if (!currentAndAdmitted() || confirming || state().busy || review !== rendered) return false
        confirming = true
        try { confirmReview(rendered) } finally { confirming = false }
        return true
    }

    /** Saved terminal or foreign-kingdom requests keep their existing recovery owner; never replace an install. */
    fun openSavedOutcome(openRecovery: () -> Unit): Boolean {
        if (!currentAndAdmitted()) return false
        val current = state()
        if (current.busy || current.review != null) return false
        val saved = current.journal.operation ?: return false
        if (saved.proof == null && saved.refusal == null && saved.command.request.baseId == identity.baseId) return false
        openRecovery()
        return true
    }

    fun cancel(force: Boolean = false) {
        if (!force && state().busy) return
        val held = owned
        if (held != null && state().review === held) dismissReview()
        owned = null
    }

    /** True once this kingdom's saved starter install has the server's accepted proof. */
    fun accepted(): Boolean = state().journal.operation?.let { it.proof != null && it.command.request.baseId == identity.baseId } == true

    /**
     * Morning gap audit (exploration end to end): an accepted install stayed the saved request, so the next INSTALL FREE,
     * CHECK or History tap fell to the old StarterFleet screen ([openSavedOutcome]) and the Berth still read "no boat".
     * Once the proof is saved, the existing owner archives it and re-reads the kingdom (GET only, the old page's own
     * `finish`). Waits briefly for the confirm to end; never sends anything.
     */
    suspend fun settleAccepted(): Boolean {
        if (settling) return false
        settling = true
        try {
            repeat(HOME_VOYAGE_SETTLE_ATTEMPTS) {
                if (current() != identity || !accepted()) return false
                val now = state()
                if (!now.busy && now.review == null && admitted()) { finishAccepted(); return true }
                delay(HOME_VOYAGE_SETTLE_POLL_MS)
            }
            return false
        } finally { settling = false }
    }
    private var settling = false

    /** Each Berth open re-reads the owner; INSTALL FREE tapped then waits for that read instead of being refused. */
    suspend fun awaitReady() {
        withTimeoutOrNull(HOME_VOYAGE_READY_WAIT_MS) {
            while (current() == identity && state().busy) delay(HOME_VOYAGE_SETTLE_POLL_MS)
        }
    }
}

/** Paint/Back lifetime only; an exiting seal still blocks navigation and the single resource stack. */
internal class HomeStarterReviewPresence {
    var painted by mutableStateOf(false)
    var back: BackRegistry.Registration? by mutableStateOf(null)
    fun ownsBack(active: BackRegistry.Registration?) = active != null && active === back
}

/** Existing voyage review art and arming, with the free owner's actual no-signature/no-fee contract. */
internal fun homeStarterFleetSeal(review: StarterFleetReview, busy: Boolean, armedAtMs: Long) = VoyageSealV2Ui(
    title = "INSTALL STARTER BOAT",
    pay = VoyageSealSideUi(VoyageSealSideUi.Kind.VEHICLE, VehicleFamily.STARTER),
    gets = VoyageSealSideUi(VoyageSealSideUi.Kind.BERTH, VehicleFamily.STARTER),
    lines = listOf(if (review.command.installation == null) "Install your free Starter Boat in this kingdom's reviewed Berth."
        else "Keep this kingdom's existing Starter Boat.", "No SOL, Gems, SHARDS or resource cost. The boat stays with this kingdom."),
    cut = null, note = "No wallet signature is needed.", network = null, shortLine = null,
    confirmLabel = if (review.command.installation == null) "INSTALL FREE" else "KEEP EXISTING BOAT", confirmSub = null,
    armedAtMs = armedAtMs, state = if (busy) VoyageSealState.SENDING else VoyageSealState.ARMED,
)

/** Mounted once in Home's full viewport overlay, outside the bounded Berth sheet. */
@Composable internal fun HomeStarterFleetReviewOverlay(controller: HomeStarterFleetReviewController?, state: StarterFleetState?,
    presence: HomeStarterReviewPresence, modifier: Modifier = Modifier, explain: (String) -> Unit) {
    val review = controller?.review
    val armedAt = remember(review) { System.currentTimeMillis() }
    val ui = review?.let { homeStarterFleetSeal(it, state?.busy == true, armedAt) }
    val registry = LocalBackRegistry.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val visible = ui != null || presence.painted
    SideEffect { if (ui != null) presence.painted = true }
    DisposableEffect(controller, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) controller?.cancel(force = true) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); controller?.cancel(force = true); presence.painted = false }
    }
    DisposableEffect(registry, controller, visible) {
        val registration = registry.register(BackPriority.CONFIRM, visible) { controller?.cancel() }
        presence.back = registration
        onDispose { registry.unregister(registration); if (presence.back === registration) presence.back = null }
    }
    BackHandler(visible) { registry.dispatch() }
    val admitted = controller?.currentAndAdmitted() == true
    LaunchedEffect(controller, state?.review, admitted) { if (!admitted) controller?.cancel() }
    VoyageSealV2(ui, VoyageSealV2Actions(
        onConfirm = { if (controller != null && review != null) scope.launch {
            try {
                if (!controller.confirm(review)) explain("Review this starter installation again before confirming.")
                // berth-starter.png success: the banner, then the Berth re-reads so the primary becomes GO TO LODGE.
                else if (controller.accepted()) {
                    Toasts.post(STARTER_INSTALLED_LINE)
                    controller.settleAccepted()
                }
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The starter installation could not be confirmed. Check its saved receipt before trying again.") }
        } },
        onBack = { controller?.cancel() },
    ), modifier, onExitFinished = { presence.painted = false })
}
