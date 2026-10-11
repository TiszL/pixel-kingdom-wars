package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.FeedbackBounds
import gg.pixelkingdomwars.nativeclient.data.FeedbackReportDraft
import gg.pixelkingdomwars.nativeclient.data.FeedbackState
import gg.pixelkingdomwars.nativeclient.data.feedbackSubmitBlocker
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.groupedAmount
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import java.util.Locale

/** The two Feedback tab ids the designed card draws; a host's tab state uses exactly these. */
internal val FEEDBACK_TABS = listOf("NEW", "MY REPORTS")

internal data class FeedbackPickerTicket(val owner: Any, val epoch: Int, val conversation: String?) {
    fun isCurrent(currentOwner: Any, currentEpoch: Int, currentConversation: String?): Boolean =
        owner === currentOwner && epoch == currentEpoch && conversation == currentConversation
}

/** Admission never retries a request. The repository owns persistence, delivery and reconciliation. */
internal class FeedbackActionGate(private val current: () -> Boolean, private val busy: () -> Boolean,
    private val explain: (String) -> Unit, private val paused: () -> Boolean = { false }) {
    fun run(action: () -> Unit): Boolean {
        val reason = when {
            !current() -> "The account or kingdom changed. Open Feedback again."
            // The Home host holds reads while another owner's action finishes; that is not a changed account.
            paused() -> "Feedback is paused while the current action finishes."
            busy() -> "A feedback request is still finishing. Please wait."
            else -> null
        }
        if (reason != null) { explain(reason); return false }
        action(); return true
    }
}

/** What one Back does in Feedback, innermost layer first. */
internal enum class FeedbackBackStep { DISMISS_CONFIRM, CLOSE_SCREENSHOT, CLOSE_CONVERSATION, CLOSE_CARD }

internal fun feedbackBackStep(confirmOpen: Boolean, screenshotOpen: Boolean, conversationOpen: Boolean): FeedbackBackStep = when {
    confirmOpen -> FeedbackBackStep.DISMISS_CONFIRM
    screenshotOpen -> FeedbackBackStep.CLOSE_SCREENSHOT
    conversationOpen -> FeedbackBackStep.CLOSE_CONVERSATION
    else -> FeedbackBackStep.CLOSE_CARD
}

/** Hosted in a Home sheet, closing the card is the host's Back; Feedback takes Back only for its own open layer. */
internal fun feedbackConsumesHostedBack(step: FeedbackBackStep): Boolean = step != FeedbackBackStep.CLOSE_CARD

/**
 * Close with unsent words on NEW asks first (SPEC §2.7 Discard). A saved request is not a draft: it is resolved on its
 * own card, so closing never offers to erase it.
 */
internal fun feedbackCloseNeedsConfirm(tab: String, draft: FeedbackReportDraft, hasSavedRequest: Boolean, sent: Boolean): Boolean =
    tab == "NEW" && !hasSavedRequest && feedbackNeedsDiscardConfirm(draft.title, draft.body,
        if (sent) MoneylessSendState.SENT else MoneylessSendState.IDLE)

/**
 * The discard confirm. KEEP closes the card and keeps the words in the session's drafts (0.5.4: leaving must never
 * cost a player their report); only DISCARD erases them.
 */
internal fun feedbackDiscardConfirm(): ConfirmUi = ConfirmUi("DISCARD THIS REPORT?", null, null,
    "DISCARD erases your unsent title and details.", "KEEP closes Feedback and keeps them to finish later.", "DISCARD",
    backLabel = "KEEP")

/** A MY REPORTS row that is the phone's saved request has no server conversation; it opens the saved card on NEW. */
internal fun feedbackRowOpensSavedRequest(rowId: String, state: FeedbackState): Boolean =
    state.pending?.requestId == rowId || state.parked.any { it.requestId == rowId }

internal fun feedbackHubUi(
    state: FeedbackState, bounds: FeedbackBounds?, draft: FeedbackReportDraft,
    tab: String = "NEW", attachments: List<AttachmentUi> = emptyList(), kingdomName: String? = null,
    sending: Boolean = false, failed: Boolean = false, sent: Boolean = false,
    current: Boolean = true, loadingFiles: Boolean = false, error: String? = null,
    recurrenceRequired: Boolean = false, recurrence: Boolean = false,
): FeedbackUi {
    val reason = when {
        !current -> "The account or kingdom changed. Open Feedback again."
        state.pending != null -> "Continue your saved request before sending another."
        state.busy || sending -> "A feedback request is still finishing. Please wait."
        loadingFiles -> "Reading the selected screenshots. Please wait."
        else -> feedbackSubmitBlocker(bounds, draft, recurrenceRequired, recurrence)
    }
    val send = when {
        sending -> MoneylessSendState.SENDING
        state.pending != null -> MoneylessSendState.FAILED
        sent -> MoneylessSendState.SENT
        failed -> MoneylessSendState.FAILED
        else -> MoneylessSendState.IDLE
    }
    return FeedbackUi(
        tab = tab.takeIf { it in FEEDBACK_TABS } ?: "NEW",
        category = draft.category.takeIf { it in bounds?.categories.orEmpty() }, title = draft.title, body = draft.body,
        bounds = FeedbackBoundsUi(bounds?.titleMax, bounds?.bodyMax, bounds?.attachmentsMax),
        attachments = attachments, includeKingdom = draft.includeBase, kingdomName = kingdomName,
        send = send, reports = state.reports.map { ReportRowUi(it.id, it.title, it.status, if (it.unread) null else 0) },
        // This field counts loaded reports the server flagged unread, never an invented number of replies.
        unreadReplies = state.reports.count { it.unread }, savedDraft = draft.hasText || state.pending != null,
        categories = bounds?.categories.orEmpty().map { FilterChipUi(it, it.uppercase(Locale.ROOT)) },
        openReport = state.detail?.report?.id,
        attachLine = bounds?.attachmentsMax?.let { "Choose up to $it pictures. Check them for private information before sending." }
            ?: "Screenshot limits are unavailable. Update game content.",
        sendBlockedReason = reason, showSend = state.pending == null,
        notice = listOfNotNull(error, state.notice).distinct().joinToString("\n").takeIf { it.isNotBlank() },
    )
}

/** A page cannot establish either total tester points or a total reviewed count. */
internal fun feedbackHubReportsUi(state: FeedbackState, testerPoints: String? = null,
    reviewedCount: Int? = null, error: String? = null): FeedbackReportsUi {
    // A report or evidence the server has not acknowledged is the phone's saved request: drawn first as NOT SENT.
    val saved = state.pending?.takeIf { it.kind in setOf("report", "evidence") && it.reportReceipt == null && it.evidenceReceipt == null }
    // Dead-end audit 2026-10-06: requests kept aside on this phone are NOT SENT rows too; a tap opens NEW to continue one.
    val kept = state.parked.filter { it.kind in setOf("report", "evidence") && it.reportReceipt == null && it.evidenceReceipt == null }
    val notSent = (listOfNotNull(saved) + kept).map {
        MyReportRowUi(it.requestId, (it.category ?: it.issue?.category ?: "other").uppercase(Locale.ROOT),
            it.title ?: it.issue?.title ?: "Saved report", "Saved on this phone", ReportStatus.NOT_SENT, 0, null)
    }
    val rows = state.reports.map { report ->
        val status = when {
            report.status == "fixed" -> ReportStatus.FIXED
            report.closed || report.status in setOf("rejected", "duplicate") -> ReportStatus.CLOSED
            report.status in setOf("reviewed", "accepted") -> ReportStatus.READING
            else -> ReportStatus.SENT
        }
        val points = report.points.takeIf { it > 0 }?.let { "+${groupedAmount(it.toString())}" }
        val line = listOfNotNull("Unread update".takeIf { report.unread }, report.status.replaceFirstChar { it.titlecase(Locale.ROOT) },
            report.fixedRef?.takeIf { report.status == "fixed" }, points?.let { "$it points" }).joinToString(" · ")
        // The server sends only an unread flag: null draws the "…" badge, never a reply count.
        MyReportRowUi(report.id, report.category.uppercase(Locale.ROOT), report.title, line, status,
            unread = if (report.unread) null else 0, points = points)
    }
    return FeedbackReportsUi(
        reports = notSent + rows,
        testerPoints = groupedAmount(testerPoints), reviewedCount = reviewedCount?.takeIf { it >= 0 },
        load = when { error != null -> LoadState.Error(error); !state.loaded -> LoadState.Loading; else -> LoadState.Ready },
    )
}
