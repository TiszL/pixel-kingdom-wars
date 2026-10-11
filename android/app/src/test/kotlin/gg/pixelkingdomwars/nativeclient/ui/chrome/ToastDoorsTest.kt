package gg.pixelkingdomwars.nativeclient.ui.chrome

import gg.pixelkingdomwars.nativeclient.data.FeedbackDrafts
import gg.pixelkingdomwars.nativeclient.data.FeedbackReportDraft
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import org.junit.Assert.*
import org.junit.Test

/** Hub SPEC §3.2: the error toast's "Report" opens Feedback prefilled, and a GO opens its place. The app-wide layer draws
 * a door only while one is bound, so a binding must say truthfully whether it is live: a door that stays drawn after its
 * screen is gone would be a dead control, and an old screen's late dispose must not switch off the newer screen's door.
 * The prefill must never cost a player words they already typed (0.5.4: Back from the form discarded the report). */
class ToastDoorsTest {
    @Test fun `a bound Report door receives the toast sentence and closing it unbinds`() {
        val got = mutableListOf<String>()
        val binding = ToastDoors.bindReport { got += it; true }
        try {
            assertTrue("the layer may draw Report now", ToastDoors.reportBound.value)
            assertTrue(ToastDoors.report("Wallet didn't answer. Nothing was sent."))
            assertEquals(listOf("Wallet didn't answer. Nothing was sent."), got)
        } finally { binding.close() }
        assertFalse("the layer must stop drawing Report once nothing can open Feedback", ToastDoors.reportBound.value)
        assertFalse("an unbound door says it did not open", ToastDoors.report("again"))
        assertEquals("nothing reaches a closed handler", 1, got.size)
    }

    @Test fun `report is false when nothing is bound or the bound handler refused`() {
        assertFalse(ToastDoors.reportBound.value)
        assertFalse(ToastDoors.report("Report failed"))
        val binding = ToastDoors.bindReport { false }
        try {
            assertFalse("a refusing handler is reported as not opened", ToastDoors.report("Report failed"))
        } finally { binding.close() }
    }

    @Test fun `a stale Report binding closing late leaves the newer door bound`() {
        val opened = mutableListOf<String>()
        val old = ToastDoors.bindReport { opened += "old"; true }
        val newer = ToastDoors.bindReport { opened += "newer"; true }
        try {
            old.close()
            assertTrue("the old screen's dispose must not unbind the screen that replaced it", ToastDoors.reportBound.value)
            assertTrue(ToastDoors.report("x"))
            assertEquals("only the current handler opens", listOf("newer"), opened)
        } finally { newer.close() }
        assertFalse(ToastDoors.reportBound.value)
    }

    @Test fun `a GO door opens the feature and a stale close leaves the newer one bound`() {
        val opened = mutableListOf<FeatureId>()
        assertFalse("no GO is drawn before Home binds one", ToastDoors.goBound.value)
        assertFalse(ToastDoors.go(FeatureId("lodge.underway")))
        val old = ToastDoors.bindGo { opened += it; true }
        val newer = ToastDoors.bindGo { opened += it; true }
        try {
            old.close()
            assertTrue(ToastDoors.goBound.value)
            assertTrue(ToastDoors.go(FeatureId("lodge.underway")))
            assertEquals(listOf(FeatureId("lodge.underway")), opened)
        } finally { newer.close() }
        assertFalse("leaving Home takes GO off every toast", ToastDoors.goBound.value)
        assertFalse(ToastDoors.go(FeatureId("lodge.underway")))
    }

    @Test fun `a toast report never overwrites words the player already typed`() {
        assertNull("a typed title is the player's", toastReportDraft(FeedbackReportDraft("idea", "Map is slow", "", false), "Report failed", listOf("bug")))
        assertNull("typed details are the player's", toastReportDraft(FeedbackReportDraft("", "", "It froze twice", false), "Report failed", listOf("bug")))
        val drafts = FeedbackDrafts()
        val typed = FeedbackReportDraft("idea", "Map is slow", "Zooming stutters", true)
        drafts.keepReport(typed)
        assertFalse(prefillToastReport(drafts, "Wallet didn't answer. Nothing was sent.", listOf("bug")))
        assertEquals("Feedback opens on what the player wrote", typed, drafts.report)
    }

    @Test fun `a toast report picks the catalogue's bug category and carries the sentence as the details`() {
        val draft = requireNotNull(toastReportDraft(FeedbackReportDraft(includeBase = true), "  Wallet didn't answer. Nothing was sent. ",
            listOf("idea", "Bug", "other"))) { "an empty draft is prefilled" }
        assertEquals("the catalogue's own id, matched without case, so Submit accepts it", "Bug", draft.category)
        assertEquals("Wallet didn't answer. Nothing was sent.", draft.body)
        assertEquals("the player names the report", "", draft.title)
        assertTrue("the include-my-base choice stays the player's", draft.includeBase)
        val chosenOnly = requireNotNull(toastReportDraft(FeedbackReportDraft(category = "idea"), "Report failed", listOf("bug", "idea")))
        assertEquals("a category alone is not words, so the toast's report replaces it", "bug", chosenOnly.category)
    }

    @Test fun `a catalogue without a bug category leaves the category for the player`() {
        val draft = requireNotNull(toastReportDraft(FeedbackReportDraft(), "Report failed", listOf("idea", "payment", "other")))
        assertEquals("never a category the server would refuse", "", draft.category)
        assertEquals("", requireNotNull(toastReportDraft(FeedbackReportDraft(), "Report failed", emptyList())).category)
    }

    @Test fun `prefill stores the toast report in the session drafts`() {
        val drafts = FeedbackDrafts()
        assertTrue(prefillToastReport(drafts, "Report failed", listOf("bug", "idea")))
        assertEquals(FeedbackReportDraft("bug", "", "Report failed", false), drafts.report)
    }
}
