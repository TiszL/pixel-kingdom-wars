package gg.pixelkingdomwars.nativeclient.scene.world

import kotlin.math.floor

/**
 * The pure half of `FramePacer` (GLOBE-NATIVE-PLAN §5.6): which vsync may start a world frame, and when that frame
 * may be presented. It runs on the pacer thread; the GL thread reads [presentationTargetNs] for the frame it draws.
 *
 * Why it exists: `GLSurfaceView` renders at whatever vsync the panel runs, libGDX's `setForegroundFPS` does nothing on
 * Android, and libGDX's touch handler calls `requestRendering()` on every touch event. On the Seeker's ~120 Hz panel a
 * pan would therefore render at ~120 fps (double the GPU and CPU cost) or judder between 60 and 120. The pacer starts
 * a frame only every [interval]-th vsync and stamps it with a presentation time, so the panel shows an even cadence.
 *
 * Rules:
 * - [interval] is the largest whole number of vsyncs whose rate still meets the target: 120 Hz → 2 (60 fps),
 *   60 Hz → 1, 90 Hz → 1 (90 fps), 144 Hz → 2 (72 fps); a 30 fps target (ladder L3) → 4 at 120 Hz.
 *   (The plan writes `round(refresh / target)`; at 90 Hz that is 2, i.e. 45 fps, below the 60 fps bar.)
 * - A vsync starts a frame only when one is wanted (dirty or continuous), none is still in flight (a request is never
 *   stacked behind an undrawn frame), and at least `interval × period − period / 2` has passed since the last start
 *   (half a period of slack absorbs vsync timestamp jitter). After idle the first wanted vsync starts at once.
 * - The frame's presentation target is its start vsync + `interval × period − period / 2`: the compositor presents at
 *   the first vsync at or after it, which is exactly `interval` vsyncs after the start, never earlier.
 *
 * Integer nanoseconds; never allocates.
 */
class PacerClock(targetFps: Int, refreshHz: Float) {
    var targetFps: Int = targetFps; private set
    var refreshHz: Float = refreshHz; private set
    var periodNs: Long = periodOf(refreshHz); private set
    var interval: Int = intervalFor(refreshHz, targetFps); private set
    var lastStartNs: Long = 0L; private set
    var starts: Long = 0L; private set

    init { require(targetFps > 0) { "targetFps must be positive" } }

    val cadenceNs: Long get() = interval * periodNs

    fun setRefresh(hz: Float) {
        if (!(hz > 1f)) return // a display that reports 0 or NaN keeps the last good rate
        refreshHz = hz; periodNs = periodOf(hz); interval = intervalFor(hz, targetFps)
    }

    fun setTarget(fps: Int) {
        require(fps > 0) { "targetFps must be positive" }
        targetFps = fps; interval = intervalFor(refreshHz, fps)
    }

    /** One vsync at [frameTimeNs]. True: start a frame now (the caller requests a render). */
    fun onVsync(frameTimeNs: Long, want: Boolean, inFlight: Boolean): Boolean {
        if (!want || inFlight) return false
        if (lastStartNs != 0L && frameTimeNs - lastStartNs < cadenceNs - periodNs / 2) return false
        lastStartNs = frameTimeNs
        starts++
        return true
    }

    /**
     * A requested frame that has not started drawing [STALE_IN_FLIGHT_NS] after its request is treated as lost (the
     * view dropped the request, e.g. around a surface change): otherwise "in flight" would block every later frame and
     * the world would freeze until the next pause.
     */
    fun inFlightExpired(frameTimeNs: Long): Boolean = lastStartNs != 0L && frameTimeNs - lastStartNs > STALE_IN_FLIGHT_NS

    /** When the frame started at [lastStartNs] may be presented; 0 when none started yet (present as usual). */
    fun presentationTargetNs(): Long = if (lastStartNs == 0L) 0L else lastStartNs + cadenceNs - periodNs / 2

    /** After a pause: the next wanted vsync starts at once. */
    fun reset() { lastStartNs = 0L }

    companion object {
        const val STALE_IN_FLIGHT_NS = 250_000_000L

        fun periodOf(refreshHz: Float): Long = if (refreshHz > 1f) (1_000_000_000.0 / refreshHz).toLong() else 16_666_667L

        fun intervalFor(refreshHz: Float, targetFps: Int): Int {
            if (!(refreshHz > 1f) || targetFps <= 0) return 1
            return maxOf(1, floor(refreshHz / targetFps + 0.1).toInt())
        }
    }
}
