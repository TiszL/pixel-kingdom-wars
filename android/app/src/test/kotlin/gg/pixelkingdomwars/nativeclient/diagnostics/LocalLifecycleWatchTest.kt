package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.renderer.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.zip.ZipInputStream
import org.junit.Assert.*
import org.junit.Test

class LocalLifecycleWatchTest {
    private val scene = LocalSceneSnapshot(LocalSceneKind.BATTLE, 2, 9.0, 7, 873, 393, 15.0, 15.0, 0.4)
    private val build = "0.4.2:15:dev"
    private fun watch() = LocalLifecycleWatch().apply { reset(1) }
    private fun LocalLifecycleWatch.begin(stage: LocalLifecycleStage, now: Long = 0) =
        begin(1, stage, scene, now, 1_000 + now, build)

    @Test fun `unfinished pause is observable after heartbeat background and scene close without another frame`() {
        val heartbeats = LocalStallWatch().apply { arm(true, 0); start(0) }
        val spans = watch(); spans.begin(LocalLifecycleStage.FRAGMENT_PAUSE)
        heartbeats.arm(false, 10) // Actual lifecycle hides the scene before libGDX waits.
        assertNull(heartbeats.observation(6_000))
        assertTrue(spans.hasWork(1))
        val report = spans.sample(1, 6_000)!!
        assertEquals("fragment_pause", report.records.single().stage)
        assertFalse(report.records.single().ended); assertEquals(6_000L, report.records.single().durationMs)
        spans.saved(report)
        assertTrue(spans.hasWork(1)) // A saved unfinished report must not disarm the wait.
        assertNull(spans.sample(1, 6_100)) // Bounded periodic observations of a stuck operation.
        assertNotNull(spans.sample(1, 16_000))
    }

    @Test fun `nested disposal stages retain starting scene context and exact independent durations`() {
        val spans = watch()
        val dispose = spans.begin(LocalLifecycleStage.RENDERER_DISPOSE, 100)!!
        val assets = spans.begin(LocalLifecycleStage.ASSET_MANAGER_DISPOSE, 200)!!
        spans.end(assets, 4_200); spans.end(dispose, 4_300)
        val batch = spans.sample(1, 5_000)!!
        val byStage = batch.records.associateBy { it.stage }
        assertEquals(4_000L, byStage.getValue("asset_manager_dispose").durationMs)
        assertEquals(4_200L, byStage.getValue("renderer_dispose").durationMs)
        assertTrue(batch.records.all { it.ended && it.scene == "battle" && it.viewportWidth == 873 && it.queueDepth == 2 && it.build == build })
        spans.saved(batch)
        assertFalse(spans.hasWork(1)); assertNull(spans.sample(1, 60_000)) // Background observer can stop.
    }

    @Test fun `active slots and completed ring stay bounded and excess admission does not displace a wait`() {
        val spans = watch()
        val active = (1..LocalLifecycleWatch.MAX_ACTIVE).map { spans.begin(LocalLifecycleStage.FRAGMENT_REMOVE)!! }
        assertNull(spans.begin(LocalLifecycleStage.FRAGMENT_REMOVE))
        assertEquals(8, spans.sample(1, 1_000)!!.records.size)
        active.forEach { spans.end(it, 1_000) }
        repeat(100) { index -> val ticket = spans.begin(LocalLifecycleStage.FRAGMENT_PAUSE, 2_000L + index)!!; spans.end(ticket, 3_000L + index) }
        assertEquals(LocalLifecycleWatch.MAX_ENDED, spans.sample(1, 4_000)!!.records.size)
    }

    @Test fun `clear or opt out fences stalled tickets old samples and late ends`() {
        val spans = watch(); val old = spans.begin(LocalLifecycleStage.ASSET_MANAGER_DISPOSE)!!
        val batch = spans.sample(1, 4_000)!!
        spans.reset(2)
        spans.end(old, 5_000); spans.saved(batch)
        assertFalse(spans.hasWork(2)); assertNull(spans.sample(2, 9_000))
        assertNull(spans.begin(1, LocalLifecycleStage.FRAGMENT_PAUSE, scene, 9_000, 10_000, build))
        val next = spans.begin(2, LocalLifecycleStage.FRAGMENT_PAUSE, scene, 9_000, 10_000, build)!!
        spans.saved(batch) // Obsolete disk completion cannot acknowledge this generation.
        assertTrue(spans.hasWork(2)); spans.end(next, 9_100)
        assertTrue(spans.sample(2, 9_200)!!.records.single().ended)
    }

    @Test fun `duplicate end cannot overwrite elapsed duration or create another record`() {
        val spans = watch(); val ticket = spans.begin(LocalLifecycleStage.FRAGMENT_REMOVE)!!
        spans.end(ticket, 10); spans.end(ticket, 80_000)
        assertEquals(10L, spans.sample(1, 80_000)!!.records.single().durationMs)
    }

    @Test fun `instrumented operation ends on exception and diagnostics errors cannot alter control flow`() {
        var ended = 0
        val observer = object : LocalSceneDiagnostics {
            override fun frameStarted() = Unit
            override fun frameCompleted() = Unit
            override fun state(snapshot: LocalSceneSnapshot) = Unit
            override fun lifecycle(stage: LocalLifecycleStage) = LocalLifecycleSpan { ended++; error("diagnostics end failure") }
        }
        val original = IllegalStateException("original operation failure")
        try { observer.duringLifecycle(LocalLifecycleStage.FRAGMENT_REMOVE) { throw original } }
        catch (caught: IllegalStateException) { assertSame(original, caught) }
        assertEquals(1, ended)
    }

    @Test fun `bounded typed lifecycle fields persist and export without raw trace consent`() {
        val spans = watch(); val ticket = spans.begin(LocalLifecycleStage.FRAGMENT_PAUSE)!!; spans.end(ticket, 3_500)
        val row = spans.sample(1, 4_000)!!.records.single()
        val dir = Files.createTempDirectory("pkw-lifecycle").toFile()
        try {
            val storage = LocalReportStore(dir)
            val bundle = LocalReportBundle(lifecycle = listOf(row), markers = listOf(LocalProcessMarker(123456, 1_000, build)))
            storage.save(bundle) { true }
            assertEquals(listOf(row), storage.load(5_000).lifecycle)
            val output = ByteArrayOutputStream(); storage.export(storage.load(5_000), output, false) { true }
            ZipInputStream(ByteArrayInputStream(output.toByteArray())).use { zip ->
                assertEquals("report.json", zip.nextEntry.name)
                val exported = zip.readBytes().decodeToString()
                assertTrue(exported.contains("fragment_pause")); assertTrue(exported.contains("3500"))
                assertFalse(exported.contains("123456")); assertFalse(exported.contains("wallet")); assertFalse(exported.contains("stack"))
                assertEquals("README.txt", zip.nextEntry.name)
                assertTrue(zip.readBytes().decodeToString().contains("not proof of an ANR")); assertNull(zip.nextEntry)
            }
            assertTrue(bundle.retained(REPORT_RETENTION_MS + 2_000).lifecycle.isEmpty())
            assertTrue(bundle.copy(lifecycle = listOf(row.copy(stage = "arbitrary account identifier"))).retained(5_000).lifecycle.isEmpty())
            assertEquals(64, bundle.copy(lifecycle = (1L..100L).map { row.copy(id = it) }).retained(5_000).lifecycle.size)
        } finally { dir.deleteRecursively() }
    }
}
