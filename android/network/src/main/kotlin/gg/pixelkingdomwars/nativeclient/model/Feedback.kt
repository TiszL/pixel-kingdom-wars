package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val feedbackJson = Json { ignoreUnknownKeys = true }
fun feedbackUuid(value: String) { require(UUID.fromString(value).toString() == value.lowercase()) }
private fun revision(value: Long) { require(value in 0..9_007_199_254_740_991L) }

/** Reporter-only projection. Staff identity, diagnostics and private revisions are never retained. */
@Serializable data class FeedbackReport(val id: String, val category: String, val title: String, val body: String,
    val status: String, val importance: String?, val points: Int, val createdAt: String,
    val fixedAt: String?, val fixedRef: String?, val adminNote: String? = null,
    val locked: Boolean = false, val closed: Boolean = false, val unread: Boolean = false) {
    init { feedbackUuid(id); Instant.parse(createdAt); fixedAt?.let { Instant.parse(it) }; require(points >= 0)
        require(status in setOf("new", "reviewed", "accepted", "rejected", "duplicate", "fixed")) }
}
@Serializable data class FeedbackPage(val feedback: List<FeedbackReport>, val nextCursor: String?) {
    init { require(feedback.map { it.id }.distinct().size == feedback.size); require(nextCursor == null || nextCursor.isNotBlank()) }
    companion object { fun from(raw: JsonObject): FeedbackPage = feedbackJson.decodeFromJsonElement(raw) }
}
@Serializable data class FeedbackAttachment(val id: String, val width: Int?, val height: Int?, val byteLength: Int?,
    val contentType: String?, val expired: Boolean) {
    init { feedbackUuid(id); width?.let { require(it > 0) }; height?.let { require(it > 0) }; byteLength?.let { require(it > 0) }
        if (!expired) require(width != null && height != null && byteLength != null && contentType == "image/webp") }
    companion object { fun from(raw: JsonObject): FeedbackAttachment = feedbackJson.decodeFromJsonElement(raw) }
}
@Serializable data class FeedbackMessage(val id: String, val revision: Long, val body: String, val kind: String,
    val visibility: String, val authorRole: String, val createdAt: String, val attachments: List<FeedbackAttachment> = emptyList()) {
    init { feedbackUuid(id); revision(revision); require(revision > 0); Instant.parse(createdAt)
        require(visibility == "reporter" && authorRole in setOf("reporter", "admin") && kind in setOf("reply", "status", "note"))
        require(attachments.map { it.id }.distinct().size == attachments.size) }
    companion object { fun from(raw: JsonObject): FeedbackMessage = feedbackJson.decodeFromJsonElement(raw) }
}
@Serializable data class FeedbackThread(val report: FeedbackReport, val messages: List<FeedbackMessage>, val hasMore: Boolean,
    val oldestRevision: Long, val hasEarlier: Boolean, val nextRevision: Long, val latestRevision: Long, val readRevision: Long, val unread: Boolean) {
    init { listOf(oldestRevision, nextRevision, latestRevision, readRevision).forEach(::revision)
        require(oldestRevision <= nextRevision && nextRevision <= latestRevision && readRevision <= latestRevision)
        require(messages.zipWithNext().all { (a, b) -> a.revision < b.revision })
        require(messages.map { it.id }.distinct().size == messages.size)
        require(messages.isEmpty() || messages.first().revision == oldestRevision && messages.last().revision == nextRevision) }
    companion object { fun from(raw: JsonObject): FeedbackThread {
        val report = raw.getValue("report").jsonObject
        require(report["locked"]?.jsonPrimitive?.booleanOrNull != null && report["closed"]?.jsonPrimitive?.booleanOrNull != null)
        return feedbackJson.decodeFromJsonElement(raw)
    } }
}
@Serializable data class FeedbackReceipt(val id: String, val basePoints: Int, val dailyRemaining: Int) {
    init { feedbackUuid(id); require(basePoints >= 0 && dailyRemaining >= 0) }
    companion object { fun from(raw: JsonObject): FeedbackReceipt = feedbackJson.decodeFromJsonElement(raw) }
}

/** The same eight curated public fields are returned with or without a player session. */
@Serializable data class FeedbackIssue(val id: String, val title: String, val summary: String, val category: String,
    val status: String, val workaround: String?, val fixedRelease: String?, val affectedPlayerCount: Int) {
    init { feedbackUuid(id); require(status in setOf("open", "investigating", "planned", "fixed", "closed")); require(affectedPlayerCount >= 0) }
    val resolved: Boolean get() = status == "fixed" || status == "closed"
    /** A new affected count does not change the description the player confirmed. */
    fun sameDescription(other: FeedbackIssue) = copy(affectedPlayerCount = 0) == other.copy(affectedPlayerCount = 0)
    companion object { fun from(raw: JsonObject): FeedbackIssue = feedbackJson.decodeFromJsonElement(raw) }
}
@Serializable data class FeedbackIssues(val issues: List<FeedbackIssue>) {
    init { require(issues.map { it.id }.distinct().size == issues.size) }
    companion object { fun from(raw: JsonObject): FeedbackIssues = feedbackJson.decodeFromJsonElement(raw) }
}
@Serializable data class FeedbackEvidenceReceipt(val reportId: String, val messageId: String?, val reused: Boolean,
    val recurrence: Boolean, val issueRevision: Long, val basePoints: Int, val dailyRemaining: Int?) {
    init { feedbackUuid(reportId); messageId?.let(::feedbackUuid); revision(issueRevision); require(issueRevision > 0 && basePoints >= 0)
        require(if (reused) messageId != null && dailyRemaining == null else messageId == null && dailyRemaining != null && dailyRemaining >= 0) }
    companion object { fun from(raw: JsonObject): FeedbackEvidenceReceipt = feedbackJson.decodeFromJsonElement(raw) }
}
