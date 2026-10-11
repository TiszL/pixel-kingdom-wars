package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.isDefinitiveRejection
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

data class FeedbackBounds(val categories: List<String>, val titleMax: Int, val bodyMin: Int, val bodyMax: Int,
    val replyMax: Int, val pageSize: Int, val cursorMax: Int, val requestIdMax: Int, val attachmentsMax: Int,
    val uploadMax: Int, val downloadMax: Int, val imageEdgeMax: Int, val decodedPixelsMax: Long) {
    companion object { fun from(catalogue: JsonObject?): FeedbackBounds? = runCatching {
        val constants = requireNotNull(catalogue?.get("constants") as? JsonObject)
        val report = constants.getValue("TESTER_PROGRAM").jsonObject.getValue("feedback").jsonObject
        val thread = constants.getValue("FEEDBACK_THREADS").jsonObject
        val images = constants.getValue("FEEDBACK_SCREENSHOTS").jsonObject
        fun number(raw: JsonObject, key: String) = requireNotNull(raw.string(key)?.toIntOrNull()).also { require(it > 0) }
        FeedbackBounds(report.getValue("categories").jsonArray.map { it.jsonPrimitive.content }.also { require(it.isNotEmpty()) },
            number(report, "titleMaxLen"), number(report, "bodyMinLen"), number(report, "bodyMaxLen"), number(thread, "replyMaxLen"),
            number(thread, "pageSize"), number(thread, "reportCursorMaxLen"), number(thread, "requestIdMaxLen"), number(images, "maxPerMessage"),
            number(images, "maxUploadBytes"), number(images, "maxNormalizedBytes"), number(images, "maxOutputEdge"), number(images, "maxDecodedPixels").toLong())
    }.getOrNull() }
}
data class FeedbackIssueBounds(val queryMax: Int, val resultLimit: Int, val debounceMs: Long) {
    companion object { fun from(catalogue: JsonObject?): FeedbackIssueBounds? = runCatching {
        val raw = requireNotNull(catalogue?.get("constants") as? JsonObject).getValue("FEEDBACK_ISSUES").jsonObject
        fun number(key: String) = requireNotNull(raw.string(key)?.toIntOrNull()).also { require(it > 0) }
        FeedbackIssueBounds(number("queryMaxLen"), number("resultLimit"), number("searchDebounceMs").toLong())
    }.getOrNull() }
}
/** Originals remain in memory only. Recovery asks for the identical image; encrypted metadata
 * preserves its SHA-256 and immutable upload ID, never a broad photo-library permission. */
data class FeedbackImage(val bytes: ByteArray, val contentType: String)
internal fun feedbackImageHash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
@Serializable data class SavedFeedbackImage(val requestId: String, val sha256: String, val size: Int, val contentType: String,
    val attachment: FeedbackAttachment? = null) {
    init { feedbackUuid(requestId); require(sha256.matches(Regex("[a-f0-9]{64}")) && size > 0)
        require(contentType in setOf("image/png", "image/jpeg", "image/webp")) }
}
@Serializable data class SavedFeedback(val wallet: String, val origin: String, val requestId: String,
    val kind: String, val body: String, val category: String? = null, val title: String? = null,
    val context: JsonObject = buildJsonObject {}, val reportId: String? = null,
    val images: List<SavedFeedbackImage> = emptyList(), val attempted: Boolean = false,
    val reportReceipt: FeedbackReceipt? = null, val replyReceipt: FeedbackMessage? = null,
    val issue: FeedbackIssue? = null, val evidenceMode: String? = null,
    val evidenceReceipt: FeedbackEvidenceReceipt? = null, val confirmationReceipt: FeedbackIssue? = null,
    val attachmentReplyId: String? = null, val attachmentReplyAttempted: Boolean = false,
    val attachmentReplyReceipt: FeedbackMessage? = null) {
    init { feedbackUuid(requestId); require(wallet.isNotBlank() && origin.isNotBlank())
        require(when (kind) {
            "report" -> !category.isNullOrBlank() && !title.isNullOrBlank() && reportId == null && replyReceipt == null && issue == null
            "reply" -> reportId != null && category == null && title == null && reportReceipt == null && issue == null
            "evidence" -> issue != null && evidenceMode in setOf("evidence", "recurrence") && !title.isNullOrBlank() && category == null && reportId == null && reportReceipt == null && replyReceipt == null
            "confirm" -> issue != null && body.isEmpty() && category == null && title == null && reportId == null && images.isEmpty() && reportReceipt == null && replyReceipt == null
            else -> false
        })
        require(kind == "evidence" || evidenceReceipt == null && evidenceMode == null); require(kind == "confirm" || confirmationReceipt == null)
        attachmentReplyId?.let(::feedbackUuid)
        require(if (kind in setOf("report", "evidence") && images.isNotEmpty()) attachmentReplyId != null else attachmentReplyId == null && !attachmentReplyAttempted && attachmentReplyReceipt == null)
        require(!attachmentReplyAttempted || reportReceipt != null || evidenceReceipt != null)
        reportId?.let(::feedbackUuid); require(images.map { it.requestId }.distinct().size == images.size) }
}
/** A saved request whose delivery is uncertain and cannot finish without the server: it may be kept aside
 * ([FeedbackOutbox.park]). Not-yet-attempted requests, and acknowledged reports whose screenshot reply was never
 * attempted, already have their own exits (retry, discard, finish without screenshots). */
fun feedbackParkable(saved: SavedFeedback): Boolean {
    val acknowledged = saved.reportReceipt != null || saved.replyReceipt != null || saved.evidenceReceipt != null || saved.confirmationReceipt != null
    return if (!acknowledged) saved.attempted else saved.attachmentReplyAttempted && saved.attachmentReplyReceipt == null
}
/** One active saved request (the one every flow continues) plus requests kept aside.
 *
 * Dead-end audit 2026-10-06 (shape B). No GET lists a feedback requestId (report rows carry only the server id) and
 * feedback moves no money, so an uncertain request cannot block every new report forever: the player may keep it
 * aside ([park]); it stays on this phone with CONTINUE (which moves it back and offers RETRY) while a new request
 * uses its own new key. Duplicate safety: a kept request is only ever resent under its own original requestId.
 * Nothing parked keeps the original single-object bytes (older builds read them); otherwise the document is
 * `{"active":…,"parked":[…]}`. [MAX_PARKED] is a technical storage bound. */
class FeedbackOutbox(private val store: SecretStore, private val wallet: String, private val origin: String) {
    @Serializable private data class Document(val active: SavedFeedback?, val parked: List<SavedFeedback>)
    private fun document(): Document {
        val raw = store.read() ?: return Document(null, emptyList())
        val value = Json.parseToJsonElement(raw).jsonObject
        val d = if ("parked" in value) Json.decodeFromJsonElement<Document>(value).also { require(it.parked.size in 1..MAX_PARKED) }
            else Document(Json.decodeFromJsonElement<SavedFeedback>(value), emptyList())
        val all = listOfNotNull(d.active) + d.parked
        all.forEach { check(it.wallet == wallet && it.origin == origin) { "Saved feedback belongs to another account or server" } }
        require(all.map { it.requestId }.distinct().size == all.size); return d
    }
    private fun write(d: Document) = when {
        d.parked.isNotEmpty() -> store.write(Json.encodeToString(d))
        d.active != null -> store.write(Json.encodeToString(d.active))
        else -> store.clear()
    }
    @Synchronized fun read(): SavedFeedback? = document().active
    @Synchronized fun parked(): List<SavedFeedback> = document().parked
    @Synchronized fun create(value: SavedFeedback) { val d = document(); check(d.active == null) { "Resolve your saved feedback before sending another" }
        check(value.wallet == wallet && value.origin == origin && d.parked.none { it.requestId == value.requestId }); write(d.copy(active = value)) }
    @Synchronized fun replace(expected: SavedFeedback, value: SavedFeedback): SavedFeedback {
        val d = document(); check(d.active == expected) { "Saved feedback changed" }; check(value.wallet == wallet && value.origin == origin && value.requestId == expected.requestId)
        write(d.copy(active = value)); return value
    }
    @Synchronized fun clear(expected: SavedFeedback) { val d = document(); check(d.active == expected) { "Saved feedback changed" }; write(d.copy(active = null)) }
    @Synchronized fun park(expected: SavedFeedback) {
        val d = document(); check(d.active == expected && feedbackParkable(expected)) { "Saved feedback changed" }
        check(d.parked.size < MAX_PARKED) { "Continue a request kept on this phone before keeping another" }; write(Document(null, d.parked + expected))
    }
    @Synchronized fun unpark(requestId: String): SavedFeedback {
        val d = document(); check(d.active == null) { "Finish the current saved request first" }
        val kept = d.parked.single { it.requestId == requestId }; write(Document(kept, d.parked - kept)); return kept
    }
    companion object { const val MAX_PARKED = 8 }
}
data class FeedbackState(val reports: List<FeedbackReport> = emptyList(), val nextCursor: String? = null, val loaded: Boolean = false,
    val detail: FeedbackThread? = null, val pending: SavedFeedback? = null, val busy: Boolean = false, val notice: String? = null,
    /** Dead-end audit 2026-10-06: uncertain requests kept aside on this phone; [pending] is the active one only. */
    val parked: List<SavedFeedback> = emptyList(),
    val issues: List<FeedbackIssue> = emptyList(), val selectedIssue: FeedbackIssue? = null, val confirmedIssues: Set<String> = emptySet(),
    /** A known-issue lookup is in flight. Deliberately not [busy]: see [LiveFeedbackRepository.searchIssues]. */
    val searching: Boolean = false)

class LiveFeedbackRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val outbox: FeedbackOutbox, private val bounds: () -> FeedbackBounds?, private val newId: () -> String = { UUID.randomUUID().toString() },
    private val issueBounds: () -> FeedbackIssueBounds? = { null }, private val nativeBuild: String = "unknown") {
    init { require(nativeBuild.matches(Regex("[a-f0-9]{40}|dev|unknown"))) }
    private val mutable = MutableStateFlow(FeedbackState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var detailRequest = 0L
    private var issueRequest = 0L
    private var searches = 0
    /** Unsent text for this signed-in session; see [FeedbackDrafts]. */
    val drafts = FeedbackDrafts()
    private fun current() = holder.requireCurrent(session)
    private fun limits() = requireNotNull(bounds()) { "Feedback limits are unavailable. Update game content." }
    private fun diagnosticContext(baseId: String?) = buildJsonObject {
        put("screen", "feedback"); put("build", nativeBuild); put("platform", "android")
        if (baseId != null) put("baseId", baseId)
    }
    private suspend fun <T> disk(block: () -> T): T = withContext(NonCancellable + Dispatchers.IO) { block() }
    private suspend fun <T> action(block: suspend () -> T): T {
        current(); check(admission.tryLock()) { "A feedback request is already in progress" }; mutable.update { it.copy(busy = true) }
        try { return block() } finally {
            try { if (holder.isCurrent(session)) { val saved = disk { outbox.read() }; val parked = disk { outbox.parked() }; current(); mutable.update { it.copy(pending = saved, parked = parked) } } }
            finally { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) }; admission.unlock() }
        }
    }
    private inline fun <T> decode(path: String, read: () -> T): T = try { read() } catch (_: Exception) { throw ApiCompatibilityException(path) }
    fun closeIssue() { issueRequest++; mutable.update { it.copy(selectedIssue = null) } }
    /** Runs while the player types the report title, so it is a passive GET: it never takes
     * [admission] and never raises [FeedbackState.busy]. A busy form disables its fields, and a
     * disabled field drops focus, closes the keyboard and loses the characters typed meanwhile
     * (0.5.4: players could not finish a title). It also must not make Submit fail with
     * "already in progress". Stale results are still refused by [issueRequest]. */
    suspend fun searchIssues(rawQuery: String, category: String?) {
        val ticket = ++issueRequest
        current(); searches++; mutable.update { it.copy(searching = true) }
        try {
            val cfg = requireNotNull(issueBounds()) { "Known-issue limits are unavailable. Update game content." }
            val query = rawQuery.trim(); require(query.length <= cfg.queryMax && (category == null || category in limits().categories))
            val path = "/tester/issues"; val raw = api.get(path, mapOf("query" to query) + category?.let { mapOf("category" to it) }.orEmpty()); current()
            val page = decode(path) { FeedbackIssues.from(raw).also { require(it.issues.size <= cfg.resultLimit) } }
            if (ticket == issueRequest) mutable.update { it.copy(issues = page.issues, selectedIssue = null) }
        } finally { searches--; if (holder.isCurrent(session)) mutable.update { it.copy(searching = searches > 0) } }
    }
    suspend fun openIssue(id: String) {
        feedbackUuid(id); val ticket = ++issueRequest
        action { val issue = readIssue(id); if (ticket == issueRequest) mutable.update { it.copy(selectedIssue = issue) } }
    }
    private suspend fun readIssue(id: String): FeedbackIssue {
        val path = "/tester/issues/$id"; val raw = api.get(path); current()
        // GET can resolve a published merge to another canonical ID. Show it for new consent, never POST through it silently.
        return decode(path) { FeedbackIssue.from(raw) }
    }
    private suspend fun checkIssueConsent(expected: FeedbackIssue, requireOpen: Boolean = true) {
        if (requireOpen) check(mutable.value.selectedIssue?.sameDescription(expected) == true) { "Open the issue summary before confirming" }
        val ticket = issueRequest; val fresh = readIssue(expected.id)
        check(ticket == issueRequest) { "Issue was closed. Review it again." }
        mutable.update { it.copy(selectedIssue = fresh) }
        check(fresh.sameDescription(expected)) { "This issue changed. Review its current summary before continuing." }
    }
    suspend fun confirmIssue(issue: FeedbackIssue) = action {
        checkIssueConsent(issue)
        val saved = SavedFeedback(session.wallet, session.origin, newId(), "confirm", "", issue = issue)
        disk { outbox.create(saved) }; deliver(saved, emptyList())
    }
    suspend fun evidence(issue: FeedbackIssue, rawTitle: String, rawBody: String, recurrence: Boolean, diagnosticBaseId: String? = null, images: List<FeedbackImage> = emptyList()) = action {
        val cfg = limits(); val title = rawTitle.trim(); val body = rawBody.trim()
        require(title.length in 1..cfg.titleMax && body.length in cfg.bodyMin..cfg.bodyMax) { "Review the title and evidence length" }
        require(recurrence == issue.resolved) { "Choose a new recurrence explicitly for a fixed or closed issue" }
        val frozen = freezeImages(images); val files = imageRecords(frozen)
        // Evidence's frozen selection remains valid while the title changes its suggestion search.
        diagnosticBaseId?.let(::feedbackUuid); checkIssueConsent(issue, requireOpen = false)
        val saved = SavedFeedback(session.wallet, session.origin, newId(), "evidence", body, title = title,
            context = diagnosticContext(diagnosticBaseId),
            issue = issue, evidenceMode = if (recurrence) "recurrence" else "evidence", images = files,
            attachmentReplyId = if (files.isEmpty()) null else newId())
        require(saved.requestId.length <= cfg.requestIdMax); disk { outbox.create(saved) }; deliver(saved, frozen)
    }
    suspend fun refresh(older: Boolean = false) = action { refreshUnlocked(older) }
    /** Production uses explicit refresh/paging. Android adds a GET refresh on foreground;
     * no timer or repeated submission is inferred from the lifecycle. */
    suspend fun resume() = action { refreshUnlocked(); if (mutable.value.detail != null) newerUnlocked() }
    private suspend fun refreshUnlocked(older: Boolean = false) {
        val cursor = if (older) mutable.value.nextCursor ?: return else null
        val path = "/tester/feedback/page"
        val raw = api.get(path, cursor?.let { mapOf("cursor" to it) }.orEmpty()); current()
        val page = decode(path) { FeedbackPage.from(raw).also {
            require(it.feedback.size <= limits().pageSize)
            val next = it.nextCursor; require(next == null || next.length <= limits().cursorMax && next != cursor)
        } }
        mutable.update { it.copy(reports = ((if (older) it.reports else emptyList()) + page.feedback).distinctBy { row -> row.id }, nextCursor = page.nextCursor, loaded = true) }
    }
    fun closeDetail() { detailRequest++; mutable.update { it.copy(detail = null) } }
    suspend fun open(id: String) {
        feedbackUuid(id); val ticket = ++detailRequest
        action { val detail = thread(id); if (ticket == detailRequest) mutable.update { it.copy(detail = detail) } }
    }
    private suspend fun thread(id: String, before: Long? = null, after: Long? = null): FeedbackThread {
        val path = "/tester/feedback/$id/thread"
        require(before == null || after == null)
        val raw = api.get(path, before?.let { mapOf("beforeRevision" to it.toString()) } ?: after?.let { mapOf("afterRevision" to it.toString()) }.orEmpty()); current()
        return decode(path) { FeedbackThread.from(raw).also {
            require(it.report.id == id && it.messages.size <= limits().pageSize)
            require(before == null || it.messages.all { message -> message.revision < before })
            require(after == null || it.messages.all { message -> message.revision > after } && it.nextRevision >= after)
            require(after != null || !it.hasEarlier || it.messages.isNotEmpty())
        } }
    }
    suspend fun earlier() = action {
        val previous = requireNotNull(mutable.value.detail); if (!previous.hasEarlier) return@action
        val ticket = detailRequest; val page = thread(previous.report.id, previous.oldestRevision)
        val messages = (page.messages + previous.messages).distinctBy { it.id }.sortedBy { it.revision }
        check(page.latestRevision >= previous.nextRevision) { "Feedback changed. Refresh the conversation." }
        if (ticket == detailRequest) mutable.update { it.copy(detail = page.copy(messages = messages,
            oldestRevision = messages.firstOrNull()?.revision ?: page.oldestRevision,
            nextRevision = messages.lastOrNull()?.revision ?: page.nextRevision,
            hasMore = page.latestRevision > (messages.lastOrNull()?.revision ?: page.nextRevision))) }
    }
    suspend fun newer() = action { newerUnlocked() }
    private suspend fun newerUnlocked() {
        val previous = requireNotNull(mutable.value.detail); val ticket = detailRequest
        val page = thread(previous.report.id, after = previous.nextRevision)
        check(page.latestRevision >= previous.nextRevision) { "Feedback changed. Reopen the conversation." }
        val messages = (previous.messages + page.messages).distinctBy { it.id }.sortedBy { it.revision }
        if (ticket == detailRequest) mutable.update { it.copy(detail = page.copy(messages = messages,
            oldestRevision = messages.firstOrNull()?.revision ?: previous.oldestRevision,
            nextRevision = messages.lastOrNull()?.revision ?: page.nextRevision,
            readRevision = maxOf(previous.readRevision, page.readRevision), hasEarlier = previous.hasEarlier)) }
    }
    suspend fun markRead() = action {
        val detail = requireNotNull(mutable.value.detail); val ticket = detailRequest
        val path = "/tester/feedback/${detail.report.id}/read"
        val raw = api.post(path, buildJsonObject { put("revision", detail.nextRevision) }); current()
        val read = decode(path) { requireNotNull(raw.string("readRevision")?.toLongOrNull()).also { require(it >= detail.nextRevision) } }
        val unread = detail.unread && read < detail.latestRevision
        if (ticket == detailRequest) mutable.update { it.copy(detail = it.detail?.copy(readRevision = minOf(read, detail.latestRevision), unread = unread),
            reports = it.reports.map { row -> if (row.id == detail.report.id) row.copy(unread = unread) else row }) }
    }
    suspend fun submit(category: String, rawTitle: String, rawBody: String, diagnosticBaseId: String? = null, images: List<FeedbackImage> = emptyList()) = action {
        val title = rawTitle.trim(); val body = rawBody.trim(); val cfg = limits()
        require(category in cfg.categories && title.length in 1..cfg.titleMax && body.length in cfg.bodyMin..cfg.bodyMax) { "Review the category, title and report length" }
        diagnosticBaseId?.let(::feedbackUuid)
        val frozen = freezeImages(images); val files = imageRecords(frozen)
        val saved = SavedFeedback(session.wallet, session.origin, newId(), "report", body, category, title,
            diagnosticContext(diagnosticBaseId), images = files,
            attachmentReplyId = if (files.isEmpty()) null else newId())
        require(saved.requestId.length <= cfg.requestIdMax); disk { outbox.create(saved) }; deliver(saved, frozen)
    }
    suspend fun reply(reportId: String, rawBody: String, images: List<FeedbackImage> = emptyList()) = action {
        val detail = requireNotNull(mutable.value.detail); check(detail.report.id == reportId && !detail.report.locked && !detail.report.closed) { "Refresh this open conversation before replying" }
        val body = rawBody.trim(); val cfg = limits()
        require(body.length <= cfg.replyMax && (body.isNotBlank() || images.isNotEmpty()) && images.size <= cfg.attachmentsMax) { "Review the reply and screenshot limit" }
        // Freeze mutable caller buffers before hashing or any suspension.
        val frozen = freezeImages(images); val files = imageRecords(frozen)
        val saved = SavedFeedback(session.wallet, session.origin, newId(), "reply", body, reportId = reportId, images = files)
        require(saved.requestId.length <= cfg.requestIdMax && files.all { it.requestId.length <= cfg.requestIdMax })
        disk { outbox.create(saved) }; deliver(saved, frozen)
    }
    /** An explicit retry is the only path that may repeat a POST. Opening screens only reads. */
    suspend fun retry(images: List<FeedbackImage> = emptyList()) = action {
        deliver(requireNotNull(disk { outbox.read() }) { "No saved feedback" }, images.map { FeedbackImage(it.bytes.copyOf(), it.contentType) })
    }
    suspend fun discardUnsentReply() = action {
        val saved = requireNotNull(disk { outbox.read() })
        check(saved.kind == "reply" && !saved.attempted && saved.replyReceipt == null) { "A reply that may have been sent must be resolved first" }
        // Uploads alone never publish a message. Abandoned private uploads expire server-side;
        // discarding cannot refund their per-thread capacity or change a sent reply.
        disk { outbox.clear(saved) }; current(); mutable.update { it.copy(notice = "Unsent reply discarded. Unattached screenshots expire automatically.") }
    }
    /** Dead-end audit 2026-10-06 (shape B). Keeps an uncertain saved request on this phone so a new one may be sent;
     * it is never forgotten and is only ever resent under its own original requestId. */
    suspend fun park() = action {
        val saved = requireNotNull(disk { outbox.read() }) { "No saved feedback" }
        check(feedbackParkable(saved)) { "Continue this saved request; it can still finish on its own." }
        disk { outbox.park(saved) }; current()
        mutable.update { it.copy(notice = "Your saved request is kept on this phone. You can send a new one and continue it later.") }
    }
    /** Moves a kept request back to the active slot, where CONTINUE SAVED REQUEST retries it. GET-free, POST-free. */
    suspend fun unpark(requestId: String) = action { disk { outbox.unpark(requestId) }; current() }
    /** The report itself is already acknowledged. This explicit choice removes only images
     * that have not possibly been published by the attachment reply; it never retracts a report. */
    suspend fun finishWithoutScreenshots() = action {
        val saved = requireNotNull(disk { outbox.read() })
        check((saved.reportReceipt != null || saved.evidenceReceipt != null) && saved.images.isNotEmpty() &&
            !saved.attachmentReplyAttempted && saved.attachmentReplyReceipt == null) { "Resolve the possibly sent screenshot reply first" }
        val next = disk { outbox.replace(saved, saved.copy(images = emptyList(), attachmentReplyId = null)) }; current()
        deliver(next, emptyList())
    }
    private fun freezeImages(images: List<FeedbackImage>): List<FeedbackImage> {
        val cfg = limits(); require(images.size <= cfg.attachmentsMax) { "Too many screenshots" }
        return images.map {
            require(it.bytes.isNotEmpty() && it.bytes.size <= cfg.uploadMax && it.contentType in setOf("image/png", "image/jpeg", "image/webp")) { "Screenshot exceeds the supported image limits" }
            FeedbackImage(it.bytes.copyOf(), it.contentType)
        }
    }
    private fun imageRecords(images: List<FeedbackImage>) = images.map { image ->
        SavedFeedbackImage(newId().also { require(it.length <= limits().requestIdMax) }, feedbackImageHash(image.bytes), image.bytes.size, image.contentType)
    }
    private suspend fun uploadFiles(initial: SavedFeedback, reportId: String, images: List<FeedbackImage>): SavedFeedback {
        var saved = initial
        for ((index, file) in saved.images.withIndex()) {
            if (file.attachment != null) continue
            val image = images.firstOrNull { it.contentType == file.contentType && it.bytes.size == file.size && feedbackImageHash(it.bytes) == file.sha256 }
            check(image != null) { "Reselect the original screenshot to continue this saved request" }
            current(); val path = "/tester/feedback/$reportId/screenshots/${file.requestId}"
            val raw = api.upload(path, "POST", image.bytes, file.contentType); current()
            val attachment = decode(path) { FeedbackAttachment.from(raw).also { validateAttachment(it) } }
            val next = saved.copy(images = saved.images.mapIndexed { i, entry -> if (i == index) entry.copy(attachment = attachment) else entry })
            saved = disk { outbox.replace(saved, next) }; current()
        }
        return saved
    }
    /** Called with no suspension after the acknowledgement is known: the caller's scope may be
     * cancelled at the very next suspension point, and a sent report must not survive as a draft. */
    private fun retireSent(sent: SavedFeedback) {
        when (sent.kind) {
            "report", "evidence" -> drafts.retireReport(sent.title.orEmpty(), sent.body)
            "reply" -> sent.reportId?.let { drafts.retireReply(it, sent.body) }
        }
    }
    private suspend fun deliver(initial: SavedFeedback, images: List<FeedbackImage>) {
        var saved = initial; val ticket = detailRequest; val issueTicket = issueRequest
        if (saved.reportReceipt == null && saved.replyReceipt == null && saved.evidenceReceipt == null && saved.confirmationReceipt == null) {
            if (saved.kind == "reply") {
                saved = uploadFiles(saved, requireNotNull(saved.reportId), images)
            }
            val previouslyAttempted = saved.attempted
            saved = disk { outbox.replace(saved, saved.copy(attempted = true)) }; current()
            val path = when (saved.kind) {
                "report" -> "/tester/feedback"; "reply" -> "/tester/feedback/${saved.reportId}/replies"
                "evidence" -> "/tester/issues/${requireNotNull(saved.issue).id}/evidence"
                else -> "/tester/issues/${requireNotNull(saved.issue).id}/confirm"
            }
            val body = buildJsonObject {
                if (saved.kind != "confirm") {
                    put("requestId", saved.requestId); put("body", saved.body)
                    when (saved.kind) {
                        "report" -> { put("category", saved.category); put("title", saved.title); put("context", saved.context) }
                        "evidence" -> { put("mode", saved.evidenceMode); put("title", saved.title); put("context", saved.context) }
                        else -> { put("visibility", "reporter"); put("attachmentIds", JsonArray(saved.images.map { JsonPrimitive(requireNotNull(it.attachment).id) })) }
                    }
                }
            }
            val raw = try { api.post(path, body) } catch (failure: ApiException) {
                current()
                if (saved.kind in setOf("report", "evidence") && failure.code == "FEEDBACK_REPORT_TRASHED") {
                    // Canonical submit verifies this wallet's exact request hash before this terminal response.
                    retireSent(saved); disk { outbox.clear(saved) }; current()
                    mutable.update { it.copy(notice = "Your saved report was removed by the review team. You can create a new report if needed.") }
                    return
                }
                if (saved.kind == "confirm" && failure.code == "FEEDBACK_ISSUE_MERGED") {
                    disk { outbox.clear(saved) }; current()
                    mutable.update { it.copy(notice = "This issue was merged. ${if (previouslyAttempted) "Your earlier confirmation may have been recorded. " else ""}Review the current summary before confirming again.") }
                    return
                }
                // A refusal after an earlier unknown response cannot prove that earlier send failed.
                if (!previouslyAttempted && isDefinitiveRejection(failure.status)) disk { outbox.clear(saved) }
                throw failure
            }
            current()
            val accepted = when (saved.kind) {
                "report" -> saved.copy(reportReceipt = decode(path) { FeedbackReceipt.from(raw) })
                "evidence" -> saved.copy(evidenceReceipt = decode(path) { FeedbackEvidenceReceipt.from(raw).also { require(it.recurrence == (saved.evidenceMode == "recurrence")) } })
                "confirm" -> saved.copy(confirmationReceipt = decode(path) { FeedbackIssue.from(raw).also { require(it.id == saved.issue?.id) } })
                else -> saved.copy(replyReceipt = decode(path) { FeedbackMessage.from(raw).also {
                    require(it.kind == "reply" && it.authorRole == "reporter" && it.body == saved.body && it.attachments.map { row -> row.id } == saved.images.map { row -> row.attachment?.id })
                } })
            }
            retireSent(accepted); saved = disk { outbox.replace(saved, accepted) }; current()
        } else retireSent(saved) // A retry of an acknowledged request: a restored screen may have brought its words back.
        // Reports/evidence are accepted before their images can be uploaded. Each stage has
        // its own durable acknowledgement, so replay never duplicates the primary report.
        if (saved.attachmentReplyId != null && saved.attachmentReplyReceipt == null) {
            val target = saved.reportReceipt?.id ?: requireNotNull(saved.evidenceReceipt).reportId
            saved = uploadFiles(saved, target, images)
            val wasAttempted = saved.attachmentReplyAttempted
            saved = disk { outbox.replace(saved, saved.copy(attachmentReplyAttempted = true)) }; current()
            val path = "/tester/feedback/$target/replies"
            val body = buildJsonObject {
                put("requestId", saved.attachmentReplyId); put("body", ""); put("visibility", "reporter")
                put("attachmentIds", JsonArray(saved.images.map { JsonPrimitive(requireNotNull(it.attachment).id) }))
            }
            val raw = try { api.post(path, body) } catch (failure: ApiException) {
                current()
                if (!wasAttempted && isDefinitiveRejection(failure.status)) {
                    saved = disk { outbox.replace(saved, saved.copy(attachmentReplyAttempted = false)) }; current()
                }
                throw failure
            }
            current()
            val receipt = decode(path) { FeedbackMessage.from(raw).also {
                require(it.kind == "reply" && it.authorRole == "reporter" && it.body.isEmpty() &&
                    it.attachments.map { attachment -> attachment.id } == saved.images.map { image -> image.attachment?.id })
            } }
            saved = disk { outbox.replace(saved, saved.copy(attachmentReplyReceipt = receipt)) }; current()
        }
        // Persist the POST acknowledgement before hydration. Retry after a failed GET never POSTs again.
        if (saved.kind != "confirm") refreshUnlocked()
        val reportId = saved.reportReceipt?.id ?: saved.evidenceReceipt?.reportId ?: saved.reportId
        if (reportId != null && mutable.value.detail?.report?.id == reportId && ticket == detailRequest) {
            val detail = thread(reportId)
            if (ticket == detailRequest) mutable.update { it.copy(detail = detail) }
        }
        current(); disk { outbox.clear(saved) }; current()
        val confirmation = saved.confirmationReceipt
        mutable.update { it.copy(
            confirmedIssues = if (confirmation != null) it.confirmedIssues + confirmation.id else it.confirmedIssues,
            selectedIssue = if (confirmation != null && issueTicket == issueRequest && it.selectedIssue?.id == confirmation.id) confirmation else it.selectedIssue,
            issues = if (confirmation != null) it.issues.map { issue -> if (issue.id == confirmation.id) confirmation else issue } else it.issues,
            notice = when (saved.kind) {
                "report" -> "Report submitted. Points are awarded after review."
                "confirm" -> "Confirmed that you are affected. Confirmations earn no points and publish no private evidence."
                "evidence" -> if (saved.evidenceReceipt?.reused == true) "Private evidence added to your existing report." else "Private ${if (saved.evidenceReceipt?.recurrence == true) "recurrence " else "evidence "}report submitted. Points are awarded after review."
                else -> "Reply sent."
            }) }
    }
    private fun validateAttachment(attachment: FeedbackAttachment) {
        val cfg = limits(); val width = requireNotNull(attachment.width); val height = requireNotNull(attachment.height)
        require(!attachment.expired && requireNotNull(attachment.byteLength) <= cfg.downloadMax &&
            width <= cfg.imageEdgeMax && height <= cfg.imageEdgeMax && width.toLong() * height <= cfg.decodedPixelsMax)
    }
    suspend fun screenshot(reportId: String, attachment: FeedbackAttachment): ByteArray {
        current(); feedbackUuid(reportId); validateAttachment(attachment)
        check(mutable.value.detail?.report?.id == reportId && mutable.value.detail?.messages?.any { attachment in it.attachments } == true) { "Open this screenshot's conversation first" }
        val ticket = detailRequest
        val bytes = api.download("/tester/feedback/$reportId/screenshots/${attachment.id}", "image/webp", limits().downloadMax)
        current(); check(ticket == detailRequest) { "This conversation was closed" }
        check(bytes.size == attachment.byteLength) { "Screenshot changed. Refresh this conversation." }; return bytes
    }
}
