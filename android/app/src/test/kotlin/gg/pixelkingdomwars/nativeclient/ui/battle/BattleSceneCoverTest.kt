package gg.pixelkingdomwars.nativeclient.ui.battle

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06: "black screen is low quality indication … loading indicator is like not well implemented … professional
 * solution"; the battle default is the design spec's 220 ms fade through the scene colour (army/SPEC.md:521/798,
 * scene-transitions §2 BATTLE_FADE). Every battle-family opening (raid, watch, scout, replay) used an opaque #100E14 plate.
 * These pin the replacement: the player's own base dimmed (or the wallpaper), the same honest indicator as Home, the fade
 * through the target's ground colour once the field has drawn, and a return to Home that lands on its postcard.
 */
class BattleSceneCoverTest {
    private fun main(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    @Test fun `the fade through the ground colour is 220 ms, a 120 ms cross-fade with reduced motion`() {
        val (washIn, lift) = battleFadeMs(reducedMotion = false)
        assertEquals(220, washIn + lift)
        assertEquals(BATTLE_FADE_HALF_MS, washIn)
        assertEquals(0 to 120, battleFadeMs(reducedMotion = true))
        assertEquals("the waiting base shows at 60 %", .4f, BATTLE_DIM, 0f)
        assertEquals(160, BATTLE_DIM_MS)
    }

    @Test fun `only a presented field fades through the colour, so no colour flashes over a failure panel`() {
        assertTrue(battleCoverFades(fieldPresented = true))
        assertFalse(battleCoverFades(fieldPresented = false))
    }

    @Test fun `the cover waits two vsyncs, washes to the ground colour, then lifts, and never draws a plate`() {
        val cover = main("ui/battle/BattleSceneCover.kt")
        val swap = cover.substring(cover.indexOf("repeat(SWAP_VSYNCS) { withFrameNanos { } }"), cover.indexOf("gone = true\n        SceneLoadLog"))
        assertTrue("wash first", swap.indexOf("wash.animateTo(1f") in 0 until swap.indexOf("cover.animateTo(0f"))
        for (dark in listOf("LoadingOverlay(", "LoadingCard(", "Palette.backdrop", "PkwTokens.Colors.bg"))
            assertFalse("the cover never draws $dark", cover.contains(dark))
        assertTrue("no picture means the loading wallpaper and strip", cover.contains("RealmVeil(failed, onRetry, title = cause, failedTitle = cause)"))
        assertTrue("the same honest indicator as Home", cover.contains("rememberIndicatorStage(route, waiting = !live, failed = failed)"))
        assertTrue("the ground colour is read off Main", cover.contains("withContext(Dispatchers.Default) { runCatching { realmGroundColor("))
    }

    @Test fun `every battle-family opening is covered by its parent, never by the surface's own dark veil`() {
        val screens = main("ui/battle/BattleScreens.kt")
        assertEquals("raid, watch, scout and replay", 4, Regex("""coveredByParent = true, onOpeningFailure = \{ failed, retry -> fieldFailed = failed; fieldRetry = retry \}""").findAll(screens).count())
        for (route in listOf("battle", "watch", "scout", "replay")) assertTrue(route, screens.contains("route = \"$route\""))
        assertTrue("the raid shows the player's own base while it waits",
            main("ui/nav/PkwApp.kt").contains("postcardAccount = gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.accountKey(current.session.wallet))"))
    }

    @Test fun `the return from a battle lands on the Home postcard, which a battle never overwrites`() {
        val postcards = main("scene/ScenePostcards.kt")
        assertTrue("a battle frame is never a Home postcard", postcards.contains("fragment.battle != null || !fragment.hasPresentedScene"))
        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertTrue("Home's cover shows its own postcard on the way back", kingdom.contains("ScenePresentationLayer(live, shownPostcard, coverFailed, coverRetry"))
    }
}
