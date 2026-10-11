package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which small island the EXPLORE panel holds ([WorldHudUi.archipelagoId]). Why it matters: the World tab draws the designed
 * archipelago sheet exactly while EXPLORE holds an island, and the chain list otherwise. A lost id puts the old list back over
 * a tapped island; a stale one draws a sheet for an island the player already left, over the list they came back to.
 */
class WorldArchipelagoSelectionTest {
    @Test fun `a tap on a small island records it for the sheet, from the globe and from the chain list`() {
        val globe = WorldHudFlow.globePick(WorldHudUi(), WorldTarget.Island("glasswake/2"))
        assertEquals(GlobePanel.EXPLORE, globe.ui.panel)
        assertEquals("glasswake", globe.ui.chainId)
        assertEquals("glasswake/2", globe.ui.archipelagoId)
        assertEquals("the engine still selects and frames it", listOf(WorldIntent.Select(WorldTarget.Island("glasswake/2")),
            WorldIntent.FlyTo(WorldTarget.Island("glasswake/2"))), globe.intents)
        val list = WorldHudFlow.openPanel(WorldHudUi(), GlobePanel.EXPLORE).ui.copy(chainId = "aurora")
        assertEquals("aurora/0", WorldHudFlow.selectIsland(list, "aurora/0").ui.archipelagoId)
        assertEquals("a second island replaces the first", "aurora/4", WorldHudFlow.selectIsland(globe.ui, "aurora/4").ui.archipelagoId)
    }

    @Test fun `closing the sheet clears the island, by its X, by Back and by a tap on the sea`() {
        val open = WorldHudFlow.selectIsland(WorldHudUi(), "aurora/1").ui
        val closed = WorldHudFlow.deselect(open).ui
        assertEquals(GlobePanel.NONE, closed.panel); assertNull(closed.archipelagoId)
        assertNull(WorldHudFlow.back(open, BackPriority.GLOBE_LAYERS).ui.archipelagoId)
        assertNull(WorldHudFlow.globePick(open, null).ui.archipelagoId)
    }

    @Test fun `the chain list keeps no island, so it draws the list and never a stale sheet`() {
        val open = WorldHudFlow.selectIsland(WorldHudUi(), "aurora/1").ui
        // "All archipelagos" and a chain row both reopen EXPLORE through openPanel
        val all = WorldHudFlow.openPanel(open.copy(chainId = null), GlobePanel.EXPLORE).ui
        assertEquals(GlobePanel.EXPLORE, all.panel); assertNull(all.archipelagoId)
        val chain = WorldHudFlow.openPanel(open.copy(chainId = "glasswake"), GlobePanel.EXPLORE).ui
        assertEquals("glasswake", chain.chainId); assertNull(chain.archipelagoId)
        // any other panel drops it too, so a later EXPLORE never resurrects it
        assertNull(WorldHudFlow.openPanel(open, GlobePanel.WARZONE).ui.archipelagoId)
    }
}
