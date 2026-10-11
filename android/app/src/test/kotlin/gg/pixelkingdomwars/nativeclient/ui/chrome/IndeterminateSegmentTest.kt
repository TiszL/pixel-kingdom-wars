package gg.pixelkingdomwars.nativeclient.ui.chrome

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Owner screenshot 2026-10-06: "Opening your kingdom…" with a bar "about half full". The bar measured nothing: it was a
 * 30 % segment ping-ponging, and under reduced motion it parked at 35–65 %. Scene-transitions spec §1.3: an indeterminate
 * line is a one-way sweep or nothing — never a segment frozen in place, never moving backwards.
 */
class IndeterminateSegmentTest {
    @Test fun `with no sweep running nothing is lit, so a frozen half-full segment can never be drawn`() {
        assertNull(indeterminateSegment(null))
    }

    @Test fun `the sweep only moves forward and stays inside the track`() {
        var lastStart = -1f
        for (step in 0..100) {
            val segment = indeterminateSegment(step / 100f) ?: continue
            assertTrue("inside the track", segment.first >= 0f && segment.second <= 1f && segment.second > segment.first)
            assertTrue("never wider than the 30 % segment", segment.second - segment.first <= .3f + 1e-4f)
            assertTrue("one-way: the lit span never moves backwards", segment.first >= lastStart)
            lastStart = segment.first
        }
        assertEquals("it enters at the left", 0f, indeterminateSegment(0.05f)!!.first, 0f)
        assertEquals("and leaves at the right", 1f, indeterminateSegment(0.99f)!!.second, 0f)
    }

    @Test fun `the progress bar uses the one-way sweep and lights nothing under reduced motion`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/chrome/Controls.kt").readText()
        val bar = source.substring(source.indexOf("@Composable private fun WebProgress"), source.indexOf("@Composable fun CircularProgressIndicator"))
        assertTrue(bar.contains("val phase = if(progress==null && !reduced) loadingPhase() else null"))
        assertTrue(bar.contains("indeterminateSegment(phase?.value)"))
        assertFalse("no parked segment", bar.contains("?: .5f"))
        assertFalse("no ping-pong", bar.contains("reverse = true"))
    }
}
