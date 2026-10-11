package gg.pixelkingdomwars.nativeclient.diagnostics

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Called only on the runtime's serial IO dispatcher. noBackup root, fixed filenames, bounded inputs. */
internal class LocalReportStore(private val root: File) {
    private val json = Json { ignoreUnknownKeys = false }
    private val metadata get() = File(root, "report.json")
    fun load(now: Long): LocalReportBundle {
        // The serial IO owner never reads during a write. These are only interrupted-write remnants.
        listOf("trace.tmp", "report.tmp").forEach { name ->
            val scratch = File(root, name)
            check(!scratch.exists() || scratch.delete()) { "Interrupted report cleanup failed" }
        }
        val data = try {
            if (!metadata.isFile || metadata.length() > 128 * 1024) LocalReportBundle()
            else json.decodeFromString<LocalReportBundle>(metadata.readText()).takeIf { it.version == 1 } ?: LocalReportBundle()
        } catch (_: Exception) { LocalReportBundle() }
        val retained = data.retained(now)
        val kept = retained.copy(traces = retained.traces.filter { verifiedTrace(it) != null })
        (0..1).filter { slot -> kept.traces.none { it.slot == slot } }.forEach { trace(it).delete() }
        return kept
    }
    fun save(bundle: LocalReportBundle, active: () -> Boolean) {
        if (!active()) return
        root.mkdirs()
        val scratch = File(root, "report.tmp")
        try {
            scratch.writeText(json.encodeToString(bundle))
            if (!active()) return
            check(scratch.renameTo(metadata))
        } finally { scratch.delete() }
    }
    fun saveTrace(slot: Int, bytes: ByteArray, active: () -> Boolean) {
        require(slot in 0..1 && bytes.size <= TRACE_LIMIT)
        if (!active()) return
        root.mkdirs()
        val scratch = File(root, "trace.tmp")
        try {
            scratch.writeBytes(bytes)
            if (active()) check(scratch.renameTo(trace(slot)))
        } finally { scratch.delete() }
    }
    fun export(bundle: LocalReportBundle, output: OutputStream, includeTraces: Boolean, active: () -> Boolean) {
        val verified = if (includeTraces) bundle.traces.mapNotNull { row -> verifiedTrace(row)?.let { row to it } } else emptyList()
        ZipOutputStream(output).use { zip ->
            fun entry(name: String, bytes: ByteArray) {
                check(active()) { "Report cleared" }
                zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry()
            }
            // Process IDs and attribution markers stay private; the export contains closed fields only.
            entry("report.json", json.encodeToString(bundle.copy(markers = emptyList(), traces = verified.map { it.first })).toByteArray())
            entry("README.txt", """
                Pixel Kingdom Wars local battle report

                report.json contains bounded local stall observations, Android exit metadata, build attribution and references to any included traces. Process IDs and private attribution markers are omitted. This export does not enable remote reporting or upload itself.

                textureMiB estimates the RGBA bytes of textures loaded by the renderer's AssetManager. It excludes directly created ground, wall, font and stroke textures, buffers, mipmaps and driver overhead. It is not total GPU memory, process memory or a device memory limit. An observation may precede the latest completed texture load by one render frame.

                lifecycle contains typed pause, fragment-removal and disposal spans with their starting scene context. ended=false means the independent observer had not seen an end yet; durationMs is a lower bound at observation, not proof of an ANR. ended=true measures until control returned, including an exceptional return; it does not certify success. These spans remain observable while a lifecycle operation is in progress after the scene is hidden. No thread names, stacks, account IDs or asset paths are collected by this instrumentation.

                commands contains input-admission observations identified only by process-local ordinal aliases. Stage values are milliseconds elapsed on the device monotonic clock since that input, not server wall time. Missing stages are unavailable, not zero; restored commands have no original input and create no timing observation. Values record the first observed original-ID binding, durable intent, durable attempted marker, POST beginning, returned JSON response and validated receipt persistence. Recovery reads may persist a receipt before a delayed POST response. Retries keep the same observation and never reset its start. Optional transport stages belong only to the first observed attempt: transport_admitted precedes IO dispatch; transport_io_started enters the IO block; call_enqueued precedes OkHttp admission; request_headers_sent and request_body_sent are OkHttp end callbacks; response_headers_received is the completed response-header callback; response_callback precedes the response continuation; response_body_read follows the complete body string read; response_json_parsed follows successful JSON-object parsing; transport_resumed returns to the caller dispatcher before its session check. response follows the successful return to the battle coordinator. These are client boundaries, not server execution timings; header-to-callback and callback-to-body intervals can include dispatch scheduling. Failed or cancelled calls may lack later stages. Later retries cannot fill missing first-attempt transport stages. first_canonical_body_submitted is the first successful renderer body-batch submission of a linked, alive, nontransparent canonical actor with its trimmed body intersecting the viewport. The association uses that exact completed live presentation revision and original input alias. It is not a compositor/display timestamp or proof that terrain, another sprite or UI did not occlude the body. Preview first draw is not yet instrumented. No wallet, account, base, raid or command IDs, request bodies, URLs or stacks are collected by command timing.

                preparations contains one process-local ordinal per first-page presentation attempt. Each stagesMs value is elapsed monotonic milliseconds since started, never server execution time. call_enqueued precedes OkHttp admission; response_headers is its onResponse callback after headers; body_read follows body string completion; json_parsed follows JSON-object parsing; assembly_complete follows validated complete timeline assembly, including any additional cursor pages. Only the first page transport is measured; automatic OkHttp GET recovery may be included in its interval. mapper_queued precedes Default dispatch; mapper_started/completed bracket application scene mapping; renderer_queued precedes the bounded preparation worker; renderer_started/completed bracket CPU preparation including atlas metadata and wall pixels; gl_activated follows graphics activation; the renderer_completed-to-gl_activated interval includes queueing, texture upload and any same-generation ground repair, not pure GPU execution; first_draw follows successful current-generation scene batch submission, not physical display. Durations may be subtracted only between present ordered milestones of the SAME ordinal. No stage from another revision, retry or renderer generation can complete an earlier interval. Missing phases are unavailable, not zero. Cancelled/superseded/failed/unchanged/expired preparations are explicit; drawn means batch submission only. A mapper retry of the same retained assembly does not reuse a prior timing start and is currently unmeasured. Records omit revision hashes, generation identifiers, raids, bases, accounts, command IDs, URLs, events and stacks. Bindings exist only in bounded memory while consent and the owning session/selection remain valid.

                Optional trace-*.bin files are included only when requested and verified against their recorded hashes. Raw Android traces can contain private app data and thread stacks. Review them before sharing.
            """.trimIndent().toByteArray())
            verified.forEach { (row, bytes) -> entry("trace-${row.slot}.bin", bytes) }
        }
    }
    private fun verifiedTrace(row: LocalTraceRecord): ByteArray? = try {
        if (row.slot !in 0..1 || row.bytes !in 1..TRACE_LIMIT) null
        else trace(row.slot).takeIf { it.isFile && it.length() == row.bytes.toLong() }?.readBytes()
            ?.takeIf { it.size == row.bytes && traceHash(it) == row.sha256 }
    } catch (_: Exception) { null }
    fun clear() { check(!root.exists() || root.deleteRecursively()) { "Local report cleanup failed" } }
    private fun trace(slot: Int) = File(root, "trace-$slot.bin")
}
