package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the pure rules of map round 2 (design/final/map/SPEC.md "Round 2 additions (2026-10-03)" §A-§E and
 * "Round 2 critic fixes"): the Seeker REALM PERMIT tiles and Seal arming, ISLAND REWARDS tabs and claim rows, the Divine
 * Isle scene's door hit test and default door, the Solo Trials pips / stars / top-500 rule, and the Fragments DELIVER
 * guard. No Compose here (JVM-tested in app/src/test/kotlin/.../ui/sheets/map/MapR2LogicTest.kt). Money rule: nothing
 * here computes an amount; amounts are strings from the data lane.
 */

// ---- Shared enums (SPEC names) ----

/** A permit RealmTile's state (§A `PermitRealmState`). */
enum class PermitRealmState { OPEN, HOME, NOT_SOLD, COVERED }

/** The ISLAND REWARDS tabs (critic fix: MATERIALS · SHARDS · REALM'S CUT; replaces SHARES / KEEP_TAX everywhere). */
enum class RewardsTab { MATERIALS, SHARDS, REALMS_CUT }

/** The Divine Isle's two doors (§C). */
enum class DivineDoor { WEST, EAST }

/** Where waiting fragments come from (§E). */
enum class FragmentSource { SOLO, CLAN, SEEKER }

/** A fragment source row's state (§E). */
enum class SourceState { READY, LOCKED, NONE }

/** An earlier rewards term / realm's-cut round (§B "EARLIER TERMS", "uncertain", "kingdom gone"). */
enum class TermState {
    /** Claimable now: green READY. */
    READY,
    /** A saved claim with no outcome yet: "Being checked" + CHECK SAVED RECEIPT; it cannot be claimed again. */
    CHECKING,
    /** Already claimed (receipt kept): moss SENT. */
    CLAIMED,
    /** Nothing claimable on this row (a 0 only from the server): no tag. */
    NONE,
}

// ---- §A REALM PERMIT ----

/** What a tap on a permit RealmTile does. */
enum class PermitTileTap { SELECT, NOT_SOLD, HOME }

/** §A: a sold realm (open or already covered: buying adds the term on top) selects; a dimmed one explains itself. */
fun permitTileTap(state: PermitRealmState): PermitTileTap = when (state) {
    PermitRealmState.OPEN, PermitRealmState.COVERED -> PermitTileTap.SELECT
    PermitRealmState.NOT_SOLD -> PermitTileTap.NOT_SOLD
    PermitRealmState.HOME -> PermitTileTap.HOME
}

/** §A: the toast of a dimmed tile. */
const val PERMIT_NOT_SOLD_LINE = "Not sold at this spot"
const val PERMIT_HOME_LINE = "Your home realm needs no permit"

/** True when a tile draws dimmed (your home realm, a realm this spot does not sell). */
fun permitTileDimmed(state: PermitRealmState): Boolean = state == PermitRealmState.HOME || state == PermitRealmState.NOT_SOLD

/** A tile's corner tag: moss "OPEN" right after a purchase receipt, a stone "TO 9 OCT" while covered, else none. */
fun permitTileTag(state: PermitRealmState, coveredUntil: String?, justBought: Boolean): MapTagUi? = when {
    justBought -> MapTagUi("OPEN", Verb.MOSS)
    state == PermitRealmState.COVERED -> MapTagUi("TO ${coveredUntil?.takeIf { it.isNotBlank() } ?: UNKNOWN}", Verb.STONE)
    else -> null
}

/**
 * Whether the permit Seal's BUY may arm (§A states, design correction 7): only on a priced quote (OK or a server zero)
 * and only in a state that can send (READY or FAILED → RETRY). A CHECKING price opens the Seal as navigation but it
 * shows "Checking the price…" and never arms; UNAVAILABLE / SHORT never reach a send.
 */
fun permitSealCanArm(price: PriceUi, stage: MoneyStage): Boolean =
    (price.status == PriceStatus.OK || price.status == PriceStatus.SERVER_ZERO) && (stage == MoneyStage.READY || stage == MoneyStage.FAILED)

/** The Seal's line while it cannot arm because the quote is still out; null when the price is known. */
fun permitSealWaitLine(price: PriceUi): String? = when (price.status) {
    PriceStatus.CHECKING -> "Checking the price…"
    PriceStatus.UNAVAILABLE -> "Permit terms aren't available right now"
    else -> null
}

/** §A empty state: the quota line reads "Sold out here today" when the spot has none left. */
fun permitQuotaLine(quotaLine: String?, soldOut: Boolean): String = when {
    soldOut -> "Sold out here today"
    quotaLine.isNullOrBlank() -> UNKNOWN
    else -> quotaLine
}

// ---- §B ISLAND REWARDS ----

/** The tab ids handed back by `onTab` (the Destination's tab value). */
fun rewardsTabId(tab: RewardsTab): String = tab.name

/** The tab of an id; unknown ids fall back to MATERIALS (the drawn default). */
fun rewardsTabOf(id: String?): RewardsTab = RewardsTab.entries.firstOrNull { it.name == id } ?: RewardsTab.MATERIALS

/** The VT 20 intro of each tab (§B layout). */
fun rewardsIntro(tab: RewardsTab): String = when (tab) {
    RewardsTab.MATERIALS -> "Materials your winning spots earned. They go into a kingdom you own."
    RewardsTab.SHARDS -> "Shards your winning spots earned. They go into a kingdom you own."
    RewardsTab.REALMS_CUT -> "Each realm's cut of the permits your spots sold. Paid in KEEP to your wallet."
}

/** The footnote under the INTO row (critic fix wording), naming the two other tabs. */
fun rewardsFootnote(tab: RewardsTab): String = when (tab) {
    RewardsTab.MATERIALS -> "Shards and the realm's cut are claimed on their own tabs."
    RewardsTab.SHARDS -> "Materials and the realm's cut are claimed on their own tabs."
    RewardsTab.REALMS_CUT -> "Materials and Shards are claimed on their own tabs."
}

/** The tag of an earlier-term row (§B): READY green, CHECKING stone "BEING CHECKED", CLAIMED moss "SENT", NONE none. */
fun termTag(state: TermState): MapTagUi? = when (state) {
    TermState.READY -> MapTagUi("READY", Verb.GREEN)
    TermState.CHECKING -> MapTagUi("BEING CHECKED", Verb.STONE)
    TermState.CLAIMED -> MapTagUi("SENT", Verb.MOSS)
    TermState.NONE -> null
}

/**
 * The realm's-cut Seal fine print (§B: every SOL line lives only here). Null maxima are dropped; with neither known the
 * line still warns that a network cost applies, never a made-up number.
 */
fun realmsCutFinePrint(setupMaxSol: String?, networkMaxSol: String?): String {
    val setup = setupMaxSol?.takeIf { it.isNotBlank() }
    val network = networkMaxSol?.takeIf { it.isNotBlank() }
    return when {
        setup != null && network != null -> "A one-time wallet setup may be needed (at most $setup SOL) and a network cost (at most $network SOL)."
        setup != null -> "A one-time wallet setup may be needed (at most $setup SOL) and a network cost."
        network != null -> "A network cost applies (at most $network SOL)."
        else -> "A network cost applies; your wallet shows it before you sign."
    }
}

// ---- §C Divine Isle scene ----

/** The door anchors on `Q/world/divine-isle.webp`, in art px (§C): the WEST trials ring and the EAST citadel. */
val DIVINE_WEST_ANCHOR = IslandPoint(640f, 600f)
val DIVINE_EAST_ANCHOR = IslandPoint(1410f, 430f)

/** §C: hit areas are at least 96 dp around each door. */
const val DIVINE_DOOR_HIT_DP = 96f

/**
 * The scene's tap → door (pointer rule: the plates are paint, so the isle scene's own tap handler calls this with the
 * tap in overlay px). The nearest door whose anchor is within 48 dp (half the 96 dp hit square) wins; null = empty sea
 * (the scene deselects).
 */
fun pickDivineDoor(camera: IslandCamera, density: Float, tapXPx: Float, tapYPx: Float,
    west: IslandPoint = DIVINE_WEST_ANCHOR, east: IslandPoint = DIVINE_EAST_ANCHOR): DivineDoor? {
    val radius = DIVINE_DOOR_HIT_DP / 2f * density
    fun d(p: IslandPoint): Float {
        val dx = camera.screenX(p.x) - tapXPx
        val dy = camera.screenY(p.y) - tapYPx
        return kotlin.math.sqrt(dx * dx + dy * dy)
    }
    val dw = d(west); val de = d(east)
    return when {
        dw <= radius && (dw <= de || de > radius) -> DivineDoor.WEST
        de <= radius -> DivineDoor.EAST
        else -> null
    }
}

/** §C default: on entry WEST is selected while trials are open, else nothing; a door the player picked always wins. */
fun divineSelectedDoor(picked: DivineDoor?, entered: Boolean, trialsOpen: Boolean): DivineDoor? = when {
    picked != null -> picked
    entered && trialsOpen -> DivineDoor.WEST
    else -> null
}

/** Device px per art px at the isle's two zoom levels (§C: Z0 = exact 2:1 box reduction, Z1 = 1 device px per art px). */
fun divineLevelScale(zoom: Int): Float = if (zoom <= 0) 0.5f else 1f

// ---- §D Solo Trials ----

/** The TRIES LEFT pips: one per try this week, filled for each try still left (§D: "2 of 3" = two gold, one dark).
 *  Null (draw none, never a fake zero) when either side is unknown. */
fun triesFills(left: Int?, max: Int?): List<Boolean>? {
    if (left == null || max == null || max <= 0) return null
    val l = left.coerceIn(0, max)
    return List(max) { it < l }
}

/** The YOUR BEST stars: [stars] of [max] lit; null stars draws all unlit (the "…" line says unknown). */
fun trialStars(stars: Int?, max: Int = 3): List<Boolean> = List(max.coerceAtLeast(0)) { stars != null && it < stars.coerceAtLeast(0) }

/**
 * Where the gold "TOP 500 HOLD AN AREA" rule goes in STANDINGS (§D): before the first row whose rank is past [cutoff].
 * Returns that row's index (0 when the first shown row is already outside), or -1 when every shown row is inside or
 * the ranks are unknown (an unknown rank never moves the rule).
 */
fun topCutoffIndex(ranks: List<Int?>, cutoff: Int = 500): Int = ranks.indexOfFirst { it != null && it > cutoff }

/** The trials primary's draw state: a saved attempt still being checked blocks a second send (§D uncertain). */
fun trialPrimaryState(given: CommandState, attemptChecking: Boolean): CommandState =
    if (attemptChecking && given == CommandState.ENABLED) CommandState.DISABLED else given

// ---- §E Fragments ----

/** §E uncertain: DELIVER stays off until a saved request is checked; otherwise the mapper's state stands. */
fun deliverState(given: CommandState, recoveryPending: Boolean): CommandState =
    if (recoveryPending && given == CommandState.ENABLED) CommandState.DISABLED else given

/** §E: the DELIVER reason while a saved request is out. */
const val DELIVER_CHECK_FIRST = "This request may already be accepted. Check its outcome."

/** A fragment source row's tag: green READY, or none (a LOCKED row carries a GO instead). */
fun sourceTag(state: SourceState): MapTagUi? = if (state == SourceState.READY) MapTagUi("READY", Verb.GREEN) else null

/** §C motion: a door deselects in 120 ms (select = `PkwTokens.Motion.SELECT` 140, plate drop = `PLATE_IN` 160). */
const val DIVINE_DESELECT_MS = 120

/** §C: the plate rides 8 dp above its resting place and drops in. */
const val DIVINE_PLATE_DROP_DP = 8f

/** The FRAGMENTS command's gold count badge (§C: "gold count badge = fragments waiting"); none at 0 or unknown. */
fun fragmentsBadge(waiting: Int?): gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi? {
    val text = waiting?.let { gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount(it) } ?: return null
    return gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi(text, gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone.REWARD, "$waiting fragments waiting for you")
}
