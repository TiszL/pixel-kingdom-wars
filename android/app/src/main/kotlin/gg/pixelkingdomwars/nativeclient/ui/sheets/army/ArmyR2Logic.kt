package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * The pure rules of the army cluster's round 2 (design/final/army/SPEC.md "Round 2 additions" R2.1-R2.3 and E1.1-E1.2,
 * with the critic fixes): the defence rows' one answer verb (REVENGE), the log's window line and tab badge, the scout
 * shelf, and the hero skill tier track. The battle result's motion timeline is in ResultCelebrationTimeline.kt. No
 * Compose here; JVM-tested in ArmyR2LogicTest.
 */

// ---- Defence rows (R2.1, R2.2) ----

/** How a defence ended for the player. */
enum class Outcome { LOST, HELD }

/** The answer state of one defence (SPEC R2.1): AVAILABLE and ATTACK_BACK draw the SAME red REVENGE (one verb everywhere). */
enum class RevengeState { AVAILABLE, ATTACK_BACK, ANSWERED, UNAVAILABLE }

/** A row's own request state. */
enum class RowActionState {
    /** Nothing sent. */
    IDLE,
    /** REVENGE pressed: stone + dots "Finding Ironjaw" until the scene opens. */
    BUSY,
    /** The revenge search's answer was lost: tag "Being checked", REVENGE kept as RETRY. */
    CHECKING,
}

/** What the row's answer control shows. */
enum class RevengeKind {
    /** Red REVENGE (caption only, fits inside 104 × 52). */
    REVENGE,
    /** Stone + dots with the busy label. */
    BUSY,
    /** Red RETRY under a "Being checked" tag. */
    RETRY,
    /** Off REVENGE with a reason (no energy, no troops ready); a tap explains. */
    OFF,
    /** Moss "ANSWERED" tag, dimmed row, REPLAY only. */
    ANSWERED,
    /** Authoritatively unavailable (attacker shielded / relocated): a stone tag with the server words, no button. */
    GONE,
}

/** The answer control: its [kind], label and reason / tag text. */
data class RevengeLook(val kind: RevengeKind, val label: String, val note: String?)

/**
 * The answer control of a defence row. [gate] is a chooser-wide reason that turns every REVENGE off ("Energy 0 · next in
 * 38m", "No troops ready"); [unavailableNote] is the server's words for an UNAVAILABLE row ("SHIELDED · try in 2h").
 */
fun revengeLook(state: RevengeState, action: RowActionState, attacker: String, gate: String? = null, unavailableNote: String? = null,
    busyLabel: String? = null): RevengeLook = when {
    state == RevengeState.ANSWERED -> RevengeLook(RevengeKind.ANSWERED, "ANSWERED", null)
    state == RevengeState.UNAVAILABLE -> RevengeLook(RevengeKind.GONE, "REVENGE", unavailableNote ?: "Can't be answered now")
    action == RowActionState.BUSY -> RevengeLook(RevengeKind.BUSY, busyLabel ?: "Finding $attacker", null)
    action == RowActionState.CHECKING -> RevengeLook(RevengeKind.RETRY, "RETRY", "Being checked")
    gate != null -> RevengeLook(RevengeKind.OFF, REVENGE, gate)
    else -> RevengeLook(RevengeKind.REVENGE, REVENGE, null)
}

/** The one answer verb (critic fix 2026-10-03: the native "ATTACK BACK" label is retired in this design). */
const val REVENGE = "REVENGE"

/** The log's window line: "4 raids", "1 raid", "…" while unknown. Header and footer say the same window. */
fun raidCountLine(count: Int?): String = when {
    count == null || count < 0 -> UNKNOWN
    count == 1 -> "1 raid"
    else -> "$count raids"
}

/** The DEFENCE tab's red badge: defences the player has not looked at (null at 0). */
fun unseenBadge(unseen: Int): BadgeUi? = badgeCount(unseen)?.let { BadgeUi(it, BadgeTone.COUNT, "$unseen new raids on you") }

/** The outcome tag: red LOST / green HELD. */
fun outcomeTag(outcome: Outcome): Pair<String, Verb> = when (outcome) {
    Outcome.LOST -> "LOST" to Verb.RED
    Outcome.HELD -> "HELD" to Verb.GREEN
}

// ---- Scout (R2.3) ----

/** Where the scout scene was opened from. */
enum class ScoutSource { MATCH, MAP, CAMPAIGN, REVENGE }

/** The shelf commands left → right: HOME, SKIP (only for a FIND A MATCH scout, and only when the server priced one),
 *  ATTACK last. From the map, a campaign stage or a revenge target there is no next base, so SKIP is never shown. */
fun scoutShelf(home: CommandUi, skip: CommandUi?, attack: CommandUi, source: ScoutSource): List<CommandUi> =
    listOfNotNull(home, skip?.takeIf { source == ScoutSource.MATCH }, attack)

/** The loot plate shows except on a campaign scout (the stage has no loot to take). */
fun scoutShowsLoot(source: ScoutSource): Boolean = source != ScoutSource.CAMPAIGN

// ---- Hero skill tiers (E1.1) ----

/** Levels per skill tier (`heroTier(level)`: T1 Lv 1-5, T2 Lv 6-10, T3 Lv 11-15, T4 Lv 16-20). */
const val LEVELS_PER_TIER = 5
/** The highest skill tier. */
const val MAX_TIER = 4

/** The hero's skill tier for a level (1..4). */
fun heroTier(level: Int): Int = ((level.coerceAtLeast(1) - 1) / LEVELS_PER_TIER + 1).coerceIn(1, MAX_TIER)

/** A tier cell's look: done (green band), current (gold rim), future (flat). */
enum class TierState { DONE, CURRENT, FUTURE }

/** One cell of the tier track (SPEC E1.1 `TierCellUi`): "T2" over "Lv 6-10". */
data class TierCellUi(val label: String, val levels: String, val state: TierState)

/** The four tier cells for a hero at [level]; at [maxed] (max level) every cell is DONE. */
fun tierCells(level: Int, maxed: Boolean = false): List<TierCellUi> {
    val current = heroTier(level)
    return (1..MAX_TIER).map { t ->
        val from = (t - 1) * LEVELS_PER_TIER + 1
        val state = when {
            maxed || t < current -> TierState.DONE
            t == current -> TierState.CURRENT
            else -> TierState.FUTURE
        }
        TierCellUi("T$t", "Lv $from-${from + LEVELS_PER_TIER - 1}", state)
    }
}

/** "2 of 5 · Vex uses them on his own" (skills autocast; never imply a button). */
fun skillsCountLine(unlocked: Int, total: Int, hero: String): String = "$unlocked of $total · $hero uses them on his own"

/** The right column's second line: "once a battle" for once-per-battle skills, else the cooldown ("every 12s"), else "". */
fun cooldownLine(oncePerBattle: Boolean, cooldown: String?): String = when {
    oncePerBattle -> "once a battle"
    cooldown.isNullOrBlank() -> ""
    else -> cooldown
}
