package gg.pixelkingdomwars.nativeclient.ui.nav

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Scene-transitions spec §4 step 3 (owner 2026-10-06, "loading indicator is like not well implemented"): the NavHost
 * cross-fades every route by default (700 ms), and a GL SurfaceView cannot follow a Compose alpha, so entering or leaving a
 * scene showed a half-faded shell over it. Scene routes switch at once and let their own covers transition; every other
 * route keeps the default fade (removing it everywhere would change how ordinary screens feel).
 */
class SceneRouteTransitionsTest {
    private val nav = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
    private val none = "(enterTransition = sceneEnter, exitTransition = sceneExit, popEnterTransition = sceneEnter, popExitTransition = sceneExit)"

    @Test fun `every scene route switches without the default fade`() {
        for (route in listOf("HomeRoute", "BattleRoute", "WatchRoute", "ReplayRoute", "ScoutRoute"))
            assertTrue("$route has no NavHost fade", nav.contains("composable<$route>$none {"))
        assertTrue(nav.contains("{ androidx.compose.animation.EnterTransition.None }"))
        assertTrue(nav.contains("{ androidx.compose.animation.ExitTransition.None }"))
    }

    @Test fun `ordinary routes keep the default fade`() {
        for (route in listOf("QuestsRoute", "ProfileRoute", "RaidLogRoute", "ShopRoute"))
            assertFalse("$route keeps its fade", nav.contains("composable<$route>$none"))
        assertEquals("only the five scene routes", 5, Regex("""composable<\w+>\(enterTransition = sceneEnter""").findAll(nav).count())
    }
}
