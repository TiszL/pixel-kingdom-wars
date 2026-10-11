package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the pure rules of hub round 2 (design/final/hub/SPEC.md "Round 2 additions" R2.1 Daily Cache, R2.2
 * Founding Kingdoms event, part two Leagues REWARDS / Settings HELP / Feedback MY REPORTS / RIGHT NOW cards, and the
 * critic fixes): the streak tiles, the cache states, the event's activity meters and footer, the EARNING tag, the item
 * legend, the report tags and order, and the RIGHT NOW card cap. No Compose (JVM-tested in HubR2LogicTest).
 */

// ---- R2.1 Daily Cache ----

/** One streak tile's look (R2.1 layout item 3). */
enum class CacheDay {
    /** Green-rimmed `#EEF7D8`, the streak flame + green "Dn". */
    CLAIMED,
    /** Gold 3 dp rim on `#FFF3C8` with the chest; bounces 6 dp once on open. */
    TODAY,
    /** Cream with the chest grey at 45 %. */
    FUTURE,
}

/**
 * The streak tiles for [day] of [days] (1-based). Before today: CLAIMED; today: TODAY, or CLAIMED once [claimedToday];
 * after: FUTURE. Null when [days] is unknown or not positive: the pack constant is missing and the streak row is hidden
 * ("Game content update needed"), never a made-up streak.
 */
fun cacheDays(day: Int, days: Int?, claimedToday: Boolean): List<CacheDay>? {
    if (days == null || days <= 0) return null
    val today = day.coerceIn(1, days)
    return List(days) { i ->
        val d = i + 1
        when {
            d < today -> CacheDay.CLAIMED
            d == today -> if (claimedToday) CacheDay.CLAIMED else CacheDay.TODAY
            else -> CacheDay.FUTURE
        }
    }
}

/** Where the Daily Cache claim stands (R2.1 states). */
enum class CacheState {
    /** Claimable: gold CLAIM with the reward. */
    READY,
    /** First read: reward "…", CLAIM stone with dots. */
    LOADING,
    /** Sent: stone "Claiming" dots. */
    CLAIMING,
    /** The receipt landed (or claimed earlier today): moss "CLAIMED TODAY" disabled + "Next cache in …". */
    CLAIMED,
    /** The result is not known: "Being checked", CLAIM kept as RETRY. */
    CHECKING,
}

/** The CLAIM button's label in each state. */
fun cacheClaimLabel(state: CacheState): String = when (state) {
    CacheState.READY, CacheState.LOADING -> "CLAIM"
    CacheState.CLAIMING -> "Claiming"
    CacheState.CLAIMED -> "CLAIMED TODAY"
    CacheState.CHECKING -> "RETRY"
}

/** The VT 18 line under the claimed primary ("Next cache in 14h 20m"); "…" while the time is unknown. */
fun nextCacheLine(nextIn: String?): String = "Next cache in ${nextIn?.takeIf { it.isNotBlank() } ?: UNKNOWN}"

/** The open-chest frame [elapsedMs] after the receipt: frames 1..3 at 12 fps, then it holds the last one (R2.1 success). */
fun openChestFrame(elapsedMs: Long, frames: Int = 3, fps: Int = 12): Int =
    if (frames <= 0 || fps <= 0) 1 else (elapsedMs.coerceAtLeast(0L) * fps / 1000L).toInt().coerceAtMost(frames - 1) + 1

// ---- R2.2 Founding Kingdoms event ----

/** The campaign's phase (R2.2 `EventPhase`). */
enum class EventPhase { UPCOMING, LIVE, CLOSED }

/** The footer: one gold JOIN THE EVENT only while LIVE and not joined; no footer otherwise (rows are their own doors). */
fun eventShowsJoin(phase: EventPhase, joined: Boolean): Boolean = phase == EventPhase.LIVE && !joined

/** An activity's meter fill (0..1), or null for a row with no bar (its cap is unknown or not positive). */
fun activityFill(count: Int, cap: Int): Float? = if (cap <= 0) null else (count.coerceIn(0, cap).toFloat() / cap)

/** "2/5 · 20 each" (the cap row) or "1/1 · 10" (a once-only row, cap 1). */
fun activityLine(count: Int, cap: Int, pointsEach: String): String {
    val each = pointsEach.ifBlank { UNKNOWN }
    return if (cap == 1) "${count.coerceAtLeast(0)}/1 · $each" else "${count.coerceAtLeast(0)}/$cap · $each each"
}

/** "TODAY 120 / 300" right column; unknown sides read "…". */
fun todayPointsLine(points: String?, cap: String?): String = "${points?.ifBlank { null } ?: UNKNOWN} / ${cap?.ifBlank { null } ?: UNKNOWN}"

// ---- Part two A: Leagues REWARDS ----

/** The payout card's tag: green EARNING, stone NOT YET (below `rewardMinAttackerRaids`), moss PAID after the payout;
 *  null (no tag) when the server has not said. */
fun earningTag(earning: Boolean?, paid: Boolean): StatusLook? = when {
    paid -> StatusLook("PAID", Verb.MOSS, false)
    earning == true -> StatusLook("EARNING", Verb.GREEN, false)
    earning == false -> StatusLook("NOT YET", Verb.STONE, false)
    else -> null
}

/** The item legend under the league rows (critic fix): each distinct item present in the tiers, first seen first. */
fun itemLegend(tierItems: List<List<ItemTileUi>>): List<ItemTileUi> = tierItems.flatten().distinctBy { it.id }

// ---- Part two C: Feedback MY REPORTS ----

/** A report's state (part two C `status`, plus NOT_SENT for a report saved on the phone). */
enum class ReportStatus { SENT, READING, ANSWERED, FIXED, CLOSED, NOT_SENT }

/** The row-end status tag: READING stone, FIXED moss, DONE moss (answered / closed), SENT stone, NOT SENT red. */
fun reportStatusLook(status: ReportStatus): StatusLook = when (status) {
    ReportStatus.SENT -> StatusLook("SENT", Verb.STONE, false)
    ReportStatus.READING -> StatusLook("READING", Verb.STONE, false)
    ReportStatus.ANSWERED, ReportStatus.CLOSED -> StatusLook("DONE", Verb.MOSS, false)
    ReportStatus.FIXED -> StatusLook("FIXED", Verb.MOSS, false)
    ReportStatus.NOT_SENT -> StatusLook("NOT SENT", Verb.RED, false)
}

/** The category tag's face: BUG red, IDEA blue, PAYMENT gold (ink text), anything else stone (OTHER). */
fun reportCategoryVerb(category: String): Verb = when (category.uppercase()) {
    "BUG" -> Verb.RED
    "IDEA" -> Verb.BLUE
    "PAYMENT" -> Verb.GOLD
    else -> Verb.STONE
}

/** MY REPORTS order: a row with an unread reply pops to the top; otherwise the server's newest-first order is kept. */
fun <T> orderReports(rows: List<T>, unread: (T) -> Int): List<T> = rows.sortedBy { if (unread(it) > 0) 0 else 1 }

// ---- Part two D: RIGHT NOW cards ----

/** At most three RIGHT NOW cards (one headline + two halves); nothing becomes a list. */
const val NOW_CARDS_MAX = 3

/** The cards to draw, in the mapper's priority order (claim > returned > auction > idle builder > quest), at most 3. */
fun <T> nowCards(cards: List<T>, max: Int = NOW_CARDS_MAX): List<T> = cards.take(max.coerceAtLeast(0))

/** The art well backdrop of a card (`NowCardUi.artBg`): "sunrays" (a claim) or the card tone `#14121A` (critic fix: the
 *  off-token sea blues are gone). */
enum class NowArtBg { SUNRAYS, CARD }

fun nowArtBg(artBg: String): NowArtBg = if (artBg.equals("sunrays", ignoreCase = true)) NowArtBg.SUNRAYS else NowArtBg.CARD
