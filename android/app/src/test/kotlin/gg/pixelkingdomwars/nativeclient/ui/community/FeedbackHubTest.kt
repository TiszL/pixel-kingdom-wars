package gg.pixelkingdomwars.nativeclient.ui.community

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.FeedbackReport
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import org.junit.Assert.*
import org.junit.Test

class FeedbackHubTest {
    private val bounds = FeedbackBounds(listOf("bug", "idea", "payment", "other"), 80, 12, 2000, 1000, 20, 200, 80, 4, 2000, 2000, 1024, 1048576)
    private val draft = FeedbackReportDraft("bug", "Button does not open", "After selecting the building the button does not open.", true)
    private val id = "00000000-0000-0000-0000-000000000001"
    private val report = FeedbackReport(id, "bug", "A report", "What happened", "new", null, 40, "2026-10-05T00:00:00Z", null, null)
    private fun ui(state: FeedbackState = FeedbackState(loaded = true), limits: FeedbackBounds? = bounds,
        words: FeedbackReportDraft = draft, sending: Boolean = false, failed: Boolean = false, sent: Boolean = false,
        current: Boolean = true, loadingFiles: Boolean = false) = feedbackHubUi(state, limits, words,
        sending = sending, failed = failed, sent = sent, current = current, loadingFiles = loadingFiles)

    @Test fun `catalogue category keys remain exact while labels are capitalized`() {
        val result = ui()
        assertEquals("bug", result.category)
        assertEquals(listOf("bug", "idea", "payment", "other"), result.categories.map { it.id })
        assertEquals(listOf("BUG", "IDEA", "PAYMENT", "OTHER"), result.categories.map { it.label })
    }
    @Test fun `missing limits keep counters unknown and refuse sending`() {
        val result = ui(limits = null)
        assertNull(result.bounds.titleMax)
        assertNull(result.bounds.bodyMax)
        assertNull(result.bounds.maxPictures)
        assertTrue(result.categories.isEmpty())
        assertTrue(feedbackSendReason(result)!!.contains("limits"))
    }
    @Test fun `server body minimum is enforced before send`() {
        assertTrue(feedbackSendReason(ui(words = draft.copy(body = "tiny")))!!.contains("12"))
    }
    @Test fun `valid trimmed report is admitted`() { assertNull(feedbackSendReason(ui())) }
    @Test fun `unsupported category is refused`() {
        assertEquals("Choose a category.", feedbackSendReason(ui(words = draft.copy(category = "UNKNOWN"))))
    }
    @Test fun `busy reader blocks send without changing draft values`() {
        val result = ui(FeedbackState(loaded = true, busy = true))
        assertNotNull(feedbackSendReason(result))
        assertEquals(draft.title, result.title)
        assertEquals(draft.body, result.body)
    }
    @Test fun `file decoding blocks send`() { assertNotNull(feedbackSendReason(ui(loadingFiles = true))) }
    @Test fun `stale owner blocks all new submission`() { assertNotNull(feedbackSendReason(ui(current = false))) }
    @Test fun `sending wins over failed and successful presentation`() {
        assertEquals(MoneylessSendState.SENDING, ui(sending = true, failed = true, sent = true).send)
    }
    @Test fun `saved request is recovery not a second new send`() {
        val saved = SavedFeedback("wallet", "https://example.invalid", id, "report", draft.body, draft.category, draft.title)
        val result = ui(FeedbackState(loaded = true, pending = saved), sent = true)
        assertFalse(result.showSend)
        assertNotEquals(MoneylessSendState.SENT, result.send)
        assertTrue(result.savedDraft)
    }
    @Test fun `success is shown only after explicit confirmed completion`() {
        assertEquals(MoneylessSendState.IDLE, ui(FeedbackState(loaded = true, notice = "Report submitted")).send)
        assertEquals(MoneylessSendState.SENT, ui(sent = true).send)
    }
    @Test fun `attachment copy never claims an automatic capture`() {
        val result = ui()
        assertTrue(result.attachLine.contains("4"))
        assertFalse(result.attachLine.contains("attached"))
    }
    @Test fun `unread report presence is unknown reply count`() {
        val result = feedbackHubReportsUi(FeedbackState(loaded = true, reports = listOf(report.copy(unread = true))))
        assertNull(result.reports.single().unread)
        assertNull(result.testerPoints)
        assertNull(result.reviewedCount)
    }
    @Test fun `read report has no unread badge`() {
        assertEquals(0, feedbackHubReportsUi(FeedbackState(loaded = true, reports = listOf(report))).reports.single().unread)
    }
    @Test fun `points total is not synthesized from a partial report page`() {
        val state = FeedbackState(loaded = true, reports = listOf(report), nextCursor = "more")
        assertNull(feedbackHubReportsUi(state).testerPoints)
        assertNull(feedbackHubReportsUi(state).reviewedCount)
        assertEquals("340", feedbackHubReportsUi(state, testerPoints = "340").testerPoints)
    }
    @Test fun `fixed status and points use server values`() {
        val row = feedbackHubReportsUi(FeedbackState(loaded = true, reports = listOf(report.copy(status = "fixed", fixedRef = "0.7.1")))).reports.single()
        assertEquals(ReportStatus.FIXED, row.status)
        assertTrue(row.stateLine.contains("0.7.1"))
        assertEquals("+40", row.points)
    }
    @Test fun `closed server conversation stays closed`() {
        assertEquals(ReportStatus.CLOSED, feedbackHubReportsUi(FeedbackState(loaded = true, reports = listOf(report.copy(closed = true)))).reports.single().status)
    }
    @Test fun `read failure keeps report rows and error state`() {
        val result = feedbackHubReportsUi(FeedbackState(loaded = true, reports = listOf(report)), error = "Offline")
        assertEquals(1, result.reports.size)
        assertTrue(result.load is LoadState.Error)
    }
    @Test fun `unloaded report list is loading not empty success`() {
        assertTrue(feedbackHubReportsUi(FeedbackState()).load is LoadState.Loading)
    }
    @Test fun `picker ticket cannot cross conversations or epoch`() {
        val owner = Any()
        val ticket = FeedbackPickerTicket(owner, 3, "report-a")
        assertTrue(ticket.isCurrent(owner, 3, "report-a"))
        assertFalse(ticket.isCurrent(owner, 4, "report-a"))
        assertFalse(ticket.isCurrent(owner, 3, "report-b"))
        assertFalse(ticket.isCurrent(Any(), 3, "report-a"))
    }
    @Test fun `action gate rejects stale and busy taps and runs current tap once`() {
        var current = false; var busy = false; var calls = 0; val reasons = mutableListOf<String>()
        val gate = FeedbackActionGate({ current }, { busy }, reasons::add)
        assertFalse(gate.run { calls++ })
        current = true; busy = true
        assertFalse(gate.run { calls++ })
        busy = false
        assertTrue(gate.run { calls++ })
        assertEquals(1, calls)
        assertEquals(2, reasons.size)
    }

    @Test fun `a paused host read is explained as paused not as a changed account`() {
        // "The account changed" would send the player away from a card that only has to wait for the Home host.
        var calls = 0; val reasons = mutableListOf<String>()
        val gate = FeedbackActionGate({ true }, { false }, reasons::add, paused = { true })
        assertFalse(gate.run { calls++ })
        assertEquals(0, calls)
        assertEquals("Feedback is paused while the current action finishes.", reasons.single())
    }

    // ---- Tap routing: Back, Close and the discard confirm ----

    @Test fun `back closes the innermost open layer before the card`() {
        // One Back must never skip past an open confirm or conversation and drop the player out of Feedback.
        assertEquals(FeedbackBackStep.DISMISS_CONFIRM, feedbackBackStep(confirmOpen = true, screenshotOpen = true, conversationOpen = true))
        assertEquals(FeedbackBackStep.CLOSE_SCREENSHOT, feedbackBackStep(confirmOpen = false, screenshotOpen = true, conversationOpen = true))
        assertEquals(FeedbackBackStep.CLOSE_CONVERSATION, feedbackBackStep(confirmOpen = false, screenshotOpen = false, conversationOpen = true))
        assertEquals(FeedbackBackStep.CLOSE_CARD, feedbackBackStep(confirmOpen = false, screenshotOpen = false, conversationOpen = false))
    }
    @Test fun `a hosted card leaves closing to the Home sheet host`() {
        // Hosted, the SheetHost owns Back for the card itself; Feedback takes Back only while its own layer is open.
        assertFalse(feedbackConsumesHostedBack(FeedbackBackStep.CLOSE_CARD))
        assertTrue(feedbackConsumesHostedBack(FeedbackBackStep.CLOSE_CONVERSATION))
        assertTrue(feedbackConsumesHostedBack(FeedbackBackStep.CLOSE_SCREENSHOT))
        assertTrue(feedbackConsumesHostedBack(FeedbackBackStep.DISMISS_CONFIRM))
    }
    @Test fun `closing with unsent words on NEW asks first`() {
        assertTrue(feedbackCloseNeedsConfirm("NEW", draft, hasSavedRequest = false, sent = false))
    }
    @Test fun `closing without words or away from NEW never asks`() {
        // A confirm with nothing to lose, or over a list, is a door that interrupts for no reason.
        assertFalse(feedbackCloseNeedsConfirm("NEW", FeedbackReportDraft(category = "bug", includeBase = true), hasSavedRequest = false, sent = false))
        assertFalse(feedbackCloseNeedsConfirm("MY REPORTS", draft, hasSavedRequest = false, sent = false))
    }
    @Test fun `a sent report or a saved request is never offered for discard`() {
        // Sent words are no longer a draft, and a saved request is resolved on its own card, never erased by Close.
        assertFalse(feedbackCloseNeedsConfirm("NEW", draft, hasSavedRequest = false, sent = true))
        assertFalse(feedbackCloseNeedsConfirm("NEW", draft, hasSavedRequest = true, sent = false))
    }
    @Test fun `discard confirm keeps by default and erases only on DISCARD`() {
        // 0.5.4: leaving Feedback must never cost a player their words; KEEP leaves with them kept.
        val confirm = feedbackDiscardConfirm()
        assertEquals("KEEP", confirm.backLabel)
        assertEquals("DISCARD", confirm.confirmLabel)
        assertTrue(confirm.line.contains("erases"))
        assertTrue(confirm.subLine.orEmpty().contains("keeps"))
    }

    // ---- MY REPORTS rows ----

    @Test fun `a saved unsent report shows as NOT SENT and opens the saved request`() {
        val saved = SavedFeedback("wallet", "https://example.invalid", id, "report", draft.body, draft.category, draft.title)
        val state = FeedbackState(loaded = true, reports = listOf(report.copy(id = "00000000-0000-0000-0000-000000000002")), pending = saved)
        val rows = feedbackHubReportsUi(state).reports
        assertEquals(ReportStatus.NOT_SENT, rows.first().status)
        assertEquals("Saved on this phone", rows.first().stateLine)
        assertEquals(draft.title, rows.first().title)
        assertEquals(2, rows.size)
        // It has no server conversation: a tap must open the saved card, never a conversation GET for an unknown id.
        assertTrue(feedbackRowOpensSavedRequest(id, state))
        assertFalse(feedbackRowOpensSavedRequest("00000000-0000-0000-0000-000000000002", state))
    }
    @Test fun `a saved reply is not drawn as a report row`() {
        val saved = SavedFeedback("wallet", "https://example.invalid", id, "reply", "More details", reportId = "00000000-0000-0000-0000-000000000002")
        assertTrue(feedbackHubReportsUi(FeedbackState(loaded = true, pending = saved)).reports.isEmpty())
    }
    @Test fun `a fixed report stays FIXED after the conversation closes`() {
        // FIXED tells the player the outcome; CLOSED would hide it. Same order as the shared reports mapper.
        val row = feedbackHubReportsUi(FeedbackState(loaded = true, reports = listOf(report.copy(status = "fixed", closed = true, fixedRef = "0.7.1")))).reports.single()
        assertEquals(ReportStatus.FIXED, row.status)
    }
    @Test fun `tester points and earned points read as grouped server amounts`() {
        val result = feedbackHubReportsUi(FeedbackState(loaded = true, reports = listOf(report.copy(points = 1500))), testerPoints = "12340")
        assertEquals("12,340", result.testerPoints)
        assertEquals("+1,500", result.reports.single().points)
        // A malformed total is unknown ("…"), never a number the client made up.
        assertNull(feedbackHubReportsUi(FeedbackState(loaded = true), testerPoints = "-3").testerPoints)
    }
    @Test fun `unread rows say Unread update and the tab counts only flagged reports`() {
        val state = FeedbackState(loaded = true, reports = listOf(report.copy(unread = true), report.copy(id = "00000000-0000-0000-0000-000000000002")))
        assertTrue(feedbackHubReportsUi(state).reports.first().stateLine.startsWith("Unread update"))
        assertEquals(1, ui(state).unreadReplies)
    }
    @Test fun `tab ids are exactly NEW and MY REPORTS`() {
        // The Home sheet host stores these ids; an unknown id falls back to NEW instead of drawing nothing.
        assertEquals(listOf("NEW", "MY REPORTS"), FEEDBACK_TABS)
        assertEquals("NEW", feedbackHubUi(FeedbackState(loaded = true), bounds, draft, tab = "INBOX").tab)
        assertEquals("MY REPORTS", feedbackHubUi(FeedbackState(loaded = true), bounds, draft, tab = "MY REPORTS").tab)
    }
}
