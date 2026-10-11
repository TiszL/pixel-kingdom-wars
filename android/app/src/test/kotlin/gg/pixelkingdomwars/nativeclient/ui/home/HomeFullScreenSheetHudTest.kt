package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHudPlan
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner 2026-10-06: "none of screens should overlay each other on interface". Under a full-screen sheet nothing of the
 * Home HUD may peek over or beside it except the resource pills on the sheet's shelf; and the NO LAND ticker must not sit
 * under the MAIL / CHAT edge tabs (owner screenshot 1).
 */
class HomeFullScreenSheetHudTest {
    private fun hud() = homeHudState(BaseState(balances = Balances(shards = "1431", keep = "200")),
        null, 0, true, 3, 0, selectionOpen = false, toolsOpen = true)

    @Test fun `under a full-screen sheet only the resource pills remain of the Home HUD`() {
        val original = hud()
        assertTrue(original.deckVisible)
        val covered = homeHudUnderFullScreenSheet(original, fullScreenSheet = true)
        assertFalse(covered.deckVisible)
        assertFalse(covered.toolsOpen)
        assertNull("no herald over the sheet header", covered.herald)
        assertNull("no context chip over the sheet footer", covered.context)
        assertEquals("the pills are kept for the shelf", original.resources, covered.resources)
        val plan = homeHudPlan(covered)
        assertTrue(plan.deck.isEmpty())
        assertTrue(plan.leftEdge.isEmpty())
        assertTrue(plan.rightEdge.isEmpty())
    }

    @Test fun `without a full-screen sheet the Home HUD is untouched`() {
        val original = hud()
        assertSame(original, homeHudUnderFullScreenSheet(original, fullScreenSheet = false))
    }

    @Test fun `a full card over Home leaves no empty pill shelf above its header`() {
        // A Full card (Clan from the Clan Hall, Profile, Leagues...) covers Home, so homeLiftedStackPainted paints no pills.
        // The shelf counted them anyway and pushed the card 38 dp down under an empty band below the camera strip.
        assertEquals(0, homeShelfRows(4, fullCardOver = true))
        assertEquals(0, gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry.shelfDp(homeShelfRows(4, fullCardOver = true)))
        // When the pills are painted, the shelf still makes room for exactly them, so a pill never sits on a header.
        assertEquals(4, homeShelfRows(4, fullCardOver = false))
        assertEquals(38, gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry.shelfDp(homeShelfRows(4, fullCardOver = false)))
        assertEquals(0, homeShelfRows(0, fullCardOver = false))
        val scaffold = listOf(java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt"),
            java.io.File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt")).first { it.isFile }.readText()
        assertTrue("the shelf height follows the painted pills", scaffold.contains("val shelfRows = homeShelfRows("))
        assertTrue(scaffold.contains("fullCardOver = hooks.homeCovered)"))
    }

    @Test fun `the land ticker starts right of the left edge tab column`() {
        // The edge tabs are TAB_W wide at x 0; the ticker adds its own 8 dp gutter after this start.
        assertTrue(homeLandTickerStartDp() >= HudGeometry.TAB_W)
        val scaffold = listOf(java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt"),
            java.io.File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt")).first { it.isFile }.readText()
        // The old "NO LAND YET" ticker was removed from Home on 2026-10-06 (the land door is the HUD herald), so nothing
        // mounts at that start any more; the rule kept is that the start stays clear of the edge tab column.
        assertFalse("no ticker is mounted at the left edge over the tab column", scaffold.contains("Copy.NO_LAND_PROMPT"))
    }
}
