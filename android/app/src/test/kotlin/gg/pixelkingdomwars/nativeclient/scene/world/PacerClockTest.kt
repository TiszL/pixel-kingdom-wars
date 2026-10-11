package gg.pixelkingdomwars.nativeclient.scene.world

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §5.6: the Seeker's panel runs at about 120 Hz and libGDX requests a render on every touch event.
 * Unpaced, a pan renders at ~120 fps (double GPU and CPU cost) or judders between 60 and 120. The pacer must start a
 * world frame on every 2nd vsync at 120 Hz no matter how many requests arrive, present each frame exactly that many
 * vsyncs after its start, and answer at once after idle.
 */
class PacerClockTest {
    private fun vsyncs(hz: Float, count: Int, jitterNs: Long = 0L): LongArray {
        val period = PacerClock.periodOf(hz)
        return LongArray(count) { 1_000_000_000L + it * period + (if (it % 2 == 0) jitterNs else -jitterNs) }
    }

    @Test fun `vsyncs per frame meet the target without dropping below it`() {
        assertEquals(2, PacerClock.intervalFor(120f, 60))
        assertEquals(2, PacerClock.intervalFor(119.88f, 60))
        assertEquals(1, PacerClock.intervalFor(60f, 60))
        assertEquals(1, PacerClock.intervalFor(59.94f, 60))
        assertEquals("90 Hz: 90 fps, never 45 (below the 60 fps bar)", 1, PacerClock.intervalFor(90f, 60))
        assertEquals(2, PacerClock.intervalFor(144f, 60))
        assertEquals("ladder L3", 4, PacerClock.intervalFor(120f, 30))
        assertEquals(2, PacerClock.intervalFor(60f, 30))
        assertEquals("a display reporting 0 Hz keeps rendering", 1, PacerClock.intervalFor(0f, 60))
    }

    @Test fun `continuous demand at 120 Hz starts a frame on exactly every second vsync, even with jitter`() {
        for (jitter in listOf(0L, 700_000L)) {
            val clock = PacerClock(60, 120f)
            val started = vsyncs(120f, 240, jitter).map { clock.onVsync(it, want = true, inFlight = false) }
            assertEquals("jitter $jitter", 120, started.count { it })
            assertTrue("never two starts in a row", started.zipWithNext().none { (a, b) -> a && b })
        }
    }

    @Test fun `a touch storm cannot raise the rate above the target`() {
        val clock = PacerClock(60, 120f)
        // every vsync carries a fresh render request (libGDX's touch handler)
        val starts = vsyncs(120f, 120).count { clock.onVsync(it, want = true, inFlight = false) }
        assertEquals(60, starts)
    }

    @Test fun `a frame still in flight is never stacked behind`() {
        val clock = PacerClock(60, 120f)
        val v = vsyncs(120f, 6)
        assertTrue(clock.onVsync(v[0], true, false))
        assertFalse("the frame from v0 has not started drawing", clock.onVsync(v[2], true, inFlight = true))
        assertTrue("it drew; the next vsync may start", clock.onVsync(v[3], true, false))
    }

    @Test fun `a request the view dropped is forgotten, so the world cannot freeze on it`() {
        val clock = PacerClock(60, 120f)
        val v = vsyncs(120f, 40)
        assertTrue(clock.onVsync(v[0], true, false))
        assertFalse("still inside the stale window", clock.inFlightExpired(v[20]))
        assertTrue("250 ms later the request is treated as lost", clock.inFlightExpired(v[31]))
    }

    @Test fun `nothing wanted means nothing started, and the first wanted vsync after idle starts at once`() {
        val clock = PacerClock(60, 120f)
        val v = vsyncs(120f, 20)
        assertTrue(clock.onVsync(v[0], true, false))
        for (i in 1 until 10) assertFalse(clock.onVsync(v[i], want = false, inFlight = false))
        assertTrue("idle for 9 vsyncs: no wait for a cadence slot", clock.onVsync(v[11], true, false))
    }

    @Test fun `each frame is presented exactly interval vsyncs after its start`() {
        for ((hz, fps) in listOf(120f to 60, 60f to 60, 120f to 30)) {
            val clock = PacerClock(fps, hz)
            val start = 5_000_000_000L
            assertEquals(0L, clock.presentationTargetNs())
            assertTrue(clock.onVsync(start, true, false))
            val target = clock.presentationTargetNs()
            val period = PacerClock.periodOf(hz)
            // the compositor presents at the first vsync at or after the target
            val presentVsync = start + ((target - start + period - 1) / period) * period
            assertEquals("$hz Hz at $fps fps", start + clock.interval * period, presentVsync)
        }
    }

    @Test fun `a refresh change or a target change applies to the next frame`() {
        val clock = PacerClock(60, 60f)
        assertEquals(1, clock.interval)
        clock.setRefresh(120f); assertEquals(2, clock.interval)
        clock.setTarget(30); assertEquals(4, clock.interval)
        clock.setRefresh(Float.NaN); assertEquals("a bogus rate keeps the last good one", 120f, clock.refreshHz)
    }
}
