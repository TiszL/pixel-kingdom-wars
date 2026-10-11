package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionView
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetView
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.isoMs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.prim
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject

/*
 * Voyage morning gap audit: "a routine refresh never blanks shown data" (voyage SPEC §0.5: "Every list shows its last
 * snapshot while a refresh runs"). The borrowed owners drop their current view at the start of every read: the starter
 * expedition and starter fleet repositories set `view = null` in refresh(), and the vehicle repository clears its fleet and
 * routes while it re-hydrates. Each Lodge / Berth open re-reads them, so the sheet flashed skeletons, "…" route segments and
 * an "Installing" primary on every visit. This file keeps, for display only, the last view each owner showed for the same
 * kingdom while that owner is busy re-reading. Admission and every command read the owners' own state, never this.
 */

/** The last view each voyage owner showed for one kingdom. Plain fields (not snapshot state): it never recomposes. */
internal class VoyageSnapshotMemory(val baseId: String?) {
    var starterView: StarterExpeditionView? = null
    var fleetView: StarterFleetView? = null
    var fleet: JsonObject? = null
    var routes: JsonObject? = null
}

/** The three owner states as the voyage sheets draw them. */
internal data class RetainedVoyage(val starter: StarterExpeditionState?, val starterFleet: StarterFleetState?, val vehicles: VehicleState?)

/**
 * Remembers each owner's current view of [VoyageSnapshotMemory.baseId] and, while an owner is busy with its view dropped,
 * hands back the last one instead. A finished read that failed (busy again false, view still null) shows as it is: the
 * sheet then says it could not refresh rather than drawing an old view as current.
 */
internal fun retainVoyage(memory: VoyageSnapshotMemory, starter: StarterExpeditionState?, starterFleet: StarterFleetState?,
    vehicles: VehicleState?): RetainedVoyage {
    val base = memory.baseId
    starter?.view?.takeIf { it.baseId == base }?.let { memory.starterView = it }
    starterFleet?.view?.takeIf { it.baseId == base }?.let { memory.fleetView = it }
    vehicles?.fleet?.takeIf { it.prim("baseId") == base }?.let { memory.fleet = it }
    vehicles?.routes?.takeIf { it.prim("baseId") == base }?.let { memory.routes = it }
    val lastStarter = memory.starterView
    val lastFleetView = memory.fleetView
    val lastFleet = memory.fleet
    return RetainedVoyage(
        starter = if (starter != null && starter.busy && starter.view == null && lastStarter != null) starter.copy(view = lastStarter) else starter,
        starterFleet = if (starterFleet != null && starterFleet.busy && starterFleet.view == null && lastFleetView != null)
            starterFleet.copy(view = lastFleetView) else starterFleet,
        vehicles = if (vehicles != null && vehicles.busy && vehicles.fleet == null && lastFleet != null)
            vehicles.copy(fleet = lastFleet, routes = vehicles.routes ?: memory.routes) else vehicles,
    )
}

/** The starter flight's id once its scheduled return has passed by [nowMs]; null while it is still out or unknown. */
internal fun starterDueFlightId(flight: StarterExpeditionFlight?, nowMs: Long): String? =
    flight?.takeIf { f -> isoMs(f.returnsAt)?.let { it <= nowMs } == true }?.expeditionId

/** Re-read pauses after a starter flight falls due: the server settles the automatic return when it is next read. */
private val STARTER_DUE_READS_MS = longArrayOf(1_500L, 5_000L, 15_000L)

/**
 * While a voyage sheet is open, a starter flight whose return time passed is re-read through the existing owner (its own
 * GET), so the server settles the automatic return, the trip leaves "Due back · checking" and the return moment plays.
 * Stops as soon as the flight is gone (the key clears). Never a mutation, never a new owner or driver.
 */
@Composable internal fun HomeStarterDueRefresh(owner: HomeStarterOwner?, flight: StarterExpeditionFlight?, nowMs: Long) {
    val due = starterDueFlightId(flight, nowMs)
    val current by rememberUpdatedState(owner)
    LaunchedEffect(due) {
        if (due == null) return@LaunchedEffect
        for (pause in STARTER_DUE_READS_MS) {
            delay(pause)
            current?.let { o -> if (o.projection.canRead()) o.refresh.invoke(Unit) }
        }
    }
}
