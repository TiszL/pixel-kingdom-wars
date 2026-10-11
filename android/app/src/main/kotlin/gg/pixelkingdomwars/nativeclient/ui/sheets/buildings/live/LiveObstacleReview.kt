package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*

internal fun consumeObstacleTap(open: Boolean, busy: Boolean, owner: () -> Boolean, close: () -> Unit): Boolean =
    if (owner()) true else if (open) { if (!busy) close(); true } else false

/** An idle obstacle only. Running clear jobs and original construction recovery remain with their existing owners. */
internal fun liveObstacleReview(state: KingdomUiState, obstacle: Obstacle, busy: Boolean, scene: BaseScene?, sent: Boolean = false): ObstacleQuoteUi? {
    val base = state.base ?: return null
    if (base.obstacles.none { it == obstacle } || base.jobs.any { it.obstacleId == obstacle.id }) return null
    val tier = state.catalogue?.let { obstacleTier(it, obstacle.spriteKey.orEmpty()) }
    val cost = tier?.costShards?.takeIf { it >= 0 }?.toString()
    val seconds = tier?.clearSec?.takeIf { it >= 0 }
    val free = base.freeBuilders.takeIf { base.raw.containsKey("freeBuilders") && it >= 0 }
    val have = state.home.balances?.shards?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }?.toBigIntegerOrNull()
    val short = if (cost != null && have != null) (cost.toBigInteger() - have).takeIf { it.signum() > 0 } else null
    val reason = when {
        state.constructionBlocked -> "Resolve the saved construction payment first"
        !state.ordersAllowed || !state.deedActionsAllowed -> "Game orders are paused"
        cost == null || seconds == null -> "Clearing cost unavailable"
        free == null -> "Builder availability unavailable"
        have == null -> "Shards balance unavailable"
        busy && !sent -> "Your kingdom is updating. Try again in a moment."
        else -> state.home.error
    }
    val unavailable = state.constructionBlocked || !state.ordersAllowed || !state.deedActionsAllowed ||
        cost == null || seconds == null || free == null || have == null
    val mode = when {
        busy && sent -> UpgradeState.BUSY
        busy -> UpgradeState.READ_ONLY
        unavailable -> UpgradeState.READ_ONLY
        free == 0 -> UpgradeState.NO_BUILDER
        short != null -> UpgradeState.SHORT
        else -> UpgradeState.READY
    }
    val portrait = scene?.takeIf { it.baseId == base.baseId }?.obstacles?.singleOrNull {
        it.id == obstacle.id && it.tileX == obstacle.tx.toFloat() && it.tileY == obstacle.ty.toFloat() &&
            (it.spriteKey == null || it.spriteKey == obstacle.spriteKey)
    }?.frameKey?.takeIf { it.isNotBlank() } ?: "shape:unknown"
    val priceStatus = when {
        cost == null -> PriceStatus.UNAVAILABLE
        short != null -> PriceStatus.SHORT
        cost == "0" -> PriceStatus.SERVER_ZERO
        else -> PriceStatus.OK
    }
    return ObstacleQuoteUi(obstacle.id, obstacle.spriteKey?.replace('_', ' ')?.uppercase() ?: "OBSTACLE", portrait,
        PriceUi(Currency.SHARDS, cost?.let(::fmtN), priceStatus), seconds?.let(::fmtDur) ?: "…",
        buildersLine(free, base.player.builders),
        state.catalogue?.let(::obstacleClearRewardShards)?.takeIf { it >= 0 }?.let { "Gives ${fmtN(it)} Shards once" },
        mode, title = "REMOVE OBSTACLE", shortfall = short?.toString()?.let(::fmtN), reason = reason)
}
