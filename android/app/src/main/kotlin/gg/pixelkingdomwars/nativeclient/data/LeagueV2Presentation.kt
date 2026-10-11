package gg.pixelkingdomwars.nativeclient.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

// Protocol identities only. Thresholds and all reward amounts remain supplied data.
private val leagueTierIdentitiesV2 = listOf("bronze", "silver", "gold", "platinum", "diamond", "solana", "seeker")

private fun leagueRulesV2(catalogue: JsonObject?): JsonObject? =
    ((catalogue?.get("constants") as? JsonObject)?.get("PHASE_E_LEAGUE_TIERS") as? JsonObject)

/** An older or incompatible content pack cannot supply a plausible v2 ladder. */
internal fun leagueTiersV2(catalogue: JsonObject?): List<String>? {
    val rows = leagueRulesV2(catalogue)?.get("tiers") as? JsonArray ?: return null
    val tiers = rows.map { row ->
        val value = row as? JsonPrimitive ?: return null
        if (!value.isString) return null
        value.content
    }
    return tiers.takeIf { it == leagueTierIdentitiesV2 }
}

/** Read exact integer thresholds from verified content without a local fallback. */
internal fun leagueThresholdsV2(catalogue: JsonObject?): List<Long>? {
    val tiers = leagueTiersV2(catalogue) ?: return null
    val rows = leagueRulesV2(catalogue)?.get("thresholds") as? JsonArray ?: return null
    val values = rows.map { row ->
        val value = row as? JsonPrimitive ?: return null
        if (value.isString) return null
        value.longOrNull ?: return null
    }
    return values.takeIf { it.size == tiers.size && it.all { value -> value >= 0L }
        && it.zipWithNext().all { (low, high) -> high > low } }
}

internal data class LeagueProgressV2(val fraction: Float, val nextTier: String?, val remaining: Long?)

/** Progress is cosmetic; the supplied server tier is never recomputed or promoted. */
internal fun leagueProgressV2(catalogue: JsonObject?, tierV2: String, trophies: Int): LeagueProgressV2? {
    if (trophies < 0) return null
    val tiers = leagueTiersV2(catalogue) ?: return null
    val index = tiers.indexOf(tierV2).takeIf { it >= 0 } ?: return null
    val thresholds = leagueThresholdsV2(catalogue) ?: return null
    val high = thresholds.getOrNull(index + 1) ?: return LeagueProgressV2(1f, null, null)
    val low = thresholds[index]
    val fraction = ((trophies.toLong() - low).toDouble() / (high - low).toDouble()).toFloat().coerceIn(0f, 1f)
    return LeagueProgressV2(fraction, tiers[index + 1], (high - trophies.toLong()).coerceAtLeast(0L))
}
