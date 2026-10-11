package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: the shared UI-state types of the hub cluster (design/final/hub/SPEC.md §1 "Common Kotlin shapes",
 * §3.3 ConfirmDialog, §3.6 error state). Every hub sheet's own `…Ui` / `…Actions` live in that sheet's file; only the
 * shapes two or more sheets share live here.
 *
 * Rules (same as ui/model/UiModels.kt): immutable, presentation only (no repository, view model, network or graph
 * type), every number arrives formatted, an unknown value is "…" ([gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN]),
 * never "0".
 */

/**
 * A door a hub row or button opens (SPEC: `Destination`, UX-ARCHITECTURE §7.3).
 *
 * The arch's `Destination` sealed type is written by the Codex lane (`ui/features/Destination.kt`) and is not committed
 * on this branch, so the hub cannot name it without breaking the build. A hub screen never reads a door anyway; it only
 * hands it back. So a link carries:
 * - [feature]: the Feature Registry row (always set). The mount may resolve the door from the registry alone.
 * - [destination]: the arch §7.3 `Destination` the mapper already resolved (for doors with arguments, e.g.
 *   `FocusBuilding("barracks", then = Army("TRAIN"))` or a History recovery `GoldForge("GEMS")`), or null to use the
 *   registry row's destination. Opaque here: the mount casts it (`link.destination as? Destination`).
 */
@Immutable data class HubLink(
    /** The registry row of this door, e.g. `FeatureId("hud.quests")`. */
    val feature: FeatureId,
    /** The resolved arch §7.3 `Destination`, or null to use the registry row's. Never read by a hub composable. */
    val destination: Any? = null,
)

/**
 * Where a card's server data stands (SPEC §2.2 `LoadState`, §3.4 in-card loading, §3.6 error state).
 * A card never blanks: the frame, header, tabs and footer always render; see [boardView] for how each state draws.
 */
sealed interface LoadState {
    /** Waiting for the first answer (or a refresh). With data already shown, the last good view stays on screen. */
    @Immutable data object Loading : LoadState

    /** The data on screen is the server's current answer. */
    @Immutable data object Ready : LoadState

    /** The data on screen is kept from [asOf] ("14:02"); a stone "as of 14:02" tag says so. */
    @Immutable data class Stale(val asOf: String) : LoadState

    /**
     * The read failed. [message] is what failed, in plain words ("Can't reach the league board."); [asOf] is when the kept
     * data is from ("14:02"), null when nothing is kept; [retrying] turns RETRY into busy dots; [safeLine] is the optional
     * reassurance ("Your trophies are safe.").
     */
    @Immutable data class Error(
        val message: String,
        val asOf: String? = null,
        val retrying: Boolean = false,
        val safeLine: String? = null,
    ) : LoadState
}

/** One FilterChip (SPEC §1): 48 tall, cream, gold when active. */
@Immutable data class FilterChipUi(
    /** Stable filter id handed back by `onFilter` ("ALL", "REWARDS", "goldforge"). */
    val id: String,
    /** The PS label ("REWARDS"). */
    val label: String,
    /** Optional 24 px (or 32 px) icon before the label. */
    val icon: String? = null,
    /** Optional count drawn after the label in PS 11 ("8"); null draws none. */
    val count: String? = null,
    /** Optional gold count badge after the label (REWARDS 2); wins over [count] when both are set. */
    val badge: BadgeUi? = null,
    /** Screen-reader text; blank uses the label (and count). */
    val description: String = "",
    /** SPEC §1 Locked tab grammar on a chip: dim face and a padlock; a tap still calls back so the caller says why. */
    val locked: Boolean = false,
)

/** The footer's "CLAIM n" (Quests, Mail): hidden when null or [count] ≤ 0. */
@Immutable data class ClaimAllUi(
    /** How many claims the one button makes. */
    val count: Int,
    /** The VT 18 sub-line, the sum of what it pays ("300 Shards · 10 Gems"). */
    val summary: String,
)

/** What a generic [RowUi] does on tap. */
enum class RowKind {
    /** Opens a page: drawn with a Chevron; a tap hands back [RowUi.link]. */
    OPEN,
    /** Runs one action: drawn with a stone button labelled [RowUi.buttonLabel]; a tap hands back [RowUi.id]. */
    BUTTON,
    /** Read-only: no control, not a button. */
    INFO,
}

/** A generic CardRow (Settings ACCOUNT / HELP, gate release notes, Profile WALLET). */
@Immutable data class RowUi(
    /** Stable id (BUTTON rows hand it back: "fit", "signout", "copy-address"). */
    val id: String,
    /** The Well's icon; null draws no Well. */
    val icon: String?,
    /** VT 20 title. */
    val title: String,
    /** VT 18 sub-line; null draws none. */
    val sub: String? = null,
    /** What a tap does. */
    val kind: RowKind = RowKind.OPEN,
    /** Where an OPEN row goes. */
    val link: HubLink? = null,
    /** The stone button's label on a BUTTON row ("FIT", "COPY", "SIGN OUT"). */
    val buttonLabel: String? = null,
    /** True draws [sub] in danger (a disabled reason). */
    val subDanger: Boolean = false,
)

/**
 * The destructive, non-money ConfirmDialog (SPEC §3.3): leave clan, kick member, discard feedback draft, sign out.
 * Money never uses this: every Gems, SOL, KEEP and SKR consent is the kit's `Seal`.
 */
@Immutable data class ConfirmUi(
    /** PS 13 question ("LEAVE IRON WARDENS?"). */
    val title: String,
    /** The "from" Well's authored portrait; null hides the from → to picture. */
    val fromIcon: String?,
    /** The "to" Well's authored portrait; null hides the arrow and the second Well. */
    val toIcon: String?,
    /** VT 20 consequence ("You lose your share of this week's chest."). */
    val line: String,
    /** VT 18 reassurance ("Your kingdom and trophies stay."); null draws none. */
    val subLine: String?,
    /** The red primary's verb ("LEAVE CLAN"). */
    val confirmLabel: String,
    /** The primary's face: RED for destructive (the default and the only use tonight). */
    val tone: Verb = Verb.RED,
    /** The stone back button's label. */
    val backLabel: String = "BACK",
)
