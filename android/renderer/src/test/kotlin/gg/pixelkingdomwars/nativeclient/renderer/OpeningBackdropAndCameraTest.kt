package gg.pixelkingdomwars.nativeclient.renderer

import java.io.File
import org.junit.Test
import kotlin.test.*

/**
 * Owner 2026-10-06: "black screen is low quality indication". Scene-transitions spec §1.1/§2: before a renderer has its own
 * ground (and always for a realm kit, which has no v1 ground) it cleared to near-black; it now clears to the requested
 * scene's realm ground colour. And the swap from a postcard to the live scene must not jump: the drawn camera says whether
 * the player framed it, so a reopening Home hands exactly that camera to the new renderer (a fit is recomputed the same way).
 */
class OpeningBackdropAndCameraTest {
    private val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()

    @Test fun `the clear colour is the ground, else the scene's realm colour, and near-black only with neither`() {
        val frame = source.substring(source.indexOf("private fun renderFrame()"), source.indexOf("private var publishedCamera"))
        val ground = frame.indexOf("if (backdrop != null) Gdx.gl.glClearColor(backdrop.red, backdrop.green, backdrop.blue, 1f)")
        val realm = frame.indexOf("else if (opening != null) Gdx.gl.glClearColor(")
        val fallback = frame.indexOf("else Gdx.gl.glClearColor(0.035f, 0.055f, 0.04f, 1f)")
        assertTrue(ground >= 0 && realm > ground && fallback > realm, "ground first, then the realm colour, then the old fallback")
    }

    @Test fun `both base and battle preparations publish the realm colour before any heavy work`() {
        assertEquals(1, Regex("""realmBackdrop\(frozen\)\?\.let \{ openingBackdrop = it \}""").findAll(source).count(), "the base preparation")
        assertEquals(1, Regex("""realmBackdrop\(frozen\.base\)\?\.let \{ openingBackdrop = it \}""").findAll(source).count(), "the battle preparation")
        assertTrue("groundRules?.artFor(visual)?.sources?.get(visual.realmId)?.color" in source, "the realm colour comes from the pack's ground art")
    }

    @Test fun `the drawn camera says whether the player framed it`() {
        val fit = BaseCameraView("base", 640f, 640f, 1f, 1080, 2400)
        assertFalse(fit.moved, "a scene's own fit is not a framed camera")
        val framed = fit.copy(moved = true)
        assertTrue(fit.matches("base", 640f, 640f, 1f, 1080, 2400))
        assertFalse(fit.matches("base", 640f, 640f, 1f, 1080, 2400, moved = true), "a pinch that ends on the same numbers is still news")
        assertTrue(framed.copy(overlayVisible = false).moved, "hiding chrome during contact keeps the framing")
        assertTrue("BaseCameraView(active.baseId, camera.position.x, camera.position.y, camera.zoom, width, height, moved = cameraFraming.moved)" in source)
    }

    @Test fun `a pending entry is visible so a reopening Home never overrides the World seam's`() {
        val controls = SceneCameraControls(null)
        assertFalse(controls.entryPending)
        controls.enterAt("base", 10f, 20f, 1.5f)
        assertTrue(controls.entryPending)
        assertNull(controls.entryFor("other", false), "another base leaves it waiting")
        assertTrue(controls.entryPending)
        assertNotNull(controls.entryFor("base", false))
        assertFalse(controls.entryPending, "consumed on its base's first frame")
        controls.enterAt("base", 1f, 1f, 1f); controls.cancelEntry()
        assertFalse(controls.entryPending)
    }
}
