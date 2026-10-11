package gg.pixelkingdomwars.nativeclient.scene.world

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.3 and §5.7: the world context asks for robustness so a Mali GPU reset is reported (libGDX's
 * factory never does), falls back so the World tab still opens, and the shared worker context matches the world
 * context's reset strategy exactly (EGL refuses a mismatched share with `EGL_BAD_MATCH`: no worker, every program on
 * the GL thread).
 */
class WorldEglTest {
    private val robust = "EGL_KHR_image_base EGL_EXT_create_context_robustness EGL_ANDROID_presentation_time"
    private val withPriority = "$robust EGL_IMG_context_priority"

    private fun IntArray.pairs(): Map<Int, Int> {
        assertEquals("EGL attribute lists end with EGL_NONE", WorldEgl.EGL_NONE, last())
        assertEquals(1, size % 2)
        return (0 until size - 1 step 2).associate { this[it] to this[it + 1] }
    }

    @Test fun `the world context asks for a lose-on-reset robust ES 3 context first, then falls back`() {
        val ladder = WorldEgl.worldLadder(3, robust)
        assertEquals(listOf(WorldEgl.ContextSpec(3, true), WorldEgl.ContextSpec(3, false), WorldEgl.ContextSpec(2, false)), ladder)
        val first = ladder.first().attributes().pairs()
        assertEquals(3, first[WorldEgl.EGL_CONTEXT_CLIENT_VERSION])
        assertEquals(WorldEgl.EGL_TRUE, first[WorldEgl.EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT])
        assertEquals(WorldEgl.EGL_LOSE_CONTEXT_ON_RESET_EXT, first[WorldEgl.EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT])
    }

    @Test fun `without the robustness extension no robustness attribute is ever sent`() {
        val ladder = WorldEgl.worldLadder(3, "EGL_KHR_image_base")
        assertTrue(ladder.none { it.robust })
        assertTrue(ladder.all { WorldEgl.EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT !in it.attributes().pairs() })
        assertEquals(listOf(WorldEgl.ContextSpec(2, false)), WorldEgl.worldLadder(2, null))
    }

    @Test fun `the worker copies the world context's version and reset strategy and only adds a low priority`() {
        for (world in listOf(WorldEgl.ContextSpec(3, true), WorldEgl.ContextSpec(3, false), WorldEgl.ContextSpec(2, false))) {
            val ladder = WorldEgl.workerLadder(world, withPriority)
            assertEquals(2, ladder.size)
            assertTrue("$world", ladder.all { it.version == world.version && it.robust == world.robust })
            val first = ladder.first().attributes().pairs()
            assertEquals(WorldEgl.EGL_CONTEXT_PRIORITY_LOW_IMG, first[WorldEgl.EGL_CONTEXT_PRIORITY_LEVEL_IMG])
            assertEquals(world.robust, first[WorldEgl.EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT] == WorldEgl.EGL_LOSE_CONTEXT_ON_RESET_EXT)
            assertFalse("the fallback drops only the priority", WorldEgl.EGL_CONTEXT_PRIORITY_LEVEL_IMG in ladder[1].attributes().pairs())
        }
        assertEquals(listOf(WorldEgl.ContextSpec(3, true)), WorldEgl.workerLadder(WorldEgl.ContextSpec(3, true), robust))
    }

    @Test fun `extension names match whole tokens only`() {
        assertTrue(WorldEgl.listed(robust, WorldEgl.EXT_ROBUSTNESS))
        assertTrue(WorldEgl.listed(robust, WorldEgl.EXT_PRESENTATION_TIME))
        assertFalse(WorldEgl.listed("EGL_ANDROID_presentation_time_extra", WorldEgl.EXT_PRESENTATION_TIME))
        assertFalse(WorldEgl.listed("XEGL_ANDROID_presentation_time", WorldEgl.EXT_PRESENTATION_TIME))
        assertTrue(WorldEgl.listed("EGL_ANDROID_presentation_time_extra EGL_ANDROID_presentation_time", WorldEgl.EXT_PRESENTATION_TIME))
        assertFalse(WorldEgl.listed(null, WorldEgl.EXT_ROBUSTNESS))
    }
}
