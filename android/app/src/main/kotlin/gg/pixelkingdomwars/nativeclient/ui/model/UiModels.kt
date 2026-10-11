package gg.pixelkingdomwars.nativeclient.ui.model

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId

/*
 * The UI-state classes of the rehaul (UX-ARCHITECTURE §7.2, plus the helpers the final design needs).
 *
 * Rules every class here follows:
 * - Immutable, presentation only: no repository, view model, network or graph type. Mappers (Codex) fill them from server
 *   state; composables only read them.
 * - Every number arrives already formatted. An unknown value is the ellipsis "…" (DESIGN-SYSTEM §9), never "0".
 * - The fields named in §7.2 keep their names, order and types. Fields the final design added come after them and have
 *   defaults, so a constructor call written from §7.2 still compiles.
 * - Icon fields are GameArt names: a drawable or atlas frame name (see `ui/chrome/PixelArt.kt`), `ui:<id>` for a bundled
 *   Phase E icon (`res/drawable-nodpi/pkw_ui_*`), or `shape:<name>` for a drawn kit glyph (see `ui/kit/PkwIcon.kt`).
 */

/** The verb colours (DESIGN-SYSTEM §2: colour = verb). The kit maps each to its face / highlight / lip ramp. */
enum class Verb {
    /** The building's own job (FORGE, TRAIN, SMELT, BID, COLLECT). One per surface. */
    GOLD,
    /** Upgrade, confirm, save. */
    GREEN,
    /** Info, navigation, GO to a place. */
    BLUE,
    /** Attack, close, count. */
    RED,
    /** Quiet utility (BACK, WITHDRAW, steppers, tools) and busy money states. */
    STONE,
    /** Edge buttons, ARMY, locked buttons. */
    CHARCOAL,
    /** Disabled: the server says no. Always shown with a reason. */
    OFF,
    /** SENT, the finished money state. */
    MOSS,
}

/** The one badge grammar (DESIGN-SYSTEM §10): red count, gold reward or NEW, green "!" ready, blue info. */
enum class BadgeTone { COUNT, REWARD, READY, INFO }

/** A corner badge. */
@Immutable data class BadgeUi(
    /** Exactly what the badge shows: a count already capped by `badgeCount` ("3", "99+"), "NEW" or "!". Never empty. */
    val text: String,
    /** Which of the four badge colours to use. */
    val tone: BadgeTone,
    /** What a screen reader says, for example "3 quests ready to claim". */
    val description: String,
)

/** How a status chip segment is tinted. */
enum class ChipTone {
    /** Plain text on the veil. */
    NORMAL,
    /** Gold attention (for example a builder just finished). */
    ALERT,
    /** Danger text (for example "RAIDED ×2" in place of a shield). */
    DANGER,
    /** A quiet state label in muted text (the "free camp" in place of a shield, account/onboard-first-home.png). */
    QUIET,
}

/** One segment of the Home status chip: trophies, builders or shield (DESIGN-SYSTEM §6 TopBar). */
@Immutable data class ChipUi(
    /** The registry row a tap on this segment opens (Leagues, Builders, Defence log). */
    val id: FeatureId,
    /** The segment's icon (league crest, `builder`, `shield`); blank draws none (the free camp label stands alone). */
    val icon: String,
    /** The formatted value ("1,284", "1/2", "4h", "…"). Builders show the next finish time when all are busy. */
    val value: String,
    /** What a screen reader says, for example "Builders: 1 of 2 free". */
    val description: String,
    /** The 6 dp gold dot (a builder is free or just finished). */
    val dot: Boolean = false,
    /** Text tint. */
    val tone: ChipTone = ChipTone.NORMAL,
)

/** The top-left level badge (design: a 40 dp blue badge with the Keep level; the name lives in Profile). */
@Immutable data class ProfileMedallionUi(
    /** The Profile row. */
    val id: FeatureId,
    /** The Keep level as shown ("12", or "…" while unknown). */
    val level: String,
    /** Optional Keep portrait art; the final design draws the level only, so this is null on Home. */
    val portrait: String?,
    /** What a screen reader says, for example "Profile, Keep level 12". */
    val description: String,
    /** Optional badge (for example unread profile news). */
    val badge: BadgeUi? = null,
)

/** Which resource tint a readout uses for its value and storage bar (TOKENS.json `color.resource`). */
enum class ResourceAccent { PLAIN, SHARDS, GEMS, KEEP, SKR, DIVINE }

/** One row of the top-right resource stack (DESIGN-SYSTEM §6 ResourceChip). */
@Immutable data class ResourceChipUi(
    /** The registry row of this resource; a tap opens the resource drawer at it. */
    val id: FeatureId,
    /** The resource icon (24 px art drawn at 24 dp). */
    val icon: String,
    /** The formatted value, at most 6 glyphs ("40,943", "312.5", "1.2M"); "…" while unknown, never "0". Format a
     *  canonical decimal or base-unit amount with `compactAmount(amount, decimals)` (decimal-safe; no Long, no float). */
    val value: String,
    /** Storage fill 0..1 for the 3 dp bar (SHARDS only); null draws no bar. At or above 1 the bar turns red (full). */
    val fill: Float?,
    /** Kept from §7.2. Not drawn: the final design puts no "+" on HUD readouts (DESIGN-SYSTEM §3); the drawer's row
     *  and every SHORT cost pill carry GET / GO instead. Mappers should pass false. */
    val plus: Boolean,
    /** Optional badge on the row. */
    val badge: BadgeUi?,
    /** The resource's name for screen readers ("Shards"); falls back to the id when blank. */
    val name: String = "",
    /** Value and bar tint. */
    val accent: ResourceAccent = ResourceAccent.PLAIN,
    /** A server-confirmed gain to celebrate ("+200"): rises 12 dp and fades over 450 ms. Null when nothing was gained. */
    val gain: String? = null,
    /** True on the last row (SKR): it carries the gold drawer caret. */
    val drawerHandle: Boolean = false,
    /** What a screen reader says for this readout, with the EXACT, unabbreviated amount ("KEEP 1,234.567891", built
     *  with `exactAmount(amount, decimals)`); the drawer shows the same exact figure. Blank falls back to name + [value].
     *  (design ruling 092decf3 item 2.) */
    val exactDescription: String = "",
)

/** An edge button (right column) or edge tab (left column). Shown only while it has a badge (DESIGN-SYSTEM §6). */
@Immutable data class EdgeButtonUi(
    /** The registry row it opens. */
    val id: FeatureId,
    /** 24 px art (drawn at 36 dp) or 64 px art (drawn at 32 dp). */
    val icon: String,
    /** The outlined caption ("QUESTS"); edge tabs draw no caption and use it as the screen-reader label. */
    val label: String,
    /** The corner badge; an edge button with no badge is not shown at all. */
    val badge: BadgeUi?,
    /** A soft gold pulse for a live event. */
    val glow: Boolean,
)

/** One bottom-deck button: ATTACK, ARMY, MAP or BUILD (DESIGN-SYSTEM §6 BottomDeck). */
@Immutable data class DeckButtonUi(
    /** The registry row it opens. */
    val id: FeatureId,
    /** Its icon (36 dp) or portrait (28 dp for ARMY). */
    val icon: String,
    /** The outlined caption ("ATTACK"). */
    val label: String,
    /** True for the larger corner buttons (ATTACK 80 × 72, BUILD 72 × 72); false for ARMY / MAP (52 × 52). */
    val primary: Boolean,
    /** Corner badge (BUILD's gold NEW). */
    val badge: BadgeUi?,
    /** (current, capacity) for the ARMY fill meter or ATTACK energy pips; null draws none. */
    val pips: Pair<Int, Int>?,
    /** Face colour: ATTACK red, ARMY charcoal, MAP blue, BUILD green. */
    val verb: Verb = if (primary) Verb.GOLD else Verb.STONE,
    /** Why this navigation would refuse; it remains tappable to explain the same reason. */
    val stateDescription: String? = null,
)

/** The one transient herald banner (DESIGN-SYSTEM §6 Banner): 44 dp, top centre, 4 s, one at a time. */
@Immutable data class HeraldUi(
    /** Identity of this notice; a new key restarts its 4 s. */
    val key: String,
    /** Its 32 dp icon. */
    val icon: String,
    /** One sentence ("Builder finished: Workshop Lv 3"). */
    val text: String,
    /** Where a tap goes; null when the banner only informs. */
    val target: FeatureId?,
)

/** The transient context chip between ARMY and MAP (DESIGN-SYSTEM §6 ContextChip): what and where, shown 6 s. */
@Immutable data class ContextChipUi(
    /** The place the tap flies the camera to. */
    val id: FeatureId,
    /** The 32 dp icon that pokes out at the top-left. */
    val icon: String,
    /** Line 1, what ("Auction"). */
    val what: String,
    /** Line 2, where ("Seeker ▸"). */
    val where: String,
)

/** Everything the Home HUD draws (UX-ARCHITECTURE §2, DESIGN-SYSTEM §6 HUD, owner addenda 1, 5 and 6). */
@Immutable data class HomeHudUi(
    /** The top-left level badge. */
    val profile: ProfileMedallionUi,
    /** The builders segment of the status chip. */
    val builders: ChipUi,
    /** The shield segment of the status chip. */
    val shield: ChipUi,
    /** The resource stack, top to bottom: SHARDS, GEMS, KEEP (only with a linked wallet), SKR (the drawer handle).
     *  At most 4 rows (owner addendum 6 refines §2.1's "≤ 3": the 4th is SKR). */
    val resources: List<ResourceChipUi>,
    /** Right edge buttons, only those with a badge; at most 2 visible, the rest stack into the top one ("+n"). */
    val rightEdge: List<EdgeButtonUi>,
    /** Left edge tabs (MAIL only while unread, CHAT); at most 2. */
    val leftEdge: List<EdgeButtonUi>,
    /** The herald banner, if one is showing. */
    val herald: HeraldUi?,
    /** The deck, left to right; at most 4. */
    val deck: List<DeckButtonUi>,
    /** False while a building is selected: the deck slides down and the command bar replaces it. */
    val deckVisible: Boolean,
    /** The league + trophies segment of the status chip (design: it replaces the name line). */
    val trophies: ChipUi? = null,
    /** The transient context chip, if one is showing. */
    val context: ContextChipUi? = null,
    /** The left-handed setting: the deck is mirrored. */
    val mirrored: Boolean = false,
    /** Where the "+n" of folded right-edge buttons goes: the player hub row, at its notices section, where every folded
     *  candidate is listed (design ruling 092decf3 item 6). The first visible edge button keeps its own id. Null keeps
     *  "+n" a count only (not a door); mappers should always pass the hub row. */
    val rightEdgeOverflow: FeatureId? = null,
    /** The deck's folded base tools (LAYOUT · EXPAND · FIT), at most [gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry.MAX_TOOLS].
     *  They are not permanent chrome: a long-press on BUILD (or its screen-reader action) opens them as a transient shelf
     *  over BUILD's corner, so they cost the 12 % Home budget nothing. Empty draws no shelf and no long-press. */
    val tools: List<DeckToolUi> = emptyList(),
    /** True while the tools shelf is open (host-owned; [gg.pixelkingdomwars.nativeclient.ui.hud.HomeHudActions.toggleTools]). */
    val toolsOpen: Boolean = false,
)

/** One base tool in the deck's transient tools shelf (a 52 × 52 stone deck face). */
@Immutable data class DeckToolUi(
    /** The registry row it runs. */
    val id: FeatureId,
    /** Its 24 dp icon. */
    val icon: String,
    /** The outlined caption ("FIT"). */
    val label: String,
    /** False draws the OFF face and the tap does nothing; [description] then says why. */
    val enabled: Boolean,
    /** What a screen reader says (include the reason while disabled). */
    val description: String,
)

/** A command's state (UX-ARCHITECTURE §3.2). Every state still calls back on tap so the caller can explain it. */
enum class CommandState {
    /** Works. */
    ENABLED,
    /** Off; a tap shows [CommandUi.reason] as a toast, never silent. */
    DISABLED,
    /** Waiting for the server: dots in place of the icon. */
    BUSY,
    /** Priced and not affordable: the cost pill turns red; a tap opens the Need-more half sheet, never auto-spends. */
    SHORT,
    /** Gated by a requirement: charcoal face with a padlock; a tap shows the requirement. */
    LOCKED,
}

/** One command of the building command bar (DESIGN-SYSTEM §6 CommandButton). */
@Immutable data class CommandUi(
    /** The registry row this command runs or opens. */
    val id: FeatureId,
    /** The 36 dp icon (40 dp on the primary). */
    val icon: String,
    /** The one-word caption ("UPGRADE"). */
    val caption: String,
    /** The cost pill shown 30 dp above, only when the command costs something. */
    val price: PriceUi?,
    /** The primary (120 × 92), always last in the bar; at most one per bar. A VISUAL designation from the registry row,
     *  not an authority: a locked primary stays primary with state LOCKED and a [reason]; executability is only
     *  [state] (design ruling 5ed31eb8 item 3). Gold unless [verb] names another verb (green UPGRADE primary). */
    val primary: Boolean,
    /** Current state. */
    val state: CommandState,
    /** Why it is DISABLED or LOCKED, in one short sentence; read by screen readers and shown on tap. */
    val reason: String?,
    /** Corner badge (red count, green "!" ready). */
    val badge: BadgeUi?,
    /** Face colour (INFO blue, UPGRADE green, utility stone). A primary left at STONE draws gold; a primary with any
     *  other verb draws that verb (Keep / wall UPGRADE primaries are green). */
    val verb: Verb = Verb.STONE,
    /** A short VT line inside the face ("4h" on UPGRADE). */
    val sub: String? = null,
    /** The primary's second icon of its icon pair (ingot + KEEP on FORGE). */
    val iconSecondary: String? = null,
    /** A short PS 12 value drawn beside the primary's icon (buildings/SPEC.md §1.6): "+8,400" on COLLECT, "x3" on a
     *  finished craft, the time left on FINISH. Already formatted; "…" while unknown. */
    val value: String? = null,
    /** The time left of the building's own running job ("2h 10m"), drawn as the 26 dp timer chip on the primary's
     *  top-left corner (SPEC §1.3: a busy primary is never blocked, the timer rides on the button). */
    val timer: String? = null,
    /** 0..1 fill of the 64 × 10 meter under the primary's icon (the ARMY camp fill); null draws none. */
    val meter: Float? = null,
)

/** The command bar of the selected building (UX-ARCHITECTURE §3.2). */
@Immutable data class CommandBarUi(
    /** The selected building's id. */
    val buildingId: String,
    /** INFO first and the primary last (see `orderCommands`). Portrait shows at most FOUR (INFO, up to two secondaries,
     *  the primary; design correction 7): put a fifth action inside the INFO sheet. Landscape shows up to five. */
    val commands: List<CommandUi>,
    /** The first-selections hint pill ("Tap the forge again to open it"); null after the third selection. */
    val hint: String? = null,
)

/** The name plate over a selected building (DESIGN-SYSTEM §6 NamePlate). */
@Immutable data class NamePlateUi(
    /** The building name ("GOLD FORGE"). */
    val name: String,
    /** The level tag text exactly as shown ("LV 3", "…"). */
    val level: String,
    /** The live state line ("Smelted 2/3 · pool 6h 20m", "Ready", "Max"); null shows none. */
    val stateLine: String?,
    /** 0..1 progress of the running job for the plate meter; null draws none. */
    val progress: Float?,
    /** The level tag's face (buildings/SPEC.md §1.6 levelTone). Null keeps the default: gold for "NEW", blue otherwise. */
    val levelVerb: Verb? = null,
    /** The meter's fill: green for construction, upgrades and the camp fill, blue for working jobs (research, refining). */
    val progressVerb: Verb = Verb.GREEN,
    /** Draws the meter as green stripes (a building under construction, states.png). */
    val progressStriped: Boolean = false,
)

/** A price's currency. ITEM uses [PriceUi.icon] (an ingredient). */
enum class Currency { SHARDS, GEMS, KEEP, SKR, SOL, ITEM }

/** Where a price stands (UX-ARCHITECTURE §1, M48: never "0" or FREE without a server zero). */
enum class PriceStatus {
    /** A server price the player can pay. */
    OK,
    /** Still asking the server: "…". */
    CHECKING,
    /** The server could not price it: "unavailable". */
    UNAVAILABLE,
    /** A server price the player cannot afford: red pill. */
    SHORT,
    /** The server itself said zero: the only way a "0" price is drawn. */
    SERVER_ZERO,
}

/** One price (cost pill, seal pay/get token). */
@Immutable data class PriceUi(
    /** Its currency. */
    val currency: Currency,
    /** The formatted amount ("52,400"); null while unknown. Never drawn when [status] is CHECKING or UNAVAILABLE. */
    val amount: String?,
    /** Where the price stands. */
    val status: PriceStatus,
    /** Icon override (required for [Currency.ITEM]); null uses the currency's icon. */
    val icon: String? = null,
    /** Screen-reader text; null builds "52,400 Shards". */
    val description: String? = null,
)

/** One sheet tab (DESIGN-SYSTEM §6 Tabs). */
@Immutable data class TabUi(
    /** Stable tab id (the Destination's tab value, for example "SMELT"). */
    val id: String,
    /** 24 px (drawn at 24 dp) or 64 px (drawn at 32 dp) icon. */
    val icon: String,
    /** One or two words ("CLAIM"). */
    val label: String,
    /** Badge outside the tab's corner. */
    val badge: BadgeUi?,
    /** Locked tabs show a padlock and still call back, so the caller can say why. */
    val locked: Boolean,
)

/** The three sheet sizes (DESIGN-SYSTEM §6 Sheet). */
enum class SheetSize {
    /** ≤ 50 % height, no scrim; the scene's own tap closes it. */
    HALF,
    /** From y 104 to the bottom, 40 % scrim, the world keeps rendering. */
    TALL,
    /** Full card, 60 % scrim, world parked. */
    FULL,
}

/** The frame of any sheet (wood frame, header, tabs, parchment body, pinned footer). */
@Immutable data class SheetFrameUi(
    /** The title on the charcoal title plate ("GOLD FORGE"). */
    val title: String,
    /** Static header art when there is no living header composable; null draws a plain wood header. */
    val portrait: String?,
    /** Which size the host gives it (the frame fills what it is given). */
    val size: SheetSize,
    /** Tabs; empty draws no strip. */
    val tabs: List<TabUi>,
    /** The selected tab id, or null when there are no tabs. */
    val selectedTab: String?,
    /** The blue tag beside the title ("LV 3"). */
    val titleTag: String? = null,
    /** The live chip at the header's bottom-left ("Pool closes 6h 20m"). */
    val live: TimerUi? = null,
    /** True draws the 48 dp stone History button (receipts one tap away). */
    val history: Boolean = false,
    /** A level transition: with [titleTag] "LV 2" and this "LV 3" the title plate draws blue LV 2 → gold step → green
     *  LV 3 (the UPGRADE sheet). Null draws [titleTag] alone. */
    val titleTagTo: String? = null,
)

/** A money consent (DESIGN-SYSTEM §6 ConfirmDialog / Seal): every Gems, SOL, KEEP and SKR spend. */
@Immutable data class SealUi(
    /** PS title ("BUY 500 GEMS"). */
    val title: String,
    /** VT lines under the tokens ("Paid from your wallet. You sign once."). */
    val lines: List<String>,
    /** What the player pays. */
    val price: PriceUi,
    /** The primary's label ("BUY"). */
    val confirmLabel: String,
    /** Wall-clock ms (`System.currentTimeMillis`) when the seal was raised. The primary accepts only from
     *  armedAtMs + `PkwTokens.Motion.SEAL_ARM` (see `sealAccepts`). */
    val armedAtMs: Long,
    /** What the player gets, drawn after the arrow; null draws the pay token only. */
    val gets: PriceUi? = null,
    /** The stone back button's label. */
    val backLabel: String = "BACK",
)

/** A map panel for an island (UX-ARCHITECTURE §5.2). */
@Immutable data class IslandPanelUi(
    /** "seeker-island", "solana-island", "divine-isle" or "archipelago". */
    val islandId: String,
    /** One state line ("Auctions open Wed 14 Oct"). */
    val stateLine: String,
    /** The panel's one primary command. */
    val primary: CommandUi,
    /** Other doors on the island. */
    val entries: List<CommandUi>,
)

/** An island spot's auction state (DESIGN-SYSTEM §6 AuctionSpotCard tags). */
enum class SpotState {
    /** Auctions are not open on this server yet. */
    NOT_OPEN,
    /** Live and the player has not bid. */
    LIVE,
    /** Live and the player is the top bidder (green YOU LEAD). */
    YOU_LEAD,
    /** Live and the player was outbid (red OUTBID; their SKR is held for them). */
    OUTBID,
    /** The player holds the spot (gold KING). */
    KING,
    /** Ended. */
    CLOSED,
    /** Solana Island licensed spot: "Licence allocation opens later", no BID. */
    LICENCE_LATER,
}

/** The spot sheet on Seeker / Solana Island (UX-ARCHITECTURE §5.3). */
@Immutable data class SpotSheetUi(
    /** The spot number ("SPOT 142"). */
    val spotNo: Int,
    /** True for king-class spots. */
    val kingClass: Boolean,
    /** Auction state. */
    val state: SpotState,
    /** Crest art of the bidders shown. */
    val crests: List<String>,
    /** The top bid; null when none. */
    val highBid: PriceUi?,
    /** The player's own bid; null when none. */
    val yourBid: PriceUi?,
    /** "2h 10m" left; null when not live. */
    val countdown: String?,
    /** BID / WITHDRAW / GO commands. */
    val commands: List<CommandUi>,
    /** True when the data is a fixture: the TEST DATA tag is mandatory and "live" is never shown. */
    val testData: Boolean,
)

/** A toast's look. */
enum class ToastKind { INFO, ERROR }

/** One toast (DESIGN-SYSTEM §6 Toast): 4 s, at most 3, the same key merges (see `ToastQueue`). */
@Immutable data class ToastUi(
    /** Merge key: a second toast with the same key replaces this one and restarts its 4 s. */
    val key: String,
    /** One VT sentence. */
    val message: String,
    /** The 32 dp icon; null draws none. */
    val icon: String?,
    /** INFO charcoal or ERROR blood. */
    val kind: ToastKind,
    /** Where the blue GO goes; null draws no GO. */
    val go: FeatureId?,
    /** GO's label ("GO"). */
    val goLabel: String?,
    /** True draws the "Report" link (errors). */
    val report: Boolean,
    /** Wall-clock ms the toast was posted (or last merged). */
    val postedAtMs: Long,
    /** Bumped by every merge so the toast's own timer restarts. */
    val revision: Int = 0,
)

/** The receipt-gated celebration (DESIGN-SYSTEM §6 Celebration). */
@Immutable data class CelebrationUi(
    /** The server receipt that proves the money moved. Required: nothing celebrates without one. */
    val receiptId: String,
    /** The 48 dp token art ("keep"). */
    val icon: String,
    /** The ribbon text ("+1,240 KEEP"). */
    val ribbon: String,
    /** The VT line ("Sent to your wallet"). */
    val line: String,
)

/** A timer readout (DESIGN-SYSTEM §6 TimerChip; also the sheet header's live chip). */
@Immutable data class TimerUi(
    /** The formatted remaining time ("6h 20m"; m:ss below 1 h), or "…". */
    val text: String,
    /** Screen-reader text ("Pool closes in 6 hours 20 minutes"). */
    val description: String,
    /** Its 24 px icon. */
    val icon: String = "timer",
    /** Optional 0..1 progress for a meter under the time. */
    val progress: Float? = null,
)

/** The money sequence of a CLAIM / BUY GEMS / BID / SOL button (DESIGN-SYSTEM §6 Money sequence). */
enum class MoneyStage {
    /** Gold, the action's own label. */
    READY,
    /** Stone, "Check wallet" (the wallet is asking the player). */
    CHECK_WALLET,
    /** Stone dots, "Sending". */
    SENDING,
    /** Moss "SENT", only after the server receipt. */
    SENT,
    /** Red "RETRY" (with an error toast and Report). */
    FAILED,
}

/** An item tile's state (DESIGN-SYSTEM §6 ItemTile). */
enum class ItemTileState { OWNED, SELECTED, MISSING }

/** One item tile (72 × 80; the drawer variant 48 × 56). */
@Immutable data class ItemTileUi(
    /** Stable item id. */
    val id: String,
    /** 32 dp art. */
    val icon: String,
    /** The count as shown ("14", "2K", "…"). */
    val count: String,
    /** Screen-reader text ("Crown Iron Ore, 14"). */
    val description: String,
    /** Owned, selected or missing. */
    val state: ItemTileState = ItemTileState.OWNED,
    /** The gold NEW badge. */
    val isNew: Boolean = false,
    /** Divine Isle lavender tint. */
    val divine: Boolean = false,
    /** Zero owned: the icon draws at 40 % and the count in red. Still tappable. */
    val empty: Boolean = false,
)

/** A parchment empty state (DESIGN-SYSTEM §6 EmptyState). */
@Immutable data class EmptyStateUi(
    /** The 64 dp authored icon, drawn at 40 %. */
    val icon: String,
    /** VT 20 headline ("No boat yet"). */
    val headline: String,
    /** VT 18 reason ("Build one at the Berth to explore islands."). */
    val reason: String,
    /** The blue button label ("GO TO BERTH"); null draws none. */
    val goLabel: String?,
    /** Where it goes. */
    val go: FeatureId?,
)

/** One resource in the resource drawer (owner addenda 2, 3 and 6: every resource is a signpost). */
@Immutable data class ResourceRowUi(
    /** Stable resource id (catalogue key, "shards", "skr"). */
    val id: String,
    /** Its art: 24 px currency icons, 64 px Phase E icons. */
    val icon: String,
    /** Display name ("EMBERCORE"). */
    val name: String,
    /** Formatted count ("1", "2K", "40,943"), "…" while unknown. */
    val value: String,
    /** What it is for, one sentence ("Builds Ember Engines and Gold Forge Lv 4."). */
    val purpose: String,
    /** Where it is earned, one sentence ("Refined at the Workshop."). */
    val earnedAt: String,
    /** The building or island to fly to; null when there is nowhere to go yet. */
    val earnedAtFeature: FeatureId?,
    /** The destination's 32 dp icon drawn on the GO button; null draws "GO" only. */
    val goIcon: String? = null,
    /** None owned: 40 % icon and a red count, still tappable. */
    val empty: Boolean = false,
    /** Divine Isle lavender tint. */
    val divine: Boolean = false,
    /** A row-level action word ("BID" on SKR); null draws none. */
    val actionLabel: String? = null,
    /** Where [actionLabel] goes. */
    val action: FeatureId? = null,
)

/** How a drawer group lays out its rows. */
enum class ResourceGroupLayout {
    /** EVERY DAY: 2 × 2 wide rows with value + source. */
    WIDE_ROWS,
    /** A sideways-scrolling strip of 48 × 56 tiles. */
    TILE_STRIP,
}

/** One drawer group, by where its resources come from (HARVESTERS, WORKSHOP, LODGE). */
@Immutable data class ResourceGroupUi(
    /** Stable group id. */
    val id: String,
    /** The 32 dp source icon. */
    val icon: String,
    /** PS name ("WORKSHOP"). */
    val title: String,
    /** VT note ("refined from raw"). */
    val note: String,
    /** The group's GO destination; null draws no GO. */
    val go: FeatureId?,
    /** Its rows. */
    val rows: List<ResourceRowUi>,
    /** Wide rows or a tile strip. */
    val layout: ResourceGroupLayout = ResourceGroupLayout.TILE_STRIP,
)

/** The resource drawer that drops from the top bar (DESIGN-SYSTEM §6 Resource drawer). SOL is never in it. */
@Immutable data class ResourceDrawerUi(
    /** Groups top to bottom; the first is normally EVERY DAY (WIDE_ROWS). */
    val groups: List<ResourceGroupUi>,
    /** The row whose info card shows at the top (the row the player tapped); null shows the first row. */
    val focusRowId: String?,
    /** The PS title. */
    val title: String = "RESOURCES",
    /** The VT hint beside the title. */
    val hint: String = "tap one to see where",
    /** The VT footnote under the groups (the tint legend); null draws none. */
    val footnote: String? = null,
)
