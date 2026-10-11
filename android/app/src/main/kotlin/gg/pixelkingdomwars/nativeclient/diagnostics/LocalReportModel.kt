package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.renderer.LocalSceneSnapshot
import kotlinx.serialization.Serializable
import java.io.InputStream

@Serializable data class LocalFrameRecord(val at: Long, val scene: String, val mainDelayMs: Long, val glDelayMs: Long,
    val glInsideFrame: Boolean, val queueDepth: Int, val textureMiB: Double, val pendingWallUploads: Int,
    val viewportWidth: Int, val viewportHeight: Int, val cameraX: Double, val cameraY: Double, val cameraZoom: Double,
    val build: String)
@Serializable data class LocalExitRecord(val at: Long, val reason: String, val status: Int, val pssKiB: Long,
    val rssKiB: Long, val build: String, val key: String)
@Serializable data class LocalProcessMarker(val pid: Int, val since: Long, val build: String)
@Serializable data class LocalTraceRecord(val key: String, val at: Long, val slot: Int, val truncated: Boolean, val sha256: String = "", val bytes: Int = 0)
@Serializable data class LocalLifecycleRecord(val at: Long, val id: Long, val stage: String, val ended: Boolean,
    val durationMs: Long, val scene: String, val queueDepth: Int, val textureMiB: Double, val pendingWallUploads: Int,
    val viewportWidth: Int, val viewportHeight: Int, val cameraX: Double, val cameraY: Double, val cameraZoom: Double, val build: String)
@Serializable data class LocalCommandRecord(val at: Long, val alias: Long, val stagesMs: Map<String, Long>, val build: String)
@Serializable data class LocalPreparationRecord(val at: Long, val ordinal: Long, val stagesMs: Map<String,Long>, val outcome: String, val build: String)
@Serializable data class LocalReportBundle(val version: Int = 1, val frames: List<LocalFrameRecord> = emptyList(),
    val exits: List<LocalExitRecord> = emptyList(), val markers: List<LocalProcessMarker> = emptyList(),
    val traces: List<LocalTraceRecord> = emptyList(), val lifecycle: List<LocalLifecycleRecord> = emptyList(), val commands: List<LocalCommandRecord> = emptyList(), val preparations: List<LocalPreparationRecord> = emptyList())

/** Small, deterministic watchdog core. No IO, Android calls, callbacks, account IDs or locks held by disk work. */
class LocalStallWatch {
    private var active = false
    private var armedAt = 0L
    private var pending: Long? = null
    private var sequence = 0L
    private var pendingAt = 0L
    private var entered = 0L
    private var completed = 0L
    private var inside = false
    private var lastRecord = Long.MIN_VALUE
    @Synchronized fun arm(on: Boolean, now: Long) {
        if (active == on) return
        active = on; pending = null; armedAt = now; entered = now; completed = now; inside = false; lastRecord = Long.MIN_VALUE
    }
    @Synchronized fun probe(now: Long): Long? {
        if (!active || pending != null) return null
        return (++sequence).also { pending = it; pendingAt = now }
    }
    @Synchronized fun acknowledge(token: Long) { if (pending == token) pending = null }
    @Synchronized fun start(now: Long) { if (active) { entered = now; inside = true } }
    @Synchronized fun complete(now: Long) { if (active) { completed = now; inside = false } }
    @Synchronized fun observation(now: Long): Observation? {
        if (!active) return null
        val main = if (pending != null) (now - pendingAt).coerceAtLeast(0) else 0
        val gl = (now - (if (inside) entered else completed).coerceAtLeast(armedAt)).coerceAtLeast(0)
        if (main < 3_000 && gl < 3_000) return null
        if (lastRecord != Long.MIN_VALUE && now - lastRecord < 10_000) return null
        lastRecord = now
        return Observation(main, gl, inside)
    }
    data class Observation(val mainMs: Long, val glMs: Long, val inside: Boolean)
}

internal const val REPORT_RETENTION_MS = 7L * 24 * 60 * 60 * 1_000
internal const val TRACE_LIMIT = 256 * 1024
internal fun LocalReportBundle.retained(now: Long): LocalReportBundle {
    fun fresh(at: Long) = at in (now - REPORT_RETENTION_MS)..now
    fun buildSafe(value: String) = value == "originating build unknown" ||
        value.matches(Regex("[a-zA-Z0-9._-]{1,64}:[0-9]{1,10}:([a-f0-9]{40}|dev|unknown)"))
    fun keySafe(value: String) = value.matches(Regex("[a-f0-9]{64}"))
    val keptExits = exits.filter { fresh(it.at) && it.reason in setOf("anr", "crash", "native_crash", "low_memory", "signal", "user_exit", "self_exit", "other") &&
        it.pssKiB >= 0 && it.rssKiB >= 0 && buildSafe(it.build) && keySafe(it.key) }.distinctBy { it.key }.takeLast(16)
    return copy(preparations = preparations.filter { fresh(it.at) && it.ordinal > 0 && buildSafe(it.build) &&
        it.outcome in LocalPreparationTiming.OUTCOMES && it.stagesMs.size <= LocalPreparationTiming.STAGES.size &&
        it.stagesMs.all { (stage, elapsed) -> stage in LocalPreparationTiming.STAGES && elapsed in 0..LocalPreparationTiming.MAX_MS }
    }.distinctBy { it.at to it.ordinal }.takeLast(LocalPreparationTiming.LIMIT), commands = commands.filter { fresh(it.at) && it.alias > 0 && buildSafe(it.build) &&
        it.stagesMs.size <= gg.pixelkingdomwars.nativeclient.network.BattleCommandStage.entries.size &&
        it.stagesMs.all { (stage, elapsed) -> stage in gg.pixelkingdomwars.nativeclient.network.BattleCommandStage.entries.map { s -> s.name.lowercase() } && elapsed in 0..LocalCommandTiming.ASSOCIATION_MS }
    }.distinctBy { it.at to it.alias }.takeLast(LocalCommandTiming.RECORD_LIMIT), lifecycle = lifecycle.filter { fresh(it.at) && it.id > 0 && it.durationMs >= 0 &&
        it.stage in gg.pixelkingdomwars.nativeclient.renderer.LocalLifecycleStage.entries.map { stage -> stage.name.lowercase() } &&
        it.scene in setOf("loading", "base", "battle") && it.queueDepth in 0..100_000 && it.pendingWallUploads in 0..100_000 &&
        it.viewportWidth in 0..100_000 && it.viewportHeight in 0..100_000 &&
        listOf(it.textureMiB, it.cameraX, it.cameraY, it.cameraZoom).all(Double::isFinite) &&
        it.textureMiB in 0.0..100_000.0 && it.cameraZoom in 0.0..100_000.0 && buildSafe(it.build)
    }.distinctBy { it.at to it.id }.takeLast(64), frames = frames.filter { fresh(it.at) && it.scene in setOf("loading", "base", "battle") &&
        it.mainDelayMs >= 0 && it.glDelayMs >= 0 && it.queueDepth >= 0 && it.pendingWallUploads >= 0 &&
        it.viewportWidth >= 0 && it.viewportHeight >= 0 && listOf(it.textureMiB, it.cameraX, it.cameraY, it.cameraZoom).all(Double::isFinite) &&
        it.textureMiB >= 0 && it.cameraZoom >= 0 && buildSafe(it.build) }.takeLast(32), exits = keptExits,
        markers = markers.filter { fresh(it.since) && it.pid > 0 && buildSafe(it.build) }.takeLast(8),
        traces = traces.filter { fresh(it.at) && it.slot in 0..1 && keySafe(it.sha256) && it.bytes in 1..TRACE_LIMIT && keptExits.any { exit -> exit.key == it.key } }.distinctBy { it.slot }.takeLast(2))
}
internal fun LocalSceneSnapshot.valid() = listOf(textureMiB, cameraX, cameraY, cameraZoom).all { it.isFinite() } &&
    queueDepth in 0..100_000 && pendingWallUploads in 0..100_000 && textureMiB in 0.0..100_000.0 &&
    viewportWidth in 0..100_000 && viewportHeight in 0..100_000 && cameraZoom in 0.0..100_000.0
internal fun readBoundedTrace(input: InputStream, active: () -> Boolean): Pair<ByteArray, Boolean> {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8_192)
    while (output.size() <= TRACE_LIMIT) {
        if (!active()) throw java.util.concurrent.CancellationException()
        val read = input.read(buffer, 0, minOf(buffer.size, TRACE_LIMIT + 1 - output.size()))
        if (read < 0) break
        if (read == 0) break
        output.write(buffer, 0, read)
    }
    val all = output.toByteArray()
    return all.copyOf(minOf(all.size, TRACE_LIMIT)) to (all.size > TRACE_LIMIT)
}

internal fun traceHash(bytes: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
