package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.badgeCount
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/**
 * Design component: Feedback (design/final/hub/feedback.png, SPEC §2.7): report a bug or an idea with a picture.
 * Destination: `Feedback` (FULL card, child: Back returns to Settings). Tabs NEW · MY REPORTS. Reached in one tap from
 * "Report" on every error toast or error row (category BUG, the screen captured before the card opened, the toast text
 * prefilled), or in three from Settings › HELP › FEEDBACK.
 */

/** Where a feedback send stands (no money moves, so no wallet stages). */
enum class MoneylessSendState { IDLE, SENDING, SENT, FAILED }

/** The server's bounds; null = not given (no counter maximum, no cap). */
@Immutable data class FeedbackBoundsUi(val titleMax: Int?, val bodyMax: Int?, val maxPictures: Int?)

/** One attached picture (the Report capture or a picked photo). */
@Immutable data class AttachmentUi(
    val id: String,
    /** The 72 × 128 thumbnail; null draws an empty well. */
    val thumb: ImageBitmap?,
    /** Will be sent (green ✓); a tap toggles it. */
    val selected: Boolean,
    /** Screen-reader text ("Screen from the Gold Forge"). */
    val description: String,
)

/** One of MY REPORTS. */
@Immutable data class ReportRowUi(
    val id: String,
    val title: String,
    /** "In review · 20 points". */
    val statusLine: String,
    /** Unread replies (red count badge, [reportUnreadBadge]). The server sends only whether a reply is unread, so null =
     *  unread with no count ("…"); 0 = none. */
    val unread: Int?,
)

/** Everything Feedback draws (SPEC §2.7 State; fields after `savedDraft` were added with defaults). */
@Immutable data class FeedbackUi(
    /** "NEW" or "MY REPORTS". */
    val tab: String,
    /** "BUG", "IDEA", "PAYMENT", "OTHER"; null until picked. */
    val category: String?,
    val title: String,
    val body: String,
    val bounds: FeedbackBoundsUi,
    val attachments: List<AttachmentUi>,
    val includeKingdom: Boolean,
    /** "Ironhold"; null hides the kingdom toggle. */
    val kingdomName: String?,
    val send: MoneylessSendState,
    val reports: List<ReportRowUi>,
    /** Unread replies across reports (the MY REPORTS tab badge). */
    val unreadReplies: Int,
    /** The draft was restored from the saved request (FAILED keeps it). */
    val savedDraft: Boolean,
    val categories: List<FilterChipUi> = listOf("BUG", "IDEA", "PAYMENT", "OTHER").map { FilterChipUi(it, it) },
    /** "Discard this report?" being shown; null when none (see [feedbackNeedsDiscardConfirm]). */
    val discard: ConfirmUi? = null,
    /** The open report (MY REPORTS conversation); null shows the list. */
    val openReport: String? = null,
    /** The VT 18 explainer beside the attachments. */
    val attachLine: String = "Choose pictures to share with the review team.",
    val sendBlockedReason: String? = null,
    val showSend: Boolean = true,
    val notice: String? = null,
)

/** Feedback callbacks. */
@Immutable data class FeedbackActions(
    val onTab: (String) -> Unit = {},
    val onCategory: (String) -> Unit = {},
    /** Already clamped to the server bound ([clampInput]). */
    val onTitle: (String) -> Unit = {},
    val onBody: (String) -> Unit = {},
    val onToggleAttachment: (String) -> Unit = {},
    /** Open the Android photo picker. */
    val onAddPicture: () -> Unit = {},
    val onIncludeKingdom: (Boolean) -> Unit = {},
    val onSend: () -> Unit = {},
    val onOpenReport: (String) -> Unit = {},
    /** Back / Close: with a draft the caller raises [FeedbackUi.discard] first ([feedbackNeedsDiscardConfirm]). */
    val onBack: () -> Unit = {},
    val onClose: () -> Unit = {},
    val onDiscardKeep: () -> Unit = {},
    val onDiscardConfirm: () -> Unit = {},
)

/** The SEND reason shown under a disabled SEND; null when SEND may go. */
fun feedbackSendReason(ui: FeedbackUi): String? = when {
    ui.sendBlockedReason != null -> ui.sendBlockedReason
    ui.category == null -> "Pick what happened first"
    ui.title.isBlank() -> "Add a short title"
    !feedbackCanSend(ui) && ui.send == MoneylessSendState.IDLE -> "Too long for the review team"
    else -> null
}

/**
 * The Feedback card. [conversation] is the existing MY REPORTS conversation body (`community/FeedbackScreen.kt`),
 * shown when [FeedbackUi.openReport] is set.
 * Success: the body becomes "Sent. We'll reply in MY REPORTS." with a green DONE and the card closes after 900 ms.
 *
 * Pointer rule: the root is a plain Box (the [HubCard] Column plus the discard confirm); only painted fields, tiles,
 * rows and buttons take touches. The confirm's scrim exists only while [FeedbackUi.discard] is set.
 */
@Composable fun FeedbackSheet(ui: FeedbackUi, on: FeedbackActions, modifier: Modifier = Modifier,
    conversation: (@Composable ColumnScope.() -> Unit)? = null,
    newExtras: (@Composable ColumnScope.() -> Unit)? = null,
    bodyOverride: (@Composable ColumnScope.() -> Unit)? = null) {
    val close by rememberUpdatedState(on.onClose)
    if (ui.send == MoneylessSendState.SENT) LaunchedEffect(Unit) { delay(HubMotion.FEEDBACK_SENT_CLOSE.toLong()); close() }
    val tabs = listOf(
        TabUi("NEW", "info", "NEW", null, false),
        TabUi("MY REPORTS", "replay", "MY REPORTS", badgeCount(ui.unreadReplies)?.let { BadgeUi(it, BadgeTone.COUNT, "${ui.unreadReplies} reports with unread updates") }, false),
    )
    Box(modifier) {
        HubCard(Modifier.fillMaxSize(), tabs = tabs, selectedTab = ui.tab, onTab = on.onTab,
            footer = if (ui.tab != "NEW" || !ui.showSend || bodyOverride != null) null else ({
                when (ui.send) {
                    MoneylessSendState.IDLE -> {
                        val reason = feedbackSendReason(ui)
                        PrimaryButton("SEND", on.onSend, Modifier.weight(1f), sub = "to the review team",
                            state = if (reason == null) CommandState.ENABLED else CommandState.DISABLED, reason = reason)
                    }
                    MoneylessSendState.SENDING -> PrimaryButton("Sending", {}, Modifier.weight(1f), state = CommandState.BUSY)
                    MoneylessSendState.SENT -> PrimaryButton("DONE", on.onClose, Modifier.weight(1f), verb = Verb.GREEN)
                    MoneylessSendState.FAILED -> PrimaryButton("RETRY", on.onSend, Modifier.weight(1f), verb = Verb.RED, sub = "your draft is saved",
                        state = if (feedbackSendReason(ui) == null) CommandState.ENABLED else CommandState.DISABLED, reason = feedbackSendReason(ui))
                }
            }),
            header = { CompactHeader("FEEDBACK", "info", on.onClose, onBack = on.onBack) }) {
            ui.notice?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4) }
            when {
                bodyOverride != null -> bodyOverride()
                ui.tab != "NEW" -> ReportsBody(ui, on, conversation)
                ui.send == MoneylessSendState.SENT -> SentBody()
                else -> NewBody(ui, on, newExtras)
            }
        }
        HubConfirmDialog(ui.discard, on.onDiscardConfirm, on.onDiscardKeep, Modifier.fillMaxSize())
    }
}

@Composable private fun ColumnScope.NewBody(ui: FeedbackUi, on: FeedbackActions, extras: (@Composable ColumnScope.() -> Unit)?) {
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionHeader("WHAT HAPPENED?")
        FilterChipStrip(ui.categories, ui.category, on.onCategory)
        HubTextField(ui.title, { on.onTitle(clampInput(it, ui.bounds.titleMax)) }, "Title", placeholder = "A short title",
            counter = counterText(ui.title.length, ui.bounds.titleMax))
        HubTextField(ui.body, { on.onBody(clampInput(it, ui.bounds.bodyMax)) }, "Details", placeholder = "What did you do, and what happened?",
            counter = counterText(ui.body.length, ui.bounds.bodyMax), area = true)
        SectionHeader("ATTACHED", note = "only the review team sees these")
        // feedback.png: the VT 18 explainer sits beside the tiles, not under them; the tiles scroll within their half.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.weight(1f, fill = false).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ui.attachments.forEach { AttachmentTile(it) { on.onToggleAttachment(it.id) } }
                val cap = ui.bounds.maxPictures
                if (cap == null || ui.attachments.size < cap) AddTile(on.onAddPicture)
            }
            PkwText(ui.attachLine, PkwTokens.Type.small, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch2, maxLines = 5)
        }
        ui.kingdomName?.let { name ->
            ToggleRow("Include my kingdom", "$name · helps us find the problem", ui.includeKingdom, on.onIncludeKingdom)
        }
        extras?.invoke(this)
        PkwText("Tester points are given after review.", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2,
            textAlign = TextAlign.Center)
    }
}

/** A 72 × 128 capture thumbnail, 3 dp ink border, green ✓ badge while selected; a tap toggles it. */
@Composable private fun AttachmentTile(ui: AttachmentUi, onToggle: () -> Unit) {
    Box {
        Box(Modifier.size(72.dp, 128.dp)
            .clearAndSetSemantics {
                contentDescription = ui.description + if (ui.selected) ", attached" else ", not attached"
                role = Role.Checkbox; selected = ui.selected
                onClick(label = null, action = { onToggle(); true })
            }
            .clickable(role = Role.Checkbox, onClick = onToggle)
            .background(PkwTokens.Colors.ink).padding(3.dp).background(HubColors.wellDark)) {
            ui.thumb?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, filterQuality = FilterQuality.None,
                alpha = if (ui.selected) 1f else 0.45f) }
        }
        // The green ✓ badge (drawn check glyph: the VT323 face has no check mark).
        if (ui.selected) Box(Modifier.align(Alignment.TopEnd).offset(x = (-4).dp, y = 4.dp).size(24.dp).background(PkwTokens.Colors.ink)
            .padding(2.dp).background(PkwTokens.Colors.green.face), contentAlignment = Alignment.Center) {
            PkwIcon("shape:check", 16.dp, tint = PkwTokens.Colors.label)
        }
    }
}

/** The dashed 3 dp `#C4A464` ADD tile (plus 24 + PS 11): opens the photo picker. */
@Composable private fun AddTile(onAdd: () -> Unit) {
    Column(Modifier.size(72.dp, 128.dp)
        .clearAndSetSemantics { contentDescription = "Add a picture"; role = Role.Button; onClick(label = null, action = { onAdd(); true }) }
        .clickable(role = Role.Button, onClick = onAdd)
        .drawBehind {
            val w = 3.dp.toPx()
            drawRect(PkwTokens.Colors.parchmentLo, topLeft = androidx.compose.ui.geometry.Offset(w / 2f, w / 2f),
                size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w),
                style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))))
        }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        PkwIcon("plus", 24.dp)
        PkwText("ADD", PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
    }
}

@Composable private fun ColumnScope.SentBody() {
    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
        Plate(PlateKind.CREAM, Modifier.fillMaxWidth(), tint = HubColors.rowReady, blocksScene = false) {
            Column(Modifier.fillMaxWidth().padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PkwIcon("shape:check", 48.dp, tint = PkwTokens.Colors.green.face)
                PkwText("Sent. We'll reply in MY REPORTS.", PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                StatusTag("DONE", Verb.GREEN, tall = true)
            }
        }
    }
}

@Composable private fun ColumnScope.ReportsBody(ui: FeedbackUi, on: FeedbackActions, conversation: (@Composable ColumnScope.() -> Unit)?) {
    if (ui.openReport != null && conversation != null) {
        Column(Modifier.fillMaxWidth().weight(1f), content = conversation)
        return
    }
    Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (ui.reports.isEmpty()) HubEmptyState("No reports yet", "What you send shows here, with the team's replies.", Modifier.padding(top = 60.dp), icon = "info")
        ui.reports.forEach { report ->
            val unread = reportUnreadBadge(report.unread)
            CardRow(onClick = { on.onOpenReport(report.id) }, description = listOfNotNull(report.title, report.statusLine,
                unread?.description).joinToString(". ")) {
                RowText(report.title, report.statusLine)
                unread?.let { Badge(it) }
                RowChevron()
            }
        }
    }
}

// ---- Previews (feedback.png numbers) ----

private val sampleFeedback = FeedbackUi(
    tab = "NEW", category = "BUG", title = "Claim button stays grey",
    body = "At the Gold Forge the CLAIM tab says ready, but the button stays grey after I come back from my wallet.",
    bounds = FeedbackBoundsUi(80, 2000, 4), attachments = listOf(AttachmentUi("capture", null, true, "Screen from the Gold Forge")),
    includeKingdom = true, kingdomName = "Ironhold", send = MoneylessSendState.IDLE,
    reports = listOf(ReportRowUi("r1", "Lodge timer jumps back", "Fixed · 40 points", null), ReportRowUi("r2", "Wall drag skips a tile", "In review", 0)),
    unreadReplies = 1, savedDraft = false,
)

@Preview(name = "Feedback (feedback.png)", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackPreview() { HubPreviewStage { FeedbackSheet(sampleFeedback, FeedbackActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Feedback: sending", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackSendingPreview() { HubPreviewStage { FeedbackSheet(sampleFeedback.copy(send = MoneylessSendState.SENDING), FeedbackActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Feedback: sent", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackSentPreview() { HubPreviewStage { FeedbackSheet(sampleFeedback.copy(send = MoneylessSendState.SENT), FeedbackActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Feedback: failed (RETRY, draft saved)", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackFailedPreview() {
    HubPreviewStage { FeedbackSheet(sampleFeedback.copy(send = MoneylessSendState.FAILED, savedDraft = true), FeedbackActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Feedback: empty draft (SEND disabled)", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackBlankPreview() {
    HubPreviewStage { FeedbackSheet(sampleFeedback.copy(category = null, title = "", body = ""), FeedbackActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Feedback: discard confirm", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackDiscardPreview() {
    HubPreviewStage {
        FeedbackSheet(sampleFeedback.copy(discard = ConfirmUi("DISCARD THIS REPORT?", null, null, "Your title and details will be lost.", null, "DISCARD",
            backLabel = "KEEP")), FeedbackActions(), Modifier.fillMaxSize())
    }
}

@Preview(name = "Feedback: MY REPORTS", widthDp = 412, heightDp = 915)
@Composable private fun FeedbackReportsPreview() { HubPreviewStage { FeedbackSheet(sampleFeedback.copy(tab = "MY REPORTS"), FeedbackActions(), Modifier.fillMaxSize()) } }
