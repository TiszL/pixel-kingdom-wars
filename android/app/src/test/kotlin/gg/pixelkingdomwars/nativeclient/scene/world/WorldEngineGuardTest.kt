package gg.pixelkingdomwars.nativeclient.scene.world

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §8.1 (D-168.3, RM-GPU-1): a GL30 world engine must never render on a host GPU through an emulator.
 * The owner's Mac hung on a realm-map shader on 2026-09-24; an emulator whose GLES is translated to that GPU would put
 * the same shaders there. On an emulator only SwiftShader (the CPU renderer) may run them.
 */
class WorldEngineGuardTest {
    private val es3 = 0x30000
    private val ES32 = "OpenGL ES 3.2 v1.r38p1-01eac0.0cc4b6a3b1e8e7a6b8a0f7c8d7c1ec33"
    private val ES31 = "OpenGL ES 3.1 SwiftShader 4.0.0.1"

    @Test fun `an emulator whose renderer is not SwiftShader always gets the legacy globe`() {
        for (hardware in listOf("ranchu", "goldfish", "Ranchu", "goldfish_arm64"))
            for (renderer in listOf("Android Emulator OpenGL ES Translator (Apple M3 Pro)", "ANGLE (Apple, Metal)", "", null)) {
                val d = WorldEngineGuard.decide(hardware, renderer, gl30Present = true, glVersion = ES32, glExtensions = null)
                assertEquals("$hardware / $renderer", WorldEngineChoice.LEGACY, d.choice)
                assertTrue("the reason names why (it is logged): ${d.reason}", "SwiftShader" in d.reason)
            }
    }

    @Test fun `an emulator on SwiftShader and a real device may run the GL30 engines`() {
        assertTrue(WorldEngineGuard.decide("ranchu", "Google SwiftShader", true, ES31, null).gl30)
        assertTrue(WorldEngineGuard.decide("ranchu", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))", true, ES32, null).gl30)
        assertTrue(WorldEngineGuard.decide("mt6878", "Mali-G615 MC2", true, ES32, null).gl30)
    }

    @Test fun `libGDX's silent ES 2 fallback means legacy, even on a device`() {
        val d = WorldEngineGuard.decide("mt6878", "Mali-G615 MC2", gl30Present = false, glVersion = ES32, glExtensions = null)
        assertEquals(WorldEngineChoice.LEGACY, d.choice)
        assertFalse(d.gl30)
    }

    @Test fun `a GL30 context is requested only when admitted and the device reports GLES 3`() {
        assertFalse("the World tab stays the legacy globe until N1", WorldEngineGuard.admitContext(false, es3).gl30)
        assertFalse(WorldEngineGuard.admitContext(true, 0x20000).gl30)
        assertTrue(WorldEngineGuard.admitContext(true, es3).gl30)
        assertTrue(WorldEngineGuard.admitContext(true, 0x30002).gl30)
    }

    /**
     * N0 review defect 3 (2026-09-25): on an ES 3.1 driver the `GLES32` entry points are logging stubs. Called
     * unchecked, reset detection is silently off and every staged copy silently does nothing (the guarded smoke saw
     * "called unimplemented OpenGL ES API" on the emulator's ES 3.1 context). So the choice comes from GL_VERSION first,
     * then the one copy extension with an android.opengl binding, and otherwise no staging ring.
     */
    @Test fun `the reset and copy entry points follow GL_VERSION, then GL_EXT_copy_image, then none`() {
        assertEquals(Gles3Paths(ResetQuery.ES32, CopyImage.ES32), WorldEngineGuard.paths(ES32, null))
        assertEquals("an ES 3.2 driver needs no extension", Gles3Paths(ResetQuery.ES32, CopyImage.ES32), WorldEngineGuard.paths("OpenGL ES 3.2", ""))
        assertEquals(Gles3Paths(ResetQuery.NONE, CopyImage.EXT), WorldEngineGuard.paths(ES31, "GL_OES_x GL_EXT_copy_image GL_KHR_debug"))
        assertEquals("GL_OES_copy_image has no android.opengl binding", Gles3Paths(ResetQuery.NONE, CopyImage.NONE),
            WorldEngineGuard.paths(ES31, "GL_OES_copy_image GL_EXT_robustness GL_KHR_robustness"))
        assertEquals("a whole-token match only", CopyImage.NONE, WorldEngineGuard.paths(ES31, "GL_EXT_copy_image_extra").copy)
        assertEquals(Gles3Paths.ES30, WorldEngineGuard.paths("OpenGL ES 3.0 V@415.0", null))
        for (unreadable in listOf(null, "", "3.2", "OpenGL 4.6", "WebGL 2.0", "OpenGL ES-CM 1.1"))
            assertEquals("'$unreadable' never admits an ES 3.2 entry point", ResetQuery.NONE, WorldEngineGuard.paths(unreadable, null).reset)
        assertFalse(Gles3Paths(ResetQuery.NONE, CopyImage.NONE).stagingCopy)
        assertTrue(Gles3Paths(ResetQuery.NONE, CopyImage.EXT).stagingCopy)
    }

    @Test fun `the GL30 decision carries the chosen paths and says so in its logged reason`() {
        val seeker = WorldEngineGuard.decide("mt6878", "Mali-G615 MC2", true, ES32, null)
        assertEquals(Gles3Paths(ResetQuery.ES32, CopyImage.ES32), seeker.paths)
        assertTrue(seeker.reason, "reset es32, copy es32" in seeker.reason && "3.2" in seeker.reason)
        val emulator = WorldEngineGuard.decide("ranchu", "Google SwiftShader", true, ES31, null)
        assertTrue("SwiftShader ES 3.1 still runs GL30, without a staging ring", emulator.gl30)
        assertEquals(Gles3Paths.ES30, emulator.paths)
        assertTrue(emulator.reason, "no staging ring" in emulator.reason)
        assertEquals("a legacy decision calls nothing beyond ES 3.0", Gles3Paths.ES30,
            WorldEngineGuard.decide("ranchu", "Android Emulator OpenGL ES Translator (Apple M3 Pro)", true, ES32, null).paths)
    }

    @Test fun `GL_VERSION parses to major and minor`() {
        assertEquals(0x30002, WorldEngineGuard.glesVersion(ES32))
        assertEquals(0x30001, WorldEngineGuard.glesVersion(ES31))
        assertEquals(0x30000, WorldEngineGuard.glesVersion("OpenGL ES 3.0 (OpenGL ES 3.1 SwiftShader 4.0)"))
        assertEquals(0, WorldEngineGuard.glesVersion("ANGLE OpenGL ES 3.2"))
    }

    @Test fun `hardware that is not an emulator is never mistaken for one`() {
        for (hardware in listOf("mt6878", "qcom", "exynos2200", "", null)) assertFalse("$hardware", WorldEngineGuard.isEmulator(hardware))
    }
}
