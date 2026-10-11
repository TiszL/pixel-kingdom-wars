package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * The pure rules of the buildings cluster (design/final/buildings/SPEC.md §2-§4 and DESIGN CORRECTION 7): what the UPGRADE
 * primary row shows and whether it may send, what a BUILD card tap means, how the tray orders its sections, what PLACE
 * looks like per state, how a drag snaps to tiles, which world markers are drawn, and the one failure sentence.
 * No Compose here; JVM-tested in BuildingsLogicTest. The composables only call these.
 */

/** At most this many "what improves" rows before the "+n more" row (SPEC §2.1). */
const val MAX_STAT_ROWS = 4

/** At most this many world markers on screen, nearest to the camera first (DESIGN-SYSTEM §6, TOKENS `budget`). */
const val MAX_WORLD_MARKERS = PkwTokens.Budget.MAX_WORLD_MARKERS

/** The rows a list shows and how many fold into the "+n more" row. */
data class FoldedRows<T>(val shown: List<T>, val hidden: Int)

/** The first [max] rows, or all of them once [expanded]; the rest are counted for "+n more". */
fun <T> foldRows(rows: List<T>, expanded: Boolean, max: Int = MAX_STAT_ROWS): FoldedRows<T> =
    if (expanded || rows.size <= max) FoldedRows(rows, 0) else FoldedRows(rows.take(max), rows.size - max)

/** True when [price] is a number the server gave and the player can pay (a server zero included). */
fun payablePrice(price: PriceUi): Boolean = when (price.status) {
    PriceStatus.SERVER_ZERO -> true
    PriceStatus.OK -> !price.amount.isNullOrBlank()
    PriceStatus.CHECKING, PriceStatus.UNAVAILABLE, PriceStatus.SHORT -> false
}

/** What the UPGRADE sheet's primary row is. */
enum class UpgradePrimaryKind {
    /** Green UPGRADE + "Uses 1 builder for 4h": the only kind that may send the order. */
    UPGRADE,
    /** Stone + dots while the price is unknown (never a spend at an unknown price). */
    WAIT_PRICE,
    /** Off UPGRADE "needs Shards" + blue GET SHARDS (opens Need-more, never auto-spends). */
    NEED_MORE,
    /** Off UPGRADE "needs a builder" + stone BUILDERS "Free in 2h 14m". */
    NEED_BUILDER,
    /** Stone + dots "Starting…": the request is out. */
    STARTING,
    /** Stone + dots: the answer was lost; the server is being asked whether it started. Never re-sendable. */
    VERIFYING,
    /** Off with a reason (max level, read-only base, price unavailable). */
    OFF,
}

/** The UPGRADE primary row: its [kind], whether a tap may call `onUpgrade`, and the reason line for OFF / VERIFYING. */
data class UpgradePrimaryLook(val kind: UpgradePrimaryKind, val sends: Boolean, val reason: String?)

/**
 * The UPGRADE primary row for a sheet state (SPEC §2.3). ERROR returns to the READY look so the player can try again (the
 * error toast is the OverlayHost's); VERIFYING never does, because the first request may still have gone through.
 */
fun upgradePrimaryLook(state: UpgradeState, price: PriceUi, reason: String?): UpgradePrimaryLook = when (state) {
    UpgradeState.READY, UpgradeState.ERROR -> when {
        payablePrice(price) -> UpgradePrimaryLook(UpgradePrimaryKind.UPGRADE, true, null)
        price.status == PriceStatus.SHORT -> UpgradePrimaryLook(UpgradePrimaryKind.NEED_MORE, false, null)
        price.status == PriceStatus.UNAVAILABLE -> UpgradePrimaryLook(UpgradePrimaryKind.OFF, false, reason ?: PRICE_UNAVAILABLE)
        else -> UpgradePrimaryLook(UpgradePrimaryKind.WAIT_PRICE, false, null)
    }
    UpgradeState.CHECKING -> UpgradePrimaryLook(UpgradePrimaryKind.WAIT_PRICE, false, null)
    UpgradeState.SHORT -> UpgradePrimaryLook(UpgradePrimaryKind.NEED_MORE, false, null)
    UpgradeState.NO_BUILDER -> UpgradePrimaryLook(UpgradePrimaryKind.NEED_BUILDER, false, null)
    UpgradeState.BUSY -> UpgradePrimaryLook(UpgradePrimaryKind.STARTING, false, null)
    UpgradeState.VERIFYING -> UpgradePrimaryLook(UpgradePrimaryKind.VERIFYING, false, reason)
    UpgradeState.MAX -> UpgradePrimaryLook(UpgradePrimaryKind.OFF, false, reason ?: "Already at the highest level")
    UpgradeState.READ_ONLY -> UpgradePrimaryLook(UpgradePrimaryKind.OFF, false, reason ?: "This base is read-only")
}

internal const val PRICE_UNAVAILABLE = "Price unavailable right now"
internal const val SAVED_BUILD_PAYMENT = "Check the saved payment first"
internal const val BUILDING_UNAVAILABLE = "Building unavailable right now"
internal const val UPDATING_BUILD_PRICES = "Updating prices. Try again in a moment."

/** Hero recruitment's own words (the recruitment menu and `HeroRecruitmentRepository` already say these); never new
 *  consent text. The HeroAltarConfirm review stays the only consent for a recruitment. */
internal const val HERO_RECRUIT_UNSUPPORTED = "Hero recruitment is unavailable on this server until recovery support is released. Saved receipts remain available."
internal const val HERO_RECRUIT_OFF = "New hero recruitment is currently unavailable. Saved receipts remain available."
internal const val HERO_RECRUIT_SAVED = "Check the original saved construction before recruiting."
internal const val HERO_RECRUIT_BUSY = "An altar request is already in progress."

/**
 * The one sentence after a failed order (DESIGN CORRECTION 7). Only an [authoritative] refusal (the server answered no)
 * may say nothing was spent; a timeout or lost answer says it is being checked, because the order may have landed.
 */
fun failureLine(action: String, authoritative: Boolean, serverReason: String? = null): String {
    if (!authoritative) return "Checking whether the $action went through."
    val why = serverReason?.trim()?.trimEnd('.')?.takeIf { it.isNotEmpty() }
    return if (why == null) "The $action didn't start. Nothing was spent." else "$why. Nothing was spent."
}

/** What a tap on a BUILD card means (SPEC §3.1). Every tap also reaches `onCard`; this names the route. */
enum class CardTap {
    /** Close the tray and enter placement (AVAILABLE, CHECKING: PLACE waits for the price). */
    PLACE,
    /** Push Need-more over the tray; no placement (SHORT). */
    NEED_MORE,
    /** Scroll the required building's card into view and pulse it (REQUIRES). */
    SHOW_REQUIRED,
    /** Shake, then a toast with GO to the Keep upgrade (LOCKED by Keep level). */
    EXPLAIN_LOCKED,
    /** Toast "All built" + GO to the building (MAX). */
    EXPLAIN_MAX,
    /** Half sheet with the server's reason (UNAVAILABLE). */
    EXPLAIN_UNAVAILABLE,
}

/** The route of a BUILD card tap by its state. */
fun cardTap(state: BuildCardState): CardTap = when (state) {
    BuildCardState.AVAILABLE, BuildCardState.CHECKING -> CardTap.PLACE
    BuildCardState.SHORT -> CardTap.NEED_MORE
    BuildCardState.REQUIRES -> CardTap.SHOW_REQUIRED
    BuildCardState.LOCKED -> CardTap.EXPLAIN_LOCKED
    BuildCardState.MAX -> CardTap.EXPLAIN_MAX
    BuildCardState.UNAVAILABLE -> CardTap.EXPLAIN_UNAVAILABLE
}

/** Short paint-only labels; full reasons remain in card semantics and the live tap explanation. */
internal fun buildCardReasonLabel(card: BuildCardUi): String = when {
    card.state != BuildCardState.UNAVAILABLE -> card.reason ?: gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
    card.reason == PRICE_UNAVAILABLE -> "No price yet"
    card.reason == SAVED_BUILD_PAYMENT -> "Check payment"
    card.reason == BUILDING_UNAVAILABLE -> "Unavailable"
    card.reason == HERO_RECRUIT_UNSUPPORTED || card.reason == HERO_RECRUIT_OFF -> "Unavailable"
    card.reason == HERO_RECRUIT_SAVED -> "Check payment"
    card.reason == HERO_RECRUIT_BUSY -> "Working…"
    else -> card.reason ?: gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
}

/**
 * The cost pill a BUILD card draws, or null when its footer is a state bar instead (REQUIRES, LOCKED, MAX, UNAVAILABLE).
 * A SHORT card's pill is red. CHECKING hides digits except the explicitly held, previously admitted display price (339e7ac0).
 */
fun cardPrice(card: BuildCardUi): PriceUi? = when (card.state) {
    BuildCardState.AVAILABLE -> card.price
    BuildCardState.SHORT -> card.price?.let { if (it.status == PriceStatus.OK) it.copy(status = PriceStatus.SHORT) else it }
    BuildCardState.CHECKING -> card.price?.copy(status = if (card.priceHeld) PriceStatus.OK else PriceStatus.CHECKING)
    BuildCardState.REQUIRES, BuildCardState.LOCKED, BuildCardState.MAX, BuildCardState.UNAVAILABLE -> null
}

/** The tray's sections as drawn (SPEC §3.1 / §3.3): empty sections hidden, a section holding a NEW card first, the
 *  mapper's order otherwise kept. */
fun traySections(sections: List<BuildSectionUi>): List<BuildSectionUi> =
    sections.filter { it.cards.isNotEmpty() }.sortedBy { section -> if (section.cards.any { it.isNew }) 0 else 1 }

/** What a tap on PLACE does. */
enum class PlaceTap { PLACE, NEED_MORE, BUILDERS, NONE }

/** The PLACE button: its face, busy dots, the ink pill under it, its tap, and whether the ghost may still be dragged. */
data class PlaceLook(val verb: Verb, val dots: Boolean, val reason: String?, val tap: PlaceTap, val draggable: Boolean)

/** PLACE per placement state (SPEC §4.3). ERROR returns to the VALID look (the toast is the host's). */
fun placeLook(state: PlacementState, price: PriceUi, reason: String?): PlaceLook = when (state) {
    PlacementState.VALID, PlacementState.ERROR -> when {
        payablePrice(price) -> PlaceLook(Verb.GREEN, false, null, PlaceTap.PLACE, true)
        price.status == PriceStatus.SHORT -> PlaceLook(Verb.OFF, false, null, PlaceTap.NEED_MORE, true)
        price.status == PriceStatus.UNAVAILABLE -> PlaceLook(Verb.OFF, false, reason ?: PRICE_UNAVAILABLE, PlaceTap.NONE, true)
        else -> PlaceLook(Verb.STONE, true, null, PlaceTap.NONE, true)
    }
    PlacementState.BLOCKED -> PlaceLook(Verb.OFF, false, reason ?: "Spot is blocked", PlaceTap.NONE, true)
    PlacementState.CHECKING_PRICE -> PlaceLook(Verb.STONE, true, null, PlaceTap.NONE, true)
    PlacementState.SHORT -> PlaceLook(Verb.OFF, false, null, PlaceTap.NEED_MORE, true)
    PlacementState.NO_BUILDER -> PlaceLook(Verb.OFF, false, reason ?: "No free builder", PlaceTap.BUILDERS, true)
    PlacementState.SENDING -> PlaceLook(Verb.STONE, true, null, PlaceTap.NONE, false)
    PlacementState.VERIFYING -> PlaceLook(Verb.STONE, true, reason ?: "Checking with the server", PlaceTap.NONE, false)
}

/** Whether the placement plate keeps its timer group (hourglass + build time). NO_BUILDER drops it: the plate turns
 *  "free in 2h 14m" (SPEC §4.3) and that line takes the whole row, so it is never cut to "free …" on a phone. The build
 *  time stays in the plate's spoken line and returns with a free builder. */
fun placementPlateShowsTime(state: PlacementState): Boolean = state != PlacementState.NO_BUILDER

/** The placement hint pill (SPEC §4.1): the mapper's [hint] wins; otherwise the state's default line. */
fun placementHint(state: PlacementState, hint: String?): String = hint ?: when (state) {
    PlacementState.BLOCKED -> "Red tiles are taken. Drag it clear."
    else -> "Drag to move · PLACE when green"
}

/** How many whole tiles (x, y) a drag of ([dx], [dy]) px moves the ghost, snapping to the nearest tile. */
fun tileStep(dx: Float, dy: Float, tilePx: Float): Pair<Int, Int> {
    if (tilePx <= 0f) return 0 to 0
    return (dx / tilePx).roundToInt() to (dy / tilePx).roundToInt()
}

/** The world markers drawn: at most [max], nearest the screen centre ([centerX], [centerY]) first; none while hidden. */
fun visibleMarkers(markers: List<BuildingMarkerUi>, centerX: Float, centerY: Float, max: Int = MAX_WORLD_MARKERS): List<BuildingMarkerUi> =
    markers.sortedBy { distanceSq(it.anchor, centerX, centerY) }.take(max.coerceAtLeast(0))

private fun distanceSq(rect: PxRect, x: Float, y: Float): Float {
    val dx = rect.centerX - x; val dy = (rect.top + rect.bottom) / 2f - y
    return dx * dx + dy * dy
}
