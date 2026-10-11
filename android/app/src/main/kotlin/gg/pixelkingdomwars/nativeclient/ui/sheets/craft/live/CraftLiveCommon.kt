package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import java.math.BigInteger
import java.time.Instant
import java.util.Locale

/**
 * Shared pure helpers of the craft-cluster LIVE mappers (feeds `HarvesterLiveMapper.kt` → `HarvesterSheet` and
 * `CharterLiveMapper.kt` → `ClanCharterBody`). Reads nothing itself: plain conversions of server strings the mappers
 * receive. No Compose, no repository, no network.
 */

/** The one reason every money action of these live sheets carries until the money lane wires it (MS-M3). A tap on such
 *  an action only explains this; nothing is charged, signed or sent from a live sheet. */
internal const val MONEY_WIRING_PENDING = "wiring pending: MS-M3"

/** A plain non-negative integer string from the server as a Long; null when malformed or larger than a Long (an
 *  unknown count reads "…", never 0). */
internal fun liveCount(value: String?): Long? =
    value?.takeIf { it.matches(Regex("0|[1-9][0-9]{0,18}")) }?.toBigInteger()?.takeIf { it.bitLength() < 64 }?.toLong()

/** A plain non-negative integer string as a BigInteger (for ordering wallet sequences); null when malformed. */
internal fun liveBig(value: String?): BigInteger? = value?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }?.toBigInteger()

/** Sum of server quantity strings; null when any one is malformed or the total exceeds a Long (never a partial sum). */
internal fun liveSum(values: List<String>): Long? {
    var total = BigInteger.ZERO
    for (v in values) total += liveBig(v) ?: return null
    return total.takeIf { it.bitLength() < 64 }?.toLong()
}

/** An ISO-8601 server instant as epoch ms; null when unreadable. */
internal fun liveInstantMs(value: String?): Long? = value?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

/** "WAITING FOR THE OTHER WALLET" → "Waiting for the other wallet": the existing screens' upper-case status words as a
 *  sheet sub line (the words themselves are not re-derived). */
internal fun sentenceCase(text: String): String =
    text.lowercase(Locale.US).replaceFirstChar { it.titlecase(Locale.US) }
