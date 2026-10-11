package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.outcomeLine
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: the pure rules of the map and islands cluster (design/final/map/SPEC.md §1-§6 and
 * design/final/account/SPEC.md §6.2-§6.3): map modes, rail order, island-scene clustering and hit testing, the spot tag
 * and cluster face grammar, the spot sheet and licence sheet layouts, the Reach unlock layout, and the seal /
 * celebration builders the OverlayHost raises.
 *
 * No Compose here (JVM-tested in app/src/test/kotlin/.../ui/sheets/map/MapLogicTest.kt). Money rule: nothing here
 * computes an amount; every amount is a string from the data lane, carried through untouched.
 */

// ---- Shared enums ----

/** The map's mode (SPEC §1.3 ModeButton). */
enum class MapMode { EXPLORE, WARZONE, KINGDOMS }

/** Which island scene (SPEC §3, §4). */
enum class IslandKind { SEEKER, SOLANA }

/** A spot sprite's look (SPEC §3.3: `seeker-site-{look}`, `solana-workshop-{look}`). */
enum class SpotLook { AVAILABLE, OCCUPIED, ACTIVE, EXPIRED }

/** The player's own relation to a spot (SPEC §3.2 `SpotMarkerUi.mine`). */
enum class MineState { NONE, LEADING, OUTBID, OPERATING }

/** A cluster bubble's face (SPEC §3.2 table, priority 1-4). */
enum class ClusterFace { RED, GREEN, CREAM, STONE }

/** The island bottom-row filters; they double as the legend (SPEC §3.2, §4.1). */
enum class SpotFilter { ALL, MINE, BIDS, KING, PUBLIC }

/** Where the Seeker auction stands (SPEC §3.1). Null in a Ui means "still loading". */
enum class AuctionPhase { OPEN, OPENS_AT, OPERATING, SERVER_OFF }

/** One Solana workshop licence's state (SPEC §4 licence-state table). */
enum class LicenceState { NONE, OPEN, DRAWN, MINE, OCCUPIED }

/** A trip to an archipelago island (SPEC §6 `TripRowUi.state`; named apart from the voyage cluster's `TripState`). */
enum class ExpeditionState { UNDER_WAY, RETURNED }

/** A Solana Reach tile unlock (account SPEC §6.2 `ReachTileUiState.status`). */
enum class ReachStatus { AVAILABLE, UNLOCKED_BY_ME, UNLOCKED_BY_OTHER, CLAIMED, OFF }

/** A Solana Reach tile's allocation (account SPEC §6.2). */
enum class ReachAllocation { SEEKER, GENESIS, ORDINARY }

// ---- Map HUD ----

/** The ModeButton cycles EXPLORE › WARZONE › KINGDOMS › EXPLORE (SPEC §1.3). */
fun nextMode(mode: MapMode): MapMode = MapMode.entries[(mode.ordinal + 1) % MapMode.entries.size]

/** The ModeButton's icon (SPEC §1.3 table). */
fun modeIcon(mode: MapMode): String = when (mode) {
    MapMode.EXPLORE -> "ui:lodge-menu"
    MapMode.WARZONE -> "attack"
    MapMode.KINGDOMS -> "ui_portrait_keep_t2"
}

/** The rail ids of the three special islands, in the owner's priority order (SPEC §10 row 2). */
val SPECIAL_ISLAND_IDS: List<String> = listOf("seeker", "solana", "divine")

/**
 * The rail order (SPEC §1.4, §10 row 2): Seeker, Solana, Divine first, then every other tile (the realms) in the order the
 * caller gave (REALM_IDS order). Returns the ordered ids and the index the 4 dp divider follows (-1 when there is none).
 */
fun <T> orderRail(tiles: List<T>, id: (T) -> String): Pair<List<T>, Int> {
    val islands = SPECIAL_ISLAND_IDS.mapNotNull { want -> tiles.firstOrNull { id(it) == want } }
    val realms = tiles.filter { id(it) !in SPECIAL_ISLAND_IDS }
    val divider = if (islands.isNotEmpty() && realms.isNotEmpty()) islands.size - 1 else -1
    return (islands + realms) to divider
}

/** At most [PkwTokens.Budget.MAX_WORLD_MARKERS] trip markers, the caller's nearest-first order, on-screen ones only. */
fun <T> capMarkers(markers: List<T>, onScreen: (T) -> Boolean): List<T> =
    markers.filter(onScreen).take(PkwTokens.Budget.MAX_WORLD_MARKERS)

// ---- Island scene: zoom, clustering, hit testing ----

/** The design's minimum touch target (TOKENS.json `size.minTap`, = `PkwTokens.Dims.minTap`), as a plain number so this
 *  file stays free of Compose types. */
const val MIN_TAP_DP = 48f

/** A point on the island art, in art pixels (the IS-A2 layout list's unit). */
data class IslandPoint(val x: Float, val y: Float)

/** Device pixels per art pixel at a zoom level (SPEC §3.2: Z0 = art / 2, Z1 = art / 1, Z2 = 2 px per art px). */
fun levelScale(zoom: Int): Float = when (zoom.coerceIn(0, 2)) {
    0 -> 0.5f
    1 -> 1f
    else -> 2f
}

/** The whole-number sprite scale at a zoom level (64 art px → 64 device px at Z1, 128 at Z2; Z0 draws clusters). */
fun spriteScale(zoom: Int): Int = if (zoom >= 2) 2 else 1

/** The minimum spacing below which spots merge into one ClusterBubble: always at Z0 (two bubbles wide), closer than
 *  48 dp at Z1, never at Z2 (SPEC §3.2). */
fun clusterSpacingDp(zoom: Int): Float? = when (zoom.coerceIn(0, 2)) {
    0 -> 104f
    1 -> 48f
    else -> null
}

/** One spot as the clustering sees it: number, King class, look, own state, licence and its art-space anchor. */
data class SpotGeom(val no: Int, val king: Boolean, val look: SpotLook, val mine: MineState, val at: IslandPoint,
    val licence: LicenceState? = null)

/** One ClusterBubble: its members (spot numbers, ascending), centre (art px), face and King crown pip. */
data class SpotCluster(val members: List<Int>, val at: IslandPoint, val face: ClusterFace, val king: Boolean)

/** True when a spot is blocked for the cluster face: expired on Seeker; expired or held by another kingdom on Solana. */
fun spotBlocked(island: IslandKind, spot: SpotGeom): Boolean = spot.look == SpotLook.EXPIRED ||
    (island == IslandKind.SOLANA && (spot.licence == LicenceState.OCCUPIED || spot.look == SpotLook.OCCUPIED))

/**
 * A cluster's face (SPEC §3.2): red when it holds one of your outbid bids, green when it holds one of yours (leading or
 * operating, or a Solana licence you hold), stone when every spot inside is blocked, cream otherwise (open).
 */
fun clusterFace(island: IslandKind, members: List<SpotGeom>): ClusterFace = when {
    members.any { it.mine == MineState.OUTBID } -> ClusterFace.RED
    members.any { it.mine == MineState.LEADING || it.mine == MineState.OPERATING || it.licence == LicenceState.MINE } -> ClusterFace.GREEN
    members.isNotEmpty() && members.all { spotBlocked(island, it) } -> ClusterFace.STONE
    else -> ClusterFace.CREAM
}

/**
 * Groups spots into ClusterBubbles at [zoom] (SPEC §3.2). Greedy and deterministic: spots are taken in number order and
 * each joins the first cluster whose seed spot is closer than the level's spacing on screen (dp = art px × device px
 * per art px ÷ [density]); otherwise it seeds a new cluster. The centre is the members' mean. At Z2 every spot stands
 * alone. A single-member cluster at Z1 draws as its sprite, not a bubble.
 */
fun clusterSpots(island: IslandKind, spots: List<SpotGeom>, zoom: Int, density: Float): List<SpotCluster> {
    val spacing = clusterSpacingDp(zoom)
    val sorted = spots.sortedBy { it.no }
    if (spacing == null) return sorted.map { SpotCluster(listOf(it.no), it.at, clusterFace(island, listOf(it)), it.king) }
    val dpPerArt = levelScale(zoom) / density.coerceAtLeast(0.1f)
    val limit = spacing / dpPerArt // in art px
    val seeds = ArrayList<SpotGeom>()
    val groups = ArrayList<MutableList<SpotGeom>>()
    for (s in sorted) {
        val i = seeds.indexOfFirst { seed -> dist(seed.at, s.at) < limit }
        if (i < 0) { seeds.add(s); groups.add(mutableListOf(s)) } else groups[i].add(s)
    }
    return groups.map { g ->
        val cx = g.sumOf { it.at.x.toDouble() } / g.size
        val cy = g.sumOf { it.at.y.toDouble() } / g.size
        SpotCluster(g.map { it.no }, IslandPoint(cx.toFloat(), cy.toFloat()), clusterFace(island, g), g.any { it.king })
    }
}

private fun dist(a: IslandPoint, b: IslandPoint): Float {
    val dx = a.x - b.x; val dy = a.y - b.y
    return kotlin.math.sqrt(dx * dx + dy * dy)
}

/** How the island art sits in the overlay: [scale] device px per art px, [tx] / [ty] the device-px position of the
 *  art's origin. Owned by the island scene (pan / pinch); the overlay only reads it. */
data class IslandCamera(val scale: Float, val tx: Float, val ty: Float) {
    fun screenX(artX: Float): Float = tx + artX * scale
    fun screenY(artY: Float): Float = ty + artY * scale
}

/** What a tap on the island scene hit (SPEC §3.3: hit area ≥ 48 dp, several hits pick the nearest centre). */
sealed interface IslandTap {
    data class Spot(val no: Int) : IslandTap
    data class Cluster(val members: List<Int>, val at: IslandPoint) : IslandTap
    data object PublicWorkshop : IslandTap
}

/** One tappable thing on the island, at its visual centre (art px). */
data class IslandTarget(val tap: IslandTap, val centre: IslandPoint)

/**
 * The island scene's tap rule (pointer rule: the overlay's markers are paint only, so the scene's own tap handler calls
 * this). The nearest target whose visual centre is within 24 dp (the 48 dp hit square's half) wins; null when none is.
 */
fun pickIslandTarget(targets: List<IslandTarget>, camera: IslandCamera, density: Float, tapXPx: Float, tapYPx: Float): IslandTap? {
    val radius = MIN_TAP_DP / 2f * density
    var best: IslandTap? = null
    var bestD = Float.MAX_VALUE
    for (t in targets) {
        val dx = camera.screenX(t.centre.x) - tapXPx
        val dy = camera.screenY(t.centre.y) - tapYPx
        val d = kotlin.math.sqrt(dx * dx + dy * dy)
        if (d <= radius && d < bestD) { best = t.tap; bestD = d }
    }
    return best
}

/** True when a spot passes the island filter (D-191 grammar: non-matching spots are hidden, never dimmed; the selected
 *  one always draws). */
fun spotPasses(filter: SpotFilter, spot: SpotGeom, selected: Int?): Boolean = spot.no == selected || when (filter) {
    SpotFilter.ALL -> true
    SpotFilter.MINE -> spot.mine == MineState.LEADING || spot.mine == MineState.OPERATING || spot.licence == LicenceState.MINE
    SpotFilter.BIDS -> spot.mine == MineState.LEADING || spot.mine == MineState.OUTBID
    SpotFilter.KING -> spot.king
    SpotFilter.PUBLIC -> false
}

/** The filters an island's bottom row offers (SPEC §3.2: ALL · MINE · BIDS · KING; §4.1 Solana: ALL · MINE · PUBLIC). */
fun islandFilters(island: IslandKind): List<SpotFilter> = when (island) {
    IslandKind.SEEKER -> listOf(SpotFilter.ALL, SpotFilter.MINE, SpotFilter.BIDS, SpotFilter.KING)
    IslandKind.SOLANA -> listOf(SpotFilter.ALL, SpotFilter.MINE, SpotFilter.PUBLIC)
}

/** A filter's chip label. */
fun filterLabel(filter: SpotFilter): String = filter.name

/** A filter count as the server gave it; a missing count is "…", never 0. */
fun filterCount(counts: Map<SpotFilter, String>, filter: SpotFilter): String = counts[filter]?.takeIf { it.isNotBlank() } ?: UNKNOWN

/** The visible dot verbs of a filter chip (BIDS is half green / half red; KING and PUBLIC gold; MINE green). */
fun filterDots(filter: SpotFilter): List<Verb> = when (filter) {
    SpotFilter.ALL -> emptyList()
    SpotFilter.MINE -> listOf(Verb.GREEN)
    SpotFilter.BIDS -> listOf(Verb.GREEN, Verb.RED)
    SpotFilter.KING, SpotFilter.PUBLIC -> listOf(Verb.GOLD)
}

/** The "No spots in MINE yet · ALL" pill line (SPEC §3.2 Empty filter). */
fun emptyFilterLine(filter: SpotFilter): String = "No spots in ${filterLabel(filter)} yet"

// ---- Spot tags (SPEC §3.3 SpotTag; §4 licence world tags) ----

/** A SpotTag's look: the text, its face verb (null = veil), and the King crown pip before the number. */
data class SpotTagLook(val text: String, val verb: Verb?, val crown: Boolean)

/**
 * The tag under a spot sprite, or null when it is not shown. At Z1 only your spots and King spots carry a tag; at Z2 all
 * do (SPEC §3.3). Your states: green "12 LEAD", red "42 OUTBID", gold "YOURS" (operating). Solana: gold "YOURS" (a licence
 * you hold), stone "n OCCUPIED", blue "DRAWN", otherwise the number.
 */
fun spotTag(spot: SpotGeom, zoom: Int): SpotTagLook? {
    val mine = spot.mine != MineState.NONE || spot.licence == LicenceState.MINE
    if (zoom <= 0) return null
    if (zoom == 1 && !mine && !spot.king) return null
    val n = spot.no.toString()
    return when {
        spot.licence == LicenceState.MINE -> SpotTagLook("YOURS", Verb.GOLD, spot.king)
        spot.licence == LicenceState.OCCUPIED -> SpotTagLook("$n OCCUPIED", Verb.STONE, spot.king)
        spot.licence == LicenceState.DRAWN -> SpotTagLook("$n DRAWN", Verb.BLUE, spot.king)
        spot.mine == MineState.LEADING -> SpotTagLook("$n LEAD", Verb.GREEN, spot.king)
        spot.mine == MineState.OUTBID -> SpotTagLook("$n OUTBID", Verb.RED, spot.king)
        spot.mine == MineState.OPERATING -> SpotTagLook("YOURS", Verb.GOLD, spot.king)
        else -> SpotTagLook(n, null, spot.king)
    }
}

/** What a screen reader says for a spot marker. */
fun spotDescription(island: IslandKind, spot: SpotGeom): String {
    val what = if (island == IslandKind.SEEKER) "Spot" else "Workshop"
    val parts = mutableListOf("$what ${spot.no}")
    if (spot.king) parts += "King"
    when (spot.mine) {
        MineState.LEADING -> parts += "you lead"
        MineState.OUTBID -> parts += "you were outbid"
        MineState.OPERATING -> parts += "yours"
        MineState.NONE -> Unit
    }
    when (spot.licence) {
        LicenceState.MINE -> parts += "your licence"
        LicenceState.OCCUPIED -> parts += "held by another kingdom"
        LicenceState.DRAWN -> parts += "drawn"
        LicenceState.OPEN -> parts += "entries open"
        LicenceState.NONE, null -> Unit
    }
    if (spot.look == SpotLook.EXPIRED) parts += "blocked this term"
    return parts.joinToString(", ")
}

// ---- Countdown chip (SPEC §3.2 CountdownChip, §4.1) ----

/** The CountdownChip copy: icon, VT label and the gold-hi time (null = none). */
data class CountdownCopy(val icon: String, val label: String, val time: String?)

/**
 * The island's CountdownChip, or null when a banner replaces it (Seeker SERVER_OFF). A null [time] while a timer is due
 * reads "…" (loading), never a made-up time. Solana with no draw (NONE) or after a draw never invents a countdown.
 */
fun countdownCopy(island: IslandKind, phase: AuctionPhase?, licence: LicenceState?, time: String?): CountdownCopy? = when (island) {
    IslandKind.SEEKER -> when (phase) {
        null -> CountdownCopy("timer", "Bids close in", UNKNOWN)
        AuctionPhase.OPEN -> CountdownCopy("timer", "Bids close in", time ?: UNKNOWN)
        AuctionPhase.OPENS_AT -> CountdownCopy("timer", "Bidding opens", time ?: UNKNOWN)
        AuctionPhase.OPERATING -> CountdownCopy("timer", "Operating · next auction in", time ?: UNKNOWN)
        AuctionPhase.SERVER_OFF -> null
    }
    IslandKind.SOLANA -> when (licence) {
        LicenceState.OPEN -> CountdownCopy("timer", "Draw closes in", time ?: UNKNOWN)
        LicenceState.DRAWN, LicenceState.MINE, LicenceState.OCCUPIED -> CountdownCopy("ui:queue-status", "Next draw opens later", null)
        LicenceState.NONE, null -> CountdownCopy("ui:queue-status", "Licence draw opens later", null)
    }
}

// ---- Seeker panel (SPEC §3.1) ----

/** An alert row's kind, in priority order (outbid > won-unclaimed > ready-to-claim). */
enum class AlertKind { OUTBID, WON_UNCLAIMED, READY_TO_CLAIM }

/** The alert rows the panel shows: priority order, at most two (SPEC §3.1). */
fun <T> topAlerts(alerts: List<T>, kind: (T) -> AlertKind): List<T> = alerts.sortedBy { kind(it).ordinal }.take(2)

/** The state card's headline (SPEC §3.1): "…" while loading; never the word LIVE. */
fun phaseHeadline(phase: AuctionPhase?): String = when (phase) {
    null -> UNKNOWN
    AuctionPhase.OPEN -> "BIDDING OPEN"
    AuctionPhase.OPENS_AT -> "BIDDING OPENS"
    AuctionPhase.OPERATING -> "OPERATING"
    AuctionPhase.SERVER_OFF -> "Not open on this server yet"
}

// ---- Spot sheet (SPEC §3.4-§3.7) ----

/** The spot sheet's one primary (or none). */
enum class SpotPrimary { NONE, CHECKING, LOCKED_OPENS, BID, CLAIM, PERMIT }

/** What the spot sheet draws, from the auction state alone (no amounts). */
data class SpotLayout(
    val bidCards: Boolean,
    val heldRow: Boolean,
    val stepper: Boolean,
    val claimTiles: Boolean,
    val primary: SpotPrimary,
    val footnote: Boolean,
    val offLine: Boolean,
)

/**
 * The spot sheet layout (SPEC §3.4 states, §3.5, §3.7, arch §5.3 table):
 * - loading: bid cards with "…" and a stone CHECKING primary;
 * - SERVER_OFF: no stepper and no primary, only "Auctions are not open on this server yet" (hidden, not disabled);
 * - NOT_OPEN (auctions on, bidding not yet open): bid cards + the locked "OPENS …" primary;
 * - LIVE / YOU_LEAD: bid cards + stepper (BID / raise); OUTBID: the held row + stepper (RAISE TO);
 * - KING (yours, operating): READY TO CLAIM tiles + CLAIM;
 * - CLOSED: no stepper, no primary; an operating spot of another kingdom with a permit command: BUY REALM PERMIT.
 */
fun spotLayout(state: SpotState, phase: AuctionPhase?, loading: Boolean, hasPermit: Boolean): SpotLayout {
    if (phase == AuctionPhase.SERVER_OFF) return SpotLayout(false, false, false, false, SpotPrimary.NONE, false, true)
    if (loading || phase == null) return SpotLayout(true, false, false, false, SpotPrimary.CHECKING, false, false)
    return when (state) {
        SpotState.NOT_OPEN -> SpotLayout(true, false, false, false, SpotPrimary.LOCKED_OPENS, true, false)
        SpotState.LIVE, SpotState.YOU_LEAD -> SpotLayout(true, false, true, false, SpotPrimary.BID, true, false)
        SpotState.OUTBID -> SpotLayout(false, true, true, false, SpotPrimary.BID, true, false)
        SpotState.KING -> SpotLayout(false, false, false, true, SpotPrimary.CLAIM, false, false)
        SpotState.CLOSED, SpotState.LICENCE_LATER ->
            SpotLayout(false, false, false, false, if (hasPermit) SpotPrimary.PERMIT else SpotPrimary.NONE, false, false)
    }
}

/** One head tag: text and face verb. */
data class HeadTag(val text: String, val verb: Verb)

/**
 * The spot sheet's head tags (SPEC §3.4 head row, §3.5, §3.7): gold "KING" for a King-class spot; then the state tag
 * with the countdown. On fixture data ([testData]) the word LIVE never appears: the countdown becomes a stone timer
 * and a stone "TEST DATA" tag is added.
 */
fun spotHeadTags(kingClass: Boolean, state: SpotState, countdown: String?, term: String?, testData: Boolean,
    phase: AuctionPhase?): List<HeadTag> {
    val tags = mutableListOf<HeadTag>()
    if (kingClass) tags += HeadTag("KING", Verb.GOLD)
    if (phase == AuctionPhase.SERVER_OFF) { if (testData) tags += HeadTag("TEST DATA", Verb.STONE); return tags }
    val time = countdown?.takeIf { it.isNotBlank() }
    when (state) {
        SpotState.LIVE -> tags += if (testData) HeadTag(time ?: UNKNOWN, Verb.STONE) else HeadTag("LIVE ${time ?: UNKNOWN}", Verb.RED)
        SpotState.YOU_LEAD -> { tags += HeadTag("YOU LEAD", Verb.GREEN); tags += HeadTag(time ?: UNKNOWN, if (testData) Verb.STONE else Verb.RED) }
        SpotState.OUTBID -> { tags += HeadTag("OUTBID", Verb.RED); tags += HeadTag(time ?: UNKNOWN, if (testData) Verb.STONE else Verb.RED) }
        SpotState.KING -> { tags += HeadTag("YOURS", Verb.GREEN); if (term != null) tags += HeadTag(term, Verb.STONE) }
        SpotState.CLOSED -> tags += HeadTag("BLOCKED THIS TERM", Verb.STONE)
        SpotState.NOT_OPEN -> tags += HeadTag("NOT OPEN YET", Verb.STONE)
        SpotState.LICENCE_LATER -> tags += HeadTag("NO LICENCE YET", Verb.STONE)
    }
    if (testData) tags += HeadTag("TEST DATA", Verb.STONE)
    return tags
}

/** A spot's top bidder as a game name (CRITIC §2.2): a kingdom name, or "a Seeker player" for a wallet with no
 *  kingdom; never a wallet string. Null bidder = nobody yet. */
fun bidderName(kingdomName: String?): String = kingdomName?.trim()?.takeIf { it.isNotEmpty() } ?: "a Seeker player"

/**
 * The line under a failed money action (design correction 7): only an [authoritative] refusal may say nothing was spent;
 * an uncertain result says it is being checked (the caller keeps the recovery action). Null when nothing failed.
 */
fun moneyNote(failed: Boolean, action: String, authoritative: Boolean, serverReason: String? = null): String? =
    if (!failed) null else outcomeLine(action, authoritative, serverReason)

// ---- Solana licence draw (SPEC §4) ----

/** The four licence steps of the `draw_steps` strip. */
val LICENCE_STEPS: List<LicenceState> = listOf(LicenceState.OPEN, LicenceState.DRAWN, LicenceState.MINE, LicenceState.OCCUPIED)

/** The lit step of the strip (null = none lit: no draw yet, the strip is the explainer). */
fun litLicenceStep(state: LicenceState?): LicenceState? = state?.takeIf { it != LicenceState.NONE }

/** The licence sheet's primary. */
enum class LicencePrimary { LOCKED, ENTER, ENTERED, CLAIM, NONE }

/** The licence sheet's primary and its reason line (SPEC §4 table, §4.2, §4.3). A server-off sheet shows the same as
 *  NONE; no countdown is invented. */
data class LicenceAction(val primary: LicencePrimary, val reason: String?)

fun licenceAction(state: LicenceState?, yourEntry: Boolean?, closesIn: String?, hasClaim: Boolean): LicenceAction = when (state) {
    null, LicenceState.NONE -> LicenceAction(LicencePrimary.LOCKED, "Licence draw opens later")
    LicenceState.OPEN -> if (yourEntry == true) LicenceAction(LicencePrimary.ENTERED, "Drawn in ${closesIn ?: UNKNOWN}")
        else LicenceAction(LicencePrimary.ENTER, null)
    LicenceState.DRAWN -> LicenceAction(LicencePrimary.NONE, null)
    LicenceState.MINE -> if (hasClaim) LicenceAction(LicencePrimary.CLAIM, null) else LicenceAction(LicencePrimary.NONE, null)
    LicenceState.OCCUPIED -> LicenceAction(LicencePrimary.LOCKED, "Next draw opens later")
}

/** The head tag of a workshop sheet (SPEC §4 table). */
fun licenceHeadTag(state: LicenceState?, testData: Boolean): HeadTag = when (state) {
    null, LicenceState.NONE -> HeadTag("NO LICENCE YET", Verb.STONE)
    LicenceState.OPEN -> HeadTag("ENTRIES OPEN", Verb.GREEN)
    LicenceState.DRAWN -> HeadTag("DRAWN", Verb.BLUE)
    LicenceState.MINE -> HeadTag("YOURS", Verb.GOLD)
    LicenceState.OCCUPIED -> HeadTag("OCCUPIED", Verb.STONE)
}.let { if (testData && it.text == "ENTRIES OPEN") it.copy(verb = Verb.STONE) else it }

// ---- Archipelago (SPEC §6) ----

/** The archipelago SEND row: what the primary is. */
enum class ArchipelagoPrimary { SEND, BUILD_LODGE, NONE }

/** No Lodge → green BUILD A LODGE (GO TO LODGE hidden); an unknown route → no SEND (name only + Report). */
fun archipelagoPrimary(hasLodge: Boolean, routeKnown: Boolean): ArchipelagoPrimary = when {
    !routeKnown -> ArchipelagoPrimary.NONE
    !hasLodge -> ArchipelagoPrimary.BUILD_LODGE
    else -> ArchipelagoPrimary.SEND
}

/** "GRADE 2" / "TIER 2+" tags; unknown reads "…", never 0. */
fun gradeTag(grade: Int?): String = "GRADE ${grade?.takeIf { it > 0 }?.toString() ?: UNKNOWN}"
fun tierTag(minTier: Int?): String = "TIER ${minTier?.takeIf { it > 0 }?.let { "$it+" } ?: UNKNOWN}"

// ---- Solana Reach tile unlock (account SPEC §6.2-§6.3) ----

/** The Reach sheet's foot. */
enum class ReachPrimary { UNLOCK, GET_SKR, GET_LAND, BUY_BASE, NONE }

/** What the Reach half sheet shows: the primary, and whether the INFO button and the value cards draw. */
data class ReachLayout(val primary: ReachPrimary, val info: Boolean, val cards: Boolean, val line: String?)

/**
 * Account SPEC §6.2 states: feature off → "Seeker tiles are not open on this server yet", no buttons (hidden, not
 * disabled); held by another wallet → "Held by another kingdom", no primary; unlocked by me → BUY BASE HERE; no deed →
 * blue GET LAND (checked before SKR: a deed is the gate); short of SKR → blue GET SKR; otherwise gold UNLOCK TILE. An
 * unknown deed / balance (null) still offers UNLOCK: the server decides at the seal.
 */
fun reachLayout(status: ReachStatus, hasDeed: Boolean?, short: Boolean): ReachLayout = when (status) {
    ReachStatus.OFF -> ReachLayout(ReachPrimary.NONE, false, false, "Seeker tiles are not open on this server yet")
    ReachStatus.UNLOCKED_BY_OTHER, ReachStatus.CLAIMED -> ReachLayout(ReachPrimary.NONE, true, false, "Held by another kingdom")
    ReachStatus.UNLOCKED_BY_ME -> ReachLayout(ReachPrimary.BUY_BASE, true, false, "This tile is held for you. Buy the base on it whenever you are ready.")
    ReachStatus.AVAILABLE -> when {
        hasDeed == false -> ReachLayout(ReachPrimary.GET_LAND, true, true, null)
        short -> ReachLayout(ReachPrimary.GET_SKR, true, true, null)
        else -> ReachLayout(ReachPrimary.UNLOCK, true, true, null)
    }
}

/** A price is short only when the data lane says so (SHORT); the UI never compares amounts. */
fun isShort(vararg prices: PriceUi?): Boolean = prices.any { it?.status == PriceStatus.SHORT }

// ---- Seals and celebrations the OverlayHost raises (no amounts computed: the PriceUi is the data lane's) ----

/** What happens to a bid (K-night-A4, provisional wording 2026-10-10, owner's final wording pending): the economy program
 *  holds it until the auction ends, and an outbid player takes it back with WithdrawBid. Nothing returns it on its own. */
const val SEEKER_BID_HELD_LINE = "Held until the auction ends. If you are outbid, tap WITHDRAW to take it back."

/** The bid seal (SPEC §3.6): "BID ON SPOT 7", SKR → the spot. [raise] words it as a raise. */
fun bidSealUi(spotNo: Int, amount: PriceUi, raise: Boolean, armedAtMs: Long, testData: Boolean): SealUi = SealUi(
    title = if (raise) "RAISE ON SPOT $spotNo" else "BID ON SPOT $spotNo",
    lines = listOfNotNull(
        SEEKER_BID_HELD_LINE,
        "Paid from your wallet. You sign once.",
        "Test data: not a real bid.".takeIf { testData }),
    price = amount, confirmLabel = if (raise) "RAISE" else "BID", armedAtMs = armedAtMs)

/** The withdraw seal (SPEC §3.5): "Return 120 SKR to your wallet". */
fun withdrawSealUi(spotNo: Int, held: PriceUi, armedAtMs: Long): SealUi = SealUi(
    title = "WITHDRAW FROM SPOT $spotNo",
    lines = listOf("Return ${held.amount ?: UNKNOWN} SKR to your wallet.", "You sign once."),
    price = held, confirmLabel = "WITHDRAW", armedAtMs = armedAtMs)

/** The paid draw-entry seal (SPEC §4.3); [refundLine] is the server's refund rule ("not refunded if you are not picked"). */
fun drawEntrySealUi(workshopNo: Int, price: PriceUi, refundLine: String, armedAtMs: Long): SealUi = SealUi(
    title = "ENTER THE DRAW · WORKSHOP $workshopNo",
    lines = listOf(refundLine, "Paid from your wallet. You sign once."),
    price = price, confirmLabel = "ENTER", armedAtMs = armedAtMs)

/** The Reach unlock seal (account SPEC §6.3). */
fun reachUnlockSealUi(tileLabel: String, price: PriceUi, armedAtMs: Long, devnet: Boolean): SealUi = SealUi(
    title = "UNLOCK TILE $tileLabel?",
    lines = listOfNotNull("Paid from your wallet. You sign once.", "Then buy the base here. Only you can.",
        "Devnet test SKR. The network fee is shown in your wallet.".takeIf { devnet }),
    price = price, confirmLabel = "UNLOCK", armedAtMs = armedAtMs)

/** "SPOT 7 IS YOURS" (SPEC §3.7); raise only after the settlement receipt. */
fun spotWonCelebration(receiptId: String, spotNo: Int, termLine: String): CelebrationUi =
    CelebrationUi(receiptId, "ui:seeker-navigation", "SPOT $spotNo IS YOURS", termLine)

/** A drawn licence you won (SPEC §4 MINE celebration); only after the draw receipt. */
fun licenceWonCelebration(receiptId: String, workshopNo: Int, termLine: String): CelebrationUi =
    CelebrationUi(receiptId, "ui:solana-navigation", "WORKSHOP $workshopNo IS YOURS", termLine)

/** "TILE 1,204 UNLOCKED" (account SPEC §6.3); only after the unlock receipt. */
fun reachUnlockedCelebration(receiptId: String, tileLabel: String): CelebrationUi =
    CelebrationUi(receiptId, "itm_deed_earth", "TILE $tileLabel UNLOCKED", "Held for you. Buy the base on it whenever you are ready.")

/** Rounds a dp size to whole device pixels (pixel art sits on the device grid). */
fun wholePx(dp: Float, density: Float): Int = (dp * density).roundToInt().coerceAtLeast(1)
