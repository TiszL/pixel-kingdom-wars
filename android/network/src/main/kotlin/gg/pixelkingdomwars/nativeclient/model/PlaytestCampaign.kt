package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val campaignJson = Json { ignoreUnknownKeys = true }
private fun campaignTime(value: String?) { value?.let { Instant.parse(it) } }

@Serializable data class CampaignParticipant(val campaignId: String, val wallet: String, val joinedAt: String,
    val disqualifiedAt: String?, val disqualificationReason: String?, val bonusAt: String?) {
    init { require(campaignId.isNotBlank() && wallet.isNotBlank()); campaignTime(joinedAt); campaignTime(disqualifiedAt); campaignTime(bonusAt) }
    companion object { fun from(raw: JsonObject): CampaignParticipant = campaignJson.decodeFromJsonElement(raw) }
}
@Serializable data class CampaignSubmission(val id: String, val campaignId: String, val wallet: String, val kind: String,
    val reportId: String?, val url: String?, val createdAt: String) {
    init { require(id.isNotBlank() && campaignId.isNotBlank() && wallet.isNotBlank()); campaignTime(createdAt)
        when (kind) { "report" -> { UUID.fromString(requireNotNull(reportId)); require(url == null) }; "video" -> require(!url.isNullOrBlank() && reportId == null); else -> error("Unknown campaign submission") } }
    companion object { fun from(raw: JsonObject): CampaignSubmission = campaignJson.decodeFromJsonElement(raw) }
}
@Serializable data class CampaignStanding(val rank: Int, val wallet: String, val username: String, val points: Long,
    val activeDays: Int, val longestStreak: Int, val revenge: Int, val stages: Int, val achievedAt: String?, val eligible: Boolean,
    val guaranteed: Boolean, val isYou: Boolean) {
    init { require(rank > 0 && wallet.isNotBlank() && points >= 0 && activeDays >= 0 && longestStreak >= 0 && revenge >= 0 && stages >= 0); campaignTime(achievedAt) }
}
@Serializable data class CampaignFounder(val wallet: String, val username: String, val position: Int) { init { require(wallet.isNotBlank() && position > 0) } }
@Serializable data class CampaignAward(val prizeId: String, val wallet: String, val username: String, val amountUsd: Int, val category: String) {
    init { require(prizeId.isNotBlank() && wallet.isNotBlank() && amountUsd >= 0 && category.isNotBlank()) }
}
@Serializable data class CampaignPrize(val id: String, val title: String, val amountUsd: Int, val category: String, val metric: String) {
    init { require(id.isNotBlank() && title.isNotBlank() && amountUsd >= 0 && category.isNotBlank() && metric.isNotBlank()) }
}
@Serializable data class CampaignVerification(val status: String, val lastSuccessAt: String?, val lastAttemptAt: String?) {
    init { require(status in setOf("verified", "stale", "unavailable")); campaignTime(lastSuccessAt); campaignTime(lastAttemptAt) }
}
@Serializable data class CampaignCheckpoint(val count: Int?, val target: Int, val frozen: Boolean, val available: Boolean, val verification: CampaignVerification) {
    init { require(count == null || count >= 0); require(target > 0) }
}
@Serializable data class CampaignSpots(val reserved: Int, val ranked: Int, val total: Int) { init { require(reserved >= 0 && ranked >= 0 && total >= 0) } }
@Serializable data class PlaytestCampaign(val id: String, val kind: String, val name: String, val phase: String,
    val startAt: String?, val endAt: String?, val registrationOpen: Boolean, val revision: Int, val reconciledAt: String?,
    val snapshotAt: String?, val checkpoint: CampaignCheckpoint?, val spots: CampaignSpots?, val stale: Boolean,
    val measurementSince: String?, val participant: CampaignParticipant?, val standings: List<CampaignStanding>,
    val founders: List<CampaignFounder>, val winners: List<CampaignAward>, val prizes: List<CampaignPrize>, val ownSubmissions: List<CampaignSubmission>) {
    init { require(id.isNotBlank() && name.isNotBlank() && kind in setOf("founding", "rewarded") && revision > 0)
        require(phase in setOf("draft", "scheduled", "running", "ended", "finalized", "cancelled"))
        listOf(startAt, endAt, reconciledAt, snapshotAt, measurementSince).forEach(::campaignTime)
        require(standings.map { it.rank } == (1..standings.size).toList()); require(founders.map { it.position }.distinct().size == founders.size)
        require(ownSubmissions.map { it.id }.distinct().size == ownSubmissions.size); require(prizes.map { it.id }.distinct().size == prizes.size)
        require(standings.count { it.isYou } <= 1)
    }
    val canEnter get() = kind == "rewarded" && participant == null && registrationOpen && phase in setOf("draft", "scheduled", "running")
    val canSubmit get() = kind == "rewarded" && phase == "running" && participant != null && participant.disqualifiedAt == null
    companion object { fun from(raw: JsonObject): PlaytestCampaign = campaignJson.decodeFromJsonElement(raw) }
}
