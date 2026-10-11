package gg.pixelkingdomwars.nativeclient.renderer

import java.util.Locale
import kotlin.math.ceil

/** Opt-in diagnostics only. All durations use monotonic time; no player or world identifiers
 * enter this sampler. Storage stays bounded even if a device renders faster than expected. */
class FrameTimeSampler(
    private val reportIntervalNanos: Long = 60_000_000_000L,
    private val warmupNanos: Long = 10_000_000_000L,
    private val capacity: Int = 16_384,
) {
    private var previousNanos: Long? = null
    private var warmupElapsed = 0L
    private var activeNanos = 0L
    private var pauses = 0
    private var reportSequence = 0
    private var warmup = Durations(capacity)
    private var steady = Durations(capacity)
    private val scenes = linkedSetOf<String>()
    private var drawTotal = 0L
    private var drawMax = 0
    private var textureMax = 0.0

    init { require(reportIntervalNanos > 0 && warmupNanos >= 0 && capacity > 0) }

    /** Call on the render thread. Lifecycle gaps cannot become false frame stalls. */
    fun pause() { previousNanos = null; warmupElapsed = 0; pauses++ }

    fun frame(nowNanos: Long, scene: String, drawCalls: Int, textureRgbaMiB: Double): FrameTimeReport? {
        require(scene in setOf("loading", "base", "battle"))
        require(drawCalls >= 0 && textureRgbaMiB.isFinite() && textureRgbaMiB >= 0)
        val previous = previousNanos
        previousNanos = nowNanos
        if (previous == null) return null
        val elapsed = nowNanos - previous
        require(elapsed >= 0) { "Frame timestamps must be monotonic" }
        if (elapsed == 0L) return null
        if (warmupElapsed < warmupNanos) warmup.add(elapsed) else steady.add(elapsed)
        warmupElapsed += elapsed
        activeNanos += elapsed
        scenes += scene
        drawTotal += drawCalls
        drawMax = maxOf(drawMax, drawCalls)
        textureMax = maxOf(textureMax, textureRgbaMiB)
        if (activeNanos < reportIntervalNanos) return null
        val count = warmup.count + steady.count
        val report = FrameTimeReport(++reportSequence, scene, scenes.toList(), activeNanos / 1e9,
            count * 1e9 / activeNanos, pauses, warmup.summary(), steady.summary(),
            drawTotal.toDouble() / count, drawMax, textureRgbaMiB, textureMax)
        activeNanos = 0; pauses = 0; warmup = Durations(capacity); steady = Durations(capacity)
        scenes.clear(); drawTotal = 0; drawMax = 0; textureMax = 0.0
        return report
    }

    private class Durations(capacity: Int) {
        private val values = LongArray(capacity)
        var count = 0L; private set
        private var retained = 0
        private var total = 0L
        private var max = 0L
        private var stalls = 0L
        fun add(nanos: Long) {
            if (retained < values.size) values[retained++] = nanos
            count++; total += nanos; max = maxOf(max, nanos)
            if (nanos > 50_000_000L) stalls++
        }
        fun summary(): FrameDurationSummary {
            val sorted = values.copyOf(retained).apply { sort() }
            fun percentile(p: Double): Double? = if (retained == 0) null
                else sorted[(ceil(p * retained).toInt() - 1).coerceAtLeast(0)] / 1e6
            return FrameDurationSummary(count, retained, count - retained, percentile(0.5), percentile(0.95),
                percentile(0.99), if (count == 0L) null else total / 1e6 / count,
                if (count == 0L) null else max / 1e6, stalls)
        }
    }
}

data class FrameDurationSummary(val count: Long, val retained: Int, val dropped: Long,
    val p50Ms: Double?, val p95Ms: Double?, val p99Ms: Double?, val meanMs: Double?, val maxMs: Double?,
    val stallsOver50Ms: Long) {
    internal fun json() = """{"frames":$count,"retained":$retained,"dropped":$dropped,"p50Ms":${p50Ms.number()},"p95Ms":${p95Ms.number()},"p99Ms":${p99Ms.number()},"meanMs":${meanMs.number()},"maxMs":${maxMs.number()},"stallsOver50Ms":$stallsOver50Ms}"""
}

data class FrameTimeReport(val sequence: Int, val activeScene: String, val scenes: List<String>,
    val activeSeconds: Double, val averageFps: Double, val pauses: Int,
    val warmup: FrameDurationSummary, val steady: FrameDurationSummary,
    val meanDrawCalls: Double, val maxDrawCalls: Int, val textureRgbaMiB: Double, val maxTextureRgbaMiB: Double) {
    /** One bounded logcat line, deliberately without session/account/raid identifiers. */
    fun toJson() = """{"schemaVersion":1,"sequence":$sequence,"activeScene":"$activeScene","scenes":[${scenes.joinToString(",") { "\"$it\"" }}],"activeSeconds":${activeSeconds.number()},"averageFps":${averageFps.number()},"pauses":$pauses,"warmup":${warmup.json()},"steady":${steady.json()},"meanDrawCalls":${meanDrawCalls.number()},"maxDrawCalls":$maxDrawCalls,"textureRgbaMiBEstimate":${textureRgbaMiB.number()},"maxTextureRgbaMiBEstimate":${maxTextureRgbaMiB.number()}}"""
}

private fun Double?.number(): String = if (this == null) "null" else String.format(Locale.US, "%.3f", this)
