package gg.pixelkingdomwars.nativeclient.renderer.world

import kotlin.test.*
import org.junit.Test

class WorldFrameSamplerTest {
    private val ms = 1_000_000L

    @Test fun `idle cadence frames never become intervals or stalls`() {
        val sampler = WorldFrameSampler(reportIntervalNanos = 1_000 * ms, warmupNanos = 0)
        var t = 0L; var report: WorldFrameReport? = null
        repeat(20) { t += 125 * ms; report = sampler.frame(t, WorldScene.REALM, motion = false, 2 * ms, ms) ?: report }
        val r = assertNotNull(report)
        assertEquals(0L, r.steady.intervals)
        assertEquals(0L, r.hitches, "the 8 fps idle cadence is by design, not a stall")
        assertTrue(r.toJson().contains("\"scene\":\"realm\""))
    }

    @Test fun `a hitch inside the warmup window still counts against the gate`() {
        val sampler = WorldFrameSampler(reportIntervalNanos = 500 * ms, warmupNanos = 200 * ms)
        var t = 0L; var report: WorldFrameReport? = null
        sampler.frame(t, WorldScene.GLOBE, true, ms, ms)
        t += 80 * ms; sampler.frame(t, WorldScene.GLOBE, true, ms, ms) // first-dive hitch, in warmup
        while (report == null) { t += 16 * ms; report = sampler.frame(t, WorldScene.GLOBE, true, ms, ms) }
        assertEquals(1L, report.hitches)
        assertTrue(report.warmup.intervals > 0 && report.steady.intervals > 0)
    }

    @Test fun `a lifecycle pause never becomes a frame and cpu and swap times are reported apart`() {
        val sampler = WorldFrameSampler(reportIntervalNanos = 100 * ms, warmupNanos = 0)
        sampler.frame(0L, WorldScene.GLOBE, true, 3 * ms, 9 * ms)
        sampler.pause()
        var t = 60_000 * ms; var report: WorldFrameReport? = null
        while (report == null) { report = sampler.frame(t, WorldScene.GLOBE, true, 3 * ms, 9 * ms); t += 16 * ms }
        assertEquals(0L, report.hitches, "the background gap became a stall")
        assertEquals(3.0, report.cpuP95Ms); assertEquals(9.0, report.swapP95Ms)
        assertEquals(1, report.pauses)
    }
}
