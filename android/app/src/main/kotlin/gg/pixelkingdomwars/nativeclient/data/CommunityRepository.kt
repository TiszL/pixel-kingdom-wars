package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.util.UUID

data class MailBounds(val pageSize: Int, val maxPageSize: Int) {
    init { require(pageSize > 0 && maxPageSize >= pageSize) }
    companion object { fun from(catalogue: JsonObject?): MailBounds? = runCatching {
        val raw = ((catalogue?.get("constants") as? JsonObject)?.get("MAIL") as? JsonObject) ?: return null
        MailBounds(requireNotNull(raw.string("listLimitDefault")?.toIntOrNull()), requireNotNull(raw.string("listLimitMax")?.toIntOrNull()))
    }.getOrNull() }
}
data class CommunityState(val mailbox: MailPage? = null, val archived: Boolean = false, val status: MailStatus? = null,
    val detail: MailMessage? = null, val pendingClaim: PendingIntent? = null, val claimNotice: String? = null,
    val leagues: LeagueOverview? = null, val leagueBaseId: String? = null, val busy: Boolean = false,
    val leagueSelectionGeneration: Long? = null,
    /** The saved claim key (the mail id) whose claim offers CLOSE (owner review 2026-10-06: never sent, or a settled server
     * `absent` answer; `unknown` only stops it blocking). */
    val serverUnknownClaimKey: String? = null)

interface CommunityRepository {
    val state: StateFlow<CommunityState>
    suspend fun refreshMail(archived: Boolean)
    suspend fun moreMail()
    suspend fun openMail(id: String)
    fun closeMail()
    suspend fun markRead()
    suspend fun archive()
    suspend fun claim(mailId: String, baseId: String?)
    suspend fun checkClaim()
    suspend fun retryClaim()
    /** CLOSE on the saved claim after a settled server `absent` answer for it (owner review 2026-10-06). Nothing is sent. A repository
     * without the claim journal closes nothing: Unsupported (the saved claim, if any, is retained). */
    suspend fun closeClaim(): Receipt<*>? = Receipt.Unsupported
    suspend fun refreshLeagues()
}

class LiveCommunityRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val store: PendingIntentStore, private val observer: ReceiptObserver, private val selectedBaseId: () -> String?,
    private val bounds: () -> MailBounds?,
    /** A claimed reward credits SHARDS into a base and KEEP to the wallet; the Home HUD re-reads them (see [homeHudRefresh]). */
    private val refreshHud: suspend () -> Unit = {},
    private val selectionGeneration: () -> Long = { 0L }) : CommunityRepository {
    private val mutable = MutableStateFlow(CommunityState())
    override val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var detailRaw: JsonObject? = null
    private var detailRequest = 0L
    private fun current() = holder.requireCurrent(session)
    private fun currentBase(base: String?) { current(); if (base != selectedBaseId()) throw CancellationException("Selected base changed") }
    private fun currentLeagueSelection(base: String?, generation: Long) {
        currentBase(base)
        if (generation != selectionGeneration()) throw CancellationException("League selection changed")
    }
    private val op = MoneyOp(MailClaimSpec, store, object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject { current(); return api.get(path, query).also { current() } }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            current(); body.string("baseId")?.let { currentBase(it) }
            return api.post(path, body).also { current() }
        }
    })
    init { observer.register(op, ::hydrate) }
    private suspend fun <T> action(block: suspend () -> T): T {
        current(); check(admission.tryLock()) { "A community request is already in progress" }
        mutable.update { it.copy(busy = true) }
        try { return block() } finally {
            try {
                if (holder.isCurrent(session)) {
                    try { observer.refresh(session.wallet); mutable.update { it.copy(pendingClaim = op.pending(session.wallet)) } }
                    finally { mutable.update { it.copy(busy = false) } }
                }
            } finally { admission.unlock() }
        }
    }
    private inline fun <T> decode(path: String, read: () -> T): T = try { read() } catch (_: Exception) { throw ApiCompatibilityException(path) }
    private suspend fun readMail(id: String): Pair<JsonObject, MailMessage> {
        require(UUID.fromString(id).toString() == id.lowercase())
        val path = "/mail/$id"; val raw = api.get(path); current()
        val message = decode(path) { MailMessage.from(raw).also { require(it.id == id) } }
        return raw to message
    }
    private suspend fun readStatus(): MailStatus {
        val raw = api.get("/mail/status"); current(); return decode("/mail/status") { MailStatus.from(raw) }
    }
    override suspend fun refreshMail(archived: Boolean) = action {
        if (mutable.value.archived != archived) mutable.update { it.copy(mailbox = null, archived = archived) }
        val page = readPage(archived, null)
        mutable.update { it.copy(mailbox = page, archived = archived) }
        val status = readStatus(); mutable.update { it.copy(status = status) }
    }
    private suspend fun readPage(archived: Boolean, cursor: String?): MailPage {
        val limits = requireNotNull(bounds()) { "Mail limits are unavailable. Update game content." }
        val raw = api.get("/mail", mapOf("archived" to archived.toString(), "limit" to limits.pageSize.toString()) + cursor?.let { mapOf("cursor" to it) }.orEmpty())
        current()
        return decode("/mail") { MailPage.from(raw).also { require(it.messages.size <= limits.pageSize); require(cursor == null || it.nextCursor != cursor) } }
    }
    override suspend fun moreMail() = action {
        val previous = mutable.value.mailbox ?: return@action
        val cursor = previous.nextCursor ?: return@action
        val next = readPage(mutable.value.archived, cursor)
        decode("/mail") { require(next.messages.none { row -> previous.messages.any { it.id == row.id } }) }
        mutable.update { it.copy(mailbox = MailPage(previous.messages + next.messages, next.nextCursor)) }
    }
    override suspend fun openMail(id: String) = action {
        val request = ++detailRequest
        detailRaw = null; mutable.update { it.copy(detail = null) }
        val (raw, message) = readMail(id)
        if (request != detailRequest) throw CancellationException("Mail detail was closed")
        detailRaw = raw; mutable.update { it.copy(detail = message) }
    }
    override fun closeMail() { detailRequest++; detailRaw = null; mutable.update { it.copy(detail = null) } }
    override suspend fun markRead() = changeMail("read")
    override suspend fun archive() = changeMail("archive")
    private suspend fun changeMail(action: String) = action {
        val id = requireNotNull(mutable.value.detail).id
        val request = detailRequest
        val raw = api.post("/mail/$id/$action"); current()
        val message = decode("/mail/$id/$action") { MailMessage.from(raw).also { require(it.id == id); require(if (action == "read") it.readAt != null else it.archivedAt != null) } }
        // Display the acknowledged state immediately. If status fails, refresh can reconcile with GET;
        // no lifecycle event retries the read/archive POST.
        if (request == detailRequest) {
            detailRaw = raw; mutable.update { it.copy(detail = message, mailbox = null) }
        } else mutable.update { it.copy(mailbox = null) }
        val status = readStatus(); mutable.update { it.copy(status = status) }
    }
    override suspend fun claim(mailId: String, baseId: String?) = action {
        val raw = requireNotNull(detailRaw) { "Open the message before claiming" }
        val message = requireNotNull(mutable.value.detail)
        check(message.id == mailId) { "The selected message changed. Review its reward again." }
        check(message.rewardState == "pending") { "This mail has no pending reward" }
        val target = if (message.needsBase) requireNotNull(baseId) { "Select a Land Deed for SHARDS and items" } else null
        if (message.needsBase) currentBase(target)
        val body = buildJsonObject { target?.let { put("baseId", it) } }
        // The key is the mail id, so a new claim can reuse a closed one's key: never its old `unknown` answer.
        mutable.update { it.copy(claimNotice = null, serverUnknownClaimKey = null) }
        op.submit(PendingIntent(IntentKind.MAIL_CLAIM, session.wallet, target, message.id, "/mail/${message.id}/claim", body,
            "Claim mail reward", raw), ::hydrate)
        Unit
    }
    override suspend fun checkClaim() = action {
        val receipt = op.observe(session.wallet, ::hydrate)
        mutable.update { it.copy(serverUnknownClaimKey = op.pending(session.wallet)?.idempotencyKey?.takeIf { receipt != null && op.closable(session.wallet) }) }
        if (receipt == Receipt.Unknown || receipt == Receipt.Absent || receipt == Receipt.Unsupported) mutable.update { it.copy(claimNotice = "No terminal claim receipt yet. The saved destination is unchanged.") }
    }
    override suspend fun retryClaim() = action { op.retry(session.wallet, ::hydrate); Unit }
    /** The existing MoneyOp closure: one more GET of the letter; a terminal reward found there is hydrated as usual, and only a
     * settled server `absent` answer for this exact mail id archives the saved claim on this device (re-read on every Home resume). No POST; the reward stays in its letter. */
    override suspend fun closeClaim(): Receipt<*>? = action {
        val result = op.close(session.wallet, confirmed = true, ::hydrate)
        mutable.update { state -> state.copy(serverUnknownClaimKey = null, claimNotice = if (result is Receipt.Closed) null else state.claimNotice) }
        result
    }
    private suspend fun hydrate(receipt: Receipt.Accepted<MailMessage>) {
        current()
        val request = detailRequest
        val showDetail = mutable.value.detail?.id == receipt.value.id || (mutable.value.detail == null && request == 0L)
        val (raw, latest) = readMail(receipt.value.id)
        decode("/mail/${latest.id}") { require(latest.rewardState == receipt.value.rewardState && latest.claimBaseId == receipt.value.claimBaseId && latest.attachments == receipt.value.attachments) }
        val status = readStatus(); current()
        if (latest.rewardState != "expired") { refreshHud(); current() }
        val notice = when (latest.rewardState) {
            "expired" -> "This reward expired. No reward was claimed."
            else -> if (latest.needsBase) "Reward claimed into base ${latest.claimBaseId}. KEEP, if included, was credited to your wallet."
                else "Reward claimed into your wallet's in-game KEEP balance."
        }
        if (showDetail && request == detailRequest) {
            detailRaw = raw
            mutable.update { it.copy(detail = latest, status = status, mailbox = null, claimNotice = notice) }
        } else mutable.update { it.copy(status = status, mailbox = null, claimNotice = notice) }
    }
    override suspend fun refreshLeagues() = action {
        // The account generation distinguishes A→B→A, even when this request
        // observes the same base ID before and after transport.
        val generation = selectionGeneration()
        val base = selectedBaseId(); currentLeagueSelection(base, generation)
        if (mutable.value.leagueBaseId != base || mutable.value.leagueSelectionGeneration != generation) {
            mutable.update { it.copy(leagues = null, leagueBaseId = base, leagueSelectionGeneration = generation) }
        }
        val raw = api.get("/leagues", base?.let { mapOf("baseId" to it) }.orEmpty()); currentLeagueSelection(base, generation)
        val overview = decode("/leagues") { LeagueOverview.from(raw).also { require(base == null || it.you?.baseId == null || it.you?.baseId == base) } }
        val skr = overview.skr
        val entitlement = skr?.entitlement
        // SKR belongs to the authenticated wallet; its winning base can differ
        // from the selected base. A foreign entitlement cannot erase fixed rewards.
        val bound = if (skr != null && entitlement != null && entitlement.wallet != session.wallet) {
            overview.copy(skr = skr.copy(entitlement = null))
        } else overview
        currentLeagueSelection(base, generation)
        mutable.update { it.copy(leagues = bound, leagueBaseId = base, leagueSelectionGeneration = generation) }
    }
}
