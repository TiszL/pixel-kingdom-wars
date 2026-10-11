package gg.pixelkingdomwars.nativeclient.ui.world

import org.junit.Assert.*
import org.junit.Test

/** The owner rejected the landscape map because chrome hid the globe; these pin the visible-globe budget. */
class WorldChromePlanTest {
    @Test fun `seeker landscape keeps one header row and a rail so the globe owns the viewport`() {
        val plan = worldChromePlan(915, 411)
        assertTrue(plan.rail); assertTrue(plan.sidePanel); assertEquals(300, plan.panelWidth)
        assertEquals("edge + header + gap", 62, plan.stackedChrome)
        assertTrue("height ${plan.globeHeightFraction}", plan.globeHeightFraction >= .65f)
        assertTrue("width ${plan.globeWidthFraction}", plan.globeWidthFraction >= .6f)
    }
    @Test fun `portrait phones stack the chrome but keep over half of the height for the globe`() {
        listOf(360 to 740, 412 to 880, 360 to 640).forEach { (w, h) ->
            val plan = worldChromePlan(w, h)
            assertFalse(plan.rail); assertFalse(plan.sidePanel)
            assertTrue("${w}x$h height ${plan.globeHeightFraction}", plan.globeHeightFraction >= .55f)
            assertEquals(1f, plan.globeWidthFraction)
        }
        assertEquals("edge + header + realms + search + modes + gaps", 210, worldChromePlan(360, 740).stackedChrome)
    }
    @Test fun `wide tablets keep the stacked rows with a wider side panel`() {
        val portraitTablet = worldChromePlan(800, 1280)
        assertFalse(portraitTablet.rail); assertTrue(portraitTablet.sidePanel); assertEquals(360, portraitTablet.panelWidth)
        val landscapeTablet = worldChromePlan(1280, 800)
        assertFalse("taller than 480dp is not short", landscapeTablet.rail); assertTrue(landscapeTablet.sidePanel)
    }
    @Test fun `a degenerate viewport never produces a negative budget`() {
        val plan = worldChromePlan(0, 0)
        assertEquals(0f, plan.globeHeightFraction); assertEquals(1f, plan.globeWidthFraction)
    }
}
