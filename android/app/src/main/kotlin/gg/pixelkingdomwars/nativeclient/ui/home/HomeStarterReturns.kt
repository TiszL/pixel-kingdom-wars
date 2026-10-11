package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.CollectActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LODGE_TYPE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.hasCompleted
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.isoMs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/*
 * Voyage gap audit, exploration end to end for the free Starter Boat on Home (voyage SPEC §1 plate line, §2 home-return,
 * §5b collect moment). Before, the starter owner was read only while the Lodge sheet was open: a fresh Home had no trip
 * line on the Lodge plate, a boat at sea stayed "due back" on Home forever, and its return (credited by the server on its
 * own, no COLLECT request exists) was never celebrated unless the player happened to open the Lodge.
 *
 * Home now presents the starter owner's view the way the Lodge does: it holds the existing owner's visibility lease
 * (HomeVoyageVisibilityLease, the SAME lease the Lodge sheet holds) only while it needs that owner's GET:
 * - once per Home visit when the owner has no view of this kingdom yet (the plate and the Berth timer need it), and
 * - when the boat's scheduled return has passed (the server settles the return on that read and drops the flight).
 * The lease lets the existing driver run the owner's own foreground read; nothing here reads, sends or archives anything.
 * When a later view of this kingdom no longer has a flight Home saw at sea, the collect card plays once (StarterReturnWatch).
 */

/** How long after a starter flight's scheduled return Home asks for the owner's read (device clock grace). */
internal const val STARTER_DUE_GRACE_MS = 2_000L

/** Later re-reads while a returned flight is still shown (server clock a little behind the device). */
private val STARTER_DUE_RETRY_MS = longArrayOf(5_000L, 15_000L, 60_000L)

/** The longest a warm read may hold the lease; a slower or refused read leaves the plate as it was. */
internal const val STARTER_WARM_LEASE_MS = 10_000L

/** Whether Home should hold the starter owner's visibility lease: no view of this kingdom yet (one warm read per visit,
 *  never retried), or a flight whose scheduled return has passed (the read that settles it). */
internal fun homeStarterLeaseWanted(viewKnown: Boolean, warmed: Boolean, flightDue: Boolean): Boolean =
    (!viewKnown && !warmed) || flightDue

@Composable internal fun HomeStarterReturnWatcher(session: SessionGraph, identity: HomeRouteIdentity, owners: HomeOwnerProjections,
    overlays: HomeVoyageOverlays, openFeature: (String) -> Unit) {
    val owner = owners.starter ?: return
    val base by session.base.state.collectAsState()
    // Only a kingdom with a finished Lodge has starter trips to show; no other kingdom pays for the warm read.
    val lodge = hasCompleted(base.base?.takeIf { it.baseId == identity.baseId }?.buildings, LODGE_TYPE) == true
    val emission by owner.projection.state.collectAsState()
    val state = emission.takeIf { owner.projection.currentState() != null }
    // The last view of this kingdom stays shown while the owner re-reads (HomeVoyageSnapshots.kt), so the lease is not
    // dropped mid-read (dropping it dismisses the owner's view and would end its read).
    val memory = remember(identity) { VoyageSnapshotMemory(identity.baseId) }
    val view = retainVoyage(memory, state, null, null).starter?.view?.takeIf { it.baseId == identity.baseId }
    val flight = view?.flight
    var warmed by remember(identity) { mutableStateOf(false) }
    LaunchedEffect(identity, view == null, state != null) {
        if (view != null) warmed = true
        else if (state != null) { delay(STARTER_WARM_LEASE_MS); warmed = true }
    }
    var due by remember(flight?.expeditionId) { mutableStateOf(false) }
    LaunchedEffect(flight?.expeditionId, flight?.returnsAt) {
        due = false
        val at = isoMs(flight?.returnsAt) ?: return@LaunchedEffect
        val wait = at + STARTER_DUE_GRACE_MS - System.currentTimeMillis()
        if (wait > 0) delay(wait)
        due = true
    }
    // A departure the server accepted while the Lodge closed before its owner archived it: the boat sailed, but the
    // owner's view still shows it docked and the next SEND would be refused. Home archives it through the SAME owner's
    // GET-only finish (the Lodge does this itself while it is open).
    val proven = state?.journal?.operation?.takeIf { it.proof != null && it.command.request.baseId == identity.baseId }?.command?.key
    if (state != null && (proven != null || homeStarterLeaseWanted(view != null || !lodge, warmed, due && flight != null)))
        HomeVoyageVisibilityLease(identity, owner.voyage, null)
    LaunchedEffect(proven) {
        val commands = owner.voyage ?: return@LaunchedEffect
        if (proven == null) return@LaunchedEffect
        repeat(HOME_VOYAGE_SETTLE_ATTEMPTS) {
            val now = owner.projection.state.value
            if (now.journal.operation?.command?.key != proven || now.journal.operation?.proof == null) return@LaunchedEffect
            if (!overlays.lodgeMounted && !now.busy && now.review == null && commands.current()) {
                try { commands.finishAccepted() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* The saved proof stays; the Lodge settles it on its next open. */ }
                return@LaunchedEffect
            }
            delay(HOME_VOYAGE_SETTLE_POLL_MS)
        }
    }
    // The lease's first read can land a moment before the server's own clock reaches the return; a few later reads through
    // the owner's existing read action settle it. Stops as soon as the flight is gone.
    val currentOwner by rememberUpdatedState(owner)
    LaunchedEffect(due, flight?.expeditionId) {
        if (!due || flight == null) return@LaunchedEffect
        for (pause in STARTER_DUE_RETRY_MS) {
            delay(pause)
            currentOwner.let { o -> if (o.projection.canRead()) o.refresh.invoke(Unit) }
        }
    }
    // collect.png for the starter boat. Its return is credited by the server's own settlement, which is also what drops the
    // flight from the view, so the card shows the departure's own net cargo once, after the fact. A Seal or another card up
    // means the player is busy: the cargo is already home, so nothing is queued.
    val currentOpen by rememberUpdatedState(openFeature)
    val raw = state?.view
    LaunchedEffect(raw) {
        val back = overlays.returnWatch.observe(raw) ?: return@LaunchedEffect
        if (overlays.shown) return@LaunchedEffect
        val collected = homeStarterReturnCollect(back, raw?.installation?.berthId)
        overlays.collectActions = CollectActions(onOk = overlays::dismissCollect,
            onSendAgain = {
                overlays.dismissCollect()
                // SPEC §5b SEND AGAIN: the Lodge's SEND with the same coast route and boat (an open Lodge takes it itself).
                overlays.repeatTrip = collected.trips.firstOrNull()
                if (!overlays.lodgeMounted) currentOpen("lodge.expedition")
            }, onGoBerth = overlays::dismissCollect)
        overlays.collect = collected
    }
}
