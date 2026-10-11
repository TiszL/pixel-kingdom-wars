package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.model.MineStatus
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CacheState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.DailyCacheUi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.time.Duration
import java.time.Instant

/** The cache is separate from accrued mining. Only the server's claimable flag admits CLAIM. */
internal fun dailyCacheUi(catalogue: JsonObject?, mine: MineStatus?, busy: Boolean, now: Long,
    blockedReason: String? = null, sent: Boolean = false): DailyCacheUi {
    val constants = catalogue?.get("constants") as? JsonObject
    val definition = constants?.get("DAILY_CACHE") as? JsonObject
    val days = (definition?.get("consistencyStreakDays") as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 }
    val cache = mine?.cache
    val reward = cache?.cacheShards?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }?.let { "+${fmtN(it)}" }
    val dayKnown = cache != null && cache.currentDay >= 0 && (days == null || cache.currentDay <= days)
    val state = when {
        cache == null -> CacheState.LOADING
        busy && sent -> CacheState.CLAIMING
        cache.claimable -> CacheState.READY
        else -> CacheState.CLAIMED
    }
    val nextIn = cache?.nextClaimAt?.let { next -> runCatching {
        fmtDur(Duration.between(Instant.ofEpochMilli(now), Instant.parse(next)).seconds.coerceAtLeast(0))
    }.getOrNull() }
    return DailyCacheUi(
        reward = reward, currency = "shards", day = maxOf(1, cache?.currentDay ?: 1), days = days,
        // Bonus effect wording awaits owner confirmation; the catalogue ratio alone cannot establish it.
        bonusLabel = null, claimable = cache?.claimable == true, nextIn = nextIn,
        ruleLine = "Claim when your cache is ready. The server sets the next claim time.", state = state,
        // BaseState has no claim receipt identity. A status flip or a completed busy action is not a receipt.
        receiptId = null,
        rewardLine = when {
            cache == null -> "Cache details unavailable"
            cache.claimable -> "Shards, ready to claim"
            else -> "Shards cache"
        },
        claimSub = reward?.let { "$it Shards to your stores" }, dayKnown = dayKnown,
        litDays = cache?.currentDay?.takeIf { dayKnown },
        claimBlockedReason = if (state == CacheState.READY) {
            blockedReason ?: if (busy) "Your kingdom is updating. Wait a moment." else null
        } else null,
    )
}

internal fun dailyCacheBlockedReason(ordersAllowed: Boolean, deedActionsAllowed: Boolean, raidActive: Boolean): String? = when {
    !ordersAllowed -> "Install the available native app update before submitting game orders. Your account is preserved."
    !deedActionsAllowed && raidActive -> gg.pixelkingdomwars.nativeclient.ui.Copy.ACTIVE_RAID_MESSAGE
    !deedActionsAllowed -> "This base is read-only. Wait for your kingdom to update, or open another available kingdom."
    else -> null
}

internal fun dailyCacheCanClaim(ui: DailyCacheUi): Boolean =
    ui.claimable && ui.state == CacheState.READY && ui.claimBlockedReason == null

/** The external sheet owner sees the resolved scene tap first, before this local half sheet closes. */
internal fun consumeDailyCacheTap(open: Boolean, owner: () -> Boolean, close: () -> Unit): Boolean =
    if (owner()) true else if (open) { close(); true } else false
