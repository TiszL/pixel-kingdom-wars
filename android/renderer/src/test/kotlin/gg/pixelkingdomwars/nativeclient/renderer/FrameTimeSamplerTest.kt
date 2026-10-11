package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test

class FrameTimeSamplerTest {
    @Test fun `percentiles retain real slow frames and count stalls strictly above fifty milliseconds`() {
        val sampler = FrameTimeSampler(reportIntervalNanos = 5_050_000_000L, warmupNanos = 0)
        var now = 0L
        sampler.frame(now, "battle", 2, 12.0)
        var report: FrameTimeReport? = null
        for (millis in 1..100) {
            now += millis * 1_000_000L
            report = sampler.frame(now, "battle", 2, 12.0) ?: report
        }
        val result = assertNotNull(report)
        assertEquals(50.0, result.steady.p50Ms)
        assertEquals(95.0, result.steady.p95Ms)
        assertEquals(99.0, result.steady.p99Ms)
        assertEquals(50, result.steady.stallsOver50Ms)
        assertEquals(100, result.steady.count)
        assertEquals(0, result.steady.dropped)
        assertEquals(0, result.warmup.count)
        assertTrue(result.toJson().contains("\"p99Ms\":99.000"))
    }

    @Test fun `background time is excluded and resume warmup cannot pollute steady frame percentiles`() {
        val sampler = FrameTimeSampler(reportIntervalNanos = 60_000_000L, warmupNanos = 10_000_000L)
        sampler.frame(0, "base", 1, 3.0)
        sampler.frame(10_000_000, "base", 1, 3.0) // launch warmup
        sampler.frame(20_000_000, "base", 1, 3.0) // steady
        sampler.pause()
        sampler.frame(60_000_000_000, "battle", 2, 4.0) // background gap must not become a frame
        sampler.frame(60_010_000_000, "battle", 2, 4.0) // resume warmup
        sampler.frame(60_020_000_000, "battle", 2, 4.0)
        sampler.frame(60_030_000_000, "battle", 2, 4.0)
        val result = assertNotNull(sampler.frame(60_040_000_000, "battle", 2, 4.0))
        assertEquals(0.06, result.activeSeconds)
        assertEquals(2, result.warmup.count)
        assertEquals(4, result.steady.count)
        assertEquals(10.0, result.steady.p99Ms)
        assertEquals(0, result.steady.stallsOver50Ms)
        assertEquals(1, result.pauses)
        assertEquals(listOf("base", "battle"), result.scenes)
    }
}
