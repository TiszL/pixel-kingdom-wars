package gg.pixelkingdomwars.nativeclient.renderer.globe2

import com.badlogic.gdx.files.FileHandle
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.world.InputScale
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The host adapters (lane NG): the HUD's view-px layout reaches the engine in buffer px (a wrong scale would frame the
 * globe under the header on the Seeker's 2.6× buffer), the debug world bundle serves its manifest's hashes (content
 * activates only after hash verification), and the shader source serves exactly the pinned stages or none.
 */
class GlobeWiringTest {
    @Test fun `the HUD layout crosses from view px (x, y, w, h) to buffer px (x0, y0, x1, y1)`() {
        val input = InputScale().also { it.set(1200, 2670, 914, 2034) }
        val l = globeLayoutFromView(210f, floatArrayOf(1100f, 400f, 80f, 300f), 1, floatArrayOf(0f, 210f, 1200f, 1400f), input)
        assertEquals(210f * input.sy, l.top, 1e-3f)
        assertEquals(1100f * input.sx, l.obstacles[0], 1e-3f); assertEquals((1100f + 80f) * input.sx, l.obstacles[2], 1e-3f)
        assertEquals((400f + 300f) * input.sy, l.obstacles[3], 1e-3f)
        assertEquals(1, l.obstacleCount)
        val free = assertNotNull(l.panelFree)
        assertEquals((210f + 1400f) * input.sy, free[3], 1e-3f)
        assertNull(globeLayoutFromView(0f, FloatArray(0), 0, null, input).panelFree, "no panel: the whole screen")
    }

    @Test fun `the debug world bundle serves its manifest's hashes, and is absent without one`() {
        val dir = Files.createTempDirectory("globe-world").toFile()
        try {
            val root = FileHandle(dir)
            assertNull(GdxGlobeFiles.worldBundle(root), "no content.json: no bundle (release builds)")
            root.child("globe-v2").mkdirs(); root.child("globe-v2/a.png").writeBytes(byteArrayOf(1, 2, 3), false)
            root.child("content.json").writeString("""{"pin":"x","files":[{"path":"globe-v2/a.png","sha256":"abc","bytes":3}]}""", false, "UTF-8")
            val files = assertNotNull(GdxGlobeFiles.worldBundle(root))
            assertEquals("abc", files.expectedSha256("globe-v2/a.png"))
            assertNull(files.expectedSha256("globe-v2/unlisted.png"), "an unlisted file has no pin, so the loader refuses it")
            assertEquals(3, files.read("globe-v2/a.png")!!.size); assertNull(files.read("missing.png"))
        } finally { dir.deleteRecursively() }
    }

    @Test fun `the shader source serves the pinned stages exactly, or nothing`() {
        assertNull(WorldShadersGlobeSource.stages("no-such-program"))
        for ((name, p) in WorldShaders.globe) {
            val s = assertNotNull(WorldShadersGlobeSource.stages(name))
            assertEquals(p.vs.sha256, s.vsSha256); assertEquals(p.fs.sha256, s.fsSha256)
            assertTrue(s.vs.startsWith("#version 300 es") && s.fs.startsWith("#version 300 es"), name)
        }
        // the half-scale step borrows exactly one realm program, the pinned lowres blit (explicit attribute location 0)
        val blit = assertNotNull(WorldShadersGlobeSource.stages(GlobeV2Renderer.PROGRAM_BLIT))
        assertEquals(WorldShaders.realm.getValue(GlobeV2Renderer.PROGRAM_BLIT).fs.sha256, blit.fsSha256)
        assertTrue("layout(location = 0) in vec2 aPos" in blit.vs, "the core's full-screen triangle feeds attribute 0")
        assertNull(WorldShadersGlobeSource.stages("rm-chart"), "no other realm program is served as a globe program")
    }
}
