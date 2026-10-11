package gg.pixelkingdomwars.nativeclient.renderer.world

import kotlin.test.*
import org.junit.Test

class IdleSchedulerTest {
    private fun scheduler(): IdleScheduler = IdleScheduler(WebPin.IDLE).also { it.input(0L); it.frameRendered(0L) }

    @Test fun `motion renders every paced vsync and only motion frames carry the motion flag`() {
        val idle = scheduler()
        idle.setMoving(true)
        assertEquals(0L, idle.delayMs(10L)); assertTrue(idle.motion)
        idle.frameRendered(10L)
        idle.setMoving(false)
        idle.invalidate()
        assertEquals(0L, idle.delayMs(20L))
        assertFalse(idle.motion, "a one-off frame (an intent, an upload) is not a motion interval")
    }

    @Test fun `a fast animation renders at 20 fps for 20 s after input, then at 8 fps`() {
        val idle = scheduler()
        idle.animating(IdleScheduler.TAG_WATER, 16)
        assertEquals(50L, idle.delayMs(1_000L))
        assertEquals(IdleScheduler.PHASE_FULL, idle.phase)
        assertEquals(125L, idle.delayMs(20_000L))
        assertEquals(IdleScheduler.PHASE_CAPPED, idle.phase)
        idle.cadenceScale = 2 // thermal MODERATE
        assertEquals(250L, idle.delayMs(20_000L))
    }

    @Test fun `a slow animation renders only when its frame index changes`() {
        val idle = scheduler()
        idle.animating(IdleScheduler.TAG_ISLANDS, 400)
        idle.frameRendered(150L)
        assertEquals(250L, idle.delayMs(150L))
    }

    @Test fun `after 60 s everything freezes, the selection pulse included, and nothing is scheduled`() {
        val idle = scheduler()
        idle.animating(IdleScheduler.TAG_SELECT, 250)
        idle.animating(IdleScheduler.TAG_SHIELD, 100)
        idle.frameRendered(59_999L)
        val clock = idle.clockMs
        assertEquals(IdleScheduler.NEVER, idle.delayMs(60_000L), "a 4 fps pulse forever breaks the idle-battery gate")
        idle.frameRendered(60_000L)
        assertTrue(idle.frozen, "the shader draws the frozen pulse at full brightness")
        idle.frameRendered(90_000L)
        assertEquals(clock, idle.clockMs, "a frozen clock must not advance")
    }

    @Test fun `input unfreezes and the clock resumes without jumping over the frozen time`() {
        val idle = scheduler()
        idle.frameRendered(61_000L)
        val frozenAt = idle.clockMs
        idle.input(300_000L)
        idle.frameRendered(300_016L)
        assertEquals(frozenAt + 16, idle.clockMs)
        assertFalse(idle.frozen)
    }

    @Test fun `hidden, reduced motion and input-only schedule no idle frames but an invalidate still renders once`() {
        for (setup in listOf<(IdleScheduler) -> Unit>({ it.hidden = true }, { it.reducedMotion = true }, { it.inputOnly = true })) {
            val idle = scheduler()
            idle.animating(IdleScheduler.TAG_CLOUDS, 16)
            setup(idle)
            assertEquals(IdleScheduler.NEVER, idle.delayMs(100L))
            idle.invalidate()
            assertEquals(0L, idle.delayMs(100L))
            idle.frameRendered(100L)
            assertEquals(IdleScheduler.NEVER, idle.delayMs(200L))
        }
    }

    @Test fun `nothing animating means nothing scheduled`() {
        assertEquals(IdleScheduler.NEVER, scheduler().delayMs(10L))
    }
}
