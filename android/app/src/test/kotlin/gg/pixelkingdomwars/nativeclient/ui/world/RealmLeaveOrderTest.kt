package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The owner's "the minimap sometimes turns transparent" (Seeker, code-27). The realm HUD's minimap is a Compose frame
 * around a GL pass. A leave renders the realm's last frame, GL minimap included, into a snapshot and fades it out over
 * the globe for 450 ms. The HUD heard of the leave only at the fade's end (`Left`), so a pinch-out, which has no HUD
 * tap before it, kept the opaque frame up while the globe showed through its middle. The host must say `Leaving`
 * before the first fade frame, and the HUD must drop the realm HUD on it, as map.js `exit` calls `ui.hide()` before
 * `onExit`. The host is Android-bound, so its order is checked in its source, the way `WorldEngineIntegrationTest`
 * checks the host's other hooks.
 */
class RealmLeaveOrderTest {
    private val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
    private val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()

    @Test fun `the host says Leaving before the first fade frame and Left only after the last`() {
        val leave = host.substring(host.indexOf("private fun startLeave"), host.indexOf("private fun logBand"))
        val leaving = leave.indexOf("callbacks.event(WorldHudEvent.Leaving(id))")
        assertTrue("startLeave tells the HUD", leaving >= 0)
        assertTrue("before the snapshot that the fade composites is drawn", leaving < leave.indexOf("r.renderSnapshot("))
        assertTrue("before the leave fade starts", leaving < leave.indexOf("r.fade.start(RealmDiveFade.LEAVE, now)"))
        val fades = host.substring(host.indexOf("MODE_FADE_IN, MODE_FADE_OUT -> {"), host.indexOf("MODE_REALM -> {"))
        assertTrue("Left waits for the fade's end", fades.indexOf("callbacks.event(WorldHudEvent.Left(id))") > fades.indexOf("if (rr.fade.done(now))"))
        // every leave runs through startLeave: the HUD's Leave intent and the engine's own pinch-out alike
        assertTrue("a pinch-out asks for the same leave", "override fun onExit(lon: Double, lat: Double) { if (mode == MODE_REALM) leaveRequested = true }" in host)
        assertTrue("a requested leave starts at frame start", "if (leaveRequested && mode == MODE_REALM) { leaveRequested = false; startLeave(now) }" in host)
        val dive = host.substring(host.indexOf("private fun beginDive"), host.indexOf("private fun diveStep"))
        assertTrue("a dive tells the HUD as it begins (a pinch-in dive has no HUD tap either)", "callbacks.event(WorldHudEvent.Diving(realmId))" in dive)
    }

    @Test fun `a pinch-out leave drops the realm HUD and its minimap frame at once, and the globe comes back at the fade's end`() {
        val onMap = WorldHudUi(mode = WorldHudMode.REALM, realmId = "crownlands", card = RealmCard(5000, 200, 6), miniOpen = true,
            levelOpen = true, realmSearch = true)
        // the host's events for a pinch-out: Leaving, 450 ms of fade frames, Left
        val leaving = WorldHudFlow.leaving(onMap)
        assertEquals(WorldHudMode.LEAVING, leaving.ui.mode)
        assertTrue("no Leave back: the engine is already leaving", leaving.intents.isEmpty())
        assertTrue("the screen applies it", "is WorldHudEvent.Leaving -> applyNow(WorldHudFlow.leaving(u))" in screen)
        assertTrue("the realm HUD (minimap frame included) is composed on a map at rest", "WorldHudMode.REALM -> RealmLayer(" in screen)
        assertTrue("and nothing is composed while leaving", "WorldHudMode.LEAVING -> Unit" in screen)
        assertEquals("Back waits for the globe", listOf(BackPriority.REALM_MAP), WorldHudFlow.backLayers(leaving.ui))
        val back = WorldHudFlow.left(leaving.ui, "crownlands")
        assertEquals(WorldHudMode.GLOBE, back.ui.mode); assertEquals(GlobePanel.REALM, back.ui.panel); assertNull(back.ui.card)
        assertEquals(listOf(WorldIntent.Select(WorldTarget.Realm("crownlands"))), back.intents)

        // ◀ Globe or Back: the HUD is LEAVING already when the host's Leaving arrives, which changes and re-sends nothing
        val tapped = WorldHudFlow.leave(onMap)
        assertEquals(listOf(WorldIntent.Leave), tapped.intents)
        val echo = WorldHudFlow.leaving(tapped.ui)
        assertEquals(tapped.ui, echo.ui); assertTrue(echo.intents.isEmpty())
        assertEquals("a stale Leaving on the globe changes nothing", WorldHudUi(), WorldHudFlow.leaving(WorldHudUi()).ui)
    }

    @Test fun `a pinch-in dive hides the globe controls as it begins, and an Enter map dive keeps what it will select`() {
        val globe = WorldHudUi(realmId = "frostveil", panel = GlobePanel.REALM, globeSearch = true, noMap = "No map here")
        val dive = WorldHudFlow.diving(globe, "sunscar")
        assertEquals(WorldHudMode.DIVING, dive.ui.mode); assertEquals("sunscar", dive.ui.realmId)
        assertFalse(dive.ui.globeSearch); assertNull(dive.ui.noMap)
        assertTrue("no intent back: the engine is already diving", dive.intents.isEmpty())
        assertTrue("the screen applies it", "is WorldHudEvent.Diving -> applyNow(WorldHudFlow.diving(u, event.realmId))" in screen)
        val landed = WorldHudFlow.dived(dive.ui, "sunscar", RealmCard(1, 1, 1))
        assertEquals(WorldHudMode.REALM, landed.ui.mode); assertNull("a pinch-in dive selects nothing on landing", landed.ui.card)

        val entered = WorldHudFlow.enterMap(globe, "frostveil", tile = RealmCard(7, 7, 0)).ui
        assertEquals("the host's Diving for an Enter map dive keeps its pending tile", entered, WorldHudFlow.diving(entered, "frostveil").ui)
    }
}
