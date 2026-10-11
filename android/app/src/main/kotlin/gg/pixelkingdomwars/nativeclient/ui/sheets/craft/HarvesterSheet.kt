package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import java.util.Locale

/*
 * Design component: the Harvester tall sheet (craft/SPEC.md §4; UX-ARCHITECTURE §7.3 `Destination.Harvester(tab)`),
 * side-by-side tabs YIELD · HISTORY. YIELD: the SourceCard (GATHERING with the cadence bar, or ARRIVED green), the policy
 * line, two MiniStats, the USED FOR doors, and UPGRADE (green, Shards pill) or COLLECT (client-only acknowledgement:
 * hauls are delivered by the server on their own, SPEC 0.2). HISTORY: the earning observations and the stone "Check with
 * the server" recovery row. No header History button (SPEC 0.7: the tab is the one door).
 */

/** An earning interval's state (`interval.state(NONE|RUNNING|ENDED)`). */
enum class IntervalState { NONE, RUNNING, ENDED }

/** `policy{grossPerCadence, cadenceSec}`. */
@Immutable data class HarvesterPolicyUi(val grossPerCadence: Long?, val cadenceSec: Long?)

/** `interval{state, startedAt, nextHaulAt}` (server epoch ms). */
@Immutable data class HarvesterIntervalUi(val state: IntervalState, val startedAtMs: Long?, val nextHaulAtMs: Long?)

/** `arrived{unseenQuantity, lastAt}`: a haul the server delivered that the player has not acknowledged. */
@Immutable data class HarvesterArrivedUi(val unseenQuantity: Long, val lastAt: String?)

/** Harvester › YIELD state (SPEC §4 `HarvesterUiState`; fields after `saved` were added). */
@Immutable data class HarvesterYieldUi(
    /** The server's realm id. */
    val realmId: String,
    /** The server art map's key (`seeker-reach` etc.); never derived from [realmId] (SPEC §4.1 mismatch). */
    val artKey: String?,
    val resourceId: String,
    val level: Int?,
    /** The art tier from the server building art map. */
    val tier: Int?,
    val policy: HarvesterPolicyUi,
    val interval: HarvesterIntervalUi,
    val arrived: HarvesterArrivedUi,
    /** Units arrived today; null = unknown. */
    val todayArrived: Long?,
    val stock: StockUi,
    /** The next level's gain, formatted ("+4 per haul at Lv 3"); null at max level. */
    val nextLevelDelta: String?,
    /** The UPGRADE price; null at max level (the footer hides). CHECKING is still enabled navigation. */
    val upgradeCost: PriceUi?,
    val actionsAllowed: Boolean,
    val saved: SavedOpUi?,
    /** Realm display name ("Crownlands"). */
    val realmName: String = "",
    /** Resource display name ("Crown Iron Ore"). */
    val resourceName: String = "",
    /** Resource icon (`craftItemIcon(resourceId)`). */
    val resourceIcon: String = craftItemIcon(resourceId),
    /** The word in "12 ore arrived". */
    val arrivedNoun: String = "ore",
    /** False while the Harvester is still being built ("Finish building first"). */
    val complete: Boolean = true,
    /** The refined-output door → Workshop REFINE (id = recipe id); null hides it. */
    val refineDoor: DoorRowUi? = null,
    /** The "Spare ore · Sell it at the Market" door (id = item id); null hides it. */
    val sellDoor: DoorRowUi? = null,
    val hydration: CraftHydration = CraftHydration.Ready,
    val submit: SubmitUi = SubmitUi(),
    val serverOffsetMs: Long = 0L,
    /** Added: the saved request is this kingdom's unproven, unrefused selection, so REVIEW SAVED REQUEST shows under the
     *  recovery row (SPEC §5) and re-reviews its exact key. */
    val savedReviewable: Boolean = false,
)

/** One earning observation (HISTORY tab). */
@Immutable data class HarvestRecordUi(val id: String, val date: String, val amount: String, val kingdom: String)

/** Harvester › HISTORY state. */
@Immutable data class HarvesterHistoryUi(
    val records: List<HarvestRecordUi>,
    /** True while "Check with the server" runs. */
    val checking: Boolean = false,
    val hydration: CraftHydration = CraftHydration.Ready,
)

/** Everything the Harvester sheet draws. */
@Immutable data class HarvesterSheetUi(
    /** Title "HARVESTER", "LV n", History OFF, `harvesterTabs()` with `stackedTabs = false`. The live chip is derived. */
    val frame: CraftFrameUi,
    /** The sprite (`harvesterSprite(artKey, tier, IDLE | READY | CONSTRUCTION)`). */
    val header: CraftHeaderUi,
    /** The YIELD tab's state. */
    val harvest: HarvesterYieldUi,
    val history: HarvesterHistoryUi? = null,
    /** The START review half sheet ("This starts a new interval. Earned units stay owed to their kingdom."). */
    val review: CraftReviewUi? = null,
    /** The HAUL ARRIVED party of a COLLECT tap (SPEC §4.2, 0.6): the host sets it from the haul it showed, before the seen
     *  marker moves (`harvesterArrivedCelebration`); null otherwise. Client-only: no server call. */
    val celebration: CraftCelebrationUi? = null,
    /** The Shards row shown top-right while open (SPEC 0.8). Drawn by the host. */
    val spend: ResourceChipUi? = null,
)

/** The Harvester sheet's callbacks (SPEC §4). */
@Immutable data class HarvesterSheetActions(
    val onClose: () -> Unit = {},
    /** A tab tap (YIELD, HISTORY). */
    val onTab: (String) -> Unit = {},
    /** Opens the START review half sheet. */
    val onStart: () -> Unit = {},
    /** COLLECT: `markSeen` the arrived haul (client-only; the count-up follows). */
    val onCollectSeen: () -> Unit = {},
    /** → the system Upgrade half sheet. */
    val onUpgrade: () -> Unit = {},
    /** → Workshop REFINE with that recipe selected. */
    val onGoWorkshop: (recipeId: String) -> Unit = {},
    /** → Market SELL with that item selected. */
    val onGoMarketSell: (itemId: String) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onNeedMore: (PriceUi) -> Unit = {},
    val onCheckSaved: (String) -> Unit = {},
    val onReviewBack: () -> Unit = {},
    /** The review's START: begin the interval. */
    val onReviewConfirm: () -> Unit = {},
    /** HISTORY's "Check with the server" (today's CHECK EARNING OBSERVATIONS). */
    val onCheckObservations: () -> Unit = {},
    val onCelebrationDone: (String) -> Unit = {},
    /** REVIEW SAVED REQUEST (shown when [HarvesterYieldUi.savedReviewable]): re-review the saved request's exact key. */
    val onReviewSaved: () -> Unit = {},
)

/**
 * The Harvester tall sheet. [modifier] must give it a bounded height (SheetHost: y 104 to the bottom edge).
 *
 * Pointer rule: the root is the painted wood frame (a scene-input region), never full-screen, with no scrim of its own
 * (the TALL 40 % scrim is the SheetHost's). The optional panel's scrim covers the sheet only while it shows.
 */
@Composable fun HarvesterSheet(ui: HarvesterSheetUi, on: HarvesterSheetActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }) {
    val now = rememberNow(clock)
    val tab = ui.frame.selectedTab
    val primary = if (tab == HarvesterTab.YIELD) harvesterPrimary(ui.harvest) else null
    CraftSheetFrame(ui.frame.copy(live = harvesterLive(ui.harvest, now, ui.frame.live), history = false, stackedTabs = false),
        on.onClose, on.onTab, {}, modifier,
        headerArt = { HeaderStage(ui.header, null, null, 182.dp, (-20).dp, "The ${ui.harvest.realmName} Harvester") },
        footer = { if (tab == HarvesterTab.YIELD) HarvesterYieldFooter(ui.harvest, on, primary, now) },
        panelOverlay = { ReviewHalfSheet(ui.review, emptyList(), null, on.onReviewBack, on.onReviewConfirm) },
        frameOverlay = { CraftCelebrationOverlay(ui.celebration, on.onCelebrationDone) },
    ) {
        if (tab == HarvesterTab.HISTORY) HarvesterHistoryBody(ui.history, on) else HarvesterYieldBody(ui.harvest, on, now)
    }
}

/**
 * The policy line under the SourceCard ("Up to 12 every 6h. A higher level gathers more."). The second sentence is a
 * claim about the next level, so it shows only when the server gives that level's gain ([HarvesterYieldUi.nextLevelDelta]);
 * today's Harvester policy is per wallet, not per level, and the sheet never promises more than the server states.
 */
internal fun harvesterPolicyLine(ui: HarvesterYieldUi): String =
    "Up to ${groupDigits(ui.policy.grossPerCadence)} every ${shortDuration(ui.policy.cadenceSec)}." +
        if (ui.nextLevelDelta != null) " A higher level gathers more." else ""

/** The YIELD body. */
@Composable private fun ColumnScope.HarvesterYieldBody(ui: HarvesterYieldUi, on: HarvesterSheetActions, nowMs: Long) {
    val c = PkwTokens.Colors
    ui.saved?.let { saved ->
        RecoveryRow(saved, on.onCheckSaved)
        // An unproven request of this kingdom resumes by re-reviewing its exact saved key (never a new command); the host
        // explains when the owner cannot open the review now, so this door is never silently off.
        if (ui.savedReviewable) SecondaryButton("REVIEW SAVED REQUEST", on.onReviewSaved, Modifier.fillMaxWidth(),
            contentDescription = "Review the saved Harvester request again")
    }
    SectionLabel("THIS HARVESTER", ui.realmName)
    if (ui.interval.state == IntervalState.NONE) {
        EmptyState(EmptyStateUi("ui:harvester-menu", "Not gathering yet", "Start an earning interval for this Harvester.", null, null), onGo = {})
    } else {
        SourceCard(ui, nowMs)
    }
    PkwText(harvesterPolicyLine(ui), PkwTokens.Type.small, Modifier.padding(horizontal = 2.dp), color = c.textOnParch2, maxLines = 2)
    // A routine refresh keeps the last observed counts (SPEC §5 "loading without blanking"); only an unknown count is "…".
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        MiniStat("ui:ready-status", groupDigits(ui.todayArrived), "arrived today", Modifier.weight(1f))
        MiniStat(ui.resourceIcon, groupDigits(ui.stock.available), "in your stores", Modifier.weight(1f))
    }
    if (ui.refineDoor != null || ui.sellDoor != null) {
        SectionLabel("USED FOR", "tap to go", modifier = Modifier.padding(top = 4.dp))
        ui.refineDoor?.let { DoorRow(it, on.onGoWorkshop) }
        ui.sellDoor?.let { DoorRow(it, on.onGoMarketSell) }
    }
}

/** SourceCard (CreamCard 112): the raw resource in a 72 well, its name, GATHERING / ARRIVED / ENDED, the cadence bar, and
 *  "+12 in 2h 10m, then every 6h" or "+12 already in your stores". */
@Composable private fun SourceCard(ui: HarvesterYieldUi, nowMs: Long) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val arrived = ui.arrived.unseenQuantity > 0L
    val ended = ui.interval.state == IntervalState.ENDED
    val left = secondsLeft(ui.interval.nextHaulAtMs, nowMs, ui.serverOffsetMs)
    val progress = when {
        arrived -> 1f
        ended -> null
        else -> jobProgress(null, ui.interval.nextHaulAtMs, ui.policy.cadenceSec, nowMs, ui.serverOffsetMs, if (reduced) 60_000L else 1L)
    }
    // harvester-yield.png / harvester-arrived.png: card padding 6 / 10 / 10, 10 dp gap, bar 6 dp under the tag, PS 11 "+12".
    CreamCard(Modifier.fillMaxWidth().heightIn(min = 112.dp), rim = if (arrived) CardRim.READY else CardRim.NONE,
        contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 10.dp, bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well(72.dp) { CraftIcon(ui.resourceIcon, 64.dp) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PkwText(ui.resourceName.uppercase(Locale.US), PkwTokens.Type.label, color = c.textOnParch)
                when {
                    arrived -> Tag("ARRIVED", Verb.GREEN)
                    ended -> Tag("ENDED", Verb.STONE)
                    else -> Tag("GATHERING", Verb.GOLD)
                }
                ProgressBar(progress, if (arrived) "Haul arrived" else "Next haul in ${timeLeft(left)}", Modifier.padding(top = 2.dp),
                    verb = if (arrived) Verb.GREEN else Verb.GOLD, height = 14.dp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PkwText("+${groupDigits(if (arrived) ui.arrived.unseenQuantity else ui.policy.grossPerCadence)}", PkwTokens.Type.caption, color = c.textOnParch)
                    PkwText(when {
                        arrived -> "already in your stores"
                        ended -> "the interval ended"
                        else -> "in ${countdownText(left)}, then every ${shortDuration(ui.policy.cadenceSec)}"
                    }, PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
    }
}

/** MiniStat (CreamCard 70): a 32 icon, a PS 12 number (counts up when it changes) and a VT 18 line. */
@Composable private fun MiniStat(icon: String, value: String, line: String, modifier: Modifier) {
    val c = PkwTokens.Colors
    // harvester-yield.png `.mini`: 70 tall, padding 6 / 8, 8 dp between the icon and the numbers.
    CreamCard(modifier.heightIn(min = 70.dp), contentPadding = PaddingValues(start = 8.dp, top = 6.dp, end = 8.dp, bottom = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CraftIcon(icon, 32.dp)
            Column {
                CountUpText(value, PkwTokens.Type.label)
                PkwText(line, PkwTokens.Type.small, color = c.textOnParch2)
            }
        }
    }
}

/** The YIELD footer: START / START AGAIN / COLLECT / UPGRADE (hidden at max level), and the note. */
@Composable private fun ColumnScope.HarvesterYieldFooter(ui: HarvesterYieldUi, on: HarvesterSheetActions, primary: CraftPrimaryUi?, nowMs: Long) {
    if (primary != null) {
        CraftPrimaryButton(primary, { action ->
            when (action) {
                PrimaryAction.START -> on.onStart()
                PrimaryAction.COLLECT -> on.onCollectSeen()
                PrimaryAction.UPGRADE -> on.onUpgrade()
                PrimaryAction.NEED_MORE -> primary.price?.let(on.onNeedMore)
                PrimaryAction.RETRY -> on.onRetry()
                else -> Unit
            }
        }, Modifier.fillMaxWidth().padding(top = if (primary.price != null) 14.dp else 0.dp))
    }
    val notice = submitNotice(ui.submit) ?: (ui.hydration as? CraftHydration.Error)?.message
    if (notice != null) FooterNote(notice, danger = true) else FooterNote(harvesterNote(ui, nowMs))
}

/** The HISTORY body: observations, newest first, and the stone recovery row at the bottom. */
@Composable private fun ColumnScope.HarvesterHistoryBody(ui: HarvesterHistoryUi?, on: HarvesterSheetActions) {
    val c = PkwTokens.Colors
    val records = ui?.records.orEmpty()
    if (ui == null || (records.isEmpty() && ui.hydration != CraftHydration.Loading)) {
        EmptyState(EmptyStateUi("ui:harvester-menu", "No hauls yet.", "Hauls appear here once they arrive.", null, null), onGo = {})
    } else {
        SectionLabel("HAULS", "newest first", groupDigits(records.size.toLong()))
        records.forEach { r ->
            CreamCard(Modifier.fillMaxWidth().heightIn(min = 52.dp), contentPadding = PaddingValues(start = 10.dp, top = 4.dp, end = 10.dp, bottom = 6.dp)) {
                Row(Modifier.align(Alignment.CenterStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        PkwText(r.date, PkwTokens.Type.body, color = c.textOnParch)
                        PkwText(r.kingdom, PkwTokens.Type.small, color = c.textOnParch2)
                    }
                    PkwText(r.amount, PkwTokens.Type.label, color = c.textOnParch)
                }
            }
        }
    }
    CreamCard(Modifier.fillMaxWidth(), rim = CardRim.NOTE, contentPadding = PaddingValues(start = 8.dp, top = 4.dp, end = 6.dp, bottom = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                PkwText("Missing a haul?", PkwTokens.Type.body, color = c.textOnParch)
                PkwText("Check with the server", PkwTokens.Type.small, color = c.textOnParch2)
            }
            val checking = ui?.checking == true
            SecondaryButton(if (checking) "CHECKING" else "CHECK", { if (!checking) on.onCheckObservations() }, Modifier.width(104.dp),
                enabled = !checking, contentDescription = "Check earning observations with the server")
        }
    }
}

/** Renders a Harvester sheet the way the SheetHost does on the 412 × 915 phone (y 104 → bottom), with a fixed clock. */
@Composable private fun HarvesterPreviewHost(ui: HarvesterSheetUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        HarvesterSheet(ui, HarvesterSheetActions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp), clock = { CraftSamples.NOW })
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Preview(name = "Harvester › YIELD gathering (harvester-yield.png)", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterYieldPreview() = HarvesterPreviewHost(CraftSamples.harvester)

@Preview(name = "Harvester › YIELD haul arrived (harvester-arrived.png)", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterArrivedPreview() = HarvesterPreviewHost(CraftSamples.harvesterArrived)

@Preview(name = "Harvester › YIELD not gathering yet", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterNonePreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(harvest = CraftSamples.harvester.harvest.copy(
    interval = HarvesterIntervalUi(IntervalState.NONE, null, null))))

@Preview(name = "Harvester › YIELD interval ended", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterEndedPreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(harvest = CraftSamples.harvester.harvest.copy(
    interval = HarvesterIntervalUi(IntervalState.ENDED, null, null))))

@Preview(name = "Harvester › YIELD still building (locked)", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterBuildingPreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(harvest = CraftSamples.harvester.harvest.copy(complete = false)))

@Preview(name = "Harvester › YIELD read-only base", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterReadOnlyPreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(harvest = CraftSamples.harvester.harvest.copy(actionsAllowed = false)))

@Preview(name = "Harvester › YIELD loading", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterLoadingPreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(harvest = CraftSamples.harvester.harvest.copy(
    hydration = CraftHydration.Loading)))

@Preview(name = "Harvester › YIELD start review", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterStartReviewPreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(
    harvest = CraftSamples.harvester.harvest.copy(interval = HarvesterIntervalUi(IntervalState.NONE, null, null)),
    review = CraftReviewUi("START GATHERING", "This starts a new interval. Earned units stay owed to their kingdom.")))

@Preview(name = "Harvester › HISTORY", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterHistoryPreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(
    frame = CraftSamples.harvester.frame.copy(selectedTab = HarvesterTab.HISTORY)))

@Preview(name = "Harvester › HISTORY empty", widthDp = 412, heightDp = 811)
@Composable private fun HarvesterHistoryEmptyPreview() = HarvesterPreviewHost(CraftSamples.harvester.copy(
    frame = CraftSamples.harvester.frame.copy(selectedTab = HarvesterTab.HISTORY), history = HarvesterHistoryUi(emptyList())))
