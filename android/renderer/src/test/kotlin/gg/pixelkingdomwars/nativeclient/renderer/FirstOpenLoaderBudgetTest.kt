package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test
import java.io.File

/**
 * Owner 2026-10-06: Home must open fast, with no loading screen over gameplay. Every Home re-entry builds a new renderer
 * that decodes and uploads every atlas page again; libGDX `AssetManager.update()` advances only one step of one task per
 * call, so each page waited about three GL frames for its decode hand-off and upload while the app veiled the scene. Until
 * the first complete frame nothing of this renderer is visible, so the loader may use most of a frame. After it, a scene is
 * on screen and a revision's uploads must stay one step per frame (the existing "never stack uploads" smoothness rule).
 */
class FirstOpenLoaderBudgetTest {
    private val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()

    @Test fun `a renderer with nothing on screen yet may finish several loader steps in one frame`() {
        val budget = loaderBudgetMs(presented = false)
        assertTrue(budget > 0, "the first open must not pay one frame per loader step")
        assertTrue(budget < 16, "the GL thread still yields every frame (pause handshake, input) within a 60 Hz frame")
    }

    @Test fun `once a scene is drawn the loader goes back to one step per frame`() {
        assertEquals(0, loaderBudgetMs(presented = true), "a revision under a visible scene never stacks uploads into a frame")
    }

    @Test fun `the frame loop uses the rule and only the first complete frame ends the first open`() {
        val frame = source.substring(source.indexOf("private fun renderFrame()"), source.indexOf("private var publishedCamera"))
        assertTrue("loaderBudgetMs(presented)" in frame, "the texture loader step follows the first-open rule")
        assertFalse(Regex("""\n\s*assets\.update\(\)\n""").containsMatchIn(frame), "no unconditional single-step update is left")
        assertEquals(1, Regex("""presented = true""").findAll(source).count(), "one place marks the renderer presented")
        assertTrue("renderedSceneToken=sceneToken; presented = true" in frame, "presented means a complete scene frame was drawn")
    }

    @Test fun `the opening catalogue job reuses the static art the preparation already parsed`() {
        assertTrue("private fun loadCatalogue(): List<Art> = staticArtByKey.values.toList()" in source,
            "create() queues this behind the base preparation on the same worker; parsing staticArt twice delays the first frame")
    }
}
