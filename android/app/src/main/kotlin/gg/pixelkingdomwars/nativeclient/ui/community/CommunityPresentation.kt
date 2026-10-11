package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.network.string
import java.math.BigInteger
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.*

/** Source leagueTier.ts order. All thresholds, multipliers, rewards and deadlines are supplied data. */
internal val communityLeagueTiers = listOf("bronze", "silver", "gold", "sol")
internal fun leagueRules(catalogue: JsonObject?) = (catalogue?.get("constants") as? JsonObject)?.get("LEAGUES") as? JsonObject
internal fun leagueThresholds(catalogue: JsonObject?): List<Long>? {
    val rows = (leagueRules(catalogue)?.get("thresholds") as? JsonArray) ?: return null
    val values = rows.map { (it as? JsonPrimitive)?.longOrNull ?: return null }
    return values.takeIf { it.size == communityLeagueTiers.size && it.all { n -> n >= 0 } && it.zipWithNext().all { (a,b) -> b > a } }
}
internal data class LeagueProgress(val fraction: Float, val nextTier: String?, val remaining: Long?)
internal fun leagueProgress(catalogue: JsonObject?, tier: String, trophies: Int): LeagueProgress? {
    val index = communityLeagueTiers.indexOf(tier).takeIf { it >= 0 } ?: return null
    val thresholds = leagueThresholds(catalogue) ?: return null
    val high = thresholds.getOrNull(index + 1) ?: return LeagueProgress(1f, null, null)
    val low = thresholds[index]
    return LeagueProgress(((trophies.toDouble() - low) / (high - low)).toFloat().coerceIn(0f, 1f), communityLeagueTiers[index + 1], (high - trophies).coerceAtLeast(0))
}
internal fun leagueCache(catalogue: JsonObject?, tier: String, keepLevel: Int?): String? {
    if (keepLevel == null || keepLevel <= 0) return null
    val rules = leagueRules(catalogue) ?: return null
    val table = rules["weeklyCacheShardsByKeepLevel"] as? JsonArray ?: return null
    if (table.isEmpty()) return null
    val base = (table.getOrNull((keepLevel - 1).coerceAtMost(table.lastIndex)) as? JsonPrimitive)?.content?.toBigIntegerOrNull() ?: return null
    val multiplier = (rules["cacheTierMultBps"] as? JsonObject)?.string(tier)?.toBigIntegerOrNull() ?: return null
    if (base.signum() < 0 || multiplier.signum() < 0) return null
    return (base * multiplier / BigInteger.valueOf(10_000)).toString() // Basis-point unit, source weeklyCache.
}
internal fun communityItemName(catalogue: JsonObject?, id: String): String {
    val legacy = (catalogue?.get("constants") as? JsonObject)?.get("LEGACY_ITEMS") as? JsonObject
    return (legacy?.get(id) as? JsonObject)?.string("name") ?: id.replace('_', ' ').uppercase()
}
internal fun communityDate(value: String?, zone: ZoneId = ZoneId.systemDefault()): String = value?.let {
    runCatching { DateTimeFormatter.ofPattern("MMM dd, yyyy HH:mm", Locale.getDefault()).withZone(zone).format(Instant.parse(it)) }.getOrNull()
} ?: "—"
internal fun leagueRemaining(value: String, now: Long): Long? = runCatching {
    val remaining = java.time.Duration.between(Instant.ofEpochMilli(now), Instant.parse(value))
    if (remaining.isNegative || remaining.isZero) 0L else remaining.seconds + if (remaining.nano > 0) 1 else 0
}.getOrNull()
