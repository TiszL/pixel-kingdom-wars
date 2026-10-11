package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import org.junit.Assert.*
import org.junit.Test

/**
 * The builder-finished herald (hub SPEC §3.1, toasts.png top). Why it matters: the herald says a builder FINISHED, so it
 * may only speak when the server's own base read shows it (a level that rose, a construction that ended) between two reads
 * of the same kingdom. Comparing against another kingdom's levels, or against nothing, would announce finishes that never
 * happened, and a refresh that briefly has no buildings must not swallow a real one.
 */
class HomeBuilderHeraldTest {
    private fun building(id: String, type: String, level: Int, constructing: Boolean = false) =
        Building(id, type, level, 0, 0, underConstruction = constructing)

    @Test fun `a level that rose between two reads of the same base is one herald naming the building and its level`() {
        val before = listOf(building("w1", "workshop", 2), building("m1", "mine", 3))
        val after = listOf(building("w1", "workshop", 3), building("m1", "mine", 3))
        val herald = homeBuilderFinishedHeralds("base-1", before, "base-1", after).single()
        assertEquals("the frame's line, with the server's new level", "Builder finished: Workshop Lv 3", herald.text)
        assertEquals("one key per finish, so the next level restarts the banner", "builder:w1:3", herald.key)
        assertEquals("the authored builder art", "builder", herald.icon)
        assertEquals("a tap opens the builders, as the HUD's builders chip does", HudIds.BUILDERS, herald.target)
    }

    @Test fun `a construction that ended is a herald and the name is the game's display copy`() {
        val herald = homeBuilderFinishedHeralds("base-1", listOf(building("f1", "forge", 1, constructing = true)),
            "base-1", listOf(building("f1", "forge", 1))).single()
        assertEquals("the forge type is the Alchemy Lab to a player, never the raw id", "Builder finished: Alchemy Lab Lv 1", herald.text)
    }

    @Test fun `a level up and a construction end together count once`() {
        val heralds = homeBuilderFinishedHeralds("base-1", listOf(building("t1", "archertower", 0, constructing = true)),
            "base-1", listOf(building("t1", "archertower", 1)))
        assertEquals(listOf("builder:t1:1"), heralds.map { it.key })
    }

    @Test fun `a base switch raises nothing`() {
        val heralds = homeBuilderFinishedHeralds("base-1", listOf(building("w1", "workshop", 2)), "base-2", listOf(building("w1", "workshop", 5)))
        assertTrue("another kingdom's levels are not a finish here", heralds.isEmpty())
    }

    @Test fun `the first read of a base raises nothing`() {
        assertTrue("nothing to compare with", homeBuilderFinishedHeralds(null, null, "base-1", listOf(building("w1", "workshop", 3))).isEmpty())
        assertTrue("a base with no id cannot be told apart from another",
            homeBuilderFinishedHeralds(null, listOf(building("w1", "workshop", 2)), null, listOf(building("w1", "workshop", 3))).isEmpty())
    }

    @Test fun `an unchanged read or a started job or a newly placed building raises nothing`() {
        val before = listOf(building("w1", "workshop", 2), building("m1", "mine", 3))
        assertTrue("unchanged", homeBuilderFinishedHeralds("base-1", before, "base-1", before).isEmpty())
        val started = listOf(building("w1", "workshop", 2, constructing = true), building("m1", "mine", 3))
        assertTrue("a construction that started is not a finish", homeBuilderFinishedHeralds("base-1", before, "base-1", started).isEmpty())
        val placed = before + building("l1", "lodge", 1)
        assertTrue("a building just placed was not finished by a builder", homeBuilderFinishedHeralds("base-1", before, "base-1", placed).isEmpty())
    }

    @Test fun `a refresh with no buildings neither raises nor forgets the last read`() {
        val reads = HomeBuilderReads()
        assertTrue("the first read of a base raises nothing", reads.next("base-1", listOf(building("w1", "workshop", 2))).isEmpty())
        assertTrue(reads.next("base-1", null).isEmpty())
        assertEquals("the finish that landed across the refresh is still announced", listOf("Builder finished: Workshop Lv 3"),
            reads.next("base-1", listOf(building("w1", "workshop", 3))).map { it.text })
        assertTrue("a switch to another base compares with nothing", reads.next("base-2", listOf(building("w1", "workshop", 7))).isEmpty())
        assertEquals("and the new base is then the one compared", listOf("builder:w1:8"),
            reads.next("base-2", listOf(building("w1", "workshop", 8))).map { it.key })
    }
}
