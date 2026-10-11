package gg.pixelkingdomwars.nativeclient.diagnostics

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.FrameMetrics
import android.view.Window
import kotlin.math.ceil

/**
 * PKWFrames (scene-transitions spec §4 step 1, §6): the measurement plan needs numbers for "smooth" — how the UI thread's
 * frames behaved in the 2 s after a scene swap. HWUI FrameMetrics TOTAL_DURATION per frame, summarised as one line:
 * `FRAMES window=<label> n=<frames> p50=<ms> p95=<ms> p99=<ms> gt16=<frames over 16.7 ms> gt33=<frames over 33.3 ms>`
 * (MainActivity prints it under the PKWFrames tag). Debug and candidate builds only (the PKWLoad sink); account-free.
 */
internal data class FrameStats(val frames: Int, val p50: Double, val p95: Double, val p99: Double, val over16: Int, val over33: Int)

/** Nearest-rank percentiles over frame durations in nanoseconds; an empty window is all zeros. */
internal fun frameStats(durationsNanos: List<Long>): FrameStats {
    if (durationsNanos.isEmpty()) return FrameStats(0, 0.0, 0.0, 0.0, 0, 0)
    val ms = durationsNanos.map { it / 1_000_000.0 }.sorted()
    fun rank(p: Double) = ms[(ceil(p * ms.size).toInt() - 1).coerceIn(0, ms.size - 1)]
    return FrameStats(ms.size, rank(.50), rank(.95), rank(.99), ms.count { it > FRAME_16_MS }, ms.count { it > FRAME_33_MS })
}
internal const val FRAME_16_MS = 1000.0 / 60
internal const val FRAME_33_MS = 1000.0 / 30
internal const val FRAME_WINDOW_MS = 2_000L

internal fun frameStatsLine(window: String, s: FrameStats): String =
    "FRAMES window=$window n=${s.frames} p50=${ms(s.p50)} p95=${ms(s.p95)} p99=${ms(s.p99)} gt16=${s.over16} gt33=${s.over33}"
private fun ms(value: Double) = String.format(java.util.Locale.ROOT, "%.1f", value)

internal object FrameWindows {
    private val thread by lazy { HandlerThread("pkw-frames").also { it.start() } }
    private val main by lazy { Handler(Looper.getMainLooper()) }

    /** Main thread. Records the window's frames for [FRAME_WINDOW_MS] and prints one FRAMES line; no-op without the sink. */
    fun record(window: Window?, label: String) {
        if (window == null || SceneLoadLog.sink == null) return
        val frames = Handler(thread.looper)
        val durations = ArrayList<Long>() // touched only on the frames thread
        val listener = Window.OnFrameMetricsAvailableListener { _, metrics, _ -> durations += metrics.getMetric(FrameMetrics.TOTAL_DURATION) }
        if (runCatching { window.addOnFrameMetricsAvailableListener(listener, frames) }.isFailure) return
        main.postDelayed({
            runCatching { window.removeOnFrameMetricsAvailableListener(listener) }
            frames.post { SceneLoadLog.mark(LoadEvent.FRAMES, frameStatsLine(label, frameStats(durations)).removePrefix("FRAMES ")) }
        }, FRAME_WINDOW_MS)
    }
}
