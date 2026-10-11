package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHudPlan
import org.junit.Assert.*
import org.junit.Test

class BuildTrayHudTest {
    @Test fun `the mounted BUILD HUD excludes HEROES so its KEEP balance stays visible`() {
        // 2c3d803d: openBuildMenu(true) also sets buildMenu; that alone must not hide HEROES' ordinary HUD.
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        val argument = Regex("""buildOpen\s*=\s*kingdomAudio\.local\.buildMenu\s*&&\s*!kingdomAudio\.local\.heroesOnly\b""")
        assertEquals("Pin the actual mounted argument, not just the pure HUD projection", 1, argument.findAll(source).count())
    }

    private fun hud(shards: String? = null) = homeHudState(
        BaseState(balances = shards?.let { Balances(shards = it, keep = "200") }),
        null, 0, true, 3, 0, selectionOpen = false, toolsOpen = true)

    @Test fun `BUILD keeps the same Shards readout and hides the other HUD zones`() {
        for (balance in listOf(null, "0", "1431")) {
            val original = hud(balance)
            val build = homeHudForBuild(original, buildOpen = true)
            assertEquals(listOf(HudIds.SHARDS), build.resources.map { it.id })
            assertSame(original.resources.single { it.id == HudIds.SHARDS }, build.resources.single())
            assertFalse(build.deckVisible)
            assertFalse(build.toolsOpen)
            assertNull(build.herald)
            assertNull(build.context)
            val plan = homeHudPlan(build)
            assertTrue(plan.deck.isEmpty())
            assertTrue(plan.leftEdge.isEmpty())
            assertTrue(plan.rightEdge.isEmpty())
        }
    }

    @Test fun `closing BUILD restores the unmodified current HUD including its ordinary currencies`() {
        val original = hud("1431")
        assertTrue(original.resources.size > 1)
        assertTrue(original.deckVisible)
        assertSame(original, homeHudForBuild(original, buildOpen = false))
    }

    @Test fun `a missing Shards row cannot substitute KEEP or invent a balance`() {
        val original = hud().let { it.copy(resources = it.resources.filterNot { row -> row.id == HudIds.SHARDS }) }
        assertTrue(original.resources.isNotEmpty())
        assertTrue(homeHudForBuild(original, buildOpen = true).resources.isEmpty())
    }
}
