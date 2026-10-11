package gg.pixelkingdomwars.nativeclient.ui.economy

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingHydration
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingOperation
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingRecipe
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.InputKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedOpUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedRequestDoorUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopRefineUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.savedRequestDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.ordinaryRefineReviewUi
import kotlinx.coroutines.awaitCancellation

private enum class RefiningPage(val label: String) { REFINE("Craft"), STOCK("Stock"), JOBS("Jobs"), HISTORY("History") }
internal fun ordinaryCraftingSavedPill(operation: OrdinaryCraftingOperation) = when {
    operation.proof?.completion != null -> PaymentPill("DELIVERED", PaymentTone.DONE)
    operation.proof != null -> PaymentPill("START ACCEPTED", PaymentTone.SENT)
    operation.refusal != null -> PaymentPill("DECLINED", PaymentTone.TROUBLE)
    operation.attemptRevision != null -> PaymentPill("CHECK OUTCOME", PaymentTone.TROUBLE)
    else -> PaymentPill("SAVED DRAFT", PaymentTone.OPEN)
}

/** Current stock and immutable original receipts are separate. No local clock delivers a job. */
@Composable fun OrdinaryCraftingScreen(model: OrdinaryCraftingViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, onBack: () -> Unit) {
    val back = { model.dismiss(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    DesignedPage("WORKSHOP MATERIALS", back) {
        OrdinaryCraftingContent(model, wallet, selectedBase, generation, actionsAllowed)
    }
}

/** The REFINE tab on the designed Workshop sheet. The existing owner reviews in place on the half sheet (its START is
 * the explicit consent); [onOpenDestination], when the host binds one, takes a missing raw input to the Harvester and
 * anything else to the Market. Original receipts stay in the History dialog. */
@Composable fun OrdinaryCraftingContent(model: OrdinaryCraftingViewModel, wallet: String, selectedBase: String?, generation: Long,
    actionsAllowed: Boolean, modifier: Modifier = Modifier, onOpenDestination: ((Destination) -> Unit)? = null) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var quantity by rememberSaveable(wallet, selectedBase) { mutableStateOf("") }
    var recipeId by rememberSaveable(wallet, selectedBase) { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var page by rememberSaveable(wallet) { mutableStateOf(RefiningPage.REFINE) }
    DisposableEffect(model, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) model.dismiss() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); model.dismiss() }
    }
    LaunchedEffect(model, lifecycle, generation) {
        model.dismiss(); lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(); awaitCancellation() }
    }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) model.dismiss() }
    // Notices ride the app-wide toast host; the sheet itself never blanks for one.
    LaunchedEffect(notice) { notice?.let { Toasts.post(it.message, it.error) } }
    val busy = state.busy || running; val operation = state.journal.operation
    val view = state.view?.takeIf { it.wallet == wallet && it.baseId == selectedBase }
    val review = state.review; val canAct = actionsAllowed && !busy
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }
    val host = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost.current
    val completion by model.completion.collectAsState()
    LaunchedEffect(model, selectedBase) { model.selectCompletionBase(selectedBase) }
    // A confirmed start keeps its original receipt until the player explicitly archives it from the saved request's
    // door or History; nothing opens History or archives on its own.
    val ownerLifecycleState by lifecycle.currentStateFlow.collectAsState()
    val ownerActive = ownerLifecycleState.isAtLeast(Lifecycle.State.STARTED)
    val openingView = remember(model, wallet, selectedBase, generation, ownerActive) { state.view }
    val current = host?.current?.invoke() == true && ownerActive &&
        state.journal.identity.wallet == wallet
    val admitted = current && !busy && notice?.error != true && view != null && view !== openingView && state.advertised
    val visibleCompletion = completion?.takeIf { event ->
        admitted && operation == null && review == null && event.token.baseId == selectedBase &&
            event.token.wallet == wallet && event.token.origin == state.journal.identity.origin &&
            event.token.cluster == state.journal.identity.cluster
    }
    LaunchedEffect(visibleCompletion?.token) { if (visibleCompletion != null) page = RefiningPage.REFINE }
    BackHandlerAt(BackPriority.CONFIRM, visibleCompletion != null) {
        visibleCompletion?.let { model.acknowledgeCompletion(it.token) }
    }
    val selectedQuantity = quantity.toIntOrNull()?.coerceIn(1, view?.maxBatch?.coerceAtLeast(1) ?: 1) ?: 1
    val items = view?.recipes.orEmpty().flatMap { recipe -> listOf(recipe.output.itemId) + recipe.inputs.map { it.itemId } }
        .distinct().associateWith { id ->
            val madeHere = view?.recipes?.firstOrNull { it.output.itemId == id }
            // workshop-short.png: an input this Workshop makes says where it comes from ("Refine here, from …").
            val source = madeHere?.inputs?.firstOrNull { it.kind != "shards" }?.let { "Refine here, from ${resourceLabel(it.itemId)}" }
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftItemUi(id, resourceLabel(id),
                gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon(id), source.orEmpty(), madeHere?.recipeId)
        }
    // The current protocol has a server snapshot time, but no measured client receive-time offset. Render progress
    // at that observed server instant; only another owner read can advance it or observe automatic delivery.
    val snapshotNow = view?.serverNow?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
    // c-gap-craft: the bench ticks from that server instant on the device's monotonic clock (never ahead of the server),
    // so the bar, the live chip and "Bench busy" count down instead of standing still until a reopen.
    val liveClock = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.snapshotClock(view, snapshotNow)
    val mapped = gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopRefineTabUi(
        state, state.journal.identity, selectedBase, repositoryCurrent = current, viewCurrent = admitted,
        benchCapacity = host?.benchCapacity, quantity = selectedQuantity, selectedRecipeId = recipeId,
        serverOffsetMs = snapshotNow?.let { 0L }, items = items)
    // The last admitted body keeps the sheet drawn through a routine refresh or a failed one (SPEC §5: never blank).
    val retained = remember(model, wallet, selectedBase, generation) { arrayOfNulls<WorkshopRefineUi>(1) }
    if (mapped != null) retained[0] = mapped
    // The same projection over a view whose saved operation is the review itself (or the request shown above the body).
    fun projected(source: OrdinaryCraftingView, count: Int, recipe: String?): WorkshopRefineUi? =
        gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.workshopRefineTabUi(
            state.copy(journal = state.journal.copy(operation = null), view = source, review = null, busy = false, advertised = true),
            state.journal.identity, selectedBase, repositoryCurrent = current, viewCurrent = true,
            benchCapacity = host?.benchCapacity, quantity = count, selectedRecipeId = recipe,
            serverOffsetMs = source.serverNow.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }?.let { 0L }, items = items)
    // Reopening the sheet (fix-crafting-fidelity): the owner's last view of this kingdom is drawn as the designed loading
    // state (SPEC §2.1: the last snapshot, counts "…", busy primary, no action) until this open's own read answers, instead
    // of a "Checking current recipes…" text card on every open. Only before that read starts, or while a read runs.
    var openRead by remember(model, wallet, selectedBase, generation) { mutableStateOf(false) }
    LaunchedEffect(busy) { if (busy) openRead = true }
    val reopening = current && view != null && view === openingView && !openRead
    if (retained[0] == null && current && view != null && (busy || reopening)) retained[0] = projected(view, selectedQuantity, recipeId)
    val saved = operation?.takeIf { review == null }
    val refine: WorkshopRefineUi? = when {
        // The open review: its own validated view, drawn closed behind the half sheet.
        review != null -> if (!current) null else (projected(review.view, review.command.request.quantity, review.command.request.recipeId)
            ?: retained[0]?.copy(selectedRecipeId = review.command.request.recipeId, quantity = review.command.request.quantity))
            ?.copy(actionsAllowed = false)
        // A review being prepared saves its draft first: keep the last body loading rather than flash a recovery row.
        saved != null && busy && current && retained[0] != null && saved.proof == null && saved.refusal == null && saved.attemptRevision == null ->
            retained[0]?.copy(actionsAllowed = false, hydration = CraftHydration.Loading)
        // A saved request: its recovery row on top; counts are withheld until it is resolved (they may have been spent).
        saved != null -> if (!current) null else ((if (admitted) view?.let { projected(it, selectedQuantity, recipeId) } else null) ?: retained[0])
            ?.copy(stock = emptyMap(), shards = null, actionsAllowed = false, savedOperation = refineSavedOp(saved, busy))
        mapped != null -> mapped.copy(actionsAllowed = canAct && current && review == null)
        current && (busy || notice?.error == true) -> retained[0]?.copy(actionsAllowed = false,
            hydration = if (busy) CraftHydration.Loading else CraftHydration.Error(notice?.message ?: "Refining information could not be refreshed."))
        reopening -> retained[0]?.copy(actionsAllowed = false, hydration = CraftHydration.Loading)
        else -> null
    }
    // A review the sheet cannot draw is closed rather than left invisible; its saved draft stays recoverable.
    LaunchedEffect(review, refine == null) { if (review != null && refine == null) model.dismiss() }
    val reason = when {
        !current -> "Refining information is not current. Reopen the Workshop."
        busy -> "Checking current recipes, stock and original receipts…"
        operation != null -> "A saved refining request needs attention. Its original recipe and receipt are preserved."
        notice?.error == true -> notice?.message ?: "Refining information could not be refreshed."
        host?.benchCapacity == null -> "The current Workshop queue capacity is unavailable. Original requests remain available."
        !admitted -> "Current recipes and stock have not been observed. Try again."
        else -> "Refining information cannot be shown from this observation. Original requests remain available."
    }
    val ui = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetUi(
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftFrameUi("WORKSHOP", null,
            // A saved request says so in the live chip instead of claiming a free bench.
            if (refine?.savedOperation != null) gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftLiveUi("timer", "Saved Workshop request needs attention") else null, true,
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopTabs(), gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.REFINE),
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi(null),
        refine = refine, celebration = visibleCompletion?.ui,
        review = review?.takeIf { refine != null }?.let { ordinaryRefineReviewUi(it, busy, operation?.attemptRevision != null) },
        observation = if (refine != null) null else gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopObservationUi(
            reason, loading = busy, canRetry = current && !busy && review == null,
            canOpenOriginal = current && (operation != null || state.journal.archives.isNotEmpty())),
        destinationsAvailable = onOpenDestination != null)
    val canReadNow = { host?.current?.invoke() == true && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
        model.state.value.journal.identity.wallet == wallet && !model.state.value.busy && !model.busy.value }
    val notCurrent = { Toasts.post("Refining information is not current. Reopen the Workshop.") }
    val selectRecipe: (String) -> Unit = { id -> if (view?.recipes?.any { it.recipeId == id } == true) recipeId = id }
    val savedDoor = saved?.takeIf { current }?.let { original ->
        when (savedRequestDoor(original.proof != null, original.refusal != null, original.attemptRevision != null,
            canAct && original.command.request.baseId == selectedBase)) {
            SavedDoor.FINISH -> SavedRequestDoorUi("ARCHIVE ACCEPTED START", "Archive the accepted start. Its receipt stays in History.",
                !busy) { if (canReadNow()) model.finish() else notCurrent() }
            SavedDoor.REVIEW -> SavedRequestDoorUi("REVIEW SAVED REQUEST", "Review the saved refining request again", canAct) {
                if (canReadNow() && actionsAllowed) model.reviewSaved() else notCurrent()
            }
            SavedDoor.HISTORY -> SavedRequestDoorUi("ORIGINAL REQUEST", "Open the original refining requests", true) {
                if (canReadNow()) { page = RefiningPage.HISTORY } else notCurrent()
            }
        }
    }
    // c-gap-craft: once the bench job is due, one ordinary owner read observes the server's automatic delivery (then the
    // BATCH DONE celebration plays from the owner's own completion proof); it backs off while the server still works.
    val dueJob = view?.pendingJobs?.minByOrNull { it.readyAt }
    gg.pixelkingdomwars.nativeclient.ui.sheets.craft.DueRefreshEffect(dueJob?.jobId,
        dueJob?.readyAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }, liveClock) {
        if (canReadNow() && model.state.value.review == null && model.state.value.journal.operation == null) { model.refresh(); true } else false
    }
    // The sheet and its records page share the sheet's bounds: History never opens a window over the world.
    Box(modifier.fillMaxSize()) {
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheet(ui,
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetActions(
                onClose = { model.dismiss(); host?.onClose?.invoke() },
                onTab = { tab -> if (canReadNow()) { model.dismiss(); host?.onTab?.invoke(tab) }
                    else Toasts.post("Finish the current review or reopen this Workshop before changing tabs.") },
                onHistory = { if (canReadNow()) { page = RefiningPage.HISTORY } else notCurrent() },
                onRetry = { if (canReadNow() && model.state.value.review == null) model.refresh() },
                onNeedMore = { price -> Toasts.post(price.description ?: "More SHARDS are needed for the listed batch. No request was sent.") },
                onCheckSaved = { if (canReadNow() && model.state.value.review == null) model.check() },
                onReviewBack = { model.dismiss() },
                onReviewConfirm = { review?.let { r -> if (canAct && current) model.confirm(r) } },
                onOpenOriginal = { if (canReadNow()) page = RefiningPage.HISTORY },
                onCelebrationDone = { jobId -> visibleCompletion?.takeIf { it.ui.jobId == jobId }?.let {
                    model.acknowledgeCompletion(it.token)
                } },
                onGoRecipe = selectRecipe,
                onGo = { itemId -> onOpenDestination?.invoke(workshopIngredientDestination(itemId, refine)) },
                savedDoor = savedDoor,
                refine = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopRefineActions(
                    onSelectRecipe = selectRecipe,
                    onQty = { delta -> if (delta == -1 || delta == 1) quantity = (selectedQuantity.toLong() + delta)
                        .coerceIn(1L, (view?.maxBatch ?: 1).coerceAtLeast(1).toLong()).toString() },
                    onStart = { id, count ->
                        val latest = model.state.value
                        if (canReadNow() && actionsAllowed && latest.view === view && latest.journal.operation == null && latest.review == null &&
                            view?.recipes?.any { it.recipeId == id } == true && count in 1..(view?.maxBatch ?: 0)) {
                            model.start(id, count.toString())
                        } else notCurrent()
                })), Modifier.fillMaxSize(), clock = liveClock)
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordsOverlay(
            if (page == RefiningPage.HISTORY && review == null && visibleCompletion == null) refiningRecords(state, view, operation,
                selectedBase, busy, canAct, model) else null,
            onClose = { page = RefiningPage.REFINE }, modifier = Modifier.fillMaxSize())
    }
}

/** The designed records page for the REFINE owner (c-gap-craft: replaces the "ORIGINAL REFINING REQUESTS" chrome dialog).
 *  Same sentences, same buttons, same enabled rules and the same owner verbs; only the surface changed. */
private fun refiningRecords(state: gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState, view: OrdinaryCraftingView?,
    operation: OrdinaryCraftingOperation?, selectedBase: String?, busy: Boolean, canAct: Boolean,
    model: OrdinaryCraftingViewModel): gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordsUi {
    val saved = operation?.let { saved ->
        val pill = ordinaryCraftingSavedPill(saved)
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordUi("Saved refining request", pill.label, paymentRecordVerb(pill.tone),
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon(saved.command.recipe.output.itemId),
            refiningRecipeLines(saved.command.recipe) + listOfNotNull(when {
                saved.proof?.completion != null -> "The server observed automatic delivery. Current stock comes from a fresh kingdom read."
                saved.proof != null -> "Start accepted. Output is delivered automatically; check the original receipt for completion."
                saved.refusal != null -> "This request was declined. Check its original receipt before archiving."
                saved.attemptRevision != null -> "This request may have been accepted. Checking its receipt never sends it again."
                else -> "The original recipe, quantity and producing kingdom stay saved after closing."
            }, "This request belongs to another kingdom. Receipt checks remain available here.".takeIf { saved.command.request.baseId != selectedBase }),
            ordinaryCraftingDetails(saved).map { gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordDetail(it.label, it.value) },
            listOfNotNull(
                if (saved.proof == null && saved.refusal == null) gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction(
                    if (saved.attemptRevision == null) "REVIEW SAVED REQUEST" else "REVIEW SAME REQUEST AGAIN",
                    canAct && saved.command.request.baseId == selectedBase, { model.reviewSaved() }) else null,
                gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("CHECK ORIGINAL RECEIPT", !busy, { model.check() }),
                if (saved.proof != null) gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("ARCHIVE ACCEPTED START", !busy, { model.finish() })
                // Owner 2026-10-06 (dead-end audit): an attempted request with no outcome can be closed too. The same archive
                // action reads its receipt again and closes it only if the server answers `unknown` for this key; never a POST.
                else gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction(when { saved.refusal != null -> "ARCHIVE DECLINED REQUEST"
                    saved.attemptRevision == null -> "ARCHIVE UNUSED DRAFT"; else -> "CLOSE SAVED REQUEST" }, !busy, { model.archiveUnusedOrRefused() })),
            attention = true)
    }
    val jobs = view?.pendingJobs.orEmpty().map { job ->
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordUi(resourceLabel(job.recipe.output.itemId), "REFINING",
            paymentRecordVerb(PaymentTone.SENT), gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon(job.recipe.output.itemId),
            refiningRecipeLines(job.recipe) + listOf("Due: ${job.readyAt} (UTC)", "Delivery is automatic. Refresh for the server's completion observation."),
            listOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordDetail("Job", job.jobId),
                gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordDetail("Started (UTC)", job.startedAt)))
    }
    val archives = state.journal.archives.asReversed().map { archive ->
        val pill = ordinaryCraftingSavedPill(archive.operation)
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordUi(
            when (archive.reason) { "accepted" -> "Historical accepted start"; "refused" -> "Declined request"; "unknown" -> "Closed request"; else -> "Unused draft" },
            pill.label, paymentRecordVerb(pill.tone),
            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon(archive.operation.command.recipe.output.itemId),
            refiningRecipeLines(archive.operation.command.recipe) + listOfNotNull(
                "Acceptance recovered after archival. The original archive reason is preserved."
                    .takeIf { archive.reason != "accepted" && archive.operation.proof != null },
                archive.operation.proof?.completion?.let { "Automatic delivery observed: ${it.completedAt} (UTC)." }
                    ?: "No automatic delivery has been observed for this original request.",
                "Historical proof. Current stock stays in the Stock view."),
            ordinaryCraftingDetails(archive.operation).map { gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordDetail(it.label, it.value) },
            listOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("CHECK AUTOMATIC COMPLETION", !busy,
                { model.checkArchived(archive.operation.command.key) })))
    }
    return gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordsUi("REFINING RECORDS", sections = listOf(
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordSection("SAVED REQUEST", records = listOfNotNull(saved)),
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordSection("ON THE BENCH", records = jobs,
            empty = if (view == null) "Refresh the selected kingdom to load its jobs." else "No active refining job. Start a batch in Refine."),
        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordSection("ARCHIVE", records = archives,
            empty = "Archived starts, declined requests and unused drafts appear here. A start receipt remains available while its job completes.")),
        notes = listOfNotNull("The original start is archived. Its producing kingdom is unavailable here; no current stock is shown for it."
            .takeIf { state.hydration == OrdinaryCraftingHydration.ORIGINAL_BASE_UNAVAILABLE }),
        footer = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftRecordAction("REFRESH STOCK & RECEIPTS", !busy, { model.refresh() }),
        busy = busy)
}

/** The recipe sentences the old receipt plate printed: output, inputs consumed, time · batch units · version. */
private fun refiningRecipeLines(recipe: OrdinaryCraftingRecipe): List<String> = listOf(
    "${fmtN(recipe.output.quantity)} ${resourceLabel(recipe.output.itemId)}",
    recipe.inputs.joinToString(" + ") { "${fmtN(it.quantity)} ${resourceLabel(it.itemId)}" } + " consumed",
    "${fmtDur(recipe.durationSec)} · ${recipe.quantity} batch units · Recipe ${recipe.recipeVersion}")

/** Where a missing ingredient's GO goes when this Workshop does not make it (craft/SPEC.md §2.1 `onGo`): a raw harvester
 *  resource opens the Harvester; anything else opens the Market's BUY tab. */
internal fun workshopIngredientDestination(itemId: String, refine: WorkshopRefineUi?): Destination =
    if (refine?.recipes?.any { recipe -> recipe.inputs.any { it.itemId == itemId && it.kind == InputKind.RAW } } == true) Destination.Harvester()
    else Destination.Market("BUY")

/** The saved request's recovery row, in the owner's existing receipt wording (SPEC §5; checking while its read runs). */
private fun refineSavedOp(operation: OrdinaryCraftingOperation, checking: Boolean): SavedOpUi {
    val key = operation.command.key
    return when {
        operation.proof?.completion != null ->
            SavedOpUi(key, "The server observed automatic delivery.", "Current stock comes from a fresh kingdom read.", checking)
        operation.proof != null -> SavedOpUi(key, "Start accepted.", "Output is delivered automatically.", checking)
        operation.refusal != null -> SavedOpUi(key, "This request was declined.", "Check its original receipt before archiving.", checking)
        operation.attemptRevision != null ->
            SavedOpUi(key, "This request may have been accepted.", "Checking its receipt never sends it again.", checking)
        else -> SavedOpUi(key, checking = checking)
    }
}

private fun resourceLabel(id: String) = if (id == "shards") "SHARDS" else id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
private fun ordinaryCraftingDetails(operation: OrdinaryCraftingOperation) = listOfNotNull(
    PaymentDetail("Producing kingdom", operation.command.request.baseId), PaymentDetail("Original request", operation.command.key),
    operation.proof?.receipt?.let { PaymentDetail("Started (UTC)", it.startedAt) }, operation.proof?.receipt?.let { PaymentDetail("Due (UTC)", it.readyAt) },
    operation.proof?.completion?.let { PaymentDetail("Automatic delivery (UTC)", it.completedAt) })
