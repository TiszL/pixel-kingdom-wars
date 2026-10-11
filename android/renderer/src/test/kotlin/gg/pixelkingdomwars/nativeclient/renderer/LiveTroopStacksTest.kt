package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test

class LiveTroopStacksTest {
    private fun LiveTroopStacks.actor(id: Int, x: Float = 100f, y: Float = 100f, height: Float = 50f,
        alive: Boolean = true, visible: Boolean = true, alpha: Float = 1f) = drawn(id, x, y, height, alive, visible, alpha)
    private fun LiveTroopStacks.badges() = stacks.filter { it.count > 1 }

    @Test fun `counts only coincident living visible bodies at actual rendered pixels`() {
        val stacks = LiveTroopStacks()
        stacks.actor(10); stacks.actor(11); stacks.actor(12, height = 60f)
        stacks.actor(13, x = 102f); stacks.actor(14, visible = false)
        stacks.actor(15, alive = false); stacks.actor(16, alpha = 0f)
        stacks.actor(17, x = Float.NaN); stacks.actor(18, y = Float.POSITIVE_INFINITY)
        assertEquals(listOf(LiveTroopStack(10, 3, 100.0, 40.0)), stacks.badges())
    }
    @Test fun `pixel grouping uses JavaScript half ties including negative coordinates`() {
        val stacks = LiveTroopStacks()
        stacks.actor(1, x = 100.5f, y = -0.5f); stacks.actor(2, x = 101f, y = 0f)
        stacks.actor(3, x = -1.5f, y = 10f); stacks.actor(4, x = -1f, y = 10f)
        stacks.actor(5, x = 100.49999f, y = 0f)
        assertEquals(listOf(101.0, -1.0), stacks.badges().map { it.x })
        assertEquals(listOf(2, 2), stacks.badges().map { it.count })
    }
    @Test fun `moving groups follow the current frame and disappear when bodies separate`() {
        val stacks = LiveTroopStacks()
        stacks.actor(10); stacks.actor(11); stacks.actor(12)
        assertEquals(3, stacks.badges().single().count)
        stacks.beginFrame(); stacks.actor(10, x = 140f); stacks.actor(11, x = 140f); stacks.actor(12, x = 140f)
        assertEquals(LiveTroopStack(10, 3, 140.0, 50.0), stacks.badges().single())
        stacks.beginFrame(); stacks.actor(10, x = 140f); stacks.actor(11, x = 150f); stacks.actor(12, x = 160f)
        assertTrue(stacks.badges().isEmpty())
    }
    @Test fun `death rewind and corrected actor IDs cannot carry an old count into the next frame`() {
        val stacks = LiveTroopStacks()
        stacks.actor(10); stacks.actor(11); stacks.actor(12)
        stacks.beginFrame(); stacks.actor(10); stacks.actor(11); stacks.actor(12, alive = false)
        assertEquals(2, stacks.badges().single().count)
        stacks.beginFrame(); assertTrue(stacks.badges().isEmpty())
        // A corrected revision can reuse IDs; only freshly drawn living bodies count.
        stacks.actor(10); stacks.actor(11); assertEquals(2, stacks.badges().single().count)
        stacks.beginFrame(); stacks.actor(10); stacks.actor(11); stacks.actor(12)
        assertEquals(3, stacks.badges().single().count)
    }
}
