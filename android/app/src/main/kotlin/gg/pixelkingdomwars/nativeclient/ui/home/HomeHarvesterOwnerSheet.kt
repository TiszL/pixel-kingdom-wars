package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterIdentity
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.readBuildingFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftCelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterHistoryTabActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetR2
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetR2Actions
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterSheetR2Ui
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterArrivedCelebration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterHistoryLiveUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterLatestSequence
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterLiveActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.harvesterLiveUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.rememberNow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl

/*
 * The Harvester tall sheet on Home, complete in place (craft SPEC §4 and E1.3; frames harvester-yield, harvester-arrived,
 * harvester-history). It replaces HomeHarvesterSheet (HomeRouteDispatcher.kt, left in source tonight) with every guard of
 * that host kept: projection currentness, canCheckNow, the refresh loop that waits for the review's refreshRevision, the
 * per-account seen marker, the scoped receipt history, openReview and the receipt CHECK. What changed:
 * - header art arrives from the mount ([artKey], [artTier]): the realm key and tier come from the server art map;
 * - COLLECT moves the client-only seen marker and plays HAUL ARRIVED for the haul the player was shown (no server call);
 * - REVIEW SAVED REQUEST is a designed button under the recovery row, never a raw chrome button;
 * - UPGRADE focuses the Harvester on Home, where its existing UPGRADE review runs; refine and sell GO open the designed
 *   Workshop REFINE and Market SELL sheets through [onOpenDestination];
 * - every door that cannot act says why.
 * No ViewModel, repository or command owner is created here; archival and the full original-receipt controls keep their
 * existing route ([onLegacy], HISTORY's ORIGINAL REQUESTS).
 */

/** No current Harvester owner for this account and kingdom: the plate says so plainly and keeps the existing
 *  original-requests route one tap away; saved receipts are never dropped. */
@Composable private fun HomeHarvesterOwnerMissing(modifier: Modifier, onOriginal: () -> Unit, onClose: () -> Unit) {
    Plate(PlateKind.WOOD, modifier) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText("Harvester recovery is unavailable. Saved receipts are preserved.", PkwTokens.Type.body, Modifier.fillMaxWidth(),
                maxLines = 3)
            SecondaryButton("ORIGINAL REQUESTS", onOriginal, Modifier.fillMaxWidth(),
                contentDescription = "Open original Harvester source selections and receipts")
            SecondaryButton("CLOSE", onClose, Modifier.fillMaxWidth())
        }
    }
}

/** The repository stays session-owned. START, START AGAIN and REVIEW SAVED REQUEST borrow its exact reviewed callbacks in
 * place through [reviewController]; [onFocusBuilding] and [onOpenDestination] are the mount's navigation doors. */
@Composable internal fun HomeHarvesterOwnerSheet(
    graph: AppGraph, session: SessionGraph, identity: HomeRouteIdentity, entry: SheetEntry, owners: HomeOwnerProjections,
    kingdom: KingdomUiState, modifier: Modifier, onTab: (String) -> Unit, onClose: () -> Unit, onLegacy: () -> Unit,
    canRead: () -> Boolean, explain: (String) -> Unit,
    reviewController: HomeHarvesterReviewController?, artKey: String?, artTier: (Int?) -> Int?,
    onFocusBuilding: (String) -> Unit, onOpenDestination: (Destination) -> Unit,
) {
    val owner = owners.harvester
    val observed = owner?.projection?.state?.collectAsState()?.value
    val state = observed?.takeIf { owner?.projection?.currentState() != null }
    if (owner == null || state == null) {
        HomeHarvesterOwnerMissing(modifier,
            onOriginal = { if (canRead()) onLegacy()
                else explain(homeReadRefusalReason(owner?.projection?.reviewBlocked == true, owner?.projection?.currentState() != null)) },
            onClose = onClose)
        return
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var retry by remember(identity) { mutableIntStateOf(0) }
    var refreshError by remember(identity) { mutableStateOf<String?>(null) }
    var refreshing by remember(identity) { mutableStateOf(false) }
    // The COLLECT party the player triggered; NICE, a tap or its timer clears it (craft SPEC 0.6). Client-only.
    var celebration by remember(identity) { mutableStateOf<CraftCelebrationUi?>(null) }
    val currentCanRead by rememberUpdatedState(canRead)
    LaunchedEffect(owner, identity, lifecycle, retry, reviewController?.refreshRevision) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            // Returning from the in-place confirmation has the same one current read as reopening the original
            // screen. Wait for its own painted review/Back lease to retire; no source selection is retried here.
            if ((reviewController?.refreshRevision ?: 0) > 0) {
                snapshotFlow { currentCanRead() && reviewController?.holding != true }.first { it }
            }
            if (currentCanRead()) {
                refreshing = true; refreshError = null
                try {
                    if (!owner.refresh.invoke(Unit)) refreshError = homeReadRefusalReason(
                        owner.projection.reviewBlocked && owner.projection.currentState() != null, owner.projection.currentState() != null)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { refreshError = "Harvester could not be refreshed. Saved receipts are preserved; try again." }
                finally { refreshing = false }
            }
            kotlinx.coroutines.awaitCancellation()
        }
    }
    val context = LocalContext.current.applicationContext
    val seen = remember(session.session) {
        // Public account identity scopes this notification marker; no credential or journal is stored here.
        val accountKey = java.security.MessageDigest.getInstance("SHA-256")
            .digest("${session.session.origin}\n${session.session.wallet}".toByteArray()).joinToString("") { "%02x".format(it) }
        val preferences = context.getSharedPreferences(storageNamespace(session.session.origin, "harvester-seen-$accountKey"), android.content.Context.MODE_PRIVATE)
        HomeHarvesterSeen({ source -> preferences.getString(source, null) },
            { source, sequence -> preferences.edit().putString(source, sequence).apply() })
    }
    val view = state.view?.takeIf { it.wallet == session.session.wallet && it.baseId == identity.baseId }
    val sourceId = view?.source?.sourceId
    val latest = sourceId?.let { harvesterLatestSequence(state.journal, it) }
    var marker by remember(identity, sourceId) { mutableStateOf<String?>(null) }
    SideEffect { if (sourceId != null && canRead()) marker = seen.observe(sourceId, latest) }
    val now = rememberNow(clock = { System.currentTimeMillis() })
    val selected = kingdom.selectedBuilding?.takeIf { it.type == "harvester" }
        ?: kingdom.base?.buildings?.singleOrNull { it.type == "harvester" }
    val facts = selected?.takeIf { kingdom.base?.baseId == identity.baseId }?.let {
        readBuildingFacts(kingdom, it, state.busy, now)
    }
    val destination = entry.destination as Destination.Harvester
    val projectionCurrent = currentCanRead() && owner.projection.currentState() === state
    val historyIdentity = remember(graph, session) {
        HarvesterIdentity(
            graph.origin.toHttpUrl().toString().trimEnd('/'), graph.cluster.id, session.session.wallet)
    }
    val history = harvesterHistoryLiveUi(
        state, historyIdentity, identity.baseId, facts?.buildingId, projectionCurrent, refreshing, refreshError)
    // Anchor the server clock once per observation so countdowns advance between reads. Receipt quantities and
    // delivery still require server proof; elapsed device time never creates a haul.
    val serverOffset = remember(view?.serverNow) {
        view?.let {
            runCatching { Math.subtractExact(java.time.Instant.parse(it.serverNow).toEpochMilli(), System.currentTimeMillis()) }.getOrNull()
        } ?: 0L
    }
    val canCheckNow = {
        val latestState = owner.projection.currentState()
        currentCanRead() && owner.projection.canRead() && !refreshing &&
            latestState != null && !latestState.busy && latestState.review == null
    }
    // Header art (craft SPEC §4 header): the mount reads the realm key and tier from the server art map; nothing here
    // derives either from a realm or resource name.
    val ui = harvesterLiveUi(entry.selectedTab ?: destination.tab, state, session.session.wallet, identity.baseId,
        facts, artKey = artKey, tier = artTier(facts?.level), seenThroughSequence = marker, actionsAllowed = kingdom.ordersAllowed && kingdom.deedActionsAllowed,
        running = refreshing, error = refreshError, nowMs = now, serverOffsetMs = serverOffset).copy(review = null)
    val scope = rememberCoroutineScope()
    // Every in-sheet door re-checks its owner at tap time and says why when it cannot act; it is never a silent no-op.
    val checked: (() -> Unit) -> Unit = { action -> if (currentCanRead() && owner.projection.currentState() != null) action()
        else explain(homeReadRefusalReason(owner.projection.reviewBlocked, owner.projection.currentState() != null)) }
    val openReview: (String?) -> Unit = { target ->
        if (canCheckNow()) scope.launch {
            try {
                if (reviewController?.open(target) != true) explain("This Harvester cannot be reviewed now. Check its saved request or refresh the current kingdom.")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { explain(error.message ?: "The Harvester review could not be opened. Its saved request is preserved.") }
        }
        else explain(homeReadRefusalReason(owner.projection.reviewBlocked, owner.projection.currentState() != null))
    }
    val actions = harvesterLiveActions(onClose, onTab, reviewStart = { openReview(facts?.buildingId) },
        markSeen = {
            checked {
                // Read the latest owner emission at click time; never acknowledge a replaced source/account.
                val current = owner.projection.currentState()
                val source = current?.view?.takeIf { it.wallet == session.session.wallet && it.baseId == identity.baseId }?.source?.sourceId
                if (current != null && source != null) {
                    // HAUL ARRIVED names the haul the player was shown, so it is built BEFORE the marker moves (afterwards
                    // that haul reads as seen). A source replaced since the last paint celebrates nothing. No server call.
                    val party = if (source == sourceId) harvesterArrivedCelebration(ui.harvest, "$source:${latest.orEmpty()}") else null
                    marker = seen.acknowledge(source, harvesterLatestSequence(current.journal, source))
                    celebration = party
                }
            }
        },
        openUpgrade = { checked {
            // The Harvester's existing UPGRADE review runs on Home: the mount closes this sheet and selects the building.
            val building = facts?.buildingId
            if (building != null) onFocusBuilding(building) else explain("Harvester details are unavailable. Try again.")
        } },
        openWorkshop = { _ -> checked { onOpenDestination(Destination.Workshop(WorkshopTab.REFINE)) } },
        openMarketSell = { _ -> checked { onOpenDestination(Destination.Market(MarketTab.SELL)) } },
        refresh = { if (canCheckNow()) retry++
            else explain(homeReadRefusalReason(owner.projection.reviewBlocked, owner.projection.currentState() != null)) }, needMore = { price -> checked { explain(price.description ?: "More resources are needed.") } },
        checkReceipt = { checked { scope.launch {
            try { if (!owner.check.invoke(Unit)) explain("Finish the current review before checking its receipt.") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { explain("The original receipt could not be checked. Try again.") }
        }; Unit } },
        dismissReview = { reviewController?.cancel() },
        confirmReview = { /* The complete, exact owner review is confirmed only by its dedicated overlay. */ },
        reviewSaved = {
            // REVIEW SAVED REQUEST (craft SPEC §5): re-review this kingdom's unproven saved key; never a new command.
            val saved = state.journal.operation?.takeIf { it.proof == null && it.refusal == null && it.command.request.baseId == identity.baseId }
            if (saved != null) openReview(saved.command.request.harvesterId)
            else explain("This Harvester cannot be reviewed now. Check its saved request or refresh the current kingdom.")
        },
        celebrationDone = { celebration = null })
    HarvesterSheetR2(
        HarvesterSheetR2Ui(ui.copy(celebration = celebration), historyTab = history),
        HarvesterSheetR2Actions(sheet = actions,
            history = HarvesterHistoryTabActions(
                onCheck = { if (canCheckNow()) retry++
                    else explain(homeReadRefusalReason(owner.projection.reviewBlocked, owner.projection.currentState() != null)) },
                onTab = onTab,
                onOpenOriginal = if (projectionCurrent && canCheckNow()) ({ if (canCheckNow()) onLegacy() }) else null)), modifier)
}
