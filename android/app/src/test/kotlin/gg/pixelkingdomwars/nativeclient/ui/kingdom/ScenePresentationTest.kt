package gg.pixelkingdomwars.nativeclient.ui.kingdom

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06, verbatim: "black screen is low quality indication … loading indicator is like not well implemented …
 * professional solution". Scene-transitions spec §1–§3 as rules:
 * - a Home scene area shows the live scene, else its postcard, else the realm wallpaper — no black, no plate;
 * - the HUD only over a picture of the kingdom;
 * - no indicator before 400 ms, once shown at least 300 ms, the cause only from 2 s and TRY AGAIN only from 8 s or a failure;
 * - the swap waits 2 vsyncs and takes 180 ms (120 ms reduced) with the camera handed over, so it does not jump.
 */
class ScenePresentationTest {
    private fun clockRun(doneAt: Long?, failedAt: Long? = null, until: Long = 10_000): List<Pair<Long, IndicatorStage>> {
        val clock = IndicatorClock()
        return (0..until step 50).map { t -> t to clock.stage(t, waiting = doneAt == null || t < doneAt, failed = failedAt != null && t >= failedAt) }
    }

    @Test fun `there is no black and no plate state, only pictures`() {
        assertEquals(listOf("LIVE", "POSTCARD", "REALM_VEIL"), ScenePicture.entries.map { it.name })
        assertEquals(ScenePicture.LIVE, scenePicture(live = true, postcard = true))
        assertEquals(ScenePicture.POSTCARD, scenePicture(live = false, postcard = true))
        assertEquals(ScenePicture.REALM_VEIL, scenePicture(live = false, postcard = false))
    }

    @Test fun `the HUD shows over the live kingdom or its postcard, never over the wallpaper cover`() {
        assertTrue(homeHudShown(ScenePicture.LIVE))
        assertTrue(homeHudShown(ScenePicture.POSTCARD))
        assertFalse(homeHudShown(ScenePicture.REALM_VEIL))
    }

    @Test fun `indicator appears only after 400 ms`() {
        val run = clockRun(doneAt = null)
        assertTrue(run.filter { it.first < 400 }.all { it.second == IndicatorStage.HIDDEN })
        assertEquals(IndicatorStage.LINE, run.first { it.first == 400L }.second)
        assertTrue("a scene live within 400 ms never shows an indicator", clockRun(doneAt = 350).all { it.second == IndicatorStage.HIDDEN })
    }

    @Test fun `indicator stays at least 300 ms once shown`() {
        val run = clockRun(doneAt = 450)
        assertEquals("shown at 400", IndicatorStage.LINE, run.first { it.first == 400L }.second)
        assertTrue("held while the scene is already live", run.filter { it.first in 450L..650L }.all { it.second == IndicatorStage.LINE })
        assertEquals("gone after its 300 ms", IndicatorStage.HIDDEN, run.first { it.first == 700L }.second)
    }

    @Test fun `cause text only from 2 s and retry only from 8 s or on failure`() {
        val run = clockRun(doneAt = null)
        assertTrue(run.filter { it.first in 400L until 2_000L }.all { it.second == IndicatorStage.LINE })
        assertTrue(run.filter { it.first in 2_000L until 8_000L }.all { it.second == IndicatorStage.CAUSE })
        assertTrue(run.filter { it.first >= 8_000L }.all { it.second == IndicatorStage.RETRY })
        assertEquals("a failure offers TRY AGAIN at once", IndicatorStage.RETRY, clockRun(doneAt = null, failedAt = 100).first { it.first == 100L }.second)
    }

    @Test fun `the swap waits two vsyncs and fades in 180 ms, 120 ms with reduced motion`() {
        assertEquals(2, SWAP_VSYNCS)
        assertEquals(180, swapMs(reducedMotion = false))
        assertEquals(120, swapMs(reducedMotion = true))
        assertEquals("the in-scene line steps at 12 fps", 83, LINE_STEP_MS)
        assertEquals(8, LINE_BLOCKS)
    }

    private fun main(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    @Test fun `no Home path shows the dark backdrop over the scene area`() {
        val layer = main("ui/kingdom/ScenePresentation.kt")
        for (dark in listOf("LoadingOverlay(", "LoadingCard(", "Palette.backdrop", "0xFF100E14"))
            assertFalse("the cover never draws $dark", layer.contains(dark))
        assertTrue("no picture means the loading wallpaper", layer.contains("LoadingBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .9f)"))
        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertFalse(kingdom.contains("LoadingOverlay("))
        assertFalse(kingdom.contains("KingdomOpenNotice("))
        // Rewritten 2026-10-06 (PKWFrames: every frame after the swap over 16 ms): the alpha is still in graphicsLayer, now
        // modulating each draw instead of compositing a full-screen offscreen layer per frame.
        assertTrue("the swap alpha lives in graphicsLayer, never on the SurfaceView",
            layer.contains(".graphicsLayer { alpha = cover.value; compositingStrategy = CompositingStrategy.ModulateAlpha }"))
        assertTrue(layer.contains("repeat(SWAP_VSYNCS) { withFrameNanos { } }"))
    }

    @Test fun `Home passes its readiness and the shell gates the HUD on a picture`() {
        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertTrue(kingdom.contains("onPresentationReady = { sceneLive = it }"))
        assertTrue(kingdom.contains("SideEffect { model.homePicture.value = homeHudShown(picture) }"))
        assertTrue("scene taps are swallowed until live", kingdom.contains("chipTap.allowFootprint() && sceneLive &&"))
        assertTrue("the chat layer stands over a picture only", kingdom.contains("if (!editing && homeHudShown(picture)) Box(Modifier.matchParentSize()"))
        assertTrue("the first-run cards too", kingdom.contains("!local.buildMenu && homeHudShown(picture)) guideTutorial?.let {"))
        assertTrue("saved-payment recovery is never hidden by the cover (money first)",
            kingdom.contains("if (!editing && liveTray == null && homeStatusShown(state.selectedBuilding != null, local.placement != null)) Column("))
        val app = main("ui/nav/PkwApp.kt")
        assertTrue(app.contains("hudShown = kingdomPicture"))
        val scaffold = main("ui/home/HomeScaffold.kt")
        // Rewritten 2026-10-06 (PKWFrames): hidden means composed and measured but not placed (not drawn, not tappable, not in
        // semantics), so the HUD's first composition never lands in the swap frames; it still fades in over 160 ms.
        assertTrue("the HUD fades in over 160 ms", scaffold.contains("Box(Modifier.fillMaxSize().placedOnlyWhen(hudShown || hudAlpha > 0f)"))
        assertTrue(scaffold.contains("if (hudShown) gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens.Motion.PLATE_IN else 0"))
    }

    @Test fun `camera is handed over at the swap`() {
        val kingdom = main("ui/kingdom/KingdomScreen.kt")
        assertTrue("a framed camera opens the new renderer where the postcard was drawn, unless a World seam entry waits",
            kingdom.contains("if (!live && camera.moved && !controls.entryPending) controls.enterAt(card.key.baseId, camera.x, camera.y, camera.zoom)"))
        val postcards = main("scene/ScenePostcards.kt")
        assertTrue("the postcard keeps the camera it was drawn with", postcards.contains("PostcardCamera(it.cameraX, it.cameraY, it.zoom, it.moved)"))
    }
}
