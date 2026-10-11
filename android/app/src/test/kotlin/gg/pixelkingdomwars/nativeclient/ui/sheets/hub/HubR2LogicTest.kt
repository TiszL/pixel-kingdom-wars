package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure rules of hub round 2 (design/final/hub/SPEC.md "Round 2 additions" + part two + critic fixes). Each test names
 * the promise it keeps: a streak is never invented, a claimed cache cannot be claimed twice, an event row shows real
 * progress, the league tag tells the truth, a new reply is never buried, and RIGHT NOW never grows into a list.
 */
class HubR2LogicTest {

    // R2.1: day 5 of 7 shows four claimed tiles, today, and two to come; after the claim today turns green.
    @Test fun `the streak shows claimed days, today and the days to come`() {
        val c = CacheDay.CLAIMED; val t = CacheDay.TODAY; val f = CacheDay.FUTURE
        assertEquals(listOf(c, c, c, c, t, f, f), cacheDays(5, 7, claimedToday = false))
        assertEquals(listOf(c, c, c, c, c, f, f), cacheDays(5, 7, claimedToday = true))
        assertEquals(listOf(t, f, f), cacheDays(1, 3, claimedToday = false))
    }

    // R2.1 states: a missing pack constant hides the streak ("Game content update needed"), never a made-up 7 days.
    @Test fun `an unknown streak length hides the streak row`() {
        assertNull(cacheDays(5, null, claimedToday = false))
        assertNull(cacheDays(5, 0, claimedToday = false))
        assertEquals(7, cacheDays(9, 7, claimedToday = false)?.size)
    }

    // R2.1: claimed means CLAIMED TODAY (off) with the next time, an uncertain claim keeps CLAIM as RETRY.
    @Test fun `the claim button says what the cache can do now`() {
        assertEquals("CLAIM", cacheClaimLabel(CacheState.READY))
        assertEquals("Claiming", cacheClaimLabel(CacheState.CLAIMING))
        assertEquals("CLAIMED TODAY", cacheClaimLabel(CacheState.CLAIMED))
        assertEquals("RETRY", cacheClaimLabel(CacheState.CHECKING))
        assertEquals("Next cache in 14h 20m", nextCacheLine("14h 20m"))
        assertEquals("Next cache in …", nextCacheLine(null))
    }

    // R2.1 success: the open chest plays frames 1..3 at 12 fps and then holds; it never loops back to closed.
    @Test fun `the open chest plays three frames and holds the last`() {
        assertEquals(1, openChestFrame(0))
        assertEquals(2, openChestFrame(84))
        assertEquals(3, openChestFrame(170))
        assertEquals(3, openChestFrame(10_000))
    }

    // R2.2: JOIN appears only while the event is live and the player has not joined (no footer otherwise).
    @Test fun `the join footer shows only while live and not joined`() {
        assertTrue(eventShowsJoin(EventPhase.LIVE, joined = false))
        assertFalse(eventShowsJoin(EventPhase.LIVE, joined = true))
        assertFalse(eventShowsJoin(EventPhase.UPCOMING, joined = false))
        assertFalse(eventShowsJoin(EventPhase.CLOSED, joined = false))
    }

    // R2.2: a row's meter is real progress, capped, and a row without a cap draws no bar (never an empty 0 %).
    @Test fun `activity meters are capped and rows without a cap draw no bar`() {
        assertEquals(0.4f, activityFill(2, 5)!!, 0.0001f)
        assertEquals(1f, activityFill(7, 5)!!, 0.0001f)
        assertNull(activityFill(0, 0))
        assertEquals("2/5 · 20 each", activityLine(2, 5, "20"))
        assertEquals("1/1 · 10", activityLine(1, 1, "10"))
        assertEquals("0/3 · … each", activityLine(0, 3, ""))
        assertEquals("120 / 300", todayPointsLine("120", "300"))
        assertEquals("… / 300", todayPointsLine(null, "300"))
    }

    // Part two A: EARNING / NOT YET follow the server's minimum; PAID wins once the payout landed; unknown draws nothing.
    @Test fun `the league tag tells the truth about this week`() {
        assertEquals(StatusLook("EARNING", Verb.GREEN, false), earningTag(true, paid = false))
        assertEquals(StatusLook("NOT YET", Verb.STONE, false), earningTag(false, paid = false))
        assertEquals("PAID", earningTag(true, paid = true)?.label)
        assertNull(earningTag(null, paid = false))
    }

    // Critic fix: the legend names each item present in the rows once, so the stand-in icons are never a mystery.
    @Test fun `the item legend lists each item present once, first seen first`() {
        val seal = ItemTileUi("seal", "streak", "1", "Finisher's Seal")
        val keg = ItemTileUi("keg", "timer", "2", "Keg of Haste")
        assertEquals(listOf("seal", "keg"), itemLegend(listOf(listOf(seal, keg), listOf(seal.copy(count = "1")), listOf(keg))).map { it.id })
        assertTrue(itemLegend(listOf(emptyList(), emptyList())).isEmpty())
    }

    // Part two C: the report tags match feedback-reports.png; a report not sent is red, never "SENT".
    @Test fun `report tags follow the report's state and category`() {
        assertEquals(StatusLook("READING", Verb.STONE, false), reportStatusLook(ReportStatus.READING))
        assertEquals(StatusLook("FIXED", Verb.MOSS, false), reportStatusLook(ReportStatus.FIXED))
        assertEquals("DONE", reportStatusLook(ReportStatus.ANSWERED).label)
        assertEquals(Verb.RED, reportStatusLook(ReportStatus.NOT_SENT).verb)
        assertEquals(Verb.RED, reportCategoryVerb("BUG"))
        assertEquals(Verb.BLUE, reportCategoryVerb("idea"))
        assertEquals(Verb.GOLD, reportCategoryVerb("PAYMENT"))
        assertEquals(Verb.STONE, reportCategoryVerb("OTHER"))
    }

    // Part two C: a new reply pops its row to the top; the server's newest-first order is otherwise kept.
    @Test fun `a report with a new reply pops to the top and the rest keep their order`() {
        val rows = listOf("a" to 0, "b" to 0, "c" to 2, "d" to 0, "e" to 1)
        assertEquals(listOf("c", "e", "a", "b", "d"), orderReports(rows) { it.second }.map { it.first })
    }

    // Part two D: RIGHT NOW is at most three cards (one headline, two halves); nothing becomes a list.
    @Test fun `right now shows at most three cards in priority order`() {
        assertEquals(listOf(1, 2, 3), nowCards(listOf(1, 2, 3, 4, 5)))
        assertEquals(listOf(1), nowCards(listOf(1)))
        assertTrue(nowCards(emptyList<Int>()).isEmpty())
        assertEquals(NowArtBg.SUNRAYS, nowArtBg("sunrays"))
        assertEquals(NowArtBg.CARD, nowArtBg("sea"))
    }

    // HubR2Art: wide art must fit its box at a whole scale; rounding up would bleed past the box.
    @Test fun `art fits its box at the largest whole scale`() {
        assertEquals(2, fitArtScale(294f, 112))   // 112 dp box at 2.625 px/dp: 2×, not the nearest 3×
        assertEquals(6, fitArtScale(630f, 96))    // the 96 px event banner in a 240 dp box
        assertEquals(1, fitArtScale(10f, 112))
        assertEquals(1, fitArtScale(100f, 0))
    }

    @Test fun `tester points line names the reviewed count only when known`() {
        assertEquals("From 6 reviewed reports. Points come after the team reads a report.", testerPointsLine(6))
        assertEquals("Points come after the team reads a report.", testerPointsLine(null))
    }
}
