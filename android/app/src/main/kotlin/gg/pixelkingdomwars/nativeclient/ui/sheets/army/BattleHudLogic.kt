package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN

/*
 * Design component: the pure rules of the in-battle HUD (design/final/army/SPEC.md §6A, battle-hud.png): the clock's
 * label and warning look, the destruction figure and meter, the deck card's count text and where a card tap goes, and
 * END versus LEAVE. No Compose; JVM-tested in `BattleHudLogicTest`. The server decides damage, stars and loot; these only
 * format what it said.
 */

/** The battle clock's phase (SPEC §6A.3). */
enum class ClockPhase {
    /** Before the first troop lands: "starts" with the scout countdown. */
    SCOUT,
    /** The fight: "ends in". */
    FIGHT,
    /** Under 0:30: the numerals turn danger and the plate pulses once a second (reduced motion: colour only). */
    LAST_30,
}

/** How the clock plate draws. */
data class ClockLook(val label: String, val danger: Boolean, val pulse: Boolean)

fun clockLook(phase: ClockPhase, reducedMotion: Boolean): ClockLook = when (phase) {
    ClockPhase.SCOUT -> ClockLook("starts", danger = false, pulse = false)
    ClockPhase.FIGHT -> ClockLook("ends in", danger = false, pulse = false)
    ClockPhase.LAST_30 -> ClockLook("ends in", danger = true, pulse = !reducedMotion)
}

/** "0%".."100%", or "…%" before the server has said (never a made-up 0). */
fun destructionText(pct: Int?): String = if (pct == null) "$UNKNOWN%" else "${pct.coerceIn(0, 100)}%"

/** The meter's fill, 0..1; null (unknown) draws an empty track that says so. */
fun destructionFraction(pct: Int?): Float? = pct?.coerceIn(0, 100)?.div(100f)

/** Stars lit, 0..3 (unknown lights none). */
fun starsLit(stars: Int?): Int = (stars ?: 0).coerceIn(0, 3)

/** The line under a deck card's portrait: "x5", "x0", "x…" while unknown; the hero reads "HERO" until sent, then
 *  "SKILL" when its ability is ready or the time until it is ("12s"). */
fun deckCountText(count: Int?, isHero: Boolean, heroSent: Boolean = false, abilityReadyIn: String? = null): String = when {
    isHero && !heroSent -> "HERO"
    isHero -> abilityReadyIn ?: "SKILL"
    count == null -> "x$UNKNOWN"
    else -> "x${count.coerceAtLeast(0)}"
}

/** A card that has nothing left to send (it stays in place, greyed, so the row never shifts). */
fun deckCardUsedUp(count: Int?, isHero: Boolean): Boolean = !isHero && count == 0

/** Where a deck card tap goes. */
enum class DeckTap { SELECT, ABILITY, NONE }

/**
 * Tap routing for a deck card: a troop with some left (or an unknown count: the server re-checks every deploy) is
 * selected; a used-up troop does nothing; the hero is selected until sent, then the card is its ability button and acts
 * only when the ability is ready ([abilityReadyIn] null).
 */
fun deckCardTap(count: Int?, isHero: Boolean, heroSent: Boolean, abilityReadyIn: String?): DeckTap = when {
    isHero && !heroSent -> DeckTap.SELECT
    isHero -> if (abilityReadyIn == null) DeckTap.ABILITY else DeckTap.NONE
    count == 0 -> DeckTap.NONE
    else -> DeckTap.SELECT
}

/** END before any troop is sent reads LEAVE and needs no confirm (nothing has been committed); after, END asks first. */
enum class EndRoute { LEAVE, CONFIRM }

fun endRoute(canLeaveFree: Boolean): EndRoute = if (canLeaveFree) EndRoute.LEAVE else EndRoute.CONFIRM
fun endLabel(canLeaveFree: Boolean): String = if (canLeaveFree) "LEAVE" else "END"

/** More than six cards scroll sideways (peek 22 dp) instead of shrinking under the 62 dp card. */
const val DECK_VISIBLE_CARDS = 6
fun deckScrolls(cards: Int): Boolean = cards > DECK_VISIBLE_CARDS
