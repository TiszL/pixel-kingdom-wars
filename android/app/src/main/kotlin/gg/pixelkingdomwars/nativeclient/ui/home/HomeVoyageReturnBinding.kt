package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.CollectActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.prim
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.voyagePolicyFacts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Home borrows the same Vehicle registration for the return bubble and the Lodge collect button. */
@Composable internal fun rememberHomeVoyageReturnAction(graph: AppGraph, session: SessionGraph, identity: HomeRouteIdentity?,
    owners: HomeOwnerProjections, overlays: HomeVoyageOverlays, admitted: () -> Boolean,
    openFeature: (String) -> Unit, explain: (String) -> Unit): HomeVoyageReturnAction? {
    // The free Starter Boat's Home loop (plate line, due read, return card) needs no vehicle owner (HomeStarterReturns.kt).
    if (identity != null) HomeStarterReturnWatcher(session, identity, owners, overlays, openFeature)
    val owner = owners.vehicle ?: return null
    val commands = owner.voyage ?: return null
    identity ?: return null
    HomeVoyageVisibilityLease(identity, null, commands)
    val currentAdmitted by rememberUpdatedState(admitted)
    val currentOwners by rememberUpdatedState(owners)
    val currentOpen by rememberUpdatedState(openFeature)
    val currentExplain by rememberUpdatedState(explain)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val collector = remember(identity, owner, commands) {
        HomeVoyageCollector(identity, { homeOwnerProjectionIdentity(graph, session) }, { currentAdmitted() }, {
            VoyageLiveInputs(session.base.state.value.base?.takeIf { it.baseId == identity.baseId }?.buildings,
                identity.baseId, currentOwners.starter?.projection?.currentState(), currentOwners.starterFleet?.projection?.currentState(),
                owner.projection.currentState(), voyagePolicyFacts(owner.policy()), nowMs = System.currentTimeMillis())
        }) { commands.collect(identity.baseId) }
    }
    DisposableEffect(overlays, collector) {
        overlays.collector = collector
        onDispose { if (overlays.collector === collector) overlays.collector = null }
    }
    LaunchedEffect(identity, owner, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            snapshotFlow { currentAdmitted() && owner.projection.canRead() }.first { it }
            if (owner.policy() != null && owner.projection.currentState()?.fleet?.prim("baseId") != identity.baseId) {
                try { owner.fleet.invoke(identity.baseId) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* The current owner's retry remains available in Lodge. */ }
            }
            awaitCancellation()
        }
    }
    // Named arguments: a trailing lambda would bind to `busy`, the last parameter.
    return remember(collector, overlays) { HomeVoyageReturnAction(collect = {
        if (currentAdmitted() && !collector.busy) scope.launch {
            try {
                val collected = collector.collect()
                // Voyage SPEC §0.6: players never read "receipt"; the receipt surface is the Lodge's History.
                if (collected == null) currentExplain("The return needs checking. Check the trip History in the Lodge.")
                else {
                    overlays.collectActions = CollectActions(onOk = overlays::dismissCollect,
                        onSendAgain = { overlays.dismissCollect(); overlays.repeatTrip = collected.trips.firstOrNull(); currentOpen("lodge.expedition") },
                        onGoBerth = { overlays.dismissCollect(); currentOpen("berth.service") })
                    overlays.collect = collected
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { currentExplain("The return needs checking. Its original request has been kept.") }
        }
    }, busy = { collector.busy }) }
}
