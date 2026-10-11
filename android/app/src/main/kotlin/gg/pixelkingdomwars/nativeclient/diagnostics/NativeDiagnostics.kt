package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.renderer.FrameTimeReport
import gg.pixelkingdomwars.nativeclient.telemetry.TelemetryBuild
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

data class NativeDiagnosticsState(val enabled: Boolean = false, val report: FrameTimeReport? = null, val sampledAtMs: Long? = null)

/** Real renderer reports only. No account data, disk queue, retries or error-reporting side effects.
 * Summary limits mirror web PERF_DIAG: one minute and at most 30 per process session. */
class NativeDiagnosticsSession(private val build: TelemetryBuild,
    private val monotonicMs: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wallMs: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() }) {
    private val current = MutableStateFlow(NativeDiagnosticsState())
    val state = current.asStateFlow()
    private var generation = 0L
    private var summaries = 0
    private var lastSummaryAt: Long? = null

    @Synchronized fun setEnabled(enabled: Boolean) {
        if (enabled == current.value.enabled) return
        generation++
        current.value = NativeDiagnosticsState(enabled)
    }
    @Synchronized fun sample(report: FrameTimeReport) {
        if (current.value.enabled && valid(report)) current.value = NativeDiagnosticsState(true, report, monotonicMs())
    }
    @Synchronized fun currentGeneration() = generation
    @Synchronized fun isActive(expectedGeneration: Long) = current.value.enabled && generation == expectedGeneration

    /** Returns a one-shot batch; toggling off clears the readout but never rearms the session cap. */
    @Synchronized fun summary(report: FrameTimeReport): JsonObject? {
        if (!current.value.enabled || !valid(report) || report.activeSeconds < 60 || summaries >= 30) return null
        val now = monotonicMs()
        if (lastSummaryAt?.let { now < it || now - it < 60_000 } == true) return null
        summaries++
        lastSummaryAt = now
        val props = buildJsonObject {
            put("seq", summaries); put("windowMs", report.activeSeconds * 1_000)
            put("fps", report.averageFps); put("steadyFrames", report.steady.count); put("warmupFrames", report.warmup.count)
            report.steady.p50Ms?.let { put("steadyP50Ms", it) }
            report.steady.p95Ms?.let { put("steadyP95Ms", it) }
            report.steady.p99Ms?.let { put("steadyP99Ms", it) }
            report.steady.maxMs?.let { put("steadyMaxMs", it) }
            put("steadyStalls", report.steady.stallsOver50Ms); put("sampleDrops", report.steady.dropped)
            put("drawsAvg", report.meanDrawCalls); put("drawsMax", report.maxDrawCalls)
            put("textureMiB", report.textureRgbaMiB); put("texturePeakMiB", report.maxTextureRgbaMiB)
            put("pauses", report.pauses)
            put("base", "base" in report.scenes); put("battle", "battle" in report.scenes); put("loading", "loading" in report.scenes)
        }
        return buildJsonObject {
            put("context", build.context())
            put("events", buildJsonArray { add(buildJsonObject {
                put("event", "perf_summary"); put("eventId", newId()); put("ts", Instant.ofEpochMilli(wallMs()).toString()); put("props", props)
            }) })
        }
    }

    private fun valid(report: FrameTimeReport): Boolean {
        if (report.activeScene !in SCENES || report.scenes.any { it !in SCENES } || report.sequence < 0 || report.pauses < 0 || report.maxDrawCalls < 0) return false
        if (listOf(report.activeSeconds, report.averageFps, report.meanDrawCalls, report.textureRgbaMiB, report.maxTextureRgbaMiB).any { !it.isFinite() || it < 0 }) return false
        return listOf(report.warmup, report.steady).all { row ->
            row.count >= 0 && row.retained >= 0 && row.dropped >= 0 && row.stallsOver50Ms >= 0 &&
                listOf(row.p50Ms, row.p95Ms, row.p99Ms, row.meanMs, row.maxMs).filterNotNull().all { it.isFinite() && it >= 0 }
        }
    }
    private companion object { val SCENES = setOf("loading", "base", "battle") }
}
