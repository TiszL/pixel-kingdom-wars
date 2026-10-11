package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi

/**
 * Design component: the Feedback card with the round-2 MY REPORTS list (design/final/hub/SPEC.md part two §C;
 * feedback-reports.png), composed WITHOUT editing the committed `FeedbackSheet.kt`: NEW and an open conversation render
 * the committed [FeedbackSheet] unchanged; the MY REPORTS list renders the same frame (the [HubCard] with the CompactHeader
 * Back + "FEEDBACK" + close, the same NEW · MY REPORTS tabs with the red unread badge, the discard confirm layer) around
 * [FeedbackReportsTab] and the WRITE A REPORT footer.
 *
 * Replaces: the committed MY REPORTS list (`ReportsBody`) and its missing footer. The cleaner merge is the slot change in
 * MOUNT-r2-r2-map-hub.md, after which this wrapper can be deleted.
 *
 * Pointer rule: the root is a plain Box (the [HubCard] Column plus the confirm); only painted rows and buttons take
 * touches. The confirm's scrim exists only while [FeedbackUi.discard] is set; the FULL-card scrim is the SheetHost's.
 */
@Composable fun FeedbackSheetR2(ui: FeedbackUi, reports: FeedbackReportsUi, on: FeedbackActions, reportsOn: FeedbackReportsActions,
    modifier: Modifier = Modifier, conversation: (@Composable ColumnScope.() -> Unit)? = null,
    newExtras: (@Composable ColumnScope.() -> Unit)? = null,
    bodyOverride: (@Composable ColumnScope.() -> Unit)? = null,
    reportsExtras: (@Composable ColumnScope.() -> Unit)? = null) {
    if (bodyOverride != null || ui.tab == "NEW" || (ui.openReport != null && conversation != null)) {
        FeedbackSheet(ui, on, modifier, conversation, newExtras, bodyOverride)
        return
    }
    val tabs = listOf(
        TabUi("NEW", "info", "NEW", null, false),
        TabUi("MY REPORTS", "replay", "MY REPORTS", badgeCount(ui.unreadReplies)?.let { BadgeUi(it, BadgeTone.COUNT, "${ui.unreadReplies} reports with unread updates") }, false),
    )
    Box(modifier) {
        HubCard(Modifier.fillMaxSize(), tabs = tabs, selectedTab = ui.tab, onTab = on.onTab,
            footer = { FeedbackReportsFooter(reportsOn) },
            header = { CompactHeader("FEEDBACK", "info", on.onClose, onBack = on.onBack) }) {
            ui.notice?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4) }
            FeedbackReportsTab(reports, reportsOn)
            reportsExtras?.invoke(this)
        }
        HubConfirmDialog(ui.discard, on.onDiscardConfirm, on.onDiscardKeep, Modifier.fillMaxSize())
    }
}

// ---- Previews (feedback-reports.png numbers) ----

private val sampleMyReports = FeedbackReportsUi(listOf(
    MyReportRowUi("r5", "BUG", "Map labels overlap", "Sent 3 Oct · waiting", ReportStatus.SENT, 0, null),
    // The server says only that a reply is unread: null draws "…", never an invented count.
    MyReportRowUi("r1", "BUG", "Claim button stays grey", "New reply · 2h ago", ReportStatus.ANSWERED, null, null),
    MyReportRowUi("r2", "IDEA", "Show wall count", "Being read by the team", ReportStatus.READING, 0, null),
    MyReportRowUi("r3", "BUG", "Boat stuck at sea", "Fixed in 0.6.5 · +40 points", ReportStatus.FIXED, 0, "+40"),
    MyReportRowUi("r4", "PAYMENT", "Gems took a minute", "Answered · +20 points", ReportStatus.ANSWERED, 0, "+20"),
), testerPoints = "340", reviewedCount = 6)

private val sampleFeedbackForReports = FeedbackUi(tab = "MY REPORTS", category = null, title = "", body = "", bounds = FeedbackBoundsUi(80, 2000, 4),
    attachments = emptyList(), includeKingdom = false, kingdomName = null, send = MoneylessSendState.IDLE, reports = emptyList(), unreadReplies = 1,
    savedDraft = false)

@Preview(name = "Feedback: MY REPORTS (feedback-reports.png)", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackReportsR2Preview() {
    HubPreviewStage { FeedbackSheetR2(sampleFeedbackForReports, sampleMyReports, FeedbackActions(), FeedbackReportsActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Feedback MY REPORTS: empty / loading / error + NOT SENT", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackReportsStatesPreview() {
    HubPreviewStage {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            FeedbackSheetR2(sampleFeedbackForReports.copy(unreadReplies = 0), FeedbackReportsUi(emptyList(), "0", 0), FeedbackActions(),
                FeedbackReportsActions(), Modifier.weight(1f))
            FeedbackSheetR2(sampleFeedbackForReports, FeedbackReportsUi(emptyList(), null, null, LoadState.Loading), FeedbackActions(),
                FeedbackReportsActions(), Modifier.weight(1f))
            FeedbackSheetR2(sampleFeedbackForReports, sampleMyReports.copy(load = LoadState.Error("Can't reach your reports.", asOf = "14:02"),
                reports = sampleMyReports.reports + MyReportRowUi("r6", "OTHER", "Music too loud", "Saved on this phone", ReportStatus.NOT_SENT, 0, null)),
                FeedbackActions(), FeedbackReportsActions(), Modifier.weight(1f))
        }
    }
}
