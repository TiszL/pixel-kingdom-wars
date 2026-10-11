package gg.pixelkingdomwars.nativeclient.scene.world

import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.world.RealmCard
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudFlow
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudMode
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The enter-base seam (OPEN BASE on your own deed, D-162.3). The base scene opens on the camera the realm map hands
 * over, so the hand-off waits until the map shows the picture the base will continue: the deed at full TRUE with a
 * lane's TRUE ground drawn (seamless) and the camera at rest. Handed over mid-flight, the base would open at a scale the
 * map never rested at; handed over on the core's chart standing in for TRUE, on a different picture. A map that never
 * gets there must not strand the player: past the bound the base opens at its own fit, as before the seam (F8).
 */
class SeamWaitTest {
    @Test fun `the camera goes to the base only once the map rests on the deed's TRUE ground, else the bound opens the base at its fit`() {
        val w = SeamWait(WorldEngineHost.DIVE_STALL_MS)
        assertEquals("nothing pending, nothing to answer", SeamWait.WAIT, w.step(0.0, seamless = true, moving = false))
        w.start(310, 120, 1_000.0)
        assertTrue(w.pending)
        assertEquals("mid-flight at TRUE scale: not yet", SeamWait.WAIT, w.step(1_500.0, seamless = true, moving = true))
        assertEquals("at rest, the chart standing in for TRUE: not yet", SeamWait.WAIT, w.step(2_000.0, seamless = false, moving = false))
        assertEquals("at rest on TRUE ground: hand over", SeamWait.HAND_OFF, w.step(2_100.0, seamless = true, moving = false))
        w.clear(); assertFalse(w.pending)
        w.start(310, 120, 10_000.0)
        assertEquals(SeamWait.WAIT, w.step(10_000.0 + WorldEngineHost.DIVE_STALL_MS, seamless = false, moving = false))
        assertEquals("past the bound: the base opens at its own fit", SeamWait.GIVE_UP,
            w.step(10_000.0 + WorldEngineHost.DIVE_STALL_MS + 1, seamless = false, moving = true))
        // a newer OPEN BASE replaces the older one: its own deed, its own bound
        w.start(311, 121, 50_000.0)
        assertEquals(311, w.catalogX); assertEquals(121, w.catalogY)
        assertEquals(SeamWait.WAIT, w.step(50_000.0 + WorldEngineHost.DIVE_STALL_MS, seamless = false, moving = false))
    }

    /** The wiring spans the host, the HUD and the Kingdom tab, which no unit test above can see, so it is pinned here. */
    @Test fun `the host polls the frame it just drew, keeps frames coming while it waits, and the Kingdom scene gets the camera`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val realmMode = host.substring(host.indexOf("            MODE_REALM -> {"), host.indexOf("    // ---------------------------------------------------------------- dive and leave"))
        assertTrue("seamless reads the realm frame just drawn", realmMode.indexOf("rr.frame(") in 0 until realmMode.indexOf("seamStep(rr, now)"))
        assertTrue("frames keep coming while the seam waits (its bound needs them)", "|| seamWait.pending" in host.substring(host.indexOf("private fun schedule")))
        val leave = host.substring(host.indexOf("private fun startLeave"), host.indexOf("private fun logBand"))
        assertTrue("a leave ends the wait without opening the base", "seamWait.clear()" in leave && "BaseSeam" !in leave)
        assertTrue("the base scene's camera is world px: art px times the world tile's scale", "s.worldPerArt(spec.worldTilePixels)" in host)
        val hud = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        assertTrue("the camera is set only once the base is selected, right before the Kingdom tab",
            "model.openBase(baseId) { event.camera?.let { c -> homeCamera?.enterAt(baseId, c.worldX, c.worldY, c.zoom) }; openBaseNow() }" in hud)
        val kingdom = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue("the Kingdom scene reads the shared controls", "cameraControls = gg.pixelkingdomwars.nativeclient.scene.LocalSceneHost.current?.homeCamera" in kingdom)
    }

    /**
     * D-173: a pinch-out on the realm map returns to the globe. Its first finger reaches the host frames before the pinch
     * becomes a leave, so a touch that ended the wait with the fit-open answer took a player who pinched out into his base
     * (the HUD opened it before the leave's `Leaving` arrived). A tap elsewhere, or the HUD's zoom, minimap or a flight, is
     * the player looking elsewhere: with the wait left armed, its bound opened the Kingdom tab 12 s later while he browsed.
     * Taking the camera cancels the wait and nothing opens; OPEN BASE again starts a new seam.
     */
    @Test fun `a touch, a pinch-out or a HUD camera control cancels OPEN BASE and nothing opens`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val cancel = host.substring(host.indexOf("private fun seamCancel"), host.indexOf("// ---------------------------------------------------------------- engine events"))
        assertTrue("a cancel tells the HUD that nothing opens", "seamWait.clear()" in cancel && "callbacks.event(WorldHudEvent.BaseSeamCancelled(cx, cy))" in cancel)
        assertFalse("never the fit-open answer", "WorldHudEvent.BaseSeam(" in cancel)
        val touch = host.substring(host.indexOf("override fun touchDown"), host.indexOf("override fun touchDragged"))
        // (a resume's landing under its clouds takes no touch: no map is on screen yet, so no OPEN BASE waits then)
        assertTrue("any finger on the map (a pinch-out's first) cancels", "MODE_REALM -> if (!landingHeld) { seamCancel(" in touch)
        assertFalse("a touch never opens the base at its fit", "seamGiveUp(" in touch)
        val zoom = host.substring(host.indexOf("override fun zoom(steps: Int)"), host.indexOf("override fun home()"))
        assertTrue("the HUD's -/+ cancels", "if (mode == MODE_REALM) seamCancel(" in zoom)
        assertTrue("a minimap tap or a drag of its view box cancels",
            "if (gesture is MinimapGesture.Tap || gesture is MinimapGesture.DragTo) seamCancel(" in host)
        assertTrue("a flight to a deed (MY PARCEL, Look closer, a search pick) cancels",
            "is WorldIntent.FlyTo -> if (mode == MODE_REALM) (intent.target as? WorldTarget.Deed)?.let { seamCancel(" in host)
        // a cancelled wait never reaches its bound, so the fit-open answer cannot come later either
        val w = SeamWait(WorldEngineHost.DIVE_STALL_MS)
        w.start(310, 120, 0.0); w.clear()
        assertEquals(SeamWait.WAIT, w.step(WorldEngineHost.DIVE_STALL_MS + 1, seamless = false, moving = true))
        // the HUD drops its request on the cancel, without selecting or opening the base
        val hud = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        val answer = hud.substring(hud.indexOf("is WorldHudEvent.BaseSeamCancelled ->"), hud.indexOf("onDispose { bridge.listen(null) }"))
        assertTrue("the request for that deed is dropped",
            "if (seamPending?.let { it.second == event.catalogX && it.third == event.catalogY } == true) seamPending = null" in answer)
        assertFalse("and nothing opens", "openBase" in answer)
    }

    /**
     * OPEN BASE sits on the realm card, and the card stays up while the seam waits, so the first Back lands on the card's
     * layer (REALM_CARD outranks REALM_MAP). The card's own Back only closes it and starts no leave, the one other end of
     * the wait, and the flight then opened the Kingdom tab anyway. While the seam waits that Back cancels it instead:
     * nothing opens and the card stays.
     */
    @Test fun `Back while OPEN BASE waits cancels it at the card and nothing opens`() {
        val onCard = WorldHudUi(mode = WorldHudMode.REALM, realmId = "crownlands", card = RealmCard(5000, 200, 6))
        assertEquals("the first Back lands on the card, above the map's leave", BackPriority.REALM_CARD, WorldHudFlow.backLayers(onCard).maxOrNull())
        val closed = WorldHudFlow.back(onCard, BackPriority.REALM_CARD)
        assertFalse("the card's own Back starts no leave", WorldIntent.Leave in closed.intents)
        assertEquals(WorldHudMode.REALM, closed.ui.mode)
        val hud = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldHudScreen.kt").readText()
        val back = hud.substring(hud.indexOf("// ---- back chain"), hud.indexOf("val density = LocalDensity.current"))
        assertTrue("the card's layer answers Back while the seam waits, card or no card",
            "BackHandlerAt(priority, priority in layers || (seamBack && seamPending != null))" in back && "val seamBack = priority == BackPriority.REALM_CARD" in back)
        assertTrue("that Back drops the request and ends the host's wait, and does nothing else",
            "if (seamBack && seamPending != null) { seamPending = null; bridge.controls?.cancelBase() } else applyNow(" in back)
        // the host ends its wait silently: an answer could match a newer OPEN BASE on the same deed
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/scene/world/WorldEngineHost.kt").readText()
        val cancelBase = host.substring(host.indexOf("override fun cancelBase()"), host.indexOf("fun setLayout("))
        assertTrue("seamWait.clear()" in cancelBase)
        assertFalse("no answer from a HUD cancel", "callbacks.event" in cancelBase)
    }
}
