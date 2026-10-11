package gg.pixelkingdomwars.nativeclient.diagnostics

import java.io.InputStream
import java.security.MessageDigest

/** Android objects and arbitrary descriptions never enter persistence. IO is opened only after admission. */
internal data class LocalExitCandidate(val at: Long, val pid: Int, val process: String, val reason: String,
    val status: Int = 0, val pssKiB: Long = 0, val rssKiB: Long = 0, val trace: () -> InputStream? = { null })

internal fun collectLocalExits(initial: LocalReportBundle, candidates: List<LocalExitCandidate>, process: String,
    now: Long, includeHistory: Boolean, includeRaw: Boolean, active: () -> Boolean,
    saveTrace: (Int, ByteArray) -> Unit): LocalReportBundle {
    var bundle = initial.retained(now)
    for (exit in candidates.take(32).filter { it.process == process && it.at in (now - REPORT_RETENTION_MS)..now }.sortedBy { it.at }) {
        if (!active()) throw java.util.concurrent.CancellationException()
        val marker = bundle.markers.filter { it.since <= exit.at }.maxByOrNull { it.since }?.takeIf { it.pid == exit.pid }
        if (!includeHistory && marker == null) continue
        val key = MessageDigest.getInstance("SHA-256").digest("${exit.pid}:${exit.at}:${exit.reason}".toByteArray())
            .joinToString("") { "%02x".format(it) }
        if (bundle.exits.none { it.key == key }) bundle = bundle.copy(exits = (bundle.exits + LocalExitRecord(exit.at,
            exit.reason, exit.status, exit.pssKiB.coerceAtLeast(0), exit.rssKiB.coerceAtLeast(0),
            marker?.build ?: "originating build unknown", key)).takeLast(16))
        if (includeRaw && bundle.traces.none { it.key == key }) {
            // ANR traces may accompany later non-ANR exits. Preserve the platform's actual exit reason.
            val bytes = try { exit.trace()?.use { readBoundedTrace(it, active) } }
                catch (cancelled: java.util.concurrent.CancellationException) { throw cancelled }
                catch (_: Exception) { null }
            if (!active()) throw java.util.concurrent.CancellationException()
            if (bytes != null && bytes.first.isNotEmpty()) {
                val slot = (0..1).firstOrNull { candidate -> bundle.traces.none { it.slot == candidate } }
                    ?: bundle.traces.minBy { it.at }.slot
                saveTrace(slot, bytes.first)
                bundle = bundle.copy(traces = bundle.traces.filterNot { it.slot == slot } + LocalTraceRecord(key, exit.at, slot, bytes.second, traceHash(bytes.first), bytes.first.size))
            }
        }
    }
    return bundle.retained(now)
}
