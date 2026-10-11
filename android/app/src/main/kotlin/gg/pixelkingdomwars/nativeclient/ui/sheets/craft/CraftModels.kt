package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi

/*
 * Design component: the UI-state types every craft-cluster sheet shares (craft/SPEC.md §1 CraftSheet, §5 cross-cutting
 * states). Presentation only: no repository, view model, network or graph type. Codex's mappers fill them from server
 * state. Unknown counts are null and render as the ellipsis "…" (DESIGN-SYSTEM §9), never as 0.
 *
 * Icon fields take the kit's names (`ui:<id>`, `shape:<name>`, GameArt names) plus `craft:<name>` for the art this
 * cluster bundled (`res/drawable-nodpi/pkw_ui_<name>.png`, see CraftArt.kt). `craftItemIcon(itemId)` gives the icon of
 * any catalogue item.
 */

/** Where a sheet's data stands (SPEC §2.1 `hydration: Loading|Ready|Error(msg)`, §5 loading without blanking). */
sealed interface CraftHydration {
    /** A refresh is running. The last snapshot keeps rendering; counts show "…" and the primary shows busy dots. */
    data object Loading : CraftHydration
    /** The server answered; counts are real. */
    data object Ready : CraftHydration
    /** The last refresh failed. [message] is shown under the primary ("The Workshop can't reach the server. Try again."). */
    data class Error(val message: String) : CraftHydration
}

/** A saved request from earlier (SPEC §5 recovery; today's "CHECK ORIGINAL RECEIPT"). While one exists the primary is off. */
@Immutable data class SavedOpUi(
    /** The saved operation's id, handed back by the CHECK button. */
    val opId: String,
    /** VT 20 line. */
    val title: String = "A request from earlier is waiting",
    /** VT 18 line. */
    val line: String = "Check it before starting another",
    /** True while the CHECK call runs (the button shows CHECKING and does nothing). */
    val checking: Boolean = false,
)

/** Where a start / list / take-back request stands. */
enum class SubmitStage {
    /** Nothing in flight. */
    IDLE,
    /** Sent; waiting for the server (stone dots + [SubmitUi.busyLabel]). */
    SENDING,
    /** The answer was lost or timed out: the result is UNCERTAIN and is being checked. Never says nothing was spent;
     *  the recovery row (`savedOperation`) stays and the primary stays busy. */
    CHECKING,
    /** The server refused it AUTHORITATIVELY. Only this stage may tell the player nothing was spent. */
    REFUSED,
}

/** The in-flight state of the sheet's one action (SPEC "success" rows; design correction: uncertain ≠ refused). */
@Immutable data class SubmitUi(
    /** See [SubmitStage]. */
    val stage: SubmitStage = SubmitStage.IDLE,
    /** The busy label while [SubmitStage.SENDING] ("Starting", "Listing", "Taking back"). */
    val busyLabel: String = "Starting",
    /** The server's refusal sentence for [SubmitStage.REFUSED]; null uses a generic one. */
    val message: String? = null,
)

/** The header's live chip (SPEC §1: VeilChip 30 tall, one live sentence per sheet). */
@Immutable data class CraftLiveUi(
    /** 24 px art (drawn at 24 dp) or a 64 px `ui:` / `craft:` icon (drawn at 32 dp). */
    val icon: String,
    /** The plain part ("Refining ·", "Free to work", "Next haul"). */
    val text: String,
    /** The highlighted part in gold-hi ("3:48", "2h 10m"); null for none. */
    val accent: String? = null,
    /** True draws the whole sentence green (a ready / sold / arrived state). */
    val ready: Boolean = false,
    /** What a screen reader says. */
    val description: String = listOfNotNull(text, accent).joinToString(" "),
)

/** The frame of a craft sheet: title plate, History, close, live chip and tabs (SPEC §1 SheetHeader + Tabs). */
@Immutable data class CraftFrameUi(
    /** The title on the charcoal plate ("WORKSHOP"). */
    val title: String,
    /** The blue level tag ("LV 2", "…"); null draws none. */
    val titleTag: String?,
    /** The live chip; null draws none. */
    val live: CraftLiveUi?,
    /** True draws the 48 dp stone History button (→ `WalletHistory(<home>)`). False on the Harvester (SPEC 0.7). */
    val history: Boolean,
    /** Tabs. [TabUi.id] keeps the registry / Destination id (REFINE, EQUIPMENT, MY ORDERS…); [TabUi.label] is the
     *  ≤ 6-glyph visible word (SPEC 0.1). */
    val tabs: List<TabUi>,
    /** The selected tab id. */
    val selectedTab: String,
    /** True for the 4-tab `Tabs.Stacked` strip (icon above label); false uses the kit's side-by-side TabStrip. */
    val stackedTabs: Boolean = true,
)

/** One header well (SPEC §2.1 header: input well 44, output well 44). */
@Immutable data class CraftWellUi(
    /** The item's icon (drawn at 32 dp). */
    val icon: String,
    /** Opacity: 1 normally, 0.45 for a missing input, 0.35 / 0.5 while the bench works. */
    val alpha: Float = 1f,
    /** What a screen reader says ("Input: Frost Quartz"). */
    val description: String,
)

/** The living header art of a building without an interior scene (SPEC 0.3). */
@Immutable data class CraftHeaderUi(
    /** The building's authored sprite at world density (`craft:workshop_t2_idle`); null draws grass only. */
    val sprite: String?,
    /** A looping sprite atlas to play instead of [sprite] (the Workshop working loop, the Market working strip); null
     *  plays none. Reduced motion always draws [sprite]. */
    val loop: CraftAtlas? = null,
    /** Frames per second of [loop] (Workshop 8, Market 6). */
    val loopFps: Int = 8,
    /** The working stage's input well (crafting buildings only). */
    val input: CraftWellUi? = null,
    /** The working stage's output well. */
    val output: CraftWellUi? = null,
)

/** One catalogue item as the craft sheets show it. */
@Immutable data class CraftItemUi(
    /** Catalogue id ("frostglass", "crown_iron_ore"). */
    val itemId: String,
    /** Display name ("Frostglass"). */
    val name: String,
    /** Its icon (`craftItemIcon(itemId)`). */
    val icon: String,
    /** Where it comes from, one VT 18 line ("Frostveil harvester", "Refine here, from logs"). */
    val source: String,
    /** The recipe that makes it at this Workshop; non-null makes a missing-ingredient GO select that recipe in place. */
    val makeHereRecipeId: String? = null,
    /** The name used after a count other than one ("Expedition Kits"); defaults to [name]. */
    val pluralName: String = name,
    /** What it is for, one sentence ("For tools and kits."); null draws none. */
    val usedFor: String? = null,
)

/** What a recipe input is (SPEC §2.1 `inputs[{kind(raw|crafting|shards)…}]`). */
enum class InputKind { RAW, CRAFTING, SHARDS }

/** One recipe input (SPEC §2.1). */
@Immutable data class RecipeInputUi(
    /** Raw, crafting or Shards. Shards inputs are not rows: they become the primary's cost pill. */
    val kind: InputKind,
    /** Catalogue id ("frost_quartz"; "shards" for Shards). */
    val itemId: String,
    /** How many one unit of output needs. */
    val perUnit: Long,
)

/** One stock entry (SPEC §2.1 `stock: Map<itemId, {available, reserved, total, pendingOutput}>`). Null = unknown. */
@Immutable data class StockUi(
    /** Free to spend now. Every "have" count uses this. */
    val available: Long?,
    /** Held by an open order or job. */
    val reserved: Long? = null,
    /** available + reserved. */
    val total: Long? = null,
    /** Still being made. */
    val pendingOutput: Long? = null,
)

/** Why something is locked (SPEC §2.1 `locked: LockReason?`). */
@Immutable data class LockReasonUi(
    /** VT 18 line under the card ("Unlocks at Workshop 3"). */
    val line: String,
    /** The locked primary's label ("Workshop 3", "Market 4"). */
    val requirement: String,
)

/** The in-sheet review half sheet (SPEC §2.1 "Review half sheet", replaces today's AlertDialog). No money moves, so
 *  it is not a Seal. Back closes it (SPEC §5 Back order). */
@Immutable data class CraftReviewUi(
    /** PS title ("REFINE 6 FROSTGLASS"). */
    val title: String,
    /** VT 20 consent line ("No refunds. Nothing is spent until you tap START."). */
    val line: String,
    /** The gold confirm label ("START", "LIST", "TAKE BACK"). */
    val confirmLabel: String = "START",
    /** The stone back label. */
    val backLabel: String = "BACK",
    /** True while the confirmed request is in flight (the confirm shows dots and ignores taps). */
    val sending: Boolean = false,
)

/** The craft result celebration (SPEC §2.4 / 0.6). For auto-delivered output it is client-only: [jobId] is the
 *  server's finished job, so it never plays before the server reports the job complete. */
@Immutable data class CraftCelebrationUi(
    /** The finished job; handed back to `markSeen`. */
    val jobId: String,
    /** PS 13 title ("BATCH DONE", "HAUL ARRIVED"). */
    val title: String,
    /** The output icon (drawn at 64 dp). */
    val icon: String,
    /** The ribbon ("+6 FROSTGLASS"). */
    val ribbon: String,
    /** The VT 20 line ("In your stores. The bench is free."). */
    val line: String,
)

/** A navigation row with a blue GO (SPEC §4.1 "USED FOR" doors, §2.6 TravelRow). */
@Immutable data class DoorRowUi(
    /** Stable id handed back on GO (a recipe id, an item id, a travel row id). */
    val id: String,
    /** 32 dp icon. */
    val icon: String,
    /** VT 20 line ("Crownsteel"). */
    val title: String,
    /** VT 18 line ("Refine it at the Workshop"). */
    val line: String,
    /** The GO's screen-reader label ("Go to the Workshop, refine Crownsteel"). */
    val goDescription: String,
)
