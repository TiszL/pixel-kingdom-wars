package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.ScreenNotice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Where the Kingdom's status lines go (home-budget.png: at rest the permanent HUD is the only chrome; DESIGN-SYSTEM §6
 * Toast). Why it matters: the old status column sat on the scene permanently and broke the owner's 12 % budget, so routine
 * lines must become toasts, each exactly once (a repeated toast on every recomposition would wall the screen) and then be
 * retired with the owner's own callback; while saved payments and receipts must never be turned into a 4 s toast, because a
 * player who misses it would lose sight of money that is still being checked.
 */
class KingdomStatusRoutingTest {
    private val t0 = 1_000_000L

    @Test fun `saved payments, receipts and the content APPLY stay where they are`() {
        assertEquals(KingdomStatusRoute.KEEP, kingdomStatusRoute(KingdomStatusSource.RECOVERY))
        assertEquals(KingdomStatusRoute.KEEP, kingdomStatusRoute(KingdomStatusSource.RECOVERY, error = true))
        assertEquals("an action, not a message", KingdomStatusRoute.KEEP, kingdomStatusRoute(KingdomStatusSource.CONTENT_UPDATE))
    }

    @Test fun `routine lines become toasts and errors become error toasts`() {
        assertEquals(KingdomStatusRoute.TOAST, kingdomStatusRoute(KingdomStatusSource.NOTICE, error = false))
        assertEquals(KingdomStatusRoute.ERROR_TOAST, kingdomStatusRoute(KingdomStatusSource.NOTICE, error = true))
        assertEquals(KingdomStatusRoute.ERROR_TOAST, kingdomStatusRoute(KingdomStatusSource.HOME_ERROR))
        assertEquals(KingdomStatusRoute.TOAST, kingdomStatusRoute(KingdomStatusSource.HOME_MESSAGE))
        assertEquals(KingdomStatusRoute.TOAST, kingdomStatusRoute(KingdomStatusSource.UPDATE_NOTICE))
        assertEquals(KingdomStatusRoute.TOAST, kingdomStatusRoute(KingdomStatusSource.TIMING_NOTICE))
    }

    @Test fun `an error a sheet already prints is kept for the sheet, a confirmation is still toasted`() {
        assertEquals(KingdomStatusRoute.KEEP, kingdomStatusRoute(KingdomStatusSource.NOTICE, error = true, sheetShowsErrors = true))
        assertEquals(KingdomStatusRoute.KEEP, kingdomStatusRoute(KingdomStatusSource.HOME_ERROR, sheetShowsErrors = true))
        assertEquals(KingdomStatusRoute.TOAST, kingdomStatusRoute(KingdomStatusSource.NOTICE, error = false, sheetShowsErrors = true))
    }

    @Test fun `a message is posted once and retired with clearNotice`() {
        val facts = KingdomStatusFacts(homeMessage = "+200 SHARDS")
        val first = kingdomStatusStep(facts, KingdomStatusMemory(), t0)
        assertEquals(listOf(KingdomStatusPost(KingdomStatusSource.HOME_MESSAGE, "+200 SHARDS", error = false)), first.posts)
        assertTrue(first.clearHome)
        // The owner has not cleared it yet (the next composition can come first): no second toast.
        val again = kingdomStatusStep(facts, first.memory, t0 + 16)
        assertTrue(again.posts.isEmpty())
    }

    @Test fun `an action error is one error toast even when the notice and the read error carry the same words`() {
        val failed = KingdomStatusFacts(notice = ScreenNotice("Not enough Shards", error = true), homeError = "Not enough Shards")
        val step = kingdomStatusStep(failed, KingdomStatusMemory(), t0)
        assertEquals(1, step.posts.size)
        assertTrue(step.posts.single().error)
        assertTrue("clearNotice retires both", step.clearHome)
        // The read error can arrive a frame after the notice was retired: still the same toast, merged.
        val late = kingdomStatusStep(KingdomStatusFacts(homeError = "Not enough Shards"), step.memory, t0 + 50)
        assertTrue(late.posts.isEmpty())
        assertTrue(late.clearHome)
    }

    @Test fun `the same line returning later is a new toast`() {
        val shown = kingdomStatusStep(KingdomStatusFacts(notice = ScreenNotice("Working…", error = false)), KingdomStatusMemory(), t0)
        assertTrue(shown.dismissNotice)
        val gone = kingdomStatusStep(KingdomStatusFacts(), shown.memory, t0 + 100)
        val back = kingdomStatusStep(KingdomStatusFacts(notice = ScreenNotice("Working…", error = false)), gone.memory, t0 + 10_000)
        assertEquals(1, back.posts.size)
    }

    @Test fun `an error while a sheet prints it is neither toasted nor retired, and is toasted once the sheet closes`() {
        val inSheet = KingdomStatusFacts(notice = ScreenNotice("Builder busy", error = true), homeError = "Builder busy",
            homeMessage = "QUEST CLAIMED", sheetShowsErrors = true)
        val step = kingdomStatusStep(inSheet, KingdomStatusMemory(), t0)
        assertEquals(listOf("QUEST CLAIMED"), step.posts.map { it.text })
        assertFalse("clearNotice would yank the error out of the open sheet", step.clearHome)
        assertFalse(step.dismissNotice)
        val closed = kingdomStatusStep(inSheet.copy(sheetShowsErrors = false), step.memory, t0 + 20_000)
        assertEquals(listOf("Builder busy"), closed.posts.map { it.text })
        assertTrue(closed.clearHome)
    }

    @Test fun `the content line is retired with its owner and the timing line is posted once and never retired`() {
        val timing = "GAME CONTENT UPDATE NEEDED"
        val step = kingdomStatusStep(KingdomStatusFacts(updateNotice = "Game content updated.", timingNotice = timing), KingdomStatusMemory(), t0)
        assertEquals(2, step.posts.size)
        assertTrue(step.dismissUpdate)
        assertFalse(step.clearHome)
        val later = kingdomStatusStep(KingdomStatusFacts(timingNotice = timing), step.memory, t0 + 60_000)
        assertTrue("the derived timing line has nothing to retire, so it must not repeat", later.posts.isEmpty())
    }

    @Test fun `nothing to say does nothing`() {
        val step = kingdomStatusStep(KingdomStatusFacts(), KingdomStatusMemory(), t0)
        assertTrue(step.posts.isEmpty())
        assertFalse(step.dismissNotice); assertFalse(step.clearHome); assertFalse(step.dismissUpdate)
    }
}
