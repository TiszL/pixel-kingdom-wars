package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.model.WallRowWall
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class LiveWallRowReviewTest {
    private fun quote(afford: Boolean = true, total: String = "31", walls: List<WallRowWall> = listOf(
        WallRowWall("a", 1, 1, 2, 3, "11"), WallRowWall("b", 2, 1, 3, 4, "20"))) =
        WallRowQuote("base", "a", "f".repeat(64), 9, walls, total, "100", afford, JsonObject(emptyMap()))
    private fun ui(q: WallRowQuote = quote(), busy: Boolean = false, allowed: Boolean = true, retry: Boolean = false) =
        liveWallRowReview(q, null, busy, allowed, retry, null, "1/2 free")

    @Test fun `mixed quote preserves total and cannot invent a common unit price or level`() {
        val ui = ui()
        assertEquals("31", ui.total.amount)
        assertEquals(2, ui.count)
        assertEquals("MIXED", ui.fromLevel); assertEquals("MIXED", ui.toLevel)
        assertEquals(PriceStatus.UNAVAILABLE, ui.unitPrice.status)
        assertEquals(UpgradeState.READY, ui.state)
        assertFalse(ui.wallsStayUp)
        assertFalse(requireNotNull(ui.selectionHint).contains("Tap a wall"))
    }
    @Test fun `same unit prices are shown only when every eligible wall agrees`() {
        val ui = ui(quote(walls = listOf(WallRowWall("a", 1, 1, 2, 3, "11"), WallRowWall("b", 2, 1, 2, 3, "11")), total = "22"))
        assertEquals("11", ui.unitPrice.amount); assertEquals(PriceStatus.OK, ui.unitPrice.status)
        assertEquals("LV 2", ui.fromLevel); assertEquals("LV 3", ui.toLevel)
    }
    @Test fun `server affordability refusal disables fresh and saved purchase alike`() {
        for (retry in listOf(false, true)) {
            val ui = ui(quote(afford = false), retry = retry)
            assertEquals(UpgradeState.SHORT, ui.state)
            assertFalse(quoteLook(ui.state, ui.total, ui.reason).sends)
        }
    }
    @Test fun `busy and permission denial outrank saved retry`() {
        assertEquals(UpgradeState.BUSY, ui(busy = true, retry = true).state)
        assertEquals(UpgradeState.READ_ONLY, ui(allowed = false, retry = true).state)
    }
    @Test fun `saved quote offers same-key retry and dispatch never calls a fresh sender`() {
        assertEquals(UpgradeState.VERIFYING, ui(retry = true).state)
        assertEquals("Retry the same saved payment · 31 Shards", ui(retry = true).reason)
        val calls = mutableListOf<String>()
        submitWallRowReview(true, { calls += "new" }, { calls += "saved" })
        assertEquals(listOf("saved"), calls)
        calls.clear()
        submitWallRowReview(false, { calls += "new" }, { calls += "saved" })
        assertEquals(listOf("new"), calls)
    }
    @Test fun `all excluded walls stay disabled without claiming they all reached one level`() {
        val ui = ui(quote(walls = listOf(WallRowWall("a", 1, 1, 2, excluded = "busy"))))
        assertEquals(0, ui.count); assertEquals(1, ui.skipped)
        assertEquals(UpgradeState.READ_ONLY, ui.state)
        assertEquals("No walls in this quote can upgrade", ui.reason)
    }
    @Test fun `unknown total never becomes zero or a sendable quote`() {
        val ui = ui(quote(total = "broken"))
        assertNull(ui.total.amount)
        assertEquals(PriceStatus.UNAVAILABLE, ui.total.status)
        assertFalse(quoteLook(ui.state, ui.total, ui.reason).sends)
    }
    @Test fun `world tap closes the quote without reaching another command and busy holds it`() {
        val calls = mutableListOf<String>()
        assertTrue(consumeWallRowTap(true, false, { calls += "owner"; false }, { calls += "close" }))
        assertEquals(listOf("owner", "close"), calls)
        calls.clear()
        assertTrue(consumeWallRowTap(true, true, { calls += "owner"; false }, { calls += "close" }))
        assertEquals(listOf("owner"), calls)
        assertFalse(consumeWallRowTap(false, false, { false }, { fail("no quote") }))
        assertTrue(consumeWallRowTap(true, false, { true }, { fail("owner already consumed") }))
    }

    @Test fun `a quote for another base is read only through the live eligibility rule`() {
        val q = quote()
        val allowed = wallRowReviewAllowed(q, "another-base", true, true)
        assertFalse(allowed)
        val ui = ui(q, allowed = allowed)
        assertEquals(UpgradeState.READ_ONLY, ui.state); assertFalse(quoteLook(ui.state, ui.total, ui.reason).sends)
        assertTrue(wallRowReviewAllowed(q, "base", true, true))
        assertFalse(wallRowReviewAllowed(q, "base", false, true)); assertFalse(wallRowReviewAllowed(q, "base", true, false))
    }
    @Test fun `server refusal and repricing stay visible on commit and need more looks`() {
        for (afford in listOf(true, false)) {
            val ui = liveWallRowReview(quote(afford = afford), null, false, true, false, "The row was repriced. Review again.", "1/2 free")
            assertTrue(requireNotNull(ui.selectionHint).startsWith("The row was repriced. Review again."))
        }
    }
    @Test fun `row total balance and unknown balance stay on the quote`() {
        assertEquals("31 Shards", ui().rows.single { it.label == "Row total" }.new)
        assertEquals("100", ui().rows.single { it.label == "Balance" }.new)
        assertEquals("…", ui(quote().copy(balanceShards = "broken")).rows.single { it.label == "Balance" }.new)
        assertEquals("21", ui(quote(afford = false).copy(balanceShards = "10")).shortfall)
    }
    @Test fun `skipped walls use player words and retain different Keep requirements`() {
        val q = quote(walls = listOf(WallRowWall("a",1,1,2,excluded="max_level"), WallRowWall("b",2,1,2,excluded="keep_level"),
            WallRowWall("c",3,1,4,excluded="keep_level"), WallRowWall("d",4,1,3,excluded="busy")))
        val labels = ui(q).rows.map { it.label }
        assertTrue(labels.containsAll(listOf("Already max level", "Needs Keep 3", "Needs Keep 5", "Busy")))
    }
    @Test fun `nested Builders and ROW call the external owner once before any local close`() {
        // 02aedc7d: Builders is outermost, with each sheet asking its owner before handling a resolved tap.
        val calls = mutableListOf<String>()
        assertTrue(consumeBuildersTap(true, { consumeWallRowTap(true, false, { calls += "owner"; false }, { calls += "row" }) }, { calls += "builders" }))
        assertEquals(listOf("owner", "row"), calls)
    }
}
