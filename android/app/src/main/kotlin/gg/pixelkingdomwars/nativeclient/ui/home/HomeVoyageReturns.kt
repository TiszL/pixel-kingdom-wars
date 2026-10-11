package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.CollectUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.*

/** One explicit collect gesture, through the retained Vehicle owner. No receipt means no celebration. */
internal class HomeVoyageCollector(
    private val identity: HomeRouteIdentity,
    private val current: () -> HomeRouteIdentity?,
    private val admitted: () -> Boolean,
    private val input: () -> VoyageLiveInputs,
    private val collectExisting: suspend () -> Boolean,
) {
    var busy by mutableStateOf(false)
        private set
    suspend fun collect(): CollectUi? {
        if (busy || current() != identity || !admitted()) return null
        val before = input()
        if (before.baseId != identity.baseId || before.vehicles?.busy == true || before.vehicles?.review != null) return null
        if (voyageCollectNeedsCheck(before.vehicles, identity.baseId)) return null
        val ready = lodgeSheetUi(before, LodgeLocalState()).trips.trips.filter { it.state == TripState.READY }.map { it.tripId }.toSet()
        if (ready.isEmpty()) return null
        val prior = before.vehicles?.journal?.records.orEmpty().map { it.id }.toSet()
        busy = true
        try {
            if (!collectExisting() || current() != identity || !admitted()) return null
            val after = input()
            val state = after.vehicles
            if (after.baseId != identity.baseId || state?.error != null || state?.fleet == null ||
                !voyageCollectMatches(state.selected, identity.baseId, prior)) return null
            return collectUi(state.selected, after, ready)
        } finally { busy = false }
    }
}

/** A world bubble lends only a player tap; Home still checks its own current route and overlay admission.
 *  [busy] is the collector's own in-flight flag: the bubble draws stone dots and ignores taps while it is true
 *  (voyage SPEC §2 "Collecting"). */
internal data class HomeVoyageReturnAction(val collect: () -> Unit, val busy: () -> Boolean = { false })
internal val LocalHomeVoyageReturnAction = staticCompositionLocalOf<HomeVoyageReturnAction?> { null }
