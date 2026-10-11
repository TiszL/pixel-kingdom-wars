package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionReview
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageDuration
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyageResourceName
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/** Retains only the exact review lent by the existing ordinary departure owner. */
internal class HomeStarterDepartureController(
    private val identity: HomeRouteIdentity,
    private val current: () -> HomeRouteIdentity?,
    private val admitted: () -> Boolean,
    private val state: () -> StarterExpeditionState,
    private val reviewRoute: suspend (String) -> Unit,
    private val reviewSaved: suspend () -> Unit,
    private val confirmReview: suspend (StarterExpeditionReview) -> Unit,
    private val dismissReview: () -> Unit,
    private val finishAccepted: suspend () -> Unit = {},
    /** The existing owner's archive of an unsent draft or a declined request (GET by key, then the local archive). */
    private val archiveUnused: suspend () -> Unit = {},
) {
    private var owned: StarterExpeditionReview? by mutableStateOf(null)
    private var confirming = false
    fun currentAndAdmitted() = current() == identity && admitted()
    val review: StarterExpeditionReview? get() = owned?.takeIf {
        current() == identity && state().review === it && it.generation == identity.baseSelectionGeneration &&
            it.command.request.baseId == identity.baseId
    }

    suspend fun open(route: String): Boolean {
        if (!currentAndAdmitted()) return false
        var before = state()
        if (before.busy || before.review != null) return false
        if (before.journal.operation?.let { it.proof != null && it.command.request.baseId == identity.baseId } == true) {
            finishAccepted() // The existing owner hydrates and archives the accepted original; no mutation retry.
            if (!currentAndAdmitted()) return false
            before = state()
            if (before.busy || before.review != null || before.journal.operation != null) return false
        }
        // Exploration end to end: a request of this kingdom that can never be sent as it is (an unsent draft for another
        // route, after the player backed out of its Seal and chose LONG; or a request the server declined) used to leave
        // every SEND refused until the old screen archived it. The existing owner archives it (GET by key, then the local
        // archive, its old ARCHIVE UNUSED DRAFT / ARCHIVE DECLINED REQUEST step) and the new route is reviewed in the same tap.
        // An attempted request with no outcome is never archived here: it is CHECKed, never sent twice.
        // A paid realm draft keeps its own owner (money): only free starter requests are archived here.
        if (before.journal.operation?.let { it.proof == null && it.command.request.baseId == identity.baseId &&
                !it.command.route.routeId.startsWith("paid_") &&
                (it.refusal != null || (it.attemptRevision == null && it.command.route.routeId != route)) } == true) {
            archiveUnused()
            if (!currentAndAdmitted()) return false
            before = state()
            if (before.busy || before.review != null || before.journal.operation != null) return false
        }
        val view = before.view?.takeIf { it.baseId == identity.baseId && it.wallet == before.journal.identity.wallet } ?: return false
        if (!view.acceptingDepartures || view.installation == null || view.flight != null || view.lodgeCompletedAt == null ||
            view.routes.none { it.routeId == route && !it.routeId.startsWith("paid_") }) return false
        val original = before.journal.operation
        if (original == null) reviewRoute(route)
        else {
            if (original.command.request.baseId != identity.baseId || original.command.route.routeId != route ||
                original.proof != null || original.refusal != null || original.attemptRevision != null) return false
            reviewSaved()
        }
        val next = state().review ?: return false
        if (!currentAndAdmitted() || next.generation != identity.baseSelectionGeneration ||
            next.command.request.baseId != identity.baseId || next.command.route.routeId != route) {
            if (state().review === next) dismissReview()
            return false
        }
        owned = next
        return true
    }

    suspend fun confirm(rendered: StarterExpeditionReview): Boolean {
        if (!currentAndAdmitted() || confirming || state().busy || review !== rendered) return false
        confirming = true
        try { confirmReview(rendered) } finally { confirming = false }
        return true
    }

    fun cancel(force: Boolean = false) {
        if (!force && (state().busy || confirming)) return
        val held = owned
        if (held != null && state().review === held) dismissReview()
        owned = null
    }

    /**
     * Morning gap audit (exploration end to end): a SEND the server accepted left the saved proof un-archived and the
     * kingdom's view un-read, so the boat still looked docked, TRIPS stayed empty and a second SEND was refused with
     * "Check the saved starter request". Once this kingdom's departure has its accepted proof, the existing owner archives
     * it and re-reads the kingdom (GET only, the same `finish` its old page offered as a button). Waits briefly for the
     * owner to finish the confirm; never sends anything.
     */
    suspend fun settleAccepted(): Boolean {
        if (settling) return false
        settling = true
        try {
            repeat(HOME_VOYAGE_SETTLE_ATTEMPTS) {
                if (current() != identity) return false
                val now = state()
                val op = now.journal.operation ?: return false
                if (op.proof == null || op.command.request.baseId != identity.baseId) return false
                if (!now.busy && now.review == null && admitted()) { finishAccepted(); return true }
                delay(HOME_VOYAGE_SETTLE_POLL_MS)
            }
            return false
        } finally { settling = false }
    }
    private var settling = false

    /** A routine read of the owner (every Lodge open re-reads it) holds it busy for a moment; a SEND tapped then waits for
     *  it instead of failing with "Check the saved starter request". Bounded, so a stuck owner still answers with its reason. */
    suspend fun awaitReady() {
        withTimeoutOrNull(HOME_VOYAGE_READY_WAIT_MS) {
            while (current() == identity && (state().busy || !admitted())) delay(HOME_VOYAGE_SETTLE_POLL_MS)
        }
    }
}

/** How long a voyage tap waits for an owner's routine read, and how often it looks. */
internal const val HOME_VOYAGE_READY_WAIT_MS = 4_000L
internal const val HOME_VOYAGE_SETTLE_POLL_MS = 150L
/** About 6 s of polling for the owner to finish confirming before the accepted proof is archived. */
internal const val HOME_VOYAGE_SETTLE_ATTEMPTS = 40

internal fun homeStarterDepartureSeal(review: StarterExpeditionReview, busy: Boolean, armedAtMs: Long): VoyageSealV2Ui {
    val route = review.command.route
    return VoyageSealV2Ui(
        title = "SEND STARTER BOAT",
        pay = VoyageSealSideUi(VoyageSealSideUi.Kind.VEHICLE, VehicleFamily.STARTER),
        gets = VoyageSealSideUi(VoyageSealSideUi.Kind.VEHICLE, VehicleFamily.STARTER),
        lines = listOf("${voyageDuration(route.durationSec)} · ${voyageAmount(route.netQuantity)} ${voyageResourceName(route.resourceId)} returns to this kingdom.",
            "No SOL, Gems, SHARDS or resource cost. Returns are credited automatically.",
            "The boat cannot be called back once it sails."),
        cut = null, note = "No wallet signature is needed.", network = null, shortLine = null,
        confirmLabel = "SEND STARTER BOAT", confirmSub = null, armedAtMs = armedAtMs,
        state = if (busy) VoyageSealState.SENDING else VoyageSealState.ARMED,
    )
}
