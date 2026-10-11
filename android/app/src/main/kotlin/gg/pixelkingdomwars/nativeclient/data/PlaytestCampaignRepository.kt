package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

data class PlaytestBounds(val foundingId: String, val rewardedId: String, val foundingName: String, val rewardedName: String,
    val durationDays: Int, val pollMs: Long, val bonusDays: Int, val bonusPoints: Int, val revengeWinsPerOpponentDay: Int, val videoWeights: Map<String, Int>) {
    init { require(foundingId != rewardedId && listOf(foundingId, rewardedId).all { it.matches(Regex("[a-z0-9-]+")) })
        require(durationDays > 0 && pollMs > 0 && bonusDays > 0 && bonusPoints >= 0 && revengeWinsPerOpponentDay > 0); require(videoWeights.values.all { it >= 0 }) }
    val ids get() = listOf(foundingId, rewardedId)
    companion object { fun from(catalogue: JsonObject?): PlaytestBounds? = runCatching {
        val c = catalogue?.get("constants") as? JsonObject ?: return null
        val r = c["PLAYTEST_COMPETITIONS"] as JsonObject; val names = r["names"] as JsonObject; val bonus = r["participationBonus"] as JsonObject
        PlaytestBounds(requireNotNull(r.string("foundingId")), requireNotNull(r.string("rewardedId")), requireNotNull(names.string("founding")), requireNotNull(names.string("rewarded")),
            requireNotNull(r.string("durationDays")?.toIntOrNull()), requireNotNull((c["PLAYTEST_STATS"] as JsonObject).string("refreshEveryMs")?.toLongOrNull()),
            requireNotNull(bonus.string("activeDays")?.toIntOrNull()), requireNotNull(bonus.string("points")?.toIntOrNull()), requireNotNull(r.string("revengeWinsPerOpponentDay")?.toIntOrNull()),
            (r["videoWeights"] as JsonObject).mapValues { (_, value) -> value.jsonPrimitive.int })
    }.getOrNull() }
}

internal fun campaignVideoUrl(value: String): String {
    val text = value.trim(); val uri = text.toHttpUrlOrNull()
    require(uri != null && uri.scheme == "https" && uri.username.isEmpty() && uri.password.isEmpty() && uri.host.contains('.')) { "Enter a public HTTPS video-post URL without account credentials." }
    // Canonical route length validation remains server-owned; its limit is not an
    // exported shared constant. Do not introduce a second native copy of that bound.
    return text
}
@Serializable data class SavedCampaignRequest(val wallet: String, val origin: String, val campaignId: String, val requestId: String,
    val kind: String, val url: String? = null, val reportId: String? = null, val attempted: Boolean = false,
    val participantReceipt: CampaignParticipant? = null, val submissionReceipt: CampaignSubmission? = null) {
    init { UUID.fromString(requestId); require(wallet.isNotBlank() && origin.isNotBlank() && campaignId.matches(Regex("[a-z0-9-]+")))
        when (kind) { "participate" -> require(url == null && reportId == null && submissionReceipt == null)
            "video" -> { campaignVideoUrl(requireNotNull(url)); require(reportId == null && participantReceipt == null) }
            "report" -> { UUID.fromString(requireNotNull(reportId)); require(url == null && participantReceipt == null) }; else -> error("Unknown campaign request") } }
}
class CampaignOutbox(private val store: SecretStore, private val wallet: String, private val origin: String) {
    private val json = Json { ignoreUnknownKeys = true }
    @Synchronized fun read(): SavedCampaignRequest? = store.read()?.let {
        json.decodeFromString<SavedCampaignRequest>(it).also { saved -> check(saved.wallet == wallet && saved.origin == origin) { "Campaign request belongs to another identity" } }
    }
    @Synchronized fun create(value: SavedCampaignRequest) { check(read() == null) { "Resolve the saved campaign request first" }; check(value.wallet == wallet && value.origin == origin); store.write(json.encodeToString(value)) }
    @Synchronized fun replace(previous: SavedCampaignRequest, next: SavedCampaignRequest) { check(read() == previous) { "Campaign request changed" }; check(previous.requestId == next.requestId && next.wallet == wallet && next.origin == origin); store.write(json.encodeToString(next)) }
    @Synchronized fun clear(previous: SavedCampaignRequest) { check(read() == previous) { "Campaign request changed" }; store.clear() }
}
data class PlaytestState(val selectedId: String? = null, val campaign: PlaytestCampaign? = null, val reports: FeedbackPage? = null,
    val pending: SavedCampaignRequest? = null, val busy: Boolean = false, val notice: String? = null) {
    /** A campaign request may start: nothing is in flight and no saved request waits to be resolved. */
    val canAct: Boolean get() = !busy && pending == null
    /** Text entry never follows [busy]. Every read raises it, including the standings poll that runs
     * every `pollMs` while the screen is open, and a disabled field drops focus, closes the keyboard and
     * discards what is typed meanwhile (0.5.4: "players can't send feedback"). Only a saved request,
     * which must be resolved before another can be sent, closes the field. */
    val canType: Boolean get() = pending == null
}

class LivePlaytestRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val outbox: CampaignOutbox, private val bounds: () -> PlaytestBounds?, private val feedbackBounds: () -> FeedbackBounds?) {
    private val mutable = MutableStateFlow(PlaytestState())
    val state = mutable.asStateFlow()
    private val lock = Mutex()
    private var viewRequest = 0L
    private fun current() = holder.requireCurrent(session)
    private fun limits() = requireNotNull(bounds()) { "Campaign rules are unavailable. Update game content." }
    private suspend fun <T> disk(block: () -> T): T = withContext(NonCancellable + Dispatchers.IO) { current(); block() }
    private inline fun <T> decode(path: String, read: () -> T): T = try { read() } catch (_: Exception) { throw ApiCompatibilityException(path) }
    private suspend fun <T> action(block: suspend () -> T): T = lock.withLock {
        current(); mutable.update { it.copy(busy = true) }
        try { block() } finally { if (holder.isCurrent(session)) {
            try { val saved = disk { outbox.read() }; current(); mutable.update { it.copy(pending = saved) } }
            finally { mutable.update { it.copy(busy = false) } }
        } }
    }
    private fun validateOwned(c: PlaytestCampaign) {
        c.participant?.let { require(it.wallet == session.wallet && it.campaignId == c.id) }
        require(c.ownSubmissions.all { it.wallet == session.wallet && it.campaignId == c.id })
        require(c.standings.all { it.isYou == (it.wallet == session.wallet) })
    }
    private suspend fun read(id: String): PlaytestCampaign {
        require(id in limits().ids); val path = "/playtest/campaigns/$id/me"
        val raw = api.get(path); current()
        return decode(path) { PlaytestCampaign.from(raw).also { require(it.id == id && it.kind == if (id == limits().foundingId) "founding" else "rewarded"); validateOwned(it) } }
    }
    suspend fun open(id: String) {
        current(); require(id in limits().ids)
        val ticket = ++viewRequest
        mutable.update { it.copy(selectedId = id, campaign = null, reports = null) }
        action { val result = read(id); reconcile(result)
            if (ticket == viewRequest) mutable.update { it.copy(campaign = result) } }
    }
    fun close() { viewRequest++; mutable.update { it.copy(selectedId = null, campaign = null, reports = null) } }
    suspend fun refresh() = action {
        val id = mutable.value.selectedId ?: return@action
        val ticket = viewRequest; val result = read(id); reconcile(result)
        if (ticket == viewRequest) mutable.update { it.copy(campaign = result) }
    }
    suspend fun reports(older: Boolean = false) = action {
        val ticket = viewRequest; val previous = mutable.value.reports
        val cursor = if (older) previous?.nextCursor ?: return@action else null
        val limits = requireNotNull(feedbackBounds()); val path = "/tester/feedback/page"
        val raw = api.get(path, mapOf("limit" to limits.pageSize.toString()) + cursor?.let { mapOf("cursor" to it) }.orEmpty()); current()
        val page = decode(path) { FeedbackPage.from(raw).also { require(it.feedback.size <= limits.pageSize && (cursor == null || it.nextCursor != cursor)); it.nextCursor?.let { next -> require(next.length <= limits.cursorMax) } } }
        if (ticket == viewRequest) mutable.update { it.copy(reports = if (older) FeedbackPage((previous!!.feedback + page.feedback).distinctBy { row -> row.id }, page.nextCursor) else page) }
    }
    suspend fun participate(consent: PlaytestCampaign) = start(consent, "participate", null, null)
    suspend fun submitVideo(consent: PlaytestCampaign, url: String) = start(consent, "video", campaignVideoUrl(url), null)
    suspend fun submitReport(consent: PlaytestCampaign, id: String) = start(consent, "report", null, UUID.fromString(id).toString())
    private suspend fun start(consent: PlaytestCampaign, kind: String, url: String?, reportId: String?) {
        val ticket = viewRequest
        action {
            admit(ticket)
            check(disk { outbox.read() } == null) { "Resolve the saved campaign request first" }
            val id = consent.id
            check(mutable.value.selectedId == id && mutable.value.campaign != null) { "Open this campaign and review its rules first" }
            val latest = read(id)
            if (ticket != viewRequest) throw CancellationException("Campaign was closed")
            mutable.update { it.copy(campaign = latest) }
            check(latest.revision == consent.revision && latest.startAt == consent.startAt && latest.endAt == consent.endAt) { "Campaign rules changed. Review them before submitting." }
            check(if (kind == "participate") latest.canEnter else latest.canSubmit) { "This campaign is not accepting this action. Review the latest status." }
            if (kind == "report") {
                check(mutable.value.reports?.feedback?.any { it.id == reportId } == true) { "Choose one of your feedback reports first" }
                check(latest.ownSubmissions.none { it.reportId == reportId }) { "This report is already entered in this campaign" }
            }
            val saved = SavedCampaignRequest(session.wallet, session.origin, id, UUID.randomUUID().toString(), kind, url, reportId)
            disk { outbox.create(saved) }; current(); mutable.update { it.copy(pending = saved, notice = null) }
            send(saved, ticket)
        }
    }
    suspend fun checkPending() = action {
        val saved = disk { outbox.read() } ?: return@action
        val ticket = viewRequest
        val c = read(saved.campaignId); reconcile(c)
        if (ticket == viewRequest && mutable.value.selectedId == c.id) mutable.update { it.copy(campaign = c) }
        if (disk { outbox.read() } != null) mutable.update { it.copy(notice = "No matching campaign receipt yet. The saved request is unchanged.") }
    }
    /** Dead-end audit 2026-10-06 (shape A). One saved campaign request blocks every new one. `GET .../me` lists this
     * wallet's participation and ALL its submissions for the campaign (no page or limit), so it answers for exactly
     * this request. Closing re-reads it in this same action: a matching receipt still resolves the request; only when
     * the listing holds no record of it is it closed on this device. A request with a saved receipt never closes.
     * Duplicate safety: a lost POST that lands later is only recorded late; a report already entered stays refused. */
    suspend fun closeUnrecorded() = action {
        val saved = disk { outbox.read() } ?: return@action
        check(saved.participantReceipt == null && saved.submissionReceipt == null) { "This request has a receipt. Refresh to finish it." }
        val ticket = viewRequest; val c = read(saved.campaignId); reconcile(c)
        if (ticket == viewRequest && mutable.value.selectedId == c.id) mutable.update { it.copy(campaign = c) }
        if (disk { outbox.read() } == null) return@action // the listing held its receipt: resolved with proof
        val recorded = if (saved.kind == "participate") c.participant != null else c.ownSubmissions.any { it.id == "${saved.wallet}:${saved.requestId}" }
        check(!recorded) { "The campaign shows this request. It stays saved." }
        disk { outbox.clear(saved) }; current()
        mutable.update { it.copy(notice = CLOSED_NOTICE) }
    }
    suspend fun retry() {
        val ticket = viewRequest
        action {
            admit(ticket)
            val saved = disk { outbox.read() } ?: return@action
            if (saved.participantReceipt != null || saved.submissionReceipt != null) hydrate(saved)
            else send(saved, ticket)
        }
    }
    private fun matching(saved: SavedCampaignRequest, receipt: CampaignSubmission) {
        require(receipt.id == "${saved.wallet}:${saved.requestId}" && receipt.campaignId == saved.campaignId && receipt.wallet == saved.wallet && receipt.kind == saved.kind && receipt.url == saved.url && receipt.reportId == saved.reportId)
    }
    private fun matching(saved: SavedCampaignRequest, receipt: CampaignParticipant) { require(receipt.campaignId == saved.campaignId && receipt.wallet == saved.wallet) }
    private suspend fun reconcile(c: PlaytestCampaign) {
        val saved = disk { outbox.read() } ?: return
        if (saved.campaignId != c.id) return
        val proof = if (saved.kind == "participate") c.participant?.let { decode("campaign receipt") { matching(saved, it) }; saved.copy(participantReceipt = it) }
            else c.ownSubmissions.find { it.id == "${saved.wallet}:${saved.requestId}" }?.let { decode("campaign receipt") { matching(saved, it) }; saved.copy(submissionReceipt = it) }
        if (proof != null) {
            disk { outbox.replace(saved, proof) }; current()
            mutable.update { it.copy(notice = if (saved.kind == "participate") "Participation is recorded for this campaign." else "Your ${saved.kind} submission is recorded for this campaign.") }
            disk { outbox.clear(proof) }
        }
    }
    private suspend fun admit(ticket: Long) {
        current(); currentCoroutineContext().ensureActive()
        if (ticket != viewRequest) throw CancellationException("Campaign was closed before sending")
    }
    private suspend fun send(original: SavedCampaignRequest, ticket: Long) {
        current(); require(original.campaignId in limits().ids)
        admit(ticket)
        var saved = original.copy(attempted = true)
        disk { outbox.replace(original, saved) }
        // Back can occur while the encrypted journal write is completing. Until
        // POST admission, restore the original certainty; an older unknown stays
        // attempted. After api.post starts, ordinary receipt recovery owns it.
        try { admit(ticket) } catch (cancelled: CancellationException) {
            if (holder.isCurrent(session)) disk { outbox.replace(saved, original) }
            throw cancelled
        }
        val path = "/playtest/campaigns/${saved.campaignId}/${if (saved.kind == "participate") "participate" else "submissions"}"
        val body = if (saved.kind == "participate") JsonObject(emptyMap()) else buildJsonObject {
            put("requestId", saved.requestId); put("kind", saved.kind); saved.url?.let { put("url", it) }; saved.reportId?.let { put("reportId", it) }
        }
        val raw = try { api.post(path, body).also { current() } } catch (failure: Exception) {
            current()
            if (!original.attempted && failure is ApiException && failure.status in setOf(400, 401, 403, 404, 409, 422, 429)) disk { outbox.clear(saved) }
            throw failure
        }
        val proof = decode(path) {
            if (saved.kind == "participate") saved.copy(participantReceipt = CampaignParticipant.from(raw).also { matching(saved, it) })
            else saved.copy(submissionReceipt = CampaignSubmission.from(raw).also { matching(saved, it) })
        }
        disk { outbox.replace(saved, proof) }; current(); saved = proof
        mutable.update { it.copy(pending = saved, notice = "Campaign acknowledgement saved. Refreshing its status.") }
        hydrate(saved)
    }
    companion object { const val CLOSED_NOTICE = "The campaign has no record of the saved request. It was closed on this device; you can send a new one." }
    private suspend fun hydrate(saved: SavedCampaignRequest) {
        val ticket = viewRequest; val c = read(saved.campaignId)
        reconcile(c)
        if (ticket == viewRequest && mutable.value.selectedId == c.id) mutable.update { it.copy(campaign = c) }
        check(disk { outbox.read() } == null) { "Acknowledgement saved; the latest campaign view has not included its receipt yet. Refresh to finish." }
    }
}
