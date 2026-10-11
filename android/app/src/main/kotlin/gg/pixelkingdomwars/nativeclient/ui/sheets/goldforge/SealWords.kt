package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import java.time.Instant
import kotlin.math.ceil

/*
 * Owner 2026-10-06 17:24 (Seeker screenshot of FINISH ALL TRAINING?: "Kingdom 5d8f4121-…", nine rows of ISO instants,
 * "Original queue · 9 training slots"; "a black developer interface"): a money-consent Seal speaks the player's words.
 * Only the presentation changes. The frozen request (its ids, its timestamps, its ceiling) is still exactly what the player
 * consents to and what the repository compares and sends; nothing here reads back into it.
 */

/** The reviewed kingdom by its name: the Home read's `player.name`, only when that read IS the reviewed kingdom (the same
 *  binding the Gems balance uses). Any other read, or no name, says "Your kingdom". Never the kingdom's id. */
internal fun sealKingdomLine(home: BaseSnapshot?, reviewedBaseId: String?): String =
    home?.takeIf { reviewedBaseId != null && it.baseId == reviewedBaseId }?.player?.name?.trim()?.takeIf { it.isNotEmpty() }
        ?.let { "Kingdom · $it" } ?: "Your kingdom"

/** A frozen server instant as the time left from [nowMs] ("in 4m", D-070 fmtDur), "now" once it has passed, and null when
 *  it cannot be read (the line is then left out rather than printing the raw text). */
internal fun sealTimeFromNow(frozenIso: String?, nowMs: Long): String? {
    val at = frozenIso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return null
    val seconds = ceil((at - nowMs) / 1000.0).toLong()
    return if (seconds <= 0) "now" else "in ${fmtDur(seconds)}"
}

internal fun sealTroops(count: Int): String = if (count == 1) "1 troop" else "$count troops"
