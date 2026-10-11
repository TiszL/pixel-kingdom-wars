package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.WorkshopHydration
import gg.pixelkingdomwars.nativeclient.data.longValueExactCompat
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopJob
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopOperation
import kotlinx.coroutines.awaitCancellation

private enum class WorkshopPage(val label: String) { REFINE("Refine"), JOBS("Jobs"), HISTORY("History") }
internal fun workshopSavedPill(operation: WorkshopOperation) = when {
    operation.proof != null -> PaymentPill("CONFIRMED", PaymentTone.DONE)
    operation.refusal != null -> PaymentPill("DECLINED", PaymentTone.TROUBLE)
    operation.attempted -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED DRAFT", PaymentTone.OPEN)
}
internal fun workshopJobPill(job: WorkshopJob) = when {
    job.collectedAt != null -> PaymentPill("COLLECTED", PaymentTone.DONE)
    job.ready -> PaymentPill("READY", PaymentTone.OPEN)
    else -> PaymentPill("REFINING", PaymentTone.SENT)
}
internal fun workshopDuration(ingots: Long, seconds: Long): String {
    val duration = ingots.toBigInteger() * seconds.toBigInteger()
    return runCatching { fmtDur(duration.longValueExactCompat()) }.getOrElse { "${fmtN(duration.toString())} seconds" }
}

/** Server readiness only: no local timer turns an unfinished job into a collect action. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun WorkshopScreen(model: WorkshopViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, modifier: Modifier = Modifier, onOpenDestination: ((gg.pixelkingdomwars.nativeclient.ui.features.Destination) -> Unit)? = null, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var quantity by rememberSaveable(wallet, selectedBase) { mutableStateOf("") }
    var page by rememberSaveable(wallet) { mutableStateOf(WorkshopPage.REFINE) }
    val noticeLocation = remember { BringIntoViewRequester() }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle, generation) {
        model.dismiss(); lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) model.dismiss() }
    LaunchedEffect(notice) { if (notice?.error == true) noticeLocation.bringIntoView() }
    val back = { model.dismiss(); onBack() }; val busy = state.busy || running; val op = state.journal.operation
    val view = state.view?.takeIf { it.inventory.baseId == selectedBase }; val review = state.review
    val canAct = actionsAllowed && !busy
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }
    val host = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost.current
    val completion by model.completion.collectAsState()
    LaunchedEffect(model, selectedBase) { model.selectCompletionBase(selectedBase) }
    var selectedTab by remember(model, selectedBase, generation) {
        mutableStateOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS)
    }
    var showReceipts by remember(model) { mutableStateOf(false) }
    // A confirmed receipt waits on the sheet for the player's explicit archive (the saved request's door, or History);
    // nothing opens the receipts or archives on its own. Notices ride the app-wide toast host.
    LaunchedEffect(notice) { notice?.let { Toasts.post(it.message, it.error) } }
    // Existing foreground() is the only read driver. A retained opening snapshot is not a completed new read.
    val ownerLifecycleState by lifecycle.currentStateFlow.collectAsState()
    val ownerActive = ownerLifecycleState.isAtLeast(Lifecycle.State.STARTED)
    val openingView = remember(model, selectedBase, generation, ownerActive) { state.view }
    val currentOwner = host?.current?.invoke() == true && ownerActive
    val currentRead = currentOwner && !busy && view != null && view !== openingView && notice?.error != true
    val visibleCompletion = completion?.takeIf { event ->
        currentRead && op == null && review == null && selectedTab == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS &&
            event.token.baseId == selectedBase && event.token.wallet == wallet &&
            event.token.origin == state.journal.identity.origin && event.token.cluster == state.journal.identity.cluster
    }
    LaunchedEffect(visibleCompletion?.token) { if (visibleCompletion != null) showReceipts = false }
    BackHandlerAt(BackPriority.CONFIRM, visibleCompletion != null) {
        visibleCompletion?.let { model.acknowledgeCompletion(it.token) }
    }
    val offset = remember(view) {
        view?.let { runCatching { Math.subtractExact(java.time.Instant.parse(it.serverNow).toEpochMilli(), System.currentTimeMillis()) }.getOrNull() }
    }
    val mapped = gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopMoneySheetUi(
        state, state.journal.identity, selectedBase, repositoryCurrent = currentOwner,
        viewCurrent = currentRead, balanceCurrent = currentRead,
        availableTabs = listOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS),
        selectedTab = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS,
        quantity = quantity.toIntOrNull() ?: 1, serverOffsetMs = offset, historyAvailable = true)
    val observed = gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.homeWorkshopSheetUi(mapped,
        if (busy) gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.HomeWorkshopReadStatus.LOADING
        else if (notice?.error == true) gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.HomeWorkshopReadStatus.FAILED
        else gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.HomeWorkshopReadStatus.READY,
        currentOwner, selectedTab)
    val commandBody = mapped.ingots?.takeIf {
        selectedTab == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS &&
            currentRead && op == null && review == null &&
            (view?.jobs?.any { job -> job.collectedAt == null } == true || (view?.acceptingJobs == true && view.level > 0))
    }?.copy(actionsAllowed = canAct)
    // The last admitted body keeps the sheet drawn through a routine refresh or a failed one (SPEC §5: never blank).
    val retained = remember(model, selectedBase, generation) {
        arrayOfNulls<gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopIngotsUi>(1)
    }
    if (commandBody != null) retained[0] = commandBody
    // c-gap-craft (SPEC §2.1 loading, §5 "opens instantly from the last cached state"): reopening draws the owner's last
    // view of this kingdom as the designed loading state (busy "Checking…" primary, no action) until this open's own read
    // starts or answers, instead of the "not confirmed" observation card on every open. A read that ends without a new
    // view still falls back to the observation (with TRY AGAIN), so it can never load forever.
    var openRead by remember(model, selectedBase, generation) { mutableStateOf(false) }
    LaunchedEffect(busy) { if (busy) openRead = true }
    val reopening = currentOwner && view != null && view === openingView && !openRead && op == null && review == null &&
        selectedTab == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS && notice?.error != true
    if (retained[0] == null && currentOwner && view != null && op == null && review == null && (busy || reopening))
        retained[0] = gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopMoneySheetUi(
            state.copy(journal = state.journal.copy(operation = null), review = null, busy = false, advertised = true),
            state.journal.identity, selectedBase, repositoryCurrent = true, viewCurrent = true, balanceCurrent = false,
            availableTabs = listOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS), selectedTab = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS,
            quantity = quantity.toIntOrNull() ?: 1, serverOffsetMs = offset).ingots
    val body = when {
        // The open review: its own validated view, drawn closed behind the review half sheet.
        review != null -> if (!currentOwner) null else (ingotsReviewBody(state, review, selectedBase, offset) ?: mapped.ingots)
            ?.copy(actionsAllowed = false)
        // A review being prepared saves its draft first: keep the last body loading rather than flash a recovery row.
        op != null && busy && currentOwner && retained[0] != null && op.proof == null && op.refusal == null && !op.attempted ->
            retained[0]?.copy(actionsAllowed = false, hydration = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration.Loading)
        // A saved request: the recovery-only body (nothing current is claimed) with its row in the owner's wording.
        op != null -> if (!currentOwner) null else mapped.ingots?.let { recovery -> recovery.copy(saved = recovery.saved?.let { ingotsSavedOp(op, it) }) }
        commandBody != null -> commandBody
        selectedTab == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS && currentOwner && (busy || notice?.error == true) ->
            retained[0]?.copy(actionsAllowed = false, hydration = if (busy) gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration.Loading
                else gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration.Error(notice?.message ?: "Workshop information could not be refreshed. Try again."))
        reopening -> retained[0]?.copy(actionsAllowed = false, hydration = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration.Loading)
        else -> null
    }
    // A review the sheet cannot draw is closed rather than left invisible; its saved draft stays recoverable.
    LaunchedEffect(review, body == null) { if (review != null && body == null) model.dismiss() }
    val ui = (if (body == null) observed.copy(frame = observed.frame.copy(history = currentOwner),
        observation = observed.observation?.copy(canRetry = currentOwner && !busy && review == null))
        else mapped.copy(frame = mapped.frame.copy(
            tabs = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopTabs(
                ingotsReady = body.job?.state == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IngotJobState.READY),
            selectedTab = if (review != null || op != null) gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS else selectedTab,
            // The sheet derives its live chip from the bench ("Free to work", "Casting · 1:35", "4 ingots ready"); a saved
            // request keeps the mapper's "needs attention" chip instead of claiming a free bench.
            live = mapped.frame.live.takeIf { body.saved != null }), ingots = body, destinationsAvailable = onOpenDestination != null,
            review = review?.let { gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopIngotsReviewUi(it, busy, op?.attempted == true) }))
        .copy(celebration = visibleCompletion?.ui)
    val notCurrent = { Toasts.post("Workshop information is not current.") }
    val savedDoor = op?.takeIf { review == null && currentOwner }?.let { saved ->
        when (gg.pixelkingdomwars.nativeclient.ui.sheets.craft.savedRequestDoor(saved.proof != null, saved.refusal != null, saved.attempted,
            canAct && saved.command.baseId == selectedBase)) {
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedDoor.FINISH -> gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedRequestDoorUi(
                "ARCHIVE CONFIRMED RECEIPT", "Archive the confirmed receipt. It stays in History.", !busy) {
                if (currentOwner && !busy) model.finish() else notCurrent()
            }
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedDoor.REVIEW -> gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedRequestDoorUi(
                "REVIEW ORIGINAL REQUEST", "Review the saved Workshop request again", canAct) {
                if (canAct && currentOwner && saved.command.baseId == selectedBase) model.reviewSaved() else notCurrent()
            }
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedDoor.HISTORY -> gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedRequestDoorUi(
                "ORIGINAL REQUEST", "Open the original Workshop request", true) { showReceipts = true }
        }
    }
    val on = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetActions(
        onClose = back,
        onTab = { tab ->
            if (gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopTabs().any { it.id == tab }) {
                // A sibling tab belongs to its own owner: the host switches or explains, and this sheet stays on INGOTS.
                if (tab == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS || host == null) selectedTab = tab
                else host.onTab(tab)
            }
        },
        onHistory = { showReceipts = true },
        onRetry = { if (currentOwner && !busy) model.refresh() },
        onNeedMore = { Toasts.post("The observed Shards balance does not cover this batch. No request has been started.") },
        onReviewBack = { model.dismiss() },
        onReviewConfirm = { review?.let { r -> if (canAct && currentOwner) model.confirm(r) } },
        onOpenOriginal = { showReceipts = true },
        onCelebrationDone = { jobId -> visibleCompletion?.takeIf { it.ui.jobId == jobId }?.let {
            model.acknowledgeCompletion(it.token)
        } },
        savedDoor = savedDoor,
        ingots = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopIngotsActions(
            onQty = { delta ->
                commandBody?.let { body ->
                    val limit = listOfNotNull(body.batch.size, body.allowance.daily.remaining, body.allowance.holding.remaining)
                        .minOrNull()?.coerceAtMost(Int.MAX_VALUE.toLong())?.coerceAtLeast(1)?.toInt() ?: 1
                    quantity = ((quantity.toLongOrNull() ?: 1L) + delta).coerceIn(1L, limit.toLong()).toString()
                }
            },
            onCast = { count -> if (currentOwner && currentRead && canAct && op == null) model.start(count.toString()) else notCurrent() },
            onCollect = { jobId -> if (currentOwner && currentRead && canAct && op == null &&
                view?.jobs?.any { it.jobId == jobId && it.ready && it.collectedAt == null } == true) model.collect(jobId) else notCurrent() },
            onGoGoldForge = { onOpenDestination?.invoke(gg.pixelkingdomwars.nativeclient.ui.features.Destination.GoldForge("SMELT")) },
            onCheckOriginalReceipt = { key -> if (currentOwner && !busy && op?.command?.key == key) model.check() }))
    // c-gap-craft: a running cast that is due gets one ordinary owner read (backing off while the server still casts), so
    // READY / COLLECT appears without a reopen. Server readiness only: the clock never turns a job into a collect action.
    val castDue = commandBody?.job?.takeIf { it.state == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IngotJobState.RUNNING }
    gg.pixelkingdomwars.nativeclient.ui.sheets.craft.DueRefreshEffect(castDue?.jobId, castDue?.readyAtMs, { System.currentTimeMillis() + (offset ?: 0L) }) {
        if (currentOwner && !model.busy.value && !model.state.value.busy && model.state.value.review == null &&
            model.state.value.journal.operation == null) { model.refresh(); true } else false
    }
    // The sheet and its records page share the sheet's bounds: History never opens a window over the world.
    Box(modifier.fillMaxSize()) {
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheet(ui, on, Modifier.fillMaxSize())
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordsOverlay(
            if (showReceipts && review == null && visibleCompletion == null) workshopRecords(state, view, op, selectedBase, busy,
                canAct, currentOwner, model) else null,
            onClose = { showReceipts = false }, modifier = Modifier.fillMaxSize())
    }
}

/** The designed records page for the INGOTS owner (c-gap-craft: replaces the "WORKSHOP RECEIPTS" chrome dialog). Same
 *  sentences, same buttons, same enabled rules and the same owner verbs; only the surface changed. */
private fun workshopRecords(state: gg.pixelkingdomwars.nativeclient.data.WorkshopState,
    view: gg.pixelkingdomwars.nativeclient.workshop.WorkshopView?, op: WorkshopOperation?, selectedBase: String?, busy: Boolean,
    canAct: Boolean, currentOwner: Boolean, model: WorkshopViewModel): gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordsUi {
    val ingotIcon = "craft:inv_forge_ingot"
    val saved = op?.let { saved ->
        val pill = workshopSavedPill(saved)
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordUi("Saved ${if (saved.command.kind == "start") "refining" else "collection"}", pill.label,
            paymentRecordVerb(pill.tone), ingotIcon, listOf(
                "${fmtN(saved.command.ingots)} Forge Ingots",
                if (saved.command.kind == "start") "${fmtN(saved.command.charge())} SHARDS at start" else "Collection of the original paid job",
                when {
                    saved.proof != null -> "Original receipt confirmed. Current stock comes from a fresh kingdom read."
                    saved.refusal != null -> "This request was declined before acceptance. Archive it before starting a new one."
                    saved.attempted -> "This request may have completed. Checking its receipt does not send it again."
                    else -> "The original quantity, recipe and producing kingdom remain saved after closing."
                }),
            workshopDetails(saved).map { gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordDetail(it.label, it.value) },
            listOfNotNull(
                if (saved.proof == null && saved.refusal == null) gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("REVIEW ORIGINAL REQUEST",
                    canAct && saved.command.baseId == selectedBase, { model.reviewSaved() }) else null,
                gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("CHECK ORIGINAL RECEIPT", !busy, { model.check() }),
                if (saved.proof != null) gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("ARCHIVE CONFIRMED RECEIPT", !busy, { model.finish() })
                // Owner 2026-10-06 (dead-end audit): an attempted request with no outcome can be closed too. The same archive
                // action reads its receipt again and closes it only if the server answers `unknown` for this key; never a POST.
                else gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction(when { saved.refusal != null -> "ARCHIVE DECLINED REQUEST"
                    !saved.attempted -> "ARCHIVE UNUSED DRAFT"; else -> "CLOSE SAVED REQUEST" }, !busy, { model.archiveUnusedOrRefused() })),
            attention = true)
    }
    val archives = state.journal.archives.asReversed().map { archive ->
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordUi(when (archive.reason) { "accepted" -> "Confirmed receipt"; "refused" -> "Declined request"; "unknown" -> "Closed request"; else -> "Unused draft" },
            icon = ingotIcon, lines = listOf("${fmtN(archive.operation.command.ingots)} Forge Ingots",
                if (archive.operation.command.kind == "start") "${fmtN(archive.operation.command.charge())} SHARDS at start" else "Collection of the original paid job",
                "Historical record. Current stock is shown separately above."),
            details = workshopDetails(archive.operation).map { gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordDetail(it.label, it.value) })
    }
    val collected = view?.jobs?.filter { it.collectedAt != null }.orEmpty().map { job ->
        val pill = workshopJobPill(job)
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordUi("${fmtN(job.ingots)} Forge Ingots", pill.label, paymentRecordVerb(pill.tone), ingotIcon,
            listOf("Collected ${job.collectedAt}"), listOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordDetail("Job", job.jobId)))
    }
    return gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordsUi("WORKSHOP RECEIPTS", sections = listOf(
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordSection("SAVED REQUEST", records = listOfNotNull(saved)),
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordSection("ARCHIVE", records = archives + collected,
            empty = "Confirmed receipts, declined requests and unused drafts appear here after archiving.")),
        notes = listOfNotNull("Original receipt archived. Its producing kingdom is unavailable here; no current stock is shown for it."
            .takeIf { state.hydration == WorkshopHydration.ORIGINAL_BASE_UNAVAILABLE }),
        footer = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("REFRESH WORKSHOP & RECEIPTS", currentOwner && !busy, { model.refresh() }),
        busy = busy)
}
private fun workshopDetails(operation: WorkshopOperation) = listOfNotNull(
    PaymentDetail("Producing kingdom", operation.command.baseId), PaymentDetail("Original request", operation.command.key),
    operation.command.jobId?.let { PaymentDetail("Original job", it) }, operation.command.recipeVersion?.let { PaymentDetail("Recipe version", it.toString()) })

/** The reviewed request's own validated view, drawn closed behind the review half sheet. The draft that the review saved
 *  is the review itself, so it is not shown as a recovery here. Null leaves the recovery-only body. */
private fun ingotsReviewBody(state: gg.pixelkingdomwars.nativeclient.data.WorkshopState, review: gg.pixelkingdomwars.nativeclient.data.WorkshopReview,
    baseId: String?, offset: Long?): gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopIngotsUi? =
    gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopMoneySheetUi(
        state.copy(journal = state.journal.copy(operation = null), view = review.view, shards = review.shards, review = null,
            busy = false, advertised = true),
        state.journal.identity, baseId, repositoryCurrent = true, viewCurrent = true, balanceCurrent = true,
        availableTabs = listOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS),
        selectedTab = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS,
        quantity = review.command.ingots.coerceIn(1L, Int.MAX_VALUE.toLong()).toInt(), serverOffsetMs = offset).ingots

/** The saved request's recovery row in the owner's existing receipt wording (SPEC §5); a draft keeps the mapper's line. */
private fun ingotsSavedOp(operation: WorkshopOperation, row: gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedOpUi) = when {
    operation.proof != null -> row.copy(title = "Original receipt confirmed.", line = "Current stock comes from a fresh kingdom read.")
    operation.refusal != null -> row.copy(title = "This request was declined before acceptance.", line = "Archive it before starting a new one.")
    operation.attempted -> row.copy(title = "This request may have completed.", line = "Checking its receipt does not send it again.")
    else -> row
}
