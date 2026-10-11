package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.FeedbackAttachment
import gg.pixelkingdomwars.nativeclient.model.FeedbackIssue
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import kotlinx.coroutines.*

private val ReportDraftSaver = listSaver<FeedbackReportDraft, Any>(
    save = { listOf(it.category, it.title, it.body, it.includeBase) },
    restore = { FeedbackReportDraft(it[0] as String, it[1] as String, it[2] as String, it[3] as Boolean) })

/**
 * The existing feedback owner, drawn as the designed card (SPEC §2.7, part two §C): NEW is the designed form, MY REPORTS
 * the designed list, and the saved request, conversation, known-issue evidence and screenshot viewer keep their reviewed
 * bodies inside it. [FeedbackHub] is the entry both routes use; the first five parameters are the old route's call.
 * Standalone, Back is this screen's; [hosted] in a Home sheet, Back is the host's except while a nested layer is open.
 */
@Composable fun FeedbackScreen(
    repository: LiveFeedbackRepository, bounds: FeedbackBounds?, baseId: String?, issueBounds: FeedbackIssueBounds?, onBack: () -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(), kingdomName: String? = null, testerPoints: String? = null,
    hosted: Boolean = false, selectedTab: String? = null, onTab: ((String) -> Unit)? = null,
    ownerCurrent: () -> Boolean = { true }, canRead: () -> Boolean = { true },
) {
    val state by repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val current by rememberUpdatedState(ownerCurrent)
    val readable by rememberUpdatedState(canRead)
    var localTab by rememberSaveable(repository) { mutableStateOf("NEW") }
    val tab = selectedTab?.takeIf { it in FEEDBACK_TABS } ?: localTab
    // Unsent words live in the session's FeedbackDrafts, so Back or leaving the card keeps them;
    // the saveable copy only carries them across process death (for example behind the file picker).
    val drafts = repository.drafts
    var draft by rememberSaveable(repository, stateSaver = ReportDraftSaver) { mutableStateOf(drafts.report) }
    // A SEND or reply POST is in flight. Its words are frozen (read-only callbacks, never disabled fields), so what is
    // sent and what is on screen cannot diverge and a sent report cannot return as a draft.
    var sending by remember(repository) { mutableStateOf(false) }
    var sent by remember(repository) { mutableStateOf(false) }
    var failed by remember(repository) { mutableStateOf(false) }
    var error by remember(repository) { mutableStateOf<String?>(null) }
    var readError by remember(repository) { mutableStateOf<String?>(null) }
    var reply by rememberSaveable(repository) { mutableStateOf("") }
    var evidenceIssue by remember(repository) { mutableStateOf<FeedbackIssue?>(null) }
    var recurrence by remember(repository) { mutableStateOf(false) }
    var files by remember(repository) { mutableStateOf<List<FeedbackImage>>(emptyList()) }
    var omitted by remember(repository) { mutableStateOf<Set<Int>>(emptySet()) }
    var loadingFiles by remember(repository) { mutableStateOf(false) }
    var epoch by remember(repository) { mutableIntStateOf(0) }
    var pickerTicket by remember(repository) { mutableStateOf<FeedbackPickerTicket?>(null) }
    var screenshot by remember(repository) { mutableStateOf<Pair<String, FeedbackAttachment>?>(null) }
    var confirmDiscard by remember(repository) { mutableStateOf(false) }
    fun explain(message: String) { error = message }
    fun requireCurrent() { if (!current()) throw CancellationException("Feedback owner changed") }
    val gate = FeedbackActionGate({ current() }, { sending || repository.state.value.busy || loadingFiles }, ::explain, paused = { !readable() })
    val enabled = bounds != null && current() && readable() && !state.busy && !loadingFiles && !sending
    // Keep fields focused while requests run. Frozen callbacks, rather than disabled fields, retain the exact words sent.
    val typing = bounds != null
    fun edit(next: FeedbackReportDraft) {
        // The live repository value: a collected copy can lag a request that has just resolved the saved request.
        if (sending || sent || repository.state.value.pending != null || !current()) return
        draft = next; drafts.keepReport(next); failed = false
    }
    /** Forgets the words once a saved report is resolved; the guard in [edit] would refuse them while it is pending. */
    fun forgetReport() { draft = FeedbackReportDraft(); drafts.keepReport(draft); evidenceIssue = null; recurrence = false; failed = false }
    LaunchedEffect(repository) { draft = drafts.restoreReport(draft) }
    suspend fun request(action: suspend () -> Unit): Boolean {
        error = null
        return try { requireCurrent(); check(readable()) { "Feedback is paused while the current action finishes." }; action(); requireCurrent(); true }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { if (current()) error = failure.message ?: "Feedback connection interrupted. Check the saved request."; false }
    }
    /** Sends a report, evidence or reply. The repository retires the words the server acknowledged in
     * [FeedbackDrafts], where leaving this card cannot skip it; the card only follows the holder. */
    fun send(action: suspend () -> Unit) {
        gate.run {
            sending = true; failed = false
            scope.launch { try { if (!request(action)) failed = true } finally {
                if (current()) {
                    sending = false; draft = drafts.report
                    repository.state.value.detail?.report?.id?.let { reply = drafts.reply(it) }
                }
            } }
        }
    }
    fun clearPictures() { epoch++; files = emptyList(); omitted = emptySet(); pickerTicket = null }
    fun changeTab(next: String) {
        if (!current() || next !in FEEDBACK_TABS) return
        if (sending) { explain("Your feedback is being sent. Please wait."); return }
        clearPictures(); repository.closeDetail(); repository.closeIssue(); screenshot = null
        evidenceIssue = null; recurrence = false; sent = false
        localTab = next; onTab?.invoke(next)
    }
    fun leave() { clearPictures(); repository.closeDetail(); repository.closeIssue(); onBack() }
    fun close() {
        if (!current()) { onBack(); return }
        if (sending) { explain("Your feedback is being sent. Please wait."); return }
        if (feedbackCloseNeedsConfirm(tab, draft, repository.state.value.pending != null, sent)) { confirmDiscard = true; return }
        leave()
    }
    val backStep = feedbackBackStep(confirmDiscard, screenshot != null, state.detail != null)
    fun back() {
        when (feedbackBackStep(confirmDiscard, screenshot != null, repository.state.value.detail != null)) {
            FeedbackBackStep.DISMISS_CONFIRM -> confirmDiscard = false
            FeedbackBackStep.CLOSE_SCREENSHOT -> screenshot = null
            FeedbackBackStep.CLOSE_CONVERSATION -> { clearPictures(); repository.closeDetail(); reply = "" /* kept in drafts for this report */ }
            FeedbackBackStep.CLOSE_CARD -> close()
        }
    }
    // The discard confirm sits above every sheet; the conversation and screenshot consume a hosted Back only while open.
    BackHandlerAt(BackPriority.CONFIRM, enabled = confirmDiscard) { confirmDiscard = false }
    BackHandlerAt(if (hosted) BackPriority.SHEET else BackPriority.SCREEN,
        enabled = !hosted || feedbackConsumesHostedBack(backStep), onBack = ::back)
    DisposableEffect(repository) { onDispose { repository.closeDetail(); repository.closeIssue() } }
    LaunchedEffect(repository, bounds, lifecycle) {
        if (bounds != null) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (!current()) return@repeatOnLifecycle
            if (readable()) {
                val ok = request { repository.resume() }
                if (current()) readError = if (ok) null else error
            } else { readError = "Feedback is paused while the current action finishes. Tap Retry." }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val ticket = pickerTicket; pickerTicket = null
        fun ticketCurrent() = current() && ticket?.isCurrent(repository, epoch,
            repository.state.value.pending?.requestId ?: repository.state.value.detail?.report?.id) == true
        if (uris.isNotEmpty() && ticketCurrent() && bounds != null) {
            loadingFiles = true
            scope.launch { try { request {
                require(uris.size <= bounds.attachmentsMax) { "Choose up to ${bounds.attachmentsMax} screenshots" }
                val selected = withContext(Dispatchers.IO) {
                    uris.map { uri ->
                        ensureActive()
                        val type = context.contentResolver.getType(uri)
                        require(type in setOf("image/png", "image/jpeg", "image/webp")) { "Choose a PNG, JPEG or WebP screenshot" }
                        val bytes = context.contentResolver.openInputStream(uri)?.use { readProfileImage(it, bounds.uploadMax) { ensureActive() } }
                        FeedbackImage(requireNotNull(bytes) { "Screenshot is unavailable" }, requireNotNull(type))
                    }
                }
                if (ticketCurrent()) { files = selected; omitted = emptySet() }
            } } finally { if (current()) loadingFiles = false } }
        }
    }
    fun selectFiles() {
        gate.run {
            if (bounds == null) explain("Feedback limits are unavailable. Update game content.")
            else {
                pickerTicket = FeedbackPickerTicket(repository, epoch, state.pending?.requestId ?: state.detail?.report?.id)
                picker.launch(arrayOf("image/png", "image/jpeg", "image/webp"))
            }
        }
    }
    val detailId = state.detail?.report?.id
    LaunchedEffect(detailId) { if (detailId != null) reply = drafts.reply(detailId) }
    var thumbnails by remember(repository) { mutableStateOf<List<ImageBitmap?>>(emptyList()) }
    LaunchedEffect(files, bounds) {
        thumbnails = withContext(Dispatchers.IO) {
            files.map { file -> runCatching {
                val limits = requireNotNull(bounds)
                val size = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size, size)
                require(size.outWidth > 0 && size.outHeight > 0 && size.outWidth.toLong() * size.outHeight <= limits.decodedPixelsMax)
                val options = BitmapFactory.Options().apply { inSampleSize = 1 }
                while (maxOf(size.outWidth, size.outHeight) / options.inSampleSize > 256) options.inSampleSize *= 2
                requireNotNull(BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size, options)).asImageBitmap()
            }.getOrNull() }
        }
    }
    val ui = feedbackHubUi(state, bounds, draft, tab,
        attachments = files.mapIndexed { index, _ -> AttachmentUi(index.toString(), thumbnails.getOrNull(index), index !in omitted, "Selected screenshot ${index + 1}") },
        kingdomName = kingdomName ?: baseId?.let { "Selected kingdom" },
        sending = sending, failed = failed, sent = sent, current = current() && readable(), loadingFiles = loadingFiles, error = error,
        recurrenceRequired = evidenceIssue?.resolved == true, recurrence = recurrence).copy(
        discard = if (confirmDiscard) feedbackDiscardConfirm() else null)
    fun refresh(older: Boolean = false) {
        gate.run { scope.launch {
            val ok = request { if (repository.state.value.detail != null) repository.newer() else repository.refresh(older) }
            if (current()) readError = if (ok) null else error
        } }
    }
    fun openReport(id: String) {
        // The phone's saved request has no server conversation yet: its Continue lives on NEW.
        if (feedbackRowOpensSavedRequest(id, repository.state.value)) { changeTab("NEW"); return }
        gate.run {
            clearPictures(); reply = ""; localTab = "MY REPORTS"; onTab?.invoke("MY REPORTS")
            scope.launch { request { repository.open(id) } }
        }
    }
    fun toggleAttachment(value: String) {
        if (sending || state.pending != null || !current()) return
        val index = value.toIntOrNull() ?: return
        if (index in files.indices) omitted = if (index in omitted) omitted - index else omitted + index
    }
    fun sendReport() {
        val blocker = feedbackSubmitBlocker(bounds, draft, evidenceIssue?.resolved == true, recurrence)
        if (blocker != null) { explain(blocker); return }
        if (repository.state.value.pending != null) { explain("Continue your saved request before sending another."); return }
        val ticket = epoch; val captured = draft; val selected = evidenceIssue; val capturedRecurrence = recurrence
        val capturedBase = if (captured.includeBase) baseId else null
        val images = files.filterIndexed { index, _ -> index !in omitted }
        send {
            if (selected == null) repository.submit(captured.category, captured.title, captured.body, capturedBase, images)
            else repository.evidence(selected, captured.title, captured.body, capturedRecurrence, capturedBase, images)
            requireCurrent()
            if (ticket == epoch) {
                clearPictures(); evidenceIssue = null; recurrence = false
                // Only a cleared outbox with the repository's own acknowledgement is a confirmed send.
                sent = repository.state.value.pending == null && repository.state.value.notice.let {
                    it == "Report submitted. Points are awarded after review." || it?.startsWith("Private ") == true }
            }
        }
    }
    val actions = FeedbackActions(
        onTab = ::changeTab, onCategory = { if (it in bounds?.categories.orEmpty()) edit(draft.copy(category = it)) },
        onTitle = { edit(draft.copy(title = it)) }, onBody = { edit(draft.copy(body = it)) },
        onToggleAttachment = ::toggleAttachment, onAddPicture = ::selectFiles, onIncludeKingdom = { edit(draft.copy(includeBase = it)) },
        onSend = ::sendReport, onOpenReport = ::openReport, onBack = ::back, onClose = ::close,
        // KEEP leaves with the words kept in drafts; only DISCARD erases them.
        onDiscardKeep = { confirmDiscard = false; leave() },
        onDiscardConfirm = {
            if (current() && !sending && repository.state.value.pending == null) {
                confirmDiscard = false; edit(FeedbackReportDraft()); leave()
            } else { confirmDiscard = false; explain("A feedback request is still finishing. Please wait.") }
        },
    )
    FeedbackSheetR2(ui, feedbackHubReportsUi(state, testerPoints, error = readError), actions,
        FeedbackReportsActions(onReport = ::openReport, onWrite = { changeTab("NEW") }, onRetry = { refresh() }, onReportProblem = { changeTab("NEW") }),
        modifier = modifier.imePadding(),
        // The saved request replaces the NEW form until it resolves; MY REPORTS and its conversations stay readable.
        // The saved request, the conversation and the NEW extras keep their reviewed words, calls and enable rules; they are
        // drawn with the kit (cream plates, stone and gold buttons, the hub text field and toggle row) instead of the old
        // dark web plates on the parchment card (owner 2026-10-06: no old screen anywhere). A DISABLED kit primary still
        // answers a tap, so each primary guards its own call with the same rule its old `enabled` carried.
        bodyOverride = if (state.pending == null || tab != "NEW") null else ({ OnParchment {
        val saved = state.pending
        if (saved != null) LazyColumn(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) { item {
            Plate(PlateKind.CREAM, Modifier.fillMaxWidth(), blocksScene = false) { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                PkwText("Saved ${when (saved.kind) { "report" -> "report"; "evidence" -> "private evidence"; "confirm" -> "issue confirmation"; else -> "reply" }}",
                    PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                saved.issue?.let { FeedbackLine(it.title); FeedbackLine(it.summary) }
                saved.title?.let { FeedbackLine(it) }; FeedbackLine(saved.body)
                FeedbackLine(if ((saved.reportReceipt != null || saved.evidenceReceipt != null) && saved.images.isNotEmpty() && saved.attachmentReplyReceipt == null) "Report saved. Screenshot delivery still needs to finish."
                    else if (saved.reportReceipt != null || saved.replyReceipt != null || saved.evidenceReceipt != null || saved.confirmationReceipt != null) "Sent successfully. Tap Continue saved request to finish."
                    else "Delivery may be incomplete. Retry preserves the original text and request.")
                if (saved.images.any { it.attachment == null }) {
                    FeedbackLine("Reselect the original screenshots if needed. Uploaded screenshots are retained; different files cannot replace an interrupted upload.")
                    SecondaryButton("RESELECT ORIGINAL SCREENSHOTS", ::selectFiles, Modifier.fillMaxWidth(), enabled = enabled,
                        contentDescription = "Reselect original screenshots")
                }
                FeedbackLine("${files.size} local screenshots selected", small = true)
                PrimaryButton("CONTINUE SAVED REQUEST", { if (enabled) { val selected = files; val ticket = epoch; scope.launch { request {
                    repository.retry(selected)
                    if (current() && ticket == epoch) {
                        files = emptyList()
                        if (saved.kind == "report" || saved.kind == "evidence") forgetReport()
                        else if (saved.kind == "reply") { reply = ""; saved.reportId?.let { drafts.keepReply(it, "") } }
                    }
                } } } }, Modifier.fillMaxWidth(), state = if (enabled) CommandState.ENABLED else CommandState.DISABLED)
                // Dead-end audit 2026-10-06 (shape B): an uncertain request never blocks a new one; it is kept, never forgotten.
                if (feedbackParkable(saved)) {
                    FeedbackLine("You can keep this request on this phone and send a new one. Continue it later from NEW.", small = true)
                    SecondaryButton("KEEP IT SAVED · WRITE A NEW ONE", { scope.launch { request { repository.park() } } }, Modifier.fillMaxWidth(),
                        enabled = enabled, contentDescription = "Keep the saved request and write a new one")
                }
                if (saved.kind == "reply" && !saved.attempted && saved.replyReceipt == null) SecondaryButton("DISCARD UNSENT REPLY", {
                    scope.launch { request { repository.discardUnsentReply(); files = emptyList() } }
                }, Modifier.fillMaxWidth(), enabled = enabled, contentDescription = "Discard unsent reply")
                if ((saved.reportReceipt != null || saved.evidenceReceipt != null) && saved.images.isNotEmpty() && !saved.attachmentReplyAttempted && saved.attachmentReplyReceipt == null) {
                    FeedbackLine("You can keep the saved report without these screenshots. Unattached uploads expire automatically.")
                    SecondaryButton("FINISH WITHOUT SCREENSHOTS", { val ticket = epoch; scope.launch { request {
                        repository.finishWithoutScreenshots()
                        if (current() && ticket == epoch) { files = emptyList(); forgetReport() }
                    } } }, Modifier.fillMaxWidth(), enabled = enabled, contentDescription = "Finish report without screenshots")
                }
            } }
        } }
        } }),
        conversation = { OnParchment {
            // Read once at composition: the list below must not race a detail that closes before it measures.
            val thread = state.detail
            if (thread != null) LazyColumn(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val report = thread.report
                item {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        PkwText(report.title, PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch, maxLines = 3)
                        FeedbackLine("${report.category} · ${report.status} · ${report.points} points", small = true)
                        FeedbackLine(report.body)
                        FeedbackLine(report.createdAt, small = true)
                        report.adminNote?.takeIf { it.isNotBlank() }?.let { FeedbackLine("Review: $it") }
                        report.fixedRef?.let { FeedbackLine("Fixed in: $it") }
                        if (thread.unread) SecondaryButton("MARK CONVERSATION READ", { scope.launch { request { repository.markRead() } } },
                            enabled = enabled, contentDescription = "Mark conversation read")
                    }
                }
                if (thread.hasEarlier) item { SecondaryButton("EARLIER MESSAGES", { scope.launch { request { repository.earlier() } } }, Modifier.fillMaxWidth(),
                    enabled = enabled, contentDescription = "Earlier messages") }
                if (thread.hasMore) item { SecondaryButton("NEWER MESSAGES", { scope.launch { request { repository.newer() } } }, Modifier.fillMaxWidth(),
                    enabled = enabled, contentDescription = "Newer messages") }
                items(thread.messages, key = { it.id }) { message ->
                    // The team's replies sit on the cream plate, the player's own on the gold-tinted one (chat.png's own-bubble grammar).
                    Plate(PlateKind.CREAM, Modifier.fillMaxWidth(), tint = if (message.authorRole == "admin") null else PkwTokens.Colors.selectedTint,
                        blocksScene = false) { Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        PkwText(if (message.authorRole == "admin") "Review team" else "You", PkwTokens.Type.label, color = PkwTokens.Colors.textOnParch)
                        FeedbackLine(message.body)
                        FeedbackLine(message.createdAt, small = true)
                        message.attachments.forEachIndexed { index, attachment ->
                            SecondaryButton(if (attachment.expired) "SCREENSHOT ${index + 1} EXPIRED" else "VIEW SCREENSHOT ${index + 1}",
                                { screenshot = report.id to attachment }, enabled = !attachment.expired,
                                contentDescription = if (attachment.expired) "Screenshot ${index + 1} expired" else "View screenshot ${index + 1}")
                        }
                    } }
                }
                if (report.locked || report.closed) item { FeedbackLine("This conversation is closed to new replies and screenshots.") }
                else if (state.pending != null) item {
                    // A saved request blocks a new reply until it resolves; its Continue is on NEW.
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        FeedbackLine("Finish your saved request before replying here.")
                        SecondaryButton("OPEN SAVED REQUEST", { changeTab("NEW") }, enabled = !sending, contentDescription = "Open saved request")
                    }
                }
                else {
                    item {
                        HubTextField(reply, { if (!sending && current()) { reply = it; drafts.keepReply(report.id, it) } }, "Reply to review team",
                            placeholder = "Reply to review team", counter = "${reply.length}/${bounds?.replyMax ?: "—"}", area = true, enabled = typing)
                    }
                    item {
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            SecondaryButton("CHOOSE SCREENSHOTS (${files.size}/${bounds?.attachmentsMax ?: "—"})", ::selectFiles, Modifier.fillMaxWidth(),
                                enabled = enabled, contentDescription = "Choose screenshots, ${files.size} of ${bounds?.attachmentsMax ?: "unknown"}")
                            if (files.isNotEmpty()) SecondaryButton("REMOVE SELECTED SCREENSHOTS", { files = emptyList() }, Modifier.fillMaxWidth(),
                                enabled = enabled, contentDescription = "Remove selected screenshots")
                            FeedbackLine("Screenshots are private to this report. Check for personal information before sending.", small = true)
                            val canReply = enabled && reply.length <= (bounds?.replyMax ?: 0) && (reply.isNotBlank() || files.isNotEmpty())
                            PrimaryButton("SEND REPLY", { if (canReply) { val ticket = epoch; val selected = files; val text = reply
                                // Only the text that was sent is cleared, by the repository; send() then shows what the holder kept.
                                send { repository.reply(report.id, text, selected); if (current() && ticket == epoch) files = emptyList() }
                            } }, Modifier.fillMaxWidth(), state = if (canReply) CommandState.ENABLED else CommandState.DISABLED)
                        }
                    }
                }
                item { SecondaryButton("REFRESH CONVERSATION", { refresh() }, Modifier.fillMaxWidth(), enabled = enabled, contentDescription = "Refresh conversation") }
            }
        } },
        newExtras = { OnParchment {
            if (state.pending == null && state.parked.isNotEmpty()) {
                FeedbackLine("Kept on this phone (${state.parked.size}): delivery unconfirmed. Continue one to retry it with its original request.")
                state.parked.forEach { kept ->
                    FeedbackLine("${when (kept.kind) { "report" -> "Report"; "evidence" -> "Private evidence"; "confirm" -> "Issue confirmation"; else -> "Reply" }}: ${kept.title ?: kept.issue?.title ?: kept.body}", small = true)
                    SecondaryButton("CONTINUE THIS SAVED REQUEST", { scope.launch { request { repository.unpark(kept.requestId) } } }, Modifier.fillMaxWidth(),
                        enabled = enabled, contentDescription = "Continue a saved request")
                }
            }
            FeedbackLine("Avoid passwords, wallet keys, private conversations and sensitive personal details. Reports and screenshots are visible to the review team.", small = true)
            KnownIssues(repository, issueBounds, draft.title, draft.category, enabled, onEvidence = { issue ->
                evidenceIssue = issue; recurrence = false; edit(draft.copy(category = issue.category, title = draft.title.ifBlank { issue.title }))
            })
            evidenceIssue?.let { selected ->
                FeedbackLine("Private evidence for: ${selected.title}")
                FeedbackLine("Evidence stays in your private report. The server may add it to your existing report for this issue.", small = true)
                if (selected.resolved) ToggleRow("New recurrence", "This fixed or closed issue is happening again", recurrence, { recurrence = it },
                    disabledReason = if (enabled) null else "Wait for the current request to finish.")
                SecondaryButton("REPORT A DIFFERENT PROBLEM", { evidenceIssue = null; recurrence = false }, enabled = enabled,
                    contentDescription = "Report a different problem")
            }
            if (files.isNotEmpty()) SecondaryButton("REMOVE SELECTED SCREENSHOTS", { clearPictures() }, enabled = enabled,
                contentDescription = "Remove selected screenshots")
        } },
        reportsExtras = { OnParchment {
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("REFRESH", { refresh() }, Modifier.weight(1f), enabled = enabled, contentDescription = "Refresh reports")
                if (state.nextCursor != null) SecondaryButton("MORE REPORTS", { refresh(true) }, Modifier.weight(1f), enabled = enabled,
                    contentDescription = "More reports")
            }
        } },
    )
    screenshot?.let { selected -> FeedbackScreenshot(repository, selected.first, selected.second, bounds, onClose = { screenshot = null }) }
}

/**
 * The reviewed saved-request, conversation and known-issue bodies use Material text, whose app-wide colour (the root
 * Surface's) is cream for dark screens. Inside the designed card they sit on parchment, so their text is ink there.
 */
@Composable private fun ColumnScope.OnParchment(content: @Composable ColumnScope.() -> Unit) {
    CompositionLocalProvider(LocalContentColor provides PkwTokens.Colors.textOnParch) { content() }
}

/** One reviewed sentence on the parchment card: VT 20 ink (or VT 18 secondary with [small]), wrapping freely. */
@Composable private fun FeedbackLine(text: String, small: Boolean = false) {
    PkwText(text, if (small) PkwTokens.Type.small else PkwTokens.Type.body,
        color = if (small) PkwTokens.Colors.textOnParch2 else PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
}

@Composable private fun FeedbackScreenshot(repository: LiveFeedbackRepository, reportId: String, attachment: FeedbackAttachment, bounds: FeedbackBounds?, onClose: () -> Unit) {
    var image by remember(repository, attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    var error by remember(repository, attachment.id) { mutableStateOf<String?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val displayEdge = LocalContext.current.resources.displayMetrics.widthPixels.coerceAtLeast(1)
    LaunchedEffect(repository, attachment.id, lifecycle) {
        if (bounds != null) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try {
                val bytes = repository.screenshot(reportId, attachment)
                image = withContext(Dispatchers.IO) {
                    val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, dimensions)
                    require(dimensions.outWidth in 1..bounds.imageEdgeMax && dimensions.outHeight in 1..bounds.imageEdgeMax &&
                        dimensions.outWidth.toLong() * dimensions.outHeight <= bounds.decodedPixelsMax)
                    // Decode for the screen, keeping a full-size server image out of the UI heap.
                    val options = BitmapFactory.Options()
                    while (maxOf(dimensions.outWidth, dimensions.outHeight) / options.inSampleSize.coerceAtLeast(1) > displayEdge) {
                        options.inSampleSize = options.inSampleSize.coerceAtLeast(1) * 2
                    }
                    requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)).asImageBitmap()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message ?: "Screenshot is unavailable" }
        }
        else { error = "Feedback limits are unavailable. Update game content." }
    }
    AlertDialog(onDismissRequest = onClose, title = { Text("Private screenshot") }, text = {
        image?.let { Image(it, "Feedback screenshot", Modifier.fillMaxWidth()) } ?: Text(error ?: "Loading screenshot…")
    }, confirmButton = { TextButton(onClick = onClose) { Text("Close") } })
}
