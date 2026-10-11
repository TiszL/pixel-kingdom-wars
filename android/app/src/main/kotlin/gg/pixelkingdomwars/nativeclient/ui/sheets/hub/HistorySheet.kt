package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/**
 * Design component: History (design/final/hub/history.png, SPEC §2.8): history only, never new work. One list of
 * everything money-like or result-like the player did, grouped by day, with NEEDS YOU on top while something is
 * unfinished (money moved is money honoured: those rows stay until the server says final). Replaces "ACTIVITIES &
 * RECEIPTS", the KEEP WALLET rows and receipt pages as launchers. Destination: `WalletHistory(home)` (FULL child card);
 * the row detail is a read-only HALF sheet ([HistoryDetailSheet]). Copy never says receipt or transaction.
 */

/** A history row's status. */
enum class HistoryStatus { SENT, DONE, RETURNED, HELD, PENDING, NEEDS_YOU }

/** One HistoryRow (58). */
@Immutable data class HistoryRowUi(
    val id: String,
    /** The authored icon of the thing, in a light Well 40. */
    val icon: String,
    /** VT 20 what happened ("Claimed 1,240 KEEP"). */
    val title: String,
    /** VT 18 "place · amount · time". */
    val sub: String,
    /** The status Tag ([historyStatusLook]). */
    val status: HistoryStatus,
    /** NEEDS YOU: the owning sheet's recovery state (e.g. `GoldForge("GEMS")` restoring the saved request); else null. */
    val recovery: HubLink?,
)

/** One day group (TODAY / YESTERDAY / EARLIER). */
@Immutable data class HistoryGroupUi(val id: String, val title: String, val rows: List<HistoryRowUi>)

/** Everything History draws (SPEC §2.8 State; fields after `load` were added with defaults). */
@Immutable data class HistoryUi(
    /** The active filter id ("all", "goldforge", …). */
    val filter: String,
    /** ALL · GOLD FORGE · WORKSHOP · LODGE · BERTH · MARKET · ISLANDS · PURCHASES (the strip scrolls). */
    val filters: List<FilterChipUi>,
    /** Unfinished money flows; the NEEDS YOU section shows only while non-empty. */
    val needsYou: List<HistoryRowUi>,
    val groups: List<HistoryGroupUi>,
    /** Older history on the server: two skeleton rows at the end while [loadingMore], else a MORE row. */
    val hasMore: Boolean,
    val load: LoadState,
    val loadingMore: Boolean = false,
)

/** History callbacks. */
@Immutable data class HistoryActions(
    val onFilter: (String) -> Unit = {},
    /** A row: open its read-only detail half sheet. */
    val onRow: (String) -> Unit = {},
    /** NEEDS YOU › OPEN: the owning sheet's recovery state. */
    val onOpen: (HubLink) -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onReport: () -> Unit = {},
    val onBack: () -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The History card. [modifier] is the FULL-card area (see [HubCard]).
 *
 * Pointer rule: the root is the plain [HubCard] Column; only painted chips, rows and buttons take touches.
 */
@Composable fun HistorySheet(ui: HistoryUi, on: HistoryActions, modifier: Modifier = Modifier) {
    HubCard(modifier, header = { CompactHeader("HISTORY", "replay", on.onClose, onBack = on.onBack) }) {
        HistoryBody(ui, on)
    }
}

@Composable private fun ColumnScope.HistoryBody(ui: HistoryUi, on: HistoryActions) {
    FilterChipStrip(ui.filters, ui.filter, on.onFilter)
    PkwText("History only. Act at the building.", PkwTokens.Type.small, Modifier.padding(top = 6.dp), color = PkwTokens.Colors.textOnParch2)
    val hasData = ui.groups.any { it.rows.isNotEmpty() } || ui.needsYou.isNotEmpty()
    val view = boardView(ui.load, hasData)
    if (view == BoardView.ERROR_KEPT || view == BoardView.ERROR_EMPTY) (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReport, Modifier.padding(top = 4.dp)) }
    when {
        view == BoardView.SKELETON -> Column(Modifier.weight(1f).padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { repeat(5) { SkeletonRow(height = 58.dp) } }
        !hasData && view != BoardView.ERROR_EMPTY -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            HubEmptyState("Nothing here yet", "Claims, purchases and expeditions show up here.", icon = "replay")
        }
        else -> LazyColumn(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (ui.needsYou.isNotEmpty()) {
                item(key = "needs-header") { SectionHeader("NEEDS YOU", titleColor = HubColors.mention) }
                // Money moved is money honoured: never dimmed, never hidden by an error.
                items(ui.needsYou, key = { "n-" + it.id }) { row -> NeedsYouRow(row, on) }
            }
            ui.groups.forEach { group ->
                if (group.rows.isNotEmpty()) {
                    item(key = "g-" + group.id) { SectionHeader(group.title, Modifier.graphicsLayer { alpha = boardAlpha(view) }) }
                    items(group.rows, key = { "r-" + it.id }) { row -> HistoryRow(row, Modifier.graphicsLayer { alpha = boardAlpha(view) }) { on.onRow(row.id) } }
                }
            }
            if (ui.hasMore) item(key = "more") {
                if (ui.loadingMore) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { repeat(2) { SkeletonRow(height = 58.dp) } }
                else StoneBusyButton("MORE", false, on.onLoadMore, Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable private fun NeedsYouRow(row: HistoryRowUi, on: HistoryActions) {
    CardRow(variant = RowVariant.YOU, height = 58.dp) {
        Well(row.icon, size = 40.dp, light = true, iconSize = if (row.icon.startsWith("ui:")) 32.dp else 24.dp)
        RowText(row.title, row.sub)
        row.recovery?.let { link -> GoButton({ on.onOpen(link) }, contentDescription = "Open: ${row.title}", modifier = Modifier.width(58.dp), label = "OPEN") }
    }
}

@Composable private fun HistoryRow(row: HistoryRowUi, modifier: Modifier, onClick: () -> Unit) {
    val look = historyStatusLook(row.status)
    CardRow(modifier, height = 58.dp, onClick = onClick, description = "${row.title}. ${row.sub}. ${look.label.lowercase()}") {
        Well(row.icon, size = 40.dp, light = true, iconSize = if (row.icon.startsWith("ui:")) 32.dp else 24.dp)
        RowText(row.title, row.sub)
        // history.png / history.html: the row's status is the plain 22 dp Tag (`.tag moss`, `.tag stone`).
        StatusTag(look.label, look.verb, dots = look.dots)
    }
}

// ---- The detail half sheet ----

/** One key / value line of a history detail. */
@Immutable data class HistoryFieldUi(val label: String, val value: String)

/** The read-only detail of one history row. */
@Immutable data class HistoryDetailUi(
    val id: String,
    /** PS title ("CLAIMED 1,240 KEEP"). */
    val title: String,
    val icon: String,
    val status: HistoryStatus,
    /** Key / value lines ("Where" → "Gold Forge", "When" → "Today 14:02"). */
    val fields: List<HistoryFieldUi>,
    /** The shortened chain signature ("5yLq…9cWm"); null when the row has none. */
    val signature: String? = null,
)

/** The detail sheet's callbacks. */
@Immutable data class HistoryDetailActions(
    val onClose: () -> Unit = {},
    /** COPY the full signature (toast "Signature copied"). */
    val onCopySignature: (String) -> Unit = {},
    /** VIEW the signature in the explorer (existing outbound link flow). */
    val onViewSignature: (String) -> Unit = {},
)

/**
 * The History row detail (SPEC §2.8): a read-only HALF sheet — key / value lines and, where it applies, the chain
 * signature with COPY and VIEW. No new work starts here.
 *
 * Pointer rule: a HALF sheet has no scrim; only the painted frame and its buttons take touches (kit [SheetFrame]).
 */
@Composable fun HistoryDetailSheet(ui: HistoryDetailUi, on: HistoryDetailActions, modifier: Modifier = Modifier) {
    val look = historyStatusLook(ui.status)
    SheetFrame(SheetFrameUi(ui.title, null, SheetSize.HALF, emptyList(), null), onClose = on.onClose, modifier = modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Well(ui.icon, light = true, iconSize = if (ui.icon.startsWith("ui:")) 32.dp else 24.dp)
            StatusTag(look.label, look.verb, tall = true, dots = look.dots)
        }
        ui.fields.forEach { field ->
            Row(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = "${field.label}: ${field.value}" }) {
                PkwText(field.label, PkwTokens.Type.small, Modifier.width(110.dp), color = PkwTokens.Colors.textOnParch2)
                PkwText(field.value, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
            }
        }
        ui.signature?.let { sig ->
            CardRow {
                RowText("Signature", sig)
                SecondaryButton("COPY", { on.onCopySignature(ui.id) }, contentDescription = "Copy the signature")
                SecondaryButton("VIEW", { on.onViewSignature(ui.id) }, verb = Verb.BLUE, contentDescription = "View the signature in the explorer")
            }
        }
    }
}

// ---- Previews (history.png numbers) ----

private val sampleHistory = HistoryUi(
    filter = "all",
    filters = listOf(FilterChipUi("all", "ALL"), FilterChipUi("goldforge", "GOLD FORGE", icon = "keep"), FilterChipUi("workshop", "WORKSHOP", icon = "ui:workshop-menu"),
        FilterChipUi("lodge", "LODGE", icon = "ui:lodge-menu"), FilterChipUi("berth", "BERTH"), FilterChipUi("market", "MARKET", icon = "ui:market-menu"),
        FilterChipUi("islands", "ISLANDS"), FilterChipUi("purchases", "PURCHASES")),
    needsYou = listOf(HistoryRowUi("n1", "gem-32", "Gems purchase not finished", "Gold Forge · not sent yet", HistoryStatus.NEEDS_YOU, sampleLink("goldforge.gems"))),
    groups = listOf(
        HistoryGroupUi("today", "TODAY", listOf(
            HistoryRowUi("h1", "keep", "Claimed 1,240 KEEP", "Gold Forge · 14:02", HistoryStatus.SENT, null),
            HistoryRowUi("h2", "gem-32", "Bought 500 Gems", "Gold Forge · 500 KEEP · 13:40", HistoryStatus.SENT, null),
            HistoryRowUi("h3", "skr", "Bid 150 SKR on Spot 142", "Seeker Island · 10:12", HistoryStatus.HELD, null))),
        HistoryGroupUi("yesterday", "YESTERDAY", listOf(
            HistoryRowUi("h4", "ui:navigation-kit", "Crafted a Route Compass", "Workshop · 18:21", HistoryStatus.DONE, null),
            HistoryRowUi("h5", "ui:lodge-menu", "Expedition to Glasswake 2", "Exploration Lodge · 11:05", HistoryStatus.RETURNED, null),
            HistoryRowUi("h6", "ui:crystal-fragments", "Sold 3 Frostglass", "Market · 0.02 SOL · 09:47", HistoryStatus.SENT, null))),
        HistoryGroupUi("earlier", "EARLIER", listOf(
            HistoryRowUi("h7", "itm_deed_earth", "Land deed: Ironhold", "Purchases · 0.5 SOL · 21 Sep", HistoryStatus.SENT, null),
            HistoryRowUi("h8", "ui:expedition-kit", "Starter boat installed", "Berth · 19 Sep", HistoryStatus.PENDING, null))),
    ),
    hasMore = false, load = LoadState.Ready,
)

@Preview(name = "History (history.png)", widthDp = 412, heightDp = 915)
@Composable private fun HistoryPreview() { HubPreviewStage { HistorySheet(sampleHistory, HistoryActions(), Modifier.fillMaxSize()) } }

@Preview(name = "History: empty", widthDp = 412, heightDp = 915)
@Composable private fun HistoryEmptyPreview() { HubPreviewStage { HistorySheet(sampleHistory.copy(needsYou = emptyList(), groups = emptyList()), HistoryActions(), Modifier.fillMaxSize()) } }

@Preview(name = "History: error, stale groups dimmed", widthDp = 412, heightDp = 915)
@Composable private fun HistoryErrorPreview() {
    HubPreviewStage { HistorySheet(sampleHistory.copy(load = LoadState.Error("Can't reach your history.", asOf = "14:02")), HistoryActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "History: loading more", widthDp = 412, heightDp = 915)
@Composable private fun HistoryMorePreview() { HubPreviewStage { HistorySheet(sampleHistory.copy(hasMore = true, loadingMore = true), HistoryActions(), Modifier.fillMaxSize()) } }

@Preview(name = "History: first load", widthDp = 412, heightDp = 915)
@Composable private fun HistoryLoadingPreview() {
    HubPreviewStage { HistorySheet(sampleHistory.copy(needsYou = emptyList(), groups = emptyList(), load = LoadState.Loading), HistoryActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "History detail (half sheet)", widthDp = 412, heightDp = 460)
@Composable private fun HistoryDetailPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF2F4A2A)), contentAlignment = Alignment.BottomCenter) {
        HistoryDetailSheet(HistoryDetailUi("h1", "CLAIMED 1,240 KEEP", "keep", HistoryStatus.SENT,
            listOf(HistoryFieldUi("Where", "Gold Forge"), HistoryFieldUi("When", "Today 14:02"), HistoryFieldUi("Went to", "7xKX…9fQa")),
            signature = "5yLq…9cWm"), HistoryDetailActions(), Modifier.fillMaxWidth().padding(horizontal = 8.dp))
    }
}

