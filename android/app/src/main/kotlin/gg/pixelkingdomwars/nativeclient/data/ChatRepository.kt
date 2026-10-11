package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.isDefinitiveRejection
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.text.Normalizer
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Numeric bounds come from CHAT in the verified constants catalogue. Server status owns cadence. */
data class ChatBounds(val pageSize: Int, val retainedMessages: Int, val maxUtf8Bytes: Int, val maxLines: Int, val maxGraphemes: Int, val pollOpenMs: Long, val pollClosedMs: Long,
    /** BASE_OWNERSHIP.maxActive: the most kingdoms an author card may report. A pack without it cannot range-check the count. */
    val maxBases: Int? = null) {
    init { require(pageSize > 0 && retainedMessages >= pageSize && maxUtf8Bytes > 0 && maxLines > 0 && maxGraphemes > 0 && pollOpenMs > 0 && pollClosedMs >= pollOpenMs && (maxBases == null || maxBases > 0)) }
    companion object { fun from(catalogue: JsonObject?): ChatBounds? = runCatching {
        val raw = ((catalogue?.get("constants") as? JsonObject)?.get("CHAT") as? JsonObject) ?: return null
        fun bound(key: String) = requireNotNull(raw.string(key)?.toIntOrNull())
        val maxBases = ((catalogue?.get("constants") as? JsonObject)?.get("BASE_OWNERSHIP") as? JsonObject)?.string("maxActive")?.toIntOrNull()?.takeIf { it > 0 }
        ChatBounds(bound("pageSize"), bound("domMessageLimit"), bound("maxUtf8Bytes"), bound("maxLines"), bound("maxGraphemes"), bound("pollOpenMs").toLong(), bound("pollClosedMs").toLong(), maxBases)
    }.getOrNull() }
}
@Serializable data class SavedChatMessage(val wallet: String, val origin: String, val clientMessageId: String, val text: String, val attempted: Boolean = false) {
    init { require(wallet.isNotBlank() && origin.isNotBlank()); require(UUID.fromString(clientMessageId).toString() == clientMessageId.lowercase()); require(text.isNotBlank()) }
}
/** Dedicated encrypted outbox. Lost acknowledgements keep the exact text and UUID across process death.
 * No recipient wallet identity, access token or authorization proof is stored.
 *
 * Dead-end audit 2026-10-06 (shape B). No GET lists one exact clientMessageId completely (the log is a bounded page
 * and moderation redacts), and a message moves no money. So an unconfirmed message never blocks SEND: it stays saved
 * and shown with its RETRY, and a new message is saved beside it under its own new UUID. Duplicate safety: each
 * message is only ever resent under its own UUID, which the server deduplicates; a reused UUID is refused here.
 * One saved message keeps the original single-object bytes (older builds read it); two or more are a JSON array.
 * [MAX_SAVED] is a technical storage bound, not a game number. */
class ChatOutbox(private val store: SecretStore, private val wallet: String, private val origin: String) {
    @Synchronized fun all(): List<SavedChatMessage> {
        val raw = store.read() ?: return emptyList()
        val value = Json.parseToJsonElement(raw)
        val saved = if (value is JsonArray) Json.decodeFromJsonElement<List<SavedChatMessage>>(value).also { require(it.size in 2..MAX_SAVED) }
            else listOf(Json.decodeFromJsonElement<SavedChatMessage>(value))
        saved.forEach { check(it.wallet == wallet && it.origin == origin) { "Saved chat belongs to another account or server" } }
        require(saved.map { it.clientMessageId }.distinct().size == saved.size); return saved
    }
    /** The oldest unresolved message: the one drawn with RETRY. */
    @Synchronized fun read(): SavedChatMessage? = all().firstOrNull()
    @Synchronized fun create(value: SavedChatMessage) {
        val saved = all(); check(saved.size < MAX_SAVED) { "Resolve your interrupted messages before sending another" }
        check(saved.none { it.clientMessageId == value.clientMessageId }) { "Resolve your interrupted message before sending another" }
        check(value.wallet == wallet && value.origin == origin); write(saved + value)
    }
    @Synchronized fun attempted(expected: SavedChatMessage): SavedChatMessage {
        val saved = all(); check(expected in saved); val next = expected.copy(attempted = true)
        write(saved.map { if (it == expected) next else it }); return next
    }
    @Synchronized fun clear(expected: SavedChatMessage) { val saved = all(); check(expected in saved) { "Saved chat changed" }; write(saved - expected) }
    private fun write(saved: List<SavedChatMessage>) = when (saved.size) {
        0 -> store.clear()
        1 -> store.write(Json.encodeToString(saved.single()))
        else -> store.write(Json.encodeToString(saved))
    }
    companion object { const val MAX_SAVED = 8 }
}
data class ChatState(val status: ChatStatus? = null, val messages: List<ChatMessage> = emptyList(), val before: String? = null,
    val cursor: String? = null, val blocks: ChatBlocks? = null, val pending: SavedChatMessage? = null,
    val busy: Boolean = false, val notice: String? = null,
    /** Dead-end audit 2026-10-06: only a full outbox ([ChatOutbox.MAX_SAVED]) holds SEND; [pending] is the oldest saved. */
    val outboxFull: Boolean = false)

class LiveChatRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val outbox: ChatOutbox, private val bounds: () -> ChatBounds?, private val newId: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(ChatState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private val launcherMutable = MutableStateFlow(ChatLauncherState())
    val launcher = launcherMutable.asStateFlow()
    private val launcherAdmission = Mutex()
    private var launcherGeneration = 0L
    private fun current() = holder.requireCurrent(session)
    private fun limits() = requireNotNull(bounds()) { "Chat limits are unavailable. Update game content." }
    private suspend fun <T> disk(block: () -> T): T = withContext(NonCancellable + Dispatchers.IO) { block() }
    /** A player's own order (send, retry, report, block, refresh) queues behind the read in flight: the open poll
     * holds admission for a moment every cadence, and refusing there silently dropped a SEND pressed during it.
     * Only the poll itself stays opportunistic. Each admitted request starts with a clean notice, so the
     * composer can show one as a passing line instead of a permanent row. */
    private suspend fun <T> action(block: suspend () -> T): T { current(); admission.lock(); return admitted(block) }
    private suspend fun <T> admitted(block: suspend () -> T): T {
        try { current(); mutable.update { it.copy(busy = true, notice = null) }; return block() } finally {
            try { if (holder.isCurrent(session)) {
                val saved = disk { outbox.all() }; current(); mutable.update { it.copy(pending = saved.firstOrNull(), outboxFull = saved.size >= ChatOutbox.MAX_SAVED) }
            } } finally { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) }; admission.unlock() }
        }
    }
    private inline fun <T> decode(path: String, read: () -> T): T = try { read() } catch (_: Exception) { throw ApiCompatibilityException(path) }
    /** Eligibility belongs to the Home lifecycle (web CHAT_SCREENS = base/build). Retire late reads on leaving it. */
    @Synchronized fun clearLauncher() { launcherGeneration++; launcherMutable.value = ChatLauncherState() }
    @Synchronized fun markLauncherRead() {
        launcherGeneration++
        launcherMutable.update { it.copy(unreadMessages = emptyMap()) }
    }
    /** Opening retires the closed poll immediately. Closing adopts only the open reader's consumed raw cursor,
     * never a newer status watermark which could skip unread events. No history or outbox state is changed. */
    @Synchronized fun setLauncherOpen(open: Boolean) {
        if (!holder.isCurrent(session)) { clearLauncher(); return }
        launcherGeneration++
        val reader = mutable.value
        launcherMutable.update { before ->
            val cursor = if (open) before.cursor else listOfNotNull(before.cursor, reader.cursor).maxByOrNull { chatDecimal(it, true) }
            before.copy(open = open, cursor = cursor, unreadMessages = emptyMap(),
                status = if (!open && reader.status != null) reader.status else before.status,
                capabilityMissing = if (!open && reader.status != null) false else before.capabilityMissing)
        }
    }
    @Synchronized private fun publishLauncher(generation: Long, transform: (ChatLauncherState) -> ChatLauncherState) {
        if (launcherGeneration == generation && holder.isCurrent(session) && !launcherMutable.value.open)
            launcherMutable.update(transform)
    }
    @Synchronized private fun launcherCurrent(generation: Long) = launcherGeneration == generation && !launcherMutable.value.open
    /** A single bounded closed-panel poll. Capability initialization starts at the latest event, so old history
     * never becomes a badge. This cursor and its bounded ID map are independent of the open conversation. */
    suspend fun pollLauncher() {
        current()
        if (!launcherAdmission.tryLock()) return
        try {
            val (generation, before) = synchronized(this) { launcherGeneration to launcherMutable.value }
            if (before.open || before.capabilityMissing || bounds() == null) return
            if (!before.enabled || before.cursor == null) {
                try {
                    val raw = api.get("/chat/status"); current(); currentCoroutineContext().ensureActive()
                    val status = decode("/chat/status") { ChatStatus.from(raw) }
                    publishLauncher(generation) { it.copy(status = status, cursor = if (status.enabled) status.latestEventId else it.cursor) }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    current(); currentCoroutineContext().ensureActive()
                    if (!chatUnavailable(failure)) throw failure
                    publishLauncher(generation) { it.copy(status = null, capabilityMissing = true) }
                }
                return
            }
            try {
                val raw = api.get("/chat/events", mapOf("after" to before.cursor, "limit" to limits().pageSize.toString()))
                current(); currentCoroutineContext().ensureActive()
                val next = decode("/chat/events") {
                    val page = ChatEvents.from(raw); require(page.events.size <= limits().pageSize)
                    before.events(page, limits().retainedMessages)
                }
                publishLauncher(generation) { next }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                current(); currentCoroutineContext().ensureActive()
                if (!launcherCurrent(generation)) return
                if (chatUnavailable(failure)) {
                    publishLauncher(generation) { it.copy(status = null) }
                } else {
                    // As on web, a transient events failure checks whether chat was disabled, without moving
                    // the consumed event cursor to the newer status watermark or losing the existing pings.
                    try {
                        val raw = api.get("/chat/status"); current(); currentCoroutineContext().ensureActive()
                        val status = decode("/chat/status") { ChatStatus.from(raw) }
                        publishLauncher(generation) { it.copy(status = status.takeIf { value -> value.enabled }) }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { current() }
                    throw failure
                }
            }
        } finally { launcherAdmission.unlock() }
    }
    private fun chatUnavailable(error: Exception) = error is ApiException && (error.status == 404 || error.code == "CHAT_DISABLED")
    private suspend fun status(): ChatStatus {
        val raw = api.get("/chat/status"); current(); val value = decode("/chat/status") { ChatStatus.from(raw) }
        mutable.update { it.copy(status = value, messages = if (value.enabled) it.messages else emptyList()) }; return value
    }
    suspend fun avatar(raw: String, maxBytes: Int): ByteArray {
        require(raw.matches(Regex("/api/avatars/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.webp"))) { "Avatar URL is unavailable" }
        current(); val bytes = api.download(raw.removePrefix("/api"), "image/webp", maxBytes); current(); return bytes
    }
    /** One player's card, resolved by the server from a MESSAGE id: no wallet is sent or returned. Like [avatar]
     * it is a plain read outside admission — a tap must not queue behind the poll or grey the composer out — and
     * nothing is stored: [ChatAuthorCards] holds results in memory for as long as the chat is open. Only a message
     * in the open log can be asked about, so the id is a parsed decimal and the card's name can be held to the
     * name that message shows (contract: byte-for-byte equal). */
    suspend fun authorCard(messageId: String): ChatAuthorCard {
        current()
        val message = checkNotNull(mutable.value.messages.firstOrNull { it.id == messageId }) { "This message is no longer available" }
        val path = "/chat/messages/${message.id}/author"
        val raw = api.get(path); current()
        return decode("/chat/messages/:id/author") { ChatAuthorCard.from(raw, bounds()?.maxBases).also { require(it.name == message.author.name) } }
    }
    suspend fun refresh() = action { refreshUnlocked() }
    private suspend fun refreshUnlocked() {
        val read = status()
        if (!read.enabled) { mutable.update { it.copy(cursor = null, before = null) }; return }
        val raw = api.get("/chat/messages", mapOf("limit" to limits().pageSize.toString())); current()
        val page = decode("/chat/messages") { ChatMessagePage.from(raw).also { require(it.messages.size <= limits().pageSize) } }
        reconcile(page.messages)
        mutable.update { it.copy(messages = page.messages.sortedBy { row -> chatDecimal(row.id) }, before = page.nextBefore, cursor = read.latestEventId) }
    }
    suspend fun poll() {
        current(); if (!admission.tryLock()) return
        admitted {
            if (mutable.value.cursor == null) { refreshUnlocked(); return@admitted }
            val read = status(); if (!read.enabled) { mutable.update { it.copy(cursor = null, before = null) }; return@admitted }
            val after = requireNotNull(mutable.value.cursor)
            val raw = api.get("/chat/events", mapOf("after" to after, "limit" to limits().pageSize.toString())); current()
            val page = decode("/chat/events") { ChatEvents.from(raw).also {
                require(it.events.size <= limits().pageSize && chatDecimal(it.nextAfter, true) >= chatDecimal(after, true))
                require(it.events.all { event -> chatDecimal(event.id) > chatDecimal(after, true) })
            } }
            val messages = mutable.value.messages.associateBy { it.id }.toMutableMap()
            for (event in page.events) {
                if (event.type == "redaction") messages.remove(event.messageId)
                else messages[event.messageId] = requireNotNull(event.message)
            }
            reconcile(page.events.mapNotNull { it.message })
            // nextAfter is the RAW server page cursor, even when all events were filtered out.
            mutable.update { it.copy(messages = messages.values.sortedBy { row -> chatDecimal(row.id) }.takeLast(limits().retainedMessages), cursor = page.nextAfter) }
        }
    }
    suspend fun older() = action {
        val before = mutable.value.before ?: return@action
        val raw = api.get("/chat/messages", mapOf("before" to before, "limit" to limits().pageSize.toString())); current()
        val page = decode("/chat/messages") { ChatMessagePage.from(raw).also {
            require(it.messages.size <= limits().pageSize && it.messages.all { row -> chatDecimal(row.id) < chatDecimal(before) })
            require(it.nextBefore == null || chatDecimal(requireNotNull(it.nextBefore)) < chatDecimal(before))
        } }
        reconcile(page.messages)
        mutable.update { state -> state.copy(messages = (page.messages + state.messages).distinctBy { it.id }.sortedBy { chatDecimal(it.id) }.take(limits().retainedMessages), before = page.nextBefore) }
    }
    suspend fun send(raw: String) = action {
        check(mutable.value.status?.canSend == true) { "Chat is not ready to send. Refresh its status." }
        val text = Normalizer.normalize(raw.replace("\r\n", "\n").replace('\r', '\n'), Normalizer.Form.NFC).trim()
        require(text.isNotBlank() && text.toByteArray(Charsets.UTF_8).size <= limits().maxUtf8Bytes && text.split('\n').size <= limits().maxLines) { "Message exceeds chat limits" }
        // The server validates graphemes, control characters, links and actual mention recipients.
        val saved = SavedChatMessage(session.wallet, session.origin, newId(), text)
        disk { outbox.create(saved) }; sendSaved(saved)
    }
    suspend fun retry() = action { sendSaved(requireNotNull(disk { outbox.read() }) { "No interrupted message" }) }
    private suspend fun sendSaved(saved: SavedChatMessage) {
        current(); val attempted = disk { outbox.attempted(saved) }; current()
        val raw = try { api.post("/chat/messages", jsonBody("clientMessageId" to saved.clientMessageId, "text" to saved.text)) }
        catch (failure: ApiException) {
            current()
            if (failure.code == "CHAT_MESSAGE_REDACTED") {
                disk { outbox.clear(attempted) }; current(); mutable.update { it.copy(notice = "Your saved message was removed by moderation.") }; return
            }
            if (!saved.attempted && isDefinitiveRejection(failure.status)) disk { outbox.clear(attempted) }
            throw failure
        }
        current()
        val message = decode("/chat/messages") { ChatMessage.from(raw).also { require(it.clientMessageId == saved.clientMessageId && !it.canBlock) } }
        disk { outbox.clear(attempted) }; current()
        mutable.update { it.copy(messages = (it.messages + message).distinctBy { row -> row.id }.sortedBy { row -> chatDecimal(row.id) }.takeLast(limits().retainedMessages), notice = SENT_NOTICE) }
    }
    private suspend fun reconcile(messages: List<ChatMessage>) {
        // UUID plus viewer-relative own-author permission identifies this wallet's exact message.
        val delivered = disk { outbox.all() }.filter { pending -> messages.any { it.clientMessageId == pending.clientMessageId && !it.canBlock } }
        if (delivered.isEmpty()) return
        current(); for (pending in delivered) disk { outbox.clear(pending) }
        current(); mutable.update { it.copy(notice = "Your saved message was delivered.") }
    }
    suspend fun refreshBlocks(older: Boolean = false) = action { blocksUnlocked(older) }
    private suspend fun blocksUnlocked(older: Boolean) {
        val previous = mutable.value.blocks
        val before = if (older) previous?.nextBefore ?: return else null
        val raw = api.get("/chat/blocks", mapOf("limit" to limits().pageSize.toString()) + before?.let { mapOf("before" to it) }.orEmpty()); current()
        val page = decode("/chat/blocks") { ChatBlocks.from(raw).also {
            require(it.blocks.size <= limits().pageSize)
            require(before == null || it.blocks.all { row -> chatDecimal(row.id) < chatDecimal(before) })
        } }
        mutable.update { it.copy(blocks = if (older) ChatBlocks(requireNotNull(previous).blocks + page.blocks, page.nextBefore) else page) }
    }
    suspend fun block(messageId: String) = action {
        check(mutable.value.messages.any { it.id == messageId && it.canBlock }) { "This author cannot be blocked" }
        api.post("/chat/messages/$messageId/block"); current()
        // Reload the server-filtered list; public chat deliberately exposes no author wallet key.
        mutable.update { it.copy(messages = emptyList()) }; refreshUnlocked(); blocksUnlocked(false)
    }
    suspend fun unblock(id: String) = action {
        check(mutable.value.blocks?.blocks?.any { it.id == id } == true) { "Refresh blocked accounts" }
        api.delete("/chat/blocks/$id"); current(); blocksUnlocked(false); refreshUnlocked()
    }
    suspend fun report(messageId: String, reason: String) = action {
        require(reason in REPORT_REASONS); check(mutable.value.messages.any { it.id == messageId }) { "This message is no longer available" }
        api.post("/chat/messages/$messageId/report", jsonBody("reason" to reason)); current(); mutable.update { it.copy(notice = "Report sent to moderators.") }
    }
    companion object {
        /** Routine confirmation: the delivered message appearing in the list already says it; the composer
         * keeps it for accessibility announcements only and never spends a visible row on it. */
        const val SENT_NOTICE = "Message sent."
        // Wire enum from apps/api/src/chat/service.ts CHAT_REPORT_REASONS, not tuning.
        val REPORT_REASONS = listOf("spam", "harassment", "hate", "sexual", "personal_info", "other")
    }
}
