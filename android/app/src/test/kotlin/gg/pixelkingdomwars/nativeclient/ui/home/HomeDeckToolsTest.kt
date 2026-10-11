package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The HUD deck's tools shelf replaced KingdomScreen's LAYOUT · EXPAND · FIT dock row. Moving a door must not change who
 * may use it: these pin the row's own rules (LAYOUT / EXPAND only while the deed allows base actions, LAYOUT off while an
 * order runs, both off with no base, FIT always), and that every tool id reaches the Kingdom screen as its tool.
 */
class HomeDeckToolsTest {
    private fun tools(baseLoaded: Boolean = true, deed: Boolean = true, busy: Boolean = false) =
        homeDeckTools(baseLoaded = baseLoaded, deedActionsAllowed = deed, busy = busy)

    @Test fun `a loaded base with deed actions offers all three tools, enabled, in the row's order`() {
        val all = tools()
        assertEquals(listOf("LAYOUT", "EXPAND", "FIT"), all.map { it.label })
        assertTrue(all.all { it.enabled })
    }

    @Test fun `a deed that blocks base actions hides LAYOUT and EXPAND but keeps FIT, as the dock row did`() {
        val blocked = tools(deed = false)
        assertEquals(listOf("FIT"), blocked.map { it.label })
        assertTrue(blocked.single().enabled)
    }

    @Test fun `an order in flight turns LAYOUT off (the editor must not open over it) and leaves EXPAND and FIT on`() {
        val busy = tools(busy = true).associateBy { it.label }
        assertFalse(busy.getValue("LAYOUT").enabled)
        assertTrue("a disabled tool says why", busy.getValue("LAYOUT").description.contains("waiting"))
        assertTrue(busy.getValue("EXPAND").enabled)
        assertTrue(busy.getValue("FIT").enabled)
    }

    @Test fun `with no base loaded only FIT works, and the off tools say they are waiting for the base`() {
        val none = tools(baseLoaded = false).associateBy { it.label }
        assertFalse(none.getValue("LAYOUT").enabled)
        assertFalse(none.getValue("EXPAND").enabled)
        assertTrue(none.getValue("EXPAND").description.contains("waiting for your base"))
        assertTrue(none.getValue("FIT").enabled)
    }

    @Test fun `every tool id routes to its Kingdom tool and nothing else is mistaken for one`() {
        assertEquals(mapOf("LAYOUT" to HomeBaseTool.LAYOUT, "EXPAND" to HomeBaseTool.EXPAND, "FIT" to HomeBaseTool.FIT),
            tools().associate { it.label to homeBaseTool(it.id) })
        assertNull(homeBaseTool(HudIds.BUILD))
        assertNull(homeBaseTool(HudIds.BUILDERS))
        assertNull(homeBaseTool(FeatureId("build.layout")))
    }

    @Test fun `the builders door and the tools land on the Kingdom tab, where the screen that runs them lives`() {
        assertEquals(HomeTab.KINGDOM, HomeRequest.Builders.homeTab)
        HomeBaseTool.entries.forEach { assertEquals(HomeTab.KINGDOM, HomeRequest.BaseTool(it).homeTab) }
    }
}
