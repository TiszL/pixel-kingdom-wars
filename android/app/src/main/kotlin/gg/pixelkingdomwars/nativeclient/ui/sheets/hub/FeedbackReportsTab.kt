package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN

/**
 * Design component: Feedback › MY REPORTS (design/final/hub/SPEC.md part two §C; feedback-reports.png): your reports,
 * their state, the team's replies and tester points. The points card 84 (PS 16 "340" + "tester points", VT 18 how points
 * work), YOUR REPORTS "newest first": CardRows 64 with the category Tag (BUG red, IDEA blue, PAYMENT gold with ink text,
 * OTHER stone), the VT 20 title (one line), the VT 18 state line, the right status Tag (READING stone, FIXED moss, DONE
 * moss, SENT stone, NOT SENT red) or a red unread count, and a chevron → the conversation; unread rows use the `unread`
 * look and pop to the top. "Only you and the review team see these." Footer gold WRITE A REPORT "opens NEW".
 * The tab keeps its red badge while an unread reply exists (the card's tab strip).
 */

/** One of YOUR REPORTS (part two §C `ReportRowUi`; named apart from the committed list row `ReportRowUi`). */
@Immutable data class MyReportRowUi(
    val id: String,
    /** "BUG", "IDEA", "PAYMENT", "OTHER". */
    val category: String,
    /** "Claim button stays grey" (one line, ellipsis). */
    val title: String,
    /** "New reply · 2h ago", "Fixed in 0.6.5 · +40 points", "Saved on this phone" (NOT SENT). */
    val stateLine: String,
    val status: ReportStatus,
    /** Unread replies: a red count in place of the status tag ([reportUnreadBadge]). The server sends only whether a reply
     *  is unread, so null = unread with no count ("…"); 0 = none. */
    val unread: Int?,
    /** Points this report earned ("+40"); null when none yet. Read by screen readers (the state line carries it visibly). */
    val points: String?,
)

/** Everything MY REPORTS draws (part two §C: `reports`, `testerPoints`, `reviewedCount`, plus the read state). */
@Immutable data class FeedbackReportsUi(
    /** Newest first as the server gives them ([orderReports] lifts the unread ones). */
    val reports: List<MyReportRowUi>,
    /** "340"; null reads "…". */
    val testerPoints: String?,
    /** Reports reviewed so far (the card line); null drops the count. */
    val reviewedCount: Int?,
    val load: LoadState = LoadState.Ready,
)

/** MY REPORTS callbacks (part two §C; the tab, Back and close are the card's [FeedbackActions]). */
@Immutable data class FeedbackReportsActions(
    /** A row: its conversation (sets `FeedbackUi.openReport`). */
    val onReport: (String) -> Unit = {},
    /** WRITE A REPORT: switch to NEW. */
    val onWrite: () -> Unit = {},
    val onRetry: () -> Unit = {},
    /** The error row's Report link (a report about this screen). */
    val onReportProblem: () -> Unit = {},
)

/** The VT 18 line of the points card. */
fun testerPointsLine(reviewedCount: Int?): String =
    (if (reviewedCount != null) "From $reviewedCount reviewed reports. " else "") + "Points come after the team reads a report."

/**
 * The MY REPORTS body. Wire it as the Feedback card's MY REPORTS branch with [FeedbackReportsFooter] ([FeedbackSheetR2],
 * or the slot change in MOUNT-r2-r2-map-hub.md).
 *
 * Pointer rule: only the painted rows and buttons take touches; nothing here is full-screen or a scrim.
 */
@Composable fun ColumnScope.FeedbackReportsTab(ui: FeedbackReportsUi, on: FeedbackReportsActions) {
    val view = boardView(ui.load, ui.reports.isNotEmpty())
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        (ui.load as? LoadState.Error)?.let { ErrorRow(it, on.onRetry, on.onReportProblem) }
        val points = if (view == BoardView.SKELETON) UNKNOWN else ui.testerPoints ?: UNKNOWN
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth().heightIn(min = 84.dp)
            .clearAndSetSemantics { contentDescription = "$points tester points. ${testerPointsLine(ui.reviewedCount)}" }, blocksScene = false) {
            Row(Modifier.fillMaxWidth().padding(6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column {
                    PkwText(points, PkwTokens.Type.numeralL, color = PkwTokens.Colors.textOnParch)
                    PkwText("tester points", PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch)
                }
                PkwText(testerPointsLine(ui.reviewedCount), PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2, maxLines = 3)
            }
        }
        SectionHeader("YOUR REPORTS", note = "newest first")
        when {
            view == BoardView.SKELETON -> repeat(3) { SkeletonRow(height = 64.dp) }
            ui.reports.isEmpty() -> HubEmptyState("No reports yet", "Tell us what you see", Modifier.padding(top = 24.dp), icon = "info")
            else -> orderReports(ui.reports) { if (reportUnreadBadge(it.unread) != null) 1 else 0 }.forEach { ReportRow(it) { on.onReport(it.id) } }
        }
        PkwText("Only you and the review team see these.", PkwTokens.Type.small, Modifier.fillMaxWidth().padding(top = 6.dp),
            color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
    }
}

/** The MY REPORTS footer: gold WRITE A REPORT "opens NEW" (the card's footer row). */
@Composable fun RowScope.FeedbackReportsFooter(on: FeedbackReportsActions) {
    PrimaryButton("WRITE A REPORT", on.onWrite, Modifier.weight(1f), sub = "opens NEW")
}

/** One report row (64): category tag + VT 20 title, VT 18 state line, the status tag or the red unread count, chevron. */
@Composable private fun ReportRow(row: MyReportRowUi, onClick: () -> Unit) {
    val look = reportStatusLook(row.status)
    val unread = reportUnreadBadge(row.unread)
    val said = listOfNotNull(row.category.lowercase(), row.title, row.stateLine, unread?.description ?: look.label.lowercase(),
        row.points?.let { "$it points" }).joinToString(". ")
    CardRow(variant = if (unread != null) RowVariant.UNREAD else RowVariant.PLAIN, height = 64.dp, onClick = onClick, description = said) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatusTag(row.category.uppercase(), reportCategoryVerb(row.category))
                PkwText(row.title, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = PkwTokens.Colors.textOnParch)
            }
            PkwText(row.stateLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
        if (unread != null) Badge(unread)
        else StatusTag(look.label, look.verb)
        RowChevron()
    }
}
