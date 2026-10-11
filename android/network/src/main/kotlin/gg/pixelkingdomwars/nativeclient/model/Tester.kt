package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.time.LocalDate
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val testerJson = Json { ignoreUnknownKeys = true }
private fun testerTime(value: String?) { value?.let { Instant.parse(it) } }

@Serializable data class TesterMilestone(val key: String, val category: String, val title: String, val hint: String,
    val points: Long, val achieved: Boolean, val achievedAt: String?) {
    init { require(key.isNotBlank() && category.isNotBlank() && title.isNotBlank() && points >= 0); testerTime(achievedAt); require(achieved == (achievedAt != null)) }
}
@Serializable data class TesterDailyEntry(val key: String, val category: String? = null, val title: String, val hint: String,
    val points: Long, val cap: Int? = null, val days: Int? = null) {
    init { require(key.isNotBlank() && title.isNotBlank() && points >= 0); require(cap == null || cap > 0); require(days == null || days > 0) }
}
@Serializable data class TesterDailyCatalog(val sources: List<TesterDailyEntry>, val streaks: List<TesterDailyEntry>,
    val categoryLabels: Map<String, String>, val lookbackDays: Int) {
    init { require(lookbackDays > 0); require(sources.all { it.cap != null }); require(streaks.all { it.days != null })
        require((sources + streaks).map { it.key }.distinct().size == sources.size + streaks.size) }
}
@Serializable data class TesterDailyRow(val key: String, val count: Int, val points: Long, val lastAt: String) {
    init { require(key.isNotBlank() && count >= 0 && points >= 0); testerTime(lastAt) }
}
@Serializable data class TesterDaily(val todayPoints: Long, val streakDays: Int, val byKey: List<TesterDailyRow>, val catalog: TesterDailyCatalog) {
    init { require(todayPoints >= 0 && streakDays >= 0); require(byKey.map { it.key }.distinct().size == byKey.size) }
}
@Serializable data class TesterReferrals(val invited: Int, val qualified: Int, val activeToday: Int) {
    init { require(invited >= 0 && qualified in 0..invited && activeToday >= 0) }
}
@Serializable data class TesterWhitelist(val requiresLandDeed: Boolean, val spots: Int) { init { require(spots >= 0) } }
@Serializable data class TesterCampaign(val id: String, val scoreType: String, val name: String, val totalDays: Int,
    val startAt: String?, val endAt: String?, val dayIndex: Int?, val rewardCopy: String, val whitelist: TesterWhitelist) {
    init { require(id.isNotBlank() && name.isNotBlank() && scoreType == "founding" && totalDays > 0); testerTime(startAt); testerTime(endAt) }
    val dayLabel get() = when { dayIndex == null -> "Dates to be announced"; dayIndex < 1 -> "Opens soon"; dayIndex > totalDays -> "Closed"; else -> "Day $dayIndex of $totalDays" }
}
@Serializable data class TesterAward(val kind: String, val key: String, val points: Long, val achievedAt: String,
    val day: String? = null, val count: Int? = null) {
    init { require(kind in setOf("milestone", "daily") && key.isNotBlank() && points >= 0); testerTime(achievedAt)
        if (kind == "daily") { LocalDate.parse(requireNotNull(day)); require(requireNotNull(count) >= 0) } }
}
@Serializable data class TesterProgress(val wallet: String, val name: String?, val listed: Boolean, val listedReason: String,
    val points: Long, val rank: Int?, val milestonePoints: Long, val feedbackPoints: Long, val feedbackCount: Int,
    val dailyPoints: Long, val referralPoints: Long, val landOwner: Boolean, val milestones: List<TesterMilestone>,
    val daily: TesterDaily, val referrals: TesterReferrals, val campaign: TesterCampaign, val justEarned: List<TesterAward>) {
    init { require(wallet.isNotBlank() && listedReason.isNotBlank()); require(rank == null || rank > 0)
        require(listOf(points, milestonePoints, feedbackPoints, dailyPoints, referralPoints).all { it >= 0 } && feedbackCount >= 0)
        require(milestones.map { it.key }.distinct().size == milestones.size) }
    companion object { fun from(raw: JsonObject): TesterProgress = testerJson.decodeFromJsonElement(raw) }
}
@Serializable data class TesterRank(val rank: Int, val name: String?, val wallet: String, val points: Long,
    val milestones: Int, val feedback: Int, val dailyPoints: Long, val referralPoints: Long, val landOwner: Boolean, val lastAt: String?) {
    init { require(rank > 0 && wallet.isNotBlank() && points >= 0 && milestones >= 0 && feedback >= 0 && dailyPoints >= 0 && referralPoints >= 0); testerTime(lastAt) }
}
@Serializable data class TesterTotals(val testers: Int, val points: Long, val feedback: Int) { init { require(testers >= 0 && points >= 0 && feedback >= 0) } }
@Serializable data class TesterBoard(val entries: List<TesterRank>, val totals: TesterTotals, val scoreType: String,
    val computedAt: String, val campaignIds: List<String>, val campaign: TesterCampaign) {
    init { require(scoreType == "lifetime"); testerTime(computedAt); require(entries.map { it.rank } == (1..entries.size).toList())
        require(campaignIds.isNotEmpty() && campaignIds.distinct().size == campaignIds.size) }
    companion object { fun from(raw: JsonObject): TesterBoard = testerJson.decodeFromJsonElement(raw) }
}
