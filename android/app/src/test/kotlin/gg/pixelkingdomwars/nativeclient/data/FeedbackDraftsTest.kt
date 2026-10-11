package gg.pixelkingdomwars.nativeclient.data

import org.junit.Assert.*
import org.junit.Test

/** Owner report 0.5.4: "players can't send feedback". Back from the form threw the typed report
 * away, and a disabled Submit gave no reason. These pin the two rules that answer it. */
class FeedbackDraftsTest {
    private val cfg = FeedbackBounds(listOf("bug", "idea"), 80, 10, 2000, 2000, 2, 384, 120, 2, 100, 100, 64, 4096)
    private val ready = FeedbackReportDraft("bug", "Walls cannot be built", "Tapping the wall card does nothing", includeBase = true)

    @Test fun `typed report outlives the screen until it is sent or discarded`() {
        val drafts = FeedbackDrafts(); drafts.keepReport(ready)
        // A second screen instance (Back, then Player feedback again) starts from the same holder.
        assertEquals(ready, drafts.report); assertTrue(drafts.report.hasText)
        drafts.keepReport(FeedbackReportDraft()); assertFalse(drafts.report.hasText)
    }
    @Test fun `only words make a draft worth offering back`() {
        assertFalse(FeedbackReportDraft(category = "bug", includeBase = true).hasText)
        assertFalse(FeedbackReportDraft(title = "  ", body = "\n").hasText)
        assertTrue(FeedbackReportDraft(body = "x").hasText)
    }
    @Test fun `reply text stays with its own conversation and blank text forgets it`() {
        val drafts = FeedbackDrafts(); drafts.keepReply("a", "Still broken after the update")
        assertEquals("Still broken after the update", drafts.reply("a")); assertEquals("", drafts.reply("b"))
        drafts.keepReply("a", " "); assertEquals("", drafts.reply("a"))
    }
    // A sent report offered back as "Continue draft report" invites a duplicate; text typed later must survive.
    @Test fun `acknowledged words stop being a draft even if a box was ticked since Submit`() {
        val drafts = FeedbackDrafts(); drafts.keepReport(ready.copy(title = " ${ready.title} ", includeBase = false))
        drafts.retireReport(ready.title, ready.body) // the repository passes the server's trimmed copy
        assertEquals(FeedbackReportDraft(), drafts.report)
    }
    @Test fun `words that differ from what was sent are a new draft and stay`() {
        val later = ready.copy(body = ready.body + ", and gates too"); val drafts = FeedbackDrafts(); drafts.keepReport(later)
        drafts.retireReport(ready.title, ready.body); assertEquals(later, drafts.report)
    }
    @Test fun `a saved screen copy restores a new process but never a report sent while the screen was away`() {
        assertEquals(ready, FeedbackDrafts().restoreReport(ready)) // process death: the holder is new and knows nothing
        val drafts = FeedbackDrafts(); drafts.keepReport(ready); drafts.retireReport(ready.title, ready.body)
        assertEquals(FeedbackReportDraft(), drafts.restoreReport(ready)); assertFalse(drafts.report.hasText)
    }
    @Test fun `only the reply text that was sent is forgotten`() {
        val drafts = FeedbackDrafts(); drafts.keepReply("a", "Still broken "); drafts.keepReply("b", "Still broken, and one more thing")
        drafts.retireReply("a", "Still broken"); drafts.retireReply("b", "Still broken"); drafts.retireReply("c", "")
        assertEquals("", drafts.reply("a")); assertEquals("Still broken, and one more thing", drafts.reply("b"))
    }
    @Test fun `submit names the first thing still missing in form order`() {
        fun why(draft: FeedbackReportDraft, required: Boolean = false, recurrence: Boolean = false) = feedbackSubmitBlocker(cfg, draft, required, recurrence)
        assertNull(why(ready))
        assertEquals("Feedback limits are unavailable. Update game content.", feedbackSubmitBlocker(null, ready, false, false))
        assertEquals("Choose a category.", why(ready.copy(category = "")))
        assertEquals("Add a title.", why(ready.copy(title = "  ")))
        assertEquals("Shorten the title to 80 characters.", why(ready.copy(title = "t".repeat(81))))
        // Bounds are the server's, after trimming: padding cannot reach the minimum.
        assertEquals("Describe what happened in at least 10 characters.", why(ready.copy(body = "  too short    ")))
        assertEquals("Shorten the details to 2000 characters.", why(ready.copy(body = "b".repeat(2001))))
        assertNull(why(ready.copy(title = " " + "t".repeat(80) + " ", body = "b".repeat(2000))))
        assertEquals("Confirm this closed issue is happening again.", why(ready, required = true))
        assertNull(why(ready, required = true, recurrence = true))
    }
}
