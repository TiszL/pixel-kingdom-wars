package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.EconomyPage

/** Which economy pages a landless player is gated out of (web: the Forge and new withdrawals need a Land Deed;
 * the wallet page, the overview and support stay usable). */
internal val LAND_GATED_PAGES: Set<EconomyPage> = setOf(EconomyPage.FORGE, EconomyPage.WITHDRAWALS)

/** The reads the repository answers with a land-deed refusal instead of data for a landless player. */
internal val LAND_GATED_PATHS: Set<String> = setOf("/forge", "/forge/allocations", "/withdrawals/status")

/** Owner rule: a gate is not an error. `gate` is the one gold BUY LAND notice a landless player sees on a gated page;
 * `stale` are the remaining read failures, each shown as a caution that previously loaded values may be out of date —
 * never red, because nothing the player did was rejected. */
internal data class EconomyReadNotices(val gate: String?, val stale: List<String>)

internal const val STALE_VALUES_NOTE = "Previously loaded values may be out of date."

internal fun economyLandGate(page: EconomyPage, landOwned: Boolean): Boolean = !landOwned && page in LAND_GATED_PAGES

internal fun economyGateCopy(page: EconomyPage): String = when (page) {
    EconomyPage.FORGE -> "A Land Deed unlocks the Gold Forge. Saved allocation claims stay available."
    EconomyPage.WITHDRAWALS -> "A Land Deed is required for new withdrawals. Existing history remains available."
    else -> "A Land Deed unlocks this."
}

internal fun economyReadNotices(page: EconomyPage, landOwned: Boolean, paths: List<String>, errors: Map<String, String>): EconomyReadNotices {
    val gated = economyLandGate(page, landOwned)
    val gate = if (gated) paths.firstOrNull { it in LAND_GATED_PATHS && it in errors }?.let(errors::getValue) ?: economyGateCopy(page) else null
    val stale = paths.filter { !(gated && it in LAND_GATED_PATHS) }.mapNotNull { errors[it] }.distinct().map { "$it $STALE_VALUES_NOTE" }
    return EconomyReadNotices(gate, stale)
}
