package gg.pixelkingdomwars.nativeclient.ui.more

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.HarvesterRepository
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingRepository
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionRepository
import gg.pixelkingdomwars.nativeclient.data.StarterFleetRepository
import gg.pixelkingdomwars.nativeclient.data.WorkshopRepository
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptFamily
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptRow
import gg.pixelkingdomwars.nativeclient.ui.phasee.PhaseEReceiptRows
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryDetailActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistoryDetailSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HistorySheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HISTORY_ALL
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HISTORY_FILTERS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.HISTORY_RECOVERY_DOORS
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.historyFilterFor
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.historyNeeds
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.historyPlaceName
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.keptHistoryRows
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.liveHistoryUi
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException

internal const val HISTORY_PAUSED = "History is paused while another review or read finishes."
internal const val HISTORY_BUSY = "History is still refreshing. Please wait."
internal const val HISTORY_READ_FAILED = "Can't refresh your history."
/** DS §9: say what is safe. Saved originals live on this device and in their owners' journals, never in this card. */
internal const val HISTORY_SAFE = "Saved requests are kept."
/** ErrorRow › Report: the Feedback card (the mount maps this door like every other Profile feedback door). */
internal const val HISTORY_REPORT_DOOR = "profile.feedback"

/** The session owners History borrows. A lazy factory may throw for a corrupt isolated journal (PkwApp borrows them the
 * same way); such an owner is null here and the card says which place could not be opened, never an empty history. */
private class HistoryOwners(val workshop: WorkshopRepository?, val refining: OrdinaryCraftingRepository?,
                            val fleet: StarterFleetRepository?, val expedition: StarterExpeditionRepository?, val harvester: HarvesterRepository?) {
    val missing: List<PhaseEReceiptFamily> get() = listOfNotNull(
        PhaseEReceiptFamily.WORKSHOP.takeIf { workshop == null }, PhaseEReceiptFamily.REFINING.takeIf { refining == null },
        PhaseEReceiptFamily.STARTER_FLEET.takeIf { fleet == null }, PhaseEReceiptFamily.STARTER_EXPEDITION.takeIf { expedition == null },
        PhaseEReceiptFamily.HARVESTER.takeIf { harvester == null })

    companion object {
        fun borrow(session: SessionGraph) = HistoryOwners(runCatching { session.workshop }.getOrNull(),
            runCatching { session.ordinaryCrafting }.getOrNull(), runCatching { session.starterFleet }.getOrNull(),
            runCatching { session.starterExpedition }.getOrNull(), runCatching { session.harvester }.getOrNull())
    }
}

/** One family's projection this frame: [rows] is null when the projection itself could not be built. */
private class HistoryProjection(val family: PhaseEReceiptFamily, val busy: Boolean, val rows: List<PhaseEReceiptRow>?)

private fun historyProjection(family: PhaseEReceiptFamily, busy: Boolean, project: () -> List<PhaseEReceiptRow>) =
    HistoryProjection(family, busy, runCatching(project).getOrNull())

/**
 * The designed History card (design/final/hub/history.png, SPEC §2.8) for the standalone route and the typed Home sheet
 * (`Destination.WalletHistory`). History only: it reads only the GETs Home already makes (the Workshop and refining
 * foreground refreshes, skipped while their owner is working or holds a review) and otherwise shows what the owners
 * retain; it never resumes, submits or retries anything. NEEDS YOU › OPEN hands [onOpen] the owning building's recovery
 * door (one of [HISTORY_RECOVERY_DOORS]); a row tap opens its read-only detail. [selectedFilter] is the host's chip (or a
 * `WalletHistory.home`), [onFilter] reports a chip change, [canRead] is the host's read admission.
 */
@Composable fun HistoryHub(
    graph: AppGraph, session: SessionGraph, onBack: () -> Unit, onOpen: (HubLink) -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(), hosted: Boolean = false,
    selectedFilter: String? = null, onFilter: ((String) -> Unit)? = null, canRead: () -> Boolean = { true },
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latestCanRead by rememberUpdatedState(canRead)
    var localFilter by rememberSaveable { mutableStateOf(selectedFilter?.let(::historyFilterFor) ?: HISTORY_ALL) }
    var refresh by remember(session) { mutableIntStateOf(0) }
    var reading by remember(session) { mutableStateOf(true) }
    var readError by remember(session) { mutableStateOf<String?>(null) }
    var readAt by remember(session) { mutableStateOf<Long?>(null) }
    var savedMail by remember(session) { mutableStateOf<PendingIntent?>(null) }
    var selected by remember(session) { mutableStateOf<String?>(null) }
    val zone = remember { ZoneId.systemDefault() }
    // A retry borrows again: a factory that threw once may open now.
    val owners = remember(session, refresh) { HistoryOwners.borrow(session) }
    val workshop = owners.workshop?.state?.collectAsState()?.value
    val refining = owners.refining?.state?.collectAsState()?.value
    val fleet = owners.fleet?.state?.collectAsState()?.value
    val expedition = owners.expedition?.state?.collectAsState()?.value
    val harvester = owners.harvester?.state?.collectAsState()?.value
    val mailClaim = session.community.state.collectAsState().value.pendingClaim
    val gemsPending = session.gems.state.collectAsState().value.pending
    val gemsBuy = session.gemsBuy.state.collectAsState().value.saved

    fun current(): Boolean = graph.sessionGraph.value === session && graph.holder.current === session.session
    fun requireCurrent() { if (!current()) throw CancellationException("History owner changed") }
    fun retry() {
        when {
            !latestCanRead() -> Toasts.post(HISTORY_PAUSED)
            reading -> Toasts.post(HISTORY_BUSY)
            else -> refresh++
        }
    }

    LaunchedEffect(session, lifecycle, refresh) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            reading = true
            try {
                requireCurrent()
                // Mail's saved claim lives in the saved-request store; it stays reachable here before Mail is ever opened.
                savedMail = runCatching { session.intents.get(IntentKind.MAIL_CLAIM, session.session.wallet) }.getOrNull()
                if (!latestCanRead()) readError = HISTORY_PAUSED
                else {
                    readError = null
                    // The same foreground GETs Home makes (HomeRouteDispatcher's Workshop sheet). An owner already working,
                    // or holding a review the player opened, is left alone: its retained state shows instead.
                    owners.workshop?.takeIf { !it.state.value.busy && it.state.value.review == null }?.let {
                        requireCurrent(); it.refresh(waitForIdle = true); requireCurrent()
                    }
                    owners.refining?.takeIf { !it.state.value.busy && it.state.value.review == null }?.let {
                        requireCurrent(); it.refresh(waitForIdle = true); requireCurrent()
                    }
                    readAt = System.currentTimeMillis()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (current()) readError = HISTORY_READ_FAILED }
            finally { reading = false }
        }
    }

    // Last shown rows per family: an owner's refresh clears its server view while it reads (and leaves it cleared when the
    // read fails), and a routine refresh must not blank what was shown. Kept outside the snapshot (no state written
    // during composition); under a failed read the kept rows draw dimmed beneath the ErrorRow.
    val kept = remember(session) { HashMap<PhaseEReceiptFamily, List<PhaseEReceiptRow>>() }
    val readFailed = readError == HISTORY_READ_FAILED
    val projected = listOfNotNull(
        workshop?.let { s -> historyProjection(PhaseEReceiptFamily.WORKSHOP, s.busy) { PhaseEReceiptRows.workshop(s) } },
        refining?.let { s -> historyProjection(PhaseEReceiptFamily.REFINING, s.busy) { PhaseEReceiptRows.refining(s) } },
        fleet?.let { s -> historyProjection(PhaseEReceiptFamily.STARTER_FLEET, s.busy) { PhaseEReceiptRows.starterFleet(s) } },
        expedition?.let { s -> historyProjection(PhaseEReceiptFamily.STARTER_EXPEDITION, s.busy) { PhaseEReceiptRows.expeditions(s) } },
        harvester?.let { s -> historyProjection(PhaseEReceiptFamily.HARVESTER, s.busy) { PhaseEReceiptRows.harvester(s) } },
    )
    val rows = projected.flatMap { p ->
        val now = p.rows ?: return@flatMap kept[p.family].orEmpty()
        keptHistoryRows(kept[p.family], now, refreshing = p.busy || readFailed).also { kept[p.family] = it }
    }
    val unopened = (owners.missing + projected.filter { it.rows == null }.map { it.family }).mapNotNull(::historyPlaceName).distinct()
    val failure = listOfNotNull(readError,
        unopened.takeIf { it.isNotEmpty() }?.let { "Can't open ${it.joinToString()} history here. Open the building to check it." })
        .joinToString(" ").ifBlank { null }
    val load = when {
        failure != null -> LoadState.Error(failure,
            asOf = readAt?.let { DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH).format(Instant.ofEpochMilli(it).atZone(zone)) },
            retrying = reading, safeLine = HISTORY_SAFE)
        reading -> LoadState.Loading
        else -> LoadState.Ready
    }
    val filter = if (onFilter != null && selectedFilter != null) historyFilterFor(selectedFilter) else localFilter
    val view = liveHistoryUi(rows, historyNeeds(mailClaim ?: savedMail, gemsPending, gemsBuy), filter, load,
        System.currentTimeMillis(), zone)
    val detail = selected?.let { view.details[it] }

    BackHandlerAt(BackPriority.CONFIRM, enabled = detail != null) { selected = null }
    if (!hosted) BackHandlerAt(BackPriority.SCREEN) { onBack() }
    Box(modifier) {
        HistorySheet(view.ui, HistoryActions(
            onFilter = { id ->
                if (id in HISTORY_FILTERS) { localFilter = id; onFilter?.invoke(id) }
                else Toasts.post("This History filter is not available.")
            },
            onRow = { id -> if (view.details.containsKey(id)) { selected = id } else Toasts.post("This entry changed. Open History again.") },
            onOpen = { link ->
                if (link.feature.value in HISTORY_RECOVERY_DOORS) onOpen(link)
                else Toasts.post("This place can't be opened from History yet. Open the building on your map.")
            },
            // No paging: everything retained is already shown, so MORE is never drawn.
            onLoadMore = { Toasts.post("Everything saved is already shown.") },
            onRetry = { retry() },
            onReport = { onOpen(HubLink(FeatureId(HISTORY_REPORT_DOOR))) },
            onBack = onBack,
            onClose = onBack,
        ), Modifier.fillMaxSize())
        detail?.let {
            HistoryDetailSheet(it, HistoryDetailActions(onClose = { selected = null }), Modifier.align(Alignment.BottomCenter).fillMaxWidth())
        }
    }
}
