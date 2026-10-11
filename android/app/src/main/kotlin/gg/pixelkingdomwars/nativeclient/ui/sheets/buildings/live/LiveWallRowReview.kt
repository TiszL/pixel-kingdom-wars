package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.network.levelStats
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingPortrait
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import kotlinx.serialization.json.JsonObject

/** The server quotes a row from ONE wall id (`BaseRepository.quoteWallRow`): leaving a wall out is not supported, so a
 *  toggle says so plainly instead of doing nothing (SPEC R2.4 leave-out is not open yet). */
internal const val WALL_ROW_TOGGLE_CLOSED = "Leaving a wall out is not open yet. The whole row upgrades together."

/** The quote's `onToggleWall`: explains, never changes the quote. */
internal fun wallRowToggle(explain: (String) -> Unit): (String) -> Unit = { explain(WALL_ROW_TOGGLE_CLOSED) }

internal fun consumeWallRowTap(open: Boolean, busy: Boolean, owner: () -> Boolean, close: () -> Unit): Boolean =
    if (owner()) true else if (open) { if (!busy) close(); true } else false

internal fun submitWallRowReview(saved: Boolean, purchase: () -> Unit, retryOriginal: () -> Unit) {
    if (saved) retryOriginal() else purchase()
}

/** Same base and permission predicate as the old host, isolated so a stale quote is covered directly. */
internal fun wallRowReviewAllowed(quote: WallRowQuote, baseId: String?, ordersAllowed: Boolean, deedAllowed: Boolean): Boolean =
    ordersAllowed && deedAllowed && (quote.baseId == null || quote.baseId == baseId)

/** The quote is the consent. Totals and eligibility are never recomputed from wall art, levels or player balances. */
internal fun liveWallRowReview(quote: WallRowQuote, catalogue: JsonObject?, busy: Boolean, allowed: Boolean,
    retry: Boolean, message: String?, builders: String): WallRowQuoteUi {
    val eligible = quote.eligible
    fun amount(raw: String) = raw.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }
    val total = amount(quote.totalCostShards)
    val unit = eligible.map { amount(it.costShards) }.distinct().singleOrNull()
    val from = eligible.map { it.level }.distinct().singleOrNull()
    val to = eligible.mapNotNull { it.targetLevel }.distinct().singleOrNull()
    val reason = when {
        !allowed -> "Wall upgrades are unavailable right now"
        eligible.isEmpty() -> "No walls in this quote can upgrade"
        total == null -> "Wall row price unavailable"
        retry -> "Retry the same saved payment · ${fmtN(total)} Shards"
        else -> message
    }
    val state = when {
        busy -> UpgradeState.BUSY
        !allowed || eligible.isEmpty() || total == null -> UpgradeState.READ_ONLY
        !quote.canAfford -> UpgradeState.SHORT
        retry -> UpgradeState.VERIFYING
        else -> UpgradeState.READY
    }
    val totalStatus = when {
        total == null -> PriceStatus.UNAVAILABLE
        !quote.canAfford -> PriceStatus.SHORT
        total == "0" -> PriceStatus.SERVER_ZERO
        else -> PriceStatus.OK
    }
    val balance = amount(quote.balanceShards)
    val shortfall = shortfall(balance, total)?.let(::fmtN)
    fun skipLabel(wall: gg.pixelkingdomwars.nativeclient.model.WallRowWall): String = when (wall.excluded) {
        "max_level" -> "Already max level"
        "keep_level" -> "Needs Keep ${wall.level.toLong() + 1}"
        "busy" -> "Busy"
        else -> "Unavailable"
    }
    // wall-row.png "Hitpoints each 900 › 1,150": only for a one-level step the catalogue's `hpByTier` states.
    val hp = if (catalogue != null && from != null && to == from + 1)
        levelStats(catalogue, "wall", from)?.rows?.firstOrNull { it.label == "HP" }?.takeIf { it.next != null } else null
    val rows = listOf(StatDeltaUi("layout", "Walls to upgrade", null, "${eligible.size} of ${quote.walls.size}")) +
        listOfNotNull(hp?.let { StatDeltaUi("shield", "Hitpoints each", fmtN(it.current), it.next?.let(::fmtN)) }) +
        listOf(StatDeltaUi("shards", "Balance", null, balance?.let(::fmtN) ?: "…")) +
        listOfNotNull(total?.let { StatDeltaUi("shards", "Row total", null, "${fmtN(it)} Shards") }) +
        quote.walls.filter { it.targetLevel == null }.groupBy(::skipLabel).map { (reason, walls) ->
            StatDeltaUi("shape:lock", reason, null, walls.size.toString()) }
    fun art(level: Int?) = if (level == null || catalogue == null) "shape:unknown" else sheetBuildingPortrait(catalogue, "wall", level)
    return WallRowQuoteUi(quote.walls.map { it.id }, emptySet(), from?.let { "LV $it" } ?: "MIXED",
        to?.let { "LV $it" } ?: "MIXED", art(from), art(to), eligible.size, quote.walls.size - eligible.size, rows,
        PriceUi(Currency.SHARDS, unit?.let(::fmtN), if (unit == null) PriceStatus.UNAVAILABLE else if (unit == "0") PriceStatus.SERVER_ZERO else PriceStatus.OK),
        PriceUi(Currency.SHARDS, total?.let(::fmtN), totalStatus), null, builders, state, shortfall = shortfall,
        reason = reason, wallsStayUp = false, selectionHint = listOfNotNull(message?.takeIf { it.isNotBlank() }, "Upgrade the quoted row. Skipped walls stay unchanged.").joinToString("\n"))
}
