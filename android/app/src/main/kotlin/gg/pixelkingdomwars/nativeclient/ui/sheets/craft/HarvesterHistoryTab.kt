package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Harvester › HISTORY (design/final/craft/harvester-history.png; SPEC "E1.3 Harvester HISTORY",
 * registry row 102 `Harvester(tab = "HISTORY")`, also the History hub row "Earning history"). Supersedes the §4 "HISTORY
 * tab (not mocked)" body inside `HarvesterSheet.kt`: "LAST 7 DAYS · Crown Iron Ore · 288 in all" as a 7-column pixel bar
 * chart in a cream box (bars 26 wide, shard fill, today gold; PS 11 value on top, VT 18 day under; server day totals,
 * no axis), then day groups ("TODAY", "MONDAY") of 48 dp haul rows (PS 11 time, resource 32, PS 12 "+12", "into your
 * stores"; a level change is its own row with the builder and a blue LV tag; an ended interval is a stone row). Footer:
 * the stone recovery row (History icon, "Updated 2 min ago · Hauls are counted by the realm", CHECK = the native "CHECK
 * EARNING OBSERVATIONS") and "Hauls arrive on their own. Nothing to tap."
 *
 * Motion: after a CHECK finds new hauls, new rows slide in (160 ms) and today's bar grows (300 ms, SPEC E1.3). Reduced
 * motion: no slide, the bar changes in a 120 ms cross-fade step.
 *
 * Pointer rule: drawn inside the Harvester sheet's painted panel; only CHECK and MORE take touches. No scrim.
 */

/** One day column of the 7-day chart (SPEC `DayBarUi(label, total, today)`; `amount` was added for the bar height). */
@Immutable data class DayBarUi(
    /** VT 18 under the bar ("Fri", "Today"). */
    val label: String,
    /** PS 11 over the bar, server-formatted ("36"); null = unknown ("…"). */
    val total: String?,
    /** Today's bar is gold. */
    val today: Boolean,
    /** Added: the raw day total for the height ([dayBarHeights]); null = unknown (no bar). */
    val amount: Long?,
)

/** What a history row is (SPEC `HaulRowUi.kind`). */
enum class HaulKind {
    /** A haul into the stores: "+12 into your stores". */
    HAUL,
    /** A level change: the builder, "Reached Lv 2: +4 a haul" and a blue LV tag. */
    LEVEL,
    /** The interval ended: a stone row "Gathering stopped · START AGAIN on YIELD". */
    PAUSED,
}

/** One history row (SPEC `HaulRowUi(at, quantity, kind, line)`; fields after `line` were added). */
@Immutable data class HaulRowUi(
    /** PS 11 local time ("14:20"). */
    val at: String,
    /** HAUL: the server quantity without a sign ("12"); drawn "+12" ([haulQuantityText]). */
    val quantity: String,
    val kind: HaulKind,
    /** VT 18 ("into your stores", "Reached Lv 2: +4 a haul", "Gathering stopped · START AGAIN on YIELD"). */
    val line: String,
    /** Added: a stable row id (new rows slide in by id). */
    val id: String = "$at-$kind-$quantity",
    /** Added: LEVEL's tag ("LV 2"); null draws none. */
    val tag: String? = null,
)

/** A day group ("TODAY", "MONDAY") and its rows, newest first. */
@Immutable data class HaulGroupUi(val label: String, val rows: List<HaulRowUi>)

/** Harvester › HISTORY round-2 state (SPEC `HarvesterHistoryUi`; renamed because the round-1 `HarvesterHistoryUi` in
 *  HarvesterSheet.kt already takes the name; fields after `nextCursor` were added). */
@Immutable data class HarvesterHistoryTabUi(
    /** The server resource id ("crown_iron_ore"). */
    val resourceId: String,
    /** Seven days, oldest first, today last. */
    val days: List<DayBarUi>,
    /** "288"; drawn "288 in all" (null = "…"). */
    val weekTotal: String?,
    /** Day groups, newest first (the server pages them: the frame shows the last rows only). */
    val groups: List<HaulGroupUi>,
    /** "2 min ago"; null = not checked yet. */
    val refreshedAgo: String?,
    /** Non-null = older hauls exist (MORE at the list end). */
    val nextCursor: String?,
    /** Added: "Crown Iron Ore". */
    val resourceName: String = "",
    /** Added: the resource's icon (`craftItemIcon(resourceId)`). */
    val resourceIcon: String = craftItemIcon(resourceId),
    /** Added: Loading keeps the last good view with a 2 dp stone line. */
    val load: CraftHydration = CraftHydration.Ready,
    /** Added: true while CHECK runs (CHECKING, no second tap). */
    val checking: Boolean = false,
    /** Added: after a failed CHECK, the time of the list still shown ("14:20"): "Couldn't check · showing 14:20". */
    val errorShowing: String? = null,
    /** Added: the empty-state reason, with the server cadence ("The first one arrives 6h after the Harvester starts"). */
    val emptyReason: String = "The first one arrives after the Harvester starts",
    /** Added: true while the next page loads. */
    val loadingMore: Boolean = false,
    /** Receipt-only hosts cannot imply their locally retained rows cover complete server day totals. */
    val coverageNote: String? = null,
    val emptyTitle: String = "No hauls yet",
    /** Exact server observation time, including timezone; used instead of a device-derived refresh age. */
    val updatedAt: String? = null,
    /** False when the current owner cannot safely accept another observation check. */
    val checkAllowed: Boolean = true,
)

/** Harvester › HISTORY callbacks (SPEC: onCheck, onMore, onTab). */
@Immutable data class HarvesterHistoryTabActions(
    /** CHECK (the native CHECK EARNING OBSERVATIONS). */
    val onCheck: () -> Unit = {},
    /** MORE at the list end (paging by `nextCursor`). */
    val onMore: () -> Unit = {},
    /** A tab tap (YIELD). */
    val onTab: (String) -> Unit = {},
    /** The existing reviewed source-selection and original-receipt owner; absent means no recovery door. */
    val onOpenOriginal: (() -> Unit)? = null,
)

private const val BAR_MAX_DP = 64
/** SPEC E1.3: today's bar grows over 300 ms after a CHECK finds new hauls (no TOKENS.json duration matches; cited here). */
private const val TODAY_BAR_GROW_MS = 300

/** The HISTORY body: the 7-day chart and the day groups. */
@Composable internal fun ColumnScope.HarvesterHistoryTabBody(ui: HarvesterHistoryTabUi, on: HarvesterHistoryTabActions) {
    val c = PkwTokens.Colors
    if (ui.load is CraftHydration.Loading) Box(Modifier.fillMaxWidth().height(2.dp).background(c.stone.face))
    val empty = ui.groups.all { it.rows.isEmpty() } && ui.load !is CraftHydration.Loading
    SectionLabel("LAST 7 DAYS", ui.resourceName, weekTotalLine(ui.weekTotal))
    WeekChart(ui.days)
    ui.coverageNote?.let { PkwText(it, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2) }
    if (empty) {
        EmptyState(EmptyStateUi("ui:harvester-menu", ui.emptyTitle, ui.emptyReason, null, null), onGo = {})
        return
    }
    val seen = remember { mutableSetOf<String>() }
    val firstPass = seen.isEmpty()
    ui.groups.filter { it.rows.isNotEmpty() }.forEach { group ->
        PkwText(group.label, PkwTokens.Type.caption, Modifier.semantics { heading() }, color = c.textOnParch2)
        CreamCard(Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            Column(Modifier.fillMaxWidth()) {
                group.rows.forEachIndexed { i, row ->
                    if (i > 0) Box(Modifier.fillMaxWidth().height(2.dp).background(c.creamLo))
                    val isNew = !firstPass && row.id !in seen
                    HaulRow(row, ui.resourceIcon, isNew)
                }
            }
        }
    }
    LaunchedEffect(ui.groups) { ui.groups.forEach { g -> g.rows.forEach { seen.add(it.id) } } }
    if (ui.nextCursor != null) {
        if (ui.loadingMore) PkwText(CHECKING_TEXT, PkwTokens.Type.small, Modifier.fillMaxWidth(), color = c.textOnParch2, textAlign = TextAlign.Center)
        else SecondaryButton("MORE", on.onMore, Modifier.fillMaxWidth(), contentDescription = "Show older hauls")
    }
}

/** The HISTORY footer: the stone recovery row with CHECK, then "Hauls arrive on their own. Nothing to tap." */
@Composable internal fun ColumnScope.HarvesterHistoryTabFooter(ui: HarvesterHistoryTabUi, on: HarvesterHistoryTabActions) {
    val c = PkwTokens.Colors
    val (recoveryLine, recoveryDetail) = historyRecoveryLines(ui.refreshedAgo, ui.errorShowing)
    val line1 = if (ui.errorShowing == null && ui.updatedAt != null) "Observed ${ui.updatedAt}" else recoveryLine
    val line2 = if (ui.coverageNote != null && ui.errorShowing == null) "Saved receipts · UTC" else recoveryDetail
    Box(Modifier.fillMaxWidth().background(c.ink).padding(2.dp)) {
        Row(Modifier.fillMaxWidth().background(STONE_BODY).padding(start = 8.dp, top = 4.dp, end = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwIcon("replay", 32.dp)
            Column(Modifier.weight(1f)) {
                PkwText(line1, PkwTokens.Type.body, color = c.textOnParch, maxLines = 2)
                PkwText(line2, PkwTokens.Type.small, color = c.textOnParch2)
            }
            // Never silently off: while a check runs the label says CHECKING; otherwise the tap reaches onCheck even when this
            // view cannot take a check ([HarvesterHistoryTabUi.checkAllowed] false), and the host re-checks its owner and
            // either reads again or says why it cannot.
            SecondaryButton(if (ui.checking) "CHECKING" else "CHECK", { if (!ui.checking) on.onCheck() }, Modifier.width(104.dp),
                enabled = !ui.checking, contentDescription = "Check earning observations with the realm")
        }
    }
    on.onOpenOriginal?.let { original ->
        SecondaryButton("ORIGINAL REQUESTS", original, Modifier.fillMaxWidth(),
            contentDescription = "Open original Harvester source selections and receipts")
    }
    FooterNote("Hauls arrive on their own. Nothing to tap.")
}

/** The stone body of the recovery row (stone.hi over cream, SPEC "stone body"). */
private val STONE_BODY = Color(0xFFE6DDCB)

/** The 7-column chart in a cream box: PS 11 value on top, a 26 dp bar (shard fill, today gold), VT 18 day under. */
@Composable private fun WeekChart(days: List<DayBarUi>) {
    val c = PkwTokens.Colors
    val heights = dayBarHeights(days, BAR_MAX_DP)
    val spoken = days.joinToString(", ") { "${it.label} ${it.total ?: "unknown"}" }
    CreamCard(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = "Last 7 days: $spoken" },
        contentPadding = PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            days.forEachIndexed { i, day ->
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    PkwText(day.total ?: UNKNOWN, PkwTokens.Type.caption, color = c.textOnParch)
                    DayBar(heights.getOrNull(i), day.today)
                    Box(Modifier.fillMaxWidth().padding(horizontal = 2.dp).height(2.dp).background(c.creamLo))
                    PkwText(day.label, PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
        }
    }
}

/** One bar (26 dp wide, ink 2 dp rim); today's grows when it changes (300 ms; reduced motion: a 120 ms step). */
@Composable private fun DayBar(heightDp: Int?, today: Boolean) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val target = (heightDp ?: 0).dp
    val h by animateDpAsState(target, tween(if (!today) 0 else if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else TODAY_BAR_GROW_MS,
        easing = PkwTokens.Motion.Out), label = "dayBar")
    Box(Modifier.height(BAR_MAX_DP.dp), contentAlignment = Alignment.BottomCenter) {
        if (heightDp != null && heightDp > 0) {
            Box(Modifier.width(26.dp).height(h).background(c.ink).padding(start = 2.dp, top = 2.dp, end = 2.dp)) {
                Box(Modifier.fillMaxSize().background(if (today) c.gold.face else c.shards))
            }
        }
    }
}

/** One 48 dp row: PS 11 time, the resource 32 (builder for a level change), PS 12 "+12" + VT 18 line, or the stone
 *  "gathering stopped" row. New rows slide in (160 ms) after a CHECK; reduced motion fades. */
@Composable private fun HaulRow(row: HaulRowUi, resourceIcon: String, isNew: Boolean) {
    val c = PkwTokens.Colors
    val reduced = LocalReducedMotion.current
    val still = !isNew || LocalInspectionMode.current
    val slide = remember(row.id) { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(row.id) {
        if (!still) slide.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out))
    }
    val spoken = when (row.kind) {
        HaulKind.HAUL -> "${row.at}, ${haulQuantityText(row.quantity)} ${row.line}"
        else -> "${row.at}, ${row.line}"
    }
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
        .background(if (row.kind == HaulKind.PAUSED) STONE_BODY else Color.Transparent)
        .graphicsLayer {
            alpha = slide.value
            translationY = if (reduced) 0f else -12.dp.toPx() * (1f - slide.value)
        }
        .clearAndSetSemantics { contentDescription = spoken }
        .padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(row.at, PkwTokens.Type.caption, Modifier.width(56.dp), color = c.textOnParch2)
        when (row.kind) {
            HaulKind.HAUL -> {
                CraftIcon(resourceIcon, 32.dp)
                PkwText(haulQuantityText(row.quantity), PkwTokens.Type.label, color = c.textOnParch)
                PkwText(row.line, PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
            }
            HaulKind.LEVEL -> {
                PkwIcon("builder", 32.dp)
                PkwText(row.line, PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch)
                row.tag?.let { Tag(it, Verb.BLUE) }
            }
            HaulKind.PAUSED -> PkwText(row.line, PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch, maxLines = 2)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------- previews

private fun historySheet(h: HarvesterHistoryTabUi) = HarvesterSheetR2Ui(
    CraftSamples.harvester.copy(frame = CraftSamples.harvester.frame.copy(selectedTab = HarvesterTab.HISTORY)), h)

@Preview(name = "Harvester › HISTORY (harvester-history.png)", widthDp = 412, heightDp = 811)
@Composable private fun HistoryTabPreview() = HarvesterR2PreviewHost(historySheet(CraftR2Samples.history))

@Preview(name = "Harvester › HISTORY, interval ended", widthDp = 412, heightDp = 811)
@Composable private fun HistoryEndedPreview() = HarvesterR2PreviewHost(historySheet(CraftR2Samples.history.copy(groups = listOf(
    HaulGroupUi("TODAY", listOf(HaulRowUi("16:00", "", HaulKind.PAUSED, "Gathering stopped · START AGAIN on YIELD"))) ) + CraftR2Samples.history.groups)))

@Preview(name = "Harvester › HISTORY, loading", widthDp = 412, heightDp = 811)
@Composable private fun HistoryLoadingPreview() = HarvesterR2PreviewHost(historySheet(CraftR2Samples.history.copy(load = CraftHydration.Loading, checking = true)))

@Preview(name = "Harvester › HISTORY, error (last good + CHECK)", widthDp = 412, heightDp = 811)
@Composable private fun HistoryErrorPreview() = HarvesterR2PreviewHost(historySheet(CraftR2Samples.history.copy(
    load = CraftHydration.Error("Couldn't check"), errorShowing = "14:20")))

@Preview(name = "Harvester › HISTORY, empty", widthDp = 412, heightDp = 811)
@Composable private fun HistoryEmptyPreview() = HarvesterR2PreviewHost(historySheet(CraftR2Samples.history.copy(
    groups = emptyList(), weekTotal = "0", days = CraftR2Samples.history.days.map { it.copy(total = "0", amount = 0L) },
    emptyReason = "The first one arrives 6h after the Harvester starts")))
