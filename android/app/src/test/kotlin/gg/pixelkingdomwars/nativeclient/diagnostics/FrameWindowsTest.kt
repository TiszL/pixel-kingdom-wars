package gg.pixelkingdomwars.nativeclient.diagnostics

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.Locale

/**
 * "Fast as fuck and smooth" needs numbers, not impressions: after every Home swap the UI thread's frames for 2 s are
 * summarised as one PKWFrames line (scene-transitions spec §6 targets: p95 ≤ 16.7 ms, gt33 ≤ 2). These pin the statistics
 * the acceptance table is judged on, the machine-readable format, and that it only runs where the PKWLoad sink exists.
 */
class FrameWindowsTest {
    private fun ms(value: Double) = (value * 1_000_000).toLong()

    @Test fun `percentiles and jank counts follow the acceptance table's definitions`() {
        val frames = List(90) { ms(8.0) } + List(8) { ms(20.0) } + List(2) { ms(40.0) }
        val stats = frameStats(frames.shuffled(java.util.Random(7)))
        assertEquals(100, stats.frames)
        assertEquals(8.0, stats.p50, 1e-9)
        assertEquals("the 95th of 100 frames is a 20 ms one", 20.0, stats.p95, 1e-9)
        assertEquals(40.0, stats.p99, 1e-9)
        assertEquals("frames over one 60 Hz vsync", 10, stats.over16)
        assertEquals("frames over two", 2, stats.over33)
        assertEquals("an empty window reports nothing rather than failing", FrameStats(0, 0.0, 0.0, 0.0, 0, 0), frameStats(emptyList()))
    }

    @Test fun `the line is the same on every device locale`() {
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("FRAMES window=home-swap n=3 p50=8.5 p95=16.7 p99=40.0 gt16=1 gt33=1",
                frameStatsLine("home-swap", FrameStats(3, 8.5, 16.7, 40.0, 1, 1)))
        } finally { Locale.setDefault(previous) }
    }

    @Test fun `every swap is measured, only in builds that print PKWLoad, under its own tag`() {
        val main = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
        val layer = File(main, "ui/kingdom/ScenePresentation.kt").readText()
        assertTrue(layer.contains("FrameWindows.record(activity?.window, \"home-swap\")"))
        val windows = File(main, "diagnostics/FrameWindows.kt").readText()
        assertTrue("release builds pay nothing", windows.contains("if (window == null || SceneLoadLog.sink == null) return"))
        val activity = File(main, "MainActivity.kt").readText()
        // Rewritten 2026-10-06 (field report: no line on the R8 candidate): the sink writes through DeviceLog, never Log.i.
        assertTrue(activity.contains("DeviceLog.info(if (line.startsWith(\"FRAMES \")) \"PKWFrames\" else \"PKWLoad\", line)"))
    }
}
