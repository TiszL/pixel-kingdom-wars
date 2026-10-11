package gg.pixelkingdomwars.nativeclient.renderer.world

import java.util.Locale
import kotlin.math.ceil

enum class WorldScene(val id: String) { GLOBE("globe"), REALM("realm") }

/**
 * Frame-time sampling for the world surface with the motion flag (GLOBE-NATIVE-PLAN §8.3). The existing
 * `FrameTimeSampler` (loading/base/battle) counts every interval; on the world that would turn the idle cadence
 * (50/125 ms by design) into false stalls. It lives in the realm-kit-fenced `renderer` package and is not edited;
 * this is its world counterpart with the same bounded storage and report style.
 *
 * - An interval is counted only between two consecutive MOTION frames (frames [IdleScheduler] requested continuously).
 * - The warmup window is reported separately for averages but INCLUDED in the hitch gate (entry and first-dive hitches
 *   count: [WorldFrameReport.hitches] spans both).
 * - GL-thread CPU time (`onDrawFrame`) and swap-return time are recorded separately; there is no "GPU ms" row.
 * - [pause] (lifecycle) drops the pending interval, so a background gap never becomes a frame.
 *
 * No player, session or world identifiers. Never allocates per frame (only a report, once per interval).
 */
class WorldFrameSampler(
    private val reportIntervalNanos: Long = 60_000_000_000L,
    private val warmupNanos: Long = 10_000_000_000L,
    capacity: Int = 16_384,
    private val hitchNanos: Long = 50_000_000L,
) {
    private val warmup = Series(capacity)
    private val steady = Series(capacity)
    private val cpu = Series(capacity)
    private val swap = Series(capacity)
    private var previousNanos = 0L
    private var hasPrevious = false
    private var previousMotion = false
    private var warmupElapsed = 0L
    private var activeNanos = 0L
    private var frames = 0L
    private var hitches = 0L
    private var pauses = 0
    private var sequence = 0
    private var lastScene = WorldScene.GLOBE

    init { require(reportIntervalNanos > 0 && warmupNanos >= 0 && capacity > 0) }

    fun pause() { previousMotion = false; hasPrevious = false; warmupElapsed = 0L; pauses++ }

    /** One presented frame. [motion] = the scheduler requested it continuously. Returns a report once per interval. */
    fun frame(nowNanos: Long, scene: WorldScene, motion: Boolean, cpuNanos: Long, swapNanos: Long): WorldFrameReport? {
        require(cpuNanos >= 0 && swapNanos >= 0)
        val previous = previousNanos
        val counted = hasPrevious
        val bothMotion = counted && motion && previousMotion
        previousNanos = nowNanos; previousMotion = motion; hasPrevious = true; lastScene = scene
        frames++
        cpu.add(cpuNanos); swap.add(swapNanos)
        if (counted) {
            val elapsed = nowNanos - previous
            require(elapsed >= 0) { "Frame timestamps must be monotonic" }
            activeNanos += elapsed
            if (bothMotion) {
                if (warmupElapsed < warmupNanos) warmup.add(elapsed) else steady.add(elapsed)
                if (elapsed > hitchNanos) hitches++
            }
            warmupElapsed += elapsed
        }
        if (activeNanos < reportIntervalNanos) return null
        val report = WorldFrameReport(++sequence, lastScene.id, activeNanos / 1e9, frames, pauses, hitches,
            warmup.summary(), steady.summary(), cpu.percentileMs(0.95), swap.percentileMs(0.95))
        activeNanos = 0L; frames = 0L; hitches = 0L; pauses = 0
        warmup.reset(); steady.reset(); cpu.reset(); swap.reset()
        return report
    }

    private class Series(capacity: Int) {
        private val values = LongArray(capacity)
        var count = 0L; private set
        private var retained = 0
        fun add(v: Long) { if (retained < values.size) values[retained++] = v; count++ }
        fun reset() { count = 0; retained = 0 }
        fun percentileMs(p: Double): Double? {
            if (retained == 0) return null
            val sorted = values.copyOf(retained).apply { sort() }
            return sorted[(ceil(p * retained).toInt() - 1).coerceAtLeast(0)] / 1e6
        }
        fun summary() = MotionSummary(count, percentileMs(0.5), percentileMs(0.95), percentileMs(0.99))
    }
}

data class MotionSummary(val intervals: Long, val p50Ms: Double?, val p95Ms: Double?, val p99Ms: Double?) {
    internal fun json() = """{"intervals":$intervals,"p50Ms":${p50Ms.n()},"p95Ms":${p95Ms.n()},"p99Ms":${p99Ms.n()}}"""
}

data class WorldFrameReport(
    val sequence: Int, val scene: String, val activeSeconds: Double, val frames: Long, val pauses: Int,
    /** Motion intervals > 50 ms, warmup INCLUDED (the D-167 gate: 0 from the first world frame on). */
    val hitches: Long,
    val warmup: MotionSummary, val steady: MotionSummary, val cpuP95Ms: Double?, val swapP95Ms: Double?,
) {
    /** One bounded `[world-perf]` logcat line, without identifiers. */
    fun toJson() = """{"schemaVersion":1,"sequence":$sequence,"scene":"$scene","activeSeconds":${activeSeconds.n()},"frames":$frames,"pauses":$pauses,"motionHitchesOver50Ms":$hitches,"warmup":${warmup.json()},"steady":${steady.json()},"cpuP95Ms":${cpuP95Ms.n()},"swapP95Ms":${swapP95Ms.n()}}"""
}

private fun Double?.n(): String = if (this == null) "null" else String.format(Locale.US, "%.3f", this)
