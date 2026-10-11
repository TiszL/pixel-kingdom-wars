package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.*

private val communityJson = Json { ignoreUnknownKeys = true }
private fun uuid(value: String) { require(UUID.fromString(value).toString() == value.lowercase()) }
private fun time(value: String?) { value?.let { Instant.parse(it) } }
private fun amount(value: String) { require(value.matches(Regex("0|[1-9][0-9]*"))) }

@Serializable data class MailAttachment(val kind: String, val amount: String? = null, val itemId: String? = null, val qty: Int? = null) {
    init { when (kind) {
        "KEEP", "SHARDS" -> { amount(requireNotNull(amount)); require(itemId == null && qty == null) }
        "ITEM" -> { require(!itemId.isNullOrBlank() && qty != null && qty > 0 && amount == null) }
        else -> error("Unknown mail reward")
    } }
}
@Serializable data class MailMessage(val id: String, val sender: String, val kind: String, val subject: String, val body: String,
    val attachments: List<MailAttachment>, val rewardState: String?, val claimBaseId: String?, val createdAt: String,
    val expiresAt: String?, val readAt: String?, val archivedAt: String?, val claimedAt: String?, val expiredAt: String?) {
    val needsBase get() = attachments.any { it.kind == "SHARDS" || it.kind == "ITEM" }
    init {
        uuid(id); claimBaseId?.let(::uuid); require(sender in setOf("system", "admin"))
        require(subject.isNotBlank() && body.isNotBlank()); time(createdAt); time(expiresAt); time(readAt); time(archivedAt); time(claimedAt); time(expiredAt)
        require(kind == "info" && attachments.isEmpty() && rewardState == null && claimBaseId == null && claimedAt == null && expiredAt == null ||
            kind == "reward" && attachments.isNotEmpty() && rewardState in setOf("pending", "claimed", "expired") && expiresAt != null)
        when (rewardState) {
            "claimed" -> require(claimedAt != null && (claimBaseId != null) == needsBase && expiredAt == null)
            "expired" -> require(expiredAt != null && claimedAt == null && claimBaseId == null)
            "pending" -> require(claimedAt == null && claimBaseId == null && expiredAt == null)
        }
    }
    companion object { fun from(raw: JsonObject): MailMessage = communityJson.decodeFromJsonElement(raw) }
}
@Serializable data class MailPage(val messages: List<MailMessage>, val nextCursor: String?) {
    init { nextCursor?.let(::uuid); require(messages.map { it.id }.distinct().size == messages.size); require(nextCursor == null || messages.lastOrNull()?.id == nextCursor) }
    companion object { fun from(raw: JsonObject): MailPage = communityJson.decodeFromJsonElement(raw) }
}
@Serializable data class MailStatus(val total: Int, val unread: Int, val pendingRewards: Int) {
    init { require(total >= 0 && unread in 0..total && pendingRewards in 0..total) }
    companion object { fun from(raw: JsonObject): MailStatus = communityJson.decodeFromJsonElement(raw) }
}

@Serializable data class LeagueWeek(val startsAt: String, val closesAt: String, val settlesAt: String) {
    init { require(Instant.parse(startsAt) < Instant.parse(closesAt)); require(Instant.parse(closesAt) <= Instant.parse(settlesAt)) }
}
@Serializable data class LeagueRewards(val status: String, val firstSettlementAt: String, val minRatedAttacks: Int, val maxRewardedBasesPerWallet: Int) {
    init { require(status in setOf("disabled", "scheduled", "active")); time(firstSettlementAt); require(minRatedAttacks >= 0 && maxRewardedBasesPerWallet > 0) }
}
@Serializable data class LeagueStanding(val baseId: String, val trophies: Int, val tier: String, val currentWeekRatedAttacks: Int,
    val participationMet: Boolean, val rewardCandidate: Boolean, val blockedByHigherBase: Boolean,
    val tierV2: String? = null, val rewardV2: LeagueRewardV2? = null, val weeklyScore: Int? = null) {
    init { uuid(baseId); leagueTier(tier); require(trophies >= 0 && currentWeekRatedAttacks >= 0) }
}
@Serializable data class LeagueRank(val rank: Int, val baseId: String, val name: String?, val trophies: Int, val tier: String, val you: Boolean,
    val tierV2: String? = null) {
    init { uuid(baseId); leagueTier(tier); require(rank > 0 && trophies >= 0) }
}
@Serializable data class LeagueItem(val itemId: String, val qty: Int) { init { require(itemId.isNotBlank() && qty > 0) } }
@Serializable data class LeagueSettlement(val week: String, val tier: String, val trophies: Int, val keepLevel: Int, val cacheShards: String,
    val items: List<LeagueItem>, val settledAt: String, val tierV2: String? = null, val gems: String? = null,
    val pack: List<LeaguePackLine>? = null) {
    init { LocalDate.parse(week); leagueTier(tier); require(trophies >= 0 && keepLevel > 0); amount(cacheShards); time(settledAt) }
}
@Serializable data class LeagueOverview(val week: LeagueWeek, val rewards: LeagueRewards, val trophyModel: String,
    val you: LeagueStanding?, val board: List<LeagueRank>, val lastSettlement: LeagueSettlement?,
    val ladderVersion: Int? = null, val weeklyBoard: List<LeagueWeeklyRank>? = null, val skr: LeagueSkrOverview? = null,
    @Transient val presentationMode: LeaguePresentationMode = LeaguePresentationMode.UNAVAILABLE) {
    init { require(trophyModel == "cumulative"); require(board.map { it.baseId }.distinct().size == board.size) }
    companion object { fun from(raw: JsonObject): LeagueOverview {
        val mode = leaguePresentationMode(raw)
        return communityJson.decodeFromJsonElement<LeagueOverview>(sanitizeLeagueOverviewV2(raw)).copy(presentationMode = mode)
    } }
}
private fun leagueTier(tier: String) { require(tier in setOf("bronze", "silver", "gold", "sol")) }
