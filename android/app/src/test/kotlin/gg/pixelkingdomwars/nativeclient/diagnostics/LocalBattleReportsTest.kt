package gg.pixelkingdomwars.nativeclient.diagnostics

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.concurrent.CancellationException
import java.util.zip.ZipInputStream

class LocalBattleReportsTest {
    @Test fun `one outstanding Main probe detects Main freeze independently of completing GL frames`() {
        val watch = LocalStallWatch(); watch.arm(true, 0)
        val token = watch.probe(0)!!
        assertNull(watch.probe(1_000))
        watch.start(3_000); watch.complete(3_001)
        val report = watch.observation(3_100)!!
        assertEquals(3_100, report.mainMs); assertEquals(99, report.glMs)
        watch.acknowledge(token); assertNotNull(watch.probe(3_101))
    }
    @Test fun `GL stall captured before tail sampler even while Main responds`() {
        val watch = LocalStallWatch(); watch.arm(true, 0); watch.start(10)
        watch.acknowledge(watch.probe(2_900)!!)
        val report = watch.observation(3_100)!!
        assertEquals(0, report.mainMs); assertEquals(3_090, report.glMs); assertTrue(report.inside)
        assertNull(watch.observation(3_600)) // A stuck renderer cannot fill storage every tick.
        assertNotNull(watch.observation(13_100))
    }
    @Test fun `missing initial GL frame still produces evidence`() {
        val watch = LocalStallWatch(); watch.arm(true, 0)
        assertEquals(3_000, watch.observation(3_000)!!.glMs)
    }
    @Test fun `pause detach and opt out reset stall baseline and obsolete Main acknowledgement`() {
        val watch = LocalStallWatch(); watch.arm(true, 0); val old = watch.probe(0)!!
        watch.start(0); watch.arm(false, 50)
        assertNull(watch.observation(10_000)); assertNull(watch.probe(10_000))
        watch.arm(true, 10_000); val current = watch.probe(10_001)!!
        watch.acknowledge(old)
        assertNull(watch.probe(10_002)); assertNull(watch.observation(10_003))
        watch.acknowledge(current); assertNotNull(watch.probe(10_004))
    }
    @Test fun `traces cap bytes retain truncation and obey cancellation`() {
        val exact = readBoundedTrace(ByteArrayInputStream(ByteArray(TRACE_LIMIT))) { true }
        assertEquals(TRACE_LIMIT, exact.first.size); assertFalse(exact.second)
        val large = readBoundedTrace(ByteArrayInputStream(ByteArray(TRACE_LIMIT * 4))) { true }
        assertEquals(TRACE_LIMIT, large.first.size); assertTrue(large.second)
        assertEquals(0, readBoundedTrace(ByteArrayInputStream(byteArrayOf())) { true }.first.size)
        try { readBoundedTrace(ByteArrayInputStream(ByteArray(TRACE_LIMIT))) { false }; fail("Cancelled capture must not be saved") }
        catch (_: CancellationException) { }
    }
    @Test fun `malformed and oversized persistence fail closed and stale writes cannot resurrect cleared data`() {
        val dir = Files.createTempDirectory("pkw-local-report").toFile()
        try {
            val store = LocalReportStore(dir)
            dir.resolve("report.json").writeText("not json")
            assertEquals(LocalReportBundle(), store.load(1_000))
            dir.resolve("report.json").writeBytes(ByteArray(129 * 1024))
            assertEquals(LocalReportBundle(), store.load(1_000))
            store.clear()
            store.save(LocalReportBundle(markers = listOf(LocalProcessMarker(7, 1_000, "dev")))) { false }
            assertFalse(dir.exists())
            store.saveTrace(0, byteArrayOf(1)) { false }; assertFalse(dir.exists())
        } finally { dir.deleteRecursively() }
    }
    @Test fun `expiry and ring bounds constrain stored evidence across sessions`() {
        val now = REPORT_RETENTION_MS + 1_000
        val bundle = LocalReportBundle(exits = (1..40).map { LocalExitRecord(now - it, "anr", 0, 1, 1, "0.4.1:14:dev", it.toString(16).padStart(64, '0')) },
            traces = listOf(LocalTraceRecord("expired", 0, 0, false)), markers = listOf(LocalProcessMarker(7, 0, "old")))
        val kept = bundle.retained(now)
        assertEquals(16, kept.exits.size); assertTrue(kept.traces.isEmpty()); assertTrue(kept.markers.isEmpty())
    }
    @Test fun `export excludes private markers and raw trace unless explicitly requested`() {
        val dir = Files.createTempDirectory("pkw-local-export").toFile()
        try {
            val store = LocalReportStore(dir)
            val bundle = LocalReportBundle(markers = listOf(LocalProcessMarker(1234, 1_000, "dev")),
                traces = listOf(LocalTraceRecord("key", 1_000, 0, false, traceHash("sensitive thread stack".toByteArray()), "sensitive thread stack".length)))
            store.saveTrace(0, "sensitive thread stack".toByteArray()) { true }
            fun export(raw: Boolean): Map<String, String> {
                val out = ByteArrayOutputStream(); store.export(bundle, out, raw) { true }
                return buildMap { ZipInputStream(ByteArrayInputStream(out.toByteArray())).use { zip ->
                    while (true) { val entry = zip.nextEntry ?: break; put(entry.name, zip.readBytes().decodeToString()) }
                } }
            }
            val plain = export(false)
            assertEquals(setOf("report.json", "README.txt"), plain.keys)
            assertFalse(plain.getValue("report.json").contains("1234"))
            assertFalse(plain.getValue("report.json").contains("key"))
            assertTrue(plain.getValue("README.txt").contains("It is not total GPU memory"))
            assertTrue(plain.getValue("README.txt").contains("ground, wall, font and stroke textures"))
            assertEquals("sensitive thread stack", export(true)["trace-0.bin"])
        } finally { dir.deleteRecursively() }
    }
    @Test fun `interrupted trace slot replacement cannot export new bytes under old exit metadata`() {
        val dir = Files.createTempDirectory("pkw-local-replacement").toFile()
        try {
            val store = LocalReportStore(dir)
            val original = "old trace".toByteArray()
            val key = "a".repeat(64)
            val bundle = LocalReportBundle(exits = listOf(LocalExitRecord(1_000, "anr", 0, 0, 0, "originating build unknown", key)),
                traces = listOf(LocalTraceRecord(key, 1_000, 0, false, traceHash(original), original.size)))
            store.saveTrace(0, original) { true }; store.save(bundle) { true }
            assertEquals(1, store.load(1_001).traces.size)
            store.saveTrace(0, "new trace".toByteArray()) { true } // Process dies before metadata commit.
            val resumed = store.load(1_002)
            assertTrue(resumed.traces.isEmpty()); assertEquals(1, resumed.exits.size)
            assertFalse(dir.resolve("trace-0.bin").exists())
            val out = ByteArrayOutputStream(); store.export(bundle, out, true) { true }
            ZipInputStream(ByteArrayInputStream(out.toByteArray())).use { zip ->
                assertEquals("report.json", zip.nextEntry.name); zip.readBytes()
                assertEquals("README.txt", zip.nextEntry.name); zip.readBytes(); assertNull(zip.nextEntry)
            }
        } finally { dir.deleteRecursively() }
    }
    @Test fun `clear and disable fence old picker consent even after reports are enabled again`() {
        val consent = LocalReportConsent()
        assertNull(consent.permit(true))
        val first = consent.change(true)!!; val permit = consent.permit(true)!!
        assertTrue(consent.active(first)); assertTrue(permit.raw)
        consent.change(false); consent.change(true)
        assertFalse(consent.active(permit.generation))
        val next = consent.permit(false)!!; assertFalse(next.raw)
        consent.invalidate(); assertFalse(consent.active(next.generation))
        assertTrue(consent.enabled); assertNull(consent.change(true))
    }
    @Test fun `default off local preference remains independent from remote summaries`() {
        val values = mutableMapOf<String, String>()
        val preferences = gg.pixelkingdomwars.nativeclient.data.StoredDevicePreferences({ values[it] }, { k, v -> values[k] = v })
        assertFalse(preferences.localBattleReports)
        preferences.localBattleReports = true
        assertFalse(preferences.diagnostics)
        val reopened = gg.pixelkingdomwars.nativeclient.data.StoredDevicePreferences({ values[it] }, { _, _ -> })
        assertTrue(reopened.localBattleReports); assertFalse(reopened.diagnostics)
    }
}
